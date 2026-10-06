import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * The September database audit, asserted (drizzle/0031_database_audit.sql).
 *
 * Each test here is one finding from docs/state-of-play.md "Database-layer
 * findings", written so that the fix cannot quietly regress: a hand-run
 * GRANT, a new column, a new SECURITY DEFINER function or a new PHI table
 * without the gate trigger fails here, not in production.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Client = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

/** One statement on the app role inside a declared tenant, always rolled back. */
async function asTenant<T>(clinicId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) {
      await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    }
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** A signed agreement row, inserted as the migrator. Unbound unless an org is given. */
async function seedAcceptance(organizationId: string | null): Promise<string> {
  const id = randomUUID();
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, '1.0.0', repeat('a', 64), 'BUSINESS ASSOCIATE AGREEMENT (test)',
             $3::jsonb, 'I agree', 'Alex Chen', 'alex@radiance.test', now(),
             case when $2::text is null then null else now() end)`,
    [id, organizationId, JSON.stringify({ clinicLegalName: "Radiance", isCoveredEntity: false })],
  );
  return id;
}

describeDb("database audit (0031)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the runtime role cannot flip a clinic to production or forge a BAA date", async () => {
    const { clinicId } = await seedClinic("gate");

    await asTenant(clinicId, async (c) => {
      await expect(
        c.query(`update clinics set data_classification = 'production' where id = $1`, [clinicId]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    await asTenant(clinicId, async (c) => {
      await expect(
        c.query(`update clinics set baa_signed_at = now() where id = $1`, [clinicId]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    // Ordinary configuration is untouched by the narrowing.
    await asTenant(clinicId, async (c) => {
      const { rows } = await c.query(
        `update clinics set name = 'Renamed', timezone = 'America/Chicago' where id = $1 returning name`,
        [clinicId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  test("every clinics column except the gate columns stays updatable (a new column needs its GRANT)", async () => {
    const { rows } = await getMigratorPool().query<{ attname: string; ok: boolean }>(`
      select a.attname,
             has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE') as ok
        from pg_attribute a
       where a.attrelid = 'clinics'::regclass and a.attnum > 0 and not a.attisdropped
    `);
    const locked = rows.filter((r) => !r.ok).map((r) => r.attname).sort();
    // The BAA gate's two (0031), and the agreement-kind gate's two (0048).
    expect(locked).toEqual(["agreement_kind", "baa_signed_at", "data_classification", "regulatory_regime"]);
  });

  test("app_mark_clinic_production refuses without a bound agreement and copies its date with one", async () => {
    const { clinicId, organizationId } = await seedClinic("golive");

    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    const agreementId = await seedAcceptance(organizationId);

    // Bound agreement but covered-entity status still "I'm not sure": still no.
    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514" });
    });
    await getMigratorPool().query(`update clinics set is_covered_entity = false where id = $1`, [clinicId]);

    // Still no: the onboarding checklist (0033) is open. The refusal names it.
    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/opening hours/) });
    });
    await getMigratorPool().query(
      `update clinics
          set opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb,
              call_routing_confirmed_at = now(),
              agent_approved_at = now(),
              onboarding = jsonb_build_object(
                'hours_confirmed', now()::text, 'phone_type_confirmed', now()::text,
                'call_routing_chosen', now()::text, 'covered_entity_confirmed', now()::text,
                'agent_script_approved', now()::text, 'forwarding_configured', now()::text,
                'test_call_passed', now()::text, 'booking_requirements_confirmed', now()::text)
        where id = $1`,
      [clinicId],
    );

    const { rows: accepted } = await getMigratorPool().query<{ accepted_at: Date }>(
      `select accepted_at from baa_acceptances where id = $1`,
      [agreementId],
    );

    // Committed, not rolled back: the flip is the thing under test.
    const { rows } = await getAppPool().query<{ signed: Date }>(
      `select app_mark_clinic_production($1::uuid) as signed`,
      [clinicId],
    );
    expect(rows[0]!.signed.getTime()).toBe(accepted[0]!.accepted_at.getTime());

    const { rows: clinic } = await getMigratorPool().query<{
      data_classification: string;
      baa_signed_at: Date;
    }>(`select data_classification, baa_signed_at from clinics where id = $1`, [clinicId]);
    expect(clinic[0]!.data_classification).toBe("production");
    expect(clinic[0]!.baa_signed_at.getTime()).toBe(accepted[0]!.accepted_at.getTime());

    // A terminated agreement no longer qualifies.
    await getMigratorPool().query(`update baa_acceptances set terminated_at = now() where id = $1`, [
      agreementId,
    ]);
    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  test("binding is one-way, once, and off the runtime role's direct reach", async () => {
    const { organizationId } = await seedClinic("bind");
    const other = await seedClinic("bindother");
    const unbound = await seedAcceptance(null);

    await asTenant(null, async (c) => {
      await expect(
        c.query(`update baa_acceptances set organization_id = $1 where id = $2`, [
          organizationId,
          unbound,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    });

    await asTenant(null, async (c) => {
      const first = await c.query<{ v: { clinicLegalName: string } | null }>(
        `select app_bind_agreement($1::uuid, $2::text) as v`,
        [unbound, organizationId],
      );
      expect(first.rows[0]!.v?.clinicLegalName).toBe("Radiance");

      // Already bound: NULL, never a rebind — even to a real organisation.
      const again = await c.query<{ v: unknown }>(
        `select app_bind_agreement($1::uuid, $2::text) as v`,
        [unbound, other.organizationId],
      );
      expect(again.rows[0]!.v).toBeNull();
    });

    // One agreement per organisation.
    const second = await seedAcceptance(null);
    const held = await seedAcceptance(organizationId);
    expect(held).toBeTruthy();
    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_bind_agreement($1::uuid, $2::text)`, [second, organizationId]),
      ).rejects.toMatchObject({ code: "23505" });
    });

    // And never to an organisation that does not exist.
    await asTenant(null, async (c) => {
      await expect(
        c.query(`select app_bind_agreement($1::uuid, $2::text)`, [second, "org_nowhere"]),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  test("a tenant session sees only its own organisation's agreement; the service context sees all", async () => {
    const a = await seedClinic("orgA");
    const b = await seedClinic("orgB");
    const mine = await seedAcceptance(a.organizationId);
    await seedAcceptance(b.organizationId);

    await asTenant(a.clinicId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`select id from baa_acceptances`);
      expect(rows.map((r) => r.id)).toEqual([mine]);
    });

    await asTenant(null, async (c) => {
      const { rows } = await c.query<{ n: number }>(`select count(*)::int as n from baa_acceptances`);
      expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
    });
  });

  test("every SECURITY DEFINER function pins its search_path", async () => {
    const { rows } = await getMigratorPool().query<{ proname: string; proconfig: string[] | null }>(`
      select p.proname, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const fn of rows) {
      expect(
        (fn.proconfig ?? []).some((c) => c.startsWith("search_path=")),
        `${fn.proname} is SECURITY DEFINER with no pinned search_path`,
      ).toBe(true);
    }
  });

  test("the identity plane's records of who got in, and with what, cannot be erased by the runtime role", async () => {
    // security_events (0003), sign_in_links (0043), and the portal's second
    // factors and step-ups (0047): which device's passkey could open patient
    // data, and when. A new table of this kind belongs on this list.
    for (const table of [
      "security_events",
      "sign_in_links",
      "user_factors",
      "user_backup_codes",
      "webauthn_challenges",
      "step_ups",
      "factor_lockouts",
    ]) {
      const { rows } = await getMigratorPool().query<{ deletable: boolean }>(
        `select has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as deletable`,
        [table],
      );
      expect(rows[0]!.deletable, table).toBe(false);
    }
  });

  test("the BAA gate trigger guards every table that carries a caller's number or payload", async () => {
    const expected = [
      "appointments",
      "booking_requests",
      "consent_records",
      "contact_attempts",
      "contacts",
      "conversations",
      "deposit_payments",
      "meta_booking_drafts",
      "suppressions",
      "transactions",
      "webhook_events",
    ];
    const { rows } = await getMigratorPool().query<{ relname: string }>(`
      select distinct c.relname
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'app_enforce_baa_gate' and not t.tgisinternal
       order by c.relname
    `);
    expect(rows.map((r) => r.relname)).toEqual(expected);
  });
});
