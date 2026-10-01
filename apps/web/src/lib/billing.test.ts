import { getPlan, METERS, OVERAGE_RATES_PROVISIONAL, plans } from "@healdesk/catalog";
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
