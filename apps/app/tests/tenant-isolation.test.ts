import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  APP_URL,
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedContact } from "./setup/factories";

/**
 * Tenant isolation.
 *
 * These are the tests that decide whether the product may hold patient data.
 * They do not check that the application remembers to filter by clinic — they
 * assume it forgets, and check the database refuses anyway.
 *
 * Every one of them must pass before any connector code merges.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/**
 * Run a callback on an app-role connection with the tenant set, always rolling
 * back and always releasing.
 *
 * The always-rollback matters more than it looks: a failed expectation inside a
 * transaction leaves the connection in an aborted state, and releasing it back
 * to the pool poisons every later test with "current transaction is aborted".
 * One test's failure then cascades into unrelated ones and hides the real cause.
 */
async function asTenant<T>(
  clinicId: string,
  fn: (client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  }) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [
      clinicId,
    ]);
    return await fn(client as never);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

describeDb("tenant isolation", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the runtime role neither bypasses RLS nor owns the tables", async () => {
    const app = getAppPool();

    const { rows: roles } = await app.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select current_user, r.rolsuper, r.rolbypassrls
         from pg_roles r where r.rolname = current_user`,
    );
    const role = roles[0]!;

    // Catches Supabase's service_role and Neon's neondb_owner, both of which
    // silently ignore every policy in this database.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);

    // FORCE ROW LEVEL SECURITY makes owners subject to policies, but the app
    // still must not be the owner — that is one accidental ALTER away from
    // being exempt again.
    const { rows: owners } = await app.query<{ tableowner: string }>(
      `select tableowner from pg_tables
        where schemaname = 'public' and tablename = 'contacts'`,
    );
    expect(owners[0]!.tableowner).not.toBe(role.current_user);
  });

  test("cannot read another clinic's contact by its primary key", async () => {
    const alpha = await seedClinic("alpha");
    const beta = await seedClinic("beta");
    const victim = await seedContact(beta.clinicId, "+15550199999");

    // The strongest form of the attack: a known primary key, no clinic filter,
    // bypassing every application-layer guard. RLS must FILTER this to nothing
    // rather than error — an error would itself confirm the row exists.
    const rows = await asTenant(alpha.clinicId, async (c) => {
      const result = await c.query(`select * from contacts where id = $1`, [
        victim,
      ]);
      return result.rows;
    });

    expect(rows).toHaveLength(0);
  });

  test("cannot write a row into another clinic", async () => {
    const alpha = await seedClinic("alpha-w");
    const beta = await seedClinic("beta-w");

    // Without WITH CHECK a tenant could insert rows it could never read back.
    // 42501 specifically: an RLS refusal, not the BAA trigger firing for the
    // wrong reason — see the SECURITY DEFINER note in 0001_security_functions.
    await expect(
      asTenant(alpha.clinicId, (c) =>
        c.query(
          `insert into contacts (clinic_id, phone) values ($1, '+15550100001')`,
          [beta.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("with no tenant set, every PHI table reads empty", async () => {
    const clinic = await seedClinic("nogusc");
    await seedContact(clinic.clinicId);

    // Straight through the app pool with no wrapper at all. This is exactly
    // what a bypassed withTenant() would get.
    const app = getAppPool();
    for (const table of [
      "contacts",
      "conversations",
      "appointments",
      "transactions",
      "clinic_memberships",
      "provider_connections",
      "audit_log",
    ]) {
      const { rows } = await app.query<{ count: string }>(
        `select count(*)::int as count from ${table}`,
      );
      expect(
        Number(rows[0]!.count),
        `${table} leaked rows with no tenant set`,
      ).toBe(0);
    }
  });

  test("the channel and closure tables (0044) show a clinic only its own rows, and take no write into another", async () => {
    const alpha = await seedClinic("alpha-ch");
    const beta = await seedClinic("beta-ch");
    for (const c of [alpha, beta]) {
      await inTenant(c.clinicId, async (client) => {
        await client.query(`insert into clinic_channels (clinic_id, channel) values ($1, 'web')`, [
          c.clinicId,
        ]);
        await client.query(
          `insert into channel_events (clinic_id, channel, kind) values ($1, 'web', 'first_answer')`,
          [c.clinicId],
        );
        await client.query(
          `insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-25')`,
          [c.clinicId],
        );
      });
    }

    for (const table of ["clinic_channels", "channel_events", "clinic_closures"]) {
      const seen = await asTenant(alpha.clinicId, async (c) => {
        const result = await c.query(`select clinic_id from ${table}`);
        return result.rows;
      });
      expect(seen, table).toEqual([{ clinic_id: alpha.clinicId }]);

      const { rows } = await getAppPool().query<{ count: number }>(
        `select count(*)::int as count from ${table}`,
      );
      expect(rows[0]!.count, `${table} leaked rows with no tenant set`).toBe(0);
    }

    for (const insert of [
      `insert into clinic_channels (clinic_id, channel) values ($1, 'voice')`,
      `insert into channel_events (clinic_id, channel, kind) values ($1, 'voice', 'live')`,
      `insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-26')`,
    ]) {
      await expect(
        asTenant(alpha.clinicId, (c) => c.query(insert, [beta.clinicId])),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  test("the billing request ledger (0050) shows a clinic only its own rows, and takes no write into another", async () => {
    const alpha = await seedClinic("alpha-req");
    const beta = await seedClinic("beta-req");
    for (const c of [alpha, beta]) {
      await inTenant(c.clinicId, async (client) => {
        await client.query(
          `insert into billing_requests (clinic_id, kind, reason) values ($1, 'plan_start', 'first_answer')`,
          [c.clinicId],
        );
      });
    }

    const seen = await asTenant(alpha.clinicId, async (c) => {
      const result = await c.query(`select clinic_id from billing_requests`);
      return result.rows;
    });
    expect(seen).toEqual([{ clinic_id: alpha.clinicId }]);

    const { rows } = await getAppPool().query<{ count: number }>(
      `select count(*)::int as count from billing_requests`,
    );
    expect(rows[0]!.count, "billing_requests leaked rows with no tenant set").toBe(0);

    await expect(
      asTenant(alpha.clinicId, (c) =>
        c.query(
          `insert into billing_requests (clinic_id, kind, reason) values ($1, 'close_setup', 'deadline')`,
          [beta.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // And a tenant cannot reach another's row to rewrite it: the update finds nothing.
    const moved = await asTenant(alpha.clinicId, async (c) => {
      const result = await c.query(
        `update billing_requests set next_attempt_at = now() where clinic_id = $1 returning id`,
        [beta.clinicId],
      );
      return result.rows;
    });
    expect(moved).toEqual([]);
  });

  test("the tenant setting does not survive into the next borrower of a pooled connection", async () => {
    const clinic = await seedClinic("pooled");

    // A pool of exactly one, so the next query is guaranteed to reuse the same
    // backend. This is the entire reason set_config's third argument is `true`:
    // a session-scoped SET would leak clinic access to the next request.
    const single = new Pool({ connectionString: APP_URL, max: 1 });
    try {
      const client = await single.connect();
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [
        clinic.clinicId,
      ]);
      await client.query(`select count(*) from contacts`);
      await client.query("commit");
      client.release();

      const { rows } = await single.query<{ v: string | null }>(
        `select current_setting('app.clinic_id', true) as v`,
      );
      expect(rows[0]!.v ?? "").toBe("");
    } finally {
      await single.end();
    }
  });

  test("audit_log is append-only for the runtime role", async () => {
    const clinic = await seedClinic("audit");

    await inTenant(clinic.clinicId, async (c) => {
      await c.query(
        `insert into audit_log (clinic_id, actor_type, actor_service_name, actor_label, action, resource_type)
         values ($1, 'service', 'seed', 'seed', 'read', 'contact')`,
        [clinic.clinicId],
      );
    });

    // An audit trail the application can rewrite is not an audit trail.
    // Enforced by withheld grants (0003), so even a fully compromised app
    // process cannot erase evidence of what it did.
    await expect(
      asTenant(clinic.clinicId, (c) =>
        c.query(`update audit_log set action = 'tampered'`),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      asTenant(clinic.clinicId, (c) => c.query(`delete from audit_log`)),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("the BAA gate refuses PHI for a production clinic with no signed BAA", async () => {
    const clinic = await seedClinic("baa");

    // Flip to production without signing anything — the state the gate exists for.
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = null where id = $1`,
      [clinic.clinicId],
    );

    await expect(
      seedContact(clinic.clinicId, "+15550177777"),
    ).rejects.toMatchObject({ code: "23514" });

    // Signing the BAA opens the gate: an agreement in effect for the
    // practice (drizzle/0062), and go-live's copy of when it was accepted.
    await bindAgreementInEffect(clinic.clinicId);
    await getMigratorPool().query(
      `update clinics set baa_signed_at = now() where id = $1`,
      [clinic.clinicId],
    );
    await expect(
      seedContact(clinic.clinicId, "+15550177778"),
    ).resolves.toBeTruthy();
  });
});
