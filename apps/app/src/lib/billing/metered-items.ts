import {
  getPlan,
  OVERAGE_RATES_PROVISIONAL,
  planMeteredPrices,
  type BillingInterval,
} from "@healdesk/catalog";
import type Stripe from "stripe";

/**
 * The metered overage prices a subscription should carry, or null when the
 * plan is not in the catalog.
 *
 * Monthly plans bill overage through Stripe's meters: the subscription
 * carries one metered price per meter its package uses, at that package's
 * rate (catalog `planMeteredPrices`). Annual plans carry none — Stripe sends
 * one invoice a year, so their overage is invoiced per closed allowance month
 * by lib/billing/annual-overage.ts instead.
 *
 * While the catalog's `OVERAGE_RATES_PROVISIONAL` is true, nothing carries a
 * metered price: checkout leaves them off (apps/web `meteredLookupKeysFor`)
 * and the terms tell the buyer usage above the allowance is not billed, so a
 * reconciler must not add them afterwards either.
 *
 * Null is "unknown", which is not the same answer as [] ("carry none"): a
 * subscription on a plan id that has left the catalog must be left alone,
 * not stripped of the metered items it was sold with. Callers skip
 * reconciliation on null.
 */
export function expectedMeteredKeys(planId: string, interval: BillingInterval): string[] | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  if (OVERAGE_RATES_PROVISIONAL) return [];
  if (interval !== "month") return [];
  return planMeteredPrices(plan)
    .map((price) => price.lookupKey)
    .sort();
}

/**
 * STUB (package C replaces it). Make the clinic's subscription carry exactly
 * the expected metered items. Never inside a transaction.
 */
export async function reconcileMeteredItems(
  clinicId: string,
  options: { stripe?: Stripe } = {},
): Promise<{ status: "ok" | "fixed" | "skipped" | "failed"; reason?: string }> {
  void clinicId;
  void options;
  return { status: "skipped", reason: "Not built yet." };
}
