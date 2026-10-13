import {
  allPlans,
  getPackage,
  getPlan,
  METERS,
  OVERAGE_BLOCK_UNITS,
  PACKAGES,
  setupAfterCreditUsd,
  stripeLookupKey,
} from "@healdesk/catalog";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  archiveLegacyMeteredPrices,
  BLOCK_TRANSFORM,
  computeDesired,
  CONCURRENCY,
  couponProblems,
  describePackage,
  isLegacyMeteredKey,
  LEGACY_PLAN_META,
  legacyPackageProducts,
  legacyPerUnitKeys,
  mapLimited,
  meteredPriceParams,
  meteredPriceProblems,
  PACKAGE_META,
  packagePriceParams,
  packagePriceProblems,
  parseArgs,
  printDryRun,
  REQUESTS_PER_SECOND,
  SETUP_COUPON_OFFERS,
  staleCouponIds,
  staleLookupKeys,
  stepsLabel,
  summaryLine,
  Throttle,
  withRateLimitRetry,
  type DesiredMeter,
  type DesiredMeteredPrice,
} from "./stripe-setup";

/**
 * The pure parts of stripe-setup, for the step pricing of 13 October 2026:
 * one product per package, a monthly and an annual price per plan and one
 * setup price per package, a coupon per setup credit per package, three block
 * prices on two meters. What the catalog no longer names (the seven packages
 * of 5 October, the block prices of 6 October) is reported, never archived;
 * the per-unit prices of 5 October are still archived. The live run's pacing
 * (a throttle, a 429 retry, a concurrency cap) is tested with a fake clock.
 * Importing the script must not run it.
 */

beforeEach(() => {
  // The archive step and the dry run report on stdout, as the run does.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function meterOf(id: keyof typeof METERS): DesiredMeter {
  const found = computeDesired().meters.find((m) => m.meterId === id);
  if (!found) throw new Error(`No meter ${id}`);
  return found;
}

function packageOf(id: string) {
  const found = computeDesired().packages.find((p) => p.pkg.id === id);
  if (!found) throw new Error(`No package ${id}`);
  return found;
}

/** A price as Stripe returns one created from `meteredPriceParams`, with overrides. */
function stripePrice(
  meter: DesiredMeter,
  rate: DesiredMeteredPrice,
  overrides: Partial<Stripe.Price> = {},
): Stripe.Price {
  const params = meteredPriceParams(meter, rate, {
    productId: "prod_meter",
    meterId: "mtr_test",
    transferLookupKey: false,
  });
  return {
    id: `price_${rate.lookupKey}`,
    object: "price",
    active: true,
    billing_scheme: params.billing_scheme,
    currency: params.currency,
    lookup_key: params.lookup_key ?? null,
    metadata: params.metadata,
    nickname: params.nickname ?? null,
    product: "prod_meter",
    recurring: {
      interval: "month",
      interval_count: 1,
      meter: "mtr_test",
      trial_period_days: null,
      usage_type: "metered",
    },
    tiers_mode: null,
    transform_quantity: params.transform_quantity ?? null,
    type: "recurring",
    unit_amount: params.unit_amount ?? null,
    ...overrides,
  } as unknown as Stripe.Price;
}

describe("the package prices the catalog asks for", () => {
  test("one product per package, every plan's month and year price, one setup price each", () => {
    const desired = computeDesired();
    expect(desired.packages.map((p) => p.pkg.id)).toEqual(PACKAGES.map((p) => p.id));
    expect(desired.packages.map((p) => p.productName)).toEqual([
      "AYA Voice",
      "AYA Web Chat",
      "AYA Meta Chat",
      "AYA Voice + Web Chat",
      "AYA Voice + Meta Chat",
    ]);
    const kinds = (id: string) => {
      const prices = packageOf(id).prices;
      return ["setup", "month", "year"].map((k) => prices.filter((p) => p.kind === k).length);
    };
    expect(kinds("voice")).toEqual([1, 15, 15]);
    expect(kinds("webchat")).toEqual([1, 15, 15]);
    expect(kinds("metachat")).toEqual([1, 15, 15]);
    expect(kinds("voice-webchat")).toEqual([1, 225, 225]);
    expect(kinds("voice-metachat")).toEqual([1, 225, 225]);

    // Every plan's two recurring keys, from the catalog's own function, once each.
    const recurring = desired.packages.flatMap((p) => p.prices.filter((x) => x.kind !== "setup"));
    expect(recurring).toHaveLength(990);
    expect(new Set(recurring.map((p) => p.lookupKey))).toEqual(
      new Set(allPlans().flatMap((plan) => [stripeLookupKey(plan, "month"), stripeLookupKey(plan, "year")])),
    );
  });

  test("the sheet's own examples, at the amounts the sheet quotes", () => {
    const byKey = new Map(computeDesired().packages.flatMap((p) => p.prices.map((x) => [x.lookupKey, x])));
    // voice 500 + webchat 300 = $400 + $120 = $520 a month.
    expect(byKey.get("healdesk_voice-webchat-500-300_month_52000")).toMatchObject({
      kind: "month",
      planId: "voice-webchat-500-300",
      amountCents: 52_000,
      nickname: "500 minutes + 300 conversations, monthly",
    });
    // voice 500 annual = $320 a month, $3,840 a year.
    expect(byKey.get("healdesk_voice-500_year_384000")).toMatchObject({
      kind: "year",
      planId: "voice-500",
      amountCents: 384_000,
      nickname: "500 minutes, annual ($320/mo × 12)",
    });
    expect(byKey.get("healdesk_metachat-1500_month_90000")?.nickname).toBe("1,500 conversations, monthly");
  });

  test("the setup price is per package, one-time, at the package's fee", () => {
    const setups = computeDesired().packages.map((p) => p.prices.find((x) => x.kind === "setup"));
    expect(setups.map((s) => [s?.lookupKey, s?.amountCents, s?.planId])).toEqual([
      ["healdesk_voice_setup_69700", 69_700, null],
      ["healdesk_webchat_setup_25900", 25_900, null],
      ["healdesk_metachat_setup_69700", 69_700, null],
      ["healdesk_voice-webchat_setup_95600", 95_600, null],
      ["healdesk_voice-metachat_setup_139400", 139_400, null],
    ]);
    expect(stripeLookupKey(getPlan("voice-metachat-900-1200")!, "setup")).toBe("healdesk_voice-metachat_setup_139400");
  });

  test("creation parameters: licensed recurring for a plan, one_time for setup, keyed to the package", () => {
    const pkg = getPackage("voice-webchat")!;
    const desired = packageOf("voice-webchat");
    const month = desired.prices.find((p) => p.lookupKey === "healdesk_voice-webchat-500-300_month_52000")!;
    expect(packagePriceParams(pkg, month, { productId: "prod_vw", transferLookupKey: false })).toEqual({
      product: "prod_vw",
      currency: "usd",
      unit_amount: 52_000,
      lookup_key: "healdesk_voice-webchat-500-300_month_52000",
      transfer_lookup_key: false,
      nickname: "500 minutes + 300 conversations, monthly",
      recurring: { interval: "month", usage_type: "licensed" },
      metadata: {
        healdesk_package_id: "voice-webchat",
        healdesk_plan_id: "voice-webchat-500-300",
        healdesk_price_kind: "month",
      },
    });
    const setup = desired.prices.find((p) => p.kind === "setup")!;
    const params = packagePriceParams(pkg, setup, { productId: "prod_vw", transferLookupKey: true });
    expect(params.recurring).toBeUndefined();
    expect(params.transfer_lookup_key).toBe(true);
    expect(params.metadata).toEqual({ healdesk_package_id: "voice-webchat", healdesk_price_kind: "setup" });
  });

  test("a step label names minutes, conversations or both", () => {
    expect(stepsLabel(getPlan("voice-100")!)).toBe("100 minutes");
    expect(stepsLabel(getPlan("webchat-1500")!)).toBe("1,500 conversations");
    expect(stepsLabel(getPlan("voice-metachat-500-300")!)).toBe("500 minutes + 300 conversations");
  });

  test("each package's description names AYA's products and says overage is billed per started block of 100", () => {
    const vm = describePackage(getPackage("voice-metachat")!);
    expect(vm).toContain("AYA Voice (phone calls) + AYA Meta Chat (Instagram, Messenger, WhatsApp and website chat).");
    expect(vm).toContain("One-time setup fee $1,394;");
    expect(vm).toContain(
      "usage over the included amount billed per started block of 100 voice minutes or 100 chat " +
        "conversations at the published overage rates.",
    );
    expect(vm).toContain("WhatsApp message charges are billed to the clinic by Meta directly.");
    expect(describePackage(getPackage("webchat")!)).toContain(
      "billed per started block of 100 chat conversations at the published overage rates.",
    );
    expect(describePackage(getPackage("webchat")!)).not.toContain("WhatsApp");
    expect(describePackage(getPackage("voice")!)).toContain(
      "billed per started block of 100 voice minutes at the published overage rates.",
    );
    for (const pkg of PACKAGES) {
      // Product names are AYA's (owner, 7 October 2026).
      expect(describePackage(pkg)).not.toMatch(/chatbot|AI voice agent/i);
    }
  });
});

describe("the setup coupons", () => {
  test("one per credit per package, the credit's share of the fee, rounding the buyer's part up", () => {
    const desired = computeDesired();
    expect(desired.packages.flatMap((p) => p.coupons)).toHaveLength(20);
    expect(packageOf("voice").coupons.map((c) => [c.id, c.amountOffCents, c.offer])).toEqual([
      ["healdesk-cohort-setup-voice-69700", 69_700, "cohort-setup"],
      // 50% of $697: the buyer pays $349, so the coupon takes $348.
      ["healdesk-demo-setup-50-voice-34800", 34_800, "demo-setup-50"],
      // 30% of $697 from a homepage demo: the buyer pays $488, so the coupon takes $209.
      ["healdesk-demo-setup-30-voice-20900", 20_900, "demo-setup-30"],
      // The website's 30%: the same amount, its own coupon and name.
      ["healdesk-site-setup-30-voice-20900", 20_900, "site-setup-30"],
    ]);
    // 30% of $259: the buyer pays $182.
    expect(packageOf("webchat").coupons[3]).toMatchObject({ id: "healdesk-site-setup-30-webchat-7700", amountOffCents: 7_700 });
    for (const pkg of desired.packages) {
      for (const coupon of pkg.coupons) {
        const credit = SETUP_COUPON_OFFERS.find((o) => o.offer === coupon.offer)!.credit;
        expect(pkg.setupFeeUsd * 100 - coupon.amountOffCents).toBe(
          setupAfterCreditUsd({ setupFeeUsd: pkg.setupFeeUsd }, credit) * 100,
        );
        expect(coupon.name.length).toBeLessThanOrEqual(40);
      }
    }
  });

  test("the offers are the ones a Session's metadata names (lib/billing.ts SetupOffer)", () => {
    expect(SETUP_COUPON_OFFERS.map((o) => [o.offer, o.credit.percentOfSetupFee])).toEqual([
      ["cohort-setup", 100],
      ["demo-setup-50", 50],
      ["demo-setup-30", 30],
      ["site-setup-30", 30],
    ]);
  });

  test("a coupon whose amount, kind, currency or duration moved is drift", () => {
    const want = packageOf("voice").coupons[1]!;
    const coupon = {
      id: want.id,
      amount_off: want.amountOffCents,
      percent_off: null,
      currency: "usd",
      duration: "once",
      valid: true,
      name: want.name,
    } as unknown as Stripe.Coupon;
    expect(couponProblems(coupon, want)).toEqual([]);
    expect(couponProblems({ ...coupon, amount_off: 34_850 }, want)).toEqual(["amount_off is 34850, want 34800"]);
    expect(couponProblems({ ...coupon, duration: "forever", valid: false }, want)).toEqual([
      "duration is forever, want once",
      "coupon is no longer valid",
    ]);
  });
});

describe("the drift check on a package price", () => {
  const month = () => packageOf("voice").prices.find((p) => p.lookupKey === "healdesk_voice-500_month_40000")!;
  const price = (overrides: Partial<Stripe.Price> = {}) =>
    ({
      unit_amount: 40_000,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      ...overrides,
    }) as unknown as Stripe.Price;

  test("a price made as the catalog says matches; another amount or interval is drift", () => {
    expect(packagePriceProblems(price(), month())).toEqual([]);
    expect(packagePriceProblems(price({ unit_amount: 39_700 }), month())).toEqual([
      "amount is $397, catalog says $400",
    ]);
    expect(
      packagePriceProblems(
        price({ recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } as Stripe.Price.Recurring }),
        month(),
      ),
    ).toEqual(["interval is year, want month"]);
  });

  test("a setup fee that recurs is drift", () => {
    const setup = packageOf("voice").prices.find((p) => p.kind === "setup")!;
    expect(packagePriceProblems(price({ unit_amount: 69_700 }), setup)).toEqual([
      "setup fee is recurring, must be one_time",
    ]);
  });
});

describe("the metered prices the catalog asks for", () => {
  test("three block prices on two meters, under the block keys, at the block price", () => {
    expect(
      computeDesired().meters.map((m) => ({
        event: m.eventName,
        prices: m.prices.map((p) => [p.lookupKey, p.blockCents, p.packageIds]),
      })),
    ).toEqual([
      {
        event: "healdesk_voice_minutes",
        prices: [
          [
            "healdesk_meter_voice_minutes_block100_10400",
            10_400,
            ["voice", "voice-webchat", "voice-metachat"],
          ],
        ],
      },
      {
        event: "healdesk_chat_conversations",
        prices: [
          ["healdesk_meter_chat_conversations_block100_7800", 7_800, ["metachat", "voice-metachat"]],
          ["healdesk_meter_chat_conversations_block100_5200", 5_200, ["webchat", "voice-webchat"]],
        ],
      },
    ]);
  });

  test("the overage products say what a block is, on the name and the description", () => {
    const voice = meterOf("voiceMinutes");
    expect(voice.productName).toBe("Voice minutes over allowance, per started block of 100");
    expect(voice.productDescription).toBe(
      "Billed per started block of 100 minutes beyond the package allowance, monthly in " +
        "arrears: 1 to 100 extra minutes is one block, 101 is two.",
    );
    expect(meterOf("chatConversations").productName).toBe(
      "Chat conversations over allowance, per started block of 100",
    );
  });
});

describe("creating a block price", () => {
  test("package pricing: per_unit at the block price, the total divided by 100 and rounded up, metered monthly on the meter", () => {
    const voice = meterOf("voiceMinutes");
    expect(
      meteredPriceParams(voice, voice.prices[0]!, {
        productId: "prod_voice",
        meterId: "mtr_voice",
        transferLookupKey: false,
      }),
    ).toEqual({
      product: "prod_voice",
      currency: "usd",
      billing_scheme: "per_unit",
      unit_amount: 10_400,
      transform_quantity: { divide_by: 100, round: "up" },
      recurring: { interval: "month", usage_type: "metered", meter: "mtr_voice" },
      lookup_key: "healdesk_meter_voice_minutes_block100_10400",
      transfer_lookup_key: false,
      nickname:
        "Voice minutes over allowance — $104 per started block of 100 minutes " +
        "(voice, voice-webchat, voice-metachat)",
      metadata: { healdesk_meter: "healdesk_voice_minutes" },
    });
  });

  test("never tiers (Stripe refuses a transform on them) and never a per-unit decimal amount", () => {
    for (const meter of computeDesired().meters) {
      for (const rate of meter.prices) {
        const params = meteredPriceParams(meter, rate, {
          productId: "prod_x",
          meterId: "mtr_x",
          transferLookupKey: true,
        });
        expect(params.tiers).toBeUndefined();
        expect(params.tiers_mode).toBeUndefined();
        expect(params.unit_amount_decimal).toBeUndefined();
        expect(params.transform_quantity).toEqual({ divide_by: OVERAGE_BLOCK_UNITS, round: "up" });
        expect(params.unit_amount).toBe(rate.blockCents);
        expect(params.transfer_lookup_key).toBe(true);
      }
    }
    expect(BLOCK_TRANSFORM).toEqual({ divide_by: 100, round: "up" });
  });
});

describe("the drift check on a block price", () => {
  const chat = () => meterOf("chatConversations");

  test("a price made from the creation parameters matches", () => {
    const meter = chat();
    for (const rate of meter.prices) {
      expect(meteredPriceProblems(stripePrice(meter, rate), rate, "mtr_test")).toEqual([]);
    }
  });

  test("a missing transform_quantity is drift: the block price would bill every single unit", () => {
    const meter = chat();
    const rate = meter.prices[1]!;
    expect(
      meteredPriceProblems(
        stripePrice(meter, rate, { transform_quantity: null }),
        rate,
        "mtr_test",
      ),
    ).toEqual(["transform_quantity is unset, want divide_by 100 rounding up"]);
  });

  test("a different divisor or rounding is drift", () => {
    const meter = chat();
    const rate = meter.prices[1]!;
    expect(
      meteredPriceProblems(
        stripePrice(meter, rate, { transform_quantity: { divide_by: 1000, round: "up" } }),
        rate,
        "mtr_test",
      ),
    ).toEqual(["transform_quantity is divide_by 1000 rounding up, want divide_by 100 rounding up"]);
    expect(
      meteredPriceProblems(
        stripePrice(meter, rate, { transform_quantity: { divide_by: 100, round: "down" } }),
        rate,
        "mtr_test",
      ),
    ).toEqual([
      "transform_quantity is divide_by 100 rounding down, want divide_by 100 rounding up",
    ]);
  });

  test("the per-unit amount, a tiered price, a licensed price or another meter is drift", () => {
    const meter = chat();
    const rate = meter.prices[1]!;
    expect(
      meteredPriceProblems(stripePrice(meter, rate, { unit_amount: 52 }), rate, "mtr_test"),
    ).toEqual(["amount is $0.52, catalog says $52 a block"]);
    expect(
      meteredPriceProblems(
        stripePrice(meter, rate, { billing_scheme: "tiered", unit_amount: null }),
        rate,
        "mtr_test",
      ),
    ).toEqual([
      "amount is unset, catalog says $52 a block",
      "billing_scheme is tiered, must be per_unit",
    ]);
    const licensed = stripePrice(meter, rate);
    licensed.recurring = { ...licensed.recurring!, usage_type: "licensed" };
    expect(meteredPriceProblems(licensed, rate, "mtr_test")).toEqual([
      "usage_type is licensed, must be metered",
    ]);
    expect(meteredPriceProblems(stripePrice(meter, rate), rate, "mtr_other")).toEqual([
      "meter is mtr_test, want mtr_other",
    ]);
  });
});

describe("the per-unit prices of 5 October", () => {
  test("are the meter's prefix and a bare amount; block, package and other accounts' keys are not", () => {
    for (const key of [
      "healdesk_meter_voice_minutes_80",
      "healdesk_meter_chat_conversations_40",
      "healdesk_meter_chat_conversations_30",
      // An older rate's per-unit key is per-unit all the same.
      "healdesk_meter_voice_minutes_35",
    ]) {
      expect(isLegacyMeteredKey(key), key).toBe(true);
    }
    for (const key of [
      "healdesk_meter_voice_minutes_block100_10400",
      "healdesk_meter_voice_minutes_block100_8000",
      "healdesk_meter_chat_conversations_block100_3000",
      "healdesk_complete_month_149700",
      "healdesk_plan_start_placeholder_month",
      "scalabid_meter_voice_minutes_80",
      "healdesk_meter_voice_minutes_",
    ]) {
      expect(isLegacyMeteredKey(key), key).toBe(false);
    }
    expect(isLegacyMeteredKey("healdesk_meter_voice_minutes_80", "voiceMinutes")).toBe(true);
    expect(isLegacyMeteredKey("healdesk_meter_voice_minutes_80", "chatConversations")).toBe(false);
  });

  test("a dry run names the per-unit keys the 5 October catalog created", () => {
    expect(legacyPerUnitKeys("voiceMinutes")).toEqual(["healdesk_meter_voice_minutes_80"]);
    expect(legacyPerUnitKeys("chatConversations")).toEqual([
      "healdesk_meter_chat_conversations_30",
      "healdesk_meter_chat_conversations_40",
    ]);
  });

  function fakeStripe() {
    const updates: { id: string; params: unknown }[] = [];
    const stripe = {
      prices: {
        update: async (id: string, params: unknown) => {
          updates.push({ id, params });
          return { id, active: false };
        },
      },
    } as unknown as Pick<Stripe, "prices">;
    return { stripe, updates };
  }

  function active(...keys: string[]): Map<string, Stripe.Price> {
    return new Map(
      keys.map((key) => [key, { id: `price_${key}`, lookup_key: key } as Stripe.Price]),
    );
  }

  test("are archived with active: false, meter by meter, leaving every other price alone", async () => {
    const { stripe, updates } = fakeStripe();
    const prices = active(
      "healdesk_meter_voice_minutes_80",
      "healdesk_meter_voice_minutes_block100_10400",
      // The 6 October block price is not per-unit: reported STALE, never archived.
      "healdesk_meter_voice_minutes_block100_8000",
      "healdesk_meter_chat_conversations_30",
      "healdesk_complete_month_149700",
    );

    const voice = await archiveLegacyMeteredPrices(stripe, prices, "voiceMinutes", { keep: false });
    expect(voice).toEqual({ archived: ["healdesk_meter_voice_minutes_80"], kept: [] });
    expect(updates).toEqual([
      { id: "price_healdesk_meter_voice_minutes_80", params: { active: false } },
    ]);
    // Archived prices leave the map, so the STALE report does not list them again.
    expect([...prices.keys()].sort()).toEqual([
      "healdesk_complete_month_149700",
      "healdesk_meter_chat_conversations_30",
      "healdesk_meter_voice_minutes_block100_10400",
      "healdesk_meter_voice_minutes_block100_8000",
    ]);

    const chat = await archiveLegacyMeteredPrices(stripe, prices, "chatConversations", {
      keep: false,
    });
    expect(chat.archived).toEqual(["healdesk_meter_chat_conversations_30"]);
    expect(updates.map((u) => u.id)).toEqual([
      "price_healdesk_meter_voice_minutes_80",
      "price_healdesk_meter_chat_conversations_30",
    ]);
  });

  test("are kept, and listed, while the meter's block price has drifted", async () => {
    const { stripe, updates } = fakeStripe();
    const prices = active("healdesk_meter_voice_minutes_80");
    expect(
      await archiveLegacyMeteredPrices(stripe, prices, "voiceMinutes", { keep: true }),
    ).toEqual({ archived: [], kept: ["healdesk_meter_voice_minutes_80"] });
    expect(updates).toEqual([]);
    expect(prices.has("healdesk_meter_voice_minutes_80")).toBe(true);
  });
});

describe("what the catalog no longer names", () => {
  test("the 5 October packages' prices and the 6 October block prices are STALE; the current ones are not", () => {
    const desired = computeDesired();
    expect(
      staleLookupKeys(
        [
          "healdesk_complete_month_149700",
          "healdesk_chat-web_setup_49700",
          // "voice" was a 5 October package id too; its old prices are stale by amount.
          "healdesk_voice_month_39700",
          "healdesk_meter_voice_minutes_block100_8000",
          "healdesk_meter_chat_conversations_block100_3000",
          // Current: never stale.
          "healdesk_voice_setup_69700",
          "healdesk_voice-500_month_40000",
          "healdesk_meter_chat_conversations_block100_5200",
          "healdesk_plan_start_placeholder_month",
          // A per-unit key is the meter section's business, and scalabid's are not ours.
          "healdesk_meter_voice_minutes_80",
          "scalabid_pro_month_9900",
        ],
        desired,
      ),
    ).toEqual([
      "healdesk_chat-web_setup_49700",
      "healdesk_complete_month_149700",
      "healdesk_meter_chat_conversations_block100_3000",
      "healdesk_meter_voice_minutes_block100_8000",
      "healdesk_voice_month_39700",
    ]);
  });

  test("the old products are the ones keyed by plan id and not by package id, so the old voice product is never reused", () => {
    const products: { id: string; metadata: Record<string, string> }[] = [
      { id: "prod_old_voice", metadata: { [LEGACY_PLAN_META]: "voice" } },
      { id: "prod_old_complete", metadata: { [LEGACY_PLAN_META]: "complete" } },
      { id: "prod_new_voice", metadata: { [PACKAGE_META]: "voice" } },
      { id: "prod_meter", metadata: { healdesk_meter: "healdesk_voice_minutes" } },
      { id: "prod_scalabid", metadata: {} },
    ];
    expect(legacyPackageProducts(products).map((p) => p.id)).toEqual(["prod_old_voice", "prod_old_complete"]);
    expect(PACKAGE_META).not.toBe(LEGACY_PLAN_META);
  });

  test("setup coupons for a package or an amount the catalog no longer names", () => {
    expect(
      staleCouponIds(
        [
          "healdesk-cohort-setup-complete",
          "healdesk-demo-setup-chat-web",
          "healdesk-demo-setup-50-voice-34800",
          "healdesk-demo-setup-50-voice-35000",
          "healdesk-site-setup-30-voice-20900",
          "scalabid-launch",
        ],
        computeDesired(),
      ),
    ).toEqual([
      "healdesk-cohort-setup-complete",
      "healdesk-demo-setup-50-voice-35000",
      "healdesk-demo-setup-chat-web",
    ]);
  });
});

describe("pacing a thousand creates", () => {
  function fakeClock() {
    let now = 0;
    return {
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      },
    };
  }

  test("stays well under Stripe's test-mode limit of 25 a second", () => {
    expect(REQUESTS_PER_SECOND).toBeLessThanOrEqual(12);
    expect(CONCURRENCY).toBeLessThanOrEqual(REQUESTS_PER_SECOND);
  });

  test("the throttle spaces starts 1000 / perSecond apart, however many ask at once", async () => {
    // Three callers asking in the same instant: the first starts now, the
    // others wait for their slot.
    const sleeps: number[] = [];
    const throttle = new Throttle(10, { now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([throttle.slot(), throttle.slot(), throttle.slot()]);
    expect(sleeps).toEqual([100, 200]);
  });

  test("a 429 is retried with backoff; anything else is thrown at once", async () => {
    const { clock } = fakeClock();
    const throttle = new Throttle(1000, clock);
    let calls = 0;
    const rateLimited = Object.assign(new Error("Too many requests"), { statusCode: 429 });
    const result = await withRateLimitRetry(
      throttle,
      async () => {
        calls += 1;
        if (calls < 3) throw rateLimited;
        return "made";
      },
      { clock, baseMs: 10 },
    );
    expect(result).toBe("made");
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withRateLimitRetry(
        throttle,
        async () => {
          calls += 1;
          throw Object.assign(new Error("No such product"), { statusCode: 400 });
        },
        { clock, baseMs: 10 },
      ),
    ).rejects.toThrow(/No such product/);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      withRateLimitRetry(
        throttle,
        async () => {
          calls += 1;
          throw rateLimited;
        },
        { clock, baseMs: 10, attempts: 4 },
      ),
    ).rejects.toThrow(/Too many/);
    expect(calls).toBe(4);
  });

  test("mapLimited keeps at most `concurrency` in flight and the results in order", async () => {
    let inFlight = 0;
    let most = 0;
    const results = await mapLimited([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(most).toBe(3);
  });

  test("mapLimited stops starting new items after a failure, then throws it", async () => {
    const started: number[] = [];
    await expect(
      mapLimited([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
  });
});

describe("the dry run", () => {
  test("summarises each package rather than printing 990 lines, and --full prints every price", () => {
    const log = vi.mocked(console.log);
    const desired = computeDesired();
    printDryRun(desired);
    const summary = log.mock.calls.map((c) => String(c[0]));
    expect(summary.length).toBeLessThan(120);
    expect(summary).toContain(
      "  · month  225 prices, recurring/month/licensed, $140 … $2,100  " +
        "(healdesk_voice-metachat-100-100_month_14000 … healdesk_voice-metachat-1500-1500_month_210000)",
    );
    expect(summary.some((l) => l.includes("STALE"))).toBe(true);

    log.mockClear();
    printDryRun(desired, { full: true });
    const full = log.mock.calls.map((c) => String(c[0]));
    expect(full.length).toBeGreaterThan(990);
    expect(full.some((l) => l.includes("healdesk_voice-webchat-500-300_month_52000") && l.includes("500 minutes + 300 conversations, monthly"))).toBe(true);
  });

  test("the summary line counts what the catalog asks for", () => {
    expect(summaryLine(computeDesired())).toBe(
      "5 packages carrying 990 plan prices (month and year, 495 plans) and 5 setup prices, " +
        "20 setup coupons, 2 meters carrying 3 metered prices (per started block of 100), no trial",
    );
  });

  test("arguments: --dry-run and --full, nothing else", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true, full: false });
    expect(parseArgs(["--dry-run", "--full"])).toEqual({ dryRun: true, full: true });
    expect(parseArgs(["--live"])).toMatchObject({ error: expect.stringMatching(/Unknown argument/) });
  });
});
