import {
  allPlans,
  DEFAULT_STEPS,
  getPlan,
  meteredPriceLookupKey,
  type MeterId,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  overageBlockCents,
  PACKAGES,
  type Plan,
  planFor,
  PRODUCTS,
} from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import PricingPage from "@/app/pricing/page";
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
 * The surfaces are Review and pay, the terms, the demo call's price list and
 * /pricing. The pricing page was disabled on 9 October 2026 and came back on
 * 13 October with the step pricing, which sets each product's "each extra
 * 100" price: $104 for voice minutes, $52 for Web Chat and $78 for Meta Chat
 * conversations. The terms and /pricing state those per product; Review and
 * pay states the ones its plan bills.
 *
 * There are 495 plans. The Stripe check below runs every one of them, since
 * it renders nothing; the checks that render a page run one plan per package,
 * at the sheet's default steps, because a plan's overage depends on its
 * package and never on its steps.
 */

/** One plan per package, at the sheet's default steps: overage depends on the package alone. */
const SAMPLE_PLANS = PACKAGES.map((pkg) => planFor(pkg.id, DEFAULT_STEPS));

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

  test("every plan on the grid", () => {
    expect(allPlans()).toHaveLength(495);
  });

  test.each(allPlans().map((plan) => [plan.id, plan] as const))(
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

const EVERY_PACKAGE_AND_INTERVAL = SAMPLE_PLANS.flatMap((plan) =>
  (["month", "year"] as const).map((interval) => [plan.id, interval] as const),
);

describe("Review and pay states the package's own block prices", () => {
  test.each(EVERY_PACKAGE_AND_INTERVAL)("%s %s", (id, interval) => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    const plan = getPlan(id)!;
    const words = reviewAndPay(plan, interval);
    const when = interval === "year" ? "invoiced monthly" : "on your next invoice";
    const line = words.slice(
      words.indexOf("Past that:"),
      words.indexOf(when) + when.length + 1,
    );
    const parts = said(
      plan,
      (price, meter) =>
        `${price} for each started block of ${OVERAGE_BLOCK_UNITS} extra ${meter === "voiceMinutes" ? "voice minutes" : "chat conversations"}`,
    );
    expect(line.trim()).toBe(`Past that: ${parts.join(" and ")}, ${when}.`);
    // Nothing of our own costs beside the price (owner, 30 October 2026).
    expect(words).not.toMatch(/provisional|cost to serve|measured what/i);
  });
});

describe("Terms section 3 states the block and each product's extra-100 price", () => {
  const markup = renderToStaticMarkup(h(TermsPage));
  const fees = markup.slice(markup.indexOf('id="fees"'), markup.indexOf('id="renewal"'));
  const rows = fees
    .split("<tr")
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => text(cell[1]!)),
    );
  const header = rows[0] ?? [];
  const column = header.indexOf(`Each extra 100, per started block of ${OVERAGE_BLOCK_UNITS}`);

  test("the block rule, with the block the catalog defines", () => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(text(fees)).toContain(
      `every started block of ${OVERAGE_BLOCK_UNITS} extra voice minutes or ${OVERAGE_BLOCK_UNITS} extra chat conversations is billed at that product's price for each extra 100 in the table above`,
    );
    expect(column).toBeGreaterThan(0);
  });

  test.each(Object.values(PRODUCTS).map((product) => [product.name, product] as const))("%s's row", (_name, product) => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    const row = rows.find((cells) => cells[0] === product.name);
    expect(row, product.name).toBeDefined();
    expect(row![column]).toBe(
      `${money(overageBlockCents(product.overagePerUnitUsd))} per ${OVERAGE_BLOCK_UNITS} ${product.unit}s`,
    );
  });

  test("each product's extra-100 price is the block every plan with it is billed", () => {
    // The table states the product; Stripe bills the plan. They are one rate.
    for (const plan of allPlans()) {
      if (plan.channels.voice) {
        expect(plan.overagePerVoiceMinuteUsd, plan.id).toBe(PRODUCTS.voice.overagePerUnitUsd);
      }
      if (plan.chatProduct) {
        expect(plan.overagePerChatConversationUsd, plan.id).toBe(PRODUCTS[plan.chatProduct].overagePerUnitUsd);
      }
    }
  });
});

describe("/pricing states each product's extra-100 price", () => {
  const words = text(renderToStaticMarkup(h(PricingPage)));

  test.each(Object.values(PRODUCTS).map((product) => [product.name, product] as const))("%s", (_name, product) => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    const unit = product.unit === "minute" ? "minutes" : "conversations";
    expect(words).toContain(`${money(overageBlockCents(product.overagePerUnitUsd))} per 100 ${unit}`);
  });

  test("the block rule, and nothing of our costs", () => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(words).toContain(`each started block of ${OVERAGE_BLOCK_UNITS} past your step is billed at that product's extra-100 price`);
    expect(words).not.toMatch(/provisional|cost to serve|measured what/i);
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
        SAMPLE_PLANS
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
      words.indexOf(" Mention overage only if asked"),
    );
    const block = `each started block of ${OVERAGE_BLOCK_UNITS}`;
    expect(line).toBe(
      `Beyond the included amount, overage is billed in blocks of ${OVERAGE_BLOCK_UNITS}: ` +
        `${blockPricesOn("voiceMinutes")} for ${block} extra phone minutes, and ` +
        `${blockPricesOn("chatConversations")} for ${block} extra chat conversations, ` +
        "depending on the package. A block is charged in full once it is started. They're emailed at 90 percent of a step.",
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
      "$104 for each started block of 100 extra voice minutes and $52 for each started block of 100 extra chat conversations",
    ).not.toMatch(PER_UNIT);
    // The step price is per 100, which is not a per-unit rate.
    expect("$80 a month per 100 phone minutes").not.toMatch(PER_UNIT);
  });

  test.each([
    ["the terms", () => text(renderToStaticMarkup(h(TermsPage)))],
    ["the demo call's price list", () => VOICE_DEMO_PRICES.replace(/\s+/g, " ")],
    ["/pricing", () => text(renderToStaticMarkup(h(PricingPage)))],
  ] as const)("%s", (_name, words) => {
    expect(words()).not.toMatch(PER_UNIT);
  });

  test.each(EVERY_PACKAGE_AND_INTERVAL)("Review and pay, %s %s", (id, interval) => {
    expect(reviewAndPay(getPlan(id)!, interval)).not.toMatch(PER_UNIT);
  });
});
