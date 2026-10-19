import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TENANT_SCOPED_TABLES } from "@/db/schema";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
} from "./setup/db";

/**
 * Drift detection.
 *
 * This file is worth more than every other test here combined, because it keeps
 * working on tables that do not exist yet. It doesn't check the tables we wrote
 * policies for — it asks the catalog which tables have a clinic_id, and demands
 * each one be protected.
 *
 * The day someone adds a PHI table and forgets the policy, this fails. That is
 * the failure mode these tests exist to catch: not a bug in code we reviewed,
 * but the absence of code nobody remembered to write.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("RLS drift", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("every table with a clinic_id has RLS enabled AND forced", async () => {
    const { rows } = await getMigratorPool().query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'clinic_id'
         )
    `);

    // Guard against the query silently matching nothing and the test passing
    // vacuously — the most common way a check like this rots.
    expect(rows.length).toBeGreaterThan(0);

    for (const table of rows) {
      expect(
        table.relrowsecurity,
        `${table.relname}: RLS is not ENABLED`,
      ).toBe(true);
      expect(
        table.relforcerowsecurity,
        `${table.relname}: RLS is not FORCEd — the table owner bypasses every policy`,
      ).toBe(true);
    }
  });

  test("every table with a clinic_id actually has a policy attached", async () => {
    const { rows } = await getMigratorPool().query<{
      relname: string;
      policy_count: number;
    }>(`
      select c.relname, count(p.polname)::int as policy_count
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
       where n.nspname = 'public'
         and c.relkind = 'r'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'clinic_id'
         )
       group by c.relname
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const table of rows) {
      // ENABLE with no policy denies everything, which fails closed but breaks
      // the app in a confusing way. Both are bugs; catch them separately.
      expect(
        table.policy_count,
        `${table.relname}: RLS enabled but no policy defined`,
      ).toBeGreaterThan(0);
    }
  });

  test("clinic-scoped policies read the tenant through the STABLE helper", async () => {
    const { rows } = await getMigratorPool().query<{
      polname: string;
      relname: string;
      qual: string | null;
      withcheck: string | null;
    }>(`
      select p.polname,
             c.relname,
             pg_get_expr(p.polqual, p.polrelid)     as qual,
             pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
    `);

    expect(rows.length).toBeGreaterThan(0);

    for (const policy of rows) {
      const expression = `${policy.qual ?? ""} ${policy.withcheck ?? ""}`;

      // Calling current_setting() directly in a policy evaluates it per row.
      // Going through the STABLE helper lets the planner hoist it to an
      // InitPlan — once per query. On a large contacts table that is the
      // difference between an index scan and a sequential one.
      expect(
        expression.includes("app_current_clinic_id()"),
        `${policy.relname}.${policy.polname} does not use app_current_clinic_id(): ${expression}`,
      ).toBe(true);

      expect(
        expression.includes("current_setting("),
        `${policy.relname}.${policy.polname} calls current_setting() inline; use app_current_clinic_id()`,
      ).toBe(false);
    }
  });

  test("every clinic-scoped table has an isolation policy that names clinic_id; any other policy is a no-tenant bootstrap", async () => {
    const { rows } = await getMigratorPool().query<{
      relname: string;
      polname: string;
      expression: string;
    }>(`
      select c.relname,
             p.polname,
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expression
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = c.relname
              and col.column_name = 'clinic_id'
         )
    `);
    expect(rows.length).toBeGreaterThan(0);

    const byTable = new Map<string, typeof rows>();
    for (const row of rows) {
      byTable.set(row.relname, [...(byTable.get(row.relname) ?? []), row]);
    }

    for (const [table, policies] of byTable) {
      // The audit's complaint: "a policy exists" is not "the policy isolates".
      // At least one policy per table must compare clinic_id to the tenant.
      const isolating = policies.filter((p) => /\bclinic_id\b/.test(p.expression));
      expect(
        isolating.length,
        `${table}: no policy references clinic_id — RLS is on but isolates nothing`,
      ).toBeGreaterThan(0);

      // Everything else must be a bootstrap that only applies OUTSIDE a tenant
      // (the Stripe lookup, the connect-link token), never a second door into
      // another clinic's rows from inside one.
      for (const p of policies) {
        if (isolating.includes(p)) continue;
        expect(
          p.expression.includes("app_current_clinic_id() IS NULL"),
          `${table}.${p.polname} neither references clinic_id nor is limited to the no-tenant context: ${p.expression}`,
        ).toBe(true);
      }
    }
  });

  test("TENANT_SCOPED_TABLES names exactly the tables with a clinic_id", async () => {
    // The list is the schema's own statement of which tables are tenant data
    // (finish-common: every new tenant table goes on it). It was checked only
    // table by table, by the tests that added each, so transcript_emails
    // (drizzle/0069), FORCE RLS like every other, was missing from it for
    // a week. Compared here with the catalog, a table on one side and not
    // the other fails, whoever added it.
    const { rows } = await getMigratorPool().query<{ relname: string }>(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p')
         and exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'clinic_id'
                        and a.attnum > 0 and not a.attisdropped)
    `);
    const catalog = rows.map((r) => r.relname).sort();
    expect(catalog.length).toBeGreaterThan(20);
    expect([...TENANT_SCOPED_TABLES].sort()).toEqual(catalog);
  });

  test("the tenant helper is STABLE, so the planner can hoist it", async () => {
    const { rows } = await getMigratorPool().query<{ provolatile: string }>(
      `select provolatile from pg_proc where proname = 'app_current_clinic_id'`,
    );
    expect(rows).toHaveLength(1);
    // s = stable. 'v' (volatile) would force per-row evaluation.
    expect(rows[0]!.provolatile).toBe("s");
  });
});
