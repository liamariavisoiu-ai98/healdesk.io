import { describe, expect, test } from "vitest";

import {
  additionalLocationChargeUsd,
  annualTotalUsd,
  billableVoiceMinutes,
  cardForPlan,
  channelList,
  CHANNELS,
  CHAT_CONVERSATION_SILENCE_MS,
  chatChannelOf,
  FIRST_PERIOD_REFUND_DAYS,
  FORWARDING_PASS_THROUGH_DAYS,
  getPlan,
  getPricingCard,
  META_SOLD_ALONE,
  meteredPriceLookupKey,
  METERS,
  offersChatChoice,
  OVERAGE_BLOCK_UNITS,
  overageBlockCents,
  overageBlocks,
  overageChargeCents,
  overageRateCents,
  parseLookupKey,
  type Channel,
  type Plan,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planForCard,
  planForChannels,
  planMeteredPrices,
  plans,
  pricingCards,
  sellsMetaAlone,
  stripeLookupKey,
  type PriceKind,
} from "./plans";

/**
 * The allowances and overage rates the owner set on 5 October 2026. Written
 * out by hand rather than read back from the catalog, so that any edit to what
 * a clinic gets or is billed has to change this table too, on purpose.
 */
const SET_ON_5_OCTOBER: Record<
  string,
  { voiceMinutes: number; chatConversations: number; voiceRate: number; chatRate: number }
> = {
  "chat-web": { voiceMinutes: 0, chatConversations: 1_000, voiceRate: 0, chatRate: 0.4 },
  "chat-meta": { voiceMinutes: 0, chatConversations: 1_000, voiceRate: 0, chatRate: 0.4 },
  voice: { voiceMinutes: 1_000, chatConversations: 0, voiceRate: 0.8, chatRate: 0 },
  "chat-dual": { voiceMinutes: 0, chatConversations: 2_000, voiceRate: 0, chatRate: 0.3 },
  "web-voice": { voiceMinutes: 1_000, chatConversations: 1_000, voiceRate: 0.8, chatRate: 0.3 },
  "meta-voice": { voiceMinutes: 1_000, chatConversations: 1_000, voiceRate: 0.8, chatRate: 0.3 },
  complete: { voiceMinutes: 1_000, chatConversations: 2_000, voiceRate: 0.8, chatRate: 0.3 },
};

describe("allowances and overage rates", () => {
  test("every package carries the numbers set on 5 October 2026", () => {
    expect(plans.map((p) => p.id).sort()).toEqual(Object.keys(SET_ON_5_OCTOBER).sort());
    for (const plan of plans) {
      const want = SET_ON_5_OCTOBER[plan.id]!;
      expect(plan.includedVoiceMinutes, plan.id).toBe(want.voiceMinutes);
      expect(plan.includedChatConversations, plan.id).toBe(want.chatConversations);
      expect(plan.overagePerVoiceMinuteUsd, plan.id).toBe(want.voiceRate);
      expect(plan.overagePerChatConversationUsd, plan.id).toBe(want.chatRate);
    }
  });

  test("a channel a package sells has an allowance and a rate; one it lacks has neither", () => {
    for (const plan of plans) {
      const hasChat = plan.channels.web || plan.channels.meta;
      expect(plan.includedVoiceMinutes > 0, plan.id).toBe(plan.channels.voice);
      expect(plan.overagePerVoiceMinuteUsd > 0, plan.id).toBe(plan.channels.voice);
      expect(plan.includedChatConversations > 0, plan.id).toBe(hasChat);
      expect(plan.overagePerChatConversationUsd > 0, plan.id).toBe(hasChat);
    }
  });
});

describe("metered price lookup keys", () => {
  test("rates are whole cents, and anything else is refused", () => {
    expect(overageRateCents(0.8)).toBe(80);
    // 0.3 * 100 is 30.000000000000004 in floating point; still 30 cents.
    expect(overageRateCents(0.3)).toBe(30);
    expect(overageRateCents(0.4)).toBe(40);
    expect(() => overageRateCents(0.035)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(0)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(-0.3)).toThrow(/whole number of cents/);
    expect(() => overageRateCents(Number.NaN)).toThrow(/whole number of cents/);
  });

  test("the key encodes the meter, the block size and the block price", () => {
    // Per started block of 100 since 6 October 2026: a new price, so a new key.
    // The 5 October per-unit keys (healdesk_meter_voice_minutes_80) are gone.
    expect(meteredPriceLookupKey("voiceMinutes", 0.8)).toBe(
      "healdesk_meter_voice_minutes_block100_8000",
    );
    expect(meteredPriceLookupKey("chatConversations", 0.4)).toBe(
      "healdesk_meter_chat_conversations_block100_4000",
    );
    expect(meteredPriceLookupKey("chatConversations", 0.3)).toBe(
      "healdesk_meter_chat_conversations_block100_3000",
    );
    for (const meter of Object.keys(METERS) as (keyof typeof METERS)[]) {
      expect(meteredPriceLookupKey(meter, 0.3)).toMatch(
        new RegExp(`^${METERS[meter].lookupKeyPrefix}_block${OVERAGE_BLOCK_UNITS}_\\d+$`),
      );
    }
  });

  test("each package bills its own channels at its own rate, per block", () => {
    expect(planMeteredPrices(getPlan("chat-meta")!)).toEqual([
      {
        meter: "chatConversations",
        rateUsd: 0.4,
        blockCents: 4_000,
        lookupKey: "healdesk_meter_chat_conversations_block100_4000",
      },
    ]);
    expect(planMeteredPrices(getPlan("voice")!)).toEqual([
      {
        meter: "voiceMinutes",
        rateUsd: 0.8,
        blockCents: 8_000,
        lookupKey: "healdesk_meter_voice_minutes_block100_8000",
      },
    ]);
    expect(planMeteredPrices(getPlan("complete")!)).toEqual([
      {
        meter: "voiceMinutes",
        rateUsd: 0.8,
        blockCents: 8_000,
        lookupKey: "healdesk_meter_voice_minutes_block100_8000",
      },
      {
        meter: "chatConversations",
        rateUsd: 0.3,
        blockCents: 3_000,
        lookupKey: "healdesk_meter_chat_conversations_block100_3000",
      },
    ]);
  });

  test("the catalog needs exactly three metered prices on two meters", () => {
    const keys = new Set(plans.flatMap((p) => planMeteredPrices(p).map((x) => x.lookupKey)));
    expect([...keys].sort()).toEqual([
      "healdesk_meter_chat_conversations_block100_3000",
      "healdesk_meter_chat_conversations_block100_4000",
      "healdesk_meter_voice_minutes_block100_8000",
    ]);
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
  });

  test("nothing over, or a count that cannot be trusted, is no block at all", () => {
    for (const units of [-1, -250, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(overageBlocks(units), String(units)).toBe(0);
    }
  });

  test("a block costs the per-unit rate times 100, in whole cents", () => {
    // $80 a block of 100 voice minutes; $40 or $30 a block of 100 chat conversations.
    expect(overageBlockCents(0.8)).toBe(8_000);
    expect(overageBlockCents(0.4)).toBe(4_000);
    expect(overageBlockCents(0.3)).toBe(3_000);
    // A rate that is not a positive whole number of cents is refused, as for a unit.
    expect(() => overageBlockCents(0)).toThrow(/whole number of cents/);
    expect(() => overageBlockCents(0.035)).toThrow(/whole number of cents/);
  });

  test("the charge is started blocks times the block price, never units times the rate", () => {
    expect(overageChargeCents(1, 0.8)).toBe(8_000);
    expect(overageChargeCents(100, 0.8)).toBe(8_000);
    expect(overageChargeCents(101, 0.8)).toBe(16_000);
    expect(overageChargeCents(250, 0.8)).toBe(24_000);
    expect(overageChargeCents(250, 0.4)).toBe(12_000);
    expect(overageChargeCents(250, 0.3)).toBe(9_000);
    // Per unit, 250 minutes would have been $200: the blocks are the bill.
    expect(overageChargeCents(250, 0.8)).not.toBe(250 * overageRateCents(0.8));
  });

  test("nothing over costs nothing, even on a meter the package has no rate for", () => {
    expect(overageChargeCents(0, 0.8)).toBe(0);
    expect(overageChargeCents(0, 0)).toBe(0);
    // Units over with no rate is a catalog fault, refused rather than billed as $0.
    expect(() => overageChargeCents(1, 0)).toThrow(/whole number of cents/);
  });

  test("every package's block price is its own per-unit rate times 100", () => {
    for (const plan of plans) {
      for (const price of planMeteredPrices(plan)) {
        expect(price.blockCents, `${plan.id} ${price.meter}`).toBe(
          overageRateCents(price.rateUsd) * OVERAGE_BLOCK_UNITS,
        );
        expect(price.lookupKey).toBe(meteredPriceLookupKey(price.meter, price.rateUsd));
      }
    }
  });
});

const plan = (id: string) => {
  const found = getPlan(id);
  if (!found) throw new Error(`No package ${id}`);
  return found;
};

const card = (id: string) => {
  const found = getPricingCard(id);
  if (!found) throw new Error(`No pricing card ${id}`);
  return found;
};

describe("the twin packages", () => {
  /**
   * Web Chatbot and Meta Chatbot, and Web + Voice and Meta + Voice, are sold
   * from one card at one price. A twin that drifted would show the buyer one
   * price on the card and charge another, so every number but the id, the
   * name and the channels is held equal.
   */
  test("each pair is priced and allowanced identically", () => {
    for (const c of pricingCards.filter(offersChatChoice)) {
      const [web, meta] = c.planIds.map(plan);
      const terms = ({ id: _id, name: _name, channels: _channels, ...rest }: Plan) => rest;
      expect(terms(meta!)).toEqual(terms(web!));
    }
  });

  test("each pair differs only in its chat channel", () => {
    for (const c of pricingCards.filter(offersChatChoice)) {
      const [web, meta] = c.planIds.map(plan);
      expect(web!.channels).toEqual({ ...meta!.channels, web: true, meta: false });
      expect(chatChannelOf(web!)).toBe("web");
      expect(chatChannelOf(meta!)).toBe("meta");
    }
  });

  test("the Stripe lookup keys of a pair never collide", () => {
    // Twins share every amount, so only the package id keeps their prices apart.
    const keys = plans.flatMap((p) =>
      (["month", "year", "setup"] as const).map((kind) => stripeLookupKey(p, kind)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the channel ids", () => {
  test("CHANNELS is every key of a package's channels, in channelList's order", () => {
    // apps/app builds its channel CHECKs from this list, so a channel added
    // to the type and not here would be refused on its first row.
    for (const p of plans) {
      expect(Object.keys(p.channels).sort(), p.id).toEqual([...CHANNELS].sort());
    }
    expect(channelList(plan("complete"))).toEqual(CHANNELS);
  });
});

describe("pricing cards", () => {
  test("every package is on exactly one card", () => {
    const listed = pricingCards.flatMap((c) => c.planIds);
    expect([...listed].sort()).toEqual(plans.map((p) => p.id).sort());
    for (const p of plans) expect(cardForPlan(p).planIds).toContain(p.id);
  });

  test("the pricing page still shows five", () => {
    expect(pricingCards.map((c) => c.id)).toEqual([
      "chat-single",
      "voice",
      "chat-dual",
      "chat-voice",
      "complete",
    ]);
  });

  test("a card resolves to the package for the chat channel picked", () => {
    expect(planForCard(card("chat-single"), "web").id).toBe("chat-web");
    expect(planForCard(card("chat-single"), "meta").id).toBe("chat-meta");
    expect(planForCard(card("chat-voice"), "meta").id).toBe("meta-voice");
    // No pick is the website, which goes live without waiting on Meta.
    expect(planForCard(card("chat-voice")).id).toBe("web-voice");
    // A card without the choice ignores it.
    expect(planForCard(card("complete"), "meta").id).toBe("complete");
  });

  test("card ids never shadow a package id", () => {
    // A `?plan=` link may carry either, so one string must not mean two things
    // — except where a single-package card is named after its own package.
    for (const c of pricingCards) {
      const p = getPlan(c.id);
      if (p) expect(c.planIds).toEqual([p.id]);
    }
  });
});

describe("package lookup keys read back", () => {
  test("every plan and kind round-trips through stripeLookupKey and parseLookupKey", () => {
    const kinds: PriceKind[] = ["month", "year", "setup"];
    for (const plan of plans) {
      for (const kind of kinds) {
        const key = stripeLookupKey(plan, kind);
        const cents =
          kind === "setup" ? plan.setupFeeUsd * 100 : kind === "year" ? annualTotalUsd(plan) * 100 : plan.monthlyUsd * 100;
        expect(parseLookupKey(key), key).toEqual({ planId: plan.id, kind, cents });
      }
    }
  });

  test("anything that is not a package price is not ours to read", () => {
    for (const key of [
      // The metered overage prices, per block (6 October 2026) and the
      // archived per-unit ones before them (5 October).
      "healdesk_meter_voice_minutes_block100_8000",
      "healdesk_meter_chat_conversations_block100_4000",
      "healdesk_meter_chat_conversations_block100_3000",
      "healdesk_meter_voice_minutes_80",
      "healdesk_meter_chat_conversations_40",
      "healdesk_meter_chat_conversations_30",
      ...plans.flatMap((p) => planMeteredPrices(p).map((x) => x.lookupKey)),
      "scalabid_pro_month_9900",
      "healdesk_chat-voice_weekly_100",
      "healdesk_Complete_month_100",
      "healdesk_complete_month_",
      "",
    ]) {
      expect(parseLookupKey(key), key).toBeNull();
    }
  });
});

describe("what one unit of usage is", () => {
  test("a chat conversation ends after 24 hours of silence from the person", () => {
    expect(CHAT_CONVERSATION_SILENCE_MS).toBe(86_400_000);
  });

  test("each call rounds up to the next whole minute, on its own", () => {
    expect(billableVoiceMinutes(1)).toBe(1);
    expect(billableVoiceMinutes(59)).toBe(1);
    expect(billableVoiceMinutes(60)).toBe(1);
    expect(billableVoiceMinutes(61)).toBe(2);
    expect(billableVoiceMinutes(120)).toBe(2);
    expect(billableVoiceMinutes(120.4)).toBe(3);
    // Three 20-second calls are three minutes, never one: calls are metered per call.
    expect([20, 20, 20].map(billableVoiceMinutes).reduce((a, b) => a + b, 0)).toBe(3);
  });

  test("a duration we cannot trust bills nothing", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(billableVoiceMinutes(bad), String(bad)).toBe(0);
    }
  });
});

describe("an extra location", () => {
  test("costs the package's own recurring price again plus its setup fee once", () => {
    const webVoice = getPlan("web-voice")!;
    expect(additionalLocationChargeUsd(webVoice, "month")).toEqual({ recurringUsd: 897, setupFeeUsd: 997 });
    expect(additionalLocationChargeUsd(webVoice, "year")).toEqual({ recurringUsd: 717 * 12, setupFeeUsd: 997 });
    const single = getPlan("chat-web")!;
    expect(additionalLocationChargeUsd(single, "month")).toEqual({ recurringUsd: 397, setupFeeUsd: 497 });
  });

  test("every package prices a location the same way it prices the first", () => {
    for (const plan of plans) {
      expect(additionalLocationChargeUsd(plan, "month").recurringUsd, plan.id).toBe(plan.monthlyUsd);
      expect(additionalLocationChargeUsd(plan, "year").recurringUsd, plan.id).toBe(annualTotalUsd(plan));
      expect(additionalLocationChargeUsd(plan, "month").setupFeeUsd, plan.id).toBe(plan.setupFeeUsd);
    }
  });
});

describe("the refund window", () => {
  test("carries the number the terms quote", () => {
    expect(FIRST_PERIOD_REFUND_DAYS).toBe(14);
  });

  test("forwarded calls pass through for the 30 days terms § 7 promises", () => {
    expect(FORWARDING_PASS_THROUGH_DAYS).toBe(30);
  });
});

describe("the package for the channels in service", () => {
  /**
   * Written out by hand, so a package whose channels changed would have to
   * change this table too: billing follows these sets, and a wrong one bills a
   * clinic for a channel it does not have.
   */
  const SETS: [Channel[], string][] = [
    [["web"], "chat-web"],
    [["meta"], "chat-meta"],
    [["voice"], "voice"],
    [["web", "meta"], "chat-dual"],
    [["web", "voice"], "web-voice"],
    [["meta", "voice"], "meta-voice"],
    [["web", "meta", "voice"], "complete"],
  ];

  test("each of the seven channel sets is exactly one package", () => {
    for (const [channels, id] of SETS) {
      expect(planForChannels(channels)?.id, channels.join("+")).toBe(id);
    }
    expect(new Set(SETS.map(([, id]) => id)).size).toBe(plans.length);
  });

  test("every package is the answer for its own channels", () => {
    for (const p of plans) expect(planForChannels(channelList(p))?.id, p.id).toBe(p.id);
  });

  test("order and repeats do not matter, and any iterable will do", () => {
    expect(planForChannels(["voice", "web"])?.id).toBe("web-voice");
    expect(planForChannels(["meta", "meta", "web", "meta"])?.id).toBe("chat-dual");
    expect(planForChannels(new Set<Channel>(["voice", "meta", "web"]))?.id).toBe("complete");
  });

  test("no channel in service is no package, never a guess", () => {
    expect(planForChannels([])).toBeNull();
    expect(planForChannels(new Set<Channel>())).toBeNull();
  });
});

describe("the plan-start placeholder", () => {
  test("is the $0 price's lookup key, and never reads as a package price", () => {
    expect(PLAN_START_PLACEHOLDER_LOOKUP_KEY).toBe("healdesk_plan_start_placeholder_month");
    expect(parseLookupKey(PLAN_START_PLACEHOLDER_LOOKUP_KEY)).toBeNull();
  });
});

describe("selling Meta on its own", () => {
  test("is open, by the owner's decision of 5 October 2026", () => {
    // Opened ahead of App Review because no marketing has launched (see the
    // flag). Flipping it back is a launch decision, not a refactor: this pin
    // and the /api/checkout test change with it.
    expect(META_SOLD_ALONE).toBe(true);
  });

  test("across the catalog, exactly one package is Meta alone", () => {
    expect(plans.filter(sellsMetaAlone).map((p) => p.id)).toEqual(["chat-meta"]);
  });
});

describe("the demo setup credit", () => {
  test("holds for 48 hours, not the demo's week (owner, 13 October 2026)", async () => {
    const { DEMO_SETUP_CREDIT_HOURS } = await import("./plans");
    expect(DEMO_SETUP_CREDIT_HOURS).toBe(48);
  });

  test("is half the setup fee, in whole dollars, never less than half", async () => {
    const { demoSetupCreditUsd, plans: all } = await import("./plans");
    for (const plan of all) {
      const credit = demoSetupCreditUsd(plan);
      expect(Number.isInteger(credit)).toBe(true);
      expect(credit).toBeGreaterThanOrEqual(plan.setupFeeUsd / 2);
      expect(credit - plan.setupFeeUsd / 2).toBeLessThan(1);
    }
  });

  test("from a homepage demo is 30% of the setup fee, in whole dollars, never less than 30%", async () => {
    const { demoSetupCreditUsd, SELF_SERVE_DEMO_SETUP_CREDIT, plans: all } = await import("./plans");
    expect(SELF_SERVE_DEMO_SETUP_CREDIT.percentOfSetupFee).toBe(30);
    for (const plan of all) {
      const credit = demoSetupCreditUsd(plan, SELF_SERVE_DEMO_SETUP_CREDIT);
      expect(Number.isInteger(credit)).toBe(true);
      expect(credit).toBeGreaterThanOrEqual(plan.setupFeeUsd * 0.3);
      expect(credit - plan.setupFeeUsd * 0.3).toBeLessThan(1);
    }
  });

  test("each credit has its own coupons, offer and a name Stripe will take", async () => {
    const { DEMO_SETUP_CREDITS } = await import("./plans");
    expect(new Set(DEMO_SETUP_CREDITS.map((c) => c.couponId)).size).toBe(DEMO_SETUP_CREDITS.length);
    expect(new Set(DEMO_SETUP_CREDITS.map((c) => c.offer)).size).toBe(DEMO_SETUP_CREDITS.length);
    for (const credit of DEMO_SETUP_CREDITS) {
      expect(credit.name.length).toBeLessThanOrEqual(40);
      expect(credit.name).toContain(`${credit.percentOfSetupFee}%`);
      // Stripe prints the name on Checkout and the invoice: it names no length the offer no longer has.
      expect(credit.name).not.toMatch(/week/i);
    }
  });
});
