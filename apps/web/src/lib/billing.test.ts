import { allPlans, DEMO_SETUP_CREDIT, getPlan, METERS, SELF_SERVE_DEMO_SETUP_CREDIT } from "@healdesk/catalog";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  chooseSetupOffer,
  demoOfferFor,
  isProductionDeployment,
  isSetupOffer,
  meteredLookupKeysFor,
  overageLookupKeys,
  SETUP_OFFERS,
  setupCouponFor,
  siteUrl,
} from "./billing";

/**
 * Which metered prices a subscription carries, and which setup coupon a
 * Session names. The Session itself needs a Stripe key and a network, so the
 * decisions are pure functions and this is where they are pinned down: the
 * pairing of meters to products, and the one setup offer that applies.
 */
describe("overage prices", () => {
  test("each plan gets the meters for the products it sells, at the product's rate", () => {
    // The rates the owner set on 13 October 2026, billed per started block of
    // 100: $104 a block of voice minutes, $52 a block of Web Chat
    // conversations, $78 a block of Meta Chat conversations. Spelled out
    // rather than derived, so a catalog edit that changes what a clinic is
    // billed has to change this line too.
    expect(overageLookupKeys(getPlan("voice-500")!)).toEqual([
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
    expect(overageLookupKeys(getPlan("webchat-300")!)).toEqual([
      "healdesk_meter_chat_conversations_block100_5200",
    ]);
    expect(overageLookupKeys(getPlan("metachat-300")!)).toEqual([
      "healdesk_meter_chat_conversations_block100_7800",
    ]);
    expect(overageLookupKeys(getPlan("voice-webchat-500-300")!)).toEqual([
      "healdesk_meter_voice_minutes_block100_10400",
      "healdesk_meter_chat_conversations_block100_5200",
    ]);
    expect(overageLookupKeys(getPlan("voice-metachat-1500-100")!)).toEqual([
      "healdesk_meter_voice_minutes_block100_10400",
      "healdesk_meter_chat_conversations_block100_7800",
    ]);
  });

  test("a plan never gets a meter for a product it lacks", () => {
    for (const plan of allPlans()) {
      const keys = overageLookupKeys(plan);
      expect(keys.some((k) => k.startsWith(METERS.voiceMinutes.lookupKeyPrefix))).toBe(
        plan.channels.voice,
      );
      expect(keys.some((k) => k.startsWith(METERS.chatConversations.lookupKeyPrefix))).toBe(
        plan.chatProduct !== null,
      );
    }
  });

  test("three metered prices on two meters cover every plan", () => {
    const keys = new Set(allPlans().flatMap((plan) => overageLookupKeys(plan)));
    expect([...keys].sort()).toEqual([
      "healdesk_meter_chat_conversations_block100_5200",
      "healdesk_meter_chat_conversations_block100_7800",
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
  });

  test("a monthly plan carries its package's meters; an annual one carries none", () => {
    // Annual overage is invoiced separately, monthly in arrears (decision of
    // 21 September 2026; billing.ts header).
    for (const plan of allPlans()) {
      expect(meteredLookupKeysFor(plan, "month")).toEqual(overageLookupKeys(plan));
      expect(meteredLookupKeysFor(plan, "year")).toEqual([]);
    }
  });
});

describe("the setup offer a Session carries", () => {
  const SOON = new Date("2026-10-15T12:00:00Z");
  const LATER = new Date("2026-10-27T12:00:00Z");

  test("only one, the strongest that holds: cohort, then demo, then the website", () => {
    expect(chooseSetupOffer({ cohort: LATER, demo: SOON, site: SOON })).toEqual({ offer: "cohort-setup", endsAt: LATER });
    expect(chooseSetupOffer({ cohort: null, demo: SOON, site: LATER })).toEqual({ offer: "demo-setup-50", endsAt: SOON });
    expect(chooseSetupOffer({ cohort: null, demo: null, site: SOON })).toEqual({ offer: "site-setup-30", endsAt: SOON });
    expect(chooseSetupOffer({ cohort: null, demo: null, site: null })).toBeNull();
  });

  test("each offer names its package's coupon, the amount in the id", () => {
    const plan = getPlan("voice-500")!;
    expect(setupCouponFor("cohort-setup", plan)).toBe("healdesk-cohort-setup-voice-69700");
    expect(setupCouponFor("demo-setup-50", plan)).toBe("healdesk-demo-setup-50-voice-34800");
    expect(setupCouponFor("site-setup-30", plan)).toBe("healdesk-site-setup-30-voice-20900");
    // Per package, not per step: every voice step names the same coupon.
    expect(setupCouponFor("site-setup-30", getPlan("voice-1500")!)).toBe("healdesk-site-setup-30-voice-20900");
    expect(setupCouponFor("site-setup-30", getPlan("webchat-300")!)).toBe("healdesk-site-setup-30-webchat-7700");
  });

  test("the offer names are a closed list; the 5 October name is not one of them", () => {
    expect(SETUP_OFFERS).toEqual(["cohort-setup", "demo-setup-50", "demo-setup-30", "site-setup-30"]);
    expect(isSetupOffer("site-setup-30")).toBe(true);
    expect(isSetupOffer("demo-setup-half")).toBe(false);
    expect(isSetupOffer(null)).toBe(false);
  });

  test("an operator's demo takes half off, a homepage demo 30%, each by its own coupon", () => {
    const plan = getPlan("voice-500")!;
    expect(setupCouponFor("demo-setup-50", plan)).toBe("healdesk-demo-setup-50-voice-34800");
    expect(setupCouponFor("demo-setup-30", plan)).toBe("healdesk-demo-setup-30-voice-20900");
    expect(demoOfferFor(SELF_SERVE_DEMO_SETUP_CREDIT)).toBe("demo-setup-30");
    expect(demoOfferFor(DEMO_SETUP_CREDIT)).toBe("demo-setup-50");
    const at = new Date("2026-10-15T12:00:00Z");
    expect(chooseSetupOffer({ cohort: null, demo: at, demoOffer: "demo-setup-30", site: at })).toEqual({
      offer: "demo-setup-30",
      endsAt: at,
    });
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
