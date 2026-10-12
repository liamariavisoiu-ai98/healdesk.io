import {
  getPlan,
  meteredPriceLookupKey,
  type MeterId,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  overageBlockCents,
  type Plan,
  plans,
} from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import TermsPage from "@/app/terms/page";
import type { AgreementResult } from "@/components/checkout/AgreementStep";
import { ReviewStep } from "@/components/checkout/ReviewStep";
import { siteReadLine } from "@/lib/checkout/site-read";
import { VOICE_DEMO_PRICES } from "@/lib/voice-demo-prompt";

import { computeDesired, meteredPriceParams } from "../../scripts/stripe-setup";

/**
 * The overage copy and the overage billing cannot drift apart again.
 *
 * On 6 October 2026 the owner moved overage from per unit to per started
 * block of 100 (docs/v1-product-spec.md, "Overage prices"). The billing moved
 * first: Stripe's metered prices became $80 a block of 100 minutes and $40 or
 * $30 a block of 100 conversations, while the Terms, the pricing cards,
 * Review & pay and the demo call still quoted $0.80 a minute, and stripe:setup
 * was held back on live until the words caught up
 * (docs/design/stripe-bcd-as-built-2026-10-07.md).
 *
 * So every number below is worked out here from the catalog's per-unit rates
 * with `overageBlockCents()` and `OVERAGE_BLOCK_UNITS`, not from the
 * `overageBlockPrices()` or `planMeteredPrices()` the surfaces print with, and
 * held against what each surface says and against the price stripe:setup
 * creates: the block price is the metered price's `unit_amount`, and the block
 * size its `transform_quantity`, rounded up, which is what "started" means. A
 * change to the rates, the block or the wording on one side only fails here.
 *
 * The surfaces are Review and pay, the terms and the demo call's price list.
 * The pricing page and its cards were the fourth until the owner disabled the
 * page on 9 October 2026; packages and prices are shown in the buy flow now,
 * and its package step quotes no overage, so Review and pay is where a buyer
 * reads the block and its price before paying.
 */

const text = (markup: string) =>
  markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;

/** A package's price for one started block on each meter it bills, from the catalog's rates alone. */
function expected(plan: Plan): Record<MeterId, string | null> {
  return {
    voiceMinutes: plan.channels.voice
      ? money(overageBlockCents(plan.overagePerVoiceMinuteUsd))
      : null,
    chatConversations:
      plan.channels.web || plan.channels.meta
        ? money(overageBlockCents(plan.overagePerChatConversationUsd))
        : null,
  };
}

const rateOf = (plan: Plan, meter: MeterId) =>
  meter === "voiceMinutes" ? plan.overagePerVoiceMinuteUsd : plan.overagePerChatConversationUsd;

/** What one surface says per meter, joined the way it joins them. */
function said(plan: Plan, each: (price: string, meter: MeterId) => string): string[] {
  const want = expected(plan);
  return (["voiceMinutes", "chatConversations"] as const)
    .filter((meter) => want[meter] !== null)
    .map((meter) => each(want[meter]!, meter));
}

/**
 * Every way overage has been quoted per unit: "$0.80/min", "$0.30 a chat
 * conversation", "billed per minute or per conversation". Word boundaries,
 * because the block wording's "extra voice minutes" holds "a voice minute".
 */
const PER_UNIT =
  /\/min\b|\/conversation|\bper (?:voice |phone )?minute|\bper (?:chat )?conversation|\ba (?:voice|phone) minute|\ba chat conversation|\$0\.\d\d/i;

describe("the block Stripe bills is the block the catalog defines", () => {
  const desired = computeDesired();
  const stripe = new Map(
    desired.meters.flatMap((meter) =>
      meter.prices.map((price) => {
        const params = meteredPriceParams(meter, price, {
          productId: "prod_overage_copy",
          meterId: "mtr_overage_copy",
          transferLookupKey: false,
        });
        return [price.lookupKey, params] as const;
      }),
    ),
  );

  test.each(plans.map((plan) => [plan.id, plan] as const))(
    "%s: each metered price charges the block price for every started block",
    (_id, plan) => {
      const want = expected(plan);
      for (const meter of ["voiceMinutes", "chatConversations"] as const) {
        if (want[meter] === null) continue;
        const params = stripe.get(meteredPriceLookupKey(meter, rateOf(plan, meter)));
        expect(params, `${plan.id} ${meter}`).toBeDefined();
        expect(money(params!.unit_amount!)).toBe(want[meter]);
        expect(params!.transform_quantity).toEqual({ divide_by: OVERAGE_BLOCK_UNITS, round: "up" });
      }
    },
  );
});

const SIGNED: AgreementResult = {
  agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
  version: "1.2.1",
  hash: "a".repeat(64),
  text: "HEALDESK BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions...",
  acceptedAt: "2026-10-06T10:00:00.000Z",
  approvedByCounsel: true,
};
const noop = () => undefined;

/** Review and pay for one package and interval, read as text. */
function reviewAndPay(plan: Plan, interval: "month" | "year"): string {
  return text(
    renderToStaticMarkup(
      h(ReviewStep, {
        plan,
        interval,
        specialty: "med-spa",
        clinicName: "Glow Med Spa LLC",
        siteRead: siteReadLine(null, "glowmedspa.com"),
        salesTax: false,
        agreement: SIGNED,
        copyLink: h("a", { href: "#" }, "Download"),
        termsAccepted: false,
        onTerms: noop,
        submitting: false,
        error: null,
        onPay: noop,
        onBack: noop,
      }),
    ),
  );
}

const EVERY_PACKAGE_AND_INTERVAL = plans.flatMap((plan) =>
  (["month", "year"] as const).map((interval) => [plan.id, interval] as const),
);

describe("Review and pay states the package's own block prices", () => {
  test.each(EVERY_PACKAGE_AND_INTERVAL)("%s %s", (id, interval) => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    const plan = getPlan(id)!;
    const words = reviewAndPay(plan, interval);
    const line = words.slice(
      words.indexOf("Past that:"),
      words.indexOf("These rates are provisional"),
    );
    const parts = said(
      plan,
      (price, meter) =>
        `${price} for each started block of ${OVERAGE_BLOCK_UNITS} extra ${meter === "voiceMinutes" ? "voice minutes" : "chat conversations"}`,
    );
    const when = interval === "year" ? "invoiced monthly" : "on your next invoice";
    expect(line.trim()).toBe(`Past that: ${parts.join(" and ")}, ${when}.`);
    // Provisional, said beside the price, as the pricing cards' ", provisional"
    // said it until the cards went with /pricing (CLAUDE.md, "Claims and copy").
    expect(words).toContain(
      `${when}. These rates are provisional until we have measured what a minute and a conversation cost to serve.`,
    );
  });
});

describe("Terms section 3 states the block and each package's block prices", () => {
  const markup = renderToStaticMarkup(h(TermsPage));
  const fees = markup.slice(markup.indexOf('id="fees"'), markup.indexOf('id="renewal"'));
  const rows = fees
    .split("<tr")
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => text(cell[1]!)),
    );
  const header = rows[0] ?? [];
  const column: Record<MeterId, number> = {
    voiceMinutes: header.indexOf(
      `Extra voice, per started block of ${OVERAGE_BLOCK_UNITS} minutes`,
    ),
    chatConversations: header.indexOf(
      `Extra chat, per started block of ${OVERAGE_BLOCK_UNITS} conversations`,
    ),
  };

  test("the block rule, with the block the catalog defines", () => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(text(fees)).toContain(
      `every started block of ${OVERAGE_BLOCK_UNITS} extra voice minutes or ${OVERAGE_BLOCK_UNITS} extra chat conversations is billed at your package's block price in the table above`,
    );
    expect(column.voiceMinutes).toBeGreaterThan(0);
    expect(column.chatConversations).toBeGreaterThan(0);
  });

  test.each(plans.map((plan) => [plan.name, plan] as const))("%s's row", (_name, plan) => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    const row = rows.find((cells) => cells[0] === plan.name);
    expect(row, plan.name).toBeDefined();
    const want = expected(plan);
    expect(row![column.voiceMinutes]).toBe(want.voiceMinutes ?? "—");
    expect(row![column.chatConversations]).toBe(want.chatConversations ?? "—");
  });
});

/**
 * The demo call's price list covers every package at once, so each meter's
 * sentence names every block price a package bills on it, cheapest first. The
 * agent quotes from it to prospects once scripts/retell-demo-agent.ts has
 * pushed the prompt, so a price typed into the prompt would outlive a catalog
 * change and be quoted after Stripe had stopped billing it. The prompt carries
 * the prices whatever OVERAGE_RATES_PROVISIONAL says, so unlike the checks
 * above this one is not skipped while the flag is set.
 */
describe("the demo call quotes the block and every block price the packages bill", () => {
  /** One meter's block prices across the packages that bill it, from the catalog's rates alone. */
  const blockPricesOn = (meter: MeterId) =>
    [
      ...new Set(
        plans
          .filter((plan) => expected(plan)[meter] !== null)
          .map((plan) => overageBlockCents(rateOf(plan, meter))),
      ),
    ]
      .sort((a, b) => a - b)
      .map(money)
      .join(" or ");

  test("the overage sentence on the price list", () => {
    const words = VOICE_DEMO_PRICES.replace(/\s+/g, " ");
    const line = words.slice(
      words.indexOf("Beyond the included amount"),
      words.indexOf(" These overage rates are provisional"),
    );
    const block = `each started block of ${OVERAGE_BLOCK_UNITS}`;
    expect(line).toBe(
      `Beyond the included amount, overage is billed in blocks of ${OVERAGE_BLOCK_UNITS}: ` +
        `${blockPricesOn("voiceMinutes")} for ${block} extra phone minutes, and ` +
        `${blockPricesOn("chatConversations")} for ${block} extra chat conversations, ` +
        "depending on the package. A block is charged in full once it is started.",
    );
  });
});

describe("no surface quotes a per-unit rate", () => {
  test("the rule catches the wording the blocks replaced, and passes the blocks", () => {
    for (const old of [
      "$0.80/min · $0.30/conversation",
      "Past that: $0.80 a voice minute and $0.30 a chat conversation",
      "Beyond the included amount: $0.80 a phone minute",
      "Past the allowance you are billed per minute or per conversation",
      "per voice minute and per chat conversation",
    ]) {
      expect(old).toMatch(PER_UNIT);
    }
    expect(
      "$80 for each started block of 100 extra voice minutes and $30 for each started block of 100 extra chat conversations",
    ).not.toMatch(PER_UNIT);
  });

  test.each([
    ["the terms", () => text(renderToStaticMarkup(h(TermsPage)))],
    ["the demo call's price list", () => VOICE_DEMO_PRICES.replace(/\s+/g, " ")],
  ] as const)("%s", (_name, words) => {
    expect(words()).not.toMatch(PER_UNIT);
  });

  test.each(EVERY_PACKAGE_AND_INTERVAL)("Review and pay, %s %s", (id, interval) => {
    expect(reviewAndPay(getPlan(id)!, interval)).not.toMatch(PER_UNIT);
  });
});
