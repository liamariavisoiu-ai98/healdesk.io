import { describe, expect, test } from "vitest";

import { COMMON_WEEKDAY_HOURS } from "@/lib/clinic/opening-hours";
import { classifyRecovery, type VoiceCallEvent } from "@/lib/voice/ingest";

/**
 * The recovery classification.
 *
 * This is the one judgement in the ingestion path, and it decides the number a
 * clinic judges us on. The rule it defends: a value goes in ONLY if the clinic
 * genuinely would not have handled the contact. Every test here is a case where
 * getting it wrong inflates or deflates that figure.
 */

const TZ = "America/New_York";

const call = (over: Partial<VoiceCallEvent> = {}): VoiceCallEvent => ({
  externalCallId: "call_1",
  clinicId: "11111111-1111-4111-8111-111111111111",
  // Wednesday 14:00 New York — squarely inside COMMON_WEEKDAY_HOURS.
  startedAt: new Date("2026-09-02T18:00:00Z"),
  ...over,
});

describe("what counts as recovered", () => {
  test("a call answered during opening hours on a free line is NOT recovered", () => {
    // The most important case in the file. We answered it; their front desk
    // would have too. Counting this inflates the headline figure with calls we
    // did not save, which is the dishonesty the product exists to replace.
    expect(classifyRecovery(call(), COMMON_WEEKDAY_HOURS, TZ)).toBeNull();
  });

  test("a call outside opening hours is recovered", () => {
    // Wednesday 21:00 New York.
    const evening = call({ startedAt: new Date("2026-09-03T01:00:00Z") });
    expect(classifyRecovery(evening, COMMON_WEEKDAY_HOURS, TZ)).toBe(
      "after_hours",
    );
  });

  test("a busy line is recovered even in opening hours", () => {
    expect(
      classifyRecovery(call({ clinicLineBusy: true }), COMMON_WEEKDAY_HOURS, TZ),
    ).toBe("line_busy");
  });

  test("a call that rang at the clinic first is recovered", () => {
    expect(
      classifyRecovery(
        call({ rangAtClinicFirst: true }),
        COMMON_WEEKDAY_HOURS,
        TZ,
      ),
    ).toBe("rang_unanswered");
  });

  test("a callback outranks after-hours, because it is the stronger claim", () => {
    // Both facts are true for a 9pm callback. "We rang them back" is more
    // defensible than "they rang when you were shut", so it wins.
    const nightCallback = call({
      startedAt: new Date("2026-09-03T01:00:00Z"),
      isCallback: true,
    });
    expect(classifyRecovery(nightCallback, COMMON_WEEKDAY_HOURS, TZ)).toBe(
      "missed_call_callback",
    );
  });
});

describe("what must never manufacture recovery", () => {
  test("no opening hours on file means not recovered, not 'after hours'", () => {
    // The trap: an unset schedule makes every hour look closed. That would turn
    // missing configuration into revenue we claim to have saved.
    expect(classifyRecovery(call(), null, TZ)).toBeNull();
    expect(classifyRecovery(call(), undefined, TZ)).toBeNull();
  });

  test("a malformed schedule is a config bug, not evidence of recovery", () => {
    expect(classifyRecovery(call(), { monday: "all day" }, TZ)).toBeNull();
  });

  test("an answered call that simply didn't book is not recovery", () => {
    // Outcome plays no part in the classification, deliberately. Whether it
    // booked is a different question from whether we saved it.
    const noBooking = call({ outcome: "qualified_no_booking" });
    expect(classifyRecovery(noBooking, COMMON_WEEKDAY_HOURS, TZ)).toBeNull();
  });

  test("the clinic's own timezone decides, not the server's", () => {
    // 22:00 UTC on a Wednesday is 18:00 in New York — shut — and 15:00 in Los
    // Angeles, open. The same instant must classify differently for two
    // clinics, or a west-coast practice gets billed recovery for calls its own
    // front desk was sitting there to answer.
    const instant = call({ startedAt: new Date("2026-09-02T22:00:00Z") });
    expect(classifyRecovery(instant, COMMON_WEEKDAY_HOURS, TZ)).toBe(
      "after_hours",
    );
    expect(
      classifyRecovery(instant, COMMON_WEEKDAY_HOURS, "America/Los_Angeles"),
    ).toBeNull();
  });
});
