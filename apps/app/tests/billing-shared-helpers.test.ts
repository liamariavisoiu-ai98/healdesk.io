import { afterEach, describe, expect, test } from "vitest";

import {
  __clearPriceCacheForTests,
  PriceNotFoundError,
  pricesForLookupKeys,
  priceForLookupKey,
} from "@/lib/billing/prices";
import {
  effectivePaymentMethod,
  stripeRefId,
  workerRequestOptions,
} from "@/lib/billing/stripe-helpers";

import { createStripeFake, stripeError } from "./setup/stripe-fake";

/**
 * The helpers every billing worker leans on: the lookup-key price cache, the
 * card Stripe will charge, worker request options, and the recording fake.
 * Pure: no database.
 */

afterEach(() => {
  __clearPriceCacheForTests();
});

function price(id: string, lookupKey: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    lookup_key: lookupKey,
    product: `prod_${id}`,
    unit_amount: 39700,
    recurring: { interval: "month", usage_type: "licensed" },
    ...extra,
  };
}

describe("the lookup-key price cache", () => {
  test("asks Stripe for at most 10 lookup keys per call", async () => {
    const keys = Array.from({ length: 23 }, (_, i) => `healdesk_key_${i}`);
    const fake = createStripeFake({
      "prices.list": (params: unknown) => {
        const asked = (params as { lookup_keys: string[] }).lookup_keys;
        return { data: asked.map((key) => price(`price_${key}`, key)) };
      },
    });
    const found = await pricesForLookupKeys(keys, { stripe: fake.stripe });
    expect(found.size).toBe(23);
    const sizes = fake
      .callsTo("prices.list")
      .map((call) => (call.args[0] as { lookup_keys: string[] }).lookup_keys.length);
    expect(sizes).toEqual([10, 10, 3]);
    for (const call of fake.callsTo("prices.list")) {
      expect(call.args[0]).toMatchObject({ active: true });
    }
  });

  test("caches, so a second lookup makes no call", async () => {
    const fake = createStripeFake({
      "prices.list": () => ({ data: [price("price_a", "healdesk_a")] }),
    });
    await priceForLookupKey("healdesk_a", { stripe: fake.stripe });
    const again = await priceForLookupKey("healdesk_a", { stripe: fake.stripe });
    expect(again).toMatchObject({
      id: "price_a",
      productId: "prod_price_a",
      unitAmountCents: 39700,
      interval: "month",
    });
    expect(fake.callsTo("prices.list")).toHaveLength(1);
  });

  test("a key with no active price is a loud setup fault, never undefined", async () => {
    const fake = createStripeFake({ "prices.list": () => ({ data: [] }) });
    await expect(
      priceForLookupKey("healdesk_missing", { stripe: fake.stripe }),
    ).rejects.toBeInstanceOf(PriceNotFoundError);
  });
});

describe("the card Stripe will charge", () => {
  test("is the customer's invoice default when there is one", async () => {
    const fake = createStripeFake({
      "customers.retrieve": () => ({
        id: "cus_1",
        invoice_settings: { default_payment_method: "pm_customer" },
      }),
    });
    const pm = await effectivePaymentMethod(fake.stripe, {
      customerId: "cus_1",
      subscription: { default_payment_method: "pm_subscription" },
    });
    expect(pm).toBe("pm_customer");
  });

  test("falls back to the subscription's own default", async () => {
    const fake = createStripeFake({
      "customers.retrieve": () => ({
        id: "cus_1",
        invoice_settings: { default_payment_method: null },
      }),
    });
    const pm = await effectivePaymentMethod(fake.stripe, {
      customerId: "cus_1",
      subscription: { default_payment_method: { id: "pm_subscription" } },
    });
    expect(pm).toBe("pm_subscription");
  });

  test("a deleted customer has no card", async () => {
    const fake = createStripeFake({ "customers.retrieve": () => ({ id: "cus_1", deleted: true }) });
    expect(await effectivePaymentMethod(fake.stripe, { customerId: "cus_1" })).toBeNull();
  });
});

describe("worker request options and references", () => {
  test("keep one call well inside a 5-minute lease", () => {
    expect(workerRequestOptions()).toEqual({ timeout: 20_000, maxNetworkRetries: 1 });
    expect(workerRequestOptions("hd-key")).toEqual({
      timeout: 20_000,
      maxNetworkRetries: 1,
      idempotencyKey: "hd-key",
    });
  });

  test("a reference is an id or an expanded object", () => {
    expect(stripeRefId("in_1")).toBe("in_1");
    expect(stripeRefId({ id: "in_2" })).toBe("in_2");
    expect(stripeRefId(null)).toBeNull();
    expect(stripeRefId({})).toBeNull();
  });
});

describe("the recording Stripe fake", () => {
  test("refuses any Stripe trial parameter, however deep", async () => {
    const fake = createStripeFake({ "subscriptions.update": () => ({ id: "sub_1" }) });
    await expect(
      fake.stripe.subscriptions.update("sub_1", {
        items: [{ price: "p" }],
        trial_end: "now",
      } as never),
    ).rejects.toThrow(/never uses a Stripe trial/);
    await expect(
      fake.stripe.checkout.sessions.create({
        subscription_data: { trial_period_days: 7 },
      } as never),
    ).rejects.toThrow(/trial_period_days/);
  });

  test("refuses a call nobody expected, and records every call", async () => {
    const fake = createStripeFake();
    await expect(fake.stripe.refunds.create({ payment_intent: "pi_1" })).rejects.toThrow(
      /no handler for refunds.create/,
    );
    expect(fake.calls.map((call) => call.method)).toEqual(["refunds.create"]);
  });

  test("builds real SDK errors", () => {
    const declined = stripeError("card", { code: "card_declined" });
    expect(declined).toBeInstanceOf(Error);
    expect((declined as { statusCode?: number }).statusCode).toBe(402);
    expect((declined as { code?: string }).code).toBe("card_declined");
  });
});
