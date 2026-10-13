import { afterEach, describe, expect, test, vi } from "vitest";

import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import {
  __setStripeForTests,
  getStripe,
  StripeNotConfiguredError,
  stripeConfigured,
} from "@/lib/billing/stripe-client";

/** The one Stripe client in apps/app (design D15), and the metered keys a subscription should carry. */

describe("stripe client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __setStripeForTests(null);
  });

  test("without a key it says so by name instead of failing inside the SDK", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(stripeConfigured()).toBe(false);
    expect(() => getStripe()).toThrow(StripeNotConfiguredError);
  });

  test("with a key it builds one client and reuses it", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_not_a_real_key");
    expect(stripeConfigured()).toBe(true);
    const first = getStripe();
    expect(getStripe()).toBe(first);
  });

  test("a test fake replaces the client until it is removed", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const fake = { invoices: {} };
    __setStripeForTests(fake);
    expect(stripeConfigured()).toBe(true);
    expect(getStripe()).toBe(fake);
    __setStripeForTests(null);
    expect(() => getStripe()).toThrow(StripeNotConfiguredError);
  });

  test("the fake seam is refused in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => __setStripeForTests({})).toThrow(/not available in production/);
  });
});

describe("expectedMeteredKeys", () => {
  // Loaded with the catalog's provisional-rates flag pinned either way, so
  // these tests say what each setting means rather than what it is today.
  async function load(provisional: boolean) {
    vi.resetModules();
    vi.doMock("@healdesk/catalog", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@healdesk/catalog")>()),
      OVERAGE_RATES_PROVISIONAL: provisional,
    }));
    const mod = await import("@/lib/billing/metered-items");
    vi.doUnmock("@healdesk/catalog");
    return mod.expectedMeteredKeys;
  }

  test("monthly plans carry one metered price per meter their package uses, at its rate", async () => {
    const expected = await load(false);
    expect(expected("voice-metachat-1000-1000", "month")).toEqual([
      "healdesk_meter_chat_conversations_block100_7800",
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
    expect(expected("voice-webchat-500-300", "month")).toEqual([
      "healdesk_meter_chat_conversations_block100_5200",
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
    expect(expected("webchat-1000", "month")).toEqual([
      "healdesk_meter_chat_conversations_block100_5200",
    ]);
    expect(expected("metachat-1000", "month")).toEqual([
      "healdesk_meter_chat_conversations_block100_7800",
    ]);
    expect(expected("voice-1000", "month")).toEqual([
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
    // The step does not change the rate: only the package's products do.
    expect(expected("voice-100", "month")).toEqual(expected("voice-1500", "month"));
  });

  test("annual plans carry none: their overage is invoiced per closed month", async () => {
    const expected = await load(false);
    expect(expected("voice-metachat-1000-1000", "year")).toEqual([]);
  });

  test("while the rates are provisional nothing carries a metered price, as at checkout", async () => {
    const expected = await load(true);
    expect(expected("voice-metachat-1000-1000", "month")).toEqual([]);
    expect(expected("voice-1000", "month")).toEqual([]);
  });

  test("an unknown plan is null, not [], so a reconciler leaves the subscription alone", async () => {
    expect(await load(false).then((f) => f("no-such-plan", "month"))).toBeNull();
    expect(await load(true).then((f) => f("no-such-plan", "year"))).toBeNull();
    // The real module agrees with the pinned ones.
    expect(expectedMeteredKeys("no-such-plan", "month")).toBeNull();
    // So is a fixed package of 5 October, gone since the step pricing of 13
    // October: a subscription on one is left as it was sold.
    expect(expectedMeteredKeys("complete", "month")).toBeNull();
  });
});
