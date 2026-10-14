import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BILLING_NOTICE_KINDS, TENANT_SCOPED_TABLES } from "@/db/schema";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * drizzle/0044 (the funnel and portal contracts), asserted.
 *
 * rls-drift.test.ts already demands ENABLE + FORCE + an isolating policy on
 * every table with a clinic_id. This file pins what is specific to 0044 and
 * what other sessions build on: the privileges the runtime role keeps on each
 * new table, that a channel's first answer can be recorded only once, that
 * channel_events cannot be rewritten, and that the new entitlements and
 * clinic_settings columns stay writable by the paths that write them.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block on the RUNTIME role, optionally inside a tenant, always rolled back. */
async function asApp<T>(clinicId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

const NEW_TENANT_TABLES = ["clinic_channels", "channel_events", "clinic_closures"];

async function tablePrivileges(table: string): Promise<Record<string, boolean>> {
  const { rows } = await getMigratorPool().query<Record<string, boolean>>(
    `select has_table_privilege('healdesk_app', $1::regclass, 'SELECT') as select,
            has_table_privilege('healdesk_app', $1::regclass, 'INSERT') as insert,
            has_table_privilege('healdesk_app', $1::regclass, 'UPDATE') as update,
            has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as delete`,
    [table],
  );
  return rows[0]!;
}

/** The columns of `table` the runtime role may UPDATE, sorted. */
async function updatableColumns(table: string): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ attname: string }>(
    `select a.attname
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')
      order by a.attname`,
    [table],
  );
  return rows.map((r) => r.attname);
}

describeDb("drizzle/0044: the funnel and portal contracts schema", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("each new table forces RLS, has its isolation policy and is listed as tenant-scoped", async () => {
    const { rows } = await getMigratorPool().query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string[];
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              coalesce(array_agg(p.polname::text) filter (where p.polname is not null), array[]::text[]) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         left join pg_policy p on p.polrelid = c.oid
        where c.relname = any($1::text[])
        group by c.relname, c.relrowsecurity, c.relforcerowsecurity`,
      [NEW_TENANT_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...NEW_TENANT_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(row.policies, row.relname).toEqual([`${row.relname}_tenant_isolation`]);
      expect((TENANT_SCOPED_TABLES as readonly string[]).includes(row.relname), row.relname).toBe(
        true,
      );
    }
  });

  test("the runtime role keeps exactly the privileges the contracts give each new table", async () => {
    expect(await tablePrivileges("clinic_channels")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(await tablePrivileges("channel_events")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(await tablePrivileges("clinic_closures")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: true,
    });
    // Where table-level UPDATE is withheld, these are the only columns left.
    // Since 0078 the lifecycle stamps (ready_at, live_at, first_answer_at)
    // are the channel definers' alone.
    expect(await updatableColumns("clinic_channels")).toEqual([
      "enabled",
      "updated_at",
      "waiting_on",
    ]);
    expect(await updatableColumns("channel_events")).toEqual([]);
    expect(await updatableColumns("clinic_closures")).toEqual(["label"]);
  });

  test("a channel's first answer is recorded once; every other kind may repeat", async () => {
    const { clinicId } = await seedClinic("first-answer");
    // As the migrator, the definers' owner: since 0078 the runtime role
    // inserts none of these kinds itself.
    await inTenant(clinicId, async (c) => {
      const insert = (channel: string | null, kind: string) =>
        c.query(`insert into channel_events (clinic_id, channel, kind) values ($1, $2, $3)`, [
          clinicId,
          channel,
          kind,
        ]);
      await insert("voice", "first_answer");
      await c.query(`savepoint s`);
      await expect(insert("voice", "first_answer")).rejects.toMatchObject({ code: "23505" });
      await c.query(`rollback to savepoint s`);

      // The engine's way to record it: a no-op the second time, on INSERT alone.
      const again = await c.query(
        `insert into channel_events (clinic_id, channel, kind) values ($1, 'voice', 'first_answer')
         on conflict (clinic_id, channel) where kind = 'first_answer' do nothing returning id`,
        [clinicId],
      );
      expect(again.rows).toEqual([]);

      // Another channel's first answer is its own, and other kinds repeat.
      await insert("web", "first_answer");
      await insert("voice", "live");
      await insert("voice", "live");
      await insert(null, "paused");
      await insert(null, "paused");
      const { rows } = await c.query<{ n: number }>(
        `select count(*)::int as n from channel_events where kind = 'first_answer'`,
      );
      expect(rows[0]!.n).toBe(2);
    });
  });

  test("channel_events is append-only for the runtime role", async () => {
    const { clinicId } = await seedClinic("append-only");
    await asApp(clinicId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into channel_events (clinic_id, channel, kind, actor, detail, waiting_on)
         values ($1, 'web', 'waiting', 'system', '{"count": 1}', 'snippet') returning id`,
        [clinicId],
      );
      const id = rows[0]!.id;
      await c.query(`savepoint s`);
      await expect(
        c.query(`update channel_events set kind = 'live' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint s`);
      await expect(
        c.query(`update channel_events set occurred_at = now() - interval '1 day' where id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint s`);
      await expect(c.query(`delete from channel_events where id = $1`, [id])).rejects.toMatchObject(
        {
          code: "42501",
        },
      );
    });
  });

  test("a channel event names its channel unless it is the clinic-wide pause, and only known values pass", async () => {
    const { clinicId } = await seedClinic("event-checks");
    await asApp(clinicId, async (c) => {
      await c.query(`savepoint s`);
      const refused: [string | null, string, string | null][] = [
        [null, "turned_on", null],
        [null, "waiting", null],
        ["sms", "waiting", null],
        ["web", "renamed", null],
        ["voice", "waiting", "fax"],
      ];
      for (const [channel, kind, waitingOn] of refused) {
        await expect(
          c.query(
            `insert into channel_events (clinic_id, channel, kind, waiting_on) values ($1, $2, $3, $4)`,
            [clinicId, channel, kind, waitingOn],
          ),
          `${channel} ${kind} ${waitingOn}`,
        ).rejects.toMatchObject({ code: "23514" });
        await c.query(`rollback to savepoint s`);
      }
      await c.query(
        `insert into channel_events (clinic_id, channel, kind, waiting_on) values ($1, 'voice', 'waiting', 'forwarding')`,
        [clinicId],
      );
      await c.query(`insert into channel_events (clinic_id, kind) values ($1, 'resumed')`, [
        clinicId,
      ]);
    });
  });

  test("clinic_channels holds one row per bought channel, and only its state moves", async () => {
    const { clinicId } = await seedClinic("channels");
    await asApp(clinicId, async (c) => {
      await c.query(
        `insert into clinic_channels (clinic_id, channel) values ($1, 'web'), ($1, 'voice')`,
        [clinicId],
      );
      await c.query(`savepoint s`);
      await expect(
        c.query(`insert into clinic_channels (clinic_id, channel) values ($1, 'web')`, [clinicId]),
      ).rejects.toMatchObject({ code: "23505" });
      await c.query(`rollback to savepoint s`);
      // The channel is the catalog's, not a platform.
      await expect(
        c.query(`insert into clinic_channels (clinic_id, channel) values ($1, 'instagram')`, [
          clinicId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query(`rollback to savepoint s`);
      await expect(
        c.query(
          `insert into clinic_channels (clinic_id, channel, waiting_on) values ($1, 'meta', 'fax')`,
          [clinicId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query(`rollback to savepoint s`);

      const moved = await c.query(
        `update clinic_channels set waiting_on = 'snippet', enabled = false, updated_at = now()
          where clinic_id = $1 and channel = 'web' returning channel`,
        [clinicId],
      );
      expect(moved.rows).toHaveLength(1);
      await c.query(`savepoint t`);
      // The lifecycle stamps are the channel definers' (0078).
      for (const column of ["ready_at", "live_at", "first_answer_at"]) {
        await expect(
          c.query(`update clinic_channels set ${column} = now() where clinic_id = $1 and channel = 'web'`, [
            clinicId,
          ]),
          column,
        ).rejects.toMatchObject({ code: "42501" });
        await c.query(`rollback to savepoint t`);
      }
      await expect(
        c.query(
          `update clinic_channels set channel = 'meta' where clinic_id = $1 and channel = 'web'`,
          [clinicId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint t`);
      await expect(
        c.query(`delete from clinic_channels where clinic_id = $1`, [clinicId]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("clinic_closures holds a day once per clinic; it can be relabelled or removed, never moved", async () => {
    const { clinicId } = await seedClinic("closures-schema");
    await asApp(clinicId, async (c) => {
      await c.query(
        `insert into clinic_closures (clinic_id, closed_on, label) values ($1, '2026-12-25', 'Christmas Day')`,
        [clinicId],
      );
      await c.query(`savepoint s`);
      await expect(
        c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-25')`, [
          clinicId,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
      await c.query(`rollback to savepoint s`);
      await expect(
        c.query(
          `insert into clinic_closures (clinic_id, closed_on, label) values ($1, '2026-12-26', $2)`,
          [clinicId, "x".repeat(81)],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query(`rollback to savepoint s`);
      await expect(
        c.query(`update clinic_closures set closed_on = '2026-12-27' where clinic_id = $1`, [
          clinicId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint s`);

      const relabelled = await c.query(
        `update clinic_closures set label = 'Closed for the holiday' where clinic_id = $1 returning closed_on`,
        [clinicId],
      );
      expect(relabelled.rows).toHaveLength(1);
      const removed = await c.query(
        `delete from clinic_closures where clinic_id = $1 and closed_on = '2026-12-25' returning closed_on`,
        [clinicId],
      );
      expect(removed.rows).toHaveLength(1);
    });
  });

  test("the new entitlements and clinic_settings columns are writable by the runtime role", async () => {
    const { clinicId } = await seedClinic("contracts-columns");
    await asApp(clinicId, async (c) => {
      await c.query(
        `insert into entitlements (clinic_id, plan_code, billing_interval) values ($1, 'voice-webchat-1000-1000', 'month')`,
        [clinicId],
      );
      const started = await c.query(
        `update entitlements
            set plan_started_at = now(), bought_plan_id = 'voice-metachat-1000-1000', setup_deadline_at = now() + interval '30 days'
          where clinic_id = $1 returning clinic_id`,
        [clinicId],
      );
      expect(started.rows).toHaveLength(1);
      // Ops extends the setup window after insert.
      const extended = await c.query(
        `update entitlements set setup_deadline_at = setup_deadline_at + interval '7 days' where clinic_id = $1 returning clinic_id`,
        [clinicId],
      );
      expect(extended.rows).toHaveLength(1);

      await c.query(
        `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_by_label, ai_paused_until)
         values ($1, now(), 'Front desk Mac', now() + interval '1 hour')`,
        [clinicId],
      );
      const resumed = await c.query(
        `update clinic_settings set ai_paused_at = null, ai_paused_by_label = null, ai_paused_until = null
          where clinic_id = $1 returning clinic_id`,
        [clinicId],
      );
      expect(resumed.rows).toHaveLength(1);
    });
  });

  test("welcome_resend has left the outbox's CHECK", async () => {
    expect((BILLING_NOTICE_KINDS as readonly string[]).includes("welcome_resend")).toBe(false);
    const { clinicId } = await seedClinic("no-welcome-resend");
    await asApp(clinicId, async (c) => {
      await expect(
        c.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, 'welcome_resend', 'k')`,
          [clinicId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});
