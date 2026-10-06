import {
  getPlan,
  METERS,
  meterPriceLookupKey,
  OVERAGE_RATES_PROVISIONAL,
  plans,
} from "@healdesk/catalog";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  cohortCouponIdFor,
  isProductionDeployment,
  meteredLookupKeysFor,
  overageLookupKeys,
  siteUrl,
} from "./billing";

/**
 * Which metered prices a Session carries. The Session itself needs a Stripe
 * key and a network, so the decision is a pure function and this is where it
 * is pinned down: the pairing of meters to channels, and the rule that no
 * metered price is attached while the rates are provisional.
 */
describe("overage prices on a Session", () => {
  test("each package gets the meters for the channels it sells", () => {
    expect(overageLookupKeys(getPlan("voice")!)).toEqual([
      "healdesk_meter_voice_minutes_80",
    ]);
    expect(overageLookupKeys(getPlan("chat-web")!)).toEqual([
      "healdesk_meter_chat_conversations_40",
    ]);
    expect(overageLookupKeys(getPlan("chat-dual")!)).toEqual([
      "healdesk_meter_chat_conversations_30",
    ]);
    expect(overageLookupKeys(getPlan("complete")!)).toEqual([
      "healdesk_meter_voice_minutes_80",
      "healdesk_meter_chat_conversations_30",
    ]);
  });

  test("a package never gets a meter for a channel it lacks", () => {
    for (const plan of plans) {
      const keys = overageLookupKeys(plan);
      const voice = keys.filter((k) => k.startsWith(METERS.voiceMinutes.lookupKeyPrefix));
      const chat = keys.filter((k) =>
        k.startsWith(METERS.chatConversations.lookupKeyPrefix),
      );
      expect(voice.length).toBe(plan.channels.voice ? 1 : 0);
      expect(chat.length).toBe(plan.channels.web || plan.channels.meta ? 1 : 0);
    }
  });

  /**
   * The rate lives in the lookup key, so this is the test that stops a
   * package being billed another package's overage. Two chat rates are live
   * since 5 October 2026 ($0.40 single-channel, $0.30 multi-channel); picking
   * the chat price by channel alone would silently over-bill one of them by a
   * third. Every key a package asks for must bill that package's own number.
   */
  test("the key a package asks for encodes that package's own rate", () => {
    for (const plan of plans) {
      const keys = overageLookupKeys(plan);
      if (plan.channels.voice) {
        expect(keys).toContain(
          meterPriceLookupKey(METERS.voiceMinutes, plan.overagePerVoiceMinuteUsd),
        );
      }
      if (plan.channels.web || plan.channels.meta) {
        expect(keys).toContain(
          meterPriceLookupKey(
            METERS.chatConversations,
            plan.overagePerChatConversationUsd,
          ),
        );
      }
    }
  });

  test("the catalog's two chat rates do not collide in one key", () => {
    expect(meterPriceLookupKey(METERS.chatConversations, 0.4)).not.toBe(
      meterPriceLookupKey(METERS.chatConversations, 0.3),
    );
    // A rate Stripe could not bill as whole cents is refused, not rounded.
    expect(() => meterPriceLookupKey(METERS.chatConversations, 0.305)).toThrow();
    expect(() => meterPriceLookupKey(METERS.voiceMinutes, 0)).toThrow();
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

/**
 * Production, and where Stripe sends a paying buyer back to.
 *
 * NEXT_PUBLIC_SITE_URL is inlined at build time and feeds `success_url`. A
 * build without it used to fall back to localhost, which charges the customer
 * and then sends them to their own machine. In production the fallback is a
 * refusal instead, before any Session exists.
 */
describe("production deployments and the return URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("production is NODE_ENV or VERCEL_ENV, and nothing else", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "");
    expect(isProductionDeployment()).toBe(false);

    vi.stubEnv("VERCEL_ENV", "production");
    expect(isProductionDeployment()).toBe(true);

    // A Vercel preview: its build sets NODE_ENV, so it counts as production.
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");
    expect(isProductionDeployment()).toBe(true);
  });

  test("uses NEXT_PUBLIC_SITE_URL whenever it is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://healdesk.io");
    expect(siteUrl()).toBe("https://healdesk.io");
  });

  test("falls back to the local dev server outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(siteUrl()).toBe("http://localhost:3000");
  });

  test("refuses in production rather than send a paying buyer to localhost", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(() => siteUrl()).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });
});
