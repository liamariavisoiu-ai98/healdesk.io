import { randomUUID } from "node:crypto";

import {
  BAA_TEMPLATES,
  BOOKING_SYSTEMS,
  bookingSyncFor,
  CALENDAR_ELECTIONS,
  CURRENT_BAA_VERSION,
  getCalendarElection,
  isBaaVersionAcceptable,
} from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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

/**
 * A signed agreement row, inserted as the migrator. Unbound unless an org is
 * given. The current version unless told otherwise, because go-live refuses
 * a superseded one (0048) and only the version tests below want that.
 */
async function seedAcceptance(
  organizationId: string | null,
  version: string = CURRENT_BAA_VERSION,
): Promise<string> {
  const id = randomUUID();
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, $4, repeat('a', 64), 'BUSINESS ASSOCIATE AGREEMENT (test)',
             $3::jsonb, 'I agree', 'Alex Chen', 'alex@radiance.test', now(),
             case when $2::text is null then null else now() end)`,
    [id, organizationId, JSON.stringify({ clinicLegalName: "Radiance", isCoveredEntity: false }), version],
  );
  return id;
}

/** Everything go-live checks except the agreement, set as the onboarding call sets it. */
async function readyForGoLive(clinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set is_covered_entity = false,
            opening_hours = '{"mon":[["09:00","17:00"]]}'::jsonb,
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

  test("every clinics column except the gate columns, the offboarding dates and the record clock's history stays updatable (a new column needs its GRANT)", async () => {
    // The two BAA gate columns (0031) and the agreement-kind gate's two
    // (0051); the three offboarding dates that app_destroy_booking_requests
    // reads as its floor, which only app_start_offboarding and
    // app_mark_clinic_destroyed write; and the record clock's last
    // shortening, which app_purge_booking_requests reads and only the
    // clinics_record_clock trigger writes (booking_request_destruction
    // migration).
    const { rows } = await getMigratorPool().query<{ attname: string; ok: boolean }>(`
      select a.attname,
             has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE') as ok
        from pg_attribute a
       where a.attrelid = 'clinics'::regclass and a.attnum > 0 and not a.attisdropped
    `);
    const locked = rows.filter((r) => !r.ok).map((r) => r.attname).sort();
    // The BAA gate's two (0031), the agreement-kind gate's two (0051), the
    // offboarding and record-clock columns (0054), and the client number every
    // sealed credential is labelled with (migration A, 0057).
    expect(locked).toEqual([
      "agreement_kind",
      "baa_signed_at",
      "client_number",
      "data_classification",
      "destroy_after",
      "destroyed_at",
      "offboarding_started_at",
      "regulatory_regime",
      "retention_record_days_previous",
      "retention_record_days_shortened_at",
    ]);
  });

  test("client numbers are issued in order of creation and never change, for any role (0057)", async () => {
    const first = await seedClinic("number1");
    const second = await seedClinic("number2");
    const { rows } = await getMigratorPool().query<{ id: string; client_number: number }>(
      `select id, client_number from clinics where id = any($1::uuid[])`,
      [[first.clinicId, second.clinicId]],
    );
    const numberOf = new Map(rows.map((r) => [r.id, r.client_number]));
    expect(numberOf.get(first.clinicId)).toBeGreaterThan(0);
    // A later clinic, including a customer's second location, gets a later number.
    expect(numberOf.get(second.clinicId)!).toBeGreaterThan(numberOf.get(first.clinicId)!);

    // The runtime role holds no UPDATE on the column: refused before any trigger.
    await asTenant(first.clinicId, async (c) => {
      await expect(
        c.query(`update clinics set client_number = client_number + 1000 where id = $1`, [
          first.clinicId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    // The owner holds every privilege, and the trigger refuses it anyway,
    // including a swap that would keep the numbers unique.
    await expect(
      getMigratorPool().query(
        `update clinics set client_number = client_number + 1000 where id = $1`,
        [first.clinicId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      getMigratorPool().query(
        `update clinics set client_number = case when id = $1 then $3::int else $4::int end
          where id in ($1, $2)`,
        [
          first.clinicId,
          second.clinicId,
          numberOf.get(second.clinicId),
          numberOf.get(first.clinicId),
        ],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Nor does anyone name one at insert: the column default draws it. A
    // number named ahead of the sequence would be the writer's label, and
    // would make a later provisioning fail on the unique index.
    const { rows: next } = await getMigratorPool().query<{ n: number }>(
      `select last_value::int + 1 as n from clinics_client_number_seq`,
    );
    const ahead = next[0]!.n + 5;
    const nameNumber = (n: number | null) =>
      `insert into clinics (organization_id, slug, name, specialty, client_number)
       values ($1, '${`named-${randomUUID().slice(0, 6)}`}', 'Named', 'med-spa', ${n === null ? "null" : n})`;
    const namedRefusal = {
      code: "42501",
      message: expect.stringMatching(/drawn by its column default/),
    };
    // (Never a number some pooled session has just drawn: that one is the
    // default's own, and a duplicate of it meets the unique index instead.)
    for (const n of [ahead, 0, null]) {
      await expect(
        getMigratorPool().query(nameNumber(n), [first.organizationId]),
        `owner naming ${n}`,
      ).rejects.toMatchObject(namedRefusal);
    }
    // The runtime role inserts clinics (provisioning sets the new clinic's
    // tenant first), and is refused the same.
    const newId = randomUUID();
    await asTenant(newId, async (c) => {
      await expect(
        c.query(
          `insert into clinics (id, organization_id, slug, name, specialty, client_number)
           values ($1, $2, $3, 'Named', 'med-spa', $4)`,
          [newId, first.organizationId, `named-${randomUUID().slice(0, 6)}`, ahead],
        ),
      ).rejects.toMatchObject(namedRefusal);
    });
    // Nothing was drawn ahead, so the next clinic simply gets the next number.
    const third = await seedClinic("number3");
    const { rows: thirdRows } = await getMigratorPool().query<{ client_number: number }>(
      `select client_number from clinics where id = $1`,
      [third.clinicId],
    );
    expect(thirdRows[0]!.client_number).toBeGreaterThan(numberOf.get(second.clinicId)!);
    expect(thirdRows[0]!.client_number).toBeLessThan(ahead);

    // Unique, positive and never NULL, by the catalogue (no insert can name a
    // duplicate any more to show it).
    const { rows: shape } = await getMigratorPool().query<{
      unique_index: boolean;
      positive: boolean;
      not_null: boolean;
    }>(
      `select exists (select 1 from pg_index i
                       where i.indrelid = 'clinics'::regclass and i.indisunique
                         and i.indexrelid = 'clinics_client_number_idx'::regclass) as unique_index,
              exists (select 1 from pg_constraint
                       where conrelid = 'clinics'::regclass and conname = 'clinics_client_number_positive'
                         and contype = 'c') as positive,
              (select attnotnull from pg_attribute
                where attrelid = 'clinics'::regclass and attname = 'client_number') as not_null`,
    );
    expect(shape[0]).toEqual({ unique_index: true, positive: true, not_null: true });

    // Ordinary edits of the clinic still go through: the trigger fires only
    // when the number is in the SET list.
    await asTenant(first.clinicId, async (c) => {
      const { rows: renamed } = await c.query(
        `update clinics set name = 'Renamed again' where id = $1 returning client_number`,
        [first.clinicId],
      );
      expect(renamed).toEqual([{ client_number: numberOf.get(first.clinicId) }]);
    });

    // The runtime role draws numbers (provisioning inserts clinics) but can
    // never move the sequence.
    const { rows: seq } = await getMigratorPool().query<{ usage: boolean; update: boolean }>(
      `select has_sequence_privilege('healdesk_app', 'clinics_client_number_seq', 'USAGE') as usage,
              has_sequence_privilege('healdesk_app', 'clinics_client_number_seq', 'UPDATE') as update`,
    );
    expect(seq[0]).toEqual({ usage: true, update: false });
  });

  test("a connection's id, clinic and provider never move, for any role: its credential is sealed to them (0057)", async () => {
    // The envelope's AAD binds the clinic and the row's id, and the KMS label
    // (C6b) the clinic's number and the row's provider; a label is only worth
    // what its inputs' immutability is worth.
    const clinic = await seedClinic("conn-identity");
    const other = await seedClinic("conn-identity-other");
    const connectionId = await inTenant(clinic.clinicId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'meta', 'active', 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
        [clinic.clinicId],
      );
      return rows[0]!.id;
    });
    const moves = [
      `provider = 'google_calendar'`,
      `clinic_id = '${other.clinicId}'`,
      `id = gen_random_uuid()`,
    ];
    const refusal = { code: "42501", message: expect.stringMatching(/never change/) };
    // The runtime role, which holds table-level UPDATE here...
    for (const assignment of moves) {
      await asTenant(clinic.clinicId, async (c) => {
        await expect(
          c.query(`update provider_connections set ${assignment} where id = $1`, [connectionId]),
          assignment,
        ).rejects.toMatchObject(refusal);
      });
    }
    // ...and the owner, whom no grant stops.
    for (const assignment of moves) {
      await expect(
        inTenant(clinic.clinicId, (client) =>
          client.query(`update provider_connections set ${assignment} where id = $1`, [
            connectionId,
          ]),
        ),
        assignment,
      ).rejects.toMatchObject(refusal);
    }
    // A re-save writes the same three values (saveConnection does), and goes through.
    await asTenant(clinic.clinicId, async (c) => {
      const { rows } = await c.query(
        `update provider_connections
            set id = id, clinic_id = clinic_id, provider = provider, status = 'degraded', updated_at = now()
          where id = $1 returning status`,
        [connectionId],
      );
      expect(rows).toEqual([{ status: "degraded" }]);
    });
  });

  test("the SQL copies of the calendar catalogue agree with it, entry for entry (0057)", async () => {
    // app_calendar_election_released() and app_booking_system_live() are the
    // catalogue written out, because SQL cannot read it, and the election
    // guard believes them rather than the writer. Releasing an election
    // document, or confirming that a booking system reads Google, without a
    // migration redefining them fails here, not as elections refused (or
    // wrongly accepted) in production.
    for (const version of [
      ...CALENDAR_ELECTIONS.map((e) => e.version),
      "calendar-election/9.9.9",
      "",
    ]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select app_calendar_election_released($1) as ok`,
        [version],
      );
      expect(rows[0]!.ok, version).toBe(getCalendarElection(version)?.approvedByCounsel ?? false);
    }
    for (const system of [...BOOKING_SYSTEMS.map((b) => b.id), "acuity", ""]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select app_booking_system_live($1) as ok`,
        [system],
      );
      expect(rows[0]!.ok, system).toBe(bookingSyncFor(system) === "live");
    }
    const { rows } = await getMigratorPool().query<{ released: boolean; live: boolean }>(
      `select app_calendar_election_released(null) as released, app_booking_system_live(null) as live`,
    );
    expect(rows[0]).toEqual({ released: false, live: false });
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

  test("app_mark_clinic_production refuses a superseded agreement, names its version, and writes nothing (0048)", async () => {
    // Until 0048 any bound version went live, 1.0.0 and unapproved drafts
    // included. Everything else is ready here, so the version is the refusal: a
    // superseded release, the 1.3.0 draft, and older drafts and releases.
    for (const [i, version] of ["1.2.0", "1.3.0", "1.0.0", "0.1.0-draft"].entries()) {
      const { clinicId, organizationId } = await seedClinic(`superseded${i}`);
      await readyForGoLive(clinicId);
      await seedAcceptance(organizationId, version);

      await expect(
        getAppPool().query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining(`version ${version}, which has been superseded`),
        hint: expect.stringMatching(/accepts the current agreement first/),
      });
      const { rows } = await getMigratorPool().query(
        `select data_classification, baa_signed_at, went_live_at from clinics where id = $1`,
        [clinicId],
      );
      expect(rows[0]).toEqual({ data_classification: "synthetic", baa_signed_at: null, went_live_at: null });
    }
  });

  test("app_mark_clinic_production refuses a DPA clinic until the DPA's release gives go-live a kind-aware rule (0051)", async () => {
    // 0048's allow-list names BAA versions only, so a practice under the DPA
    // reads as superseded and cannot go live. That is the safe way round while
    // the DPA is a draft; releasing it has to change go-live on purpose, and
    // this test is what makes that change deliberate.
    const { clinicId, organizationId } = await seedClinic("dpagolive");
    await readyForGoLive(clinicId);
    await seedAcceptance(organizationId, "dpa/1.0.0");
    await expect(
      getAppPool().query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("version dpa/1.0.0, which has been superseded"),
    });
  });

  test("the SQL allow-list is the catalog's floor, version for version", async () => {
    // app_baa_version_acceptable() is isBaaVersionAcceptable() written out,
    // because SQL cannot read the catalog. A release that becomes current
    // without a migration extending the list fails here, rather than as
    // every new signer refused at go-live in production.
    for (const version of [...BAA_TEMPLATES.map((t) => t.version), "9.9.9", ""]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select app_baa_version_acceptable($1) as ok`,
        [version],
      );
      expect(rows[0]!.ok, version).toBe(isBaaVersionAcceptable(version));
    }
    const { rows } = await getMigratorPool().query<{ ok: boolean }>(`select app_baa_version_acceptable(null) as ok`);
    expect(rows[0]!.ok).toBe(false);
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
    // In the catalogue's own (C collation) order. 0057 added the slot holds
    // (a time tied to a call and a contact) and the named providers with
    // their services (whose patient someone is, beside a booking).
    const expected = [
      "appointments",
      "booking_requests",
      "clinic_provider_services",
      "clinic_providers",
      "consent_records",
      "contact_attempts",
      "contacts",
      "conversations",
      "deposit_payments",
      "meta_booking_drafts",
      "slot_holds",
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

  test("every SECURITY DEFINER function is executable by the runtime role and not by PUBLIC", async () => {
    // A definer runs as its owner, and the tenant walks among them set
    // app.clinic_id for every clinic in turn. Postgres grants EXECUTE on a new
    // function to PUBLIC by default, so one created without its REVOKE would
    // hand that walk to any role that can connect. Every migration revokes it
    // by hand; this is the check that they all did (0050 added three).
    const { rows } = await getMigratorPool().query<{
      proname: string;
      public_execute: boolean;
      app_execute: boolean;
    }>(`
      select p.proname,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
             has_function_privilege('healdesk_app', p.oid, 'EXECUTE') as app_execute
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
    `);
    expect(rows.map((r) => r.proname)).toEqual(
      expect.arrayContaining([
        "app_record_billing_request",
        "app_due_billing_requests",
        "app_clinic_for_deposit",
        // 0057: the calendar watch's tenant walk, the live-account count and
        // the desk token re-issue.
        "app_calendar_connections",
        "app_google_account_live_count",
        "app_reissue_undelivered_booking_token",
        // ... and destruction's provider delete.
        "app_destroy_clinic_providers",
      ]),
    );
    for (const fn of rows) {
      expect(fn.public_execute, `${fn.proname} is executable by PUBLIC`).toBe(false);
      expect(fn.app_execute, `${fn.proname} is not executable by healdesk_app`).toBe(true);
    }
  });

  test("0057's tables give the runtime role only the verbs their records need", async () => {
    // 0003's default privileges handed the runtime role all four verbs on each
    // new table; 0057 took back everything the records do not need. A grant
    // run by hand later fails here.
    const verbs = async (table: string) => {
      const { rows } = await getMigratorPool().query<{
        select: boolean;
        insert: boolean;
        delete: boolean;
        updatable: string[];
      }>(
        `select has_table_privilege('healdesk_app', $1::regclass, 'SELECT') as select,
                has_table_privilege('healdesk_app', $1::regclass, 'INSERT') as insert,
                has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as delete,
                coalesce((select array_agg(a.attname::text order by a.attname)
                            from pg_attribute a
                           where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
                             and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')),
                         array[]::text[]) as updatable`,
        [table],
      );
      return rows[0]!;
    };

    // Append-only contract evidence: a location's terms change by recording
    // another election.
    expect(await verbs("calendar_elections")).toEqual({
      select: true,
      insert: true,
      delete: false,
      updatable: [],
    });
    // Append-then-consume; purged after a day.
    expect(await verbs("google_oauth_states")).toEqual({
      select: true,
      insert: true,
      delete: true,
      updatable: ["consumed_ip", "used_at"],
    });
    // Who holds what, and when, never moves.
    expect(await verbs("slot_holds")).toEqual({
      select: true,
      insert: true,
      delete: true,
      updatable: [
        "appointment_id",
        "blocks_until",
        "booking_request_id",
        "check_attempts",
        "contact_id",
        "insert_attempted_at",
        "lease_token",
        "lease_until",
        "next_check_at",
        "outcome_reason",
        "released_at",
        "status",
        "updated_at",
      ],
    });
    // Deactivated, never deleted, never moved to another clinic.
    expect(await verbs("clinic_providers")).toEqual({
      select: true,
      insert: true,
      delete: false,
      updatable: ["active", "calendar_id", "display_name", "updated_at"],
    });
    // A mapping is replaced, never edited.
    expect(await verbs("clinic_provider_services")).toEqual({
      select: true,
      insert: true,
      delete: true,
      updatable: [],
    });

    // A calendar link's audience, recipients and flags are fixed at issue,
    // like its purpose: still only used_at and consumed_ip move.
    expect((await verbs("connection_links")).updatable).toEqual(["consumed_ip", "used_at"]);

    // The columns 0057 added for runtime writers on tables with table-level
    // UPDATE stay writable.
    for (const [table, column] of [
      ["appointments", "duration_minutes"],
      ["appointments", "booking_origin"],
      ["appointments", "calendar_write_claimed_at"],
      ["appointments", "calendar_write_attempts"],
      ["appointments", "calendar_write_lease"],
      ["appointments", "calendar_event_key"],
      ["provider_connections", "account_ref"],
      ["provider_connections", "broken_at"],
      ["provider_connections", "broken_alerted_at"],
      ["provider_connections", "transient_failures"],
      ["clinic_settings", "auto_confirm_bookings"],
      ["clinic_settings", "auto_confirm_changed_at"],
      ["clinic_settings", "auto_confirm_changed_by_label"],
    ] as const) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select has_column_privilege('healdesk_app', $1::regclass, $2::text, 'UPDATE') as ok`,
        [table, column],
      );
      expect(rows[0]!.ok, `${table}.${column}`).toBe(true);
    }

    // And booking_requests' frozen columns stay frozen: the desk token moves
    // only through app_reissue_undelivered_booking_token().
    for (const column of [
      "token_hash",
      "booked_via",
      "vendor_call_id",
      "preferred_window",
      "expires_at",
    ]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select has_column_privilege('healdesk_app', 'booking_requests'::regclass, $1::text, 'UPDATE') as ok`,
        [column],
      );
      expect(rows[0]!.ok, `booking_requests.${column}`).toBe(false);
    }
  });
});
