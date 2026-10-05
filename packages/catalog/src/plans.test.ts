import { describe, expect, test } from "vitest";

import {
  cardForPlan,
  chatChannelOf,
  getPlan,
  getPricingCard,
  meteredPriceLookupKey,
  offersChatChoice,
  overageRateCents,
  type Plan,
  planForCard,
  planMeteredPrices,
  plans,
  pricingCards,
  stripeLookupKey,
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

  test("the key encodes the meter and the rate", () => {
    expect(meteredPriceLookupKey("voiceMinutes", 0.8)).toBe("healdesk_meter_voice_minutes_80");
    expect(meteredPriceLookupKey("chatConversations", 0.3)).toBe(
      "healdesk_meter_chat_conversations_30",
    );
  });

  test("each package bills its own channels at its own rate", () => {
    expect(planMeteredPrices(getPlan("chat-meta")!)).toEqual([
      { meter: "chatConversations", rateUsd: 0.4, lookupKey: "healdesk_meter_chat_conversations_40" },
    ]);
    expect(planMeteredPrices(getPlan("voice")!)).toEqual([
      { meter: "voiceMinutes", rateUsd: 0.8, lookupKey: "healdesk_meter_voice_minutes_80" },
    ]);
    expect(planMeteredPrices(getPlan("complete")!)).toEqual([
      { meter: "voiceMinutes", rateUsd: 0.8, lookupKey: "healdesk_meter_voice_minutes_80" },
      { meter: "chatConversations", rateUsd: 0.3, lookupKey: "healdesk_meter_chat_conversations_30" },
    ]);
  });

  test("the catalog needs exactly three metered prices on two meters", () => {
    const keys = new Set(plans.flatMap((p) => planMeteredPrices(p).map((x) => x.lookupKey)));
    expect([...keys].sort()).toEqual([
      "healdesk_meter_chat_conversations_30",
      "healdesk_meter_chat_conversations_40",
      "healdesk_meter_voice_minutes_80",
    ]);
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
