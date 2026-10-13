import {
  allPlans,
  ANNUAL_DISCOUNT_PERCENT,
  getPlan,
  PACKAGES,
  PRODUCTS,
  planStartSentence,
  setupAfterCreditUsd,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  payLabel,
  planStartLine,
  SETUP_OFFER_CREDITS,
  SETUP_OFFER_KINDS,
  type SetupOffer,
  setupDueUsd,
  setupFeeToday,
} from "@/lib/checkout/review";
import { dueToday } from "@/lib/pricing";

import { perStepLabel, productsOf } from "./PackageStep";

/**
 * The number on the pay button.
 *
 * The deferred start (lib/billing.ts): Stripe's first invoice carries the
 * one-time setup fee and a $0 monthly line, so "Pay $X and start setup" must
 * be the setup fee, after the one setup offer that applies, and nothing else.
 * The plan's own price starts the day AYA first answers a patient, said in
 * the catalog's one sentence. A button that charged the setup fee under a
 * breakdown adding the first month would be the quiet failure this guards
 * against: both numbers look plausible. So the button and today's headline
 * (lib/checkout/review.ts) are held to the "Due today" breakdown
 * (lib/pricing.ts, `dueToday`), with and without each offer.
 */

const ENDS = "2099-01-01T00:00:00.000Z";
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

describe("due today", () => {
  test.each(
    allPlans()
      .filter((_, i) => i % 7 === 0)
      .flatMap((plan) => (["month", "year"] as const).map((interval) => [plan.id, interval, plan] as const)),
  )("%s %s: the button is the setup fee alone, and the plan starts at its first answer", (_id, interval, plan) => {
    const due = dueToday(plan, interval);
    expect(due.totalUsd).toBe(plan.setupFeeUsd);
    expect(payLabel(plan)).toBe(`Pay ${usd(due.totalUsd)} and start setup`);
    expect(setupFeeToday(plan).headline).toBe(`Today: ${usd(due.totalUsd)} setup fee`);
    expect(planStartLine(plan, interval, "med-spa")).toBe(due.planStart);
    expect(due.planStart).toBe(planStartSentence(plan, interval));
    expect(due.planStart).toMatch(/starts the day AYA first answers a patient\.$/);

    for (const kind of SETUP_OFFER_KINDS) {
      const offer: SetupOffer = { kind, endsAt: ENDS };
      const credited = dueToday(plan, interval, SETUP_OFFER_CREDITS[kind]);
      expect(setupDueUsd(plan, offer), kind).toBe(credited.totalUsd);
      expect(setupDueUsd(plan, offer), kind).toBe(setupAfterCreditUsd(plan, SETUP_OFFER_CREDITS[kind]));
      expect(payLabel(plan, offer), kind).toBe(`Pay ${usd(credited.totalUsd)} and start setup`);
    }
  });

  test("the sheet's own figures", () => {
    const voice = getPlan("voice-500")!;
    // 50% of $697 is $348.50 and the buyer pays $349; 30% leaves $487.90, so $488.
    expect(payLabel(voice, { kind: "demo", endsAt: ENDS })).toBe("Pay $349 and start setup");
    expect(payLabel(voice, { kind: "site", endsAt: ENDS })).toBe("Pay $488 and start setup");
    expect(payLabel(getPlan("webchat-300")!, { kind: "site", endsAt: ENDS })).toBe(
      "Pay $182 and start setup",
    );
    expect(planStartLine(getPlan("voice-webchat-500-300")!, "month", null)).toBe(
      "Monthly billing ($520) starts the day AYA first answers a patient.",
    );
    expect(planStartLine(voice, "year", null)).toBe(
      "Annual billing ($3,840 a year) starts the day AYA first answers a patient.",
    );
  });
});

describe("the package step's figures", () => {
  test("each product's price per step, monthly and on annual terms", () => {
    expect(perStepLabel(PRODUCTS.voice, "month")).toBe("$80 per 100 minutes");
    expect(perStepLabel(PRODUCTS.webchat, "month")).toBe("$40 per 100 conversations");
    expect(perStepLabel(PRODUCTS.metachat, "month")).toBe("$60 per 100 conversations");
    expect(perStepLabel(PRODUCTS.voice, "year")).toBe("$64 per 100 minutes");
    expect(ANNUAL_DISCOUNT_PERCENT).toBe(20);
  });

  test("a package's products are voice first, then its chat", () => {
    expect(PACKAGES.map((pkg) => productsOf(pkg).map((p) => p.id))).toEqual([
      ["voice"],
      ["webchat"],
      ["metachat"],
      ["voice", "webchat"],
      ["voice", "metachat"],
    ]);
  });
});
