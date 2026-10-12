import {
  FAKE_GOOGLE_CLIENT,
  googleCalendarAdapter,
  googleEventIdFor,
  HEALDESK_EVENT_MARKER,
  setGoogleFetch,
  setGoogleTimeouts,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { availableSlotsFor, deskSpanFree } from "@/lib/booking/availability";
import { sweepDeskWrites, writeToCalendar } from "@/lib/booking/calendar";
import { holdSpan } from "@/lib/booking/holds";
import { decideBookingRequest, resolveBookingRequest } from "@/lib/meta/booking-requests";

import { asApp, sha256Hex } from "./setup/calendar-db";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  assistantHold,
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
  type DeskLocation,
} from "./setup/desk-calendar";
import { inTenant, seedGoogleConnection } from "./setup/factories";

/**
 * The desk path against Google (plan §7.10-7.12, C12) and migration B
 * (drizzle/0059): staff confirming a request on a location whose calendar
 * terms let healdesk write, with the assistant's own holds in the way or
 * not, Google busy or not, and the write that follows. Every Google call
 * goes to the in-memory fake.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 90_000;
const MIN = 60_000;

function codeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describeDb("the desk path and the Google write (C12)", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
  });

  afterEach(() => setGoogleTimeouts(undefined));

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  const confirm = (
    token: string,
    at: Date,
    extra: { addAnyway?: boolean; treatment?: string } = {},
  ) =>
    decideBookingRequest(token, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: at,
      ...extra,
    });
  const inserts = () => google.requests.filter((r) => r.endpoint === "insert");
  const appointments = (clinicId: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{
            id: string;
            calendar_write_status: string;
            calendar_write_error: string | null;
            calendar_event_key: string | null;
            calendar_id: string | null;
            booking_origin: string | null;
            scheduled_for: Date;
          }>(
            `select id, calendar_write_status, calendar_write_error, calendar_event_key, calendar_id,
                  booking_origin, scheduled_for
             from appointments order by created_at`,
          )
        ).rows,
    );
  const holdStatus = (clinicId: string, id: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{
            status: string;
            outcome_reason: string | null;
            appointment_id: string | null;
          }>(`select status, outcome_reason, appointment_id from slot_holds where id = $1`, [id])
        ).rows[0]!,
    );

  const rejections = (clinicId: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{ reason: string; decision: string }>(
            `select metadata->>'reason' as reason, metadata->>'decision' as decision
               from audit_log
              where resource_type = 'booking_request' and action = 'update' and metadata->>'outcome' = 'rejected'
              order by occurred_at, id`,
          )
        ).rows,
    );
  const connectionBroken = (clinicId: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{ broken: boolean }>(
            `select broken_at is not null as broken from provider_connections where provider = 'google_calendar'`,
          )
        ).rows[0]?.broken === true,
    );

  /** A named provider on `calendarId` who offers `serviceKey`, with the location booking by provider. */
  const namedProvider = (clinicId: string, calendarId: string, serviceKey: string) =>
    inTenant(clinicId, async (client) => {
      await client.query(
        `insert into clinic_settings (clinic_id, booking_detail) values ($1, 'named_provider')
         on conflict (clinic_id) do update set booking_detail = 'named_provider'`,
        [clinicId],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, $2, $3) returning id`,
        [clinicId, `Dr ${calendarId.slice(0, 3)}`, calendarId],
      );
      await client.query(
        `insert into clinic_provider_services (clinic_id, provider_id, service_key) values ($1, $2, $3)`,
        [clinicId, rows[0]!.id, serviceKey],
      );
      return rows[0]!.id;
    });

  /** Until a session waits on a lock, for ten seconds at most. */
  async function untilSomeoneWaitsOnALock(): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      const { rows } = await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from pg_locks where not granted`,
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Nothing waited on a lock.");
  }

  /* ------------------------------------------------------- the hold guard */

  test(
    "checking while the assistant's write is in flight or within its grace, for every decision",
    async () => {
      const f = await deskLocation(google, "desk-checking");
      const r = await phoneRequest(f.clinicId);
      const at = deskTime(4, 10);
      await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: at,
        status: "writing",
      });
      const base = { decidedByLabel: "Jo", deskNote: null };
      expect((await confirm(r.token, at)).outcome).toBe("checking");
      expect((await decideBookingRequest(r.token, "accepted", base)).outcome).toBe("checking");
      expect((await decideBookingRequest(r.token, "declined", base)).outcome).toBe("checking");
      expect(
        (
          await decideBookingRequest(r.token, "rescheduling", {
            ...base,
            proposedSlots: [{ at: deskTime(5, 10) }],
          })
        ).outcome,
      ).toBe("checking");

      const u = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: u.requestId,
        contactId: u.contactId,
        startsAt: deskTime(4, 12),
        status: "unknown",
        attemptedSecondsAgo: 30,
      });
      expect((await decideBookingRequest(u.token, "declined", base)).outcome).toBe("checking");
      expect(await appointments(f.clinicId)).toEqual([]);
      expect(inserts()).toHaveLength(0);
      // Every refusal is on the record, as a decision's own refusal always was.
      expect(await rejections(f.clinicId)).toEqual([
        { reason: "checking", decision: "confirmed" },
        { reason: "checking", decision: "accepted" },
        { reason: "checking", decision: "declined" },
        { reason: "checking", decision: "rescheduling" },
        { reason: "checking", decision: "declined" },
      ]);
    },
    SLOW,
  );

  test(
    "an unknown write past its grace is read back: found, the assistant's booking stands (already_in_calendar); gone, the desk confirms under the hold's key",
    async () => {
      const f = await deskLocation(google, "desk-readback");
      const found = await phoneRequest(f.clinicId);
      const at = deskTime(4, 9);
      const holdId = await assistantHold(f.clinicId, {
        requestId: found.requestId,
        contactId: found.contactId,
        startsAt: at,
        status: "unknown",
        attemptedSecondsAgo: 300,
      });
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${holdId}`),
        start: at,
        end: new Date(at.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      const stands = await confirm(found.token, deskTime(4, 15));
      expect(stands).toMatchObject({
        outcome: "already_in_calendar",
        calendarWrite: "written",
        bookedFor: at,
      });
      expect(await holdStatus(f.clinicId, holdId)).toMatchObject({
        status: "converted",
        appointment_id: stands.appointmentId,
      });
      expect(await resolveBookingRequest(found.token)).toMatchObject({
        status: "confirmed",
        decidedByLabel: "assistant (calendar write confirmed after the call)",
        confirmedFor: at,
      });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        booking_origin: "assistant",
        calendar_write_status: "written",
        calendar_event_key: `hold:${holdId}`,
      });

      const gone = await phoneRequest(f.clinicId);
      const goneAt = deskTime(4, 11);
      const goneHold = await assistantHold(f.clinicId, {
        requestId: gone.requestId,
        contactId: gone.contactId,
        startsAt: goneAt,
        status: "unknown",
        attemptedSecondsAgo: 300,
      });
      const decided = await confirm(gone.token, goneAt);
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "written" });
      expect(await holdStatus(f.clinicId, goneHold)).toMatchObject({
        status: "released",
        outcome_reason: "desk_decided",
      });
      const row = (await appointments(f.clinicId)).find((a) => a.id === decided.appointmentId)!;
      expect(row).toMatchObject({ booking_origin: "desk", calendar_event_key: `hold:${goneHold}` });
      expect(google.event(f.sub, googleEventIdFor(`hold:${goneHold}`))).toBeDefined();
    },
    SLOW,
  );

  test(
    "an assistant insert that hangs and lands after the desk confirms yields one event",
    async () => {
      const f = await deskLocation(google, "desk-hang");
      const r = await phoneRequest(f.clinicId);
      const at = deskTime(4, 13);
      const holdId = await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: at,
        status: "unknown",
        attemptedSecondsAgo: 300,
      });
      // The assistant's insert, Google stores it only after the caller gave up.
      const late = google.insertThenHang({ land: "later" });
      setGoogleTimeouts({ insert: 100 });
      const context = {
        clinicId: f.clinicId,
        connectionId: f.connectionId!,
        credentials: { refresh_token: f.refreshToken },
        metadata: { calendarId: "primary" },
        oauthClient: FAKE_GOOGLE_CLIENT,
      };
      const hung = await googleCalendarAdapter.createAppointment(context, {
        startsAt: at,
        durationMinutes: 30,
        attendee: { name: "Synthetic", timeZone: "America/New_York" },
        origin: "assistant",
        service: "Consultation",
        idempotencyKey: `hold:${holdId}`,
      });
      expect(hung.ok).toBe(false);
      setGoogleTimeouts(undefined);

      const decided = await confirm(r.token, at);
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "written" });
      late.land();
      expect(google.events(f.sub).filter((e) => e.status !== "cancelled")).toHaveLength(1);
    },
    SLOW,
  );

  /* ------------------------------------------------------ Google re-check */

  test(
    "Google busy is calendar_busy until staff confirm anyway; an off-grid, out-of-hours time Google shows free is fine",
    async () => {
      const f = await deskLocation(google, "desk-busy");
      const r = await phoneRequest(f.clinicId);
      const at = deskTime(4, 10);
      google.addBusy(f.sub, at, new Date(at.getTime() + 60 * MIN));
      expect(await confirm(r.token, at)).toMatchObject({
        outcome: "calendar_busy",
        appointmentId: null,
      });
      expect(await appointments(f.clinicId)).toEqual([]);
      expect(await rejections(f.clinicId)).toEqual([
        { reason: "calendar_busy", decision: "confirmed" },
      ]);
      const anyway = await confirm(r.token, at, { addAnyway: true });
      expect(anyway).toMatchObject({ outcome: "decided", calendarWrite: "written" });
      // A second confirmation of a decided request is refused, and recorded.
      expect((await confirm(r.token, at)).outcome).toBe("already-decided");
      expect((await rejections(f.clinicId)).at(-1)).toEqual({
        reason: "already-decided",
        decision: "confirmed",
      });
      const audit = await inTenant(f.clinicId, (client) =>
        client.query(
          `select 1 from audit_log where resource_type = 'booking_request' and metadata->>'outcome' = 'confirmed_over_busy'`,
        ),
      );
      expect(audit.rows).toHaveLength(1);

      const late = await phoneRequest(f.clinicId);
      const offGrid = deskTime(5, 22, 7); // 22:07, after closing, off the quarter-hours
      expect(await confirm(late.token, offGrid)).toMatchObject({
        outcome: "decided",
        calendarWrite: "written",
      });
      expect(
        await deskSpanFree(f.clinicId, {
          startsAt: deskTime(6, 6, 3),
          durationMinutes: 30,
          service: null,
        }),
      ).toMatchObject({ status: "free", calendarId: "primary" });
    },
    SLOW,
  );

  /* ------------------------------------------------------- the decision */

  test(
    "overlapping confirmations: both stand where nothing is written; the second is slot_taken where healdesk writes, and a live call holding it says so",
    async () => {
      const manual = await deskLocation(google, "desk-notused", { bookingSystem: "mindbody" });
      const at = deskTime(4, 10);
      const a = await phoneRequest(manual.clinicId);
      const b = await phoneRequest(manual.clinicId);
      expect((await confirm(a.token, at)).outcome).toBe("decided");
      expect((await confirm(b.token, at)).outcome).toBe("decided");
      expect((await appointments(manual.clinicId)).map((x) => x.booking_origin)).toEqual([
        null,
        null,
      ]);

      const covered = await deskLocation(google, "desk-covered");
      const c = await phoneRequest(covered.clinicId);
      const d = await phoneRequest(covered.clinicId);
      expect((await confirm(c.token, at)).outcome).toBe("decided");
      // Google now shows the first booking busy; staff confirm anyway, and healdesk's own guard still refuses.
      expect(await confirm(d.token, at, { addAnyway: true })).toMatchObject({
        outcome: "slot_taken",
        takenBy: "booking",
      });
      expect(await resolveBookingRequest(d.token)).toMatchObject({ status: "requested" });

      const e = await phoneRequest(covered.clinicId);
      const held = deskTime(4, 15);
      expect(
        await holdSpan(covered.clinicId, {
          channel: "voice",
          holderKey: "voice:live",
          calendarId: "primary",
          startsAt: held,
          minutes: 30,
        }),
      ).toMatchObject({ kind: "held" });
      expect(await confirm(e.token, held)).toMatchObject({
        outcome: "slot_taken",
        takenBy: "live_call",
      });
    },
    SLOW,
  );

  test(
    "two confirmations of one request at once: one decides, the other is already-decided, never slot_taken",
    async () => {
      const f = await deskLocation(google, "desk-race");
      const r = await phoneRequest(f.clinicId);
      const at = deskTime(4, 16);
      const outcomes = (await Promise.all([confirm(r.token, at), confirm(r.token, at)]))
        .map((o) => o.outcome)
        .sort();
      expect(outcomes).toEqual(["already-decided", "decided"]);
      expect(await appointments(f.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a deposit reservation over exactly the confirmed span becomes the booking; any other hold of the request is released",
    async () => {
      const f = await deskLocation(google, "desk-reserved");
      const r = await phoneRequest(f.clinicId);
      const at = deskTime(4, 12);
      const reserved = await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: at,
        status: "reserved",
      });
      const decided = await confirm(r.token, at);
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "written" });
      expect(await holdStatus(f.clinicId, reserved)).toMatchObject({
        status: "converted",
        appointment_id: decided.appointmentId,
      });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_event_key: `hold:${reserved}`,
      });
    },
    SLOW,
  );

  /* ------------------------------------------------------------ the write */

  test(
    "no healthy calendar under terms that write: failed, calendar_not_connected, and never written later on its own",
    async () => {
      const f = await deskLocation(google, "desk-noconn", { connect: false });
      const r = await phoneRequest(f.clinicId);
      const decided = await confirm(r.token, deskTime(4, 10));
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "failed" });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "calendar_not_connected",
        booking_origin: "desk",
        calendar_id: "primary",
      });
      await seedGoogleConnection(f.clinicId, { refreshToken: f.refreshToken });
      await sweepDeskWrites();
      expect(inserts()).toHaveLength(0);
      expect((await appointments(f.clinicId))[0]!.calendar_write_status).toBe("failed");
    },
    SLOW,
  );

  test(
    "a 409 under our key at another time is event_id_taken: never moved, never doubled",
    async () => {
      const f = await deskLocation(google, "desk-409");
      const r = await phoneRequest(f.clinicId);
      const heldAt = deskTime(4, 9);
      const reserved = await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: heldAt,
        status: "reserved",
      });
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${reserved}`),
        start: heldAt,
        end: new Date(heldAt.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      const decided = await confirm(r.token, deskTime(4, 14));
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "failed" });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "event_id_taken",
      });
      expect(google.events(f.sub)).toHaveLength(1);
      expect(await resolveBookingRequest(r.token)).toMatchObject({ heldFor: heldAt });
    },
    SLOW,
  );

  test(
    "a stuck claim is taken over after two minutes and read back first; a fresh one is not; five attempts at most",
    async () => {
      const f = await deskLocation(google, "desk-stuck");
      const r = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const decided = await confirm(r.token, deskTime(4, 10));
      expect(decided.calendarWrite).toBe("unknown");
      const id = decided.appointmentId!;

      // Claimed a moment ago by a writer still running: left alone.
      await inTenant(f.clinicId, (client) =>
        client.query(
          `update appointments set calendar_write_status = 'writing', calendar_write_lease = gen_random_uuid(), calendar_write_claimed_at = null, updated_at = now() where id = $1`,
          [id],
        ),
      );
      expect(await writeToCalendar(f.clinicId, id)).toBe("unknown");
      // Claimed before the claim stamp existed and stuck for three minutes: taken over, read back first.
      await inTenant(f.clinicId, (client) =>
        client.query(
          `update appointments set updated_at = now() - interval '3 minutes' where id = $1`,
          [id],
        ),
      );
      const before = google.requests.length;
      expect(await writeToCalendar(f.clinicId, id)).toBe("written");
      expect(
        google.requests
          .slice(before)
          .map((q) => q.endpoint)
          .filter((e) => e === "get" || e === "insert"),
      ).toEqual(["get", "insert"]);

      const capped = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const c = await confirm(capped.token, deskTime(4, 12));
      await inTenant(f.clinicId, (client) =>
        client.query(`update appointments set calendar_write_attempts = 5 where id = $1`, [
          c.appointmentId,
        ]),
      );
      const writes = inserts().length;
      expect(await writeToCalendar(f.clinicId, c.appointmentId!)).toBe("unknown");
      expect(inserts()).toHaveLength(writes);
    },
    SLOW,
  );

  test(
    "the desk sweep retries unsettled writes from the last day, oldest first and at most its limit, and never a failed one",
    async () => {
      const f = await deskLocation(google, "desk-sweep");
      const ids: string[] = [];
      for (const hour of [9, 10, 11]) {
        const r = await phoneRequest(f.clinicId);
        google.failNext({ on: "insert", status: 503, reason: "backendError" });
        ids.push((await confirm(r.token, deskTime(4, hour))).appointmentId!);
      }
      const old = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 400, reason: "badRequest" });
      await confirm(old.token, deskTime(4, 15));

      const first = await sweepDeskWrites({ limit: 2 });
      expect(first).toMatchObject({ attempted: 2, written: 2, errors: 0 });
      const second = await sweepDeskWrites();
      expect(second).toMatchObject({ attempted: 1, written: 1 });
      const rows = await appointments(f.clinicId);
      expect(
        rows.filter((x) => ids.includes(x.id)).every((x) => x.calendar_write_status === "written"),
      ).toBe(true);
      expect(rows.find((x) => !ids.includes(x.id))!.calendar_write_status).toBe("failed");
      expect(await sweepDeskWrites()).toMatchObject({ attempted: 0 });
    },
    SLOW,
  );

  test(
    "Google gets the service only as the clinic's list names it: free text, typed or said, is written as Appointment",
    async () => {
      const f = await deskLocation(google, "desk-service");
      const said = await phoneRequest(f.clinicId, { service: "lip filler after my surgery" });
      expect(await confirm(said.token, deskTime(4, 9))).toMatchObject({ calendarWrite: "written" });
      const typed = await phoneRequest(f.clinicId);
      expect(
        await confirm(typed.token, deskTime(4, 11), { treatment: "Botox for migraines" }),
      ).toMatchObject({ calendarWrite: "written" });
      const listed = await phoneRequest(f.clinicId, { service: "facial" });
      expect(await confirm(listed.token, deskTime(4, 13))).toMatchObject({
        calendarWrite: "written",
      });
      expect(inserts().map((q) => (q.json as { summary: string }).summary)).toEqual([
        "Synthetic – Appointment",
        "Synthetic – Appointment",
        "Synthetic – Facial",
      ]);
      expect(JSON.stringify(inserts().map((q) => q.json))).not.toMatch(/filler|surgery|migraine/i);
    },
    SLOW,
  );

  test(
    "a read-back that finds our key at another time is event_id_taken, on a retry and on the ops retry alike; never adopted",
    async () => {
      const f = await deskLocation(google, "desk-readback-span");
      const r = await phoneRequest(f.clinicId);
      const heldAt = deskTime(4, 9);
      const reserved = await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: heldAt,
        status: "reserved",
      });
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const decided = await confirm(r.token, deskTime(4, 14));
      expect(decided.calendarWrite).toBe("unknown");
      // The assistant's booking for this request reaches Google under the hold's key, at its own time.
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${reserved}`),
        start: heldAt,
        end: new Date(heldAt.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      const external = () =>
        inTenant(
          f.clinicId,
          async (client) =>
            (
              await client.query<{ external_appointment_id: string | null }>(
                `select external_appointment_id from appointments where id = $1`,
                [decided.appointmentId],
              )
            ).rows[0]!.external_appointment_id,
        );
      expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("failed");
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "event_id_taken",
      });
      expect(await external()).toBeNull();
      // The ops retry reads back first too, and finds the same: still not this booking.
      expect(await writeToCalendar(f.clinicId, decided.appointmentId!, { fromFailed: true })).toBe(
        "failed",
      );
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "event_id_taken",
      });
      expect(await external()).toBeNull();
      expect(google.events(f.sub)).toHaveLength(1);
      expect(inserts()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a retry whose read-back Google fails to answer stays unknown, never failed, so the booking is not added twice by hand",
    async () => {
      const f = await deskLocation(google, "desk-readback-503");
      const r = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const decided = await confirm(r.token, deskTime(4, 10));
      expect(decided.calendarWrite).toBe("unknown");
      google.failNext({ on: "get", status: 503, reason: "backendError" });
      expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("unknown");
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "unknown",
      });
      // The next attempt reads back again, finds nothing, and writes it once.
      expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("written");
      expect(google.events(f.sub)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a calendar Google will no longer list for the account breaks the connection at the write, and the desk adds it by hand",
    async () => {
      const f = await deskLocation(google, "desk-target-break");
      const lee = google.addCalendar(f.sub, {
        summary: "Dr Lee",
        id: "lee-target@group.calendar.fake.test",
      });
      await namedProvider(f.clinicId, lee, "facial");
      const r = await phoneRequest(f.clinicId, { service: "Facial" });
      google.failNext({ on: "calendarList", status: 403, reason: "forbidden" });
      const decided = await confirm(r.token, deskTime(4, 10));
      expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "failed" });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "insufficient_permissions",
        calendar_id: lee,
      });
      expect(await connectionBroken(f.clinicId)).toBe(true);
      expect(inserts()).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "the guard refusing the claim (the connection broke in between) records failed / calendar_not_connected, not a silent none",
    async () => {
      const f = await deskLocation(google, "desk-guard-race");
      const r = await phoneRequest(f.clinicId);
      google.failNext({ on: "insert", status: 503, reason: "backendError" });
      const decided = await confirm(r.token, deskTime(4, 10));
      expect(decided.calendarWrite).toBe("unknown");
      const id = decided.appointmentId!;

      // A colleague's transaction holds the appointment and breaks the
      // connection; the writer reads the connection healthy, then waits on
      // the row, and its claim is judged after that commit.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const colleague = inTenant(f.clinicId, async (client) => {
        await client.query(`select 1 from appointments where id = $1 for update`, [id]);
        await client.query(
          `update provider_connections set status = 'error', broken_at = now() where provider = 'google_calendar'`,
        );
        locked();
        await gate;
      });
      await holding;
      const writing = writeToCalendar(f.clinicId, id);
      await untilSomeoneWaitsOnALock();
      release();
      await colleague;
      expect(await writing).toBe("failed");
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_write_status: "failed",
        calendar_write_error: "calendar_not_connected",
      });
      expect(inserts()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "an assistant event found late whose time was taken meanwhile is let go (record_conflict), and the desk still decides",
    async () => {
      const f = await deskLocation(google, "desk-record-conflict");
      const first = await phoneRequest(f.clinicId);
      const at = deskTime(4, 9);
      // The assistant's hold for the first request: written, unknown, its block lapsed.
      const holdId = await inTenant(f.clinicId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at, contact_id)
           values ($1, 'voice', repeat('c', 64), 'primary', $2::timestamptz, 30, $2::timestamptz + interval '30 minutes', $3)
           returning id`,
          [f.clinicId, at, first.contactId],
        );
        const id = rows[0]!.id;
        await client.query(
          `update slot_holds set status = 'writing', booking_request_id = $2, lease_token = gen_random_uuid(),
                  lease_until = clock_timestamp() + interval '30 seconds',
                  insert_attempted_at = clock_timestamp() - interval '20 minutes',
                  blocks_until = clock_timestamp() - interval '1 minute', updated_at = now()
            where id = $1`,
          [id, first.requestId],
        );
        await client.query(
          `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() + interval '2 minutes' where id = $1`,
          [id],
        );
        return id;
      });
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${holdId}`),
        start: at,
        end: new Date(at.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      // Meanwhile staff confirmed someone else at that time.
      const second = await phoneRequest(f.clinicId);
      expect((await confirm(second.token, at, { addAnyway: true })).outcome).toBe("decided");

      const base = { decidedByLabel: "Jo", deskNote: null };
      expect((await decideBookingRequest(first.token, "declined", base)).outcome).toBe("decided");
      expect(await holdStatus(f.clinicId, holdId)).toMatchObject({
        status: "released",
        outcome_reason: "record_conflict",
        appointment_id: null,
      });
      expect(await appointments(f.clinicId)).toHaveLength(1);
      const released = await inTenant(f.clinicId, (client) =>
        client.query(
          `select 1 from audit_log where resource_type = 'slot_hold' and resource_id = $1 and metadata->>'reason' = 'record_conflict'`,
          [holdId],
        ),
      );
      expect(released.rows).toHaveLength(1);
      // Nothing was deleted from the calendar.
      expect(google.event(f.sub, googleEventIdFor(`hold:${holdId}`))).toBeDefined();
    },
    SLOW,
  );

  test(
    "a read-back the grant refuses breaks the connection and lets the desk decide; an event under our id that is not ours does too",
    async () => {
      const f = await deskLocation(google, "desk-readback-break");
      const r = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: deskTime(4, 9),
        status: "unknown",
        attemptedSecondsAgo: 300,
      });
      google.revokeRefreshToken(f.refreshToken);
      const base = { decidedByLabel: "Jo", deskNote: null };
      expect((await decideBookingRequest(r.token, "declined", base)).outcome).toBe("decided");
      expect(await connectionBroken(f.clinicId)).toBe(true);

      const g = await deskLocation(google, "desk-readback-notours");
      const n = await phoneRequest(g.clinicId);
      const at = deskTime(4, 11);
      const holdId = await assistantHold(g.clinicId, {
        requestId: n.requestId,
        contactId: n.contactId,
        startsAt: at,
        status: "unknown",
        attemptedSecondsAgo: 300,
      });
      google.addEvent(g.sub, {
        id: googleEventIdFor(`hold:${holdId}`),
        start: at,
        end: new Date(at.getTime() + 30 * MIN),
      });
      expect((await decideBookingRequest(n.token, "declined", base)).outcome).toBe("decided");
      expect(await connectionBroken(g.clinicId)).toBe(false);
    },
    SLOW,
  );

  test(
    "named providers: where the assistant held time on one provider's calendar, the desk's booking goes on that calendar under the hold's key, so a late insert meets it there",
    async () => {
      const f = await deskLocation(google, "desk-provider-pin");
      const lee = google.addCalendar(f.sub, {
        summary: "Dr Lee",
        id: "lee-pin@group.calendar.fake.test",
      });
      const kim = google.addCalendar(f.sub, {
        summary: "Dr Kim",
        id: "kim-pin@group.calendar.fake.test",
      });
      await namedProvider(f.clinicId, lee, "facial");
      await namedProvider(f.clinicId, kim, "facial");
      const r = await phoneRequest(f.clinicId, { service: "Facial" });
      const at = deskTime(4, 10);
      const holdId = await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: at,
        minutes: 60,
        status: "unknown",
        attemptedSecondsAgo: 300,
        calendarId: kim,
      });
      expect(await confirm(r.token, at)).toMatchObject({
        outcome: "decided",
        calendarWrite: "written",
      });
      expect((await appointments(f.clinicId))[0]).toMatchObject({
        calendar_id: kim,
        calendar_event_key: `hold:${holdId}`,
      });
      // The assistant's hung insert lands on Kim's calendar under the same id: one event.
      google.addEvent(f.sub, {
        calendarId: kim,
        id: googleEventIdFor(`hold:${holdId}`),
        start: at,
        end: new Date(at.getTime() + 60 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      expect(google.events(f.sub, kim)).toHaveLength(1);
      expect(google.events(f.sub, lee)).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "the desk page lists a time the assistant reserved for this request, and not one it reserved for another",
    async () => {
      const f = await deskLocation(google, "desk-own-hold");
      const r = await phoneRequest(f.clinicId);
      const other = await phoneRequest(f.clinicId);
      const at = deskTime(1, 8);
      await assistantHold(f.clinicId, {
        requestId: r.requestId,
        contactId: r.contactId,
        startsAt: at,
        status: "reserved",
      });
      const own = await resolveBookingRequest(r.token);
      expect(own!.calendar!.slots.map((s) => s.at)).toContain(at.toISOString());
      const theirs = await resolveBookingRequest(other.token);
      expect(theirs!.calendar!.writable).toBe(true);
      expect(theirs!.calendar!.slots.map((s) => s.at)).not.toContain(at.toISOString());
    },
    SLOW,
  );

  test(
    "the desk page asks Google only after its own transaction has committed",
    async () => {
      const f = await deskLocation(google, "desk-no-slots-in-tx");
      const r = await phoneRequest(f.clinicId);
      const seen: boolean[] = [];
      const real = google.fetch;
      setGoogleFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input instanceof Request ? input.url : input).includes("freeBusy")) {
          // The page's open is audited in its transaction; it is visible from
          // another connection only once that transaction has committed.
          const opened = await inTenant(f.clinicId, (client) =>
            client.query(
              `select 1 from audit_log where resource_type = 'booking_request' and resource_id = $1 and metadata->>'outcome' = 'opened'`,
              [r.requestId],
            ),
          );
          seen.push(opened.rows.length === 1);
        }
        return real(input, init);
      }) as typeof fetch);
      const page = await resolveBookingRequest(r.token);
      expect(page!.calendar!.slots.length).toBeGreaterThan(0);
      expect(seen).toEqual([true]);
    },
    SLOW,
  );

  /* ------------------------------------------------------- availability */

  test(
    "availability: unknown hours are no times, not a throw; closed days and healdesk's holds are left out; Google failing leaves the page usable",
    async () => {
      const f = await deskLocation(google, "desk-avail");
      const ok = await availableSlotsFor(f.clinicId, { days: 3 });
      expect(ok.status).toBe("ok");
      const day3 = deskTime(3, 12).toISOString().slice(0, 10);
      if (ok.status !== "ok") throw new Error("no slots");
      const someSlot = ok.slots.find((s) => s.at.getTime() > Date.now() + 26 * 60 * MIN)!;

      // A hold another holder has on that time takes it off the list.
      expect(
        await holdSpan(f.clinicId, {
          channel: "voice",
          holderKey: "voice:other",
          calendarId: "primary",
          startsAt: someSlot.at,
          minutes: 30,
        }),
      ).toMatchObject({ kind: "held" });
      const held = await availableSlotsFor(f.clinicId, { days: 3 });
      expect(
        held.status === "ok" && held.slots.some((s) => s.at.getTime() === someSlot.at.getTime()),
      ).toBe(false);
      // …but not off its own holder's.
      const mine = await availableSlotsFor(f.clinicId, {
        days: 3,
        holderRef: sha256Hex("voice:other"),
      });
      expect(
        mine.status === "ok" && mine.slots.some((s) => s.at.getTime() === someSlot.at.getTime()),
      ).toBe(true);

      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_closures (clinic_id, closed_on, label) values ($1, $2, 'Training day')`,
          [
            f.clinicId,
            new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
              deskTime(2, 12),
            ),
          ],
        ),
      );
      const closed = await availableSlotsFor(f.clinicId, { days: 3 });
      const closedDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
        deskTime(2, 12),
      );
      expect(
        closed.status === "ok" &&
          closed.slots.every(
            (s) =>
              new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(s.at) !==
              closedDay,
          ),
      ).toBe(true);
      expect(day3).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      await getMigratorPool().query(`update clinics set opening_hours = null where id = $1`, [
        f.clinicId,
      ]);
      expect(await availableSlotsFor(f.clinicId)).toEqual({
        status: "unavailable",
        reason: "opening_hours_unknown",
      });
      await getMigratorPool().query(
        `update clinics set opening_hours = '{"mon": "nine to five"}'::jsonb where id = $1`,
        [f.clinicId],
      );
      expect(await availableSlotsFor(f.clinicId)).toEqual({
        status: "unavailable",
        reason: "opening_hours_unknown",
      });

      const g = await deskLocation(google, "desk-avail-down");
      const r = await phoneRequest(g.clinicId);
      google.failNext({ on: "freeBusy", status: 503, reason: "backendError" });
      expect(await resolveBookingRequest(r.token)).toMatchObject({
        status: "requested",
        calendar: { writable: true, slots: [] },
      });
    },
    SLOW,
  );

  test(
    "named providers: a service a provider offers is offered and booked on that provider's calendar, and two calendars do not block each other",
    async () => {
      const f: DeskLocation = await deskLocation(google, "desk-provider");
      const lee = google.addCalendar(f.sub, {
        summary: "Dr Lee",
        id: "lee@group.calendar.fake.test",
      });
      const leeId = await namedProvider(f.clinicId, lee, "facial");
      const at = deskTime(4, 10);
      google.addBusy(f.sub, at, new Date(at.getTime() + 60 * MIN)); // the shared calendar is busy then

      const offered = await availableSlotsFor(f.clinicId, { service: "Facial", days: 5 });
      expect(
        offered.status === "ok" &&
          offered.slots.every((s) => s.calendarId === lee && s.providerId !== null),
      ).toBe(true);
      expect(
        offered.status === "ok" && offered.slots.some((s) => s.at.getTime() === at.getTime()),
      ).toBe(true);
      // Asked for by name: her calendar for what she offers, and nobody's for what she does not.
      expect(
        await availableSlotsFor(f.clinicId, { service: "Facial", providerId: leeId, days: 2 }),
      ).toMatchObject({ status: "ok" });
      expect(
        await availableSlotsFor(f.clinicId, { service: "Consultation", providerId: leeId }),
      ).toEqual({ status: "unavailable", reason: "provider_unavailable" });

      const facial = await phoneRequest(f.clinicId, { service: "Facial" });
      expect(await confirm(facial.token, at)).toMatchObject({
        outcome: "decided",
        calendarWrite: "written",
      });
      expect(google.events(f.sub, lee)).toHaveLength(1);
      expect((await appointments(f.clinicId))[0]).toMatchObject({ calendar_id: lee });

      // The same time on the location's own calendar, for a service nobody is mapped to: not blocked by Dr Lee's.
      const consult = await phoneRequest(f.clinicId, { service: "Consultation" });
      expect(await confirm(consult.token, at, { addAnyway: true })).toMatchObject({
        outcome: "decided",
      });
      expect((await appointments(f.clinicId)).map((a) => a.calendar_id).sort()).toEqual(
        [lee, "primary"].sort(),
      );
    },
    SLOW,
  );

  /* ------------------------------------------------ migration B (0059) */

  test(
    "holds key on the clinic and the calendar; a booking naming no calendar blocks them all; a hold's calendar never moves",
    async () => {
      const f = await deskLocation(google, "migb-holds");
      const at = deskTime(5, 10);
      const hold = (holder: string, calendarId: string) =>
        holdSpan(f.clinicId, {
          channel: "voice",
          holderKey: holder,
          calendarId,
          startsAt: at,
          minutes: 30,
        });
      expect(await hold("voice:a", "primary")).toMatchObject({ kind: "held" });
      expect(await hold("voice:b", "primary")).toEqual({ kind: "slot_taken" });
      const other = await hold("voice:b", "lee@group.calendar.fake.test");
      expect(other).toMatchObject({ kind: "held" });
      // The same holder again: its earlier hold is superseded, not refused.
      expect(await hold("voice:a", "primary")).toMatchObject({ kind: "held" });

      if (other.kind !== "held") throw new Error("unreachable");
      await expect(
        asApp(f.clinicId, (c) =>
          c.query(`update slot_holds set calendar_id = 'primary' where id = $1`, [other.holdId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inTenant(f.clinicId, (c) =>
          c.query(`update slot_holds set calendar_id = 'primary' where id = $1`, [other.holdId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // A hold names its calendar: there is no default to fall back on.
      await expect(
        asApp(f.clinicId, (c) =>
          c.query(
            `insert into slot_holds (clinic_id, channel, holder_ref, starts_at, duration_minutes, ends_at)
             values ($1, 'voice', repeat('d', 64), $2::timestamptz, 30, $2::timestamptz + interval '30 minutes')`,
            [f.clinicId, deskTime(6, 10)],
          ),
        ),
      ).rejects.toMatchObject({ code: "23502", column: "calendar_id" });

      // A healdesk booking that names no calendar occupies every calendar.
      const r = await phoneRequest(f.clinicId);
      const later = deskTime(5, 14);
      await asApp(f.clinicId, (c) =>
        c.query(
          `insert into appointments (clinic_id, contact_id, scheduled_for, duration_minutes, booking_origin)
           values ($1, $2, $3, 30, 'desk')`,
          [f.clinicId, r.contactId, later],
        ),
      );
      expect(
        await holdSpan(f.clinicId, {
          channel: "voice",
          holderKey: "voice:c",
          calendarId: "lee@group.calendar.fake.test",
          startsAt: later,
          minutes: 30,
        }),
      ).toEqual({ kind: "slot_taken" });
    },
    SLOW,
  );

  test(
    "a desk write may start only where the terms still let healdesk write; the event key is written once and the calendar never changes",
    async () => {
      const f = await deskLocation(google, "migb-guard");
      const r = await phoneRequest(f.clinicId);
      const decided = await decideBookingRequest(r.token, "confirmed", {
        decidedByLabel: "Jo",
        deskNote: null,
        confirmedFor: deskTime(5, 9),
      });
      const id = decided.appointmentId!;
      const attempt = (sql: string) =>
        asApp(f.clinicId, (c) => c.query(sql, [id])).then(
          () => "ok",
          (error: unknown) => codeOf(error),
        );

      // A booking is never inserted with its write already started: the
      // write is claimed afterwards, where this guard can judge it.
      const born = (columns: string, values: string) =>
        asApp(f.clinicId, (c) =>
          c.query(
            `insert into appointments (clinic_id, contact_id, scheduled_for, duration_minutes${columns})
             values ($1, $2, $3, 30${values})`,
            [f.clinicId, r.contactId, deskTime(6, 15)],
          ),
        );
      await expect(born(", calendar_write_status", ", 'writing'")).rejects.toMatchObject({
        code: "23514",
        constraint: "appointments_write_claimed",
      });
      await expect(born(", calendar_write_lease", ", gen_random_uuid()")).rejects.toMatchObject({
        code: "23514",
        constraint: "appointments_write_claimed",
      });

      expect(
        await attempt(
          `update appointments set calendar_event_key = '${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}' where id = $1`,
        ),
      ).toBe("42501");
      expect(
        await attempt(
          `update appointments set calendar_id = 'other@group.calendar.fake.test' where id = $1`,
        ),
      ).toBe("42501");
      expect(
        await attempt(`update appointments set calendar_write_status = 'unknown' where id = $1`),
      ).toBe("ok");
      expect(
        await attempt(
          `update appointments set calendar_write_status = 'writing', calendar_write_lease = gen_random_uuid() where id = $1`,
        ),
      ).toBe("ok");

      // The connection breaks: no new write may start, from the app or the migrator.
      await inTenant(f.clinicId, (c) =>
        c.query(
          `update provider_connections set status = 'error', broken_at = now() where provider = 'google_calendar'`,
        ),
      );
      expect(
        await attempt(
          `update appointments set calendar_write_lease = gen_random_uuid() where id = $1`,
        ),
      ).toBe("23514");
      await expect(
        asApp(f.clinicId, (c) =>
          c.query(
            `update appointments set calendar_write_lease = gen_random_uuid() where id = $1`,
            [id],
          ),
        ),
      ).rejects.toMatchObject({ constraint: "appointments_write_permitted" });
      await expect(
        inTenant(f.clinicId, (c) =>
          c
            .query(`update appointments set calendar_write_status = 'unknown' where id = $1`, [id])
            .then(() =>
              c.query(`update appointments set calendar_write_status = 'writing' where id = $1`, [
                id,
              ]),
            ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
    SLOW,
  );
});
