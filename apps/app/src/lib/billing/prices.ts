import type Stripe from "stripe";

import { getStripe } from "./stripe-client";
import { WORKER_STRIPE_OPTIONS } from "./stripe-helpers";

/**
 * Stripe price ids, found by the catalog's lookup keys (build spec BD2, R41).
 *
 * The catalog names every price by a stable lookup key
 * (`healdesk_<plan>_<month|year|setup>_<cents>`, the metered keys and the
 * plan-start placeholder) and `stripe:setup` creates them, so code never
 * stores a price id. Every Stripe call that sets a price resolves the id here
 * first.
 *
 * Two Stripe rules shape it:
 * - `prices.list` accepts at most 10 `lookup_keys` per call, and the catalog
 *   has more than 20, so keys are fetched in chunks of 10;
 * - a key with no active price is a setup fault (stripe:setup not re-run, or a
 *   price archived by hand). It throws PriceNotFoundError naming the key,
 *   rather than letting a worker send `price: undefined` to Stripe.
 *
 * Cached per process: prices are immutable in Stripe (a new amount is a new
 * price under a new key), so a cached id can only go stale if a price is
 * archived, and then Stripe refuses the call loudly.
 */

export class PriceNotFoundError extends Error {
  constructor(readonly lookupKey: string) {
    super(`No active Stripe price has the lookup key ${lookupKey}. Re-run stripe:setup.`);
    this.name = "PriceNotFoundError";
  }
}

export type CatalogPrice = {
  id: string;
  lookupKey: string;
  productId: string;
  unitAmountCents: number | null;
  interval: "month" | "year" | null;
  usageType: "licensed" | "metered" | null;
};

const LOOKUP_KEYS_PER_CALL = 10;

const cache = new Map<string, CatalogPrice>();

function toCatalogPrice(price: Stripe.Price, lookupKey: string): CatalogPrice {
  const product = typeof price.product === "string" ? price.product : price.product.id;
  const interval = price.recurring?.interval;
  return {
    id: price.id,
    lookupKey,
    productId: product,
    unitAmountCents: price.unit_amount ?? null,
    interval: interval === "month" ? "month" : interval === "year" ? "year" : null,
    usageType:
      price.recurring?.usage_type === "metered"
        ? "metered"
        : price.recurring?.usage_type === "licensed"
          ? "licensed"
          : null,
  };
}

/** Every key's price, in one map. Throws PriceNotFoundError for the first key with none. */
export async function pricesForLookupKeys(
  lookupKeys: readonly string[],
  options: { stripe?: Stripe; requestOptions?: Stripe.RequestOptions } = {},
): Promise<Map<string, CatalogPrice>> {
  const missing = [...new Set(lookupKeys)].filter((key) => !cache.has(key));
  if (missing.length > 0) {
    const stripe = options.stripe ?? getStripe();
    for (let i = 0; i < missing.length; i += LOOKUP_KEYS_PER_CALL) {
      const chunk = missing.slice(i, i + LOOKUP_KEYS_PER_CALL);
      // The workers' short timeout by default (R4): a lookup inside a leased
      // request must end well before the lease does.
      const page = await stripe.prices.list(
        { lookup_keys: chunk, active: true, limit: 100 },
        options.requestOptions ?? WORKER_STRIPE_OPTIONS,
      );
      for (const price of page.data) {
        if (price.lookup_key && chunk.includes(price.lookup_key)) {
          cache.set(price.lookup_key, toCatalogPrice(price, price.lookup_key));
        }
      }
    }
  }
  const found = new Map<string, CatalogPrice>();
  for (const key of lookupKeys) {
    const price = cache.get(key);
    if (!price) throw new PriceNotFoundError(key);
    found.set(key, price);
  }
  return found;
}

/** One key's price. Throws PriceNotFoundError when there is none. */
export async function priceForLookupKey(
  lookupKey: string,
  options: { stripe?: Stripe; requestOptions?: Stripe.RequestOptions } = {},
): Promise<CatalogPrice> {
  const prices = await pricesForLookupKeys([lookupKey], options);
  return prices.get(lookupKey) as CatalogPrice;
}

/**
 * The lookup key behind a price id, from the cache only. Webhook invoice lines
 * carry bare price ids; this names one the process has already resolved, and
 * returns null for anything else rather than calling Stripe.
 */
export function cachedLookupKeyForPriceId(priceId: string): string | null {
  for (const price of cache.values()) {
    if (price.id === priceId) return price.lookupKey;
  }
  return null;
}

/** Test-only: forget every cached price. */
export function __clearPriceCacheForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__clearPriceCacheForTests is not available in production.");
  }
  cache.clear();
}
