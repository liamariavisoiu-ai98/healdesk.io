import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resetGoogleTokenCache, setGoogleTimeouts, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  CALENDAR_WRITE_REASONS,
  MAX_WRITE_ATTEMPTS,
  NEVER_RETRIED_REASONS,
  nextWriteAttemptAt,
  sweepDeskWrites,
  writeToCalendar,
  WRITE_BACKOFF_MINUTES,
} from "@/lib/booking/calendar";
import { runOperation, type Operator } from "@/lib/ops/api";
import { listClinics } from "@/lib/ops/clinics";
import { CALENDAR_BREAKS, TOKEN_BREAKS } from "@/lib/connections/google-calendar";
import { alertStuckCalendarWrites } from "@/lib/ops/calendar-write-alerts";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
} from "./setup/desk-calendar";
import { deskDecide } from "./setup/desk";
import { inTenant } from "./setup/factories";

/**
 * The desk sweep's retry ladder (design E3 §2.3; drizzle/0117): five
 * attempts, spaced +2 min, +10 min, +30 min, +2 h and +6 h, for as long as
 * the slot has not started; the reasons it never retries; and Google's "not
 * now" (a 429) retried rather than left for a person. Every Google call goes
 * to the in-memory fake, and every clock the sweep reads is passed in.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const APP = join(__dirname, "..");
const PACKAGES = join(APP, "..", "..", "packages", "connectors", "src", "google");

describe("the reason words", () => {
  test("every word the adapter, the target check and the writer can record is classified", () => {
    const words = new Set<string>();
    const literal = /reason:\s*(?:\w+\s*\?\?\s*)?"([A-Za-z_]+)"/g;
    for (const file of ["adapter.ts", "http.ts", "oauth.ts"]) {
      for (const m of readFileSync(join(PACKAGES, file), "utf8").matchAll(literal)) words.add(m[1]!);
    }
    const writer = readFileSync(join(APP, "src/lib/booking/calendar.ts"), "utf8");
    for (const m of writer.matchAll(/reason = "([a-z_]+)"/g)) words.add(m[1]!);
    for (const m of writer.matchAll(/calendarWriteError: "([a-z_]+)"/g)) words.add(m[1]!);
    // HRC-04's refusals, recorded as target_<refusal>.
    const target = readFileSync(join(APP, "src/lib/connections/google-calendar.ts"), "utf8");
    const union = /export type CalendarTargetRefusal =([\s\S]*?);/.exec(target)![1]!;
    for (const m of union.matchAll(/\|\s*"([a-z_]+)"/g)) words.add(`target_${m[1]}`);
    for (const code of [...TOKEN_BREAKS, ...CALENDAR_BREAKS]) words.add(code);

    expect(words.size).toBeGreaterThan(25);
    // Google's own words matched by the adapter, never recorded as ours.
    words.delete("notFound");
    const unclassified = [...words].filter((w) => !Object.hasOwn(CALENDAR_WRITE_REASONS, w)).sort();
    expect(unclassified).toEqual([]);
  });

  test("the reasons never retried automatically are exactly the settled ones the design names", () => {
    expect([...NEVER_RETRIED_REASONS].sort()).toEqual(
      [
        "deleted_in_calendar",
        "event_id_taken",
        "not_ours",
        "conflict",
        "calendar_not_connected",
        "target_terms",
        "target_unmanaged_account",
        "target_account_mismatch",
        "target_outside_organisation",
        "target_not_owned",
        ...TOKEN_BREAKS,
        ...CALENDAR_BREAKS,
      ].sort(),
    );
    expect(NEVER_RETRIED_REASONS).not.toContain("target_unverified");
  });

  test("the whole table is pinned: moving a word between classes, or adding one, is a decision this test names", () => {
    expect(CALENDAR_WRITE_REASONS).toEqual({
      timeout: "transient",
      network: "transient",
      unconfirmed: "transient",
      threw: "transient",
      rate_limited: "transient",
      target_unverified: "transient",
      deleted_in_calendar: "settled",
      event_id_taken: "settled",
      not_ours: "settled",
      conflict: "settled",
      calendar_not_connected: "settled",
      target_terms: "settled",
      target_unmanaged_account: "settled",
      target_account_mismatch: "settled",
      target_outside_organisation: "settled",
      target_not_owned: "settled",
      invalid_grant: "settled",
      admin_policy_enforced: "settled",
      scope_lost: "settled",
      access_denied: "settled",
      insufficient_permissions: "settled",
      calendar_not_found: "settled",
      api_disabled: "refused",
      oauth_client: "refused",
      missing_refresh_token: "refused",
      calendar_id: "refused",
      missing_key: "refused",
      bad_start: "refused",
      bad_duration: "refused",
      bad_time_zone: "refused",
      phone_field_refused: "refused",
      malformed_response: "refused",
      missing_code: "refused",
      missing_token: "refused",
      id_token_malformed: "refused",
      not_calendar_owner: "refused",
      too_many_calendars: "refused",
      bad_window: "refused",
      window_too_long: "refused",
      calendar_error: "refused",
    });
  });

  test("the ladder is +2 min, +10 min, +30 min, +2 h and +6 h", () => {
    const at = new Date("2026-10-24T10:00:00Z");
    expect([1, 2, 3, 4, 5].map((n) => (nextWriteAttemptAt(n, at).getTime() - at.getTime()) / MIN)).toEqual([
      2, 10, 30, 120, 360,
    ]);
    expect(WRITE_BACKOFF_MINUTES).toHaveLength(MAX_WRITE_ATTEMPTS);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("the desk sweep's ladder (drizzle/0117)", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  // Each test alone: the sweep reads every location, so another test's
  // unsettled write would take a turn.
  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts`);
    google = freshGoogle();
  });

  afterEach(() => setGoogleTimeouts(undefined));

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  type Row = {
    calendar_write_status: string;
    calendar_write_error: string | null;
    calendar_write_attempts: number;
    calendar_write_next_at: Date | null;
    updated_at: Date;
  };
  const row = (clinicId: string, id: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<Row>(
            `select calendar_write_status, calendar_write_error, calendar_write_attempts,
                    calendar_write_next_at, updated_at
               from appointments where id = $1`,
            [id],
          )
        ).rows[0]!,
    );
  const set = (clinicId: string, id: string, assignments: string, values: unknown[] = []) =>
    inTenant(clinicId, (client) => client.query(`update appointments set ${assignments} where id = $1`, [id, ...values]));

  /** A desk confirmation whose insert Google answered 503: unknown at its first attempt. */
  async function unknownWrite(label: string, days = 4, hour = 10): Promise<{ clinicId: string; id: string }> {
    const f = await deskLocation(google, label);
    const r = await phoneRequest(f.clinicId);
    google.failNext({ on: "insert", status: 503, reason: "backendError" });
    const decided = await deskDecide(r.token, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: deskTime(days, hour),
    });
    expect(decided.calendarWrite).toBe("unknown");
    return { clinicId: f.clinicId, id: decided.appointmentId! };
  }

  test(
    "after each failed attempt the next is +2 min, +10 min, +30 min, +2 h, +6 h; a write not due is skipped, a due one taken, and five is the end",
    async () => {
      const w = await unknownWrite("ladder", 6);
      const first = await row(w.clinicId, w.id);
      expect(first.calendar_write_attempts).toBe(1);
      expect(first.calendar_write_next_at!.getTime() - first.updated_at.getTime()).toBe(2 * MIN);

      let due = first.calendar_write_next_at!;
      for (const [attempt, minutes] of [
        [2, 10],
        [3, 30],
        [4, 120],
        [5, 360],
      ] as const) {
        // A minute early: not due, nothing claimed.
        expect(await sweepDeskWrites({ now: new Date(due.getTime() - MIN) })).toMatchObject({ attempted: 0 });
        google.failNext({ on: "insert", status: 503, reason: "backendError" });
        const before = Date.now();
        expect(await sweepDeskWrites({ now: due })).toMatchObject({ attempted: 1, unknown: 1 });
        const finished = Date.now();
        const after = await row(w.clinicId, w.id);
        expect(after.calendar_write_attempts).toBe(attempt);
        // The step, from the moment the attempt was recorded (a fresh clock,
        // not the sweep's): the row's own update time.
        expect(after.calendar_write_next_at!.getTime() - after.updated_at.getTime()).toBe(minutes * MIN);
        expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
        expect(after.updated_at.getTime()).toBeLessThanOrEqual(finished + 1_000);
        due = after.calendar_write_next_at!;
      }
      // Five of five: the sweep stops, however long it waits.
      expect(await sweepDeskWrites({ now: new Date(due.getTime() + DAY) })).toMatchObject({ attempted: 0 });
      // And the alert, which a waiting write never raised, now tells ops.
      await alertStuckCalendarWrites(new Date(due.getTime() + HOUR));
      const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
        `select fields from ops_alerts where event = 'calendar_write_stuck'`,
      );
      expect(rows.map((r) => r.fields.appointmentId)).toEqual([w.id]);
      expect(rows[0]!.fields).toMatchObject({ status: "unknown", attemptCount: 5 });
    },
    120_000,
  );

  test(
    "a write waiting for its next attempt raises no alert; a written one clears its next attempt",
    async () => {
      const w = await unknownWrite("ladder-quiet");
      // The sweep switched on: the write is waiting for a retry that will come.
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'calendar-watch'`);
      await alertStuckCalendarWrites(new Date(Date.now() + 3 * DAY));
      const { rows } = await getMigratorPool().query(`select 1 from ops_alerts where event = 'calendar_write_stuck'`);
      expect(rows).toHaveLength(0);
      expect(await sweepDeskWrites({ now: new Date(Date.now() + 3 * MIN) })).toMatchObject({ attempted: 1, written: 1 });
      expect(await row(w.clinicId, w.id)).toMatchObject({ calendar_write_status: "written", calendar_write_next_at: null });
    },
    60_000,
  );

  test(
    "a three-day-old unknown write whose slot is still ahead is retried (the old 24-hour look-back left it)",
    async () => {
      const w = await unknownWrite("ladder-weekend", 6);
      await set(w.clinicId, w.id, `updated_at = now() - interval '3 days', calendar_write_next_at = now() - interval '3 days'`);
      expect(await sweepDeskWrites()).toMatchObject({ attempted: 1, written: 1 });
      expect((await row(w.clinicId, w.id)).calendar_write_status).toBe("written");
    },
    60_000,
  );

  test(
    "a slot that has started is never written, and its unsettled write is told to ops",
    async () => {
      const w = await unknownWrite("ladder-past", 2, 9);
      const { rows } = await inTenant(w.clinicId, (client) =>
        client.query<{ scheduled_for: Date }>(`select scheduled_for from appointments where id = $1`, [w.id]),
      );
      const started = new Date(rows[0]!.scheduled_for.getTime() + MIN);
      const inserts = google.requests.filter((r) => r.endpoint === "insert").length;
      expect(await sweepDeskWrites({ now: started })).toMatchObject({ attempted: 0 });
      expect(google.requests.filter((r) => r.endpoint === "insert")).toHaveLength(inserts);
      await alertStuckCalendarWrites(started);
      const told = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
        `select fields from ops_alerts where event = 'calendar_write_stuck'`,
      );
      expect(told.rows.map((r) => r.fields.appointmentId)).toEqual([w.id]);
    },
    60_000,
  );

  test(
    "no settled reason is ever swept, even on a row left unknown; the same row with a transient reason is",
    async () => {
      const w = await unknownWrite("ladder-never");
      const later = new Date(Date.now() + HOUR);
      for (const reason of NEVER_RETRIED_REASONS) {
        await set(w.clinicId, w.id, `calendar_write_error = $2, calendar_write_next_at = null`, [reason]);
        expect(await sweepDeskWrites({ now: later }), reason).toMatchObject({ attempted: 0 });
      }
      await set(w.clinicId, w.id, `calendar_write_error = 'timeout'`);
      expect(await sweepDeskWrites({ now: later })).toMatchObject({ attempted: 1, written: 1 });
    },
    60_000,
  );

  test(
    "a staff-cancelled booking is never claimed, due or not",
    async () => {
      const w = await unknownWrite("ladder-cancelled");
      await set(w.clinicId, w.id, `status = 'cancelled', calendar_write_next_at = null`);
      expect(await sweepDeskWrites({ now: new Date(Date.now() + HOUR) })).toMatchObject({ attempted: 0 });
      expect((await row(w.clinicId, w.id)).calendar_write_status).toBe("unknown");
    },
    60_000,
  );

  test(
    "a 429 on the insert is Google's 'not now': unknown, on the ladder, and written by the next due attempt",
    async () => {
      const f = await deskLocation(google, "ladder-429");
      const r = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 429, reason: "rateLimitExceeded" });
      const decided = await deskDecide(r.token, "confirmed", {
        decidedByLabel: "Jo",
        deskNote: null,
        confirmedFor: deskTime(4, 11),
      });
      expect(decided.calendarWrite).toBe("unknown");
      const after = await row(f.clinicId, decided.appointmentId!);
      expect(after).toMatchObject({ calendar_write_status: "unknown", calendar_write_error: "rateLimitExceeded" });
      expect(after.calendar_write_next_at!.getTime() - after.updated_at.getTime()).toBe(2 * MIN);
      expect(await sweepDeskWrites({ now: after.calendar_write_next_at! })).toMatchObject({ attempted: 1, written: 1 });
    },
    60_000,
  );

  test(
    "the sweep takes writes in turn from each location, so one location's backlog cannot hold up another's",
    async () => {
      const first = await deskLocation(google, "ladder-fair-a");
      const second = await deskLocation(google, "ladder-fair-b");
      // The backlog goes to the location the sweep reads first, so one
      // location at a time would spend the whole limit on it.
      const order = (await listClinics()).map((c) => c.id);
      const [a, b] =
        order.indexOf(first.clinicId) < order.indexOf(second.clinicId) ? [first, second] : [second, first];
      for (const hour of [9, 10, 11]) {
        const r = await phoneRequest(a.clinicId);
        google.failNext({ on: "insert", status: 503, reason: "backendError" });
        await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(5, hour) });
      }
      const rb = await phoneRequest(b.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const bId = (
        await deskDecide(rb.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(5, 14) })
      ).appointmentId!;
      const result = await sweepDeskWrites({ limit: 2, now: new Date(Date.now() + 3 * MIN) });
      expect(result).toMatchObject({ attempted: 2, written: 2 });
      expect((await row(b.clinicId, bId)).calendar_write_status).toBe("written");
    },
    60_000,
  );

  /* ------------------------------------------- the sweep's claim (review) */

  const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
  const inserts = () => google.requests.filter((r) => r.endpoint === "insert").length;
  const gets = () => google.requests.filter((r) => r.endpoint === "get").length;
  const retriedEvents = async (appointmentId: string) =>
    (
      await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
        `select metadata from security_events where event = 'calendar_write_retried' and metadata->>'appointmentId' = $1`,
        [appointmentId],
      )
    ).rows.map((r) => r.metadata);

  test(
    "the sweep's claim checks the ladder itself: an id listed earlier that is no longer due is not claimed",
    async () => {
      const w = await unknownWrite("claim-stale");
      // Listed as due by a sweep at +3 min; another run tried it meanwhile and put it at +10 min.
      await set(w.clinicId, w.id, `calendar_write_next_at = now() + interval '10 minutes'`);
      const before = inserts();
      expect(await writeToCalendar(w.clinicId, w.id, { sweep: true, now: new Date(Date.now() + 3 * MIN) })).toBe("unknown");
      expect(await row(w.clinicId, w.id)).toMatchObject({ calendar_write_attempts: 1, calendar_write_status: "unknown" });
      expect(inserts()).toBe(before);
    },
    60_000,
  );

  test(
    "the sweep's claim checks the slot by the database's clock: a slot that started during a long run is not claimed",
    async () => {
      const w = await unknownWrite("claim-started");
      await set(w.clinicId, w.id, `scheduled_for = now() - interval '1 minute', calendar_write_next_at = null`);
      const before = inserts();
      // The run started ten minutes ago, when the slot was still ahead.
      expect(await writeToCalendar(w.clinicId, w.id, { sweep: true, now: new Date(Date.now() - 10 * MIN) })).toBe("unknown");
      expect((await row(w.clinicId, w.id)).calendar_write_attempts).toBe(1);
      expect(inserts()).toBe(before);
    },
    60_000,
  );

  test(
    "the next attempt is placed from the clock when the attempt was recorded, not from the sweep's start",
    async () => {
      const w = await unknownWrite("claim-fresh-clock");
      const sweepNow = new Date(Date.now() + 3 * MIN);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      expect(await sweepDeskWrites({ now: sweepNow })).toMatchObject({ attempted: 1, unknown: 1 });
      const after = await row(w.clinicId, w.id);
      expect(after.calendar_write_next_at!.getTime()).toBeLessThanOrEqual(Date.now() + 10 * MIN + 1_000);
      expect(after.calendar_write_next_at!.getTime()).toBeLessThan(sweepNow.getTime() + 10 * MIN);
      expect(after.updated_at.getTime()).toBeLessThan(sweepNow.getTime());
    },
    60_000,
  );

  test(
    "a 5xx from Google's token endpoint is 'not now' too: unknown and on the ladder, never failed",
    async () => {
      const w = await unknownWrite("ladder-token-503");
      // Back to a first attempt (an insert, no read-back), with no token cached.
      await set(w.clinicId, w.id, `calendar_write_status = 'none', calendar_write_attempts = 0, calendar_write_next_at = null`);
      resetGoogleTokenCache();
      google.failNext({ on: "token", status: 503 });
      expect(await writeToCalendar(w.clinicId, w.id)).toBe("unknown");
      const after = await row(w.clinicId, w.id);
      expect(after.calendar_write_status).toBe("unknown");
      expect(after.calendar_write_next_at).not.toBeNull();
      expect(google.requests.filter((r) => r.endpoint === "insert")).toHaveLength(1);
    },
    60_000,
  );

  test(
    "an attempt that ends failed clears the next attempt: nothing waits on the ladder",
    async () => {
      const w = await unknownWrite("ladder-fails");
      expect((await row(w.clinicId, w.id)).calendar_write_next_at).not.toBeNull();
      google.failNext({ on: "insert", status: 400, reason: "badRequest" });
      expect(await sweepDeskWrites({ now: new Date(Date.now() + 3 * MIN) })).toMatchObject({ attempted: 1, failed: 1 });
      expect(await row(w.clinicId, w.id)).toMatchObject({ calendar_write_status: "failed", calendar_write_next_at: null });
    },
    60_000,
  );

  test(
    "an operator's retry claims a write at five of five, counts the attempt, reads back once and inserts once",
    async () => {
      const w = await unknownWrite("operator-five");
      await set(w.clinicId, w.id, `calendar_write_attempts = 5`);
      const reads = gets();
      const writes = inserts();
      const res = await runOperation("retryCalendarWrite", { clinicId: w.clinicId, appointmentId: w.id }, OPERATOR);
      expect((res.body as { data: Record<string, unknown> }).data).toMatchObject({ status: "retried", outcome: "written" });
      expect(await row(w.clinicId, w.id)).toMatchObject({ calendar_write_status: "written", calendar_write_attempts: 6 });
      expect(gets() - reads).toBe(1);
      expect(inserts() - writes).toBe(1);
      // The sweep still never goes past five.
      await set(w.clinicId, w.id, `calendar_write_status = 'unknown', calendar_write_next_at = null`);
      expect(await sweepDeskWrites({ now: new Date(Date.now() + HOUR) })).toMatchObject({ attempted: 0 });
    },
    60_000,
  );

  test(
    "an operator's retry that tries nothing says so, never 'retried'",
    async () => {
      const f = await deskLocation(google, "operator-noop");
      const r = await phoneRequest(f.clinicId);
      const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(4, 9) });
      expect(decided.calendarWrite).toBe("written");
      const before = inserts();
      const res = await runOperation("retryCalendarWrite", { clinicId: f.clinicId, appointmentId: decided.appointmentId }, OPERATOR);
      expect((res.body as { data: Record<string, unknown> }).data).toEqual({
        status: "error",
        message: "That booking is already in the clinic's Google Calendar. Nothing was tried.",
      });
      expect(inserts()).toBe(before);
      // The press is recorded all the same, with why nothing was tried.
      expect(await retriedEvents(decided.appointmentId!)).toEqual([
        expect.objectContaining({ outcome: "written", attempted: false, cause: "written" }),
      ]);
    },
    60_000,
  );

  test(
    "an operator's retry at no recorded attempt still reads Google back before it inserts: Google may hold the booking",
    async () => {
      const w = await unknownWrite("operator-zero");
      // Failed with nothing counted (as a write with no healthy calendar is), then the calendar came back.
      await set(w.clinicId, w.id, `calendar_write_status = 'failed', calendar_write_error = 'calendar_not_connected', calendar_write_attempts = 0`);
      const reads = gets();
      const writes = inserts();
      const res = await runOperation("retryCalendarWrite", { clinicId: w.clinicId, appointmentId: w.id }, OPERATOR);
      expect((res.body as { data: Record<string, unknown> }).data).toMatchObject({ status: "retried", outcome: "written" });
      expect(await row(w.clinicId, w.id)).toMatchObject({ calendar_write_status: "written", calendar_write_attempts: 1 });
      expect(gets() - reads).toBe(1);
      expect(inserts() - writes).toBe(1);
    },
    60_000,
  );

  test(
    "an operator's retry that finds another attempt in flight names that cause, and the press is recorded",
    async () => {
      const w = await unknownWrite("operator-in-flight");
      await set(
        w.clinicId,
        w.id,
        `calendar_write_status = 'writing', calendar_write_lease = gen_random_uuid(), calendar_write_claimed_at = now()`,
      );
      const writes = inserts();
      const res = await runOperation("retryCalendarWrite", { clinicId: w.clinicId, appointmentId: w.id }, OPERATOR);
      expect((res.body as { data: Record<string, unknown> }).data).toEqual({
        status: "error",
        message: "Another attempt at this write is in flight. Nothing was tried; reload in a few minutes.",
      });
      expect(inserts()).toBe(writes);
      expect(await retriedEvents(w.id)).toEqual([
        expect.objectContaining({ outcome: "unknown", attempted: false, cause: "in_flight" }),
      ]);
    },
    60_000,
  );

  test(
    "a claim stuck writing with a settled reason is never listed, so it takes none of the run's places",
    async () => {
      const stuck = await unknownWrite("stuck-settled", 4, 9);
      await set(
        stuck.clinicId,
        stuck.id,
        `calendar_write_status = 'writing', calendar_write_lease = gen_random_uuid(), calendar_write_error = 'deleted_in_calendar',
         calendar_write_claimed_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'`,
      );
      // Another write at the same location, due, listed after the stuck one by age.
      const r = await phoneRequest(stuck.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const due = (
        await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(4, 15) })
      ).appointmentId!;
      for (let run = 0; run < 2; run += 1) {
        const result = await sweepDeskWrites({ limit: 1, now: new Date(Date.now() + 3 * MIN) });
        expect(result.attempted).toBeLessThanOrEqual(1);
        if (run === 0) expect(result).toMatchObject({ attempted: 1, written: 1 });
        else expect(result).toMatchObject({ attempted: 0 });
      }
      expect((await row(stuck.clinicId, due)).calendar_write_status).toBe("written");
      expect((await row(stuck.clinicId, stuck.id)).calendar_write_status).toBe("writing");
    },
    60_000,
  );
});
