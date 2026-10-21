import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LOCATION_UNSET } from "@/db/schema";
import {
  acknowledgementHash,
  recordLocationAcknowledgement,
} from "@/lib/location-acknowledgements";
import { locationById, mainLocation, readLocations } from "@/lib/locations";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeededClinic } from "./setup/factories";

/**
 * Locations, the foundation (drizzle/0105; the extra-locations plan's steps 6
 * and 7 and step 5's table). One AYA for every location of the account: the
 * clinics row is the one tenant and each location a row of clinic_locations
 * inside it. Every test here fails on the code before 0105, where none of the
 * tables, columns, triggers or functions it reads exists.
 *
 * What it pins: every clinic has its main location, made with it and kept
 * equal to its clinic's facts, which the runtime role cannot write there; a
 * later location exists only pending, with its acceptance, in the account's
 * time zone, and becomes active only through app_activate_location once its
 * charge is recorded; the acceptance is append-only and evidence of who
 * accepted it under which step-up; and the seven tables' rows name a location
 * of their own account, the main one unless told otherwise, and never move.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One transaction on the runtime role inside `clinicId`'s tenant; committed unless `rollback`. */
async function asApp<T>(
  clinicId: string | null,
  fn: (c: Client) => Promise<T>,
  options: { rollback?: boolean } = {},
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const out = await fn(client as unknown as Client);
    await client.query(options.rollback ? "rollback" : "commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The database's error a statement fails with (unwrapped from drizzle's), or null. */
async function failure(
  run: () => Promise<unknown>,
): Promise<{ code?: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as {
      code?: string;
      message: string;
      cause?: { code?: string; message: string };
    };
    return e.code === undefined && e.cause?.code !== undefined ? e.cause : e;
  }
}

type LocationRow = {
  id: string;
  position: number;
  status: string;
  label: string | null;
  timezone: string;
  address: string | null;
  published_phone_e164: string | null;
  opening_hours: unknown;
  carrier: string | null;
  phone_system_type: string;
  call_routing: string;
  direct_line_e164: string | null;
  transfer_e164: string | null;
  urgent_help_e164: string | null;
  vet_referral_e164: string | null;
  coverage_mode: string;
  activated_at: Date | null;
  add_request_id: string | null;
  acknowledgement_id: string | null;
};

async function locationsOf(clinicId: string): Promise<LocationRow[]> {
  return inTenant(
    clinicId,
    async (c) =>
      (
        await c.query<LocationRow>(
          `select * from clinic_locations where clinic_id = $1 order by position`,
          [clinicId],
        )
      ).rows,
  );
}

async function mainOf(clinicId: string): Promise<LocationRow> {
  const [main] = (await locationsOf(clinicId)).filter((l) => l.position === 1);
  if (!main) throw new Error(`no main location for ${clinicId}`);
  return main;
}

/** A passkey and a live step-up on it for the clinic's staff user, as the portal leaves them. */
async function seedStepUp(
  userId: string,
  device = "Front desk Mac",
): Promise<{ stepUpId: string; passkeyId: string; deviceLabel: string }> {
  const pool = getMigratorPool();
  const { rows: factor } = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, device, randomBytes(16).toString("base64url")],
  );
  const { rows: stepUp } = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now(), now()) returning id`,
    [createHash("sha256").update(randomBytes(24)).digest(), userId, factor[0]!.id, device],
  );
  return { stepUpId: stepUp[0]!.id, passkeyId: factor[0]!.id, deviceLabel: device };
}

const DOCUMENT = "central-assistant-acknowledgement/1.0.0";
const TEXT =
  "I have authority to bind Radiance Aesthetics LLC. Downtown, at 2 Side St, is operated by Radiance Aesthetics LLC, and I accept that AYA answers for it as one central assistant for all our locations.";

type Added = { locationId: string; acknowledgementId: string; requestId: string };

/**
 * A later location as the add (the plan's step 8) will write it: the
 * acceptance, then the pending row naming it, in one transaction on the
 * runtime role, before any charge.
 */
async function addPendingLocation(clinic: SeededClinic, label = "Downtown"): Promise<Added> {
  const stepUp = await seedStepUp(clinic.staffUserId);
  const locationId = randomUUID();
  const requestId = randomUUID();
  const zone = (await mainOf(clinic.clinicId)).timezone;
  const acknowledgementId = await withTenant(
    {
      clinicId: clinic.clinicId,
      actor: { type: "user", userId: clinic.staffUserId, label: stepUp.deviceLabel },
    },
    async (tx) => {
      const recorded = await recordLocationAcknowledgement(tx, {
        locationId,
        documentVersion: DOCUMENT,
        renderedText: TEXT,
        acceptedBy: { userId: clinic.staffUserId, label: "Laura Owner, owner", stepUp },
        request: { ipAddress: "203.0.113.7", userAgent: "vitest" },
      });
      // A raw insert: no writer of a later location exists yet (step 8).
      await tx.db.execute(
        sql`insert into clinic_locations
          (id, clinic_id, position, label, add_request_id, acknowledgement_id, timezone, address)
          values (${locationId}::uuid, ${clinic.clinicId}::uuid, 2, ${label}, ${requestId}::uuid,
                  ${recorded.id}::uuid, ${zone}, '2 Side St, Austin TX')`,
      );
      return recorded.id;
    },
  );
  return { locationId, acknowledgementId, requestId };
}

describeDb("locations, the foundation (0105)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // The main location
  // ---------------------------------------------------------------------------

  test("every clinic is made with exactly one main location, active, carrying its clinic's facts", async () => {
    const a = await seedClinic("loc-main-a");
    const b = await seedClinic("loc-main-b");
    for (const c of [a, b]) {
      const rows = await locationsOf(c.clinicId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        position: 1,
        status: "active",
        label: null,
        timezone: "America/New_York",
        phone_system_type: "unknown",
        call_routing: "conditional",
        coverage_mode: "overflow_after_hours",
        add_request_id: null,
        acknowledgement_id: null,
      });
      expect(rows[0]!.activated_at).not.toBeNull();
    }
  });

  test("provisioning's own path, the runtime role inside the new clinic's tenant, makes the main location too", async () => {
    // provisioning.ts inserts the clinic as the runtime role, the tenant set to
    // the id it chose; the trigger is a definer, so the role never writes the
    // main location itself.
    const clinicId = randomUUID();
    const org = `org_loc_prov_${clinicId.slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into organization (id, name, slug, created_at) values ($1, 'Prov', $1, now())`,
      [org],
    );
    await asApp(clinicId, (c) =>
      c.query(
        `insert into clinics (id, organization_id, slug, name, specialty, timezone, address)
         values ($1, $2, $3, 'Provisioned', 'med-spa', 'America/Chicago', '9 Elm St, Austin TX')`,
        [clinicId, org, `prov-${clinicId.slice(0, 8)}`],
      ),
    );
    const main = await mainOf(clinicId);
    expect(main).toMatchObject({
      status: "active",
      timezone: "America/Chicago",
      address: "9 Elm St, Austin TX",
    });
    // And the tenant the trigger borrowed was put back: nothing else changed it.
    const tenant = await asApp(clinicId, async (c) => {
      await c.query(`update clinics set address = '10 Elm St, Austin TX' where id = $1`, [
        clinicId,
      ]);
      return (await c.query<{ t: string }>(`select current_setting('app.clinic_id') as t`)).rows[0]!
        .t;
    });
    expect(tenant).toBe(clinicId);
    expect((await mainOf(clinicId)).address).toBe("10 Elm St, Austin TX");
  });

  test("the main location follows clinics and clinic_settings, whoever writes them, and goes back to the defaults with the settings row", async () => {
    const c = await seedClinic("loc-follow");
    const hours = {
      sun: [],
      mon: [["09:00", "17:00"]],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    };
    await asApp(c.clinicId, (q) =>
      q.query(
        `update clinics
            set address = '1 Main St, Austin TX', published_phone_e164 = '+15125550100',
                opening_hours = $2::jsonb, carrier = 'att', phone_system_type = 'voip',
                call_routing = 'always', timezone = 'America/Chicago'
          where id = $1`,
        [c.clinicId, JSON.stringify(hours)],
      ),
    );
    await asApp(c.clinicId, (q) =>
      q.query(
        `insert into clinic_settings (clinic_id, direct_line_e164, transfer_e164, urgent_help_e164, vet_referral_e164, coverage_mode)
         values ($1, '+15125550199', '+15125550198', '+15125550197', '+15125550196', 'all_calls')`,
        [c.clinicId],
      ),
    );
    expect(await mainOf(c.clinicId)).toMatchObject({
      address: "1 Main St, Austin TX",
      published_phone_e164: "+15125550100",
      opening_hours: hours,
      carrier: "att",
      phone_system_type: "voip",
      call_routing: "always",
      timezone: "America/Chicago",
      direct_line_e164: "+15125550199",
      transfer_e164: "+15125550198",
      urgent_help_e164: "+15125550197",
      vet_referral_e164: "+15125550196",
      coverage_mode: "all_calls",
    });

    // An upsert, as lib/billing/settings.ts writes the direct line.
    await asApp(c.clinicId, (q) =>
      q.query(
        `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+15125550111')
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
        [c.clinicId],
      ),
    );
    expect((await mainOf(c.clinicId)).direct_line_e164).toBe("+15125550111");

    // The settings row going (as the account's closure deletes it) is the defaults again.
    await inTenant(c.clinicId, (q) =>
      q.query(`delete from clinic_settings where clinic_id = $1`, [c.clinicId]),
    );
    expect(await mainOf(c.clinicId)).toMatchObject({
      direct_line_e164: null,
      transfer_e164: null,
      urgent_help_e164: null,
      vet_referral_e164: null,
      coverage_mode: "overflow_after_hours",
    });
    // Those defaults are clinic_settings' own, so a missing row and the copy agree.
    const { rows } = await getMigratorPool().query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_name = 'clinic_settings' and column_name = 'coverage_mode'`,
    );
    expect(rows[0]!.column_default).toBe("'overflow_after_hours'::text");
  });

  test("the runtime role cannot write the main location's facts there, insert a main location, or delete one; it may name it", async () => {
    const c = await seedClinic("loc-main-guard");
    const main = await mainOf(c.clinicId);
    for (const set of [
      `address = '3 Elsewhere'`,
      `direct_line_e164 = '+15125550123'`,
      `coverage_mode = 'all_calls'`,
      `opening_hours = '{}'::jsonb`,
    ]) {
      const refused = await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(`update clinic_locations set ${set} where id = $1`, [main.id]),
        ),
      );
      expect(refused, set).toMatchObject({ code: "42501" });
      expect(refused!.message).toMatch(/written on clinics and clinic_settings/);
    }
    // Columns the definers alone write are not granted at all.
    for (const set of [
      `timezone = 'America/Denver'`,
      `status = 'retired'`,
      `position = 3`,
      `activated_at = now()`,
    ]) {
      expect(
        await failure(() =>
          asApp(c.clinicId, (q) =>
            q.query(`update clinic_locations set ${set} where id = $1`, [main.id]),
          ),
        ),
        set,
      ).toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });
    }
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) => q.query(`delete from clinic_locations where id = $1`, [main.id])),
      ),
    ).toMatchObject({ code: "42501" });
    // A second main location, by any role: refused (the runtime role by the
    // guard, the owner by the one place per account).
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(
            `insert into clinic_locations (clinic_id, position, status, timezone) values ($1, 1, 'active', 'America/New_York')`,
            [c.clinicId],
          ),
        ),
      ),
    ).toMatchObject({ code: "42501", message: expect.stringMatching(/made with its clinic/) });
    expect(
      await failure(() =>
        inTenant(c.clinicId, (q) =>
          q.query(
            `insert into clinic_locations (clinic_id, position, timezone) values ($1, 1, 'America/New_York')`,
            [c.clinicId],
          ),
        ),
      ),
    ).toMatchObject({ code: "23505" });
    // The label is the location's own, and the portal will edit it.
    await asApp(c.clinicId, (q) =>
      q.query(`update clinic_locations set label = 'Uptown' where id = $1`, [main.id]),
    );
    expect((await mainOf(c.clinicId)).label).toBe("Uptown");
  });

  // ---------------------------------------------------------------------------
  // A later location
  // ---------------------------------------------------------------------------

  test("a later location is added pending with its acceptance before the charge, and only app_activate_location makes it active, once its charge is recorded", async () => {
    const c = await seedClinic("loc-add");
    await seedEntitled(c.clinicId, { planId: "webchat-300" });
    const added = await addPendingLocation(c);
    const [, later] = await locationsOf(c.clinicId);
    expect(later).toMatchObject({
      id: added.locationId,
      position: 2,
      status: "pending",
      label: "Downtown",
      activated_at: null,
      add_request_id: added.requestId,
      acknowledgement_id: added.acknowledgementId,
    });

    // Not charged: refused, and nothing moves.
    const early = await failure(() =>
      asApp(c.clinicId, (q) =>
        q.query(`select app_activate_location($1::uuid)`, [added.locationId]),
      ),
    );
    expect(early).toMatchObject({
      code: "23514",
      message: expect.stringMatching(/not recorded as charged/),
    });
    // Charged under another add: still refused.
    await inTenant(c.clinicId, (q) =>
      q.query(
        `update entitlements set pending_location_request_id = $2, pending_location_count = 2, pending_location_charged_at = now() where clinic_id = $1`,
        [c.clinicId, randomUUID()],
      ),
    );
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(`select app_activate_location($1::uuid)`, [added.locationId]),
        ),
      ),
    ).toMatchObject({ code: "23514" });
    // Charged for this add: active, by the database's clock, once.
    await inTenant(c.clinicId, (q) =>
      q.query(`update entitlements set pending_location_request_id = $2 where clinic_id = $1`, [
        c.clinicId,
        added.requestId,
      ]),
    );
    const first = await asApp(
      c.clinicId,
      async (q) =>
        (
          await q.query<{ at: Date }>(`select app_activate_location($1::uuid) as at`, [
            added.locationId,
          ])
        ).rows[0]!.at,
    );
    expect(first).toBeInstanceOf(Date);
    // A resume asking again gets the same time, whatever the marker says now.
    await inTenant(c.clinicId, (q) =>
      q.query(
        `update entitlements set pending_location_request_id = null, pending_location_count = null, pending_location_charged_at = null where clinic_id = $1`,
        [c.clinicId],
      ),
    );
    const again = await asApp(
      c.clinicId,
      async (q) =>
        (
          await q.query<{ at: Date }>(`select app_activate_location($1::uuid) as at`, [
            added.locationId,
          ])
        ).rows[0]!.at,
    );
    expect(again.getTime()).toBe(first.getTime());
    expect((await locationsOf(c.clinicId))[1]).toMatchObject({ status: "active" });

    // Another tenant cannot activate it, nor anyone a main location's id it does not own.
    const other = await seedClinic("loc-add-other");
    expect(
      await failure(() =>
        asApp(other.clinicId, (q) =>
          q.query(`select app_activate_location($1::uuid)`, [added.locationId]),
        ),
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await failure(() =>
        asApp(null, (q) => q.query(`select app_activate_location($1::uuid)`, [added.locationId])),
      ),
    ).toMatchObject({ code: "42501" });
  });

  test("the runtime role cannot invent a location: not active, not without its acceptance, not with another's, not in another time zone", async () => {
    const c = await seedClinic("loc-invent");
    const other = await seedClinic("loc-invent-other");
    const theirs = await addPendingLocation(other);
    const ours = await addPendingLocation(c);
    const insert = (values: Record<string, unknown>) =>
      asApp(c.clinicId, (q) => {
        const cols = Object.keys(values);
        return q.query(
          `insert into clinic_locations (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(values),
        );
      });
    const base = {
      clinic_id: c.clinicId,
      position: 3,
      label: "Eastside",
      add_request_id: randomUUID(),
      timezone: "America/New_York",
    };

    // Already active.
    expect(
      await failure(() =>
        insert({
          ...base,
          id: randomUUID(),
          status: "active",
          acknowledgement_id: ours.acknowledgementId,
        }),
      ),
    ).toMatchObject({
      code: "42501",
      message: expect.stringMatching(/added pending/),
    });
    // No acceptance: a database fact, not a code path.
    expect(await failure(() => insert({ ...base, id: randomUUID() }))).toMatchObject({
      code: "23514",
    });
    // Another location's acceptance, of this account or another.
    expect(
      await failure(() =>
        insert({ ...base, id: randomUUID(), acknowledgement_id: ours.acknowledgementId }),
      ),
    ).toMatchObject({
      code: "23503",
    });
    expect(
      await failure(() =>
        insert({ ...base, id: randomUUID(), acknowledgement_id: theirs.acknowledgementId }),
      ),
    ).toMatchObject({ code: "23503" });
    // Another account entirely: from inside this tenant the guard cannot see
    // that account's main location, and the tenant policy would refuse the
    // row after it; either way nothing is written there.
    const across = await failure(() =>
      asApp(c.clinicId, (q) =>
        q.query(
          `insert into clinic_locations (clinic_id, position, label, add_request_id, timezone) values ($1, 5, 'X', $2, 'America/New_York')`,
          [other.clinicId, randomUUID()],
        ),
      ),
    );
    expect(["23514", "42501"]).toContain(across?.code);
    expect((await locationsOf(other.clinicId)).map((l) => l.position)).toEqual([1, 2]);
    // Another time zone, this release's limit, with an acceptance of its own.
    const stepUp = await seedStepUp(c.staffUserId);
    const zoned = randomUUID();
    const refused = await failure(() =>
      withTenant(
        { clinicId: c.clinicId, actor: { type: "user", userId: c.staffUserId, label: "x" } },
        async (tx) => {
          const ack = await recordLocationAcknowledgement(tx, {
            locationId: zoned,
            documentVersion: DOCUMENT,
            renderedText: TEXT,
            acceptedBy: { userId: c.staffUserId, label: "Laura Owner", stepUp },
          });
          await tx.db.execute(
            sql`insert into clinic_locations (id, clinic_id, position, label, add_request_id, acknowledgement_id, timezone)
            values (${zoned}::uuid, ${c.clinicId}::uuid, 4, 'Westside', ${randomUUID()}::uuid, ${ack.id}::uuid, 'America/Los_Angeles')`,
          );
        },
      ),
    );
    expect(refused).toMatchObject({ code: "23514", message: expect.stringMatching(/time zone/) });
    // The location first and its acceptance after: the foreign key needs the acceptance there already.
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(
            `insert into clinic_locations (id, clinic_id, position, label, add_request_id, acknowledgement_id, timezone)
             values ($1, $2, 6, 'Late', $3, $4, 'America/New_York')`,
            [randomUUID(), c.clinicId, randomUUID(), randomUUID()],
          ),
        ),
      ),
    ).toMatchObject({ code: "23503" });
    // And no status moves for the runtime role.
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(`update clinic_locations set status = 'active' where id = $1`, [ours.locationId]),
        ),
      ),
    ).toMatchObject({ code: "42501" });
  });

  test("for every role, a location's account, place, add and acceptance never change, and its status only moves forward", async () => {
    const c = await seedClinic("loc-fixed");
    const added = await addPendingLocation(c);
    for (const set of [
      `position = 7`,
      `add_request_id = gen_random_uuid()`,
      `created_at = now() - interval '1 day'`,
    ]) {
      expect(
        await failure(() =>
          inTenant(c.clinicId, (q) =>
            q.query(`update clinic_locations set ${set} where id = $1`, [added.locationId]),
          ),
        ),
        set,
      ).toMatchObject({ code: "42501" });
    }
    await inTenant(c.clinicId, (q) =>
      q.query(`update clinic_locations set status = 'retired' where id = $1`, [added.locationId]),
    );
    expect(
      await failure(() =>
        inTenant(c.clinicId, (q) =>
          q.query(`update clinic_locations set status = 'active' where id = $1`, [
            added.locationId,
          ]),
        ),
      ),
    ).toMatchObject({ code: "42501", message: expect.stringMatching(/retired -> active/) });
    // A main location is never retired.
    const main = await mainOf(c.clinicId);
    expect(
      await failure(() =>
        inTenant(c.clinicId, (q) =>
          q.query(`update clinic_locations set status = 'retired' where id = $1`, [main.id]),
        ),
      ),
    ).not.toBeNull();
  });

  test("every location keeps the account's time zone: moved with the clinic's", async () => {
    const c = await seedClinic("loc-zone");
    await addPendingLocation(c);
    await getMigratorPool().query(`update clinics set timezone = 'America/Denver' where id = $1`, [
      c.clinicId,
    ]);
    expect((await locationsOf(c.clinicId)).map((l) => l.timezone)).toEqual([
      "America/Denver",
      "America/Denver",
    ]);
  });

  // ---------------------------------------------------------------------------
  // The acceptance
  // ---------------------------------------------------------------------------

  test("an acceptance is the text's hash, at the database's clock, under a live passkey step-up of a person with a grant; append-only for every role", async () => {
    const c = await seedClinic("loc-ack");
    const added = await addPendingLocation(c);
    const { rows } = await inTenant(c.clinicId, (q) =>
      q.query<{
        document_hash: string;
        accepted_at: Date;
        device_label: string;
        accepted_by_label: string;
      }>(
        `select document_hash, accepted_at, device_label, accepted_by_label from location_acknowledgements where id = $1`,
        [added.acknowledgementId],
      ),
    );
    expect(rows[0]!.document_hash).toBe(acknowledgementHash(TEXT));
    expect(rows[0]!.document_hash).toBe(createHash("sha256").update(TEXT, "utf8").digest("hex"));
    expect(rows[0]).toMatchObject({
      device_label: "Front desk Mac",
      accepted_by_label: "Laura Owner, owner",
    });
    expect(Math.abs(rows[0]!.accepted_at.getTime() - Date.now())).toBeLessThan(60_000);
    // The writer's audit row names the passkey and the step-up, as the access log does.
    const audit = await inTenant(c.clinicId, (q) =>
      q.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'location_acknowledgement' and resource_id = $1`,
        [added.acknowledgementId],
      ),
    );
    expect(audit.rows[0]!.metadata).toMatchObject({
      locationId: added.locationId,
      documentVersion: DOCUMENT,
    });
    expect(audit.rows[0]!.metadata).toHaveProperty("passkeyId");
    expect(audit.rows[0]!.metadata).toHaveProperty("stepUpId");

    const stepUp = await seedStepUp(c.staffUserId, "Back office PC");
    const raw = (values: Partial<Record<string, unknown>>) =>
      asApp(c.clinicId, (q) => {
        const row = {
          clinic_id: c.clinicId,
          location_id: randomUUID(),
          document_version: DOCUMENT,
          document_hash: acknowledgementHash(TEXT),
          rendered_text: TEXT,
          accepted_by_label: "Laura Owner",
          accepted_by_user_id: c.staffUserId,
          step_up_id: stepUp.stepUpId,
          passkey_id: stepUp.passkeyId,
          device_label: stepUp.deviceLabel,
          accepted_at: "2020-01-01T00:00:00Z",
          ...values,
        };
        const cols = Object.keys(row);
        return q.query<{ accepted_at: Date }>(
          `insert into location_acknowledgements (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning accepted_at`,
          Object.values(row),
        );
      });
    // The writer's date is replaced by the database's.
    const stamped = await raw({});
    expect(stamped.rows[0]!.accepted_at.getFullYear()).toBeGreaterThan(2020);
    // A hash that is not the text's.
    expect(await failure(() => raw({ document_hash: "0".repeat(64) }))).toMatchObject({
      code: "23514",
    });
    // Another person's step-up, another device's label, an ended step-up, an expired one.
    const stranger = await seedClinic("loc-ack-stranger");
    const theirs = await seedStepUp(stranger.staffUserId);
    expect(
      await failure(() => raw({ step_up_id: theirs.stepUpId, passkey_id: theirs.passkeyId })),
    ).toMatchObject({ code: "23514" });
    expect(await failure(() => raw({ device_label: "Someone else's phone" }))).toMatchObject({
      code: "23514",
    });
    const ended = await seedStepUp(c.staffUserId, "Ended");
    await getMigratorPool().query(`update step_ups set revoked_at = now() where id = $1`, [
      ended.stepUpId,
    ]);
    expect(
      await failure(() =>
        raw({ step_up_id: ended.stepUpId, passkey_id: ended.passkeyId, device_label: "Ended" }),
      ),
    ).toMatchObject({
      code: "23514",
    });
    // A person without a grant on the account, even with a step-up of their own.
    expect(
      await failure(() =>
        raw({
          accepted_by_user_id: stranger.staffUserId,
          step_up_id: theirs.stepUpId,
          passkey_id: theirs.passkeyId,
          device_label: theirs.deviceLabel,
        }),
      ),
    ).toMatchObject({ code: "23514", message: expect.stringMatching(/live grant/) });
    // The main location takes none.
    const main = await mainOf(c.clinicId);
    expect(await failure(() => raw({ location_id: main.id }))).toMatchObject({
      code: "23514",
      message: expect.stringMatching(/main location/),
    });
    // A version outside `<document>/<semver>`.
    expect(await failure(() => raw({ document_version: "1.0.0" }))).toMatchObject({
      code: "23514",
    });

    // Never changed or removed: no grant for the runtime role, and the guard for the owner.
    for (const text of [
      `update location_acknowledgements set accepted_by_label = 'Someone else' where id = $1`,
      `delete from location_acknowledgements where id = $1`,
    ]) {
      expect(
        await failure(() => asApp(c.clinicId, (q) => q.query(text, [added.acknowledgementId]))),
        text,
      ).toMatchObject({ code: "42501" });
      expect(
        await failure(() => inTenant(c.clinicId, (q) => q.query(text, [added.acknowledgementId]))),
        text,
      ).toMatchObject({
        code: "42501",
        message: expect.stringMatching(/append-only/),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // The seven tables
  // ---------------------------------------------------------------------------

  test("a row that names no location is the main location's; one naming another account's location is refused; a location never moves, for any role", async () => {
    const c = await seedClinic("loc-rows");
    const other = await seedClinic("loc-rows-other");
    const main = await mainOf(c.clinicId);
    const theirMain = await mainOf(other.clinicId);
    const later = await addPendingLocation(c);

    const ids = await asApp(c.clinicId, async (q) => {
      const contact = (
        await q.query<{ id: string }>(
          `insert into contacts (clinic_id, phone) values ($1, '+15550104001') returning id`,
          [c.clinicId],
        )
      ).rows[0]!.id;
      const conversation = (
        await q.query<{ id: string }>(
          `insert into conversations (clinic_id, contact_id, channel, started_at) values ($1, $2, 'web_chat', now()) returning id`,
          [c.clinicId, contact],
        )
      ).rows[0]!.id;
      const request = (
        await q.query<{ id: string }>(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, token_hash, expires_at)
           values ($1, $2, 'web_chat', 'any morning', $3, now() + interval '6 days') returning id`,
          [c.clinicId, contact, randomBytes(32)],
        )
      ).rows[0]!.id;
      const appointment = (
        await q.query<{ id: string }>(
          `insert into appointments (clinic_id, contact_id, scheduled_for) values ($1, $2, now() + interval '3 days') returning id`,
          [c.clinicId, contact],
        )
      ).rows[0]!.id;
      const handover = (
        await q.query<{ id: string }>(
          `insert into handovers (clinic_id, channel, conversation_id) values ($1, 'web_chat', $2) returning id`,
          [c.clinicId, conversation],
        )
      ).rows[0]!.id;
      const hold = (
        await q.query<{ id: string }>(
          `insert into slot_holds (clinic_id, channel, holder_ref, starts_at, duration_minutes, ends_at, calendar_id, expires_at, contact_id)
           values ($1, 'web_chat', $2, date_trunc('hour', now()) + interval '2 days', 30,
                   date_trunc('hour', now()) + interval '2 days 30 minutes', 'primary', now() + interval '60 seconds', $3) returning id`,
          [c.clinicId, randomBytes(32).toString("hex"), contact],
        )
      ).rows[0]!.id;
      await q.query(
        `insert into meta_booking_drafts (clinic_id, platform, sender_id, external_id) values ($1, 'whatsapp', 'v1:loc', 'ext-loc')`,
        [c.clinicId],
      );
      await q.query(
        `insert into clinic_closures (clinic_id, closed_on, label) values ($1, '2026-12-25', 'Christmas')`,
        [c.clinicId],
      );
      return { contact, conversation, request, appointment, handover, hold };
    });

    const TABLES: Array<[string, string, string]> = [
      ["conversations", "id", ids.conversation],
      ["booking_requests", "id", ids.request],
      ["appointments", "id", ids.appointment],
      ["handovers", "id", ids.handover],
      ["slot_holds", "id", ids.hold],
      ["meta_booking_drafts", "sender_id", "v1:loc"],
      ["clinic_closures", "closed_on", "2026-12-25"],
    ];
    for (const [table, key, id] of TABLES) {
      const { rows } = await inTenant(c.clinicId, (q) =>
        q.query<{ location_id: string }>(
          `select location_id from ${table} where clinic_id = $1 and ${key} = $2`,
          [c.clinicId, id],
        ),
      );
      expect(rows, table).toEqual([{ location_id: main.id }]);
      // Never moved, by the runtime role or the owner: to a later location of
      // its own account, or to another's.
      for (const to of [later.locationId, theirMain.id]) {
        expect(
          await failure(() =>
            asApp(c.clinicId, (q) =>
              q.query(`update ${table} set location_id = $3 where clinic_id = $1 and ${key} = $2`, [
                c.clinicId,
                id,
                to,
              ]),
            ),
          ),
          `${table} (runtime role)`,
        ).toMatchObject({ code: "42501" });
        expect(
          await failure(() =>
            inTenant(c.clinicId, (q) =>
              q.query(`update ${table} set location_id = $3 where clinic_id = $1 and ${key} = $2`, [
                c.clinicId,
                id,
                to,
              ]),
            ),
          ),
          `${table} (owner)`,
        ).toMatchObject({ code: "42501" });
      }
    }

    // Naming another account's location is refused by the foreign key; naming
    // a later location of its own is the tool layer's to do (step 9), and
    // stays where it was written.
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(
            `insert into conversations (clinic_id, location_id, contact_id, channel, started_at) values ($1, $2, $3, 'voice', now())`,
            [c.clinicId, theirMain.id, ids.contact],
          ),
        ),
      ),
    ).toMatchObject({ code: "23503" });
    const named = await asApp(
      c.clinicId,
      async (q) =>
        (
          await q.query<{ location_id: string }>(
            `insert into conversations (clinic_id, location_id, contact_id, channel, started_at) values ($1, $2, $3, 'voice', now()) returning location_id`,
            [c.clinicId, later.locationId, ids.contact],
          )
        ).rows[0]!.location_id,
    );
    expect(named).toBe(later.locationId);
    // And nothing keeps the placeholder.
    const { rows: unset } = await inTenant(c.clinicId, (q) =>
      q.query(`select 1 from conversations where location_id = $1`, [LOCATION_UNSET]),
    );
    expect(unset).toEqual([]);
  });

  test("the assignment fires before every other BEFORE INSERT trigger on its table, so each sees the row's real location", async () => {
    const { rows } = await getMigratorPool().query<{ relname: string; first: string }>(`
      select c.relname,
             (array_agg(t.tgname order by t.tgname))[1] as first
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and (t.tgtype & 2) = 2      -- BEFORE
         and (t.tgtype & 4) = 4      -- INSERT
         and c.relname in ('conversations', 'booking_requests', 'appointments', 'handovers', 'slot_holds', 'meta_booking_drafts', 'clinic_closures')
       group by c.relname
       order by c.relname
    `);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.first, row.relname).toBe(`${row.relname}_assign_location`);
  });

  // ---------------------------------------------------------------------------
  // Isolation, grants and the reader
  // ---------------------------------------------------------------------------

  test("a tenant sees only its own locations and acceptances; outside a tenant, nothing", async () => {
    const a = await seedClinic("loc-iso-a");
    const b = await seedClinic("loc-iso-b");
    await addPendingLocation(a, "Downtown");
    await addPendingLocation(b, "Harbour");

    const seen = await asApp(a.clinicId, async (q) => ({
      locations: (await q.query<{ clinic_id: string }>(`select clinic_id from clinic_locations`))
        .rows,
      acks: (
        await q.query<{ clinic_id: string }>(`select clinic_id from location_acknowledgements`)
      ).rows,
    }));
    expect(new Set(seen.locations.map((r) => r.clinic_id))).toEqual(new Set([a.clinicId]));
    expect(seen.locations).toHaveLength(2);
    expect(seen.acks).toEqual([{ clinic_id: a.clinicId }]);
    for (const table of ["clinic_locations", "location_acknowledgements"]) {
      expect(
        await asApp(null, async (q) => (await q.query(`select 1 from ${table}`)).rows),
        table,
      ).toEqual([]);
    }
  });

  test("lib/locations reads every location of the tenant, main first, and never another account's", async () => {
    const a = await seedClinic("loc-read-a");
    const b = await seedClinic("loc-read-b");
    const added = await addPendingLocation(a, "Downtown");
    const theirs = await addPendingLocation(b, "Harbour");
    await withTenant(
      { clinicId: a.clinicId, actor: { type: "service", serviceName: "test" } },
      async (tx) => {
        const all = await readLocations(tx);
        expect(all.map((l) => [l.position, l.isMain, l.status, l.label])).toEqual([
          [1, true, "active", null],
          [2, false, "pending", "Downtown"],
        ]);
        expect(all[1]).toMatchObject({
          id: added.locationId,
          address: "2 Side St, Austin TX",
          timezone: "America/New_York",
          activatedAt: null,
        });
        expect((await readLocations(tx, { statuses: ["active"] })).map((l) => l.position)).toEqual([
          1,
        ]);
        expect(await readLocations(tx, { statuses: [] })).toEqual([]);
        expect(await mainLocation(tx)).toMatchObject({ position: 1, isMain: true });
        expect((await locationById(tx, added.locationId))?.label).toBe("Downtown");
        // Another account's location, a malformed id and an unknown one: nothing.
        expect(await locationById(tx, theirs.locationId)).toBeNull();
        expect(await locationById(tx, "not-a-uuid")).toBeNull();
        expect(await locationById(tx, randomUUID())).toBeNull();
      },
    );
    // A clinic with no location (a closed account's were deleted) has no main one.
    const closed = await seedClinic("loc-read-closed");
    await inTenant(closed.clinicId, (q) =>
      q.query(`delete from clinic_locations where clinic_id = $1`, [closed.clinicId]),
    );
    await expect(
      withTenant(
        { clinicId: closed.clinicId, actor: { type: "service", serviceName: "test" } },
        (tx) => mainLocation(tx),
      ),
    ).rejects.toThrow(/no main location/);
  });

  test("the runtime role holds only the verbs the records need, and no longer moves the billing pointer", async () => {
    const verbs = async (table: string) =>
      (
        await getMigratorPool().query<{ insert: boolean; delete: boolean; updatable: string[] }>(
          `select has_table_privilege('healdesk_app', $1::regclass, 'INSERT') as insert,
                  has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as delete,
                  coalesce((select array_agg(a.attname::text order by a.attname)
                              from pg_attribute a
                             where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
                               and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')),
                           array[]::text[]) as updatable`,
          [table],
        )
      ).rows[0]!;
    expect(await verbs("clinic_locations")).toEqual({
      insert: true,
      delete: false,
      updatable: [
        "address",
        "call_routing",
        "carrier",
        "coverage_mode",
        "direct_line_e164",
        "label",
        "opening_hours",
        "phone_system_type",
        "published_phone_e164",
        "transfer_e164",
        "updated_at",
        "urgent_help_e164",
        "vet_referral_e164",
      ],
    });
    expect(await verbs("location_acknowledgements")).toEqual({
      insert: true,
      delete: false,
      updatable: [],
    });

    const c = await seedClinic("loc-pointer");
    const other = await seedClinic("loc-pointer-other");
    expect(
      await failure(() =>
        asApp(c.clinicId, (q) =>
          q.query(`update clinics set billing_clinic_id = $2 where id = $1`, [
            c.clinicId,
            other.clinicId,
          ]),
        ),
      ),
    ).toMatchObject({ code: "42501" });
    // Everything else on the row is as it was.
    await asApp(c.clinicId, (q) =>
      q.query(`update clinics set name = 'Renamed' where id = $1`, [c.clinicId]),
    );
  });

  test("the account's closure deletes its locations and keeps their acceptances, and nothing rebuilds a location after it", async () => {
    // The closure's list (read by tests/booking-request-destruction.test.ts
    // and tests/account-closure.test.ts) names clinic_locations, and the
    // acceptances are kept for good with the agreement.
    const { rows } = await getMigratorPool().query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname = 'app_close_clinic_account'`,
    );
    expect(rows[0]!.prosrc).toMatch(
      /DELETE FROM clinic_locations x WHERE x\.clinic_id = target_clinic/,
    );
    expect(rows[0]!.prosrc).not.toMatch(/DELETE FROM location_acknowledgements/i);
    const c = await seedClinic("loc-closed");
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [
      c.clinicId,
    ]);
    expect(
      await failure(() =>
        inTenant(c.clinicId, (q) =>
          q.query(`update clinic_locations set label = 'After' where clinic_id = $1`, [c.clinicId]),
        ),
      ),
    ).toMatchObject({ code: "23514", message: expect.stringMatching(/account is closed/) });
  });
});
