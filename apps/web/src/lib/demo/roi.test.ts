import { MAX_STEP_UNITS, MIN_STEP_UNITS, planFor } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  ASSUMED_MINUTES_PER_CALL,
  DEFAULT_MISSED_CALLS_PER_WEEK,
  DEFAULT_MISSED_MESSAGES_PER_WEEK,
  estimate,
  suggestedSteps,
  WEEKS_PER_MONTH,
} from "./roi";

/**
 * The cost side of the estimate since the step pricing of 13 October 2026:
 * the steps a clinic is shown are sized from its own volume (roi.ts header),
 * rounded up so the suggestion covers it, and held to the steps on sale.
 */
describe("suggested steps", () => {
  test("the defaults suggest 200 minutes and 100 conversations", () => {
    // 8 calls × 4.33 × 3 minutes = 103.9 → 200; 4 messages × 4.33 = 17.3 → 100.
    expect(
      suggestedSteps({
        missedCallsPerWeek: DEFAULT_MISSED_CALLS_PER_WEEK,
        missedMessagesPerWeek: DEFAULT_MISSED_MESSAGES_PER_WEEK,
      }),
    ).toEqual({ voiceMinutes: 200, chatConversations: 100 });
  });

  test("rounds up to the step that covers the volume, never down", () => {
    const calls = 30;
    const minutes = calls * WEEKS_PER_MONTH * ASSUMED_MINUTES_PER_CALL; // 389.7
    expect(suggestedSteps({ missedCallsPerWeek: calls, missedMessagesPerWeek: 0 }).voiceMinutes).toBe(400);
    expect(minutes).toBeLessThanOrEqual(400);
    expect(suggestedSteps({ missedCallsPerWeek: 0, missedMessagesPerWeek: 50 }).chatConversations).toBe(300);
  });

  test("never below the smallest step or above the largest", () => {
    expect(suggestedSteps({ missedCallsPerWeek: 0, missedMessagesPerWeek: 0 })).toEqual({
      voiceMinutes: MIN_STEP_UNITS,
      chatConversations: MIN_STEP_UNITS,
    });
    expect(suggestedSteps({ missedCallsPerWeek: 500, missedMessagesPerWeek: 5_000 })).toEqual({
      voiceMinutes: MAX_STEP_UNITS,
      chatConversations: MAX_STEP_UNITS,
    });
    expect(suggestedSteps({ missedCallsPerWeek: Number.NaN, missedMessagesPerWeek: -3 })).toEqual({
      voiceMinutes: MIN_STEP_UNITS,
      chatConversations: MIN_STEP_UNITS,
    });
  });

  test("the multiple is divided by the price of the steps suggested", () => {
    const inputs = {
      priceUsd: 425,
      priceSource: "",
      missedCallsPerWeek: 8,
      missedMessagesPerWeek: 4,
      bookingRate: 0.35,
      showRate: 0.85,
      repeat: null,
    };
    const plan = planFor("voice-metachat", suggestedSteps(inputs));
    expect(plan.monthlyUsd).toBe(220); // 200 minutes ($160) + 100 conversations ($60)
    // (8 + 4) × 4.33 × 0.35 × 0.85 × $425 = $6,569 → $6,570, over $220.
    expect(estimate(plan, inputs).multiple).toBe(29.9);
  });
});
