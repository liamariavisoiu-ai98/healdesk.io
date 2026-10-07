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
 * ## Overage: two meters, one metered price per rate, billed in blocks of 100
 *
 * Voice minutes and chat conversations over the allowance are billed through
 * Stripe Billing Meters: the app sends a meter event per unit consumed, Stripe
 * sums them per period, and a metered Price attached to the subscription turns
 * the sum into an invoice line. Each meter is keyed by its `event_name`, which
 * is what the app sends, and backs one price for every distinct overage rate
 * the catalog uses on that channel: three prices on two meters, voice at $80,
 * chat at $40 (the single-channel chat package) and chat at $30 (the rest). A
 * subscription carries only its own package's price, so one event stream
 * bills each clinic at its own rate.
 *
 * Since 6 October 2026 overage is billed per STARTED block of 100 units (the
 * owner's decision; docs/v1-product-spec.md, "Overage prices"), so each price
 * is package-priced: `billing_scheme: per_unit` at the price of one block,
 * with `transform_quantity` dividing the period's total by 100 and rounding
 * up. 1 to 100 minutes over is one block, 101 is two. Stripe applies the
 * transform to a metered total at the end of the period, and only to a
 * per_unit price, never a tiered one. The app still sends single units and
 * never has to know the block.
 *
 * Each metered price's lookup_key encodes the block size and the block price,
 * from `meteredPriceLookupKey()` (`healdesk_meter_chat_conversations_block100_3000`),
 * for the same reason a package key encodes its amount: a rate or block change
 * creates a new price instead of silently resolving to the old one. The
 * prices are created here unconditionally; whether Checkout ATTACHES them is
 * decided in apps/web/src/lib/billing.ts, and it does not while the rates are
 * provisional.
 *
 * The per-unit metered prices of 5 October (`healdesk_meter_voice_minutes_80`)
 * are ARCHIVED here, once their meter's block prices are in place: the one
 * exception to "nothing is archived" below, because their migration is
 * automatic. Archiving only stops a price being sold. Stripe goes on billing a
 * subscription item already on one until apps/app's metered-item reconcile
 * (lib/billing/metered-items.ts, which the usage reporter runs before it
 * sends any usage) swaps the item onto the block price, and leaving them
 * active would let a stale checkout keep selling per-unit overage.
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
 * Nothing else here is destructive: nothing is deleted, nothing but those
 * per-unit metered prices is archived, and no amount is ever updated. Beyond
 * create, a product's name and description are brought in line with the
 * catalog (see findOrCreateProduct), and `transfer_lookup_key` is used only
 * when the key is held by an INACTIVE price — Stripe keeps lookup keys unique
 * across prices, so without the transfer an archived price would block its
 * own replacement.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  annualTotalUsd,
  channelList,
  COHORT_SETUP_CREDIT,
  METERS,
  type MeterId,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  overageRateCents,
  planMeteredPrices,
  plans,
  stripeLookupKey,
  type Plan,
  type PriceKind,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  PLAN_START_PLACEHOLDER_NAME,
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

export type DesiredMeteredPrice = {
  lookupKey: string;
  /**
   * One started block of OVERAGE_BLOCK_UNITS units (minutes or
   * conversations), in whole cents: the price's `unit_amount`, which Stripe
   * multiplies by the period's total after BLOCK_TRANSFORM has turned it into
   * blocks.
   */
  blockCents: number;
  /** The packages billed at this rate, for the nickname and the report. */
  planIds: readonly string[];
};

export type DesiredMeter = {
  meterId: MeterId;
  eventName: string;
  displayName: string;
  /** The overage product, which names the invoice line, and what it says on Checkout. */
  productName: string;
  productDescription: string;
  unitLabel: string;
  prices: readonly DesiredMeteredPrice[];
};

/** The $0 monthly line every subscription carries until AYA first answers (contracts §2). */
export type DesiredPlaceholder = {
  lookupKey: string;
  productName: string;
  description: string;
};

export type Desired = {
  packages: readonly DesiredPackage[];
  meters: readonly DesiredMeter[];
  placeholder: DesiredPlaceholder;
};

/**
 * How every metered price turns a period's units into blocks: divide by the
 * block size and round UP, so any part of a block is a whole one (catalog
 * OVERAGE_BLOCK_UNITS). Without it the block price would bill every single
 * unit, $80 a minute; with another divisor or rounding it would bill a
 * different block. The amount and the key cannot show either, so the drift
 * check compares it field by field.
 */
export const BLOCK_TRANSFORM = { divide_by: OVERAGE_BLOCK_UNITS, round: "up" } as const;

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 4,
  })}`;
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/** "$80 per started block of 100 minutes": what one metered price charges. */
function blockLabel(blockCents: number, unitLabel: string): string {
  return `${usd(blockCents)} per started block of ${OVERAGE_BLOCK_UNITS} ${unitLabel}s`;
}

/**
 * The Product description a buyer sees on Checkout and the invoice. Built from
 * the same fields the pricing page renders so the two cannot describe
 * different packages.
 */
export function describePackage(plan: Plan): string {
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

  // Overage is billed per started block (6 October 2026), and the invoice
  // shows a block price, so the product says what a block is for each meter
  // the package bills.
  const blocks = [
    plan.channels.voice ? `${OVERAGE_BLOCK_UNITS} voice minutes` : null,
    hasChat ? `${OVERAGE_BLOCK_UNITS} chat conversations` : null,
  ].filter((s): s is string => s !== null);

  return (
    `${channelText}. ` +
    `Includes ${allowances.join(" and ")}, ${plural(plan.locations, "location")}. ` +
    `One-time setup fee ${usd(plan.setupFeeUsd * 100)}; ` +
    `usage over the allowance billed per started block of ${blocks.join(" or ")} ` +
    `at the published overage rates.` +
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
 * did not create, and its block price is the one apps/app's annual overage
 * invoice charges. It throws on a zero or fractional-cent rate (through
 * `overageBlockCents()`), which fires here in a dry run too: a package that
 * sells a channel must also say what its overage costs.
 */
function desiredMeteredPrices(meter: MeterId): DesiredMeteredPrice[] {
  const byKey = new Map<string, { blockCents: number; planIds: string[] }>();
  for (const plan of plans) {
    for (const price of planMeteredPrices(plan)) {
      if (price.meter !== meter) continue;
      const entry = byKey.get(price.lookupKey) ?? { blockCents: price.blockCents, planIds: [] };
      entry.planIds.push(plan.id);
      byKey.set(price.lookupKey, entry);
    }
  }
  return [...byKey]
    .map(([lookupKey, entry]) => ({ lookupKey, ...entry }))
    .sort((a, b) => b.blockCents - a.blockCents);
}

export function computeDesired(): Desired {
  return {
    packages: plans.map((plan) => ({
      plan,
      productName: plan.name,
      description: describePackage(plan),
      prices: desiredPrices(plan),
    })),
    meters: (Object.keys(METERS) as MeterId[]).map((id) => ({
      meterId: id,
      eventName: METERS[id].eventName,
      displayName: METERS[id].displayName,
      // The product names the invoice line, which shows a block price, so the
      // name says what a block is: "$80 × 2" reads as two blocks, not two minutes.
      productName: `${METERS[id].displayName}, per started block of ${OVERAGE_BLOCK_UNITS}`,
      productDescription:
        `Billed per started block of ${OVERAGE_BLOCK_UNITS} ${METERS[id].unitLabel}s beyond ` +
        `the package allowance, monthly in arrears: 1 to ${OVERAGE_BLOCK_UNITS} extra ` +
        `${METERS[id].unitLabel}s is one block, ${OVERAGE_BLOCK_UNITS + 1} is two.`,
      unitLabel: METERS[id].unitLabel,
      prices: desiredMeteredPrices(id),
    })),
    placeholder: {
      lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY,
      productName: PLAN_START_PLACEHOLDER_NAME,
      description: "No charge. Your package's price replaces this line the day AYA first answers.",
    },
  };
}

/**
 * The parameters that create one block price: package pricing, as Stripe
 * builds it, on a meter. `per_unit` at the price of one block, with the
 * period's metered total divided by the block size and rounded up first
 * (BLOCK_TRANSFORM). Stripe accepts `transform_quantity` only on a per_unit
 * price, and applies it to a metered price at the end of the period, so the
 * app keeps sending single units. Checked against stripe 22.6.1's
 * `PriceCreateParams`.
 */
export function meteredPriceParams(
  meter: Pick<DesiredMeter, "eventName" | "displayName" | "unitLabel">,
  rate: DesiredMeteredPrice,
  ids: { productId: string; meterId: string; transferLookupKey: boolean },
): Stripe.PriceCreateParams {
  return {
    product: ids.productId,
    currency: "usd",
    billing_scheme: "per_unit",
    unit_amount: rate.blockCents,
    transform_quantity: { ...BLOCK_TRANSFORM },
    recurring: { interval: "month", usage_type: "metered", meter: ids.meterId },
    lookup_key: rate.lookupKey,
    transfer_lookup_key: ids.transferLookupKey,
    nickname: `${meter.displayName} — ${blockLabel(rate.blockCents, meter.unitLabel)} (${rate.planIds.join(", ")})`,
    metadata: { [METER_META]: meter.eventName },
  };
}

/**
 * A per-unit metered price from before 6 October 2026: the meter's key prefix
 * and a bare amount (`healdesk_meter_voice_minutes_80`), with no
 * `_block<n>_`. Each billed every minute or conversation at the unit rate.
 * Pass a meter to ask about that meter's prices only.
 */
export function isLegacyMeteredKey(key: string, meter?: MeterId): boolean {
  const meters = meter ? [meter] : (Object.keys(METERS) as MeterId[]);
  return meters.some((id) => new RegExp(`^${METERS[id].lookupKeyPrefix}_\\d+$`).test(key));
}

/**
 * The per-unit keys the 5 October catalog created for a meter, one per rate:
 * what a dry run, which reads nothing from Stripe, says the live run will
 * archive. The live run archives every active per-unit key it finds, these or
 * any older rate's.
 */
export function catalogLegacyMeteredKeys(meter: MeterId): string[] {
  const keys = new Set<string>();
  for (const plan of plans) {
    for (const price of planMeteredPrices(plan)) {
      if (price.meter !== meter) continue;
      keys.add(`${METERS[meter].lookupKeyPrefix}_${overageRateCents(price.rateUsd)}`);
    }
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Reporting. One line per object, one glyph per outcome, and a non-zero exit
// when anything drifted so a deploy step that runs this cannot shrug it off.
// ---------------------------------------------------------------------------

type Tally = {
  created: number;
  verified: number;
  updated: number;
  archived: number;
  drift: number;
  stale: number;
};

const tally: Tally = { created: 0, verified: 0, updated: 0, archived: 0, drift: 0, stale: 0 };

function line(glyph: "✓" | "+" | "✗" | "~" | "-" | "·", text: string): void {
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
function archived(text: string): void {
  tally.archived += 1;
  line("-", `ARCHIVED: ${text}`);
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

/**
 * The same comparison for a block price. The block size is the field the key
 * cannot catch: the same key and amount without `transform_quantity` would
 * bill $80 for every single minute, and a different divisor or rounding a
 * different block, so a missing or different transform is drift.
 */
export function meteredPriceProblems(
  price: Stripe.Price,
  want: DesiredMeteredPrice,
  meterId: string,
): string[] {
  const problems: string[] = [];
  // A whole number of cents, so `unit_amount` carries it exactly; Stripe
  // leaves it null only for a fractional amount, which is drift too.
  if (price.unit_amount !== want.blockCents) {
    problems.push(
      `amount is ${price.unit_amount === null ? "unset" : usd(price.unit_amount)}, catalog says ${usd(want.blockCents)} a block`,
    );
  }
  if (price.currency !== "usd") problems.push(`currency is ${price.currency}`);
  if (price.billing_scheme !== "per_unit") {
    problems.push(`billing_scheme is ${price.billing_scheme}, must be per_unit`);
  }
  const transform = price.transform_quantity;
  const wantTransform = `divide_by ${BLOCK_TRANSFORM.divide_by} rounding ${BLOCK_TRANSFORM.round}`;
  if (!transform) {
    problems.push(`transform_quantity is unset, want ${wantTransform}`);
  } else if (
    transform.divide_by !== BLOCK_TRANSFORM.divide_by ||
    transform.round !== BLOCK_TRANSFORM.round
  ) {
    problems.push(
      `transform_quantity is divide_by ${transform.divide_by} rounding ${transform.round}, want ${wantTransform}`,
    );
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
    { name: pkg.productName, description: pkg.description, statement_descriptor: STATEMENT_DESCRIPTOR },
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
// The deferred start's $0 monthly line (contracts §2).
//
// Checkout bills the setup fee and this line, so a subscription exists, holds
// the card and bills nothing monthly until AYA first answers a patient; then
// the package's price replaces it. A $0 price rather than a trial, so Stripe
// never treats the wait as one. Verified like a package price: the amount and
// the shape, because a placeholder that billed anything would be a charge
// nobody agreed to.
// ---------------------------------------------------------------------------
const PLACEHOLDER_META = "healdesk_placeholder";

async function syncPlaceholder(
  stripe: Stripe,
  products: Stripe.Product[],
  activePrices: Map<string, Stripe.Price>,
  want: DesiredPlaceholder,
): Promise<void> {
  console.log(`\n${want.productName}`);
  const product = await findOrCreateProduct(stripe, products, PLACEHOLDER_META, "plan_start", {
    name: want.productName,
    description: want.description,
    statement_descriptor: STATEMENT_DESCRIPTOR,
  });
  const label = `month  ${want.lookupKey.padEnd(40)} ${usd(0)}`;
  const existing = activePrices.get(want.lookupKey);
  if (existing) {
    const problems: string[] = [];
    if (existing.unit_amount !== 0) problems.push(`amount is ${existing.unit_amount === null ? "unset" : usd(existing.unit_amount)}, must be $0`);
    if (existing.currency !== "usd") problems.push(`currency is ${existing.currency}`);
    if (existing.recurring?.interval !== "month") problems.push(`interval is ${existing.recurring?.interval ?? "none"}, must be month`);
    if (existing.recurring?.usage_type !== "licensed") problems.push("must be licensed, not metered");
    if (problems.length === 0) verified(`${label}  ${existing.id}`);
    else drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
    return;
  }
  const holder = await inactiveHolder(stripe, want.lookupKey);
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 0,
    lookup_key: want.lookupKey,
    transfer_lookup_key: holder !== undefined,
    nickname: "Plan start placeholder ($0 until the first answer)",
    recurring: { interval: "month", usage_type: "licensed" },
    metadata: { healdesk_price_kind: "plan_start_placeholder" },
  });
  activePrices.set(want.lookupKey, price);
  created(`${label}  ${price.id}` + (holder ? `  (lookup_key moved off archived ${holder.id})` : ""));
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
      name: want.productName,
      description: want.productDescription,
      statement_descriptor: STATEMENT_DESCRIPTOR,
    },
  );

  let meterDrifted = false;
  for (const rate of want.prices) {
    const label = `price  ${rate.lookupKey.padEnd(48)} ${blockLabel(rate.blockCents, want.unitLabel)}`;
    const existing = activePrices.get(rate.lookupKey);
    if (existing) {
      const problems = meteredPriceProblems(existing, rate, meter.id);
      if (problems.length === 0) verified(`${label}  ${existing.id}`);
      else {
        meterDrifted = true;
        drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
      }
      continue;
    }

    const holder = await inactiveHolder(stripe, rate.lookupKey);
    const price = await stripe.prices.create(
      meteredPriceParams(want, rate, {
        productId: product.id,
        meterId: meter.id,
        transferLookupKey: holder !== undefined,
      }),
    );
    activePrices.set(rate.lookupKey, price);
    created(
      `${label}  ${price.id}` +
        (holder ? `  (lookup_key moved off archived ${holder.id})` : ""),
    );
  }

  await archiveLegacyMeteredPrices(stripe, activePrices, want.meterId, { keep: meterDrifted });
}

/**
 * Archive a meter's per-unit prices of 5 October (`active: false`), once its
 * block prices are in place, and drop them from `activePrices` so they are
 * not reported STALE as well. See the header for why this one archive is
 * safe: Stripe keeps billing a subscription item already on an archived
 * price, and apps/app's reconcile moves the item onto the block price. With
 * `keep` (a block price on this meter drifted) they stay active and are
 * listed, so there is always a price on the meter that bills as it should.
 */
export async function archiveLegacyMeteredPrices(
  stripe: Pick<Stripe, "prices">,
  activePrices: Map<string, Stripe.Price>,
  meter: MeterId,
  options: { keep: boolean },
): Promise<{ archived: string[]; kept: string[] }> {
  const out = { archived: [] as string[], kept: [] as string[] };
  const legacy = [...activePrices.keys()].filter((key) => isLegacyMeteredKey(key, meter)).sort();
  for (const key of legacy) {
    const price = activePrices.get(key)!;
    if (options.keep) {
      out.kept.push(key);
      line(
        "~",
        `KEPT: ${key.padEnd(48)} ${price.id}  per-unit; archive it once the block price above is fixed`,
      );
      continue;
    }
    await stripe.prices.update(price.id, { active: false });
    activePrices.delete(key);
    out.archived.push(key);
    archived(`${key.padEnd(48)} ${price.id}  per-unit, replaced by the block price above`);
  }
  return out;
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
    desired.placeholder.lookupKey,
  ]);
  // A per-unit metered price still active here was KEPT by its meter's own
  // section, which already said why; listing it again as STALE would only
  // contradict that line.
  const extra = [...activePrices.keys()]
    .filter((k) => !wanted.has(k) && !isLegacyMeteredKey(k))
    .sort();
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
    line("·", `product  ${m.productName}  [${METER_META}=${m.eventName}]`);
    line("·", `         "${m.productDescription}"`);
    for (const rate of m.prices) {
      line(
        "·",
        `price    ${rate.lookupKey.padEnd(48)} ${blockLabel(rate.blockCents, m.unitLabel)}  ` +
          `recurring/month/metered per_unit, transform_quantity divide_by ${BLOCK_TRANSFORM.divide_by} ` +
          `round ${BLOCK_TRANSFORM.round}  (${rate.planIds.join(", ")})`,
      );
    }
    // A dry run reads nothing from Stripe, so it names the per-unit keys the
    // 5 October catalog created; the live run archives every active one it finds.
    line(
      "·",
      `archive  active per-unit prices ${METERS[m.meterId].lookupKeyPrefix}_<cents> (no _block), ` +
        `once the block prices above are in place: ${catalogLegacyMeteredKeys(m.meterId).join(", ")}`,
    );
  }
  console.log(`\n${desired.placeholder.productName}`);
  line("·", `product  ${desired.placeholder.productName}  [${PLACEHOLDER_META}=plan_start]`);
  line("·", `price    ${desired.placeholder.lookupKey.padEnd(40)} ${usd(0).padEnd(8)} recurring/month/licensed`);
  console.log(`\n${COHORT_SETUP_CREDIT.name}`);
  for (const plan of plans) {
    line(
      "·",
      `coupon   ${`${COHORT_SETUP_CREDIT.couponId}-${plan.id}`.padEnd(40)} ${usd(plan.setupFeeUsd * 100).padEnd(8)} amount_off/once`,
    );
  }
  console.log(
    `\nWould also list active ${KEY_PREFIX}* prices and flag any other the catalog no longer names as STALE.`,
  );
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

function printNext(live: boolean): void {
  console.log(
    `\nNext:\n` +
      `  1. Statement descriptor, Customer Portal and webhook endpoint:\n` +
      `     npx tsx apps/web/scripts/stripe-account-settings.ts --dry-run, then\n` +
      `     without --dry-run, with a key that can write Products, Webhook\n` +
      `     Endpoints and Customer Portal. It sets "${STATEMENT_DESCRIPTOR}" on these products\n` +
      `     only (one account serves scalabid too), and${live ? " writes the new\n     endpoint's signing secret to a git-ignored file for STRIPE_WEBHOOK_SECRET." : "\n     skips the webhook in test mode; locally run\n     stripe listen --forward-to localhost:3000/api/webhooks/stripe"}\n` +
      `  2. Stripe Tax  stays off unless the owner's accountant says it is\n` +
      `     needed. Then Settings → Tax → enable, and set a default tax behavior\n` +
      `     (prices here are created without tax_behavior and inherit it).\n` +
      `  3. Settings → Billing → Revenue recovery → Retries, if all retries\n` +
      `     fail: mark the subscription unpaid, never cancel it. healdesk owns\n` +
      `     the terminal transition — customer.subscription.updated with\n` +
      `     status=unpaid suspends the clinic, and the billing-sweep job suspends\n` +
      `     it once its grace window closes — so a Stripe-side cancel would race\n` +
      `     both. That job ships OFF: enable it from the ops console.\n`,
  );
}

function summaryLine(desired: Desired): string {
  const meteredPrices = desired.meters.reduce((n, m) => n + m.prices.length, 0);
  return (
    `${desired.packages.length} packages, ${desired.meters.length} meters ` +
    `carrying ${meteredPrices} metered prices (per started block of ${OVERAGE_BLOCK_UNITS}), no trial`
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
  await syncPlaceholder(stripe, products, activePrices, desired.placeholder);
  await syncCohortCoupons(stripe);
  reportStale(activePrices, desired);

  console.log(
    `\n${tally.created} created, ${tally.verified} verified, ${tally.updated} updated, ` +
      `${tally.archived} archived, ${tally.drift} drifted, ${tally.stale} stale.`,
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

/**
 * Run only when executed as a script, so stripe-setup.test.ts can import the
 * pure parts above without the run starting (and asking for a key).
 */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
