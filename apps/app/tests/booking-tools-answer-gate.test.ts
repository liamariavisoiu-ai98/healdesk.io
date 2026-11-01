import { describe, expect, test, vi } from "vitest";

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import { EMPTY_CAPTURE } from "@/lib/assistant/turn";
import type { AnswerDecision, assistantMayAnswer } from "@/lib/billing/answering";
import { slotLabel } from "@/lib/booking/calendar";
import { spokenSlotEn } from "@/lib/voice/spoken";
import type { BookConversationInput, BookConversationResult } from "@/lib/booking/engine";
import { bookedLine, BOOKING_REFUSED_LINE, forChat } from "@/lib/booking/lines";

/**
 * The booking tool layer asks B's answer gate (assistantMayAnswer) before
 * anything is written (book.ts, step 1): a clinic paused, or stopped at its
 * allowance, mid-conversation must not get a booking in its calendar, and
 * the person is pointed to the clinic with a fixed line. No database: the
 * engine and the gate are fakes; the engine's own handling of the gate (asked
 * after the replay, nothing written on false) is book.ts's, and this fake
 * keeps to it.
 */

const ACTOR = { type: "service", serviceName: "booking-tools-answer-gate-test" } as const;
const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-22T16:00:00Z");
const AT = "2026-10-23T17:00:00.000Z";
const CLINIC = "00000000-0000-4000-8000-000000000001";

const ANSWER: AnswerDecision = { decision: "answer" };
const PAUSED: AnswerDecision = { decision: "pass_through", reason: "ai_paused", fallback: "direct_line", directLine: "+14155550111" };
const CAPPED: AnswerDecision = { decision: "pass_through", reason: "allowance_cap", fallback: "contact_form", directLine: null };

/** An engine that keeps book.ts's order: a replay first, then the gate, then the write. */
function fakeEngine(options: { replay?: boolean } = {}) {
  const writes: Date[] = [];
  const gateAsked = { count: 0 };
  const engine: BookingEngine = {
    offerTimes: vi.fn(),
    placeHold: vi.fn(async () => ({ kind: "held" }) as never),
    chatDepositFor: vi.fn(async () => ({ kind: "none" }) as never),
    logRequest: vi.fn(async () => ({ kind: "request_logged", replayed: false, requestId: "req-1" }) as never),
    bookConversation: vi.fn(async (_clinicId: string, input: BookConversationInput): Promise<BookConversationResult> => {
      const booked: BookConversationResult = { kind: "booked", startsAt: input.startsAt, minutes: 30, canonicalService: null, providerId: null, replayed: Boolean(options.replay), appointmentId: "appt-1", requestId: "req-1", deposit: null };
      if (options.replay) return booked;
      if (input.gate) {
        gateAsked.count += 1;
        if (!(await input.gate())) return { kind: "refused" };
      }
      writes.push(input.startsAt);
      return booked;
    }),
  };
  return { engine, writes, gateAsked };
}

function gateAnswering(decision: AnswerDecision) {
  const calls: Parameters<typeof assistantMayAnswer>[0][] = [];
  const gate = vi.fn(async (input: Parameters<typeof assistantMayAnswer>[0]) => {
    calls.push(input);
    return decision;
  }) as unknown as typeof assistantMayAnswer;
  return { gate, calls };
}

const CHOSEN: BookingToolState = { ...EMPTY_TOOL_STATE, offered: [{ at: AT, providerId: null }], chosen: { at: AT, providerId: null }, held: true };
const CAPTURE = { ...EMPTY_CAPTURE, firstName: "Ada", phone: "+14155550188" };

function tools(channel: "voice" | "web_chat", engine: BookingEngine, gate: typeof assistantMayAnswer, answering?: { continuing?: boolean; usage?: { source: "web_chat"; sourceRef: string } }) {
  const holder = channel === "voice" ? "retell:call-1" : "web:conv-1";
  return bookingTools(
    { clinicId: CLINIC, channel, holderKey: holder, bookingKey: `${holder}:1`, conversationId: null, timeZone: TZ, actor: ACTOR, budgetMs: 15_000, answering },
    engine,
    gate,
  );
}

describe("the booking tool layer and the answer gate", () => {
  for (const channel of ["voice", "web_chat"] as const) {
    test(`${channel}: a paused clinic gets no booking, and the person is pointed to the clinic`, async () => {
      const { engine, writes, gateAsked } = fakeEngine();
      const { gate, calls } = gateAnswering(PAUSED);
      const turn = await tools(channel, engine, gate).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
      expect(gateAsked.count).toBe(1);
      expect(writes).toEqual([]);
      expect(turn?.bookingWritten).toBe(false);
      expect(turn?.appointmentId).toBeNull();
      expect(turn?.reply).toBe(channel === "web_chat" ? forChat(BOOKING_REFUSED_LINE) : BOOKING_REFUSED_LINE);
      // The tools are not offered again in this conversation.
      expect(turn?.state.manual).toBe(true);
      expect(turn?.state.done).toBeNull();
      expect(calls[0]).toMatchObject({ clinicId: CLINIC, channel: channel === "voice" ? "voice" : "web", now: NOW, actor: ACTOR });
    });

    test(`${channel}: a clinic stopped at its allowance gets no booking either`, async () => {
      const { engine, writes } = fakeEngine();
      const { gate } = gateAnswering(CAPPED);
      const turn = await tools(channel, engine, gate).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
      expect(writes).toEqual([]);
      expect(turn?.bookingWritten).toBe(false);
      expect(turn?.reply).toBe(channel === "web_chat" ? forChat(BOOKING_REFUSED_LINE) : BOOKING_REFUSED_LINE);
    });

    test(`${channel}: a clinic the gate answers books as before`, async () => {
      const { engine, writes } = fakeEngine();
      const { gate } = gateAnswering(ANSWER);
      const turn = await tools(channel, engine, gate).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
      expect(writes).toEqual([new Date(AT)]);
      expect(turn?.bookingWritten).toBe(true);
      expect(turn?.reply).toBe(bookedLine(channel === "voice" ? spokenSlotEn(new Date(AT), TZ) : slotLabel(new Date(AT), TZ), null));
    });

    test(`${channel}: a booking already made is answered as it was, paused now or not`, async () => {
      const { engine, gateAsked } = fakeEngine({ replay: true });
      const { gate } = gateAnswering(PAUSED);
      const turn = await tools(channel, engine, gate).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
      // The tool layer leaves the gate to the engine, after its replay.
      expect(gateAsked.count).toBe(0);
      expect(turn?.bookingWritten).toBe(true);
      expect(turn?.reply).toBe(bookedLine(channel === "voice" ? spokenSlotEn(new Date(AT), TZ) : slotLabel(new Date(AT), TZ), null));
    });
  }

  test("the adapter's usage reference and continuing flag reach the gate, so an admitted conversation is not cut off by the cap", async () => {
    const { engine } = fakeEngine();
    const { gate, calls } = gateAnswering(ANSWER);
    const usage = { source: "web_chat" as const, sourceRef: "ref-1" };
    await tools("web_chat", engine, gate, { usage }).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
    await tools("voice", engine, gate, { continuing: true }).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
    expect(calls[0]).toMatchObject({ channel: "web", usage });
    expect(calls[1]).toMatchObject({ channel: "voice", continuing: true });
  });

  test("a gate that fails writes nothing and says the failure line", async () => {
    const { engine, writes } = fakeEngine();
    const gate = vi.fn(async () => {
      throw new Error("database down");
    }) as unknown as typeof assistantMayAnswer;
    const turn = await tools("voice", engine, gate).run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
    expect(writes).toEqual([]);
    expect(turn?.bookingWritten).toBe(false);
  });
});
