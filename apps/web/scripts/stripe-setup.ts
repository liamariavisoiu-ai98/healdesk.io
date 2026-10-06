/**
 * Create the Stripe products, prices and meters for the package catalog.
 *
 * Run once per Stripe environment (test, then live), and again after any
 * catalog change:
 *
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx apps/web/scripts/stripe-setup.ts
 *   npx tsx apps/web/scripts/stripe-setup.ts --dry-run    # no key, no calls
 *
 * ## Why a script rather than the Dashboard
 *
 * The prices exist in two places — packages/catalog/src/plans.ts and Stripe —
 * and a clinic that is shown $397 and charged $897 is the kind of mistake that
 * ends a company. Creating them from the catalog means the two cannot disagree
 * at creation time, and re-running the script reports any drift that appeared
 * afterwards. It never edits an amount: prices in Stripe are immutable, and a
 * script that "fixed" a mismatch by creating a replacement would hide exactly
 * the disagreement a human needs to look at.
 *
 * ## What one package is in Stripe
 *
 * One Product, keyed by `metadata.healdesk_plan_id`, carrying three Prices:
 *
 *   - `month`  recurring, monthly, at `monthlyUsd`
 *   - `year`   recurring, yearly, at `annualTotalUsd()` (12 × the quoted
 *              per-month annual figure, so the site and the invoice agree)
 *   - `setup`  ONE-TIME, at `setupFeeUsd`. Never recurring. Checkout adds it
 *              as a second line item on the first invoice. An upgrade OWES
 *              only `setupFeeDeltaUsd()`, but nothing invoices that yet —
 *              see the catalog's note on it — so it is collected by hand.
 *
 * There is no trial. Provisioning builds a voice agent before the clinic sees
 * anything, and the setup fee is what pays for that — see the catalog header.
 *
 * ## Overage: two meters, one metered price per rate
 *
 * Voice minutes and chat conversations over the allowance are billed through
 * Stripe Billing Meters: the app sends a meter event per unit consumed, Stripe
 * sums them per period, and a metered Price attached to the subscription turns
 * the sum into an invoice line. Each meter is keyed by its `event_name`, which
 * is what the app sends, and backs one per_unit price for every distinct
 * overage rate the catalog uses on that channel. Since 5 October 2026 that is
 * three prices on two meters: voice at $0.80, chat at $0.40 (the
 * single-channel chat package) and chat at $0.30 (the rest). A subscription
 * carries only its own package's price, so one event stream bills each clinic
 * at its own rate.
 *
 * Each metered price's lookup_key encodes its rate, from
 * `meteredPriceLookupKey()` (`healdesk_meter_chat_conversations_30`), for the
 * same reason a package key encodes its amount: a rate change creates a new
 * price instead of silently resolving to the old one, and the old price is
 * reported STALE. The prices are created here unconditionally; whether
 * Checkout ATTACHES them is decided in apps/web/src/lib/billing.ts, and it
 * does not while the rates are provisional.
 *
 * ## Idempotent by lookup_key, not by name
 *
 * Every price carries a `lookup_key` from `stripeLookupKey()`, which encodes
 * the plan id, the kind and the amount (`healdesk_web-voice_month_89700`).
 * Re-running finds the existing price by that key, checks that it still says
 * what the catalog says, and leaves it alone. A catalog price CHANGE produces a
 * new key, so it is a new price; the previous one stays active for the
 * subscriptions already on it and is reported here as STALE so a human can
 * archive it once nobody is billing on it.
 *
 * Nothing here is destructive: nothing is archived or deleted, and no amount
 * is ever updated. Beyond create, a product's name and description are
 * brought in line with the catalog (see findOrCreateProduct), and
 * `transfer_lookup_key` is used only when the key is
 * held by an INACTIVE price — Stripe keeps lookup keys unique across prices,
 * so without the transfer an archived price would block its own replacement.
 */

import {
  annualTotalUsd,
  channelList,
  COHORT_SETUP_CREDIT,
  METERS,
  type MeterId,
  OVERAGE_RATES_PROVISIONAL,
  overageRateCents,
  planMeteredPrices,
  plans,
  stripeLookupKey,
  type Plan,
  type PriceKind,
} from "@healdesk/catalog";
import Stripe from "stripe";

/**
 * What a clinic sees on their card statement.
 *
 * Set explicitly because one Stripe account serves both healdesk and scalabid.
 * Without this a med spa's bank statement reads SCALABID, which generates a
 * support ticket at best and a chargeback at worst — the customer genuinely
 * does not recognise the charge.
 *
 * Stripe allows 5–22 characters, letters/numbers/spaces only.
 */
const STATEMENT_DESCRIPTOR = "HEALDESK";

/**
 * Metadata keys. Products are keyed by metadata rather than by name so that
 * renaming a package in the catalog does not orphan its Stripe product, and so
 * scalabid's products in the same account are never mistaken for ours.
 */
const PLAN_META = "healdesk_plan_id";
const METER_META = "healdesk_meter";

/** Every key this script writes starts with this; used to spot stale prices. */
const KEY_PREFIX = "healdesk_";

// ---------------------------------------------------------------------------
// The desired state, computed from the catalog with no Stripe involved.
//
// Separating "what should exist" from "make it exist" is what makes --dry-run
// honest: it prints the same objects the live run would create, from the same
// code, rather than a hand-maintained description that drifts from the real
// thing.
// ---------------------------------------------------------------------------

type DesiredPrice = {
  lookupKey: string;
  /** Hidden from customers; what the Dashboard shows in the price list. */
  nickname: string;
  amountCents: number;
  kind: PriceKind;
};

type DesiredPackage = {
  plan: Plan;
  productName: string;
  description: string;
  prices: readonly DesiredPrice[];
};

type DesiredMeteredPrice = {
  lookupKey: string;
  /** Per unit (one minute, one conversation), in whole cents. */
  unitCents: number;
  /** The packages billed at this rate, for the nickname and the report. */
  planIds: readonly string[];
};

type DesiredMeter = {
  eventName: string;
  displayName: string;
  unitLabel: string;
  prices: readonly DesiredMeteredPrice[];
};

type Desired = {
  packages: readonly DesiredPackage[];
  meters: readonly DesiredMeter[];
};

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 4,
  })}`;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The Product description a buyer sees on Checkout and the invoice. Built from
 * the same fields the pricing page renders so the two cannot describe
 * different packages.
 */
function describePackage(plan: Plan): string {
  const channels = channelList(plan);
  const hasChat = channels.includes("web") || channels.includes("meta");

  const channelText = [
    plan.channels.web ? "Web chat" : null,
    plan.channels.meta ? "Meta chat (Instagram, Messenger, WhatsApp)" : null,
    plan.channels.voice ? "AI voice agent" : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" + ");

  const allowances = [
    plan.channels.voice
      ? `${plural(plan.includedVoiceMinutes, "voice minute")}/mo`
      : null,
    hasChat
      ? `${plural(plan.includedChatConversations, "chat conversation")}/mo`
      : null,
  ].filter((s): s is string => s !== null);

  // Meta bills the clinic directly for WhatsApp messages, including service
  // replies inside the 24-hour window from 1 October 2026, and healdesk does
  // not resell them (docs/v1-product-spec.md, "Pricing consequences"). Said on
  // the product itself so the invoice line cannot read as covering them.
  const whatsapp = plan.channels.meta
    ? " WhatsApp message charges are billed to the clinic by Meta directly."
    : "";

  return (
    `${channelText}. ` +
    `Includes ${allowances.join(" and ")}, ${plural(plan.locations, "location")}. ` +
    `One-time setup fee ${usd(plan.setupFeeUsd * 100)}; ` +
    `usage over the allowance billed at the published overage rate.` +
    whatsapp
  );
}

function desiredPrices(plan: Plan): DesiredPrice[] {
  return [
    {
      kind: "month",
      lookupKey: stripeLookupKey(plan, "month"),
      nickname: `${plan.name} — monthly`,
      amountCents: plan.monthlyUsd * 100,
    },
    {
      kind: "year",
      lookupKey: stripeLookupKey(plan, "year"),
      nickname: `${plan.name} — annual (${usd(plan.annualMonthlyUsd * 100)}/mo × 12)`,
      amountCents: annualTotalUsd(plan) * 100,
    },
    {
      kind: "setup",
      lookupKey: stripeLookupKey(plan, "setup"),
      nickname: `${plan.name} — setup fee (one-time)`,
      amountCents: plan.setupFeeUsd * 100,
    },
  ];
}

/**
 * One metered price per distinct rate on the meter, from the packages that
 * bill it. `planMeteredPrices()` is the same function checkout uses to pick a
 * Session's metered prices, so a package can never be sold a key this script
 * did not create. `overageRateCents()` throws on a zero or fractional-cent
 * rate, which fires here in a dry run too: a package that sells a channel
 * must also say what its overage costs.
 */
function desiredMeteredPrices(meter: MeterId): DesiredMeteredPrice[] {
  const byKey = new Map<string, { unitCents: number; planIds: string[] }>();
  for (const plan of plans) {
    for (const price of planMeteredPrices(plan)) {
      if (price.meter !== meter) continue;
      const entry = byKey.get(price.lookupKey) ?? {
        unitCents: overageRateCents(price.rateUsd),
        planIds: [],
      };
      entry.planIds.push(plan.id);
      byKey.set(price.lookupKey, entry);
    }
  }
  return [...byKey]
    .map(([lookupKey, entry]) => ({ lookupKey, ...entry }))
    .sort((a, b) => b.unitCents - a.unitCents);
}

function computeDesired(): Desired {
  return {
    packages: plans.map((plan) => ({
      plan,
      productName: plan.name,
      description: describePackage(plan),
      prices: desiredPrices(plan),
    })),
    meters: (Object.keys(METERS) as MeterId[]).map((id) => ({
      eventName: METERS[id].eventName,
      displayName: METERS[id].displayName,
      unitLabel: METERS[id].unitLabel,
      prices: desiredMeteredPrices(id),
    })),
  };
}

// ---------------------------------------------------------------------------
// Reporting. One line per object, one glyph per outcome, and a non-zero exit
// when anything drifted so a deploy step that runs this cannot shrug it off.
// ---------------------------------------------------------------------------

type Tally = { created: number; verified: number; updated: number; drift: number; stale: number };

const tally: Tally = { created: 0, verified: 0, updated: 0, drift: 0, stale: 0 };

function line(glyph: "✓" | "+" | "✗" | "~" | "·", text: string): void {
  console.log(`  ${glyph} ${text}`);
}

function created(text: string): void {
  tally.created += 1;
  line("+", text);
}
function verified(text: string): void {
  tally.verified += 1;
  line("✓", text);
}
function drift(text: string): void {
  tally.drift += 1;
  line("✗", `DRIFT: ${text}`);
}
function stale(text: string): void {
  tally.stale += 1;
  line("~", `STALE: ${text}`);
}

// ---------------------------------------------------------------------------
// Stripe lookups.
// ---------------------------------------------------------------------------

/**
 * Products are found by listing and filtering on metadata, not via the Search
 * API. Search is served from an index that lags writes by up to a minute, so a
 * re-run straight after a create would miss the product it just made and
 * create a second one — the exact duplicate this script exists to prevent.
 * The list endpoint is read-your-writes. One account holds a few dozen
 * products at most, so paging through them is cheap.
 */
async function listActiveProducts(stripe: Stripe): Promise<Stripe.Product[]> {
  const out: Stripe.Product[] = [];
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    out.push(product);
  }
  return out;
}

/** Every active price this script could have written, by lookup_key. */
async function listOurActivePrices(
  stripe: Stripe,
): Promise<Map<string, Stripe.Price>> {
  const out = new Map<string, Stripe.Price>();
  for await (const price of stripe.prices.list({ active: true, limit: 100 })) {
    if (price.lookup_key?.startsWith(KEY_PREFIX)) out.set(price.lookup_key, price);
  }
  return out;
}

/**
 * Find a product by its metadata key, or create it. An existing product's
 * name and description ARE brought in line with the catalog: they carry the
 * allowances a buyer reads on Checkout and on the invoice, and a product
 * created before an allowance change would otherwise keep advertising the old
 * numbers while apps/app enforces the new ones. That is the one edit this
 * script makes, because it changes no amount: prices stay immutable here.
 */
async function findOrCreateProduct(
  stripe: Stripe,
  products: Stripe.Product[],
  metaKey: string,
  metaValue: string,
  params: Omit<Stripe.ProductCreateParams, "metadata"> & { name: string; description: string },
): Promise<Stripe.Product> {
  const found = products.find((p) => p.metadata[metaKey] === metaValue);
  if (found) {
    if (found.name === params.name && (found.description ?? "") === params.description) {
      verified(`product  ${found.name.padEnd(36)} ${found.id}`);
      return found;
    }
    const updated = await stripe.products.update(found.id, {
      name: params.name,
      description: params.description,
    });
    products[products.indexOf(found)] = updated;
    tally.updated += 1;
    line("~", `UPDATED: product  ${updated.name.padEnd(36)} ${updated.id}  (name or description now matches the catalog)`);
    return updated;
  }
  const product = await stripe.products.create({
    ...params,
    metadata: { [metaKey]: metaValue },
  });
  products.push(product);
  created(`product  ${product.name.padEnd(36)} ${product.id}`);
  return product;
}

/**
 * Whether a price with this key exists at all, active or not. Lookup keys are
 * unique across prices, so an archived holder blocks a plain create; the
 * caller passes `transfer_lookup_key` in that case.
 */
async function inactiveHolder(
  stripe: Stripe,
  lookupKey: string,
): Promise<Stripe.Price | undefined> {
  const found = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: false,
    limit: 1,
  });
  return found.data[0];
}

/**
 * Compare what Stripe has against what the catalog says, field by field, and
 * return the human-readable list of disagreements. An empty list is a match.
 *
 * Amount drift is nearly impossible for package prices because the key encodes
 * the amount — but "nearly" is somebody creating a price by hand in the
 * Dashboard with our key and the wrong number, which has happened elsewhere
 * and is precisely what a check costs nothing to catch. Shape drift (a setup
 * fee that recurs, a monthly price that is yearly) is not encoded in the key
 * at all, so this is the only place it gets caught.
 */
function packagePriceProblems(
  price: Stripe.Price,
  want: DesiredPrice,
): string[] {
  const problems: string[] = [];
  if (price.unit_amount !== want.amountCents) {
    problems.push(
      `amount is ${price.unit_amount === null ? "unset" : usd(price.unit_amount)}, catalog says ${usd(want.amountCents)}`,
    );
  }
  if (price.currency !== "usd") problems.push(`currency is ${price.currency}`);
  if (want.kind === "setup") {
    if (price.type !== "one_time") {
      problems.push(`setup fee is ${price.type}, must be one_time`);
    }
  } else {
    if (price.type !== "recurring" || !price.recurring) {
      problems.push(`is ${price.type}, must be recurring`);
    } else {
      if (price.recurring.interval !== want.kind) {
        problems.push(`interval is ${price.recurring.interval}, want ${want.kind}`);
      }
      if (price.recurring.interval_count !== 1) {
        problems.push(`interval_count is ${price.recurring.interval_count}`);
      }
      if (price.recurring.usage_type !== "licensed") {
        problems.push(`usage_type is ${price.recurring.usage_type}`);
      }
    }
  }
  return problems;
}

function meteredPriceProblems(
  price: Stripe.Price,
  want: DesiredMeteredPrice,
  meterId: string,
): string[] {
  const problems: string[] = [];
  // Metered prices are created with unit_amount_decimal; Stripe echoes it back
  // as a Decimal in cents. Compared as decimals, not floats — 30 and
  // "30.0000" are the same amount.
  const have = price.unit_amount_decimal;
  if (have === null || !have.eq(Stripe.Decimal.from(want.unitCents))) {
    problems.push(
      `amount is ${have === null ? "unset" : usd(Number(have.toString()))}, catalog says ${usd(want.unitCents)}`,
    );
  }
  if (price.currency !== "usd") problems.push(`currency is ${price.currency}`);
  if (price.billing_scheme !== "per_unit") {
    problems.push(`billing_scheme is ${price.billing_scheme}`);
  }
  if (price.type !== "recurring" || !price.recurring) {
    problems.push(`is ${price.type}, must be recurring`);
  } else {
    if (price.recurring.usage_type !== "metered") {
      problems.push(`usage_type is ${price.recurring.usage_type}, must be metered`);
    }
    if (price.recurring.interval !== "month") {
      problems.push(`interval is ${price.recurring.interval}, want month`);
    }
    if (price.recurring.meter !== meterId) {
      problems.push(`meter is ${price.recurring.meter ?? "unset"}, want ${meterId}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------

async function syncPackage(
  stripe: Stripe,
  products: Stripe.Product[],
  activePrices: Map<string, Stripe.Price>,
  pkg: DesiredPackage,
): Promise<void> {
  console.log(`\n${pkg.plan.name}  (${pkg.plan.id})`);

  const product = await findOrCreateProduct(
    stripe,
    products,
    PLAN_META,
    pkg.plan.id,
    { name: pkg.productName, description: pkg.description },
  );

  for (const want of pkg.prices) {
    const label = `${want.kind.padEnd(6)} ${want.lookupKey.padEnd(40)} ${usd(want.amountCents)}`;

    const existing = activePrices.get(want.lookupKey);
    if (existing) {
      const problems = packagePriceProblems(existing, want);
      if (problems.length === 0) verified(`${label}  ${existing.id}`);
      else drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
      continue;
    }

    const holder = await inactiveHolder(stripe, want.lookupKey);
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: want.amountCents,
      lookup_key: want.lookupKey,
      transfer_lookup_key: holder !== undefined,
      nickname: want.nickname,
      // The setup fee is deliberately NOT recurring: `recurring` absent makes
      // Stripe create a one_time price, which Checkout can only add as a
      // one-off line item — so a setup fee cannot be re-billed by accident.
      ...(want.kind === "setup"
        ? {}
        : { recurring: { interval: want.kind, usage_type: "licensed" } }),
      metadata: { [PLAN_META]: pkg.plan.id, healdesk_price_kind: want.kind },
    });
    activePrices.set(want.lookupKey, price);
    created(
      `${label}  ${price.id}` +
        (holder ? `  (lookup_key moved off archived ${holder.id})` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// The setup credit: one coupon per package.
//
// Day 7 of the nurture sequence offers the setup fee back
// (catalog COHORT_SETUP_CREDIT). Checkout honours it by naming the coupon on
// the Session (`discounts`, lib/billing.ts), and Stripe refuses a Session
// that names a coupon it does not have — so this runs before any of those
// emails are sent. `amount_off` is the package's own setup fee, so the credit
// and the fee it cancels can never disagree; `duration: "once"` keeps it off
// every renewal.
// ---------------------------------------------------------------------------
async function syncCohortCoupons(stripe: Stripe): Promise<void> {
  console.log(`\n${COHORT_SETUP_CREDIT.name}`);
  for (const plan of plans) {
    const id = `${COHORT_SETUP_CREDIT.couponId}-${plan.id}`;
    const amountOff = plan.setupFeeUsd * 100;
    const label = `coupon   ${id.padEnd(40)} ${usd(amountOff)}`;
    let existing: Stripe.Coupon | null = null;
    try {
      existing = await stripe.coupons.retrieve(id);
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeError && error.code === "resource_missing")) throw error;
    }
    if (existing) {
      const problems: string[] = [];
      if (existing.amount_off !== amountOff) problems.push(`amount_off is ${existing.amount_off}, want ${amountOff}`);
      if (existing.currency !== "usd") problems.push(`currency is ${existing.currency}`);
      if (existing.duration !== "once") problems.push(`duration is ${existing.duration}, want once`);
      if (!existing.valid) problems.push("coupon is no longer valid");
      if (problems.length > 0) {
        // A coupon's amount cannot be changed in place: delete it and re-run.
        drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
        continue;
      }
      // The name can, and Stripe prints it on Checkout and the invoice, so it
      // follows the catalog (it lost "Founding-cohort" on 6 October 2026).
      if (existing.name !== COHORT_SETUP_CREDIT.name) {
        await stripe.coupons.update(existing.id, { name: COHORT_SETUP_CREDIT.name });
        tally.updated += 1;
        line("~", `UPDATED: ${label}  ${existing.id}  (name now matches the catalog)`);
        continue;
      }
      verified(`${label}  ${existing.id}`);
      continue;
    }
    const coupon = await stripe.coupons.create({
      id,
      // Stripe caps a coupon name at 40 characters, and appending the package
      // name overran it for most packages. The id already names the package.
      name: COHORT_SETUP_CREDIT.name,
      amount_off: amountOff,
      currency: "usd",
      duration: "once",
      metadata: { [PLAN_META]: plan.id, healdesk_offer: "cohort-setup" },
    });
    created(`${label}  ${coupon.id}`);
  }
}

async function listActiveMeters(stripe: Stripe): Promise<Stripe.Billing.Meter[]> {
  const out: Stripe.Billing.Meter[] = [];
  for await (const meter of stripe.billing.meters.list({ status: "active", limit: 100 })) {
    out.push(meter);
  }
  return out;
}

async function syncMeter(
  stripe: Stripe,
  products: Stripe.Product[],
  meters: Stripe.Billing.Meter[],
  activePrices: Map<string, Stripe.Price>,
  want: DesiredMeter,
): Promise<void> {
  console.log(`\n${want.displayName}  (${want.eventName})`);

  // Meters are keyed by event_name because that is the contract with the app:
  // the usage reporter sends events named `healdesk_voice_minutes`, and a
  // meter under any other name would count nothing while looking configured.
  let meter = meters.find((m) => m.event_name === want.eventName);
  if (meter) {
    const problems: string[] = [];
    if (meter.default_aggregation.formula !== "sum") {
      problems.push(`aggregation is ${meter.default_aggregation.formula}, want sum`);
    }
    if (meter.customer_mapping.event_payload_key !== "stripe_customer_id") {
      problems.push(
        `customer key is ${meter.customer_mapping.event_payload_key}, want stripe_customer_id`,
      );
    }
    if (meter.value_settings.event_payload_key !== "value") {
      problems.push(`value key is ${meter.value_settings.event_payload_key}, want value`);
    }
    if (problems.length === 0) verified(`meter    ${want.eventName.padEnd(36)} ${meter.id}`);
    else drift(`meter    ${want.eventName.padEnd(36)} ${meter.id}: ${problems.join("; ")}`);
  } else {
    meter = await stripe.billing.meters.create({
      display_name: want.displayName,
      event_name: want.eventName,
      // `sum`: each event carries the units consumed in `value`, and the
      // period's bill is their total. `count` would ignore the value and
      // `last` would bill only the final report.
      default_aggregation: { formula: "sum" },
      // Events name the customer by Stripe id. The app stores the customer id
      // at checkout, so this is the one key it can always supply.
      customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
      value_settings: { event_payload_key: "value" },
    });
    meters.push(meter);
    created(`meter    ${want.eventName.padEnd(36)} ${meter.id}`);
  }

  // One product per meter so the invoice line reads "Voice minutes over
  // allowance" rather than a package name the overage does not belong to.
  const product = await findOrCreateProduct(
    stripe,
    products,
    METER_META,
    want.eventName,
    {
      name: want.displayName,
      description: `Billed per ${want.unitLabel} beyond the package allowance, monthly in arrears.`,
    },
  );

  for (const rate of want.prices) {
    const label = `price  ${rate.lookupKey.padEnd(40)} ${usd(rate.unitCents)}/${want.unitLabel}`;
    const existing = activePrices.get(rate.lookupKey);
    if (existing) {
      const problems = meteredPriceProblems(existing, rate, meter.id);
      if (problems.length === 0) verified(`${label}  ${existing.id}`);
      else drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
      continue;
    }

    const holder = await inactiveHolder(stripe, rate.lookupKey);
    const price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      billing_scheme: "per_unit",
      // A decimal amount, which is the form Stripe documents for metered
      // prices and the one the drift check above compares against.
      unit_amount_decimal: Stripe.Decimal.from(rate.unitCents),
      recurring: { interval: "month", usage_type: "metered", meter: meter.id },
      lookup_key: rate.lookupKey,
      transfer_lookup_key: holder !== undefined,
      nickname: `${want.displayName} — ${usd(rate.unitCents)}/${want.unitLabel} (${rate.planIds.join(", ")})`,
      metadata: { [METER_META]: want.eventName },
    });
    activePrices.set(rate.lookupKey, price);
    created(
      `${label}  ${price.id}` +
        (holder ? `  (lookup_key moved off archived ${holder.id})` : ""),
    );
  }
}

/**
 * Active prices with our prefix that the catalog no longer names. These are
 * usually a previous catalog's prices still billing existing subscriptions —
 * never touched here, only surfaced, because archiving one under a live
 * subscription is a manual decision with a migration attached.
 */
function reportStale(
  activePrices: Map<string, Stripe.Price>,
  desired: Desired,
): void {
  const wanted = new Set<string>([
    ...desired.packages.flatMap((p) => p.prices.map((x) => x.lookupKey)),
    ...desired.meters.flatMap((m) => m.prices.map((x) => x.lookupKey)),
  ]);
  const extra = [...activePrices.keys()].filter((k) => !wanted.has(k)).sort();
  if (extra.length === 0) return;
  console.log("\nActive prices not in the current catalog");
  for (const key of extra) {
    const price = activePrices.get(key)!;
    stale(`${key.padEnd(46)} ${price.id}  — archive once no subscription bills on it`);
  }
}

// ---------------------------------------------------------------------------
// Dry run: the same desired state, printed instead of applied.
// ---------------------------------------------------------------------------

function printDryRun(desired: Desired): void {
  console.log("DRY RUN — nothing below is sent to Stripe.\n");
  console.log("Would find-or-create, then verify against the catalog:");
  for (const pkg of desired.packages) {
    console.log(`\n${pkg.plan.name}  (${pkg.plan.id})`);
    line("·", `product  ${pkg.productName}  [${PLAN_META}=${pkg.plan.id}]`);
    line("·", `         "${pkg.description}"`);
    for (const want of pkg.prices) {
      const shape =
        want.kind === "setup" ? "one_time" : `recurring/${want.kind}/licensed`;
      line(
        "·",
        `${want.kind.padEnd(6)} ${want.lookupKey.padEnd(40)} ${usd(want.amountCents).padEnd(8)} ${shape}`,
      );
    }
  }
  for (const m of desired.meters) {
    console.log(`\n${m.displayName}  (${m.eventName})`);
    line("·", `meter    event_name=${m.eventName}  sum(value) by stripe_customer_id`);
    line("·", `product  ${m.displayName}  [${METER_META}=${m.eventName}]`);
    for (const rate of m.prices) {
      line(
        "·",
        `price    ${rate.lookupKey.padEnd(40)} ${usd(rate.unitCents)}/${m.unitLabel}  recurring/month/metered per_unit  (${rate.planIds.join(", ")})`,
      );
    }
  }
  console.log(`\n${COHORT_SETUP_CREDIT.name}`);
  for (const plan of plans) {
    line(
      "·",
      `coupon   ${`${COHORT_SETUP_CREDIT.couponId}-${plan.id}`.padEnd(40)} ${usd(plan.setupFeeUsd * 100).padEnd(8)} amount_off/once`,
    );
  }
  console.log(
    `\nWould also list active ${KEY_PREFIX}* prices and flag any the catalog no longer names as STALE.`,
  );
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

function printNext(live: boolean): void {
  const host = live ? "https://healdesk.io" : "https://<staging-domain>";
  console.log(
    `\nStatement descriptor should read "${STATEMENT_DESCRIPTOR}".\n` +
      `Set it at dashboard.stripe.com → Settings → Business → ` +
      `Public details → Statement descriptor.\n` +
      `Verify it is NOT the scalabid descriptor — one account serves both.\n`,
  );

  console.log(
    `Next:\n` +
      `  1. Webhook endpoint  dashboard.stripe.com → Developers → Webhooks\n` +
      `     URL:    ${host}/api/webhooks/stripe\n` +
      `     Events: checkout.session.completed          (records the account, in provisioning)\n` +
      `             checkout.session.async_payment_succeeded\n` +
      `             invoice.paid                        (the first one switches service on)\n` +
      `             invoice.payment_failed\n` +
      `             invoice.payment_action_required\n` +
      `             customer.subscription.updated\n` +
      `             customer.subscription.deleted\n` +
      `             charge.dispute.created\n` +
      `     (not customer.subscription.paused/resumed: they only fire when a\n` +
      `     trial ends without a card, and there is no trial. A Dashboard or\n` +
      `     portal pause arrives on customer.subscription.updated.)\n` +
      `     Copy its signing secret into STRIPE_WEBHOOK_SECRET.\n` +
      `     Locally: stripe listen --forward-to localhost:3000/api/webhooks/stripe\n` +
      `  2. Customer Portal  Settings → Billing → Customer portal\n` +
      `     ON:  update payment method; invoice history\n` +
      `     ON:  cancel subscription — "at end of billing period" ONLY\n` +
      `     OFF: switch plan. Stripe's portal cannot update a subscription that\n` +
      `          carries metered prices, and a plan change must also swap the\n` +
      `          metered items to the new package's rates (planMeteredPrices in\n` +
      `          the catalog). Change a package by hand in the Dashboard: swap the\n` +
      `          package price AND the metered prices, until healdesk's own Billing\n` +
      `          screen does it.\n` +
      `     OFF: pause subscription\n` +
      `     OFF: cancel immediately\n` +
      `  3. Stripe Tax  Settings → Tax → enable, and set a default tax behavior\n` +
      `     (prices here are created without tax_behavior and inherit it).\n` +
      `  4. Subscriptions → Manage failed payments → "on payment failure":\n` +
      `     must NOT cancel the subscription. Leave it active/past_due; healdesk\n` +
      `     owns the terminal transition — the billing-sweep job suspends the\n` +
      `     clinic once its grace window closes, and customer.subscription.updated\n` +
      `     with status=unpaid suspends it too — so a Stripe-side cancel would\n` +
      `     race it. That job ships OFF: enable it from the ops console.\n`,
  );
}

function summaryLine(desired: Desired): string {
  const meteredPrices = desired.meters.reduce((n, m) => n + m.prices.length, 0);
  return (
    `${desired.packages.length} packages, ${desired.meters.length} meters ` +
    `carrying ${meteredPrices} metered prices, no trial`
  );
}

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  const known = new Set(["--dry-run"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: stripe-setup.ts [--dry-run]`);
    process.exit(2);
  }
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));

  // Computed before touching the key so a catalog problem (a package selling
  // a channel with no overage rate, or a rate that is not whole cents) fails
  // in a dry run too — it is a catalog problem, not a Stripe one.
  const desired = computeDesired();

  if (OVERAGE_RATES_PROVISIONAL) {
    console.warn(
      `\nWARNING: OVERAGE_RATES_PROVISIONAL is true. The metered prices below\n` +
        `use placeholder rates (see packages/catalog/src/plans.ts). They will\n` +
        `bill real overage at those rates until replaced — creating them is\n` +
        `fine, quoting them on the pricing page is not.\n`,
    );
  }

  if (dryRun) {
    console.log(`healdesk → Stripe (dry run)\n${summaryLine(desired)}\n`);
    printDryRun(desired);
    printNext(false);
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set. (Use --dry-run to preview without a key.)");
    process.exit(1);
  }

  // A restricted key (rk_) is the recommended way to run this, and it is just
  // as live as a secret key (sk_); checking only sk_live_ labelled a live run
  // "test mode" and skipped the warning below.
  const live = /^(sk|rk)_live_/.test(key);
  if (live) {
    console.log(
      `\n${"!".repeat(72)}\n` +
        `!!  LIVE MODE — this creates real products and prices that real\n` +
        `!!  clinics will be charged against. Read every line of the output.\n` +
        `${"!".repeat(72)}\n`,
    );
  }
  const stripe = new Stripe(key);

  console.log(
    `healdesk → Stripe (${live ? "LIVE" : "test"} mode)\n` +
      `${summaryLine(desired)}\n`,
  );

  const products = await listActiveProducts(stripe);
  const activePrices = await listOurActivePrices(stripe);
  const meters = await listActiveMeters(stripe);

  for (const pkg of desired.packages) {
    await syncPackage(stripe, products, activePrices, pkg);
  }
  for (const meter of desired.meters) {
    await syncMeter(stripe, products, meters, activePrices, meter);
  }
  await syncCohortCoupons(stripe);
  reportStale(activePrices, desired);

  console.log(
    `\n${tally.created} created, ${tally.verified} verified, ${tally.updated} updated, ` +
      `${tally.drift} drifted, ${tally.stale} stale.`,
  );
  printNext(live);

  if (tally.drift > 0) {
    console.error(
      `${tally.drift} object(s) disagree with the catalog. Nothing was changed ` +
        `for them; resolve by hand (archive the wrong price, re-run) and never ` +
        `by editing the catalog to match Stripe.`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
