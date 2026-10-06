import { describe, expect, test } from "vitest";

import {
  cardForPlan,
  chatChannelOf,
  getPlan,
  getPricingCard,
  META_SOLD_ALONE,
  offersChatChoice,
  type Plan,
  plans,
  planForCard,
  pricingCards,
  sellsMetaAlone,
  stripeLookupKey,
} from "./plans";

/**
 * Whether Meta is sold on its own, and what that switch reaches.
 *
 * The switch is narrow on purpose. When it is off it closes exactly one
 * package, the one with Meta as the clinic's only channel, and leaves every
 * package that pairs Meta with website chat or the phone on sale. The checkout
 * UI and /api/checkout both read `sellsMetaAlone()`, so these cases are the
 * whole of what it can close.
 */

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

describe("selling Meta on its own", () => {
  test("is open, by the owner's decision of 5 October 2026", () => {
    // Opened ahead of App Review because no marketing has launched (see the
    // flag). Flipping it back is a launch decision, not a refactor: this pin
    // and the /api/checkout and checkout-UI tests change with it.
    expect(META_SOLD_ALONE).toBe(true);
  });

  test("across the catalog, exactly one package is Meta alone", () => {
    expect(plans.filter(sellsMetaAlone).map((p) => p.id)).toEqual(["chat-meta"]);
  });
});

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
