import { randomUUID } from "node:crypto";

import { setGoogleTimeouts, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The booking tool layer (lib/assistant/booking-tools.ts) wired into the
 * shared brain, through the two adapters that use it: the web chat
 * (sendWebChatMessage) and the call (RetellCallSession). The model is a
 * script; Google is the in-memory fake; everything is synthetic.
 *
 * The owner's switch is stubbed per test (process.env) and counsel's
 * addendum through a mock of the catalog's currentDirectBookingAddendum:
 * neither is ever set anywhere but here.
 */

const state = vi.hoisted(() => ({ addendum: true }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({
      ...actual.currentDirectBookingAddendum(),
      approvedByCounsel: state.addendum,
    }),
  };
});

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import { guardedLine } from "@/lib/assistant/guard";
import { EMPTY_CAPTURE, type AssistantPrompt, type AssistantResponder } from "@/lib/assistant/turn";
import type { AnswerDecision } from "@/lib/billing/answering";
import { handleConnectEvent } from "@/lib/billing/connect-events";
import { clampDepositExpiry, depositLinkText } from "@/lib/billing/deposit-link";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { slotLabel } from "@/lib/booking/calendar";
import {
  BOOKING_LINES_EN,
  BOOKING_LINES_ES,
  BOOKING_REFUSED_LINE,
  bookedLine,
  depositLine,
  detailsBeforeHoldLine,
  forChat,
  heldAskLine,
  MANUAL_BOOKING_LINE,
  REQUEST_TAKEN_LINE,
  requestAskLine,
  TOOL_FAILURE_LINE,
} from "@/lib/booking/lines";
import { sendWebChatMessage, startWebChat, type WebChatClinic } from "@/lib/chat/web-chat";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";
import type { IngestResult, VoiceCallEvent } from "@/lib/voice/ingest";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";
import { spokenSlotEs } from "@/lib/voice/spoken";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { DESK_TZ, deskLocation, deskTime, freshGoogle, installGoogleEnv, restoreGoogleEnv, type DeskLocation } from "./setup/desk-calendar";
import { bindAgreementInEffect, inTenant, queuedNotices, seedEntitled } from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { createStripeFake, stripeError, type StripeFake } from "./setup/stripe-fake";

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "booking-tools-test" } as const;
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const PHONE = "+14155550188";

type Seen = { system: AssistantPrompt; last: string };
type Answer = Record<string, unknown>;

/** A model that answers from a script, one entry per turn, each seeing what the model was sent. */
function scripted(script: Array<(seen: Seen) => Answer>) {
  const seen: Seen[] = [];
  const responder: AssistantResponder = async ({ system, messages }) => {
    const entry = { system, last: messages[messages.length - 1]!.content };
    seen.push(entry);
    const next = script.shift();
    return JSON.stringify(next ? next(entry) : { reply: "Happy to help." });
  };
  return { responder, seen };
}

/** The exact values the tool layer offered, as the model is told them. */
function offeredIn(system: AssistantPrompt): string[] {
  return [...system.turn.matchAll(/^- (\S+) = /gm)].map((m) => m[1]!);
}

/** The day `at` falls on, in the desk's zone, as the model would write it. */
function dayOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DESK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

describeDb("the booking tool layer in the web chat and the call", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    await attestPlatform(COVERAGE_VENDORS);
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 180_000);

  beforeEach(() => {
    google = freshGoogle();
    state.addendum = true;
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
  });

  afterEach(() => {
    setGoogleTimeouts(undefined);
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
  });

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  /** A live location (covered terms, Google connected, production, script approved) that has bought the web chat and the voice agent. */
  async function location(label: string): Promise<DeskLocation & { web: WebChatClinic }> {
    const f = await deskLocation(google, label);
    await bindAgreementInEffect(f.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [f.clinicId],
    );
    // Both channels bought and live: the tool layer now asks the answer gate before it
    // writes (booking-tools.ts), and a call is answered only once its channel is live.
    await seedEntitled(f.clinicId, {
      planId: "voice-webchat-1000-1000",
      planStartedAt: WINDOW_START,
      channelRows: [
        { channel: "web", liveAt: WINDOW_START },
        { channel: "voice", liveAt: WINDOW_START },
      ],
    });
    await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await approveAgentConfig(tx, "Dr Chen");
    });
    return { ...f, web: { clinicId: f.clinicId, name: `${label} Clinic`, website: null } };
  }

  const inserts = () => google.requests.filter((r) => r.endpoint === "insert");

  const rows = (clinicId: string) =>
    inTenant(clinicId, async (client) => ({
      appointments: (
        await client.query<{ id: string; scheduled_for: Date; treatment: string | null; booking_origin: string | null; conversation_id: string | null }>(
          `select id, scheduled_for, treatment, booking_origin, conversation_id from appointments order by created_at`,
        )
      ).rows,
      requests: (
        await client.query<{ id: string; status: string; channel: string; vendor_call_id: string | null; conversation_id: string | null; appointment_id: string | null }>(
          `select id, status, channel, vendor_call_id, conversation_id, appointment_id from booking_requests order by created_at`,
        )
      ).rows,
      holds: (
        await client.query<{ id: string; status: string; channel: string; starts_at: Date }>(
          `select id, status, channel, starts_at from slot_holds order by created_at`,
        )
      ).rows,
    }));

  async function chat(clinic: WebChatClinic, responder: AssistantResponder) {
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error(`no chat: ${start.mode}`);
    let token = start.token;
    return async (text: string) => {
      const reply = await sendWebChatMessage(clinic, token, text, { responder });
      if (reply.mode !== "chat") throw new Error(`not a chat reply: ${reply.mode}`);
      token = reply.token;
      return reply.reply;
    };
  }

  test(
    "web chat: times offered by the engine, the details taken before anything is held, then held, booked into Google and confirmed in the tool's words",
    async () => {
      const f = await location("tools-web");
      const at = deskTime(3, 10);
      const { responder, seen } = scripted([
        () => ({ reply: "Let me look.", booking: { wants: true, service: "Facial" }, action: { type: "find_times", service: "Facial", day: dayOf(at) } }),
        ({ system }) => ({ reply: "Great choice.", action: { type: "choose_time", at: offeredIn(system).find((v) => new Date(v).getTime() === at.getTime()) } }),
        () => ({ reply: "You're booked!", booking: { first_name: "Ana", phone: "415 555 0188" } }),
      ]);
      const say = await chat(f.web, responder);

      const offered = await say("Can I book a facial?");
      // Three times an hour apart, from the day's first: 8, 9 and 10.
      expect(offered).toMatch(/^I have .+\. Which would suit you\?$/);
      expect(offered).toContain(slotLabel(at, DESK_TZ));
      // The model was offered the tools, and told the values to choose by.
      expect(seen[0]!.system.stable).toContain("find_times");

      const first = at.toISOString();
      expect(await say("The ten o'clock please")).toBe(detailsBeforeHoldLine(slotLabel(at, DESK_TZ)));
      expect(offeredIn(seen[1]!.system)).toContain(first);
      // Nothing held for a visitor the chat cannot name yet.
      expect((await rows(f.clinicId)).holds).toEqual([]);

      // The model's own "You're booked!" is never said: the tool's line is.
      expect(await say("My name is Ana and my number is 415 555 0188")).toBe(bookedLine(slotLabel(at, DESK_TZ), "Facial"));
      const { appointments, requests, holds } = await rows(f.clinicId);
      expect(appointments).toEqual([expect.objectContaining({ scheduled_for: at, treatment: "Facial", booking_origin: "assistant" })]);
      expect(holds).toEqual([expect.objectContaining({ status: "converted", channel: "web_chat" })]);
      // One request, the engine's, on the chat's conversation; the chat files no second one.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: "confirmed", channel: "web_chat", appointment_id: appointments[0]!.id });
      expect(requests[0]!.vendor_call_id).toBe(`web:${requests[0]!.conversation_id}:1`);
      expect(appointments[0]!.conversation_id).toBe(requests[0]!.conversation_id);
      expect(inserts()).toHaveLength(1);

      // A repeated tool call answers with the one booking, and books nothing more.
      const conversationId = requests[0]!.conversation_id!;
      const tools = bookingTools({
        clinicId: f.clinicId,
        channel: "web_chat",
        holderKey: `web:${conversationId}`,
        bookingKey: `web:${conversationId}:1`,
        conversationId,
        timeZone: DESK_TZ,
        actor: ACTOR,
        budgetMs: 15_000,
      });
      const retried = await tools.run({
        action: null,
        capture: { ...EMPTY_CAPTURE, firstName: "Ana", phone: PHONE },
        state: { ...EMPTY_TOOL_STATE, service: "Facial", offered: [{ at: first, providerId: null }], chosen: { at: first, providerId: null } },
        now: new Date(),
      });
      expect(retried).toMatchObject({ bookingWritten: true, appointmentId: appointments[0]!.id, reply: bookedLine(slotLabel(at, DESK_TZ), "Facial") });
      expect(inserts()).toHaveLength(1);
      expect((await rows(f.clinicId)).appointments).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "web chat: Google's re-check failing for now takes the visitor's request for the desk, once, under the booking key, with its L7, and says nothing booked",
    async () => {
      const f = await location("tools-web-recheck-down");
      const at = deskTime(3, 10);
      const { responder } = scripted([
        () => ({ reply: "Let me look.", booking: { wants: true, service: "Facial" }, action: { type: "find_times", service: "Facial", day: dayOf(at) } }),
        ({ system }) => ({ reply: "Great choice.", action: { type: "choose_time", at: offeredIn(system).find((v) => new Date(v).getTime() === at.getTime()) } }),
        () => ({ reply: "You're booked!", booking: { first_name: "Ana", phone: "415 555 0188" } }),
        () => ({ reply: "Anything else?" }),
      ]);
      const say = await chat(f.web, responder);
      await say("Can I book a facial?");
      await say("The ten o'clock please");

      // Google answers the re-check with server errors: transient, not a break.
      google.failNext({ on: "freeBusy", status: 503, times: 10 });
      expect(await say("My name is Ana and my number is 415 555 0188")).toBe(forChat(REQUEST_TAKEN_LINE));

      const { appointments, requests } = await rows(f.clinicId);
      expect(appointments).toEqual([]);
      expect(inserts()).toHaveLength(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: "requested", channel: "web_chat" });
      expect(requests[0]!.vendor_call_id).toBe(`web:${requests[0]!.conversation_id}:1`);
      expect(await queuedNotices(f.clinicId, ["booking_request"])).toHaveLength(1);

      // The next message files nothing more and alerts no one again.
      await say("Thanks");
      expect((await rows(f.clinicId)).requests).toHaveLength(1);
      expect(await queuedNotices(f.clinicId, ["booking_request"])).toHaveLength(1);
    },
    SLOW,
  );

  /** A call on the session, with the gate answering and the record captured instead of ingested. */
  async function callSession(clinicId: string, responder: AssistantResponder) {
    const sent: RetellOutbound[] = [];
    const recorded: VoiceCallEvent[] = [];
    const session = new RetellCallSession(clinicId, `call_${randomUUID().slice(0, 8)}`, (m) => sent.push(m), {
      responder,
      realCalls: true,
      gate: async (): Promise<AnswerDecision> => ({ decision: "answer" }),
      ingest: async (event) => {
        recorded.push(event);
        return { conversationId: randomUUID() } as unknown as IngestResult;
      },
    });
    await session.open();
    await session.handle(JSON.stringify({ interaction_type: "call_details", call: { from_number: PHONE, to_number: "+14155550111", direction: "inbound" } }));
    const transcript: { role: string; content: string }[] = [];
    let id = 0;
    const lastSaid = () => {
      const responses = sent.filter((m): m is Extract<RetellOutbound, { response_type: "response" }> => m.response_type === "response");
      return responses[responses.length - 1]!.content;
    };
    transcript.push({ role: "agent", content: lastSaid() });
    return {
      session,
      recorded,
      say: async (words: string) => {
        transcript.push({ role: "user", content: words });
        id += 1;
        await session.handle(JSON.stringify({ interaction_type: "response_required", response_id: id, transcript }));
        const reply = lastSaid();
        transcript.push({ role: "agent", content: reply });
        return reply;
      },
    };
  }

  test(
    "voice: the time held for a minute as soon as it is chosen, booked once the caller is named, the caller id as the number; the call's record files nothing more",
    async () => {
      const f = await location("tools-voice");
      const at = deskTime(4, 11);
      const { responder } = scripted([
        () => ({ reply: "One moment.", booking: { wants: true, service: "Consultation" }, action: { type: "find_times", service: "Consultation", day: dayOf(at) } }),
        ({ system }) => ({ reply: "Lovely.", action: { type: "choose_time", at: offeredIn(system).find((v) => new Date(v).getTime() === at.getTime()) ?? offeredIn(system)[0] } }),
        () => ({ reply: "Thanks.", booking: { first_name: "Ben" } }),
      ]);
      const call = await callSession(f.clinicId, responder);

      expect(await call.say("I'd like a consultation")).toMatch(/^I have .+\. Which would suit you\?$/);
      const heldLine = await call.say("Eleven please");
      expect(heldLine).toBe(heldAskLine("first_name"));
      expect((await rows(f.clinicId)).holds).toEqual([expect.objectContaining({ status: "held", channel: "voice" })]);

      const said = await call.say("Ben");
      expect(said).toMatch(/^You're booked for .+ for Consultation\. It's in the clinic's calendar\.$/);
      const { appointments, requests } = await rows(f.clinicId);
      expect(appointments).toHaveLength(1);
      expect(requests).toEqual([expect.objectContaining({ status: "confirmed", channel: "voice" })]);
      expect(requests[0]!.vendor_call_id).toBe(`retell:${call.session.callId}:1`);
      expect(inserts()).toHaveLength(1);

      await call.session.finish();
      // The engine has the booking under the call's key: no request in words for the ingest to file.
      expect(call.recorded[0]).toMatchObject({ outcome: "booked" });
      expect(call.recorded[0]!.booking).toBeUndefined();
    },
    SLOW,
  );

  test(
    "voice: a hold that ran out and was taken by another caller is re-checked at booking and the nearest times offered again, never guessed",
    async () => {
      const f = await location("tools-expired");
      const at = deskTime(5, 10);
      const { responder } = scripted([
        () => ({ reply: "Checking.", booking: { wants: true, service: "Consultation" }, action: { type: "find_times", service: "Consultation", day: dayOf(at) } }),
        ({ system }) => ({ reply: "OK.", action: { type: "choose_time", at: offeredIn(system)[0] } }),
        () => ({ reply: "Thanks.", booking: { first_name: "Cleo" } }),
      ]);
      const call = await callSession(f.clinicId, responder);
      await call.say("A consultation");
      await call.say("The first");
      const [held] = (await rows(f.clinicId)).holds;
      // The minute passes, and another caller takes the time.
      await inTenant(f.clinicId, (client) => client.query(`update slot_holds set status = 'expired', released_at = clock_timestamp() where id = $1`, [held!.id]));
      const other = bookingTools({ clinicId: f.clinicId, channel: "voice", holderKey: "retell:other", bookingKey: "retell:other:1", conversationId: null, timeZone: DESK_TZ, actor: ACTOR, budgetMs: 15_000 });
      const taken = await other.run({
        action: { type: "choose_time", at: held!.starts_at.toISOString() },
        capture: { ...EMPTY_CAPTURE, firstName: "Dee" },
        state: { ...EMPTY_TOOL_STATE, service: "Consultation", offered: [{ at: held!.starts_at.toISOString(), providerId: null }] },
        callerPhone: "+14155550177",
        now: new Date(),
      });
      expect(taken?.bookingWritten).toBe(true);

      const said = await call.say("Cleo");
      expect(said).toMatch(/^That time has just gone\. The nearest times I have are .+\.$/);
      expect(said).not.toContain(slotLabel(held!.starts_at, DESK_TZ));
      expect((await rows(f.clinicId)).appointments).toHaveLength(1);
      expect(inserts()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "two chats choosing the same time at once: one booking, and the other is offered the nearest free times",
    async () => {
      const f = await location("tools-race");
      const at = deskTime(6, 14);
      const iso = at.toISOString();
      const tools = (n: number) => {
        const conversationId = randomUUID();
        return bookingTools({ clinicId: f.clinicId, channel: "web_chat", holderKey: `web:${conversationId}`, bookingKey: `web:${conversationId}:1`, conversationId: null, timeZone: DESK_TZ, actor: ACTOR, budgetMs: 15_000 }).run({
          action: { type: "choose_time", at: iso },
          capture: { ...EMPTY_CAPTURE, firstName: n === 1 ? "Eve" : "Fay", phone: n === 1 ? "+14155550161" : "+14155550162" },
          state: { ...EMPTY_TOOL_STATE, service: "Consultation", offered: [{ at: iso, providerId: null }] } satisfies BookingToolState,
          now: new Date(),
        });
      };
      const both = await Promise.all([tools(1), tools(2)]);
      expect(both.filter((t) => t?.bookingWritten)).toHaveLength(1);
      const lost = both.find((t) => !t?.bookingWritten)!;
      expect(lost.reply).toMatch(/^That time has just gone\./);
      expect(lost.state.offered.length).toBeGreaterThan(0);
      expect(lost.state.offered.every((s) => s.at !== iso)).toBe(true);
      expect((await rows(f.clinicId)).appointments).toHaveLength(1);
      expect(inserts()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "web chat: a connection that breaks at booking takes a request in the same turn, and the next turn has no tools",
    async () => {
      const f = await location("tools-broken");
      const at = deskTime(3, 15);
      const { responder, seen } = scripted([
        () => ({ reply: "Looking.", booking: { wants: true, service: "Consultation" }, action: { type: "find_times", service: "Consultation", day: dayOf(at) } }),
        ({ system }) => ({ reply: "OK.", booking: { first_name: "Gus", phone: "+14155550155" }, action: { type: "choose_time", at: offeredIn(system)[0] } }),
        () => ({ reply: "The team will confirm your time within a day.", action: { type: "find_times", service: "Consultation", day: "" } }),
      ]);
      const say = await chat(f.web, responder);
      await say("A consultation please");
      google.revokeRefreshToken(f.refreshToken);
      expect(await say("The first one, I'm Gus, 415 555 0155")).toBe(forChat(REQUEST_TAKEN_LINE));
      const { requests, appointments } = await rows(f.clinicId);
      expect(appointments).toEqual([]);
      expect(requests).toEqual([expect.objectContaining({ status: "requested", channel: "web_chat" })]);
      // Manual booking from here: the model's own words, no tools on offer, and no second request.
      expect(await say("Thanks")).toBe("The team will confirm your time within a day.");
      expect(seen[2]!.system.stable).not.toContain("find_times");
      expect((await rows(f.clinicId)).requests).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "web chat: a tool failure hands the chat to the request flow, so the details it offers to take are filed for the desk",
    async () => {
      const f = await location("tools-failure");
      const { responder, seen } = scripted([
        () => ({ reply: "Looking.", booking: { wants: true, service: "Consultation" }, action: { type: "find_times", service: "Consultation", day: "" } }),
        () => ({
          reply: "Thanks Ida. The team will confirm Friday morning within a day.",
          booking: { wants: true, first_name: "Ida", phone: "+14155550133", window: "Friday morning", service: "Consultation" },
        }),
      ]);
      const say = await chat(f.web, responder);
      // Google answers 500 to every free/busy read of this turn.
      google.failNext({ on: "freeBusy", status: 500, times: 20 });
      // BOOK-01 (main): the chat says it will take the time as a request, not the failure line.
      expect(await say("A consultation please")).toBe(forChat(MANUAL_BOOKING_LINE));
      expect(await say("Friday morning, I'm Ida, 415 555 0133")).toBe("Thanks Ida. The team will confirm Friday morning within a day.");
      // The request flow from here: no tools on offer, and the desk has the request.
      expect(seen[1]!.system.stable).not.toContain("find_times");
      const { requests, holds } = await rows(f.clinicId);
      expect(holds).toEqual([]);
      expect(requests).toEqual([expect.objectContaining({ status: "requested", channel: "web_chat", vendor_call_id: null })]);
    },
    SLOW,
  );

  test.each([
    ["the owner's switch off", () => delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED],
    ["counsel's addendum not released", () => (state.addendum = false)],
  ])(
    "%s: no tools offered, an action the model asks for is ignored, and the request is taken in words as before",
    async (_label, off) => {
      off();
      const f = await location(`tools-off-${randomUUID().slice(0, 4)}`);
      const { responder, seen } = scripted([
        () => ({
          reply: "Thanks Hana. I'll pass Thursday morning to the team, who will confirm within a day.",
          booking: { wants: true, first_name: "Hana", phone: "+14155550144", window: "Thursday morning", service: "Consultation" },
          action: { type: "find_times", service: "Consultation", day: "" },
        }),
      ]);
      const say = await chat(f.web, responder);
      expect(await say("Thursday morning, Hana, 415 555 0144")).toBe("Thanks Hana. I'll pass Thursday morning to the team, who will confirm within a day.");
      expect(seen[0]!.system.stable).not.toContain("find_times");
      expect(seen[0]!.system.turn).not.toContain("Live booking");
      expect(google.requests).toHaveLength(0);
      const { requests, holds } = await rows(f.clinicId);
      expect(holds).toEqual([]);
      expect(requests).toEqual([expect.objectContaining({ status: "requested", channel: "web_chat", vendor_call_id: null })]);
    },
    SLOW,
  );

  test(
    "a model that says a booking is made, with no booking from the tool layer, is refused by the guard",
    async () => {
      const f = await location("tools-claim");
      const { responder } = scripted([() => ({ reply: "You're booked for Thursday at 10am.", booking: { wants: true } })]);
      const say = await chat(f.web, responder);
      expect(await say("Book me Thursday at 10")).toBe(guardedLine("booking_confirmation", f.web.name));
      expect((await rows(f.clinicId)).appointments).toEqual([]);
      expect(inserts()).toHaveLength(0);
    },
    SLOW,
  );

  // ---------------------------------------------------------------------------
  // Deposits (DEPOSIT-01)
  // ---------------------------------------------------------------------------

  describe("deposits", () => {
    const ACCOUNT = "acct_1ToolsDeposit";
    const HOLD_MINUTES = 90;
    let fake: StripeFake;
    let sessions = 0;
    /** Session ids are unique in the database across tests. */
    let run = "";

    beforeEach(() => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_tools");
      sessions = 0;
      run = randomUUID().slice(0, 8);
      fake = createStripeFake({
        "checkout.sessions.create": (params: unknown) => {
          sessions += 1;
          return {
            id: `cs_test_${run}_${sessions}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_${run}_${sessions}`,
            status: "open",
            expires_at: (params as { expires_at: number }).expires_at,
          };
        },
        "checkout.sessions.retrieve": (id: unknown) => ({
          id,
          url: `https://checkout.stripe.com/c/pay/${String(id)}`,
          status: "open",
          payment_status: "unpaid",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        "checkout.sessions.expire": (id: unknown) => ({ id, status: "expired" }),
      });
      __setStripeForTests(fake.stripe);
    });

    afterEach(() => {
      __setStripeForTests(null);
      vi.unstubAllEnvs();
    });

    /** A live location whose Facial needs a $50 deposit, with deposits on and, unless `connected` is false, its own Stripe connected. */
    async function depositLocation(label: string, options: { connected?: boolean } = {}) {
      const f = await location(label);
      await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
        await updateAgentConfig(tx, {
          greeting: "Hi",
          services: [
            { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
            { name: "Facial", priceFromUsd: 100, priceToUsd: 100, durationMinutes: 60, depositUsd: 50 },
          ],
          escalationPhone: null,
          escalationHours: "Weekdays 9 to 5",
          notes: null,
          depositPolicy: null,
        });
        await approveAgentConfig(tx, "Dr Chen");
      });
      if (options.connected !== false) {
        await getMigratorPool().query(
          `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = now() where id = $1`,
          [f.clinicId, ACCOUNT],
        );
      }
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, deposits_enabled, deposit_hold_minutes) values ($1, $2, $3)
           on conflict (clinic_id) do update set deposits_enabled = excluded.deposits_enabled, deposit_hold_minutes = excluded.deposit_hold_minutes`,
          [f.clinicId, options.connected !== false, HOLD_MINUTES],
        ),
      );
      return f;
    }

    const booking = (f: DeskLocation, channel: "voice" | "web_chat", at: Date, key = randomUUID()) => {
      const holder = channel === "voice" ? `retell:${key}` : `web:${key}`;
      const iso = at.toISOString();
      return bookingTools({ clinicId: f.clinicId, channel, holderKey: holder, bookingKey: `${holder}:1`, conversationId: null, timeZone: DESK_TZ, actor: ACTOR, budgetMs: 15_000 }).run({
        action: { type: "choose_time", at: iso },
        capture: { ...EMPTY_CAPTURE, firstName: "Ivy", phone: "+14155550133" },
        state: { ...EMPTY_TOOL_STATE, service: "Facial", offered: [{ at: iso, providerId: null }] },
        callerPhone: "+14155550133",
        now: new Date(),
      });
    };

    const appointment = async (clinicId: string) =>
      (
        await inTenant(clinicId, (client) =>
          client.query<{ id: string; deposit_status: string; deposit_usd: string | null }>(`select id, deposit_status, deposit_usd from appointments`),
        )
      ).rows;

    test(
      "web chat: booked first, then the clinic's own link once, in fixed words; Stripe sees an amount, a generic name and an opaque reference, never the service; the expiry clamped to the clinic's hold",
      async () => {
        const f = await depositLocation("dep-web");
        const at = deskTime(3, 11);
        const key = randomUUID();
        const before = Date.now();
        const first = await booking(f, "web_chat", at, key);
        const url = `https://checkout.stripe.com/c/pay/cs_test_${run}_1`;
        expect(first).toMatchObject({ bookingWritten: true });
        expect(first!.reply).toBe(`${forChat(bookedLine(slotLabel(at, DESK_TZ), "Facial"))} ${depositLinkText(url)}`);

        const [row] = await appointment(f.clinicId);
        expect(row).toMatchObject({ deposit_status: "pending_link", deposit_usd: "50.00" });

        // Exactly what went to Stripe, on the clinic's own account.
        const created = fake.callsTo("checkout.sessions.create");
        expect(created).toHaveLength(1);
        const [params, requestOptions] = created[0]!.args as [Record<string, unknown>, Record<string, unknown>];
        const { rows: deposits } = await inTenant(f.clinicId, (client) =>
          client.query<{ id: string; expires_at: Date }>(`select id, expires_at from deposit_payments`),
        );
        const ref = deposits[0]!.id;
        expect(params).toEqual({
          mode: "payment",
          payment_method_types: ["card"],
          line_items: [{ price_data: { currency: "usd", unit_amount: 5000, product_data: { name: "Appointment deposit" } }, quantity: 1 }],
          payment_intent_data: { statement_descriptor_suffix: "DEPOSIT", metadata: { hd: "deposit", ref } },
          client_reference_id: ref,
          metadata: { hd: "deposit", ref },
          expires_at: Math.floor(deposits[0]!.expires_at.getTime() / 1000),
          success_url: "https://app.healdesk.test/deposit/thanks",
          cancel_url: "https://app.healdesk.test/deposit/cancelled",
        });
        expect(JSON.stringify(params)).not.toMatch(/facial|consultation|ivy|4155550133/i);
        expect(requestOptions).toMatchObject({ stripeAccount: ACCOUNT, idempotencyKey: `hd-deposit:${ref}` });
        // The clinic's 90-minute hold, inside Stripe's window.
        const expiry = deposits[0]!.expires_at.getTime();
        expect(expiry).toBeGreaterThanOrEqual(clampDepositExpiry(new Date(before), HOLD_MINUTES).getTime() - 1000);
        expect(expiry).toBeLessThanOrEqual(clampDepositExpiry(new Date(), HOLD_MINUTES).getTime() + 1000);

        // A repeated tool call: the same booking, the same link, no second session.
        const again = await booking(f, "web_chat", at, key);
        expect(again!.reply).toBe(first!.reply);
        expect(fake.callsTo("checkout.sessions.create")).toHaveLength(1);
        expect(await appointment(f.clinicId)).toHaveLength(1);
        expect(await queuedNotices(f.clinicId, ["deposit_to_collect"])).toEqual([]);
      },
      SLOW,
    );

    test(
      "voice: the same service is booked and its deposit said and flagged for staff, never a link, and Stripe is never called",
      async () => {
        const f = await depositLocation("dep-voice");
        const at = deskTime(3, 13);
        const said = await booking(f, "voice", at);
        expect(said).toMatchObject({ bookingWritten: true });
        expect(said!.reply).toBe(`${bookedLine(slotLabel(at, DESK_TZ), "Facial")} ${depositLine({ action: "book_and_flag", amountUsd: 50, scope: "booking" })}`);
        expect(said!.reply).not.toMatch(/https?:|link/i);
        expect(fake.calls).toEqual([]);
        expect(await appointment(f.clinicId)).toEqual([expect.objectContaining({ deposit_status: "pending_front_desk", deposit_usd: "50.00" })]);
        expect((await queuedNotices(f.clinicId, ["deposit_to_collect"])).length).toBe(1);
      },
      SLOW,
    );

    test(
      "web chat: a link that cannot be made leaves the deposit to the front desk, says so, and alerts the clinic once",
      async () => {
        const f = await depositLocation("dep-refused");
        fake.on("checkout.sessions.create", () => {
          throw stripeError("api", { message: "synthetic outage" });
        });
        const at = deskTime(4, 9);
        const key = randomUUID();
        const said = await booking(f, "web_chat", at, key);
        expect(said).toMatchObject({ bookingWritten: true });
        expect(said!.reply).toBe(
          `${forChat(bookedLine(slotLabel(at, DESK_TZ), "Facial"))} ${forChat(depositLine({ action: "book_and_flag", amountUsd: 50, scope: "booking" }))}`,
        );
        expect(said!.reply).not.toMatch(/https?:/);
        expect(await appointment(f.clinicId)).toEqual([expect.objectContaining({ deposit_status: "pending_front_desk" })]);
        expect((await queuedNotices(f.clinicId, ["deposit_to_collect"])).length).toBe(1);
        // Asked again: the same words, no second alert.
        expect((await booking(f, "web_chat", at, key))!.reply).toBe(said!.reply);
        expect((await queuedNotices(f.clinicId, ["deposit_to_collect"])).length).toBe(1);
      },
      SLOW,
    );

    test(
      "a clinic with no connected Stripe: no deposit can be due (D's first rule), so the chat books with no link and Stripe is never called",
      async () => {
        const f = await depositLocation("dep-unconnected", { connected: false });
        const at = deskTime(4, 15);
        const said = await booking(f, "web_chat", at);
        expect(said!.reply).toBe(forChat(bookedLine(slotLabel(at, DESK_TZ), "Facial")));
        expect(fake.calls).toEqual([]);
        expect(await appointment(f.clinicId)).toEqual([expect.objectContaining({ deposit_status: "none", deposit_usd: null })]);
      },
      SLOW,
    );

    test.each(["checkout.session.expired", "checkout.session.async_payment_failed"] as const)(
      "%s on a chat's link: the deposit moves to the front desk with its alert",
      async (type) => {
        const f = await depositLocation(`dep-${type.endsWith("expired") ? "expired" : "failed"}`);
        const said = await booking(f, "web_chat", deskTime(5, 11));
        expect(said!.reply).toContain(`https://checkout.stripe.com/c/pay/cs_test_${run}_1`);
        const { rows: deposits } = await inTenant(f.clinicId, (client) =>
          client.query<{ id: string; checkout_session_id: string }>(`select id, checkout_session_id from deposit_payments`),
        );
        const result = await handleConnectEvent({
          id: `evt_${randomUUID().replace(/-/g, "")}`,
          type,
          account: ACCOUNT,
          livemode: false,
          data: { object: { id: deposits[0]!.checkout_session_id, client_reference_id: deposits[0]!.id, metadata: { hd: "deposit", ref: deposits[0]!.id } } },
        } as unknown as Parameters<typeof handleConnectEvent>[0]);
        expect(result.outcome).toBe("processed");
        expect(await appointment(f.clinicId)).toEqual([expect.objectContaining({ deposit_status: "pending_front_desk" })]);
        expect((await queuedNotices(f.clinicId, ["deposit_to_collect"])).length).toBe(1);
      },
      SLOW,
    );
  });
});

/**
 * The tool layer alone, on an engine that answers as told: what is said when
 * the engine holds nothing, and when it fails.
 */
describe("the booking tool layer's lines, on a scripted engine", () => {
  const at = "2026-11-03T15:00:00.000Z";
  const context = {
    clinicId: randomUUID(),
    channel: "voice" as const,
    holderKey: "retell:call_unit",
    bookingKey: "retell:call_unit:1",
    conversationId: null,
    timeZone: "America/Los_Angeles",
    actor: ACTOR,
    budgetMs: 6_000,
  };
  const chosenState: BookingToolState = { ...EMPTY_TOOL_STATE, service: "Consultation", offered: [{ at, providerId: null }] };

  function engine(overrides: Partial<BookingEngine>): BookingEngine {
    const never = () => {
      throw new Error("not expected");
    };
    return { offerTimes: never, placeHold: never, bookConversation: never, chatDepositFor: never, ...overrides } as BookingEngine;
  }

  // The English shapes of a time not held and a time held are main's
  // voice-held-wording.test.ts (BOOK-01), which covers every reason; here,
  // only that a Spanish call hears the same request, in Spanish.
  test("a Spanish call whose time the engine will not hold hears the Spanish request line, never the hold", async () => {
    const tools = bookingTools(context, engine({ placeHold: async () => ({ kind: "request_only", reasons: ["deposit_required"] }) }));
    const said = await tools.run({ action: { type: "choose_time", at }, capture: EMPTY_CAPTURE, state: chosenState, callerPhone: PHONE, now: new Date("2026-11-01T12:00:00Z"), language: "es" });
    expect(said!.reply).toBe(BOOKING_LINES_ES.requestAsk("first_name", true));
    expect(said!.reply).not.toContain(BOOKING_LINES_ES.hold);
    expect(said!.state.held).toBe(false);
  });

  test("a call in Spanish hears the Spanish hold line, times and booked line; the deposit is said in Spanish, never a link", async () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const tools = bookingTools(
      context,
      engine({
        offerTimes: async () => ({ status: "ok", timeZone: context.timeZone, serviceMinutes: 30, canonicalService: "Consultation", slots: [{ at: new Date(at), providerId: null }] }) as never,
        placeHold: async () => ({ kind: "held", holdId: randomUUID(), expiresAt: new Date(), startsAt: new Date(at), minutes: 30, providerId: null }),
        bookConversation: async () =>
          ({ kind: "booked", startsAt: new Date(at), minutes: 30, canonicalService: "Consultation", providerId: null, replayed: false, appointmentId: randomUUID(), requestId: randomUUID(), deposit: { action: "book_and_flag", amountUsd: 50 } }) as never,
      }),
    );
    const offered = await tools.run({ action: { type: "find_times", service: "Consultation", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now, language: "es" });
    expect(offered!.reply).toBe(`Tengo el ${spokenSlotEs(new Date(at), context.timeZone)}. ¿Cuál le viene mejor?`);
    expect(offered!.reply).toBe("Tengo el martes 3 de noviembre a las siete de la mañana. ¿Cuál le viene mejor?");
    const held = await tools.run({ action: { type: "choose_time", at }, capture: EMPTY_CAPTURE, state: offered!.state, callerPhone: PHONE, now, language: "es" });
    expect(held!.reply).toBe(BOOKING_LINES_ES.heldAsk("first_name"));
    const booked = await tools.run({ action: null, capture: { ...EMPTY_CAPTURE, firstName: "Ana" }, state: held!.state, callerPhone: PHONE, now, language: "es" });
    expect(booked!.reply).toBe(
      "Su cita está reservada para el martes 3 de noviembre a las siete de la mañana para Consultation. Está en el calendario de la clínica. Se requiere un depósito de 50 dólares para reservar la cita. La recepción le llamará para cobrarlo; no se cobra nada en esta llamada.",
    );
    expect(booked!.reply).not.toMatch(/https?:|link/i);
    // English, or no language, is the English line byte for byte.
    const english = await tools.run({ action: { type: "find_times", service: "Consultation", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now });
    expect(english!.reply).toBe(`I have ${slotLabel(new Date(at), context.timeZone)}. Which would suit you?`);
  });

  test("the website chat stays English whatever language is passed, and the English set is the English lines themselves", async () => {
    const tools = bookingTools({ ...context, channel: "web_chat" }, engine({ offerTimes: async () => ({ status: "unavailable" }) as never }));
    const said = await tools.run({ action: { type: "find_times", service: "Consultation", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now: new Date(), language: "es" });
    // A failed find_times on the chat is taken as a request (BOOK-01), in English.
    expect(said!.reply).toBe(forChat(MANUAL_BOOKING_LINE));
    expect(BOOKING_LINES_EN.toolFailure).toBe(TOOL_FAILURE_LINE);
    expect(BOOKING_LINES_EN.refused).toBe(BOOKING_REFUSED_LINE);
    expect(BOOKING_LINES_EN.requestAsk("phone", true)).toBe(requestAskLine("phone", true));
    expect(BOOKING_LINES_EN.booked("Tue 3 Nov, 7:00 AM", null)).toBe(bookedLine("Tue 3 Nov, 7:00 AM", null));
    // Every Spanish line differs from its English one: none was left untranslated.
    for (const key of ["manual", "hold", "noFreeTime", "requestTaken", "depositHold", "depositRequest", "oneRequestPerCall", "inProgress", "toolFailure", "refused"] as const) {
      expect(BOOKING_LINES_ES[key], key).not.toBe(BOOKING_LINES_EN[key]);
    }
  });

  test("a tool failure on a call says the failure line, in the call's language, and leaves the tools on", async () => {
    // BOOK-01 (main): only the website chat turns to taking a request in
    // words when find_times fails (booking-tools-calendar-failure.test.ts);
    // a call keeps its tools and offers the clinic or the details.
    const tools = bookingTools(context, engine({ offerTimes: async () => ({ status: "unavailable" }) as never }));
    const said = await tools.run({ action: { type: "find_times", service: "Consultation", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now: new Date() });
    expect(said!.reply).toBe(TOOL_FAILURE_LINE);
    expect(said!.state.manual).toBe(false);
    const spanish = await tools.run({ action: { type: "find_times", service: "Consultation", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now: new Date(), language: "es" });
    expect(spanish!.reply).toBe(BOOKING_LINES_ES.toolFailure);
  });
});
