import { getPlan, METERS, OVERAGE_RATES_PROVISIONAL, plans } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { cohortCouponIdFor, meteredLookupKeysFor, overageLookupKeys } from "./billing";

/**
 * Which metered prices a Session carries. The Session itself needs a Stripe
 * key and a network, so the decision is a pure function and this is where it
 * is pinned down: the pairing of meters to channels, and the rule that no
 * metered price is attached while the rates are provisional.
 */
describe("overage prices on a Session", () => {
  test("each package gets the meters for the channels it sells", () => {
    expect(overageLookupKeys(getPlan("voice")!)).toEqual([
      METERS.voiceMinutes.lookupKey,
    ]);
    expect(overageLookupKeys(getPlan("chat-single")!)).toEqual([
      METERS.chatConversations.lookupKey,
    ]);
    expect(overageLookupKeys(getPlan("chat-dual")!)).toEqual([
      METERS.chatConversations.lookupKey,
    ]);
    expect(overageLookupKeys(getPlan("complete")!)).toEqual([
      METERS.voiceMinutes.lookupKey,
      METERS.chatConversations.lookupKey,
    ]);
  });

  test("a package never gets a meter for a channel it lacks", () => {
    for (const plan of plans) {
      const keys = overageLookupKeys(plan);
      expect(keys.includes(METERS.voiceMinutes.lookupKey)).toBe(plan.channels.voice);
      expect(keys.includes(METERS.chatConversations.lookupKey)).toBe(
        plan.channels.web || plan.channels.meta,
      );
    }
  });

  test("the monthly Session carries the package's meters; the annual one carries none", () => {
    // Annual overage is invoiced separately, monthly in arrears (decision of
    // 21 September 2026; billing.ts header). While the rates are provisional
    // neither interval carries anything.
    for (const plan of plans) {
      if (OVERAGE_RATES_PROVISIONAL) {
        expect(meteredLookupKeysFor(plan, "month")).toEqual([]);
      } else {
        expect(meteredLookupKeysFor(plan, "month")).toEqual(overageLookupKeys(plan));
      }
      expect(meteredLookupKeysFor(plan, "year")).toEqual([]);
    }
  });

  test("the cohort coupon id is stable per package", () => {
    for (const plan of plans) {
      expect(cohortCouponIdFor(plan)).toBe(`healdesk-cohort-setup-${plan.id}`);
    }
  });
});
