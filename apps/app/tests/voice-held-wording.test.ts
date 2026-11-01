import { describe, expect, test, vi } from "vitest";

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import type { BookConversationResult, PlacedHold } from "@/lib/booking/engine";
import { BOOKING_LINES_VOICE_EN, DEPOSIT_REQUEST_LINE, HOLD_LINE, REQUEST_TAKEN_LINE } from "@/lib/booking/lines";
import { EMPTY_CAPTURE } from "@/lib/assistant/turn";
import { spokenSlotEn } from "@/lib/voice/spoken";

/**
 * What a caller hears when they choose a time on a call (booking-tools.ts,
 * the voice hold). The spec says the slot is held for 60 seconds before
 * anything confirming is said, and a time the assistant cannot book is a
 * request staff confirm. A location with Auto-confirm off still offers real
 * free times (mode.ts, canOfferTimes), so placeHold answers `request_only`
 * and holds nothing: the caller must not be told the time is held.
 *
 * The engine is a fake: no database, no Google. Only run() is exercised.
 */

const TZ = "America/Los_Angeles";
const SLOT = new Date("2026-11-03T17:00:00Z");
const CALLER = "+14155550188";
const ACTOR = { type: "service", serviceName: "voice-held-wording-test" } as const;

function engineWith(hold: PlacedHold, booked: BookConversationResult) {
  const placeHold = vi.fn(async () => hold);
  const bookConversation = vi.fn(async () => booked);
  const engine: BookingEngine = {
    offerTimes: vi.fn(async () => ({ status: "ok" as const, timeZone: TZ, serviceMinutes: 30, canonicalService: null, slots: [{ at: SLOT, providerId: null }] })),
    placeHold,
    bookConversation,
    chatDepositFor: vi.fn(),
  } as unknown as BookingEngine;
  return { engine, placeHold, bookConversation };
}

function voiceTools(engine: BookingEngine) {
  return bookingTools(
    {
      clinicId: "00000000-0000-4000-8000-000000000001",
      channel: "voice",
      holderKey: "retell:call-1",
      bookingKey: "retell:call-1:1",
      conversationId: null,
      timeZone: TZ,
      actor: ACTOR,
      budgetMs: 1_000,
    },
    engine,
  );
}

const OFFERED: BookingToolState = { ...EMPTY_TOOL_STATE, offered: [{ at: SLOT.toISOString(), providerId: null }], service: "consultation" };
const NOW = new Date("2026-11-01T17:00:00Z");
const REQUEST: BookConversationResult = { kind: "request_logged", reason: "manual", replayed: false, deposit: null, requestId: "req-1" };

/** Any word that tells the caller a time is kept for them. */
const KEPT = /\b(?:held|hold(?:ing)?|reserved|booked|confirmed|secured)\b/i;

describe("voice: choosing a time the engine will not hold", () => {
  for (const [label, reasons, line] of [
    ["Auto-confirm off", ["auto_confirm_off"], BOOKING_LINES_VOICE_EN.manual],
    ["the owner's kill switch", ["kill_switch_off"], BOOKING_LINES_VOICE_EN.manual],
    ["a broken calendar", ["calendar_broken"], BOOKING_LINES_VOICE_EN.manual],
    ["a deposit the call cannot take", ["deposit_required"], DEPOSIT_REQUEST_LINE],
  ] as const) {
    test(`${label}: the caller is never told the time is held, and is told it is a request`, async () => {
      const { engine, placeHold, bookConversation } = engineWith({ kind: "request_only", reasons: [...reasons] }, REQUEST);
      const tools = voiceTools(engine);

      const chose = await tools.run({ action: { type: "choose_time", at: SLOT.toISOString() }, capture: EMPTY_CAPTURE, state: OFFERED, callerPhone: CALLER, now: NOW });
      expect(placeHold).toHaveBeenCalledTimes(1);
      expect(bookConversation).not.toHaveBeenCalled();
      expect(chose).not.toBeNull();
      expect(chose!.reply).not.toContain(HOLD_LINE);
      expect(chose!.reply.replace(/hold the appointment/g, "")).not.toMatch(KEPT);
      expect(chose!.reply.startsWith(line)).toBe(true);
      expect(chose!.state.held).toBe(false);
      expect(chose!.bookingWritten).toBe(false);

      // The name arrives: no second hold is tried, and the request is logged and said as one.
      const named = await tools.run({ action: null, capture: { ...EMPTY_CAPTURE, firstName: "Sam" }, state: chose!.state, callerPhone: CALLER, now: NOW });
      expect(placeHold).toHaveBeenCalledTimes(1);
      expect(bookConversation).toHaveBeenCalledTimes(1);
      expect(named!.reply).toBe(REQUEST_TAKEN_LINE);
    });
  }

  test("a real hold is still said as held", async () => {
    const hold: PlacedHold = { kind: "held", holdId: "h-1", expiresAt: new Date(NOW.getTime() + 60_000), startsAt: SLOT, minutes: 30, providerId: null };
    const { engine } = engineWith(hold, REQUEST);
    const chose = await voiceTools(engine).run({ action: { type: "choose_time", at: SLOT.toISOString() }, capture: EMPTY_CAPTURE, state: OFFERED, callerPhone: CALLER, now: NOW });
    expect(chose!.reply).toBe(BOOKING_LINES_VOICE_EN.heldAsk("first_name", spokenSlotEn(SLOT, TZ)));
    expect(chose!.state.held).toBe(true);
  });
});
