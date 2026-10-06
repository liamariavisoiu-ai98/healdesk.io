import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BILLING_NOTICE_KINDS, REPORT_DELIVERY_KINDS } from "@/db/schema";

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
 * drizzle/0045 (the email platform), asserted: the ledger's widened kinds and
 * its delivery columns, what the runtime role may do to the ledger and the two
 * ops tables, and the outbox's tenant walk.
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

describeDb("drizzle/0045: the email platform's schema", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the ledger's kinds are the report kinds and every outbox kind", () => {
    expect(REPORT_DELIVERY_KINDS.slice(0, 4)).toEqual(["monthly", "weekly", "alert", "renewal"]);
    for (const kind of BILLING_NOTICE_KINDS) expect(REPORT_DELIVERY_KINDS).toContain(kind);
  });

  test("the ledger refuses an unknown kind and an unknown delivery status", async () => {
    const { clinicId } = await seedClinic("ledger-checks");
    await asApp(clinicId, async (c) => {
      const insert = (kind: string, status: string | null) =>
        c.query(
          `insert into report_deliveries (clinic_id, kind, period_key, recipient, status, delivery_status)
           values ($1, $2, $3, 'desk@radiance.test', 'sent', $4)`,
          [clinicId, kind, crypto.randomUUID(), status],
        );
      await insert("payment_failed", "delivered");
      await insert("weekly", null);
      await c.query("savepoint s");
      await expect(insert("nurture", null)).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to savepoint s");
      await expect(insert("payment_failed", "opened")).rejects.toMatchObject({ code: "23514" });
    });
  });

  test("the runtime role keeps the ledger, may move only its delivery columns, and cannot delete it", async () => {
    expect(await tablePrivileges("report_deliveries")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(await updatableColumns("report_deliveries")).toEqual([
      "attempted_at",
      "delivery_at",
      "delivery_status",
      "message_id",
      "reason",
      "sent_at",
      "status",
    ]);
    const { clinicId } = await seedClinic("ledger-frozen");
    await asApp(clinicId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into report_deliveries (clinic_id, kind, period_key, recipient, status)
         values ($1, 'payment_failed', 'n1', 'desk@radiance.test', 'failed') returning id`,
        [clinicId],
      );
      const id = rows[0]!.id;
      await c.query(
        `update report_deliveries set delivery_status = 'bounced', delivery_at = now() where id = $1`,
        [id],
      );
      await c.query("savepoint s");
      await expect(
        c.query(`update report_deliveries set recipient = 'x@y.test' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback to savepoint s");
      await expect(
        c.query(`delete from report_deliveries where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("the ops log and the daily count: append and update their own columns, never delete", async () => {
    expect(await tablePrivileges("ops_alerts")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(await updatableColumns("ops_alerts")).toEqual([
      "last_error",
      "last_raised_at",
      "message_id",
      "repeats",
      "sent_at",
    ]);
    expect(await tablePrivileges("email_daily_quota")).toEqual({
      select: true,
      insert: true,
      update: false,
      delete: false,
    });
    expect(await updatableColumns("email_daily_quota")).toEqual([
      "alerted_at",
      "observed_at",
      "used",
    ]);

    await asApp(null, async (c) => {
      await c.query(
        `insert into ops_alerts (event, dedupe_key) values ('duplicate_subscription', 'clinicId=x')`,
      );
      await c.query("savepoint s");
      await expect(
        c.query(`insert into ops_alerts (event, dedupe_key) values ('Not An Event', 'k')`),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query("rollback to savepoint s");
      await expect(
        c.query(`update ops_alerts set event = 'support_reply_past_due'`),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  test("app_pending_notices walks every clinic, returns ids and kinds only, and restores the caller's tenant", async () => {
    const a = await seedClinic("pending-a");
    const b = await seedClinic("pending-b");
    const insert = (clinicId: string, kind: string, key: string, sent = false, attempts = 0) =>
      inTenant(clinicId, (c) =>
        c.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, send_after, sent_at, attempts)
           values ($1, $2, $3, '{"amountDueCents": 100}', now() - interval '1 minute',
                   case when $4::boolean then now() end, $5)`,
          [clinicId, kind, key, sent, attempts],
        ),
      );
    await insert(a.clinicId, "payment_failed", "a1");
    await insert(b.clinicId, "payment_failed", "b1");
    // Another kind, a sent one and a dead letter: none of them is returned.
    await insert(b.clinicId, "restored", "b2");
    await insert(b.clinicId, "payment_failed", "sent", true);
    await insert(b.clinicId, "payment_failed", "dead", false, 6);

    await asApp(null, async (c) => {
      const { rows } = await c.query<Record<string, unknown>>(
        `select * from app_pending_notices(array['payment_failed']::text[], 6, 100)`,
      );
      expect(rows.map((r) => r.clinic_id).sort()).toEqual([a.clinicId, b.clinicId].sort());
      expect(Object.keys(rows[0]!).sort()).toEqual([
        "attempts",
        "clinic_id",
        "created_at",
        "id",
        "kind",
        "send_after",
        "tried",
      ]);
    });

    await asApp(a.clinicId, async (c) => {
      await c.query(`select * from app_pending_notices(array['restored']::text[], 6, 100)`);
      const { rows } = await c.query<{ tenant: string }>(
        `select current_setting('app.clinic_id', true) as tenant`,
      );
      expect(rows[0]!.tenant).toBe(a.clinicId);
    });
  });
});
