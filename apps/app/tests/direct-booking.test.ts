import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as bookTool } from "@/app/api/voice/tools/[clinicId]/book/route";
import { POST as contextTool } from "@/app/api/voice/tools/[clinicId]/context/route";
import { POST as holdTool } from "@/app/api/voice/tools/[clinicId]/hold/route";
import { POST as requestTool } from "@/app/api/voice/tools/[clinicId]/request/route";
import { POST as slotsTool } from "@/app/api/voice/tools/[clinicId]/slots/route";
import { voiceAnswerDecision } from "@/lib/billing/answering";
import { offerTimes, type OfferedTime } from "@/lib/booking/engine";
import {
  BOOKED_LINE,
  bookedLine,
  HOLD_LINE,
  MANUAL_BOOKING_LINE,
  MISSING_DETAIL_LINES,
  NO_FREE_TIME_LINE,
  ONE_BOOKING_PER_CALL_LINE,
  ONE_REQUEST_PER_CALL_LINE,
  oneBookingPerCallLine,
  REQUEST_TAKEN_LINE,
  slotGoneLine,
  TOOL_FAILURE_LINE,
} from "@/lib/booking/lines";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { ingestCall } from "@/lib/voice/ingest";
import { spokenPhone, spokenSlot } from "@/lib/voice/spoken";
import { readSynthflowPayload } from "@/lib/voice/synthflow-payload";
import { __resetVoiceToolLimitsForTests, callRefOf, depositLine, VOICE_TOOL_LIMITS, voiceOffer } from "@/lib/voice/tools";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { freshGoogle, installGoogleEnv, restoreGoogleEnv } from "./setup/desk-calendar";
import { inTenant, seedCalendarTerms, seedClinic, seedEntitled, seedGoogleConnection, seedLegacyDemoClinic } from "./setup/factories";

/**
 * The Synthflow mid-call tool routes, a pre-Retell test harness (plan
 * §7.13): no time from a clinic's Google Calendar reaches the voice vendor
 * for any clinic but healdesk's demo clinic. Every other clinic's `context`
 * says requests and no times, its `slots`, `hold` and `book` answer 403
 * `manual_booking`, and `request` 403 `not_available`, so its requests
 * reach the desk by the post-call webhook alone, synthetic or not. The
 * demo clinic reaches the booking engine (C13) through them (C14), against
 * the in-memory Google, under the harness's keys: holder "voice:" + call
 * id, booking key the call id. Authentication, the body discipline and the
 * rate limits are unchanged. Everything synthetic.
 */

/**
 * The engine as it is, unless a test makes it throw: what a database outage
 * or a fault inside it looks like to the tool routes.
 */
const engineFault = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/booking/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/engine")>();
  const faulty =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (engineFault.on) throw new Error("engine fault for the test");
      return run(...args);
    };
  return {
    ...actual,
    offerTimes: faulty(actual.offerTimes),
    placeHold: faulty(actual.placeHold),
    bookConversation: faulty(actual.bookConversation),
    logRequest: faulty(actual.logRequest),
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const SECRET = "voice-tools-secret-for-tests";
const TZ = "America/New_York";
const HOURS = '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}';
const SLOW = 120_000;

describe("spoken forms (pure)", () => {
  test("a number is read in groups with oh for zero; a slot is a weekday, an ordinal and a clock time", () => {
    expect(spokenPhone("+14155550199")).toBe("four one five — five five five — oh one nine nine");
    expect(spokenPhone("+442071234567")).toBe("four four two — oh seven one — two three four — five six seven");
    expect(spokenSlot(new Date("2026-10-01T18:00:00Z"), TZ)).toBe("Thursday the 1st at 2 PM");
    expect(spokenSlot(new Date("2026-10-02T14:30:00Z"), TZ)).toBe("Friday the 2nd at 10:30 AM");
    expect(spokenSlot(new Date("2026-10-13T20:00:00Z"), TZ)).toBe("Tuesday the 13th at 4 PM");
    expect(spokenSlot(new Date("2026-10-22T13:00:00Z"), TZ)).toBe("Thursday the 22nd at 9 AM");
    expect(depositLine(null)).toBe("");
    expect(depositLine({ action: "book", amountUsd: 50 })).toBe("");
    expect(depositLine({ action: "book_and_flag", amountUsd: 200 })).toMatch(/^A deposit of 200 dollars is required to hold the appointment\. The front desk will call you to take it/);
    expect(depositLine({ action: "book_and_flag", amountUsd: null })).toMatch(/^A deposit is required/);
    // "Book by phone without a deposit" off: the line never promises a booking.
    expect(depositLine({ action: "decline_and_alert", amountUsd: 200 })).toMatch(/^This appointment needs a deposit of 200 dollars, so it can't be booked on this call\./);
    expect(callRefOf("call_abc123")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the fixed lines: the booked line is spec step 8's, in the clinic's own words for the service", () => {
    // Owner Q5, 5 October 2026 (spec step 8, 082cf9d).
    expect(BOOKED_LINE).toBe("You're booked for {when}{ for service}. It's in the clinic's calendar.");
    expect(bookedLine("Thursday the 1st at 2 PM", "Consultation")).toBe("You're booked for Thursday the 1st at 2 PM for Consultation. It's in the clinic's calendar.");
    expect(bookedLine("Thursday the 1st at 2 PM", null)).toBe("You're booked for Thursday the 1st at 2 PM. It's in the clinic's calendar.");
    expect(bookedLine("Thursday the 1st at 2 PM", "Peel $& more")).toBe("You're booked for Thursday the 1st at 2 PM for Peel $& more. It's in the clinic's calendar.");
    expect(oneBookingPerCallLine("Friday the 2nd at 10:30 AM")).toBe(ONE_BOOKING_PER_CALL_LINE.replace("{when}", "Friday the 2nd at 10:30 AM"));
    expect(oneBookingPerCallLine(null)).toBe("I can only book one appointment per call, and yours is already booked. For another appointment, please call back or ask the clinic.");
    expect(slotGoneLine(["Thursday the 1st at 2 PM", "Thursday the 1st at 3 PM", "Friday the 2nd at 9 AM"])).toBe(
      "That time has just gone. The nearest times I have are Thursday the 1st at 2 PM, Thursday the 1st at 3 PM, or Friday the 2nd at 9 AM.",
    );
    expect(slotGoneLine([])).toBe("That time has just gone. Which other day or time would suit you?");
    // No line promises a confirmation healdesk sends, or anything a call cannot do.
    for (const line of [BOOKED_LINE, HOLD_LINE, REQUEST_TAKEN_LINE, MANUAL_BOOKING_LINE, NO_FREE_TIME_LINE, ONE_REQUEST_PER_CALL_LINE, TOOL_FAILURE_LINE, ...Object.values(MISSING_DETAIL_LINES)]) {
      expect(line).not.toMatch(/link|text you|email you|we'll call|card/i);
    }
  });

  test("the voice offer: three times at most, spread across days, earliest first, on the clinic's own days", () => {
    // Every quarter-hour from 9 to 5, New York time, Monday 12 to Thursday 15 October 2026.
    const quarterHours = (date: string) =>
      Array.from({ length: 32 }, (_, i): OfferedTime => ({ at: new Date(Date.parse(`${date}T13:00:00Z`) + i * 15 * 60_000), providerId: null }));
    const week = ["2026-10-15", "2026-10-12", "2026-10-14", "2026-10-13"].flatMap(quarterHours);
    // The earliest time on each of the first three days, not 9:00, 9:15 and 9:30 on the first.
    expect(voiceOffer(week, TZ).map((s) => spokenSlot(s.at, TZ))).toEqual(["Monday the 12th at 9 AM", "Tuesday the 13th at 9 AM", "Wednesday the 14th at 9 AM"]);
    // One day (a day the caller named): spread across it, first and last included.
    expect(voiceOffer(quarterHours("2026-10-13"), TZ).map((s) => spokenSlot(s.at, TZ))).toEqual(["Tuesday the 13th at 9 AM", "Tuesday the 13th at 1 PM", "Tuesday the 13th at 4:45 PM"]);
    // Two days: the first gives two, spread; the second its earliest.
    expect(voiceOffer([...quarterHours("2026-10-14"), ...quarterHours("2026-10-13")], TZ).map((s) => spokenSlot(s.at, TZ))).toEqual([
      "Tuesday the 13th at 9 AM",
      "Tuesday the 13th at 4:45 PM",
      "Wednesday the 14th at 9 AM",
    ]);
    // A day is the clinic's: 11 PM in New York is the next day in UTC, and stays on its own day here.
    const late: OfferedTime[] = [
      { at: new Date("2026-10-13T03:00:00Z"), providerId: null },
      { at: new Date("2026-10-13T13:00:00Z"), providerId: null },
    ];
    expect(voiceOffer(late, TZ).map((s) => spokenSlot(s.at, TZ))).toEqual(["Monday the 12th at 11 PM", "Tuesday the 13th at 9 AM"]);
    // The same start on two providers' calendars is said once, as the engine listed it first.
    const twice: OfferedTime[] = [
      { at: new Date("2026-10-13T13:00:00Z"), providerId: "p-b" },
      { at: new Date("2026-10-13T13:00:00Z"), providerId: "p-a" },
      { at: new Date("2026-10-13T14:00:00Z"), providerId: "p-a" },
    ];
    expect(voiceOffer(twice, TZ).map((s) => s.providerId)).toEqual(["p-b", "p-a"]);
    expect(voiceOffer([], TZ)).toEqual([]);
  });
});

describeDb("the voice tools", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // healdesk's (fake) Google client, so a clinic's calendar can count as
    // healthy, and no request leaves the process.
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
    process.env.HEALDESK_VOICE_TOOLS_SECRET = SECRET;
    __resetVoiceToolLimitsForTests();
  });

  afterEach(() => {
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
  });

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  type Tool = "context" | "slots" | "hold" | "book" | "request";
  const handlers = { context: contextTool, slots: slotsTool, hold: holdTool, book: bookTool, request: requestTool } as const;
  function post(tool: Tool, clinicId: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const request = new Request(`http://app.test/api/voice/tools/${clinicId}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return handlers[tool](request, { params: Promise.resolve({ clinicId }) });
  }
  const call = (callId: string, extra: Record<string, unknown> = {}) => ({ call_id: callId, user_phone_number: "(415) 555-0177", ...extra });
  async function json(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }
  /** The clinic's own date of an instant, YYYY-MM-DD. */
  const localDay = (at: string | Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

  /**
   * A live clinic with an approved script, a billing row and a live voice
   * channel (the answer gate in front of the tools fails closed without
   * them), and — unless told otherwise — calendar terms that write and a
   * healthy Google connection: everything live booking would need. Told
   * `synthetic`, the same clinic still in setup, not yet put live.
   */
  async function liveClinic(label: string, opts: { calendar?: boolean; specialty?: string; deposit?: boolean; classification?: "production" | "synthetic" } = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = $4, baa_signed_at = now(), went_live_at = ${opts.classification === "synthetic" ? "null" : "now()"}, specialty = $2, timezone = $3,
              timezone_confirmed_at = now(), opening_hours = '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}'::jsonb
        where id = $1`,
      [c.clinicId, opts.specialty ?? "med-spa", TZ, opts.classification ?? "production"],
    );
    await seedEntitled(c.clinicId, { channelRows: [{ channel: "voice", liveAt: new Date() }] });
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
    });
    if (opts.deposit) {
      // A deposit is only asked for with deposits on and a connected Stripe account (BD27).
      await getMigratorPool().query(`update clinics set stripe_connect_account_id = 'acct_1DirectBooking', stripe_connect_connected_at = now() where id = $1`, [c.clinicId]);
      await inTenant(c.clinicId, (client) => client.query(`insert into clinic_settings (clinic_id, deposits_enabled) values ($1, true)`, [c.clinicId]));
    }
    if (opts.calendar !== false) {
      await seedCalendarTerms(c);
      await seedGoogleConnection(c.clinicId);
    }
    return c;
  }

  /**
   * healdesk's demo clinic, ready in every way live booking needs: its
   * calls answered, calendar terms that write, a healthy connection to a
   * Google account in the in-memory Google, hours and a confirmed zone, an
   * approved script. With the owner's switch on, its booking mode is live.
   */
  async function liveDemoClinic(label: string) {
    const demo = await seedLegacyDemoClinic(label);
    await getMigratorPool().query(
      `update clinics set timezone = $2, timezone_confirmed_at = now(), opening_hours = $3::jsonb where id = $1`,
      [demo.clinicId, TZ, HOURS],
    );
    await withTenant({ clinicId: demo.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550198" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
        depositPolicy: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    await seedCalendarTerms(demo);
    const sub = `4${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    google.addAccount({ sub, email: `demo-${sub}@radiance.test`, hd: "radiance.test" });
    const { refreshToken } = google.grant({ sub });
    await seedGoogleConnection(demo.clinicId, { managed: true, refreshToken });
    await inTenant(demo.clinicId, (client) =>
      client.query(`update clinic_channels set enabled = true, live_at = now() where channel = 'voice'`),
    );
    expect(await voiceAnswerDecision(demo.clinicId)).toEqual({ decision: "answer" });
    return { ...demo, sub };
  }

  /** What a call left at a clinic: its requests, appointments and holds, and the tool audit rows. */
  async function storedAt(clinicId: string) {
    return inTenant(clinicId, async (client) => ({
      requests: (await client.query<{ status: string; vendor_call_id: string | null; booked_via: string; preferred_window: string; alternative_windows: string[]; treatment: string | null }>(
        `select status, vendor_call_id, booked_via, preferred_window, alternative_windows, treatment from booking_requests order by created_at`,
      )).rows,
      appointments: (await client.query<{ scheduled_for: Date; booking_origin: string | null; calendar_write_status: string }>(`select scheduled_for, booking_origin, calendar_write_status from appointments`)).rows,
      holds: (await client.query<{ status: string }>(`select status from slot_holds order by created_at`)).rows,
      audit: (await client.query<{ resource_type: string; metadata: Record<string, unknown> }>(
        `select resource_type, metadata from audit_log where resource_type like 'voice_tool_%' and resource_type <> 'voice_tool_context' order by occurred_at`,
      )).rows,
    }));
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

  test("/context: requests and no times for every clinic but the demo clinic, even one with everything live booking needs", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    const live = await liveClinic("db-live", { specialty: "plastic-surgery", deposit: true });
    const ctx = await post("context", live.clinicId, call("ctx1"));
    expect(ctx.status).toBe(200);
    expect(await ctx.json()).toEqual({
      required_fields_spoken: "your first name, a number the practice can call, a day or time that works best, one or two other times that could work, your last name, which service you're asking about, and whether this is a consultation or a treatment visit",
      booking_mode: "desk_confirms",
      can_offer_times: false,
      hold_seconds: 60,
      booking_mode_reasons: ["harness_demo_only"],
      deposit_line: expect.stringMatching(/^A deposit of 100 dollars/),
      clinic_phone_spoken: "four one five — five five five — oh one nine nine",
      answer_mode: "assistant",
      transfer_number: null,
    });

    // The demo clinic's context is its booking mode, read fresh: live, so direct.
    const demo = await liveDemoClinic("db-demo");
    const demoCtx = (await (await post("context", demo.clinicId, call("ctx2"))).json()) as Record<string, unknown>;
    expect(demoCtx).toMatchObject({
      booking_mode: "direct",
      can_offer_times: true,
      hold_seconds: 60,
      booking_mode_reasons: [],
    });
    // The owner's switch off: requests, with times still on offer, and the reason named.
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    const switchedOff = (await (await post("context", demo.clinicId, call("ctx3"))).json()) as Record<string, unknown>;
    expect(switchedOff).toMatchObject({
      booking_mode: "desk_confirms",
      can_offer_times: true,
      booking_mode_reasons: ["kill_switch_off"],
    });
  });

  test("every clinic but the demo clinic: slots, hold and book are 403 manual_booking, request is refused for a production clinic, and nothing is written", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    const live = await liveClinic("db-parked");
    // The call is answered, and the clinic has everything live booking needs.
    expect((await voiceAnswerDecision(live.clinicId)).decision).toBe("answer");
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const parked = { error: "manual_booking", say: MANUAL_BOOKING_LINE };
    for (const [tool, body] of [
      ["slots", { days: 5 }],
      ["hold", { at }],
      ["book", { first_name: "Dana", at }],
    ] as const) {
      const res = await post(tool, live.clinicId, call("call_parked", body));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(parked);
    }
    const request = await post("request", live.clinicId, call("call_parked", { first_name: "Dana", preferred_window: "Thursday afternoon" }));
    expect(request.status).toBe(403);
    expect(await request.json()).toEqual({ error: "not_available", say: TOOL_FAILURE_LINE });
    const stored = await storedAt(live.clinicId);
    expect(stored).toMatchObject({ requests: [], appointments: [], holds: [] });
    expect(stored.audit.map((a) => [a.resource_type, a.metadata.outcome, a.metadata.reason, a.metadata.callRef])).toEqual([
      ["voice_tool_slots", "refused", "manual_booking", callRefOf("call_parked")],
      ["voice_tool_hold", "refused", "manual_booking", callRefOf("call_parked")],
      ["voice_tool_book", "refused", "manual_booking", callRefOf("call_parked")],
      ["voice_tool_request", "refused", "not_available", callRefOf("call_parked")],
    ]);
    expect(google.requests).toHaveLength(0);
  });

  test(
    "a synthetic clinic in setup, ready to book: every tool refuses, and the post-call webhook takes its request and mails the desk",
    async () => {
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      // Everything live booking needs, against a real account in the
      // in-memory Google, on a clinic still in setup (synthetic), as every
      // paying clinic is until ops put it live.
      const synthetic = await liveClinic("db-synthetic", { calendar: false, classification: "synthetic" });
      await seedCalendarTerms(synthetic);
      const sub = `6${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      google.addAccount({ sub, email: `desk-${sub}@synthetic.test`, hd: "synthetic.test" });
      await seedGoogleConnection(synthetic.clinicId, { managed: true, refreshToken: google.grant({ sub }).refreshToken });
      await inTenant(synthetic.clinicId, (client) =>
        client.query(`insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`, [synthetic.clinicId, "desk@example-clinic.test"]),
      );
      expect((await voiceAnswerDecision(synthetic.clinicId)).decision).toBe("answer");

      const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
      for (const [tool, body] of [
        ["slots", {}],
        ["hold", { at }],
        ["book", { first_name: "Dana", at }],
      ] as const) {
        const res = await post(tool, synthetic.clinicId, call("call_synth", body));
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "manual_booking", say: MANUAL_BOOKING_LINE });
      }
      // A request logged in the call would raise only a booking alert, which
      // reaches nobody until M5, and the post-call record would then link it
      // and mail nobody: the agent takes the details instead.
      const asked = await post("request", synthetic.clinicId, call("call_synth", { first_name: "Dana", preferred_window: "Thursday afternoon" }));
      expect(asked.status).toBe(403);
      expect(await asked.json()).toEqual({ error: "not_available", say: TOOL_FAILURE_LINE });
      expect(google.requests).toHaveLength(0);
      expect(await storedAt(synthetic.clinicId)).toMatchObject({ requests: [], appointments: [], holds: [] });
      // Refused by the harness, not by the engine, which would offer this clinic times.
      const engine = await offerTimes(synthetic.clinicId, { channel: "voice", holderKey: "voice:probe", service: "Consultation" });
      expect(engine).toMatchObject({ status: "ok", slots: expect.arrayContaining([expect.objectContaining({ providerId: null })]) });

      const mailed: OutgoingEmail[] = [];
      const transport: EmailTransport = {
        name: "capture",
        async send(_target, message) {
          mailed.push(message);
          return { status: "sent", messageId: `m-${mailed.length}` };
        },
      };
      const ingested = await ingestCall(
        readSynthflowPayload(
          {
            call_id: "call_synth",
            start_time: new Date(Date.now() - 300_000).toISOString(),
            end_time: new Date().toISOString(),
            duration: 300,
            status: "completed",
            lead: { name: "Dana Test", phone_number: "(415) 555-0177" },
            collected_variables: { outcome: "booked", caller_name: "Dana Test", booked_for: at, preferred_window: "Thursday afternoon", booked_treatment: "Consultation" },
          },
          synthetic.clinicId,
        ),
        undefined,
        { transport },
      );
      expect(ingested.bookingRequestId).not.toBeNull();
      const stored = await storedAt(synthetic.clinicId);
      expect(stored.requests).toEqual([expect.objectContaining({ status: "requested", vendor_call_id: null, preferred_window: "Thursday afternoon" })]);
      expect(mailed).toHaveLength(1);
      expect(mailed[0]!.subject).toMatch(/^New booking request via /);
      const notified = await inTenant(synthetic.clinicId, (client) => client.query<{ desk_notified_at: Date | null }>(`select desk_notified_at from booking_requests`));
      expect(notified.rows[0]!.desk_notified_at).not.toBeNull();
    },
    SLOW,
  );

  test(
    "the demo clinic: slots offers three times, hold holds one, book writes it to Google with the booked line, and a retry answers the same",
    async () => {
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      const demo = await liveDemoClinic("db-demo-book");
      const slots = await post("slots", demo.clinicId, call("call_book", { service: "Consultation" }));
      expect(slots.status).toBe(200);
      const offered = (await slots.json()) as { slots: { at: string; spoken: string; provider_id: string | null }[]; service: string; service_minutes: number };
      expect(offered).toMatchObject({ service: "Consultation", service_minutes: 30 });
      expect(offered.slots).toHaveLength(3);
      for (const slot of offered.slots) {
        expect(slot).toEqual({ at: slot.at, spoken: spokenSlot(new Date(slot.at), TZ), provider_id: null });
        expect(Date.parse(slot.at)).toBeGreaterThan(Date.now());
      }
      // Spread across days, earliest first (plan §6.4): three days, in order, not three quarter-hours of one.
      expect(new Set(offered.slots.map((slot) => localDay(slot.at))).size).toBe(3);
      expect([...offered.slots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))).toEqual(offered.slots);
      const at = offered.slots[0]!.at;
      const when = spokenSlot(new Date(at), TZ);

      const held = await post("hold", demo.clinicId, call("call_book", { at, service: "Consultation" }));
      expect(held.status).toBe(200);
      expect(await held.json()).toEqual({ held: true, at, when_spoken: when, hold_seconds: 60, provider_id: null, say: HOLD_LINE });

      const booked = await post("book", demo.clinicId, call("call_book", { first_name: "Dana", at, service: "Consultation" }));
      expect(booked.status).toBe(200);
      const answer = { booked: true, at, when_spoken: when, service: "Consultation", say: `You're booked for ${when} for Consultation. It's in the clinic's calendar.` };
      expect(await booked.json()).toEqual(answer);
      // A retried tool call is the first answer again, and writes nothing more.
      const again = await post("book", demo.clinicId, call("call_book", { first_name: "Dana", at, service: "Consultation" }));
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(answer);

      const events = google.events(demo.sub);
      expect(events).toHaveLength(1);
      expect(Date.parse(events[0]!.start)).toBe(Date.parse(at));
      const stored = await storedAt(demo.clinicId);
      expect(stored.requests).toEqual([expect.objectContaining({ status: "confirmed", vendor_call_id: "call_book", booked_via: "agent_direct", treatment: "Consultation" })]);
      expect(stored.appointments).toEqual([{ scheduled_for: new Date(at), booking_origin: "assistant", calendar_write_status: "written" }]);
      expect(stored.holds).toEqual([{ status: "converted" }]);
      expect(stored.audit.map((a) => [a.resource_type, a.metadata.outcome, a.metadata.callRef])).toEqual([
        ["voice_tool_slots", "offered", callRefOf("call_book")],
        ["voice_tool_hold", "held", callRefOf("call_book")],
        ["voice_tool_book", "booked", callRefOf("call_book")],
        ["voice_tool_book", "booked", callRefOf("call_book")],
      ]);
      expect(stored.audit.map((a) => a.metadata.replayed).filter((r) => r !== undefined)).toEqual([false, true]);

      // One booking a call: another time, or a request, hears the first booking's time.
      const second = await post("book", demo.clinicId, call("call_book", { first_name: "Dana", at: offered.slots[1]!.at, service: "Consultation" }));
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "key_reused", say: oneBookingPerCallLine(when) });
      const asked = await post("request", demo.clinicId, call("call_book", { first_name: "Dana", preferred_window: "next week" }));
      expect(asked.status).toBe(409);
      expect(await asked.json()).toEqual({ error: "key_reused", say: oneBookingPerCallLine(when) });
      // Nor is another time offered or held on this call, before the caller chooses one.
      for (const [tool, body] of [
        ["slots", {}],
        ["hold", { at: offered.slots[1]!.at }],
      ] as const) {
        const res = await post(tool, demo.clinicId, call("call_book", body));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: "key_reused", say: oneBookingPerCallLine(when) });
      }
      expect(google.events(demo.sub)).toHaveLength(1);
      const after = await storedAt(demo.clinicId);
      expect(after.requests).toHaveLength(1);
      expect(after.holds).toEqual([{ status: "converted" }]);
    },
    SLOW,
  );

  test(
    "the demo clinic: a time another call holds is slot_taken with the nearest times, and with the owner's switch off a booking is a request",
    async () => {
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      const demo = await liveDemoClinic("db-demo-taken");
      const offered = (await json(await post("slots", demo.clinicId, call("call_first")))).slots as { at: string }[];
      const at = offered[0]!.at;
      expect((await post("hold", demo.clinicId, call("call_first", { at }))).status).toBe(200);
      const taken = await post("hold", demo.clinicId, call("call_second", { at }));
      expect(taken.status).toBe(409);
      const body = (await taken.json()) as { error: string; alternatives: { at: string; spoken: string; provider_id: string | null }[]; say: string };
      expect(body.error).toBe("slot_taken");
      expect(body.alternatives.length).toBeGreaterThan(0);
      expect(body.alternatives.length).toBeLessThanOrEqual(3);
      // Each on the calendar asked for (here the location's own), so a hold that takes one back lands there.
      for (const alternative of body.alternatives) expect(alternative).toEqual({ at: alternative.at, spoken: spokenSlot(new Date(alternative.at), TZ), provider_id: null });
      expect(body.alternatives.map((a) => a.at)).not.toContain(at);
      expect(body.say).toBe(slotGoneLine(body.alternatives.map((a) => spokenSlot(new Date(a.at), TZ))));

      // The owner's switch off: times are still offered, nothing is held, and
      // the booking is taken as a request for the clinic to confirm.
      delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
      const later = offered[1]!.at;
      expect((await post("slots", demo.clinicId, call("call_third"))).status).toBe(200);
      const notHeld = await post("hold", demo.clinicId, call("call_third", { at: later }));
      expect(notHeld.status).toBe(403);
      expect(await notHeld.json()).toEqual({ error: "manual_booking", say: MANUAL_BOOKING_LINE });
      const requested = await post("book", demo.clinicId, call("call_third", { first_name: "Lee", at: later, service: "Consultation" }));
      expect(requested.status).toBe(200);
      expect(await requested.json()).toEqual({ booked: false, request_taken: true, say: REQUEST_TAKEN_LINE });
      expect(google.events(demo.sub)).toHaveLength(0);
      const stored = await storedAt(demo.clinicId);
      expect(stored.requests).toEqual([expect.objectContaining({ status: "requested", vendor_call_id: "call_third", treatment: "Consultation" })]);
      expect(stored.audit.filter((a) => a.resource_type === "voice_tool_book").map((a) => [a.metadata.outcome, a.metadata.reason])).toEqual([["request_logged", "manual"]]);
    },
    SLOW,
  );

  test("the demo clinic: a request in the caller's words, once a call; a missing detail is asked for again", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    const demo = await liveDemoClinic("db-demo-request");
    const ask = { first_name: "Sam", preferred_window: "Thursday afternoon", alternative_windows: ["Friday morning"], service: "Consultation" };
    const logged = await post("request", demo.clinicId, call("call_req", ask));
    expect(logged.status).toBe(200);
    expect(await logged.json()).toEqual({ request_taken: true, say: REQUEST_TAKEN_LINE });
    expect(await (await post("request", demo.clinicId, call("call_req", ask))).json()).toEqual({ request_taken: true, say: REQUEST_TAKEN_LINE });
    const another = await post("request", demo.clinicId, call("call_req", { ...ask, preferred_window: "Monday morning" }));
    expect(another.status).toBe(409);
    expect(await another.json()).toEqual({ error: "key_reused", say: ONE_REQUEST_PER_CALL_LINE });
    // A call that has passed its request is offered no times to book.
    const times = await post("slots", demo.clinicId, call("call_req"));
    expect(times.status).toBe(409);
    expect(await times.json()).toEqual({ error: "key_reused", say: ONE_REQUEST_PER_CALL_LINE });
    expect((await storedAt(demo.clinicId)).requests).toEqual([
      { status: "requested", vendor_call_id: "call_req", booked_via: "desk", preferred_window: "Thursday afternoon", alternative_windows: ["Friday morning"], treatment: "Consultation" },
    ]);

    const missing: [Tool, Record<string, unknown>, keyof typeof MISSING_DETAIL_LINES][] = [
      ["request", { first_name: "Sam" }, "preferred_window"],
      ["request", { preferred_window: "Thursday" }, "first_name"],
      ["book", { at: new Date(Date.now() + 3 * 86_400_000).toISOString() }, "first_name"],
      ["book", { first_name: "Sam" }, "at"],
      ["hold", {}, "at"],
    ];
    for (const [tool, body, field] of missing) {
      const res = await post(tool, demo.clinicId, call(`call_missing_${tool}_${field}`, body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `${field}_required`, say: MISSING_DETAIL_LINES[field] });
    }
    expect((await storedAt(demo.clinicId)).requests).toHaveLength(1);
  });

  test(
    "the demo clinic: a day the caller names is the clinic's own, nothing free has its own line, and a date or time it cannot read is refused",
    async () => {
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      const demo = await liveDemoClinic("db-demo-day");
      // Open into the evening, so a date read as UTC midnight (8 PM the
      // evening before, in New York) would offer the evening before.
      const late = JSON.stringify(Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, d === "sun" || d === "sat" ? [] : [["09:00", "23:00"]]])));
      await getMigratorPool().query(`update clinics set opening_hours = $2::jsonb where id = $1`, [demo.clinicId, late]);
      const dayAhead = (weekdays: readonly string[]) => {
        for (let k = 4; ; k += 1) {
          const at = new Date(Date.now() + k * 86_400_000);
          if (weekdays.includes(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(at))) return localDay(at);
        }
      };
      // A weekday whose evening before is open too.
      const day = dayAhead(["Tue", "Wed", "Thu", "Fri"]);

      const named = (await json(await post("slots", demo.clinicId, call("call_day", { day, service: "Consultation" })))).slots as { at: string; spoken: string }[];
      expect(named.map((slot) => localDay(slot.at))).toEqual([day, day, day]);
      // Spread across that day: its opening, and its last start before 11 PM.
      expect(named[0]!.spoken).toMatch(/ at 9 AM$/);
      expect(named[2]!.spoken).toMatch(/ at 10:30 PM$/);
      const from = (await json(await post("slots", demo.clinicId, call("call_from", { from: day })))).slots as { at: string; spoken: string }[];
      expect(localDay(from[0]!.at)).toBe(day);
      expect(from[0]!.spoken).toMatch(/ at 9 AM$/);

      // Nothing free on a day the caller named: ask for another.
      const sunday = dayAhead(["Sun"]);
      const closed = await post("slots", demo.clinicId, call("call_sunday", { day: sunday, service: "Consultation" }));
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({ slots: [], service: "Consultation", service_minutes: 30, say: NO_FREE_TIME_LINE });

      // Never guessed: a date in words, a date that does not exist, a time with no offset.
      for (const [tool, body, error] of [
        ["slots", { day: "15 October" }, "day_invalid"],
        ["slots", { day: "2026-02-30" }, "day_invalid"],
        ["slots", { from: `${day}T14:00` }, "from_invalid"],
        ["hold", { at: `${day}T14:00:00` }, "at_required"],
      ] as const) {
        const res = await post(tool, demo.clinicId, call(`call_unread_${error}_${tool}_${Object.values(body)[0]}`, body));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error, say: error === "at_required" ? MISSING_DETAIL_LINES.at : MISSING_DETAIL_LINES.preferred_window });
      }

      // Nothing free across the whole offer: a request, not a day-by-day search.
      google.addBusy(demo.sub, new Date(Date.now() - 86_400_000), new Date(Date.now() + 90 * 86_400_000));
      const full = await post("slots", demo.clinicId, call("call_full"));
      expect(full.status).toBe(403);
      expect(await full.json()).toEqual({ error: "manual_booking", say: MANUAL_BOOKING_LINE });

      const stored = await storedAt(demo.clinicId);
      expect(stored).toMatchObject({ requests: [], appointments: [], holds: [] });
      expect(stored.audit.filter((a) => a.metadata.outcome === "none_free").map((a) => a.metadata.narrowed)).toEqual([true, false]);
      expect(stored.audit.filter((a) => a.metadata.outcome === "invalid").map((a) => a.metadata.field)).toEqual(["day", "day", "from", "at"]);
    },
    SLOW,
  );

  test("the demo clinic: an engine that throws is the failure line and an audit row, never a bare 500", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    const demo = await liveDemoClinic("db-demo-fault");
    const at = ((await json(await post("slots", demo.clinicId, call("call_fault_probe")))).slots as { at: string }[])[0]!.at;
    const tools = [
      ["slots", {}],
      ["hold", { at }],
      ["book", { first_name: "Dana", at }],
      ["request", { first_name: "Dana", preferred_window: "Thursday afternoon" }],
    ] as const;
    engineFault.on = true;
    try {
      for (const [tool, body] of tools) {
        const res = await post(tool, demo.clinicId, call(`call_fault_${tool}`, body));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable", say: TOOL_FAILURE_LINE });
      }
    } finally {
      engineFault.on = false;
    }
    const stored = await storedAt(demo.clinicId);
    expect(stored).toMatchObject({ requests: [], appointments: [], holds: [] });
    expect(stored.audit.filter((a) => a.metadata.outcome === "error").map((a) => [a.resource_type, a.metadata.callRef])).toEqual(
      tools.map(([tool]) => [`voice_tool_${tool}`, callRefOf(`call_fault_${tool}`)]),
    );
  });

  test("rate limits: twelve calls a minute per call id, sixty per clinic", async () => {
    const c = await liveClinic("db-limit", { calendar: false });
    for (let i = 0; i < VOICE_TOOL_LIMITS.perCall; i += 1) expect((await post("context", c.clinicId, call("call_busy"))).status).toBe(200);
    expect((await post("context", c.clinicId, call("call_busy"))).status).toBe(429);
    expect((await post("context", c.clinicId, call("call_other"))).status).toBe(200);
    __resetVoiceToolLimitsForTests();
    for (let i = 0; i < VOICE_TOOL_LIMITS.perClinic; i += 1) expect((await post("context", c.clinicId, call(`call_${i}`))).status).toBe(200);
    expect((await post("context", c.clinicId, call("call_last"))).status).toBe(429);
  }, 120_000);
});
