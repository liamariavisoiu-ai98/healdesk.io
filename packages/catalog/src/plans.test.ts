import { describe, expect, test } from "vitest";

import {
  additionalLocationChargeUsd,
  allPlans,
  annualTotalUsd,
  billableVoiceMinutes,
  channelList,
  CHANNELS,
  CHAT_CONVERSATION_SILENCE_MS,
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  demoSetupCreditUsd,
  FIRST_PERIOD_REFUND_DAYS,
  FORWARDING_PASS_THROUGH_DAYS,
  getPlan,
  isPlanId,
  isSetupCreditLive,
  isUsageStep,
  meteredPriceLookupKey,
  METERS,
  OVERAGE_BLOCK_UNITS,
  overageBlockCents,
  overageBlocks,
  overageChargeCents,
  overageRateCents,
  PACKAGES,
  packageSetupFeeUsd,
  parseLookupKey,
  type Channel,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planFor,
  planForChannels,
  planIdFor,
  planMeteredPrices,
  PRODUCTS,
  setupAfterCreditUsd,
  setupCouponId,
  setupCreditEndsAt,
  setupCreditUsd,
  setupFeeDeltaUsd,
  SITE_SETUP_CREDIT,
  siteSetupCreditUsd,
  stripeLookupKey,
  USAGE_ALERT_PERCENT,
  USAGE_STEPS,
  type PriceKind,
} from "./plans";

const plan = (id: string) => {
  const found = getPlan(id);
  if (!found) throw new Error(`No plan ${id}`);
  return found;
};

/**
 * The owner's pricing sheet of 13 October 2026, written out by hand rather
 * than read back from the catalog, so any edit to what a clinic is charged has
 * to change this table too, on purpose.
 */
const SHEET = {
  voice: { perStep: 80, extra100: 104, setupList: 697, setupHalf: 349 },
  webchat: { perStep: 40, extra100: 52, setupList: 259, setupHalf: 130 },
  metachat: { perStep: 60, extra100: 78, setupList: 697, setupHalf: 349 },
} as const;

describe("the products on the sheet", () => {
  test("price per 100, extra 100 and setup are the sheet's", () => {
    for (const [id, row] of Object.entries(SHEET)) {
      const product = PRODUCTS[id as keyof typeof SHEET];
      expect(product.perStepMonthlyUsd, id).toBe(row.perStep);
      expect(overageBlockCents(product.overagePerUnitUsd), id).toBe(row.extra100 * 100);
      expect(product.setupFeeUsd, id).toBe(row.setupList);
    }
  });

  test("annual billing is 20% off, in whole dollars", () => {
    expect(PRODUCTS.voice.perStepAnnualMonthlyUsd).toBe(64);
    expect(PRODUCTS.webchat.perStepAnnualMonthlyUsd).toBe(32);
    expect(PRODUCTS.metachat.perStepAnnualMonthlyUsd).toBe(48);
  });

  test("Meta Chat includes the website", () => {
    expect(PRODUCTS.metachat.channels).toEqual(["web", "meta"]);
    expect(plan("metachat-300").channels).toEqual({ web: true, meta: true, voice: false });
  });
});

describe("the packages", () => {
  test("are the sheet's five, in its order", () => {
    expect(PACKAGES.map((p) => p.id)).toEqual(["voice", "webchat", "metachat", "voice-webchat", "voice-metachat"]);
  });

  test("a combined package's setup fee is the sum of its products'", () => {
    const setup = Object.fromEntries(PACKAGES.map((p) => [p.id, packageSetupFeeUsd(p)]));
    expect(setup).toEqual({
      voice: 697,
      webchat: 259,
      metachat: 697,
      "voice-webchat": 956,
      "voice-metachat": 1_394,
    });
  });
});

describe("usage steps", () => {
  test("are 100 to 1,500 in steps of 100", () => {
    expect(USAGE_STEPS).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500]);
    for (const bad of [0, 50, 150, 1_600, -100, 100.5, Number.NaN, "100"]) {
      expect(isUsageStep(bad), String(bad)).toBe(false);
    }
  });

  test("the sheet's 'Find your step' table, every row", () => {
    for (const units of USAGE_STEPS) {
      const steps = units / 100;
      expect(plan(`voice-${units}`).monthlyUsd).toBe(80 * steps);
      expect(plan(`webchat-${units}`).monthlyUsd).toBe(40 * steps);
      expect(plan(`metachat-${units}`).monthlyUsd).toBe(60 * steps);
      expect(plan(`voice-webchat-${units}-${units}`).monthlyUsd).toBe(120 * steps);
      expect(plan(`voice-metachat-${units}-${units}`).monthlyUsd).toBe(140 * steps);
    }
    expect(plan("voice-metachat-1500-1500").monthlyUsd).toBe(2_100);
  });

  test("steps mix: voice 500 with web chat 300 is $520", () => {
    const mixed = planFor("voice-webchat", { voiceMinutes: 500, chatConversations: 300 });
    expect(mixed.id).toBe("voice-webchat-500-300");
    expect(mixed.monthlyUsd).toBe(520);
    expect(mixed.includedVoiceMinutes).toBe(500);
    expect(mixed.includedChatConversations).toBe(300);
    expect(mixed.name).toBe("AYA Voice + Web Chat, 500 minutes and 300 conversations");
  });
});

describe("plan ids", () => {
  test("parse only on the grid", () => {
    for (const id of [
      "voice-500",
      "webchat-100",
      "metachat-1500",
      "voice-webchat-100-1500",
      "voice-metachat-1500-100",
    ]) {
      expect(isPlanId(id), id).toBe(true);
      expect(getPlan(id)!.id).toBe(id);
    }
    for (const id of [
      "voice",
      "voice-150",
      "voice-1600",
      "voice-0",
      "voice-500-300",
      "voice-webchat-500",
      "webchat-300-300",
      "complete",
      "chat-web",
      "voice-0500",
      "",
    ]) {
      expect(isPlanId(id), id).toBe(false);
    }
  });

  test("planIdFor refuses a step a package does not sell", () => {
    expect(() => planIdFor("voice", {})).toThrow(/not on sale/);
    expect(() => planIdFor("webchat", { chatConversations: 250 })).toThrow(/not on sale/);
    expect(planIdFor("voice", { voiceMinutes: 500, chatConversations: 300 })).toBe("voice-500");
  });

  test("there are 495 plans, every one round-trips", () => {
    const all = allPlans();
    expect(all).toHaveLength(15 + 15 + 15 + 225 + 225);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    for (const p of all) expect(getPlan(p.id)).toEqual(p);
  });
});

describe("the sheet's examples", () => {
  test("monthly and setup at 50% off", () => {
    const rows: [string, number, number][] = [
      ["webchat-300", 120, 130],
      ["voice-500", 400, 349],
      ["voice-webchat-500-300", 520, 478],
      ["voice-metachat-500-500", 700, 697],
    ];
    for (const [id, monthly, setup] of rows) {
      expect(plan(id).monthlyUsd, id).toBe(monthly);
      expect(setupAfterCreditUsd(plan(id), DEMO_SETUP_CREDIT), id).toBe(setup);
    }
  });

  test("voice 500 annual: $320 a month, billed yearly", () => {
    expect(plan("voice-500").annualMonthlyUsd).toBe(320);
    expect(annualTotalUsd(plan("voice-500"))).toBe(3_840);
  });

  test("580 minutes on the 500 step is one extra block of $104; the 600 step is $480", () => {
    const voice = plan("voice-500");
    expect(overageChargeCents(580 - voice.includedVoiceMinutes, voice.overagePerVoiceMinuteUsd)).toBe(10_400);
    expect(plan("voice-600").monthlyUsd).toBe(480);
  });

  test("an extra block always costs more than moving up a step", () => {
    for (const product of Object.values(PRODUCTS)) {
      expect(overageBlockCents(product.overagePerUnitUsd)).toBeGreaterThan(product.perStepMonthlyUsd * 100);
    }
  });
});

describe("setup credits", () => {
  test("50% on the 'send me AI' path, 30% on the website, both for 48 hours", () => {
    expect(DEMO_SETUP_CREDIT.percentOfSetupFee).toBe(50);
    expect(SITE_SETUP_CREDIT.percentOfSetupFee).toBe(30);
    expect(DEMO_SETUP_CREDIT.validHours).toBe(48);
    expect(SITE_SETUP_CREDIT.validHours).toBe(48);
  });

  test("what the buyer pays rounds up, the credit is the rest", () => {
    const after30 = Object.fromEntries(
      PACKAGES.map((p) => [p.id, setupAfterCreditUsd({ setupFeeUsd: packageSetupFeeUsd(p) }, SITE_SETUP_CREDIT)]),
    );
    expect(after30).toEqual({ voice: 488, webchat: 182, metachat: 488, "voice-webchat": 670, "voice-metachat": 976 });
    for (const p of allPlans().filter((_, i) => i % 37 === 0)) {
      for (const credit of [DEMO_SETUP_CREDIT, SITE_SETUP_CREDIT, COHORT_SETUP_CREDIT]) {
        const off = setupCreditUsd(p, credit);
        expect(Number.isInteger(off)).toBe(true);
        expect(off + setupAfterCreditUsd(p, credit)).toBe(p.setupFeeUsd);
      }
    }
    expect(demoSetupCreditUsd(plan("voice-500"))).toBe(348);
    expect(siteSetupCreditUsd(plan("voice-500"))).toBe(209);
    expect(setupCreditUsd(plan("voice-500"), COHORT_SETUP_CREDIT)).toBe(697);
  });

  test("one coupon per credit and package, its amount in the id", () => {
    expect(setupCouponId(DEMO_SETUP_CREDIT, plan("voice-500"))).toBe("healdesk-demo-setup-50-voice-34800");
    expect(setupCouponId(DEMO_SETUP_CREDIT, plan("voice-900"))).toBe("healdesk-demo-setup-50-voice-34800");
    expect(setupCouponId(SITE_SETUP_CREDIT, plan("voice-metachat-500-300"))).toBe(
      "healdesk-site-setup-30-voice-metachat-41800",
    );
  });

  test("an offer holds for exactly its hours", () => {
    const at = Date.parse("2026-10-13T12:00:00Z");
    expect(isSetupCreditLive(SITE_SETUP_CREDIT, at, at)).toBe(true);
    expect(isSetupCreditLive(SITE_SETUP_CREDIT, at, at + 48 * 3_600_000 - 1)).toBe(true);
    expect(isSetupCreditLive(SITE_SETUP_CREDIT, at, at + 48 * 3_600_000)).toBe(false);
    expect(isSetupCreditLive(SITE_SETUP_CREDIT, at, at - 1)).toBe(false);
    expect(isSetupCreditLive(SITE_SETUP_CREDIT, Number.NaN, at)).toBe(false);
    expect(setupCreditEndsAt(DEMO_SETUP_CREDIT, at).toISOString()).toBe("2026-10-15T12:00:00.000Z");
  });
});

describe("the usage alert", () => {
  test("is at 90% of the included amount", () => {
    expect(USAGE_ALERT_PERCENT).toBe(90);
  });
});

describe("metered price lookup keys", () => {
  test("rates are whole cents, and anything else is refused", () => {
    expect(overageRateCents(1.04)).toBe(104);
    expect(overageRateCents(0.52)).toBe(52);
    expect(overageRateCents(0.78)).toBe(78);
    expect(() => overageRateCents(0.035)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(0)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(-0.3)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(Number.NaN)).toThrow(/whole number of cents/);
  });

  test("each plan bills its own products at their own rate, per block", () => {
    expect(planMeteredPrices(plan("metachat-300"))).toEqual([
      {
        meter: "chatConversations",
        rateUsd: 0.78,
        blockCents: 7_800,
        lookupKey: "healdesk_meter_chat_conversations_block100_7800",
      },
    ]);
    expect(planMeteredPrices(plan("voice-webchat-500-300"))).toEqual([
      {
        meter: "voiceMinutes",
        rateUsd: 1.04,
        blockCents: 10_400,
        lookupKey: "healdesk_meter_voice_minutes_block100_10400",
      },
      {
        meter: "chatConversations",
        rateUsd: 0.52,
        blockCents: 5_200,
        lookupKey: "healdesk_meter_chat_conversations_block100_5200",
      },
    ]);
  });

  test("the catalog needs exactly three metered prices on two meters", () => {
    const keys = new Set(allPlans().flatMap((p) => planMeteredPrices(p).map((x) => x.lookupKey)));
    expect([...keys].sort()).toEqual([
      "healdesk_meter_chat_conversations_block100_5200",
      "healdesk_meter_chat_conversations_block100_7800",
      "healdesk_meter_voice_minutes_block100_10400",
    ]);
    for (const meter of Object.keys(METERS) as (keyof typeof METERS)[]) {
      expect(meteredPriceLookupKey(meter, 0.52)).toMatch(
        new RegExp(`^${METERS[meter].lookupKeyPrefix}_block${OVERAGE_BLOCK_UNITS}_\\d+$`),
      );
    }
  });
});

describe("overage billed per started block of 100", () => {
  test("a block is 100 units, and any part of one is a whole block", () => {
    expect(OVERAGE_BLOCK_UNITS).toBe(100);
    expect(overageBlocks(0)).toBe(0);
    expect(overageBlocks(1)).toBe(1);
    expect(overageBlocks(100)).toBe(1);
    expect(overageBlocks(101)).toBe(2);
    expect(overageBlocks(250)).toBe(3);
    for (const units of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(overageBlocks(units), String(units)).toBe(0);
    }
  });

  test("the charge is started blocks times the block price", () => {
    expect(overageChargeCents(1, 1.04)).toBe(10_400);
    expect(overageChargeCents(101, 1.04)).toBe(20_800);
    expect(overageChargeCents(250, 0.52)).toBe(15_600);
    expect(overageChargeCents(0, 0)).toBe(0);
    expect(() => overageChargeCents(1, 0)).toThrow(/whole number of cents/);
  });
});

describe("package lookup keys read back", () => {
  test("every plan and kind round-trips; the setup key names the package", () => {
    const kinds: PriceKind[] = ["month", "year", "setup"];
    for (const p of allPlans()) {
      for (const kind of kinds) {
        const key = stripeLookupKey(p, kind);
        const cents =
          kind === "setup" ? p.setupFeeUsd * 100 : kind === "year" ? annualTotalUsd(p) * 100 : p.monthlyUsd * 100;
        expect(parseLookupKey(key), key).toEqual({ planId: kind === "setup" ? p.packageId : p.id, kind, cents });
      }
    }
    expect(stripeLookupKey(plan("voice-webchat-500-300"), "month")).toBe("healdesk_voice-webchat-500-300_month_52000");
    expect(stripeLookupKey(plan("voice-webchat-500-300"), "setup")).toBe("healdesk_voice-webchat_setup_95600");
  });

  test("anything that is not a package price is not ours to read", () => {
    for (const key of [
      "healdesk_meter_voice_minutes_block100_10400",
      "healdesk_meter_chat_conversations_block100_5200",
      "healdesk_meter_voice_minutes_80",
      "scalabid_pro_month_9900",
      "healdesk_voice-500_weekly_100",
      "healdesk_Voice-500_month_100",
      "healdesk_voice-500_month_",
      PLAN_START_PLACEHOLDER_LOOKUP_KEY,
      "",
    ]) {
      expect(parseLookupKey(key), key).toBeNull();
    }
  });
});

describe("the plan for the channels in service", () => {
  const all = plan("voice-metachat-500-300");

  test("bills what is live, at the steps bought", () => {
    const cases: [Channel[], string | null][] = [
      [[], null],
      [["voice"], "voice-500"],
      [["web"], "webchat-300"],
      [["meta"], "metachat-300"],
      [["web", "meta"], "metachat-300"],
      [["voice", "web"], "voice-webchat-500-300"],
      [["voice", "meta"], "voice-metachat-500-300"],
      [["web", "meta", "voice"], "voice-metachat-500-300"],
    ];
    for (const [channels, id] of cases) {
      expect(planForChannels(all, channels)?.id ?? null, channels.join("+")).toBe(id);
    }
  });

  test("a channel the plan does not include is ignored", () => {
    expect(planForChannels(plan("webchat-200"), ["voice", "meta"])).toBeNull();
    expect(planForChannels(plan("voice-webchat-100-200"), ["voice", "meta"])?.id).toBe("voice-100");
  });

  test("every plan is the answer for all of its own channels", () => {
    for (const p of allPlans()) expect(planForChannels(p, channelList(p))?.id, p.id).toBe(p.id);
  });

  test("order, repeats and iterables do not matter", () => {
    expect(planForChannels(all, new Set<Channel>(["meta", "voice", "meta"]))?.id).toBe("voice-metachat-500-300");
  });
});

describe("the setup-fee delta on an upgrade", () => {
  test("a step change owes nothing; a bigger package owes the difference", () => {
    expect(setupFeeDeltaUsd(plan("voice-500"), plan("voice-1500"))).toBe(0);
    expect(setupFeeDeltaUsd(plan("webchat-300"), plan("voice-webchat-500-300"))).toBe(697);
    expect(setupFeeDeltaUsd(plan("voice-metachat-500-300"), plan("voice-500"))).toBe(0);
  });
});

describe("the channel ids", () => {
  test("are the three, in channelList's order", () => {
    expect(CHANNELS).toEqual(["web", "meta", "voice"]);
    expect(channelList(plan("voice-metachat-100-100"))).toEqual(["web", "meta", "voice"]);
  });
});

describe("what one unit of usage is", () => {
  test("a chat conversation ends after 24 hours of silence from the person", () => {
    expect(CHAT_CONVERSATION_SILENCE_MS).toBe(86_400_000);
  });

  test("each call rounds up to the next whole minute, on its own", () => {
    expect(billableVoiceMinutes(1)).toBe(1);
    expect(billableVoiceMinutes(60)).toBe(1);
    expect(billableVoiceMinutes(61)).toBe(2);
    expect([20, 20, 20].map(billableVoiceMinutes).reduce((a, b) => a + b, 0)).toBe(3);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(billableVoiceMinutes(bad), String(bad)).toBe(0);
    }
  });
});

describe("an extra location", () => {
  test("costs the plan's own recurring price again plus its setup fee once", () => {
    const p = plan("voice-webchat-500-300");
    expect(additionalLocationChargeUsd(p, "month")).toEqual({ recurringUsd: 520, setupFeeUsd: 956 });
    expect(additionalLocationChargeUsd(p, "year")).toEqual({ recurringUsd: 416 * 12, setupFeeUsd: 956 });
  });
});

describe("the refund window and the pass-through", () => {
  test("carry the numbers the terms quote", () => {
    expect(FIRST_PERIOD_REFUND_DAYS).toBe(14);
    expect(FORWARDING_PASS_THROUGH_DAYS).toBe(30);
  });
});

describe("the demo setup credits", () => {
  test("50% from an operator's demo, 30% from a homepage demo, both for 48 hours", async () => {
    const { DEMO_SETUP_CREDITS, SELF_SERVE_DEMO_SETUP_CREDIT } = await import("./plans");
    expect(DEMO_SETUP_CREDIT.percentOfSetupFee).toBe(50);
    expect(SELF_SERVE_DEMO_SETUP_CREDIT.percentOfSetupFee).toBe(30);
    for (const credit of DEMO_SETUP_CREDITS) expect(credit.validHours).toBe(48);
    expect(demoSetupCreditUsd(plan("voice-500"), SELF_SERVE_DEMO_SETUP_CREDIT)).toBe(209);
  });

  test("the coupon names Stripe shows the buyer say nothing about being new", async () => {
    const { SETUP_CREDITS } = await import("./plans");
    // Stripe prints a coupon's name on Checkout and on the invoice. The cohort
    // credit was "Founding-cohort setup credit" until it was renamed (plan
    // Part A6); no credit may say "founding", "cohort", "pilot" or the like.
    expect(COHORT_SETUP_CREDIT.name).toBe("Setup credit");
    for (const credit of SETUP_CREDITS) {
      expect(credit.name, credit.couponId).not.toMatch(/\b(?:pilot|beta|early access|first clinics|founding|cohort)\b/i);
    }
  });

  test("each credit has its own coupons and a name Stripe will take", async () => {
    const { SETUP_CREDITS } = await import("./plans");
    expect(new Set(SETUP_CREDITS.map((c) => c.couponId)).size).toBe(SETUP_CREDITS.length);
    for (const credit of SETUP_CREDITS) {
      expect(credit.name.length).toBeLessThanOrEqual(40);
      if (credit.percentOfSetupFee < 100) expect(credit.name).toContain(`${credit.percentOfSetupFee}%`);
    }
  });
});
