import { fixtureAdapter, type CanonicalSlot } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { arrangeSlots, attendeeEmailFor, namedWeekdays, slotLabel, slotsFor, writableConnection, writeToCalendar } from "@/lib/booking/calendar";
import { markVerified, saveConnection } from "@/lib/connections/store";
import { createBookingRequest, decideBookingRequest, resolveBookingRequest } from "@/lib/meta/booking-requests";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * The calendar write (design of 23 September 2026, §B.3–B.4), against the
 * fixture adapter, which books like a vendor with no idempotency key: the
 * same request twice is two bookings unless the caller reads back first. No
 * real vendor is registered in v1 (the Cal.com adapter was removed; Google
 * Calendar is not built yet), so the fixture is the only writable calendar.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const DAY = 24 * 60 * 60 * 1000;
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
    expect(attendeeEmailFor("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe("bookings+3fa85f64-5717-4562-b3fc-2c963f66afa6@sink.healdesk.io");
  });
});

describeDb("the calendar write, against the fixture", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  afterEach(() => {
    fixtureAdapter.reset();
  });

  afterAll(async () => {
    await closePools();
  });

  /** A clinic with an active fixture connection (and a PHI basis unless told otherwise) and one voice request. */
  async function clinicWithRequest(label: string, opts: { phiBasis?: "practice_account" | null; windows?: [string, ...string[]] } = {}) {
    const c = await seedClinic(label);
    await inTenant(c.clinicId, (client) => client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [c.clinicId, "desk@example-clinic.test"]));
    const connectionId = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const id = await saveConnection(tx.db, { clinicId: c.clinicId, provider: "fixture", credentials: { apiKey: "fx-key" }, metadata: { durationMinutes: 30 } });
      await markVerified(tx.db, { clinicId: c.clinicId, connectionId: id, capabilities: {} });
      return id;
    });
    if (opts.phiBasis !== null) {
      await inTenant(c.clinicId, (client) => client.query(`update provider_connections set phi_basis = $2 where id = $1`, [connectionId, opts.phiBasis ?? "practice_account"]));
    }
    const contactId = await seedContact(c.clinicId, "+15550104040");
    const { conversationId } = await seedConversation(c.clinicId, { startedAt: new Date(), contactId });
    const [primary, ...alternatives] = opts.windows ?? ["Thursday afternoon", "Friday morning", "Friday morning"];
    const created = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      createBookingRequest(tx, { channel: "voice", contactId, conversationId, preferredWindow: primary, treatment: "Consultation", alternativeWindows: alternatives }),
    );
    return { clinicId: c.clinicId, connectionId, token: created.token, requestId: created.id };
  }

  const appointmentRow = (clinicId: string) =>
    inTenant(clinicId, (client) =>
      client.query<{ id: string; calendar_write_status: string; calendar_write_error: string | null; calendar_written_at: string | null; external_appointment_id: string | null; external_source: string | null; external_confirmed_at: string | null }>(
        `select id, calendar_write_status, calendar_write_error, calendar_written_at, external_appointment_id, external_source, external_confirmed_at from appointments`,
      ),
    );

  test("a writable connection needs an adapter that writes AND a recorded PHI basis; the page lists the calendar's free times, the named days first", async () => {
    const none = await clinicWithRequest("cal-nobasis", { phiBasis: null });
    expect(await withTenant({ clinicId: none.clinicId, actor: ACTOR }, (tx) => writableConnection(tx))).toBeNull();
    expect(await resolveBookingRequest(none.token)).toMatchObject({ calendar: null, alternativeWindows: ["Friday morning"], treatment: "Consultation" });

    const f = await clinicWithRequest("cal-list");
    const writable = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) => writableConnection(tx));
    expect(writable).toMatchObject({ connectionId: f.connectionId, provider: "fixture", phiBasis: "practice_account" });
    const listed = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) => slotsFor(tx, 14, { preferred: ["Thursday afternoon", "Friday morning"] }));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThanOrEqual(40);
    expect(listed[0]!.label).toMatch(/^(Thu|Fri) /);
    for (const s of listed) {
      expect(Date.parse(s.at)).toBeGreaterThan(Date.now());
      expect(s.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)$/);
    }
    const opened = await resolveBookingRequest(f.token);
    expect(opened).toMatchObject({ calendar: { writable: true }, preferredWindow: "Thursday afternoon", alternativeWindows: ["Friday morning"] });
    expect(opened!.calendar!.slots.map((s) => s.at)).toEqual(listed.map((s) => s.at));
  });

  test("success: the desk's confirm records the appointment, writes it, and hands the vendor a name, a sink address and a time — never a number", async () => {
    const f = await clinicWithRequest("cal-ok");
    const slot = (await resolveBookingRequest(f.token))!.calendar!.slots[0]!;
    const decided = await decideBookingRequest(f.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: new Date(slot.at) });
    expect(decided).toMatchObject({ outcome: "decided", followUp: null, calendarWrite: "written" });
    expect(decided.appointmentId).not.toBeNull();

    const rows = await appointmentRow(f.clinicId);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: decided.appointmentId, calendar_write_status: "written", calendar_write_error: null, external_appointment_id: `fx-${f.requestId}`, external_source: "fixture", external_confirmed_at: null });
    expect(rows.rows[0]!.calendar_written_at).not.toBeNull();

    const writes = fixtureAdapter.recordedWrites();
    expect(writes).toHaveLength(1);
    const input = writes[0]!.input;
    expect(input.attendee.email).toBe(attendeeEmailFor(f.requestId));
    expect(input.attendee.email).toMatch(/^bookings\+[0-9a-f-]{36}@sink\.healdesk\.io$/);
    expect(input.attendee).toEqual({ name: "Synthetic Patient", email: attendeeEmailFor(f.requestId), timeZone: TZ });
    expect(input).toMatchObject({ idempotencyKey: f.requestId, service: "Consultation", durationMinutes: 30 });
    expect(input.startsAt.toISOString()).toBe(slot.at);
    expect(JSON.stringify(input)).not.toMatch(/phone|5550104040|4040/i);
    expect(Object.keys(input).sort()).toEqual(["attendee", "durationMinutes", "idempotencyKey", "service", "startsAt"]);

    // The page: added, and the confirm copy.
    expect(await resolveBookingRequest(f.token)).toMatchObject({ status: "confirmed", calendarWrite: { status: "written", error: null }, calendar: null });
    // A second confirm is already decided, and a second write finds the row written.
    expect((await decideBookingRequest(f.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: new Date(slot.at) })).outcome).toBe("already-decided");
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("written");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    const audit = await inTenant(f.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'appointment' and metadata->>'calendarWrite' is not null`));
    expect(audit.rows).toEqual([{ metadata: { calendarWrite: "written", provider: "fixture" } }]);
  });

  test("the vendor says no: the appointment stays, the row says failed, the page tells the desk to add it by hand", async () => {
    const f = await clinicWithRequest("cal-fail");
    fixtureAdapter.failNextWrite();
    const when = new Date(Date.now() + 3 * DAY);
    const decided = await decideBookingRequest(f.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when });
    expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "failed" });
    const rows = await appointmentRow(f.clinicId);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ calendar_write_status: "failed", calendar_write_error: "conflict", external_appointment_id: null, calendar_written_at: null });
    expect(await resolveBookingRequest(f.token)).toMatchObject({ status: "confirmed", calendarWrite: { status: "failed", error: "conflict" } });
    // Not retried by the plain path; the ops retry reads back and then creates.
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("failed");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(0);
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!, { fromFailed: true })).toBe("written");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
  });

  test("a timeout is unknown, and the retry adopts the booking the vendor already holds instead of booking the slot twice", async () => {
    const f = await clinicWithRequest("cal-timeout");
    fixtureAdapter.timeoutNextWrite();
    const when = new Date(Date.now() + 3 * DAY);
    const decided = await decideBookingRequest(f.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when });
    expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "unknown" });
    expect((await appointmentRow(f.clinicId)).rows[0]).toMatchObject({ calendar_write_status: "unknown", calendar_write_error: "timeout", external_appointment_id: null });
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect(fixtureAdapter.recordedWrites()[0]!.timedOut).toBe(true);

    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("written");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect((await appointmentRow(f.clinicId)).rows[0]).toMatchObject({ calendar_write_status: "written", external_appointment_id: `fx-${f.requestId}`, external_source: "fixture", calendar_write_error: null, external_confirmed_at: null });
    const audit = await inTenant(f.clinicId, (client) => client.query<{ metadata: Record<string, unknown> }>(`select metadata from audit_log where resource_type = 'appointment' and metadata->>'calendarWrite' is not null order by occurred_at`));
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      { calendarWrite: "unknown", provider: "fixture", reason: "timeout" },
      { calendarWrite: "written", provider: "fixture", adopted: true, retry: true },
    ]);
  });

  test("a write in flight is not started twice, and a clinic with no PHI basis gets no write at all", async () => {
    const f = await clinicWithRequest("cal-guard");
    const when = new Date(Date.now() + 3 * DAY);
    const decided = await decideBookingRequest(f.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when });
    expect(decided.calendarWrite).toBe("written");
    await inTenant(f.clinicId, (client) => client.query(`update appointments set calendar_write_status = 'writing', external_appointment_id = null where id = $1`, [decided.appointmentId]));
    expect(await writeToCalendar(f.clinicId, decided.appointmentId!)).toBe("unknown");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect((await appointmentRow(f.clinicId)).rows[0]!.calendar_write_status).toBe("writing");

    const none = await clinicWithRequest("cal-none", { phiBasis: null });
    const bare = await decideBookingRequest(none.token, "confirmed", { decidedByLabel: "Jo", deskNote: null, confirmedFor: when });
    expect(bare).toMatchObject({ outcome: "decided", calendarWrite: "not-connected" });
    expect((await appointmentRow(none.clinicId)).rows[0]).toMatchObject({ calendar_write_status: "none", external_appointment_id: null });
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
  });
});
