import {
  annualTotalUsd,
  firstInvoiceUsd,
  getPlan,
  getPricingCard,
  OVERAGE_RATES_PROVISIONAL,
  plans,
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
 * Step 6 promises "Pay $X and start setup", and X has to be what Stripe's
 * first invoice will actually carry: the first period plus the one-time setup
 * fee, nothing else. The breakdown above the button is the same arithmetic
 * shown as two lines and a total, so the two are checked against each other
 * here as well as against the catalog, for every package and both intervals.
 * A card that says $894 above a button that charges $397 is the failure this
 * guards against, and it is a quiet one: both numbers look plausible.
 */
describe("due today", () => {
  test.each(plans.map((plan) => [plan.id, plan] as const))(
    "%s billed monthly is the monthly price plus the setup fee",
    (_id, plan) => {
      const due = dueToday(plan, "month");
      expect(due.recurringUsd).toBe(plan.monthlyUsd);
      expect(due.setupFeeUsd).toBe(plan.setupFeeUsd);
      expect(due.totalUsd).toBe(plan.monthlyUsd + plan.setupFeeUsd);
      expect(due.totalUsd).toBe(firstInvoiceUsd(plan, "month"));
      // The lines add up to the total: the breakdown cannot disagree with it.
      expect(due.recurringUsd + due.setupFeeUsd).toBe(due.totalUsd);
      expect(due.periodLabel).toBe("First month");
    },
  );

  test.each(plans.map((plan) => [plan.id, plan] as const))(
    "%s billed annually is twelve months at the annual rate plus the setup fee",
    (_id, plan) => {
      const due = dueToday(plan, "year");
      expect(due.recurringUsd).toBe(plan.annualMonthlyUsd * 12);
      expect(due.recurringUsd).toBe(annualTotalUsd(plan));
      expect(due.totalUsd).toBe(plan.annualMonthlyUsd * 12 + plan.setupFeeUsd);
      expect(due.totalUsd).toBe(firstInvoiceUsd(plan, "year"));
      expect(due.recurringUsd + due.setupFeeUsd).toBe(due.totalUsd);
      expect(due.periodLabel).toBe("First year");
    },
  );

  test("the concrete figures for the entry package", () => {
    const plan = getPlan("chat-web")!;
    expect(dueToday(plan, "month").totalUsd).toBe(397 + 497);
    expect(dueToday(plan, "year").totalUsd).toBe(317 * 12 + 497);
  });

  test("the setup fee is charged once, so renewal is the recurring amount alone", () => {
    for (const plan of plans) {
      const monthly = plan.monthlyUsd.toLocaleString("en-US");
      expect(dueToday(plan, "month").renewsAt).toBe(`$${monthly}/mo`);
      const annual = recurringUsd(plan, "year").toLocaleString("en-US");
      expect(dueToday(plan, "year").renewsAt).toBe(`$${annual}/yr`);
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

  test("the overage line quotes each package's own rate", () => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(overageLine(getPlan("chat-web")!)).toContain("$0.40/conversation");
    expect(overageLine(getPlan("chat-dual")!)).toContain("$0.30/conversation");
    expect(overageLine(getPlan("voice")!)).toContain("$0.80/min");
    expect(overageLine(getPlan("complete")!)).toContain("$0.80/min");
    expect(overageLine(getPlan("complete")!)).toContain("$0.30/conversation");
  });

  test("no overage number is printed while the rates are provisional", () => {
    for (const plan of plans) {
      const line = overageLine(plan);
      if (OVERAGE_RATES_PROVISIONAL) {
        expect(line).toBeNull();
      } else {
        expect(line).not.toBeNull();
        if (plan.overagePerVoiceMinuteUsd === 0) {
          expect(line).not.toContain("/min");
        }
        if (plan.overagePerChatConversationUsd === 0) {
          expect(line).not.toContain("/conversation");
        }
      }
    }
  });
});
