import { describe, expect, test, vi } from "vitest";

/**
 * The website chat after a calendar failure (FINDING 2 on BOOK-01): when
 * the engine cannot book a visitor who has chosen a time and given a name
 * and a number (Google's re-check failing transiently, the hold lapsing,
 * or anything throwing), the visitor's request still reaches the desk.
 * It is logged under the conversation's booking key (logRequest, which
 * raises booking_request, L7, and is idempotent on that key), and the
 * visitor is told the clinic will confirm, never that they are booked.
 *
 * Before the fix the tool layer answered TOOL_FAILURE_LINE and kept the
 * tools live, so the chat filed nothing for the desk (web-chat.ts files
 * the capture only while the tools are off) and every later message
 * failed the same way: the visitor's details went nowhere.
 *
 * The engine is a fake: no database, no Google.
 */

const state = vi.hoisted(() => ({ addendum: true }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: state.addendum }),
  };
});

import { bookingTools, EMPTY_TOOL_STATE, type BookingEngine, type BookingToolState } from "@/lib/assistant/booking-tools";
import { EMPTY_CAPTURE } from "@/lib/assistant/turn";
import { slotLabel } from "@/lib/booking/calendar";
import { forChat, MANUAL_BOOKING_LINE, REQUEST_TAKEN_LINE, TOOL_FAILURE_LINE } from "@/lib/booking/lines";

const TZ = "America/Los_Angeles";
const ACTOR = { type: "service", serviceName: "booking-tools-failure-test" } as const;
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const AT = "2026-10-26T17:00:00.000Z";
const NOW = new Date("2026-10-22T16:00:00Z");

function engine(overrides: Partial<BookingEngine>): BookingEngine & { logRequest: ReturnType<typeof vi.fn> } {
  const logRequest = vi.fn(async () => ({ kind: "request_logged" as const, replayed: false, requestId: "req-1" }));
  return {
    offerTimes: vi.fn(async () => {
      throw new Error("offerTimes not expected");
    }),
    placeHold: vi.fn(async () => {
      throw new Error("placeHold not expected");
    }),
    bookConversation: vi.fn(async () => ({ kind: "unavailable" as const })),
    chatDepositFor: vi.fn(async () => {
      throw new Error("chatDepositFor not expected");
    }),
    logRequest,
    ...overrides,
  } as BookingEngine & { logRequest: ReturnType<typeof vi.fn> };
}

function tools(e: BookingEngine, channel: "web_chat" | "voice" = "web_chat") {
  return bookingTools(
    {
      clinicId: "clinic-1",
      channel,
      holderKey: `web:${CONVERSATION}`,
      bookingKey: `web:${CONVERSATION}:1`,
      conversationId: CONVERSATION,
      timeZone: TZ,
      actor: ACTOR,
      budgetMs: 15_000,
    },
    e,
  );
}

const chosen: BookingToolState = {
  ...EMPTY_TOOL_STATE,
  service: "Facial",
  offered: [{ at: AT, providerId: null }],
  chosen: { at: AT, providerId: null },
};
const named = { ...EMPTY_CAPTURE, firstName: "Ana", phone: "415 555 0188", fields: { email: "ana@example.test" } };

describe("the website chat's booking after a calendar failure", () => {
  test("the engine unavailable (Google's re-check failed transiently): the request is logged under the booking key and the visitor told the clinic will confirm", async () => {
    const e = engine({});
    const turn = await tools(e).run({ action: null, capture: named, state: chosen, now: NOW });

    expect(e.logRequest).toHaveBeenCalledTimes(1);
    expect(e.logRequest).toHaveBeenCalledWith("clinic-1", {
      channel: "web_chat",
      holderKey: `web:${CONVERSATION}`,
      bookingKey: `web:${CONVERSATION}:1`,
      conversationId: CONVERSATION,
      firstName: "Ana",
      phoneE164: "+14155550188",
      preferredWindow: slotLabel(new Date(AT), TZ),
      service: "Facial",
      fields: { email: "ana@example.test" },
      now: NOW,
      actor: ACTOR,
    });
    expect(turn).toMatchObject({
      reply: forChat(REQUEST_TAKEN_LINE),
      bookingWritten: false,
      requestId: "req-1",
      appointmentId: null,
    });
    // The conversation's one request: the chat records it and files no other.
    expect(turn!.state.done).toEqual({ kind: "request", at: AT, requestId: "req-1", appointmentId: null });
  });

  test("the engine throwing: the same request, never the failure line", async () => {
    const e = engine({
      bookConversation: vi.fn(async () => {
        throw new Error("synthetic database outage");
      }),
    });
    const turn = await tools(e).run({ action: null, capture: named, state: chosen, now: NOW });
    expect(e.logRequest).toHaveBeenCalledTimes(1);
    expect(turn).toMatchObject({ reply: forChat(REQUEST_TAKEN_LINE), bookingWritten: false, requestId: "req-1" });
  });

  test("a replay under the same key (the chat's state lost after the first answer) asks for the same request again, by the same key", async () => {
    const e = engine({});
    e.logRequest.mockResolvedValueOnce({ kind: "request_logged", replayed: false, requestId: "req-1" });
    e.logRequest.mockResolvedValueOnce({ kind: "request_logged", replayed: true, requestId: "req-1" });
    const first = await tools(e).run({ action: null, capture: named, state: chosen, now: NOW });
    const again = await tools(e).run({ action: null, capture: named, state: chosen, now: NOW });
    expect(e.logRequest).toHaveBeenCalledTimes(2);
    expect(e.logRequest.mock.calls[0]![1].bookingKey).toBe(e.logRequest.mock.calls[1]![1].bookingKey);
    expect(again!.reply).toBe(first!.reply);
    expect(again!.requestId).toBe("req-1");
  });

  test("the request cannot be logged either: the failure line, and nothing said as booked", async () => {
    const e = engine({});
    e.logRequest.mockRejectedValueOnce(new Error("synthetic database outage"));
    const turn = await tools(e).run({ action: null, capture: named, state: chosen, now: NOW });
    expect(turn).toMatchObject({ reply: forChat(TOOL_FAILURE_LINE), bookingWritten: false });
    expect(turn!.state.done).toBeNull();
  });

  test("find_times failing: the chat turns to taking a request in words, so the desk gets the details the failure line offers to take", async () => {
    const e = engine({
      offerTimes: vi.fn(async () => ({ status: "unavailable" as const })) as unknown as BookingEngine["offerTimes"],
    });
    const turn = await tools(e).run({ action: { type: "find_times", service: "Facial", day: null }, capture: EMPTY_CAPTURE, state: EMPTY_TOOL_STATE, now: NOW });
    expect(turn!.reply).toBe(forChat(MANUAL_BOOKING_LINE));
    expect(turn!.state.manual).toBe(true);
  });
});
