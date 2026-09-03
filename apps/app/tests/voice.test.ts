import { describe, expect, test } from "vitest";

import { COMMON_WEEKDAY_HOURS } from "@/lib/clinic/opening-hours";
import {
  classifyBooking,
  classifyRecovery,
  type VoiceCallEvent,
} from "@/lib/voice/ingest";

/**
 * The two classifications the monthly report is built on.
 *
 * `classifyRecovery` answers "would this call have been lost?", and
 * `classifyBooking` answers "did it convert?". They are separate on purpose:
 * conflating them understates how many calls the agent caught and overstates
 * how well it closes them, in the same number.
 */

const TZ = "America/New_York";

/** The normal setup: their line rings first, we get what nobody answered. */
const CONDITIONAL = {
  callRouting: "conditional" as const,
  openingHours: COMMON_WEEKDAY_HOURS,
  timezone: TZ,
};

/** A solo operator with no front desk: we are the primary number. */
const ALWAYS = { ...CONDITIONAL, callRouting: "always" as const };

const call = (over: Partial<VoiceCallEvent> = {}): VoiceCallEvent => ({
  externalCallId: "call_1",
  clinicId: "11111111-1111-4111-8111-111111111111",
  // Wednesday 14:00 New York — squarely inside COMMON_WEEKDAY_HOURS.
  startedAt: new Date("2026-09-02T18:00:00Z"),
  ...over,
});

/** Wednesday 21:00 New York — shut. */
const AFTER_HOURS = new Date("2026-09-03T01:00:00Z");

describe("conditional forwarding — the normal setup", () => {
  test("a midday call is recovered, because their receptionist let it ring out", () => {
    // The rule that matters. On a conditionally forwarded line the call only
    // reaches us BECAUSE nobody at the clinic picked it up — so the time of day
    // is irrelevant. An earlier version returned null here, on the theory that
    // the clinic "would have handled it anyway"; under conditional forwarding
    // that case cannot occur, because then it would never have reached us.
    expect(classifyRecovery(call(), CONDITIONAL)).toBe("rang_unanswered");
  });

  test("an after-hours call gets the more specific reason", () => {
    expect(
      classifyRecovery(call({ startedAt: AFTER_HOURS }), CONDITIONAL),
    ).toBe("after_hours");
  });

  test("a busy line is recorded as busy, not as unanswered", () => {
    expect(classifyRecovery(call({ clinicLineBusy: true }), CONDITIONAL)).toBe(
      "line_busy",
    );
  });

  test("a callback outranks after-hours, because it is the stronger claim", () => {
    const nightCallback = call({ startedAt: AFTER_HOURS, isCallback: true });
    expect(classifyRecovery(nightCallback, CONDITIONAL)).toBe(
      "missed_call_callback",
    );
  });

  test("no opening hours on file still counts the recovery", () => {
    // It only downgrades the REASON. The call still reached us because nobody
    // answered, and that fact does not depend on knowing their schedule.
    expect(
      classifyRecovery(call(), { ...CONDITIONAL, openingHours: null }),
    ).toBe("rang_unanswered");
  });

  test("a malformed schedule downgrades the reason, not the recovery", () => {
    expect(
      classifyRecovery(call(), { ...CONDITIONAL, openingHours: { mon: "9-5" } }),
    ).toBe("rang_unanswered");
  });
});

describe("always-forwarded — where the AI is the front desk", () => {
  test("a midday call is NOT recovered", () => {
    // Nobody was passed over. Counting this would mark the clinic's entire call
    // volume as recovered and make the headline figure meaningless.
    expect(classifyRecovery(call(), ALWAYS)).toBeNull();
  });

  test("an after-hours call IS recovered — nobody there could have taken it", () => {
    expect(classifyRecovery(call({ startedAt: AFTER_HOURS }), ALWAYS)).toBe(
      "after_hours",
    );
  });

  test("a callback we placed ourselves is recovered whatever the hour", () => {
    expect(classifyRecovery(call({ isCallback: true }), ALWAYS)).toBe(
      "missed_call_callback",
    );
  });

  test("with no hours on file, nothing in-hours is claimed", () => {
    // We cannot establish that nobody could have answered, so we do not claim
    // it. Guessing "closed" would manufacture recovery out of missing setup.
    expect(
      classifyRecovery(call(), { ...ALWAYS, openingHours: null }),
    ).toBeNull();
  });
});

describe("the clinic's timezone decides, not the server's", () => {
  test("the same instant classifies differently on each coast", () => {
    // 22:00 UTC on a Wednesday is 18:00 in New York — shut — and 15:00 in Los
    // Angeles, open. On an always-forwarded line that is the difference between
    // recovered and not.
    const instant = call({ startedAt: new Date("2026-09-02T22:00:00Z") });

    expect(classifyRecovery(instant, ALWAYS)).toBe("after_hours");
    expect(
      classifyRecovery(instant, { ...ALWAYS, timezone: "America/Los_Angeles" }),
    ).toBeNull();
  });
});

describe("booking is a separate question from recovery", () => {
  test("a recovered call that booked is a recovered booking", () => {
    const result = classifyBooking(
      call({ outcome: "booked" }),
      "rang_unanswered",
    );
    expect(result).toEqual({
      recovered: true,
      booked: true,
      recoveredBooking: true,
    });
  });

  test("a recovered call that did not book is still recovered", () => {
    // The figure that would be wrong if these were one function: we caught the
    // call, it just did not convert. Dropping it would understate reach.
    const result = classifyBooking(
      call({ outcome: "qualified_no_booking" }),
      "rang_unanswered",
    );
    expect(result.recovered).toBe(true);
    expect(result.recoveredBooking).toBe(false);
  });

  test("a booking on a call we did NOT recover is not a recovered booking", () => {
    // An always-forwarded clinic booking a midday appointment. Real business,
    // and business they would have had anyway — so we do not claim it.
    const result = classifyBooking(call({ outcome: "booked" }), null);
    expect(result).toEqual({
      recovered: false,
      booked: true,
      recoveredBooking: false,
    });
  });

  test("the three figures are strictly nested", () => {
    // answered ⊇ recovered ⊇ recovered bookings. A report that violates this
    // has a close rate above 100% somewhere in it.
    for (const reason of ["rang_unanswered", null] as const) {
      for (const outcome of ["booked", "abandoned"] as const) {
        const r = classifyBooking(call({ outcome }), reason);
        if (r.recoveredBooking) expect(r.recovered && r.booked).toBe(true);
      }
    }
  });
});
