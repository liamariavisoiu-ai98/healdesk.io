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

import { bookingTools, EMPTY_TOOL_STATE, type BookingToolState } from "@/lib/assistant/booking-tools";
import { guardedLine } from "@/lib/assistant/guard";
import { EMPTY_CAPTURE, type AssistantPrompt, type AssistantResponder } from "@/lib/assistant/turn";
import type { AnswerDecision } from "@/lib/billing/answering";
import { slotLabel } from "@/lib/booking/calendar";
import { bookedLine, detailsBeforeHoldLine, forChat, heldAskLine, REQUEST_TAKEN_LINE } from "@/lib/booking/lines";
import { sendWebChatMessage, startWebChat, type WebChatClinic } from "@/lib/chat/web-chat";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";
import type { IngestResult, VoiceCallEvent } from "@/lib/voice/ingest";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { DESK_TZ, deskLocation, deskTime, freshGoogle, installGoogleEnv, restoreGoogleEnv, type DeskLocation } from "./setup/desk-calendar";
import { bindAgreementInEffect, inTenant, seedEntitled } from "./setup/factories";
import { attestPlatform } from "./setup/platform";

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

  /** A live location (covered terms, Google connected, production, script approved) that has bought the web chat. */
  async function location(label: string): Promise<DeskLocation & { web: WebChatClinic }> {
    const f = await deskLocation(google, label);
    await bindAgreementInEffect(f.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [f.clinicId],
    );
    await seedEntitled(f.clinicId, { planId: "webchat-1000", planStartedAt: WINDOW_START, channelRows: [{ channel: "web", liveAt: WINDOW_START }] });
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
});
