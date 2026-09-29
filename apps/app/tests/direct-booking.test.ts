import { CALLBACK_CONSENT } from "@healdesk/catalog";
import { fixtureAdapter } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The direct-booking addendum is not counsel-approved in the catalogue
 * (`approvedByCounsel: false`), and E.1 refuses while it is not. The tests
 * below need both answers, so the flag is switched per test through a
 * hoisted handle; the catalogue text itself is untouched.
 */
const addendum = vi.hoisted(() => ({ approved: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: addendum.approved }),
  };
});

import { POST as bookTool } from "@/app/api/voice/tools/[clinicId]/book/route";
import { POST as contextTool } from "@/app/api/voice/tools/[clinicId]/context/route";
import { POST as slotsTool } from "@/app/api/voice/tools/[clinicId]/slots/route";
import { markVerified, saveConnection } from "@/lib/connections/store";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { ingestCall } from "@/lib/voice/ingest";
import { spokenPhone, spokenSlot } from "@/lib/voice/spoken";
import { __resetVoiceToolLimitsForTests, __setVoiceToolRuntimeForTests, callRefOf, depositLine, VOICE_TOOL_LIMITS } from "@/lib/voice/tools";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Direct booking by the phone assistant (design of 23 September 2026, §E),
 * through the mid-call tool routes, against the fixture calendar.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const SECRET = "voice-tools-secret-for-tests";
const TZ = "America/New_York";
const SPOKEN = /^[A-Z][a-z]+ the \d+(st|nd|rd|th) at \d{1,2}(:\d{2})? (AM|PM)$/;

describe("spoken forms (pure)", () => {
  test("a number is read in groups with oh for zero; a slot is a weekday, an ordinal and a clock time", () => {
    expect(spokenPhone("+14155550199")).toBe("four one five — five five five — oh one nine nine");
    expect(spokenPhone("+442071234567")).toBe("four four two — oh seven one — two three four — five six seven");
    expect(spokenSlot(new Date("2026-10-01T18:00:00Z"), TZ)).toBe("Thursday the 1st at 2 PM");
    expect(spokenSlot(new Date("2026-10-02T14:30:00Z"), TZ)).toBe("Friday the 2nd at 10:30 AM");
    expect(spokenSlot(new Date("2026-10-13T20:00:00Z"), TZ)).toBe("Tuesday the 13th at 4 PM");
    expect(spokenSlot(new Date("2026-10-22T13:00:00Z"), TZ)).toBe("Thursday the 22nd at 9 AM");
    expect(depositLine(null)).toBe("");
    expect(depositLine({ required: false, amountUsd: 50 })).toBe("");
    expect(depositLine({ required: true, amountUsd: 200 })).toMatch(/^A deposit of 200 dollars is required to hold the appointment\. The front desk will call you to take it/);
    expect(depositLine({ required: true, amountUsd: null })).toMatch(/^A deposit is required/);
    expect(callRefOf("call_abc123")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describeDb("the direct-booking tools", () => {
  const mailed: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  const transport: EmailTransport = {
    name: "capture",
    async send(target, message) {
      mailed.push({ target, message });
      return { status: "sent", messageId: `m-${mailed.length}` };
    },
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    process.env.HEALDESK_VOICE_TOOLS_SECRET = SECRET;
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    addendum.approved = true;
    __setVoiceToolRuntimeForTests({ transport });
    __resetVoiceToolLimitsForTests();
  });

  afterEach(() => {
    fixtureAdapter.reset();
    mailed.length = 0;
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    addendum.approved = false;
    __setVoiceToolRuntimeForTests(undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  type Tool = "context" | "slots" | "book";
  const handlers = { context: contextTool, slots: slotsTool, book: bookTool } as const;
  function post(tool: Tool, clinicId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const request = new Request(`http://app.test/api/voice/tools/${clinicId}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return handlers[tool](request, { params: Promise.resolve({ clinicId }) });
  }
  const call = (callId: string, extra: Record<string, unknown> = {}) => ({ call_id: callId, user_phone_number: "(415) 555-0177", ...extra });

  /**
   * A live clinic with an approved script, a writable fixture calendar with
   * a PHI basis, and — unless told otherwise — the direct-booking election.
   */
  async function liveClinic(label: string, opts: { direct?: boolean; specialty?: string; deposit?: boolean } = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), specialty = $2, timezone = $3 where id = $1`,
      [c.clinicId, opts.specialty ?? "med-spa", TZ],
    );
    await inTenant(c.clinicId, (client) => client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [c.clinicId, "desk@example-clinic.test"]));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
        depositPolicy: opts.deposit ? { required: true, amountUsd: 100, collection: "front_desk" } : null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      const id = await saveConnection(tx.db, { clinicId: c.clinicId, provider: "fixture", credentials: { apiKey: "fx-key" }, metadata: { durationMinutes: 30 } });
      await markVerified(tx.db, { clinicId: c.clinicId, connectionId: id, capabilities: {} });
      return id;
    });
    await inTenant(c.clinicId, (client) => client.query(`update provider_connections set phi_basis = 'practice_account'`));
    if (opts.direct !== false) {
      await getMigratorPool().query(
        `update clinics set booking_mode = 'direct', direct_booking_elected_at = now(), direct_booking_elected_by_label = 'Dr Chen, Owner',
                direct_booking_clause_version = 'direct-booking-addendum/1.0.0', direct_booking_clause_hash = decode('ab', 'hex') where id = $1`,
        [c.clinicId],
      );
    }
    return c;
  }

  test("503 without the secret and 401 with the wrong one — a different secret from the webhook's", async () => {
    const c = await liveClinic("db-auth");
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    process.env.HEALDESK_VOICE_WEBHOOK_SECRET = "the-webhook-secret";
    expect((await post("context", c.clinicId, call("c1"))).status).toBe(503);
    process.env.HEALDESK_VOICE_TOOLS_SECRET = SECRET;
    expect((await post("context", c.clinicId, call("c1"), { authorization: "Bearer the-webhook-secret" })).status).toBe(401);
    expect((await post("context", c.clinicId, call("c1"), { authorization: "" })).status).toBe(401);
    expect((await post("context", "not-a-uuid", call("c1"))).status).toBe(404);
    delete process.env.HEALDESK_VOICE_WEBHOOK_SECRET;
    // Body discipline: the call id and a phone number are required; 32 KB is the cap.
    expect((await post("context", c.clinicId, "{not json")).status).toBe(400);
    expect((await post("context", c.clinicId, { user_phone_number: "+14155550177" })).status).toBe(400);
    expect((await post("context", c.clinicId, { call_id: "c1", user_phone_number: "anonymous" })).status).toBe(400);
    expect((await post("context", c.clinicId, { call_id: "c1", user_phone_number: "+14155550177", pad: "x".repeat(33 * 1024) })).status).toBe(413);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from audit_log where resource_type like 'voice_tool_%'`))).rows).toHaveLength(0);
  });

  test("/context returns the practice's set and the effective mode; slots and book are 403 for a desk clinic, with the env off, or with the addendum unapproved", async () => {
    const desk = await liveClinic("db-desk", { direct: false, specialty: "plastic-surgery", deposit: true });
    const ctx = await post("context", desk.clinicId, call("ctx1"));
    expect(ctx.status).toBe(200);
    expect(await ctx.json()).toEqual({
      required_fields_spoken: "your first name, a number the practice can call, a day or time that works best, one or two other times that could work, your last name, which service you're asking about, and whether this is a consultation or a treatment visit",
      booking_mode: "desk_confirms",
      consent_line: CALLBACK_CONSENT.voice,
      deposit_line: expect.stringMatching(/^A deposit of 100 dollars/),
      clinic_phone_spoken: "four one five — five five five — oh one nine nine",
    });
    const refused = await post("slots", desk.clinicId, call("ctx1"));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "direct_booking_off", missing: [expect.stringMatching(/not elected direct booking/)] });
    expect((await post("book", desk.clinicId, call("ctx1", { first_name: "Sam", at: new Date(Date.now() + 86_400_000).toISOString() }))).status).toBe(403);

    const direct = await liveClinic("db-direct");
    expect(await (await post("context", direct.clinicId, call("ctx2"))).json()).toMatchObject({ booking_mode: "direct", deposit_line: "" });
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    // The context's mode follows the gate, so the agent never starts a flow the tool would refuse.
    expect(await (await post("context", direct.clinicId, call("ctx2"))).json()).toMatchObject({ booking_mode: "desk_confirms" });
    let off = await post("slots", direct.clinicId, call("ctx2"));
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: "direct_booking_off", missing: [expect.stringMatching(/HEALDESK_DIRECT_BOOKING_ENABLED/)] });
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    addendum.approved = false;
    off = await post("slots", direct.clinicId, call("ctx2"));
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ error: "direct_booking_off", missing: [expect.stringMatching(/addendum has not been approved/)] });
    addendum.approved = true;
    expect((await post("slots", direct.clinicId, call("ctx2"))).status).toBe(200);
    expect((await inTenant(direct.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows).toHaveLength(0);
  });

  test("/slots lists at most six free times with spoken labels; /book takes one of them, is idempotent on the call id, tells the desk without details, and links the post-call webhook to the same request", async () => {
    const c = await liveClinic("db-book", { specialty: "plastic-surgery", deposit: true });
    const listed = await post("slots", c.clinicId, call("call_book_1", { days: 5 }));
    expect(listed.status).toBe(200);
    const { slots } = (await listed.json()) as { slots: { at: string; label: string; spoken: string }[] };
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(6);
    for (const s of slots) {
      expect(Date.parse(s.at)).toBeGreaterThan(Date.now());
      expect(s.spoken).toMatch(SPOKEN);
      expect(s.label).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (AM|PM)$/);
    }
    expect(slots.map((s) => Date.parse(s.at))).toEqual([...slots.map((s) => Date.parse(s.at))].sort((a, b) => a - b));

    // A time the calendar did not offer is refused; so is a missing name.
    const invented = new Date(Date.parse(slots[0]!.at) + 7 * 60_000).toISOString();
    const refused = await post("book", c.clinicId, call("call_book_1", { first_name: "Dana", at: invented }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "slot_unavailable" });
    expect((await post("book", c.clinicId, call("call_book_1", { first_name: "Dana <script>", at: slots[0]!.at }))).status).toBe(400);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from appointments`))).rows).toHaveLength(0);

    // The booking. Fields are validated as on a callback; a clinical service is dropped to null.
    const chosen = slots[1]!;
    const booked = await post("book", c.clinicId, call("call_book_1", { first_name: "Dana", at: chosen.at, service: "Rhinoplasty consultation", fields: { last_name: "Okonkwo", consult_or_treatment: "consultation", dob: "1990", phone: "+15550000000" } }));
    expect(booked.status).toBe(200);
    const reply = (await booked.json()) as { booked: boolean; when_spoken: string; calendar: string };
    expect(reply).toEqual({ booked: true, when_spoken: chosen.spoken, calendar: "written" });

    const stored = await inTenant(c.clinicId, async (client) => ({
      requests: (await client.query<Record<string, unknown>>(`select channel, status, booked_via, vendor_call_id, decided_by_label, preferred_window, treatment, collected_fields, conversation_id, desk_notified_at, confirmed_for, appointment_id from booking_requests`)).rows,
      appointments: (await client.query<Record<string, unknown>>(`select scheduled_for, treatment, deposit_status, deposit_usd, calendar_write_status, external_appointment_id, external_confirmed_at from appointments`)).rows,
      contacts: (await client.query<{ phone: string; full_name: string; timezone: string }>(`select phone, full_name, timezone from contacts`)).rows,
      audit: (await client.query<{ resource_type: string; metadata: Record<string, unknown> }>(`select resource_type, metadata from audit_log where resource_type in ('voice_tool_book', 'voice_tool_slots', 'appointment', 'booking_request') order by occurred_at`)).rows,
    }));
    expect(stored.requests).toHaveLength(1);
    expect(stored.requests[0]).toMatchObject({
      channel: "voice",
      status: "confirmed",
      booked_via: "agent_direct",
      vendor_call_id: "call_book_1",
      decided_by_label: "assistant (direct booking)",
      preferred_window: chosen.label,
      treatment: "Rhinoplasty consultation",
      collected_fields: { last_name: "Okonkwo", consult_or_treatment: "consultation" },
      conversation_id: null,
    });
    expect(stored.requests[0]!.desk_notified_at).not.toBeNull();
    expect(new Date(stored.requests[0]!.confirmed_for as string).toISOString()).toBe(chosen.at);
    expect(stored.appointments).toHaveLength(1);
    expect(stored.appointments[0]).toMatchObject({ treatment: "Rhinoplasty consultation", deposit_status: "pending_front_desk", deposit_usd: "100.00", calendar_write_status: "written", external_confirmed_at: null });
    expect(stored.appointments[0]!.external_appointment_id).toBe(`fx-${stored.requests[0]!.appointment_id ? "" : ""}${(await inTenant(c.clinicId, (client) => client.query<{ id: string }>(`select id from booking_requests`))).rows[0]!.id}`);
    expect(stored.contacts).toEqual([{ phone: "+14155550177", full_name: "Dana", timezone: TZ }]);
    // The calendar was handed a name, the sink address and the time — never the number.
    const writes = fixtureAdapter.recordedWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.input.attendee).toEqual({ name: "Dana Okonkwo", email: expect.stringMatching(/^bookings\+[0-9a-f-]{36}@sink\.healdesk\.io$/), timeZone: TZ });
    expect(JSON.stringify(writes[0]!.input)).not.toMatch(/0177|phone/i);
    // Audit: the call by digest, never the id or the number; fields named, never valued.
    const refs = stored.audit.filter((a) => a.resource_type.startsWith("voice_tool_"));
    expect(refs.length).toBeGreaterThanOrEqual(3);
    for (const a of refs) expect(a.metadata.callRef).toBe(callRefOf("call_book_1"));
    expect(JSON.stringify(stored.audit)).not.toMatch(/call_book_1|0177|Okonkwo|Rhinoplasty/);
    expect(stored.audit.filter((a) => a.metadata.outcome === "field_refused").map((a) => `${a.metadata.field}:${a.metadata.reason}`).sort()).toEqual(["dob:not_required", "phone:locked"]);

    // The desk's FYI: the subject says the assistant booked, the body says who and when only through the link.
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.message.subject).toBe("The assistant booked an appointment — db-book Clinic");
    expect(mailed[0]!.message.text).toMatch(/booked a caller directly into your calendar, as you elected/);
    expect(mailed[0]!.message.text).toMatch(/a deposit is due/);
    expect(mailed[0]!.message.text).toMatch(/https:\/\/app\.healdesk\.test\/booking\/[A-Za-z0-9_-]{43}/);
    expect(mailed[0]!.message.text).not.toMatch(/Dana|Okonkwo|0177|Rhinoplasty|\d{1,2}:\d{2} (AM|PM)/);
    expect(mailed[0]!.message.phiClass).toBe("none");

    // Idempotent: the retry answers with the first result and writes nothing more.
    const again = await post("book", c.clinicId, call("call_book_1", { first_name: "Dana", at: slots[3]!.at }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(reply);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from appointments`))).rows).toHaveLength(1);
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect(mailed).toHaveLength(1);

    // The post-call webhook for the same call links the conversation instead of creating a second request.
    const ingested = await ingestCall(
      { externalCallId: "call_book_1", clinicId: c.clinicId, callerPhone: "+14155550177", startedAt: new Date(), outcome: "booked", booking: { scheduledFor: new Date(chosen.at), preferredWindow: "Thursday" } },
      ACTOR,
    );
    const linked = await inTenant(c.clinicId, (client) => client.query<{ id: string; conversation_id: string | null }>(`select id, conversation_id from booking_requests`));
    expect(linked.rows).toHaveLength(1);
    expect(linked.rows[0]!.conversation_id).toBe(ingested.conversationId);
    expect(ingested.bookingRequestId).toBe(linked.rows[0]!.id);
    expect((await inTenant(c.clinicId, (client) => client.query(`select 1 from appointments`))).rows).toHaveLength(1);
  });

  test("a calendar failure still books: the row stays, the agent hears failed, the desk still hears", async () => {
    const c = await liveClinic("db-calfail");
    const { slots } = (await (await post("slots", c.clinicId, call("call_fail_1"))).json()) as { slots: { at: string; spoken: string }[] };
    fixtureAdapter.failNextWrite();
    const booked = await post("book", c.clinicId, call("call_fail_1", { first_name: "Sam", at: slots[0]!.at }));
    expect(booked.status).toBe(200);
    expect(await booked.json()).toEqual({ booked: true, when_spoken: slots[0]!.spoken, calendar: "failed" });
    const rows = await inTenant(c.clinicId, (client) => client.query<{ calendar_write_status: string; calendar_write_error: string; deposit_status: string }>(`select calendar_write_status, calendar_write_error, deposit_status from appointments`));
    expect(rows.rows).toEqual([{ calendar_write_status: "failed", calendar_write_error: "conflict", deposit_status: "none" }]);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.message.text).not.toMatch(/a deposit is due/);
    // The retry reports what the row says.
    expect(await (await post("book", c.clinicId, call("call_fail_1", { first_name: "Sam", at: slots[0]!.at }))).json()).toMatchObject({ booked: true, calendar: "failed" });
  });

  test("rate limits: twelve calls a minute per call id, sixty per clinic", async () => {
    const c = await liveClinic("db-limit", { direct: false });
    for (let i = 0; i < VOICE_TOOL_LIMITS.perCall; i += 1) expect((await post("context", c.clinicId, call("call_busy"))).status).toBe(200);
    expect((await post("context", c.clinicId, call("call_busy"))).status).toBe(429);
    expect((await post("context", c.clinicId, call("call_other"))).status).toBe(200);
    __resetVoiceToolLimitsForTests();
    for (let i = 0; i < VOICE_TOOL_LIMITS.perClinic; i += 1) expect((await post("context", c.clinicId, call(`call_${i}`))).status).toBe(200);
    expect((await post("context", c.clinicId, call("call_last"))).status).toBe(429);
  });
});
