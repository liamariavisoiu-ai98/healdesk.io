import { describe, expect, test, vi } from "vitest";

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import { EMPTY_CAPTURE } from "@/lib/assistant/turn";
import type { assistantMayAnswer } from "@/lib/billing/answering";
import { forChat, TOOL_FAILURE_LINE } from "@/lib/booking/lines";

/**
 * Where two fixes meet. The answer gate (a pause or cap stops the write) and
 * the website chat's request-on-failure (a calendar that cannot book still
 * leaves the visitor's request with the desk) each keep a promise alone; the
 * gate failing to answer is the one case that touches both. A gate that
 * cannot be read means nobody knows whether the clinic may answer, so nothing
 * is written for it: no booking, and no request logged for the desk either. No
 * database: fake engine and gate.
 */

const ACTOR = { type: "service", serviceName: "booking-tools-combined-test" } as const;
const NOW = new Date("2026-10-22T16:00:00Z");
const AT = "2026-10-26T17:00:00.000Z";
const CONVERSATION = "11111111-2222-4333-8444-555555555555";

const CHOSEN: BookingToolState = { ...EMPTY_TOOL_STATE, offered: [{ at: AT, providerId: null }], chosen: { at: AT, providerId: null }, held: true };
const CAPTURE = { ...EMPTY_CAPTURE, firstName: "Ada", phone: "+14155550188" };

function setup(channel: "web_chat" | "voice") {
  const logRequest = vi.fn(async () => ({ kind: "request_logged" as const, replayed: false, requestId: "req-1" }));
  // The real engine asks the gate inside bookConversation and lets a failure out.
  const bookConversation = vi.fn(async (_clinicId: string, input: { gate?: () => Promise<boolean> }) => {
    if (input.gate) await input.gate();
    throw new Error("the gate answered, so the write was reached");
  });
  const engine = { offerTimes: vi.fn(), placeHold: vi.fn(), chatDepositFor: vi.fn(), bookConversation, logRequest } as unknown as BookingEngine;
  const gate = vi.fn(async () => {
    throw new Error("database down");
  }) as unknown as typeof assistantMayAnswer;
  const holder = channel === "voice" ? "retell:call-1" : `web:${CONVERSATION}`;
  const tools = bookingTools(
    { clinicId: "clinic-1", channel, holderKey: holder, bookingKey: `${holder}:1`, conversationId: channel === "voice" ? null : CONVERSATION, timeZone: "America/Los_Angeles", actor: ACTOR, budgetMs: 15_000 },
    engine,
    gate,
  );
  return { tools, logRequest };
}

describe("a gate that cannot be read, with the website chat's request-on-failure", () => {
  test("web chat: nothing is written and no request is logged; the failure line is said", async () => {
    const { tools, logRequest } = setup("web_chat");
    const turn = await tools.run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
    expect(logRequest).not.toHaveBeenCalled();
    expect(turn?.bookingWritten).toBe(false);
    expect(turn?.requestId).toBeNull();
    expect(turn?.state.done).toBeNull();
    expect(turn?.reply).toBe(forChat(TOOL_FAILURE_LINE));
  });

  test("a call: the same, with the failure line as said on a call", async () => {
    const { tools, logRequest } = setup("voice");
    const turn = await tools.run({ action: null, capture: CAPTURE, state: CHOSEN, now: NOW });
    expect(logRequest).not.toHaveBeenCalled();
    expect(turn?.bookingWritten).toBe(false);
    expect(turn?.reply).toBe(TOOL_FAILURE_LINE);
  });
});
