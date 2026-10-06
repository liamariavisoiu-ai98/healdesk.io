import { createHash, randomUUID } from "node:crypto";

import {
  getPlan,
  OVERAGE_RATES_PROVISIONAL,
  parseLookupKey,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planMeteredPrices,
  type BillingInterval,
  type Plan,
} from "@healdesk/catalog";
import type Stripe from "stripe";

import type { ActorContext } from "@/lib/audit";
import { log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { resolveBillingClinicId } from "./billing-clinic";
import {
  claimStripeMutationLease,
  getEntitlementsForUpdate,
  hasPlanStarted,
  releaseStripeMutationLease,
  setMeteredPriceKeys,
} from "./entitlements";
import { pricesForLookupKeys } from "./prices";
import { getStripe } from "./stripe-client";
import { stripeRefId, WORKER_STRIPE_OPTIONS, workerRequestOptions } from "./stripe-helpers";

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

// -----------------------------------------------------------------------------
// Reading a subscription's items
// -----------------------------------------------------------------------------

/**
 * A subscription item, read structurally: a webhook payload, an API response
 * and a test fixture all have these fields, and the SDK's own type is wider
 * than anything here needs. Subscription items always carry their price
 * expanded (unlike invoice lines, whose prices arrive as bare ids).
 */
export type SubscriptionItemLike = {
  id: string;
  quantity?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  price?: unknown;
};

/** The parts of a subscription the billing actions read. */
export type SubscriptionLike = {
  id: string;
  status?: string | null;
  customer?: unknown;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  default_payment_method?: unknown;
  metadata?: Record<string, string> | null;
  items?: { data?: SubscriptionItemLike[] | null } | null;
  latest_invoice?: unknown;
};

type ItemPrice = {
  id: string | null;
  lookupKey: string | null;
  usageType: "licensed" | "metered" | null;
  unitAmountCents: number | null;
  productId: string | null;
};

function priceOf(item: SubscriptionItemLike): ItemPrice {
  const price = (item.price ?? null) as {
    id?: unknown;
    lookup_key?: unknown;
    unit_amount?: unknown;
    product?: unknown;
    recurring?: { usage_type?: unknown } | null;
  } | null;
  const usage = price?.recurring?.usage_type;
  return {
    id: typeof price?.id === "string" ? price.id : null,
    lookupKey: typeof price?.lookup_key === "string" ? price.lookup_key : null,
    usageType: usage === "metered" ? "metered" : usage === "licensed" ? "licensed" : null,
    unitAmountCents: typeof price?.unit_amount === "number" ? price.unit_amount : null,
    productId: stripeRefId(price?.product ?? null),
  };
}

function itemsOf(subscription: SubscriptionLike): SubscriptionItemLike[] {
  return subscription.items?.data ?? [];
}

/** A metered overage item: its price is billed by usage, never by quantity. */
export function isMeteredItem(item: SubscriptionItemLike): boolean {
  return priceOf(item).usageType === "metered";
}

/**
 * The $0 line a subscription carries until its plan starts: the catalog's
 * placeholder price by its lookup key, or any licensed item that costs
 * nothing (a placeholder created by hand, or before the key existed).
 */
export function isPlaceholderItem(item: SubscriptionItemLike): boolean {
  const price = priceOf(item);
  if (price.lookupKey === PLAN_START_PLACEHOLDER_LOOKUP_KEY) return true;
  return price.usageType !== "metered" && price.unitAmountCents === 0;
}

export type PackageItem = {
  item: SubscriptionItemLike;
  plan: Plan;
  interval: BillingInterval;
  priceId: string;
  quantity: number;
};

/**
 * The item carrying the package price: the first licensed item whose lookup
 * key is a catalog package price (`healdesk_<plan>_<month|year>_<cents>`).
 * Null before the plan starts, while only the placeholder is there, and for
 * a subscription carrying a price this catalog does not know.
 */
export function packageItemOf(subscription: SubscriptionLike): PackageItem | null {
  for (const item of itemsOf(subscription)) {
    const price = priceOf(item);
    if (price.usageType === "metered" || !price.lookupKey || !price.id) continue;
    const parsed = parseLookupKey(price.lookupKey);
    if (!parsed || parsed.kind === "setup") continue;
    const plan = getPlan(parsed.planId);
    if (!plan) continue;
    return {
      item,
      plan,
      interval: parsed.kind,
      priceId: price.id,
      quantity: typeof item.quantity === "number" ? item.quantity : 1,
    };
  }
  return null;
}

/** The lookup keys of the metered items, sorted, as `metered_price_keys` stores them. */
export function meteredKeysOf(subscription: SubscriptionLike): string[] {
  const keys = new Set<string>();
  for (const item of itemsOf(subscription)) {
    const price = priceOf(item);
    if (price.usageType === "metered" && price.lookupKey) keys.add(price.lookupKey);
  }
  return [...keys].sort();
}

/**
 * When the current period ends: the package item's (or, before the start,
 * the placeholder's) `current_period_end`, where dahlia keeps it, falling
 * back to the latest end of any item. Null when Stripe sent none.
 */
export function currentPeriodEndOf(subscription: SubscriptionLike): Date | null {
  const items = itemsOf(subscription);
  const primary =
    packageItemOf(subscription)?.item ?? items.find((item) => isPlaceholderItem(item)) ?? null;
  const seconds =
    primary?.current_period_end ??
    items.reduce<number | null>((latest, item) => {
      const end = item.current_period_end ?? null;
      return end !== null && (latest === null || end > latest) ? end : latest;
    }, null);
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

/**
 * Where an unwanted metered item is one of OURS. A metered item this catalog
 * did not mint (another product on the shared Stripe account, or one added
 * by hand) is never deleted by a reconcile: it is reported, not repaired.
 */
function isOurMeteredKey(key: string | null): key is string {
  return key !== null && key.startsWith("healdesk_meter_");
}

export type MeteredItemChanges = {
  /** Items to remove: `{ id, deleted: true }`. */
  deletes: string[];
  /** Lookup keys to add, one item each, no quantity (metered prices refuse one). */
  adds: string[];
};

/**
 * What turns the subscription's metered items into `expected`: delete our
 * metered items whose key is not expected, add the expected keys it lacks.
 * Pure, so changePlan and the reconcile build the same item list.
 */
export function meteredItemChanges(
  subscription: SubscriptionLike,
  expected: readonly string[],
): MeteredItemChanges {
  const want = new Set(expected);
  const deletes: string[] = [];
  const have = new Set<string>();
  for (const item of itemsOf(subscription)) {
    const price = priceOf(item);
    if (price.usageType !== "metered") continue;
    if (price.lookupKey && want.has(price.lookupKey) && !have.has(price.lookupKey)) {
      have.add(price.lookupKey);
      continue;
    }
    // A duplicate of an expected key, or one of ours that is no longer
    // expected: either would bill the same usage twice or at the wrong rate.
    if (isOurMeteredKey(price.lookupKey)) deletes.push(item.id);
  }
  const adds = [...want].filter((key) => !have.has(key)).sort();
  return { deletes, adds };
}

/**
 * The `items` array for a metered swap: deletions first, then additions by
 * price id. Metered additions carry no quantity, because Stripe refuses one
 * on a usage-billed price.
 */
export async function meteredItemParams(
  changes: MeteredItemChanges,
  options: { stripe?: Stripe } = {},
): Promise<Stripe.SubscriptionUpdateParams.Item[]> {
  const prices = changes.adds.length
    ? await pricesForLookupKeys(changes.adds, options)
    : new Map<string, { id: string }>();
  return [
    ...changes.deletes.map((id) => ({ id, deleted: true })),
    ...changes.adds.map((key) => ({ price: (prices.get(key) as { id: string }).id })),
  ];
}

/** A short, stable digest of request parameters, for an idempotency key that changes when they do. */
export function paramsDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

// -----------------------------------------------------------------------------
// The reconcile
// -----------------------------------------------------------------------------

const RECONCILE_ACTOR: ActorContext = { type: "service", serviceName: "metered-items" };

export type ReconcileMeteredItemsResult = {
  status: "ok" | "fixed" | "skipped" | "failed";
  reason?: string;
};

/**
 * Make the clinic's subscription carry exactly the expected metered items
 * (BD19): the BOUGHT package's metered prices on a monthly plan, none on an
 * annual one, and none before the plan starts — the $0 placeholder carries
 * no metered price, and adding one would bill usage nobody has started
 * paying for. Works on the clinic's billing clinic. Never inside a
 * transaction.
 *
 * The usage reporter calls it before sending a meter event whenever the
 * stored snapshot (`metered_price_keys`) differs from what is expected,
 * because an event sent to a meter the subscription has no price for is
 * accepted by Stripe and then bills nothing, and a row marked reported on
 * that basis is lost for good.
 *
 * It holds the billing clinic's Stripe mutation lease (R5) while it reads
 * and changes the subscription, so it can never interleave with a plan
 * start, a step-up or a plan change that is swapping the same items; while
 * another holder has the lease it answers `skipped`, reason `busy`. The
 * snapshot is written only from the subscription Stripe returned.
 *
 * Statuses: `ok` (already right), `fixed` (changed now), `skipped` (nothing
 * to do here, with a reason code), `failed` (Stripe refused; a reason code,
 * never an exception's text).
 */
export async function reconcileMeteredItems(
  clinicId: string,
  options: { stripe?: Stripe } = {},
): Promise<ReconcileMeteredItemsResult> {
  const billingClinicId = await withTenant({ clinicId, actor: RECONCILE_ACTOR }, (tx) =>
    resolveBillingClinicId(tx),
  );
  const owner = `metered_items:${randomUUID()}`;

  const claim = await withTenant(
    { clinicId: billingClinicId, actor: RECONCILE_ACTOR },
    async (tx) => {
      const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
      if (!row) return { skip: "no_entitlements" } as const;
      if (!row.stripeSubscriptionId) return { skip: "no_subscription" } as const;
      if (row.status === "canceled" || row.status === "purged") return { skip: "ended" } as const;
      if (!hasPlanStarted(row)) return { skip: "not_started" } as const;
      const expected = expectedMeteredKeys(row.boughtPlanId ?? row.planCode, row.billingInterval);
      if (expected === null) return { skip: "unknown_plan" } as const;
      // Wall-clock, not the business `now`: a lease measures real elapsed
      // time, and a pinned or replayed clock must never expire another
      // holder's live lease.
      if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
        return { skip: "busy" } as const;
      }
      return { subscriptionId: row.stripeSubscriptionId, expected, stored: row.meteredPriceKeys };
    },
  );
  if ("skip" in claim) return { status: "skipped", reason: claim.skip };

  const release = (keys?: string[]) =>
    withTenant({ clinicId: billingClinicId, actor: RECONCILE_ACTOR }, async (tx) => {
      if (keys && !sameKeys(keys, claim.stored)) {
        await setMeteredPriceKeys(tx.db, billingClinicId, keys);
      }
      await releaseStripeMutationLease(tx.db, billingClinicId, owner);
    });

  try {
    const stripe = options.stripe ?? getStripe();
    const subscription = (await stripe.subscriptions.retrieve(
      claim.subscriptionId,
      { expand: ["items.data.price"] },
      WORKER_STRIPE_OPTIONS,
    )) as unknown as SubscriptionLike;
    if (subscription.status === "canceled" || subscription.status === "incomplete_expired") {
      await release();
      return { status: "skipped", reason: "ended" };
    }
    // healdesk never uses a Stripe trial: a trialing subscription is a fault
    // to report, never one to build on (R37).
    if (subscription.status === "trialing") {
      await release();
      return { status: "failed", reason: "trialing" };
    }

    const changes = meteredItemChanges(subscription, claim.expected);
    if (changes.deletes.length === 0 && changes.adds.length === 0) {
      await release(meteredKeysOf(subscription));
      return { status: "ok" };
    }

    const items = await meteredItemParams(changes, { stripe });
    const updated = (await stripe.subscriptions.update(
      claim.subscriptionId,
      // No proration: a metered item bills usage in arrears, so adding or
      // removing one moves no money now. off_session because nobody from the
      // clinic is present, as on every worker update.
      { items, proration_behavior: "none", off_session: true, expand: ["items.data.price"] },
      workerRequestOptions(
        `hd-metered:${billingClinicId}:${paramsDigest({ items, from: meteredKeysOf(subscription) })}`,
      ),
    )) as unknown as SubscriptionLike;
    await release(meteredKeysOf(updated));
    return { status: "fixed" };
  } catch (error) {
    const reason = stripeErrorCode(error);
    log.warn("metered items not reconciled", { clinicId: billingClinicId, code: reason });
    try {
      await release();
    } catch {
      // The lease runs out by itself; the failure above is the one to report.
    }
    return { status: "failed", reason };
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

type StripeErrorFields = {
  type?: unknown;
  rawType?: unknown;
  code?: unknown;
  statusCode?: unknown;
};

/**
 * A closed code for a Stripe failure, for a ledger column or a log line:
 * Stripe's error type and its own code (or the HTTP status when it sent no
 * code), never the message. Safe to store, because both come from Stripe's
 * fixed vocabulary; anything else is reduced to the error's class name.
 */
export function stripeErrorCode(error: unknown): string {
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9_:.-]/g, "_")
      .slice(0, 80);
  if (error && typeof error === "object") {
    const { type, rawType, code, statusCode } = error as StripeErrorFields;
    const kind = typeof rawType === "string" ? rawType : typeof type === "string" ? type : null;
    const detail =
      typeof code === "string" ? code : typeof statusCode === "number" ? String(statusCode) : null;
    if (kind || detail) return clean([kind, detail].filter(Boolean).join(":"));
    if (error instanceof Error && error.name) return clean(error.name);
  }
  return "unknown";
}

/**
 * A card decline, an authentication the clinic must complete, or any other
 * failed charge: Stripe charged nothing. A 402 counts whatever its type,
 * because that is how Stripe answers a charge it attempted and could not
 * complete, including `error_if_incomplete` refusing a payment that needs
 * the clinic to confirm it.
 */
export function isCardError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { type, rawType, statusCode } = error as StripeErrorFields;
  return rawType === "card_error" || type === "StripeCardError" || statusCode === 402;
}

/** Stripe asked us to slow down: retry later, never count it as a failure (R17). */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { type, code, statusCode } = error as StripeErrorFields;
  return type === "StripeRateLimitError" || statusCode === 429 || code === "rate_limit";
}
