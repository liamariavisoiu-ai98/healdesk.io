import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { BILLING_NOTICE_KINDS, SIGN_IN_LINK_PURPOSES, TENANT_SCOPED_TABLES } from "@/db/schema";
import {
  JOB_ANNUAL_OVERAGE_INVOICE,
  JOB_BILLING_HOUSEKEEPING,
  JOB_BILLING_NOTICES,
  JOB_USAGE_ALERTS,
  JOB_USAGE_METER_REPORT,
} from "@/lib/scheduler/jobs";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * drizzle/0043 (the Stripe launch), asserted.
 *
 * rls-drift.test.ts already demands ENABLE + FORCE + an isolating policy on
 * every table with a clinic_id, whoever adds it. This file pins the parts
 * that are specific to 0043 and that no generic test would notice going
 * wrong: which privileges the runtime role keeps on each new table, the
 * freeze on a consumed sign-in link, and the three definer functions —
 * including that the tenant walk hands the caller's tenant setting back.
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

const NEW_TENANT_TABLES = [
  "clinic_settings",
  "usage_events",
  "chat_threads",
  "meta_inbound_messages",
  "billing_notices",
  "overage_invoices",
  "deposit_payments",
];

const NEW_IDENTITY_TABLES = [
  "checkout_intents",
  "sign_in_links",
  "stripe_connect_events",
  "stripe_connect_states",
];

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

describeDb("drizzle/0043: the Stripe launch schema", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("each new tenant table forces RLS, has its isolation policy and is listed as tenant-scoped", async () => {
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

  test("the identity-plane tables have no clinic_id column, so no tenant policy can hide them from their no-tenant readers", async () => {
    const { rows } = await getMigratorPool().query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'clinic_id' and table_name = any($1::text[])`,
      [NEW_IDENTITY_TABLES],
    );
    expect(rows).toEqual([]);
  });

  test("the runtime role keeps exactly the privileges the design gives each new table", async () => {
    const expected: Record<
      string,
      { select: boolean; insert: boolean; update: boolean; delete: boolean }
    > = {
      checkout_intents: { select: true, insert: true, update: true, delete: true },
      sign_in_links: { select: true, insert: true, update: false, delete: false },
      clinic_settings: { select: true, insert: true, update: true, delete: false },
      usage_events: { select: true, insert: true, update: false, delete: false },
      chat_threads: { select: true, insert: true, update: true, delete: true },
      meta_inbound_messages: { select: true, insert: true, update: false, delete: true },
      billing_notices: { select: true, insert: true, update: false, delete: false },
      overage_invoices: { select: true, insert: true, update: true, delete: false },
      deposit_payments: { select: true, insert: true, update: true, delete: false },
      stripe_connect_events: { select: true, insert: true, update: true, delete: false },
      stripe_connect_states: { select: true, insert: true, update: true, delete: true },
    };
    for (const [table, want] of Object.entries(expected)) {
      expect(await tablePrivileges(table), table).toEqual(want);
    }
    // Where table-level UPDATE is withheld, these are the only columns left.
    expect(await updatableColumns("sign_in_links")).toEqual(["consumed_ip", "used_at"]);
    expect(await updatableColumns("usage_events")).toEqual([
      "stripe_report_attempts",
      "stripe_report_error",
      "stripe_reported_at",
    ]);
    expect(await updatableColumns("billing_notices")).toEqual([
      "attempts",
      "last_error",
      "recipients_count",
      "send_after",
      "sent_at",
    ]);
    expect(await updatableColumns("meta_inbound_messages")).toEqual([]);
  });

  test("a usage event cannot be deleted or have its quantity rewritten; only the Stripe columns move", async () => {
    const { clinicId } = await seedClinic("usage-ledger");
    const ref = createHash("sha256").update("call-1").digest("hex");
    await asApp(clinicId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into usage_events (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at, included, used_before, over_allowance)
         values ($1, $1, 'voice_minutes', 'voice_call', $2, 2, now(), 1000, 999, 1) returning id`,
        [clinicId, ref],
      );
      const id = rows[0]!.id;
      await c.query(`savepoint s`);
      await expect(
        c.query(`update usage_events set quantity = 1 where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint s`);
      await expect(c.query(`delete from usage_events where id = $1`, [id])).rejects.toMatchObject({
        code: "42501",
      });
      await c.query(`rollback to savepoint s`);
      const updated = await c.query(
        `update usage_events set stripe_reported_at = now(), stripe_report_attempts = 1 where id = $1 returning id`,
        [id],
      );
      expect(updated.rows).toHaveLength(1);
      // A redelivered webhook is a no-op, by the unique index.
      await expect(
        c.query(
          `insert into usage_events (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at, included, used_before)
           values ($1, $1, 'voice_minutes', 'voice_call', $2, 2, now(), 1000, 1001)`,
          [clinicId, ref],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  test("a sign-in link stores a digest only, and once consumed it cannot be re-armed or edited", async () => {
    const { staffUserId } = await seedClinic("links");
    const hash = createHash("sha256").update(randomBytes(32)).digest();

    await asApp(null, async (c) => {
      // A raw token (not 32 bytes) is refused by the CHECK, as in connection_links.
      await c.query(`savepoint s`);
      await expect(
        c.query(
          `insert into sign_in_links (user_id, token_hash, purpose, expires_at) values ($1, $2, 'sign_in', now() + interval '15 minutes')`,
          [staffUserId, Buffer.from("not-a-digest")],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await c.query(`rollback to savepoint s`);
      // An off-site redirect is refused, including the spellings a browser
      // normalises to `//host`: a backslash, or a tab or newline it strips.
      for (const offsite of [
        "//evil.example",
        "https://evil.example",
        "/\\evil.example",
        "/\t/evil.example",
        "/\n/evil.example",
      ]) {
        await expect(
          c.query(
            `insert into sign_in_links (user_id, token_hash, purpose, redirect_to, expires_at) values ($1, $2, 'sign_in', $3, now() + interval '15 minutes')`,
            [staffUserId, hash, offsite],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await c.query(`rollback to savepoint s`);
      }

      const { rows } = await c.query<{ id: string }>(
        `insert into sign_in_links (user_id, token_hash, purpose, redirect_to, expires_at)
         values ($1, $2, 'welcome', '/c/somewhere', now() + interval '7 days') returning id`,
        [staffUserId, hash],
      );
      const id = rows[0]!.id;

      // The runtime role cannot reach the other columns at all.
      await c.query(`savepoint t`);
      await expect(
        c.query(`update sign_in_links set expires_at = now() + interval '1 year' where id = $1`, [
          id,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint t`);

      // Consumption is one conditional UPDATE.
      const consumed = await c.query(
        `update sign_in_links set used_at = now(), consumed_ip = '203.0.113.7' where id = $1 and used_at is null returning id`,
        [id],
      );
      expect(consumed.rows).toHaveLength(1);

      await c.query(`savepoint u`);
      await expect(
        c.query(`update sign_in_links set used_at = null where id = $1`, [id]),
      ).rejects.toMatchObject({
        code: "42501",
      });
      await c.query(`rollback to savepoint u`);
      await expect(
        c.query(`update sign_in_links set consumed_ip = '198.51.100.1' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query(`rollback to savepoint u`);
      await expect(c.query(`delete from sign_in_links where id = $1`, [id])).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  test("every notice kind and link purpose the code knows passes its CHECK", async () => {
    // The CHECKs are built from these lists in schema.ts; this proves the
    // migration that is actually applied agrees, so a new kind cannot first
    // fail as a 23514 inside a Stripe event's transaction.
    const { clinicId, staffUserId } = await seedClinic("kinds");
    await inTenant(clinicId, async (c) => {
      for (const kind of BILLING_NOTICE_KINDS) {
        await c.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, $2, 'kinds-test')`,
          [clinicId, kind],
        );
      }
    });
    for (const purpose of SIGN_IN_LINK_PURPOSES) {
      await getMigratorPool().query(
        `insert into sign_in_links (user_id, token_hash, purpose, expires_at) values ($1, $2, $3, now() + interval '1 minute')`,
        [staffUserId, createHash("sha256").update(randomBytes(32)).digest(), purpose],
      );
    }
  });

  test("one source mints at most one link of a purpose", async () => {
    const { staffUserId } = await seedClinic("source");
    const sourceRef = createHash("sha256").update(randomUUID()).digest("hex");
    await asApp(null, async (c) => {
      const insert = () =>
        c.query(
          `insert into sign_in_links (user_id, token_hash, purpose, source_ref, expires_at) values ($1, $2, 'checkout', $3, now() + interval '10 minutes')`,
          [staffUserId, createHash("sha256").update(randomBytes(16)).digest(), sourceRef],
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({ code: "23505" });
    });
  });

  test("app_user_clinic_grants returns exactly the user's active grants and hands back the caller's tenant", async () => {
    const a = await seedClinic("grants-a");
    const b = await seedClinic("grants-b");
    // A second location in organisation A, where the same user holds a billing grant.
    const { rows: second } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, 'Grants A Two', 'med-spa', $3) returning id`,
      [a.organizationId, `grants-a2-${randomUUID().slice(0, 6)}`, a.clinicId],
    );
    const a2 = second[0]!.id;
    await inTenant(a2, (c) =>
      c.query(
        `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'billing')`,
        [a2, a.staffUserId],
      ),
    );
    // A third clinic in A whose grant was revoked: never returned.
    const { rows: third } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty) values ($1, $2, 'Grants A Three', 'med-spa') returning id`,
      [a.organizationId, `grants-a3-${randomUUID().slice(0, 6)}`],
    );
    const a3 = third[0]!.id;
    await inTenant(a3, (c) =>
      c.query(
        `insert into clinic_memberships (clinic_id, user_id, role, revoked_at) values ($1, $2, 'owner', now())`,
        [a3, a.staffUserId],
      ),
    );
    // Another person on clinic A: not this user's grant.
    await seedPortalUser(a.clinicId, "admin");

    await asApp(null, async (c) => {
      const { rows } = await c.query<{
        clinic_id: string;
        slug: string;
        name: string;
        role: string;
        last_seen_at: Date | null;
      }>(`select * from app_user_clinic_grants($1)`, [a.staffUserId]);
      expect(rows.map((r) => [r.clinic_id, r.role]).sort()).toEqual(
        [
          [a.clinicId, "owner"],
          [a2, "billing"],
        ].sort(),
      );
      expect(rows.find((r) => r.clinic_id === a.clinicId)!.slug).toBe(a.slug);
      expect(rows.some((r) => r.clinic_id === b.clinicId)).toBe(false);
      // Restored to "no tenant": the walk did not leave the last clinic declared.
      const { rows: after } = await c.query<{ tenant: string | null }>(
        `select app_current_clinic_id() as tenant`,
      );
      expect(after[0]!.tenant).toBeNull();
    });

    // Called from inside a tenant, it hands that tenant back unchanged.
    await asApp(b.clinicId, async (c) => {
      const { rows } = await c.query(`select * from app_user_clinic_grants($1)`, [b.staffUserId]);
      expect(rows).toHaveLength(1);
      const { rows: after } = await c.query<{ tenant: string | null }>(
        `select app_current_clinic_id()::text as tenant`,
      );
      expect(after[0]!.tenant).toBe(b.clinicId);
    });

    // A user with an active grant on a clinic but no member row in that
    // clinic's organisation is invisible: the walk is limited to the user's
    // own organisations, so a stray grant cannot open another org's clinic.
    const orphan = `usr_orphan_${randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Orphan grant', $2, true, now(), now())`,
      [orphan, `${orphan}@example-clinic.test`],
    );
    await inTenant(b.clinicId, (c) =>
      c.query(
        `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'owner')`,
        [b.clinicId, orphan],
      ),
    );
    const { rows: noMember } = await getAppPool().query(
      `select * from app_user_clinic_grants($1)`,
      [orphan],
    );
    expect(noMember).toEqual([]);
  });

  test("app_clinics_for_stripe_account and app_location_clinics answer with ids only, across tenants", async () => {
    const billing = await seedClinic("billing-root");
    const other = await seedClinic("billing-other");
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
      [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
    );
    const location = rows[0]!.id;
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_test123' where id = $1`,
      [billing.clinicId],
    );

    const app = getAppPool();
    const byAccount = await app.query<{ id: string }>(
      `select id from app_clinics_for_stripe_account($1) as id`,
      ["acct_test123"],
    );
    expect(byAccount.rows.map((r) => r.id)).toEqual([billing.clinicId]);
    const none = await app.query(`select * from app_clinics_for_stripe_account($1)`, [
      "acct_nobody",
    ]);
    expect(none.rows).toEqual([]);

    const locations = await app.query<{ id: string }>(
      `select id from app_location_clinics($1) as id`,
      [billing.clinicId],
    );
    expect(locations.rows.map((r) => r.id)).toEqual([billing.clinicId, location]);
    const alone = await app.query<{ id: string }>(`select id from app_location_clinics($1) as id`, [
      other.clinicId,
    ]);
    expect(alone.rows.map((r) => r.id)).toEqual([other.clinicId]);

    // A clinic cannot be its own billing clinic.
    await expect(
      getMigratorPool().query(`update clinics set billing_clinic_id = id where id = $1`, [
        other.clinicId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("the migration itself seeds the five billing jobs, and seeds them off", () => {
    // Read the migration, not the table: truncateAll() reseeds scheduled_jobs
    // from tests/setup/db.ts after every TRUNCATE ... CASCADE, so a query here
    // would check the harness's copy and pass with a misspelled seed.
    const sql = readFileSync(
      fileURLToPath(new URL("../drizzle/0043_stripe_launch.sql", import.meta.url)),
      "utf8",
    );
    const insert = sql.match(/INSERT INTO scheduled_jobs[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/i)?.[0];
    expect(insert, "0043 seeds scheduled_jobs").toBeDefined();
    // ('name', 'cadence, with '' escapes', enabled)
    const row = /\(\s*'([a-z-]+)'\s*,\s*'(?:[^']|'')*'\s*,\s*(true|false)\s*\)/gi;
    const seeded = [...insert!.matchAll(row)].map((m) => [m[1]!, m[2]!.toLowerCase()]);
    expect(seeded.sort()).toEqual(
      [
        ["annual-overage-invoice", "false"],
        ["billing-housekeeping", "false"],
        ["billing-notices", "false"],
        ["usage-alerts", "false"],
        ["usage-meter-report", "false"],
      ].sort(),
    );
    // And they are the names the tick runs: a mismatch makes runJob throw
    // "Unknown job" on every tick.
    expect(seeded.map(([name]) => name).sort()).toEqual(
      [
        JOB_USAGE_METER_REPORT,
        JOB_ANNUAL_OVERAGE_INVOICE,
        JOB_USAGE_ALERTS,
        JOB_BILLING_NOTICES,
        JOB_BILLING_HOUSEKEEPING,
      ].sort(),
    );
  });
});
