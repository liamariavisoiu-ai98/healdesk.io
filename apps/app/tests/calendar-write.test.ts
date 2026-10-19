import { googleEventIdFor, HEALDESK_EVENT_MARKER, type CanonicalSlot, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { arrangeSlots, namedWeekdays, slotLabel, writableConnection, writeToCalendar } from "@/lib/booking/calendar";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { deskDecide, deskView } from "./setup/desk";
import { deskLocation, deskTime, freshGoogle, installGoogleEnv, phoneRequest, restoreGoogleEnv } from "./setup/desk-calendar";
import { inTenant } from "./setup/factories";

/**
 * The desk path's calendar write (plan §7.12; design of 23 September 2026,
 * §B.3–B.4), against the in-memory Google: the one write target v1 has,
 * reached only where the location's calendar terms let healdesk write. The
 * event carries a first name, the service as the clinic's list names it and
 * the time, under an id derived from the booking, so a write Google has
 * seen is read back, never doubled.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const TZ = "America/New_York";

describe("slots, labelled and arranged for the desk", () => {
  test("a label is the clinic's own clock, day first", () => {
    // 2026-10-01T18:00Z is Thu 1 Oct, 2:00 PM in New York (EDT).
    expect(slotLabel(new Date("2026-10-01T18:00:00Z"), TZ)).toBe("Thu 1 Oct, 2:00 PM");
    expect(slotLabel(new Date("2026-10-01T18:00:00Z"), "Europe/London")).toBe("Thu 1 Oct, 7:00 PM");
  });

  test("the days the person named come first, each day is a spread, and the whole is capped at forty", () => {
    expect([...namedWeekdays(["Thursday after 4", "any weekday morning", "fri"])].sort()).toEqual([4, 5]);
    const now = new Date("2026-09-28T12:00:00Z"); // a Monday
    const slots: CanonicalSlot[] = [];
    for (let d = 1; d <= 14; d += 1) {
      for (let h = 9; h < 16; h += 1) {
        for (const m of [0, 30]) {
          const startsAt = new Date(Date.UTC(2026, 8, 28 + d, h + 4, m)); // wall clock 09:00–15:30 EDT
          slots.push({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) });
        }
      }
    }
    const arranged = arrangeSlots(slots, { timeZone: TZ, now, named: new Set([4]) });
    expect(arranged.length).toBeLessThanOrEqual(40);
    expect(arranged[0]!.label).toMatch(/^Thu /);
    expect(arranged.slice(0, 12).every((s) => s.label.startsWith("Thu "))).toBe(true);
    const perDay = new Map<string, number>();
    for (const s of arranged) perDay.set(s.label.slice(0, 10), (perDay.get(s.label.slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(6);
    // Only the future.
    expect(arrangeSlots(slots, { timeZone: TZ, now: new Date("2027-01-01T00:00:00Z"), named: new Set() })).toEqual([]);
  });
});

describeDb("the calendar write, against Google", () => {
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

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  const appointmentRow = (clinicId: string) =>
    inTenant(clinicId, async (client) =>
      (
        await client.query<{
          id: string;
          calendar_write_status: string;
          calendar_write_error: string | null;
          calendar_written_at: string | null;
          calendar_write_attempts: number;
          external_appointment_id: string | null;
          external_source: string | null;
          external_confirmed_at: string | null;
          booking_origin: string | null;
          duration_minutes: number | null;
          calendar_event_key: string | null;
          calendar_id: string | null;
        }>(
          `select id, calendar_write_status, calendar_write_error, calendar_written_at, calendar_write_attempts,
                  external_appointment_id, external_source, external_confirmed_at, booking_origin,
                  duration_minutes, calendar_event_key, calendar_id
             from appointments`,
        )
      ).rows,
    );
  const inserts = () => google.requests.filter((r) => r.endpoint === "insert");

  test("the target is the location's Google Calendar under terms that write; the page lists its free times, the named days first", async () => {
    const bare = await deskLocation(google, "cal-noconn", { connect: false });
    expect(await withTenant({ clinicId: bare.clinicId, actor: ACTOR }, (tx) => writableConnection(tx))).toBeNull();
    const manual = await deskLocation(google, "cal-manual", { bookingSystem: "mindbody" });
    expect(await withTenant({ clinicId: manual.clinicId, actor: ACTOR }, (tx) => writableConnection(tx))).toBeNull();
    const none = await phoneRequest(manual.clinicId);
    expect(await deskView(none.token)).toMatchObject({ calendar: null, alternativeWindows: ["Friday morning"], treatment: "Consultation" });

    const f = await deskLocation(google, "cal-list");
    const writable = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) => writableConnection(tx));
    expect(writable).toMatchObject({ connectionId: f.connectionId, provider: "google_calendar", phiBasis: "calendar_terms", calendarId: "primary" });
    const r = await phoneRequest(f.clinicId);
    const opened = await deskView(r.token);
    expect(opened).toMatchObject({ calendar: { writable: true }, preferredWindow: "Thursday afternoon", alternativeWindows: ["Friday morning"] });
    const listed = opened!.calendar!.slots;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(40);
    expect(listed[0]!.label).toMatch(/^(Thu|Fri) /);
    for (const s of listed) {
      expect(Date.parse(s.at)).toBeGreaterThan(Date.now() + 119 * 60_000);
      expect(s.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)$/);
    }
  });

  test("success: the desk's confirm records a desk booking, writes it under the request's key, and Google gets a first name, the service and the time — nothing else", async () => {
    const f = await deskLocation(google, "cal-ok");
    const r = await phoneRequest(f.clinicId, { service: "facial", phone: "+15550104242" });
    const when = deskTime(3, 10);
    const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when });
    expect(decided).toMatchObject({ outcome: "decided", followUp: null, calendarWrite: "written" });

    const rows = await appointmentRow(f.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: decided.appointmentId,
      calendar_write_status: "written",
      calendar_write_error: null,
      calendar_write_attempts: 1,
      external_appointment_id: googleEventIdFor(r.requestId),
      external_source: "google_calendar",
      external_confirmed_at: null,
      booking_origin: "desk",
      duration_minutes: 60,
      calendar_event_key: r.requestId,
      calendar_id: "primary",
    });

    const [event] = google.events(f.sub);
    expect(event).toMatchObject({ id: googleEventIdFor(r.requestId), status: "confirmed" });
    expect(Date.parse(event!.start)).toBe(when.getTime());
    expect(Date.parse(event!.end)).toBe(when.getTime() + 60 * 60_000);
    const body = inserts()[0]!.json as Record<string, unknown>;
    expect(body.summary).toBe("Synthetic – Facial");
    expect(body.description).toBe("Added by healdesk after your front desk confirmed it.");
    expect(body).not.toHaveProperty("attendees");
    // The caller's whole number, not "555": a uuid in the body can carry 555 by chance.
    expect(JSON.stringify(body)).not.toMatch(/5550104242|Patient|@/);

    // The page: added. A second confirm is already decided, and a second write finds the row written.
    expect(await deskView(r.token)).toMatchObject({ status: "confirmed", calendarWrite: { status: "written", error: null }, calendar: null });
    expect((await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when })).outcome).toBe("already-decided");
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("written");
    expect(inserts()).toHaveLength(1);
    const audit = await inTenant(f.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'appointment' and metadata->>'calendarWrite' is not null`));
    expect(audit.rows).toEqual([{ metadata: { calendarWrite: "written", provider: "google_calendar" } }]);
  });

  test("a vet's calendar entry says Client when the name cannot be used", async () => {
    const f = await deskLocation(google, "cal-vet", { specialty: "veterinary" });
    const r = await phoneRequest(f.clinicId);
    await inTenant(f.clinicId, (client) => client.query(`update contacts set full_name = '555 0100' where id = $1`, [r.contactId]));
    const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(3, 11) });
    expect(decided.calendarWrite).toBe("written");
    expect((inserts()[0]!.json as { summary: string }).summary).toBe("Client – Consultation");
  });

  test("Google says no: the appointment stays, the row says failed, and only the ops retry tries again, reading back first", async () => {
    const f = await deskLocation(google, "cal-fail");
    const r = await phoneRequest(f.clinicId);
    google.failNext({ on: "insert", status: 400, reason: "badRequest" });
    const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(3, 12) });
    expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "failed" });
    const [row] = await appointmentRow(f.clinicId);
    expect(row).toMatchObject({ calendar_write_status: "failed", external_appointment_id: null, calendar_written_at: null });
    expect(await deskView(r.token)).toMatchObject({ status: "confirmed", calendarWrite: { status: "failed" } });
    // Not retried by the plain path; the ops retry reads back and then creates.
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("failed");
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!, { fromFailed: true })).toBe("written");
    expect(google.requests.filter((q) => q.endpoint === "get")).toHaveLength(1);
    expect(google.events(f.sub)).toHaveLength(1);
  });

  test("a timeout is unknown, and the retry adopts the event Google already holds instead of booking the slot twice", async () => {
    const f = await deskLocation(google, "cal-timeout");
    const r = await phoneRequest(f.clinicId);
    google.failNext({ on: "insert", status: 503, reason: "backendError" });
    const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(3, 13) });
    expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "unknown" });
    expect((await appointmentRow(f.clinicId))[0]).toMatchObject({ calendar_write_status: "unknown", external_appointment_id: null });

    // Meanwhile the event did land (a 5xx after Google stored it).
    google.addEvent(f.sub, {
      id: googleEventIdFor(r.requestId),
      start: deskTime(3, 13),
      end: new Date(deskTime(3, 13).getTime() + 30 * 60_000),
      privateProperties: { ...HEALDESK_EVENT_MARKER },
    });
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("written");
    expect(google.events(f.sub)).toHaveLength(1);
    expect((await appointmentRow(f.clinicId))[0]).toMatchObject({ calendar_write_status: "written", external_appointment_id: googleEventIdFor(r.requestId), calendar_write_attempts: 2 });
    const audit = await inTenant(f.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'appointment' and metadata->>'calendarWrite' is not null order by occurred_at`));
    expect(audit.rows.map((x) => x.metadata)).toEqual([
      { calendarWrite: "unknown", provider: "google_calendar", reason: "unconfirmed" },
      { calendarWrite: "written", provider: "google_calendar", adopted: true, retry: true },
    ]);
  });

  test("a write in flight is not started twice, and a location whose system does not read Google gets no write at all", async () => {
    const f = await deskLocation(google, "cal-guard");
    const r = await phoneRequest(f.clinicId);
    const decided = await deskDecide(r.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(3, 14) });
    expect(decided.calendarWrite).toBe("written");
    await inTenant(f.clinicId, (client) =>
      client.query(`update appointments set calendar_write_status = 'writing', calendar_write_claimed_at = clock_timestamp() where id = $1`, [decided.appointmentId]),
    );
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("unknown");
    expect(inserts()).toHaveLength(1);
    expect((await appointmentRow(f.clinicId))[0]!.calendar_write_status).toBe("writing");

    const manual = await deskLocation(google, "cal-none", { bookingSystem: "mindbody" });
    const m = await phoneRequest(manual.clinicId);
    const bare = await deskDecide(m.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: deskTime(3, 14) });
    expect(bare).toMatchObject({ outcome: "decided", calendarWrite: "not-connected" });
    expect((await appointmentRow(manual.clinicId))[0]).toMatchObject({ calendar_write_status: "none", booking_origin: null, calendar_id: null });
    expect(inserts()).toHaveLength(1);
  });
});
