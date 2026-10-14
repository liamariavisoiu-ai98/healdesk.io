import { describe, expect, test } from "vitest";

import {
  BOOKED_LINE,
  bookedLine,
  depositLine,
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
import { spokenPhone } from "@/lib/voice/spoken";

/**
 * What a call hears about a booking, as written (lib/booking/lines.ts), and
 * a number read for the ear (lib/voice/spoken.ts, which the assistant's
 * voice channel uses). Pure: the booking engine's own behaviour is
 * tests/booking-engine.test.ts, and the post-call ingest is
 * tests/voice.test.ts.
 */

describe("spoken forms (pure)", () => {
  test("a number is read in groups with oh for zero, and a deposit is said, never sent as a link", () => {
    expect(spokenPhone("+14155550199")).toBe("four one five — five five five — oh one nine nine");
    expect(spokenPhone("+442071234567")).toBe("four four two — oh seven one — two three four — five six seven");
    expect(depositLine(null)).toBe("");
    expect(depositLine({ action: "book", amountUsd: 50 })).toBe("");
    expect(depositLine({ action: "book_and_flag", amountUsd: 200 })).toMatch(/^A deposit of 200 dollars is required to hold the appointment\. The front desk will call you to take it/);
    expect(depositLine({ action: "book_and_flag", amountUsd: null })).toMatch(/^A deposit is required/);
    // "Book by phone without a deposit" off: the line never promises a booking.
    expect(depositLine({ action: "decline_and_alert", amountUsd: 200 })).toMatch(/^This appointment needs a deposit of 200 dollars, so it can't be booked on this call\./);
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
});
