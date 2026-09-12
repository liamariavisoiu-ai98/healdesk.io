import { getPlan, METERS, OVERAGE_RATES_PROVISIONAL, plans } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { meteredLookupKeysFor, overageLookupKeys } from "./billing";

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

  test("nothing metered is attached while the rates are provisional", () => {
    // The pricing page says overage is not billed until the rates are
    // published; this is the line that makes that true. When the flag flips
    // the monthly Session carries the package's meters and the annual one
    // refuses until the annual path is decided (see billing.ts).
    for (const plan of plans) {
      if (OVERAGE_RATES_PROVISIONAL) {
        expect(meteredLookupKeysFor(plan, "month")).toEqual([]);
        expect(meteredLookupKeysFor(plan, "year")).toEqual([]);
      } else {
        expect(meteredLookupKeysFor(plan, "month")).toEqual(overageLookupKeys(plan));
        expect(() => meteredLookupKeysFor(plan, "year")).toThrow(/annual/);
      }
    }
  });
});
