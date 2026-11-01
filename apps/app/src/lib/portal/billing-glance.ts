import type { UsageMeter } from "@/db/schema";
import type { PreviewNextInvoiceResult } from "@/lib/billing/summary";

import { meterWords } from "./billing";
import { portalCount, portalDay, portalMoney } from "./format";

/**
 * The top of Billing (portal redesign, fourth slice, owner, 1 November
 * 2026): the plan and its price, the next charge, and this month's use, as
 * three tiles a clinic reads at a glance. Every figure is one the page
 * already shows below, from the billing summary or Stripe's own preview
 * (lib/portal/billing.ts): nothing here does billing maths of its own. Pure,
 * so the words are one table test.
 */

export type BillingTile = { key: "plan" | "next" | "usage"; label: string; value: string; hint: string };

export function billingTiles(input: {
  packageName: string | null;
  /** The plan's price for one billing period, one location, in whole dollars. */
  periodUsd: number | null;
  interval: "month" | "year";
  locations: number;
  ended: boolean;
  isPlanStarted: boolean;
  nextInvoice: PreviewNextInvoiceResult | null;
  usage: readonly { meter: UsageMeter; used: number; included: number; isWindowOpen: boolean }[];
  timeZone: string;
  now: Date;
}): BillingTile[] {
  const per = input.interval === "year" ? "a year" : "a month";
  const price =
    input.periodUsd === null
      ? ""
      : `${portalMoney(input.periodUsd * 100)} ${per}${input.locations > 1 ? " per location" : ""}`;
  const plan: BillingTile = {
    key: "plan",
    label: "Your plan",
    value: input.packageName ?? "No plan",
    hint: input.ended ? "This plan has ended." : price || "No package on file.",
  };

  // An ended plan has no next charge, and the page says nothing about one
  // (tests/portal-pages.test.tsx, "Billing after cancellation"): no tile.
  let next: BillingTile | null;
  if (input.ended) {
    next = null;
  } else if (!input.isPlanStarted) {
    next = {
      key: "next",
      label: "Next charge",
      value: "$0 for now",
      hint: "Your plan starts the day AYA first answers.",
    };
  } else if (input.nextInvoice?.status === "ok") {
    next = {
      key: "next",
      label: "Next charge",
      value: portalMoney(input.nextInvoice.amountDueCents),
      hint: input.nextInvoice.nextPaymentOn
        ? `On ${portalDay(input.nextInvoice.nextPaymentOn, input.timeZone, input.now)}.`
        : "Date to follow from Stripe.",
    };
  } else {
    next = {
      key: "next",
      label: "Next charge",
      value: "—",
      hint: input.nextInvoice?.status === "not_available" ? input.nextInvoice.message : "Not available right now.",
    };
  }

  const measured = input.usage.filter((m) => m.included > 0);
  let usage: BillingTile;
  if (measured.length === 0) {
    usage = { key: "usage", label: "This month's use", value: "—", hint: "Nothing to measure on this plan." };
  } else if (!measured.some((m) => m.isWindowOpen)) {
    usage = {
      key: "usage",
      label: "This month's use",
      value: "0%",
      hint: "Your allowance starts when your plan does.",
    };
  } else {
    // The meter nearest its allowance is the one worth a glance.
    const top = [...measured].sort((a, b) => b.used / b.included - a.used / a.included)[0]!;
    const [one, many] = meterWords(top.meter);
    usage = {
      key: "usage",
      label: "This month's use",
      value: `${Math.floor((top.used * 100) / top.included)}%`,
      hint: `${portalCount(top.used, one, many)} of ${top.included.toLocaleString("en-US")}.`,
    };
  }
  return next ? [plan, next, usage] : [plan, usage];
}

/** The shortcuts to Billing's sections, in the page's order, for what the page shows. */
export function billingSections(input: { ended: boolean; canChange: boolean }): { id: string; label: string }[] {
  return [
    { id: "plan", label: "Your plan" },
    { id: "usage", label: "Usage" },
    ...(input.ended ? [] : [{ id: "switches", label: "Allowance and renewal" }]),
    ...(input.canChange ? [{ id: "change", label: "Change plan" }] : []),
    { id: "payment-method", label: "Card and invoices" },
    { id: "agreement", label: "Agreement" },
  ];
}
