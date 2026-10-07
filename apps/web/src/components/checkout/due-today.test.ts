import {
  getPlan,
  getPricingCard,
  OVERAGE_RATES_PROVISIONAL,
  plans,
  planStartSentence,
  recurringUsd,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  allowanceRows,
  annualSavingsPercent,
  channelChips,
  cheapestPlan,
  dueToday,
  monthlyFigureUsd,
  overageLine,
} from "@/lib/pricing";

/**
 * The number on the pay button.
 *
 * The deferred start (lib/billing.ts): Stripe's first invoice carries the
 * one-time setup fee and a $0 monthly line, so "Pay $X and start setup" must
 * be the setup fee and nothing else. The plan's own price starts the day AYA
 * first answers a patient, said in the catalog's one sentence. A button that
 * charged the setup fee under a breakdown adding the first month would be
 * the quiet failure this guards against: both numbers look plausible.
 */
describe("due today", () => {
  test.each(plans.flatMap((plan) => (["month", "year"] as const).map((interval) => [plan.id, interval, plan] as const)))(
    "%s %s: today is the setup fee alone, and the plan starts at its first answer",
    (_id, interval, plan) => {
      const due = dueToday(plan, interval);
      expect(due.setupFeeUsd).toBe(plan.setupFeeUsd);
      expect(due.totalUsd).toBe(plan.setupFeeUsd);
      expect(due.planStart).toBe(planStartSentence(plan, interval));
      expect(due.planStart).toMatch(/starts the day AYA first answers a patient\.$/);
    },
  );

  test("the concrete figures for the entry package", () => {
    const plan = getPlan("chat-web")!;
    expect(dueToday(plan, "month").totalUsd).toBe(497);
    expect(dueToday(plan, "month").planStart).toBe("Monthly billing ($397) starts the day AYA first answers a patient.");
    expect(dueToday(plan, "year").planStart).toBe(
      `Annual billing ($${(317 * 12).toLocaleString("en-US")} a year) starts the day AYA first answers a patient.`,
    );
  });

  test("the plan's price is quoted per period, from the catalog", () => {
    for (const plan of plans) {
      expect(dueToday(plan, "month").planPrice).toBe(`$${plan.monthlyUsd.toLocaleString("en-US")}/mo`);
      expect(dueToday(plan, "year").planPrice).toBe(`$${recurringUsd(plan, "year").toLocaleString("en-US")}/yr`);
    }
  });

  test("the annual figure on a card is per month, and the saving is the catalog's", () => {
    for (const plan of plans) {
      expect(monthlyFigureUsd(plan, "month")).toBe(plan.monthlyUsd);
      expect(monthlyFigureUsd(plan, "year")).toBe(plan.annualMonthlyUsd);
      expect(annualSavingsPercent(plan)).toBe(20);
    }
    expect(annualSavingsPercent()).toBe(20);
  });
});

describe("the cheapest package is found by price", () => {
  test("not by position in the array", () => {
    const byPrice = Math.min(...plans.map((plan) => plan.monthlyUsd));
    expect(cheapestPlan().monthlyUsd).toBe(byPrice);
  });
});

/**
 * What a card says a package includes. A chip is a promise, so a package that
 * offers one of two chat channels gets one "or" chip rather than two chips, and
 * an allowance of zero produces no line at all rather than "0 voice minutes".
 */
describe("package cards", () => {
  test("a Web OR Meta card shows one chat chip, not two", () => {
    const chips = channelChips(getPricingCard("chat-single")!);
    expect(chips).toEqual(["Website chat or Instagram, Messenger + WhatsApp"]);
  });

  test("a Web + Meta package shows both chat chips", () => {
    expect(channelChips(getPricingCard("chat-dual")!)).toEqual([
      "Website chat",
      "Instagram, Messenger + WhatsApp",
    ]);
  });

  test("voice-only shows only the phone", () => {
    expect(channelChips(getPricingCard("voice")!)).toEqual(["Phone"]);
  });

  test("every channel in the Complete package", () => {
    expect(channelChips(getPricingCard("complete")!)).toEqual([
      "Website chat",
      "Instagram, Messenger + WhatsApp",
      "Phone",
    ]);
  });

  test("both allowance rows are always present; a zero is an em dash, not a missing row", () => {
    expect(allowanceRows(getPlan("voice")!)).toEqual([
      { label: "Included voice minutes", value: "1,000/mo" },
      { label: "Included chat conversations", value: "—" },
    ]);
    expect(allowanceRows(getPlan("chat-web")!)).toEqual([
      { label: "Included voice minutes", value: "—" },
      { label: "Included chat conversations", value: "1,000/mo" },
    ]);
    expect(allowanceRows(getPlan("complete")!)).toEqual([
      { label: "Included voice minutes", value: "1,000/mo" },
      { label: "Included chat conversations", value: "2,000/mo" },
    ]);
  });

  test("the overage line quotes each package's own price for a block of 100", () => {
    // Billed per started block since 6 October 2026 (docs/v1-product-spec.md,
    // "Overage prices"); the footnote under the cards says a started block is
    // billed whole.
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(overageLine(getPlan("chat-web")!)).toBe("$40 per block of 100 conversations");
    expect(overageLine(getPlan("chat-meta")!)).toBe("$40 per block of 100 conversations");
    expect(overageLine(getPlan("chat-dual")!)).toBe("$30 per block of 100 conversations");
    expect(overageLine(getPlan("voice")!)).toBe("$80 per block of 100 minutes");
    expect(overageLine(getPlan("complete")!)).toBe(
      "$80 per block of 100 minutes · $30 per block of 100 conversations",
    );
  });

  test("no overage number is printed while the rates are provisional, and never a per-unit rate", () => {
    for (const plan of plans) {
      const line = overageLine(plan);
      if (OVERAGE_RATES_PROVISIONAL) {
        expect(line).toBeNull();
      } else {
        expect(line).not.toBeNull();
        expect(line).not.toMatch(/\/min|\/conversation|per minute|per conversation|\$0\./);
        if (!plan.channels.voice) expect(line).not.toContain("minutes");
        if (!plan.channels.web && !plan.channels.meta) expect(line).not.toContain("conversations");
      }
    }
  });
});
