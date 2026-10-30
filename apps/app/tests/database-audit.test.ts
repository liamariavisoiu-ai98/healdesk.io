import { randomBytes, randomUUID } from "node:crypto";

import {
  BAA_TEMPLATES,
  BOOKING_SYSTEMS,
  bookingSyncFor,
  CALENDAR_ELECTIONS,
  CURRENT_BAA_VERSION,
  DPA_CALENDAR_ELECTIONS,
  getCalendarElection,
  getDpaCalendarElection,
  isBaaVersionAcceptable,
  MIN_ACCEPTABLE_BAA_VERSION,
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
import { readyWebChat, setAgreement } from "./setup/go-live";
import { attestPlatform, setGateBCodeBuilt } from "./setup/platform";

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

/**
 * Everything go-live checks except the agreement (drizzle/0090): the
 * agreement gate's columns, website chat meeting Gate B, and the platform
 * attested (in beforeAll).
 */
async function readyForGoLive(clinicId: string, kind: "baa" | "dpa" = "baa"): Promise<void> {
  await setAgreement(clinicId, "", { kind, version: null });
  await readyWebChat(clinicId);
}

/** One committed transaction on the app role inside the clinic's tenant: go-live runs only there. */
async function committedInTenant<T>(clinicId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const out = await fn(client as unknown as Client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describeDb("database audit (0031)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform();
    // The go-live tests below stand in for the commit that builds what Gate
    // B asks of the code (tests/go-live.test.ts holds today's state, false).
    await setGateBCodeBuilt(true);
  }, 60_000);

  afterAll(async () => {
    await setGateBCodeBuilt(true);
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
    // (0051); the offboarding dates that app_destruction_due reads as the
    // floor under the deletes, which only app_start_offboarding,
    // app_mark_export_delivered and app_mark_clinic_destroyed write
    // (booking_request_destruction and destruction_clock migrations); and
    // the record clock's last shortening, which app_purge_booking_requests
    // reads and only the clinics_record_clock trigger writes.
    const { rows } = await getMigratorPool().query<{ attname: string; ok: boolean }>(`
      select a.attname,
             has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE') as ok
        from pg_attribute a
       where a.attrelid = 'clinics'::regclass and a.attnum > 0 and not a.attisdropped
    `);
    const locked = rows.filter((r) => !r.ok).map((r) => r.attname).sort();
    // The BAA gate's two (0031), the agreement-kind gate's two (0051), the
    // offboarding and record-clock columns (0054), the client number every
    // sealed credential is labelled with (migration A, 0057), the export's
    // delivery, which the destruction floor reads (0058), the
    // organisation, which the agreement gate reads (0066), the account's
    // closure with the notice address it keeps, which only
    // app_close_clinic_account and app_expire_notice_addresses write (0096),
    // and the billing pointer, retired as the way locations are made and
    // given no new writer (0109).
    expect(locked).toEqual([
      "account_closed_at",
      "agreement_kind",
      "baa_signed_at",
      "billing_clinic_id",
      "client_number",
      "data_classification",
      "destroy_after",
      "destroyed_at",
      "export_delivered_at",
      "notice_address",
      "notice_address_until",
      "offboarding_started_at",
      "organization_id",
      "regulatory_regime",
      "retention_record_days_previous",
      "retention_record_days_shortened_at",
    ]);
  });

  test("the assistant's number kept its grant through the rename, and the console's projection reads it by its new name (0075)", async () => {
    // A rename keeps a column's privileges, but app_clinics_overview() is a
    // LANGUAGE sql function whose body is stored as text: it had to be
    // recreated to read the column at all, with its OUT column renamed.
    const { rows: granted } = await getMigratorPool().query<{ column_name: string; privilege_type: string }>(`
      select column_name, privilege_type
        from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'clinics' and grantee = 'healdesk_app'
         and column_name in ('assistant_number_e164', 'synthflow_number_e164')
         and privilege_type = 'UPDATE'
    `);
    expect(granted).toEqual([{ column_name: "assistant_number_e164", privilege_type: "UPDATE" }]);
    const { rows: columns } = await getMigratorPool().query<{ attname: string }>(`
      select attname from pg_attribute
       where attrelid = 'clinics'::regclass and attname like '%synthflow%' and not attisdropped
    `);
    expect(columns).toEqual([]);
    const { rows: out } = await getMigratorPool().query<{ outputs: string[] }>(`
      select p.proargnames::text[] as outputs from pg_proc p where p.oid = 'app_clinics_overview()'::regprocedure
    `);
    expect(out[0]!.outputs).toContain("assistant_number_e164");
    expect(out[0]!.outputs).not.toContain("synthflow_number_e164");
    const { rows: execute } = await getMigratorPool().query<{ app: boolean; anyone: boolean }>(`
      select has_function_privilege('healdesk_app', 'app_clinics_overview()', 'EXECUTE') as app,
             has_function_privilege('public', 'app_clinics_overview()', 'EXECUTE') as anyone
    `);
    expect(execute).toEqual([{ app: true, anyone: false }]);
  });

  test("a channel's lifecycle and live's recorded inputs are the channel definers' alone (0079)", async () => {
    // The answer gate answers only a live channel and billing is charged from
    // a channel's first answer, so neither may be written by the runtime role
    // directly: only the four definers, which re-check what they record.
    const { rows: columns } = await getMigratorPool().query<{ column: string; update: boolean }>(`
      select a.attname as column, has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE') as update
        from pg_attribute a
       where a.attrelid = 'clinic_channels'::regclass
         and a.attname in ('ready_at', 'live_at', 'first_answer_at', 'enabled', 'waiting_on')
       order by a.attname
    `);
    expect(columns).toEqual([
      { column: "enabled", update: true },
      { column: "first_answer_at", update: false },
      { column: "live_at", update: false },
      { column: "ready_at", update: false },
      { column: "waiting_on", update: true },
    ]);
    const { clinicId } = await seedClinic("lifecycle-guard");
    await inTenant(clinicId, (c) =>
      c.query(`insert into clinic_channels (clinic_id, channel) values ($1, 'voice')`, [clinicId]),
    );
    await asTenant(clinicId, async (c) => {
      for (const kind of ["ready", "live", "first_answer", "audit_passed", "runtime_seen", "widget_seen"]) {
        await c.query("savepoint s");
        await expect(
          c.query(`insert into channel_events (clinic_id, channel, kind) values ($1, 'voice', $2)`, [clinicId, kind]),
          kind,
        ).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint s");
      }
      await expect(
        c.query(`insert into clinic_channels (clinic_id, channel, live_at) values ($1, 'web', now())`, [clinicId]),
      ).rejects.toMatchObject({ code: "42501" });
    });
    const { rows: definers } = await getMigratorPool().query<{ name: string; definer: boolean; app: boolean; anyone: boolean }>(`
      select p.proname as name, p.prosecdef as definer,
             has_function_privilege('healdesk_app', p.oid, 'EXECUTE') as app,
             has_function_privilege('public', p.oid, 'EXECUTE') as anyone
        from pg_proc p
       where p.proname in ('app_channel_record_input', 'app_channel_mark_ready', 'app_channel_mark_live',
                           'app_channel_record_first_answer', 'app_channel_ours_ok', 'app_channel_live_ok',
                           'app_web_widget_seen')
       order by p.proname
    `);
    expect(definers).toEqual([
      { name: "app_channel_live_ok", definer: false, app: false, anyone: false },
      { name: "app_channel_mark_live", definer: true, app: true, anyone: false },
      { name: "app_channel_mark_ready", definer: true, app: true, anyone: false },
      { name: "app_channel_ours_ok", definer: false, app: false, anyone: false },
      { name: "app_channel_record_first_answer", definer: true, app: true, anyone: false },
      { name: "app_channel_record_input", definer: true, app: true, anyone: false },
      { name: "app_web_widget_seen", definer: true, app: true, anyone: false },
    ]);
  });

  test("the runtime role cannot delete a clinic (0066)", async () => {
    // A clinic ends by offboarding and destruction, which keep its row.
    // Deleting one and inserting its id again as synthetic reopened the
    // agreement gate, and the cascades took its patient rows with no export.
    const { rows } = await getMigratorPool().query<{ deletable: boolean }>(
      `select has_table_privilege('healdesk_app', 'clinics'::regclass, 'DELETE') as deletable`,
    );
    expect(rows[0]!.deletable).toBe(false);
  });

  test("the runtime role inserts a signature unbound, and never the agreement gate's inputs (0066)", async () => {
    // INSERT on baa_acceptances is column-scoped: a signature is written
    // unbound by signAgreement and bound, terminated or given a reason only by
    // the definers and the console's own writes. With any of the four, the
    // runtime role could write itself an agreement in effect (review R1).
    const { rows } = await getMigratorPool().query<{ attname: string }>(`
      select a.attname
        from pg_attribute a
       where a.attrelid = 'baa_acceptances'::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'INSERT')
       order by a.attname
    `);
    expect(rows.map((r) => r.attname)).toEqual([
      "accepted_at",
      "accepted_by_email",
      "accepted_by_name",
      "accepted_by_title",
      "assent_label",
      "document_hash",
      "document_version",
      "id",
      "ip_address",
      "rendered_text",
      "user_agent",
      "user_id",
      "variables",
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
    // Both forms: the BAA's (CALENDAR_ELECTIONS) and, since the DPA's
    // release (0104), the DPA's own (DPA_CALENDAR_ELECTIONS).
    for (const version of [
      ...CALENDAR_ELECTIONS.map((e) => e.version),
      ...DPA_CALENDAR_ELECTIONS.map((e) => e.version),
      "calendar-election/9.9.9",
      "calendar-election-dpa/9.9.9",
      "",
    ]) {
      const { rows } = await getMigratorPool().query<{ ok: boolean }>(
        `select app_calendar_election_released($1) as ok`,
        [version],
      );
      const form = getCalendarElection(version) ?? getDpaCalendarElection(version);
      expect(rows[0]!.ok, version).toBe(form?.approvedByCounsel ?? false);
    }
    expect(DPA_CALENDAR_ELECTIONS.every((e) => e.approvedByCounsel)).toBe(true);
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

  test("app_mark_clinic_production runs only in the clinic's own tenant, refuses without a bound agreement, and copies its date with one", async () => {
    const { clinicId, organizationId } = await seedClinic("golive");
    await readyForGoLive(clinicId);

    // Outside the clinic's tenant (no tenant, or another's) it runs at all
    // nowhere: the channel tables it reads FORCE row-level security (0090).
    const other = await seedClinic("golive-other");
    for (const tenant of [null, other.clinicId]) {
      await asTenant(tenant, async (c) => {
        await expect(
          c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
        ).rejects.toMatchObject({ code: "42501" });
      });
    }

    await asTenant(clinicId, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/no bound, in-effect agreement/) });
    });

    const accepted = await setAgreement(clinicId, organizationId);

    // Bound agreement but covered-entity status "I'm not sure": still no.
    await getMigratorPool().query(`update clinics set is_covered_entity = null where id = $1`, [clinicId]);
    await asTenant(clinicId, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/covered-entity status/) });
    });
    await getMigratorPool().query(`update clinics set is_covered_entity = false where id = $1`, [clinicId]);

    // Gate B is fail-closed: while what it asks of the code is not built, no
    // clinic goes live, and the database says why (0090, gate_b_not_built).
    await setGateBCodeBuilt(false);
    try {
      await asTenant(clinicId, async (c) => {
        await expect(
          c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
        ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/Gate B asks what is not built yet/) });
      });
    } finally {
      await setGateBCodeBuilt(true);
    }

    // Committed, not rolled back: the flip is the thing under test.
    const { rows } = await committedInTenant(clinicId, (c) =>
      c.query<{ signed: Date }>(`select app_mark_clinic_production($1::uuid) as signed`, [clinicId]),
    );
    expect(rows[0]!.signed.getTime()).toBe(accepted!.getTime());

    const read = async () =>
      (
        await getMigratorPool().query<{
          data_classification: string;
          baa_signed_at: Date;
          went_live_at: Date;
        }>(`select data_classification, baa_signed_at, went_live_at from clinics where id = $1`, [clinicId])
      ).rows[0]!;
    const after = await read();
    expect(after.data_classification).toBe("production");
    expect(after.baa_signed_at.getTime()).toBe(accepted!.getTime());

    // Go-live happens once: asked again, it returns the same date and moves nothing.
    const again = await committedInTenant(clinicId, (c) =>
      c.query<{ signed: Date }>(`select app_mark_clinic_production($1::uuid) as signed`, [clinicId]),
    );
    expect(again.rows[0]!.signed.getTime()).toBe(accepted!.getTime());
    expect((await read()).went_live_at.getTime()).toBe(after.went_live_at.getTime());

    // A terminated agreement no longer qualifies another clinic.
    const ended = await seedClinic("golive-ended");
    await readyForGoLive(ended.clinicId);
    await setAgreement(ended.clinicId, ended.organizationId);
    await getMigratorPool().query(
      `update baa_acceptances set terminated_at = now() where organization_id = $1`,
      [ended.organizationId],
    );
    await asTenant(ended.clinicId, async (c) => {
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [ended.clinicId]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  test("app_mark_clinic_production refuses a superseded agreement, names its version, and writes nothing (0048)", async () => {
    // Until 0048 any bound version went live, 1.0.0 and unapproved drafts
    // included. Everything else is ready here, so the version is the refusal:
    // superseded releases below the floor (1.2.2 since the 1.3.0 release,
    // which replaced it outright, 1.3.0 since the 1.4.0 release, which
    // replaced it outright in turn, 0070, 1.4.0 since the 1.5.0 release,
    // 0073, 1.5.0 since the 1.5.1 release, 0081, and 1.5.1 since the 1.6.0
    // release, 0136), and older drafts and releases.
    for (const [i, version] of ["1.5.1", "1.5.0", "1.4.0", "1.3.0", "1.2.2", "1.2.1", "1.2.0", "1.0.0", "1.1.0-draft", "0.1.0-draft"].entries()) {
      const { clinicId, organizationId } = await seedClinic(`superseded${i}`);
      await readyForGoLive(clinicId);
      await seedAcceptance(organizationId, version);

      await asTenant(clinicId, async (c) => {
        await expect(
          c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]),
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining(`version ${version}, which has been superseded`),
          hint: expect.stringMatching(/accepts the current agreement first/),
        });
      });
      const { rows } = await getMigratorPool().query(
        `select data_classification, baa_signed_at, went_live_at from clinics where id = $1`,
        [clinicId],
      );
      expect(rows[0]).toEqual({ data_classification: "synthetic", baa_signed_at: null, went_live_at: null });
    }
  });

  test("app_mark_clinic_production takes 1.7.0, the floor its release raised, and refuses 1.6.0", async () => {
    // 1.6.0's release (0136) raised MIN_ACCEPTABLE_BAA_VERSION to 1.6.0: no
    // clinic had signed 1.5.1, whose Subcontractors clause says Anthropic's
    // retention as Anthropic does not, so 1.6.0 replaced it outright (owner,
    // 29 October 2026), as 1.5.1 had replaced 1.5.0 (0081, 19 October), and
    // the test above refuses a 1.5.1 clinic. Go-live reads the floor through
    // app_baa_version_acceptable, never a version of its own (0090), so the
    // next release moved it too: 1.7.0's (0140, 30 October 2026) raised it
    // to 1.7.0, which replaced 1.6.0 outright for its reporting and notice
    // periods, with no clinic holding a 1.6.0 signature.
    expect(MIN_ACCEPTABLE_BAA_VERSION).toBe("1.7.0");
    const { rows: refused } = await getMigratorPool().query<{ ok: boolean }>(
      `select app_baa_version_acceptable('1.6.0') as ok`,
    );
    expect(refused[0]!.ok).toBe(false);
    const { clinicId, organizationId } = await seedClinic("acceptable");
    await readyForGoLive(clinicId);
    await seedAcceptance(organizationId, "1.7.0");
    await committedInTenant(clinicId, (c) => c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]));
    const { rows } = await getMigratorPool().query(
      `select data_classification from clinics where id = $1`,
      [clinicId],
    );
    expect(rows[0]).toEqual({ data_classification: "production" });
  });

  test("app_mark_clinic_production asks a DPA's release, not the BAA floor, of a DPA clinic: dpa/1.0.0 goes live since its release, an unreleased version is refused (0090, 0104)", async () => {
    // The kind-aware rule 0051 left for this rewrite: a DPA's version goes
    // live once released (app_dpa_version_released), a BAA's at the floor.
    // A practice the DPA covers (a hipaa-if-covered practice that is not
    // covered) under a DPA version nobody released is refused by name...
    const draft = await seedClinic("dpagolive-draft");
    await readyForGoLive(draft.clinicId, "dpa");
    await seedAcceptance(draft.organizationId, "dpa/9.9.9");
    await asTenant(draft.clinicId, async (c) => {
      const { rows } = await c.query<{ codes: string[] }>(`select app_go_live_missing($1::uuid) as codes`, [draft.clinicId]);
      expect(rows[0]!.codes).toEqual(["agreement_version"]);
      await expect(
        c.query(`select app_mark_clinic_production($1::uuid)`, [draft.clinicId]),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringContaining("data protection agreement version dpa/9.9.9, which is not released"),
      });
    });

    // ...and under dpa/1.0.0, which the owner released on 20 October 2026, it goes live.
    const { clinicId, organizationId } = await seedClinic("dpagolive");
    await readyForGoLive(clinicId, "dpa");
    await seedAcceptance(organizationId, "dpa/1.0.0");
    await asTenant(clinicId, async (c) => {
      const { rows } = await c.query<{ codes: string[] }>(`select app_go_live_missing($1::uuid) as codes`, [clinicId]);
      expect(rows[0]!.codes).toEqual([]);
    });
    await committedInTenant(clinicId, (c) => c.query(`select app_mark_clinic_production($1::uuid)`, [clinicId]));
    const { rows } = await getMigratorPool().query(`select data_classification from clinics where id = $1`, [clinicId]);
    expect(rows[0]).toEqual({ data_classification: "production" });
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
    // security_events (0003), sign_in_links (0043), the portal's second
    // factors and step-ups (0047), and the human route's links (0095):
    // which device's passkey could open patient data, how it got there, and
    // when. A new table of this kind belongs on this list.
    for (const table of [
      "security_events",
      "sign_in_links",
      "user_factors",
      "user_backup_codes",
      "webauthn_challenges",
      "step_ups",
      "factor_lockouts",
      "device_recoveries",
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
    // their services (whose patient someone is, beside a booking); 0064 the
    // amendments Practice directs to a request or a conversation; 0069 the
    // transcript outbox's sealed copies (on INSERT only: see the migration);
    // 0092 the handovers, which point at a caller's conversation or thread;
    // 0093 the flags staff put on conversations; 0094 a patient's request to
    // healdesk, passed to the practice (L32); 0098 the list of who an incident
    // affected, which names contacts; 0108 the redial records of calls that
    // ended early, sealed turns keyed to a caller; 0139 the 30-day record of
    // a missed call or chat, which keeps the caller's number.
    const expected = [
      "appointments",
      "booking_requests",
      "clinic_provider_services",
      "clinic_providers",
      "consent_records",
      "contact_attempts",
      "contacts",
      "conversation_flags",
      "conversations",
      "deposit_payments",
      "handovers",
      "incident_affected_contacts",
      "meta_booking_drafts",
      "missed_contacts",
      "patient_requests",
      "record_amendments",
      "slot_holds",
      "suppressions",
      "transactions",
      "transcript_emails",
      "voice_redial_contexts",
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
    // A definer only other definers call, which reads across tenants, is
    // granted to no one: those callers run as its owner. Each is named here
    // with its reason, and held to having no grant, so a later GRANT is a
    // widening this test sees.
    const INTERNAL: Record<string, string> = {
      app_account_closure_waiting_on:
        "called only by app_close_clinic_account and app_accounts_to_close (0096); it reads any clinic's incidents, notices and security events",
      app_record_direct_clinic_change:
        "a trigger function only (0114): the statement triggers on clinic_closures, clinic_providers and clinic_provider_services call it to record another session's edit; nothing calls it by name",
      app_clinics_changed_in_transaction:
        "db-apply's check (0114) that a change file wrote change rows for its named clinic only: granted to healdesk_writer, the change file's role, and not to the runtime role, which has no use for it",
    };
    for (const fn of rows) {
      const internal = fn.proname in INTERNAL;
      expect(fn.public_execute, `${fn.proname} is executable by PUBLIC`).toBe(false);
      expect(
        fn.app_execute,
        `${fn.proname} is ${internal ? "" : "not "}executable by healdesk_app`,
      ).toBe(!internal);
    }
    expect(Object.keys(INTERNAL).filter((name) => !rows.some((r) => r.proname === name))).toEqual([]);
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

  test("a step-up or a second factor is never dated ahead of now, for any role (0077)", async () => {
    // The idle and 8-hour limits count from step_ups' two times, so a row
    // dated ahead would open patient pages for as long as it said.
    const { rows: triggers } = await getMigratorPool().query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgname in ('step_ups_not_ahead', 'user_factors_not_ahead') and not tgisinternal
        order by tgname`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual(["step_ups_not_ahead", "user_factors_not_ahead"]);

    const { staffUserId } = await seedClinic("ahead");
    const app = getAppPool();
    const passkey = (extra: string, value: string) =>
      app.query<{ id: string }>(
        `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up${extra})
         values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true${value}) returning id`,
        [staffUserId, randomBytes(16).toString("base64url")],
      );
    // As the app writes them, now: accepted.
    const factorId = (await passkey("", "")).rows[0]!.id;
    for (const [extra, value] of [
      [", created_at", ", now() + interval '30 days'"],
      [", last_used_at", ", now() + interval '30 days'"],
    ] as const) {
      await expect(passkey(extra, value), extra).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      app.query(`update user_factors set last_used_at = now() + interval '1 day' where id = $1`, [
        factorId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await app.query(`update user_factors set last_used_at = now() where id = $1`, [factorId]);

    const stepUp = (times: string) =>
      app.query<{ id: string }>(
        `insert into step_ups (session_token_hash, user_id, factor_id, device_label${times ? ", created_at, last_activity_at" : ""})
         values ($1, $2, $3, 'Front desk Mac'${times}) returning id`,
        [randomBytes(32), staffUserId, factorId],
      );
    const stepUpId = (await stepUp("")).rows[0]!.id;
    await expect(
      stepUp(", now() + interval '30 days', now() + interval '30 days'"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(stepUp(", now(), now() + interval '7 hours'")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      app.query(`update step_ups set last_activity_at = now() + interval '7 hours' where id = $1`, [
        stepUpId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    // A touch, and a row dated in the past (it only lapses sooner), go through.
    await app.query(`update step_ups set last_activity_at = greatest(last_activity_at, now()) where id = $1`, [
      stepUpId,
    ]);
    await stepUp(", now() - interval '1 hour', now() - interval '1 hour'");
    // No role is exempt: the migrator cannot date one ahead either.
    await expect(
      getMigratorPool().query(
        `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
         values ($1, $2, $3, 'Front desk Mac', now() + interval '1 day', now() + interval '1 day')`,
        [randomBytes(32), staffUserId, factorId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  test("the operator's second factor is not in this database (0074)", async () => {
    // It moved onto Vercel on 14 October 2026 (apps/web/src/lib/admin/totp.ts).
    // The table's trigger went with it; its function is dropped by hand,
    // because CASCADE does not reach a function a trigger merely called.
    const { rows } = await getMigratorPool().query<{ table: string | null; functions: number }>(`
      select to_regclass('public.admin_totp')::text as table,
             (select count(*)::int from pg_proc where proname = 'app_admin_totp_no_rewrite') as functions
    `);
    expect(rows[0]).toEqual({ table: null, functions: 0 });
  });
});
