import { FAKE_GOOGLE_CLIENT } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { POST as bookTool } from "@/app/api/voice/tools/[clinicId]/book/route";
import { POST as contextTool } from "@/app/api/voice/tools/[clinicId]/context/route";
import { POST as slotsTool } from "@/app/api/voice/tools/[clinicId]/slots/route";
import { voiceAnswerDecision } from "@/lib/billing/answering";
import { MANUAL_BOOKING_LINE } from "@/lib/booking/lines";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";
import { spokenPhone, spokenSlot } from "@/lib/voice/spoken";
import { __resetVoiceToolLimitsForTests, callRefOf, depositLine, VOICE_TOOL_LIMITS } from "@/lib/voice/tools";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedCalendarTerms, seedClinic, seedDemoClinic, seedEntitled, seedGoogleConnection } from "./setup/factories";

/**
 * The Synthflow mid-call tool routes, parked as a pre-Retell test harness
 * (plan §7.13, C12): no time from a clinic's Google Calendar reaches the
 * voice vendor. `context` says requests and no times for every clinic but
 * healdesk's demo clinic, whose mode is bookingModeFor's; `slots` and `book`
 * answer 403 `manual_booking` for every clinic, until the engine is wired
 * for the demo clinic (C14). Authentication, the body discipline and the
 * rate limits are unchanged.
 */
const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const SECRET = "voice-tools-secret-for-tests";
const TZ = "America/New_York";
const HOURS = '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}';
const ENV_KEYS = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;

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
});

describeDb("the parked voice tools", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    process.env.HEALDESK_VOICE_TOOLS_SECRET = SECRET;
    __resetVoiceToolLimitsForTests();
    // healdesk's (fake) Google client, so a clinic's calendar can count as healthy.
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
  });

  afterEach(() => {
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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
   * A live clinic with an approved script, a billing row and a live voice
   * channel (the answer gate in front of the tools fails closed without
   * them), and — unless told otherwise — calendar terms that write and a
   * healthy Google connection: everything live booking would need.
   */
  async function liveClinic(label: string, opts: { calendar?: boolean; specialty?: string; deposit?: boolean } = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), specialty = $2, timezone = $3,
              timezone_confirmed_at = now(), opening_hours = '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}'::jsonb
        where id = $1`,
      [c.clinicId, opts.specialty ?? "med-spa", TZ],
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
   * calls answered, calendar terms that write, a healthy Google connection,
   * hours and a confirmed zone, an approved script. With the owner's switch
   * on, its booking mode is live.
   */
  async function liveDemoClinic(label: string) {
    const demo = await seedDemoClinic(label);
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
    await seedGoogleConnection(demo.clinicId);
    await inTenant(demo.clinicId, (client) =>
      client.query(`update clinic_channels set enabled = true, live_at = now() where channel = 'voice'`),
    );
    expect(await voiceAnswerDecision(demo.clinicId)).toEqual({ decision: "answer" });
    return demo;
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

  test("/slots and /book are 403 for every clinic, manual_booking where the call is answered, and write nothing", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    const live = await liveClinic("db-parked");
    const demo = await liveDemoClinic("db-parked-demo");
    for (const clinicId of [live.clinicId, demo.clinicId]) {
      // Both calls are answered, and the demo clinic's mode is live: still
      // nothing is offered or booked until the engine is wired (C14).
      expect((await voiceAnswerDecision(clinicId)).decision).toBe("answer");
      const expected = { error: "manual_booking", say: MANUAL_BOOKING_LINE };
      const slots = await post("slots", clinicId, call("call_parked", { days: 5 }));
      expect(slots.status).toBe(403);
      expect(await slots.json()).toEqual(expected);
      const booked = await post("book", clinicId, call("call_parked", { first_name: "Dana", at: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
      expect(booked.status).toBe(403);
      expect(await booked.json()).toEqual(expected);
      const stored = await inTenant(clinicId, async (client) => ({
        requests: (await client.query(`select 1 from booking_requests`)).rows.length,
        appointments: (await client.query(`select 1 from appointments`)).rows.length,
        holds: (await client.query(`select 1 from slot_holds`)).rows.length,
        audit: (await client.query<{ resource_type: string; metadata: Record<string, unknown> }>(
          `select resource_type, metadata from audit_log where resource_type in ('voice_tool_slots', 'voice_tool_book') order by occurred_at`,
        )).rows,
      }));
      expect(stored).toMatchObject({ requests: 0, appointments: 0, holds: 0 });
      expect(stored.audit.map((a) => [a.resource_type, a.metadata.outcome, a.metadata.reason, a.metadata.callRef])).toEqual([
        ["voice_tool_slots", "refused", "manual_booking", callRefOf("call_parked")],
        ["voice_tool_book", "refused", "manual_booking", callRefOf("call_parked")],
      ]);
    }
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
