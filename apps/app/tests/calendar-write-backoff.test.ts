import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setGoogleTimeouts, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  CALENDAR_WRITE_REASONS,
  MAX_WRITE_ATTEMPTS,
  NEVER_RETRIED_REASONS,
  nextWriteAttemptAt,
  sweepDeskWrites,
  WRITE_BACKOFF_MINUTES,
} from "@/lib/booking/calendar";
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
        expect(await sweepDeskWrites({ now: due })).toMatchObject({ attempted: 1, unknown: 1 });
        const after = await row(w.clinicId, w.id);
        expect(after.calendar_write_attempts).toBe(attempt);
        expect(after.calendar_write_next_at!.getTime()).toBe(due.getTime() + minutes * MIN);
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
      const a = await deskLocation(google, "ladder-fair-a");
      const ids: string[] = [];
      for (const hour of [9, 10, 11]) {
        const r = await phoneRequest(a.clinicId);
        google.failNext({ on: "insert", status: 503, reason: "backendError" });
        ids.push(
          (await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(5, hour) }))
            .appointmentId!,
        );
      }
      const b = await unknownWrite("ladder-fair-b", 5, 14);
      const result = await sweepDeskWrites({ limit: 2, now: new Date(Date.now() + 3 * MIN) });
      expect(result).toMatchObject({ attempted: 2, written: 2 });
      expect((await row(b.clinicId, b.id)).calendar_write_status).toBe("written");
    },
    60_000,
  );
});
