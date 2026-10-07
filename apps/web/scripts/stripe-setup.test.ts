import { getPlan, METERS, OVERAGE_BLOCK_UNITS } from "@healdesk/catalog";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  archiveLegacyMeteredPrices,
  BLOCK_TRANSFORM,
  catalogLegacyMeteredKeys,
  computeDesired,
  describePackage,
  isLegacyMeteredKey,
  meteredPriceParams,
  meteredPriceProblems,
  type DesiredMeter,
  type DesiredMeteredPrice,
} from "./stripe-setup";

/**
 * The pure parts of stripe-setup (owner's decision of 6 October 2026: overage
 * is billed per started block of 100). Each metered price is package-priced,
 * per_unit at the price of a block with the period's total divided by 100 and
 * rounded up, under the block keys; the drift check catches a price whose
 * transform is missing or different; the per-unit prices of 5 October are
 * archived. Importing the script must not run it.
 */

beforeEach(() => {
  // The archive step reports each price it touches on stdout, as the run does.
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

describe("the metered prices the catalog asks for", () => {
  test("three block prices on two meters, under the block keys, at the block price", () => {
    expect(
      computeDesired().meters.map((m) => ({
        event: m.eventName,
        prices: m.prices.map((p) => [p.lookupKey, p.blockCents, p.planIds]),
      })),
    ).toEqual([
      {
        event: "healdesk_voice_minutes",
        prices: [
          [
            "healdesk_meter_voice_minutes_block100_8000",
            8_000,
            ["voice", "web-voice", "meta-voice", "complete"],
          ],
        ],
      },
      {
        event: "healdesk_chat_conversations",
        prices: [
          ["healdesk_meter_chat_conversations_block100_4000", 4_000, ["chat-web", "chat-meta"]],
          [
            "healdesk_meter_chat_conversations_block100_3000",
            3_000,
            ["chat-dual", "web-voice", "meta-voice", "complete"],
          ],
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

  test("each package's description says its overage is billed per started block of 100", () => {
    expect(describePackage(getPlan("complete")!)).toContain(
      "usage over the allowance billed per started block of 100 voice minutes or 100 chat " +
        "conversations at the published overage rates.",
    );
    expect(describePackage(getPlan("chat-web")!)).toContain(
      "billed per started block of 100 chat conversations at the published overage rates.",
    );
    expect(describePackage(getPlan("voice")!)).toContain(
      "billed per started block of 100 voice minutes at the published overage rates.",
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
      unit_amount: 8_000,
      transform_quantity: { divide_by: 100, round: "up" },
      recurring: { interval: "month", usage_type: "metered", meter: "mtr_voice" },
      lookup_key: "healdesk_meter_voice_minutes_block100_8000",
      transfer_lookup_key: false,
      nickname:
        "Voice minutes over allowance — $80 per started block of 100 minutes " +
        "(voice, web-voice, meta-voice, complete)",
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
      meteredPriceProblems(stripePrice(meter, rate, { unit_amount: 30 }), rate, "mtr_test"),
    ).toEqual(["amount is $0.30, catalog says $30 a block"]);
    expect(
      meteredPriceProblems(
        stripePrice(meter, rate, { billing_scheme: "tiered", unit_amount: null }),
        rate,
        "mtr_test",
      ),
    ).toEqual([
      "amount is unset, catalog says $30 a block",
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
    expect(catalogLegacyMeteredKeys("voiceMinutes")).toEqual(["healdesk_meter_voice_minutes_80"]);
    expect(catalogLegacyMeteredKeys("chatConversations")).toEqual([
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
