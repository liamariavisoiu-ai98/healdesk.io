/**
 * Create the Stripe products, prices, coupons and meters for the catalog.
 *
 * Run once per Stripe environment (test, then live), and again after any
 * catalog change:
 *
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx apps/web/scripts/stripe-setup.ts
 *   npx tsx apps/web/scripts/stripe-setup.ts --dry-run          # no key, no calls
 *   npx tsx apps/web/scripts/stripe-setup.ts --dry-run --full   # every price and coupon
 *
 * ## Why a script rather than the Dashboard
 *
 * The prices exist in two places — packages/catalog/src/plans.ts and Stripe —
 * and a clinic that is shown $400 and charged $1,200 is the kind of mistake
 * that ends a company. Creating them from the catalog means the two cannot
 * disagree at creation time, and re-running the script reports any drift that
 * appeared afterwards. It never edits an amount: prices in Stripe are
 * immutable, and a script that "fixed" a mismatch by creating a replacement
 * would hide exactly the disagreement a human needs to look at.
 *
 * ## What one package is in Stripe (the step pricing of 13 October 2026)
 *
 * A clinic picks a package (voice, webchat, metachat, voice + webchat, voice +
 * metachat) and a step of 100 to 1,500 for each thing it uses. Every package
 * is one Product, keyed by `metadata.healdesk_package_id`, carrying:
 *
 *   - `month`  one recurring monthly price per PLAN (package and steps), at
 *              `monthlyUsd`: 15 for a single-product package, 225 for a
 *              combined one;
 *   - `year`   the same per plan, yearly, at `annualTotalUsd()` (12 × the
 *              quoted per-month annual figure, 20% off, so the site and the
 *              invoice agree);
 *   - `setup`  ONE one-time price per package, at the package's setup fee.
 *              Never recurring. Checkout adds it as a line item on the first
 *              invoice. An upgrade OWES only `setupFeeDeltaUsd()`, but nothing
 *              invoices that yet, so it is collected by hand.
 *
 * That is 990 recurring prices from `allPlans()`. The catalog header says why
 * a price per plan and not a price per step: apps/app reads a subscription as
 * one package price whose quantity is the number of locations. The nickname
 * on each says its steps ("500 minutes + 300 conversations, monthly"), which
 * is what the Dashboard lists; the lookup key is what the code reads.
 *
 * The 5 October packages were keyed by `metadata.healdesk_plan_id`, and one
 * of their ids, "voice", is also a package id now. Keying the new products by
 * a NEW metadata key is what keeps them apart: under the old key the new
 * "voice" product would have found the old one, renamed it and re-described
 * it, and every subscription still on the old $397 voice price would have
 * started reading the new package's description on its invoices. The old
 * products are left exactly as they are and listed as LEGACY, beside their
 * prices, which are listed STALE (below).
 *
 * There is no trial. Provisioning builds a voice agent before the clinic sees
 * anything, and the setup fee is what pays for that — see the catalog header.
 *
 * ## The setup credits: one coupon per credit per package
 *
 * Three credits take a share of the setup fee off, and only one applies to a
 * Session (lib/billing.ts decides which): the founding-cohort credit, the
 * whole fee; the personalised demo's, 50%; the website's, 30%. Each is a
 * Stripe coupon per package, `amount_off` the credit in whole dollars after
 * the catalog's rounding (`setupCreditUsd`: a buyer pays the fee less the
 * credit, rounded UP to the dollar), `duration: "once"` so it never touches a
 * renewal. The coupon id carries the amount (`setupCouponId`) because a
 * coupon's amount can never change: a new setup fee is a new coupon, never the
 * old one silently applied. Stripe refuses a Session that names a coupon it
 * does not have, so this runs before any offer is shown.
 *
 * ## Overage: two meters, one metered price per rate, billed in blocks of 100
 *
 * Voice minutes and chat conversations over the allowance are billed through
 * Stripe Billing Meters: the app sends a meter event per unit consumed, Stripe
 * sums them per period, and a metered Price attached to the subscription turns
 * the sum into an invoice line. Each meter is keyed by its `event_name`, which
 * is what the app sends, and backs one price for every distinct overage rate
 * the catalog uses: three prices on two meters, $104 a block of voice
 * minutes, $52 a block of Web Chat conversations and $78 a block of Meta Chat
 * conversations (owner, 13 October 2026). A subscription carries only its own
 * package's price, so one event stream bills each clinic at its own rate.
 *
 * Overage is billed per STARTED block of 100 units (6 October 2026; kept by
 * the sheet of 13 October), so each price is package-priced: `billing_scheme:
 * per_unit` at the price of one block, with `transform_quantity` dividing the
 * period's total by 100 and rounding up. 1 to 100 minutes over is one block,
 * 101 is two. Stripe applies the transform to a metered total at the end of
 * the period, and only to a per_unit price, never a tiered one. The app still
 * sends single units and never has to know the block.
 *
 * Each metered price's lookup_key encodes the block size and the block price,
 * from `meteredPriceLookupKey()` (`healdesk_meter_chat_conversations_block100_7800`),
 * for the same reason a package key encodes its amount: a rate or block change
 * creates a new price instead of silently resolving to the old one. Checkout
 * attaches none of them (lib/billing.ts); apps/app adds the package's own at
 * the plan start.
 *
 * The per-unit metered prices of 5 October (`healdesk_meter_voice_minutes_80`)
 * are ARCHIVED here, once their meter's block prices are in place: the one
 * exception to "nothing is archived" below, because their migration is
 * automatic. apps/app's metered-item reconcile (lib/billing/metered-items.ts)
 * swaps a subscription's item onto its plan's block price, and leaving them
 * active would let a stale checkout keep selling per-unit overage.
 *
 * The block prices of 6 October ($80, $40, $30 a block) are NOT archived, by
 * the same test failed: nothing migrates them. They bill subscriptions on the
 * seven packages of 5 October, whose ids have left the catalog, and the
 * reconcile leaves a subscription on a plan it cannot find alone rather than
 * strip it. Archiving them would stop nothing (Stripe goes on billing an item
 * already on an archived price, and no code adds them any more) and would
 * remove the one signal that someone is still billed on them. They are listed
 * STALE like the old package prices, for a human to archive once no
 * subscription carries them.
 *
 * ## Idempotent by lookup_key, not by name
 *
 * Every price carries a `lookup_key` from `stripeLookupKey()`, which encodes
 * the plan (or, for setup, the package), the kind and the amount
 * (`healdesk_voice-webchat-500-300_month_52000`). Re-running finds the
 * existing price by that key, checks that it still says what the catalog
 * says, and leaves it alone. A catalog price CHANGE produces a new key, so it
 * is a new price; the previous one stays active for the subscriptions already
 * on it and is reported here as STALE so a human can archive it once nobody is
 * billing on it.
 *
 * Nothing else here is destructive: nothing is deleted, nothing but those
 * per-unit metered prices is archived, no product is deactivated, and no
 * amount is ever updated. Beyond create, a product's name and description and
 * a coupon's name are brought in line with the catalog (see
 * findOrCreateProduct), and `transfer_lookup_key` is used only when the key is
 * held by an INACTIVE price — Stripe keeps lookup keys unique across prices,
 * so without the transfer an archived price would block its own replacement.
 *
 * ## A thousand prices, safely
 *
 * Every price on the account is listed ONCE, active and archived together,
 * with auto-pagination, and the run then creates only what is missing. The
 * creates go out a few at a time (CONCURRENCY) and no faster than
 * REQUESTS_PER_SECOND, well under Stripe's limit of 25 requests a second in
 * test mode and 100 in live; a 429 is retried with backoff (withRateLimitRetry)
 * and network errors, conflicts and 5xx by the SDK itself. Each create carries
 * an idempotency key naming this run and the lookup key, so a retried request
 * returns the price it already made. A run that dies part-way leaves whatever
 * it made, and the next run picks up from there.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  allPlans,
  annualTotalUsd,
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  SELF_SERVE_DEMO_SETUP_CREDIT,
  METERS,
  type MeterId,
  OVERAGE_BLOCK_UNITS,
  type Package,
  type PackageId,
  PACKAGES,
  packageSetupFeeUsd,
  planMeteredPrices,
  type Plan,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  PLAN_START_PLACEHOLDER_NAME,
  type PriceKind,
  PRODUCTS,
  type SetupCredit,
  setupCouponId,
  setupCreditUsd,
  SITE_SETUP_CREDIT,
  stripeLookupKey,
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
 * `healdesk_plan_id` keyed the products of the 5 October packages; it is read
 * here only to list them as LEGACY (see the header).
 */
export const PACKAGE_META = "healdesk_package_id";
export const LEGACY_PLAN_META = "healdesk_plan_id";
const METER_META = "healdesk_meter";

/** Every key this script writes starts with this; used to spot stale prices. */
const KEY_PREFIX = "healdesk_";

/**
 * How many creates are in flight at once, and how many requests start in any
 * second. Stripe allows 25 a second in test mode and 100 in live; ten leaves
 * room for anything else using the same key at the same time.
 */
export const CONCURRENCY = 4;
export const REQUESTS_PER_SECOND = 10;

// ---------------------------------------------------------------------------
// The desired state, computed from the catalog with no Stripe involved.
//
// Separating "what should exist" from "make it exist" is what makes --dry-run
// honest: it prints the same objects the live run would create, from the same
// code, rather than a hand-maintained description that drifts from the real
// thing.
// ---------------------------------------------------------------------------

export type DesiredPrice = {
  lookupKey: string;
  /** Hidden from customers; what the Dashboard shows in the price list. */
  nickname: string;
  amountCents: number;
  kind: PriceKind;
  /** The plan a recurring price bills; null for the package's setup fee. */
  planId: string | null;
};

/**
 * The setup offers, as the Session's `offer` metadata names them
 * (lib/billing.ts `SetupOffer`), with the catalog credit each one is.
 */
export const SETUP_COUPON_OFFERS = [
  { offer: "cohort-setup", credit: COHORT_SETUP_CREDIT },
  { offer: "demo-setup-50", credit: DEMO_SETUP_CREDIT },
  { offer: "demo-setup-30", credit: SELF_SERVE_DEMO_SETUP_CREDIT },
  { offer: "site-setup-30", credit: SITE_SETUP_CREDIT },
] as const satisfies readonly { offer: string; credit: SetupCredit }[];

export type DesiredCoupon = {
  /** `setupCouponId(credit, package)`: the prefix, the package and the amount. */
  id: string;
  /** Stripe prints it on Checkout and the invoice. At most 40 characters. */
  name: string;
  offer: (typeof SETUP_COUPON_OFFERS)[number]["offer"];
  percentOfSetupFee: number;
  amountOffCents: number;
};

export type DesiredPackage = {
  pkg: Package;
  productName: string;
  description: string;
  setupFeeUsd: number;
  /** The setup price first, then every plan's month and year prices, smallest step first. */
  prices: readonly DesiredPrice[];
  coupons: readonly DesiredCoupon[];
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
  packageIds: readonly PackageId[];
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
 * unit, $104 a minute; with another divisor or rounding it would bill a
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

/** "$104 per started block of 100 minutes": what one metered price charges. */
function blockLabel(blockCents: number, unitLabel: string): string {
  return `${usd(blockCents)} per started block of ${OVERAGE_BLOCK_UNITS} ${unitLabel}s`;
}

/** What each product answers, in a buyer's words, for the product description. */
const ANSWERS: Record<keyof typeof PRODUCTS, string> = {
  voice: "phone calls",
  webchat: "website chat",
  metachat: "Instagram, Messenger, WhatsApp and website chat",
};

/**
 * The Product description a buyer sees on Checkout (beside the setup fee,
 * which is a price on this product) and on the invoice. It describes the
 * PACKAGE, because one product carries every step: the step a clinic bought
 * is the price, and the steps on offer are what the description can say.
 * AYA's product names, never "chatbot" or "AI voice agent" (owner,
 * 7 October 2026).
 */
export function describePackage(pkg: Package): string {
  const products = [pkg.voice ? PRODUCTS.voice : null, pkg.chat ? PRODUCTS[pkg.chat] : null].filter(
    (p): p is (typeof PRODUCTS)[keyof typeof PRODUCTS] => p !== null,
  );
  const what = products.map((p) => `${p.name} (${ANSWERS[p.id]})`).join(" + ");
  const counted = products.map((p) => (p.unit === "minute" ? "voice minutes" : "chat conversations"));
  const steps = counted.map((c) => `100 to 1,500 ${c}`).join(" and ");

  // Meta bills the clinic directly for WhatsApp messages, including service
  // replies inside the 24-hour window from 1 October 2026, and healdesk does
  // not resell them (docs/v1-product-spec.md, "Pricing consequences"). Said on
  // the product itself so the invoice line cannot read as covering them.
  const whatsapp = pkg.chat === "metachat" ? " WhatsApp message charges are billed to the clinic by Meta directly." : "";

  return (
    `${what}. ` +
    `Priced by the step chosen: ${steps} a month, in steps of 100, per location. ` +
    `One-time setup fee ${usd(packageSetupFeeUsd(pkg) * 100)}; ` +
    `usage over the included amount billed per started block of ` +
    `${counted.map((c) => `${OVERAGE_BLOCK_UNITS} ${c}`).join(" or ")} at the published overage rates.` +
    whatsapp
  );
}

/** "500 minutes + 300 conversations": a plan's steps, for a price's nickname. */
export function stepsLabel(plan: Plan): string {
  const parts: string[] = [];
  if (plan.channels.voice) parts.push(`${plan.includedVoiceMinutes.toLocaleString("en-US")} minutes`);
  if (plan.chatProduct) parts.push(`${plan.includedChatConversations.toLocaleString("en-US")} conversations`);
  return parts.join(" + ");
}

function desiredPlanPrices(plan: Plan): DesiredPrice[] {
  return [
    {
      kind: "month",
      planId: plan.id,
      lookupKey: stripeLookupKey(plan, "month"),
      nickname: `${stepsLabel(plan)}, monthly`,
      amountCents: plan.monthlyUsd * 100,
    },
    {
      kind: "year",
      planId: plan.id,
      lookupKey: stripeLookupKey(plan, "year"),
      nickname: `${stepsLabel(plan)}, annual (${usd(plan.annualMonthlyUsd * 100)}/mo × 12)`,
      amountCents: annualTotalUsd(plan) * 100,
    },
  ];
}

/** One coupon per setup credit for a package; see the header. */
export function desiredCoupons(pkg: Package): DesiredCoupon[] {
  const fee = { packageId: pkg.id, setupFeeUsd: packageSetupFeeUsd(pkg) };
  return SETUP_COUPON_OFFERS.map(({ offer, credit }) => ({
    id: setupCouponId(credit, fee),
    name: credit.name,
    offer,
    percentOfSetupFee: credit.percentOfSetupFee,
    amountOffCents: setupCreditUsd(fee, credit) * 100,
  }));
}

/**
 * One metered price per distinct rate on the meter, from the plans that bill
 * it. `planMeteredPrices()` is the same function apps/app uses to pick a
 * subscription's metered prices, so a plan can never be sold a key this
 * script did not create, and its block price is the one apps/app's annual
 * overage invoice charges. It throws on a zero or fractional-cent rate
 * (through `overageBlockCents()`), which fires here in a dry run too: a
 * package that sells a channel must also say what its overage costs.
 */
function desiredMeteredPrices(meter: MeterId, plans: readonly Plan[]): DesiredMeteredPrice[] {
  const byKey = new Map<string, { blockCents: number; packageIds: PackageId[] }>();
  for (const plan of plans) {
    for (const price of planMeteredPrices(plan)) {
      if (price.meter !== meter) continue;
      const entry = byKey.get(price.lookupKey) ?? { blockCents: price.blockCents, packageIds: [] };
      if (!entry.packageIds.includes(plan.packageId)) entry.packageIds.push(plan.packageId);
      byKey.set(price.lookupKey, entry);
    }
  }
  return [...byKey]
    .map(([lookupKey, entry]) => ({ lookupKey, ...entry }))
    .sort((a, b) => b.blockCents - a.blockCents);
}

export function computeDesired(): Desired {
  const plans = allPlans();
  return {
    packages: PACKAGES.map((pkg) => {
      const own = plans.filter((plan) => plan.packageId === pkg.id);
      const setupFeeUsd = packageSetupFeeUsd(pkg);
      return {
        pkg,
        productName: pkg.name,
        description: describePackage(pkg),
        setupFeeUsd,
        prices: [
          {
            kind: "setup" as const,
            planId: null,
            // Any of the package's plans gives the same key: setup is per package.
            lookupKey: stripeLookupKey(own[0]!, "setup"),
            nickname: `${pkg.name}: setup fee (one-time)`,
            amountCents: setupFeeUsd * 100,
          },
          ...own.flatMap(desiredPlanPrices),
        ],
        coupons: desiredCoupons(pkg),
      };
    }),
    meters: (Object.keys(METERS) as MeterId[]).map((id) => ({
      meterId: id,
      eventName: METERS[id].eventName,
      displayName: METERS[id].displayName,
      // The product names the invoice line, which shows a block price, so the
      // name says what a block is: "$104 × 2" reads as two blocks, not two minutes.
      productName: `${METERS[id].displayName}, per started block of ${OVERAGE_BLOCK_UNITS}`,
      productDescription:
        `Billed per started block of ${OVERAGE_BLOCK_UNITS} ${METERS[id].unitLabel}s beyond ` +
        `the package allowance, monthly in arrears: 1 to ${OVERAGE_BLOCK_UNITS} extra ` +
        `${METERS[id].unitLabel}s is one block, ${OVERAGE_BLOCK_UNITS + 1} is two.`,
      unitLabel: METERS[id].unitLabel,
      prices: desiredMeteredPrices(id, plans),
    })),
    placeholder: {
      lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY,
      productName: PLAN_START_PLACEHOLDER_NAME,
      description: "No charge. Your package's price replaces this line the day AYA first answers.",
    },
  };
}

/** Every lookup key the catalog asks for. */
export function wantedLookupKeys(desired: Desired): Set<string> {
  return new Set<string>([
    ...desired.packages.flatMap((p) => p.prices.map((x) => x.lookupKey)),
    ...desired.meters.flatMap((m) => m.prices.map((x) => x.lookupKey)),
    desired.placeholder.lookupKey,
  ]);
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
    nickname: `${meter.displayName} — ${blockLabel(rate.blockCents, meter.unitLabel)} (${rate.packageIds.join(", ")})`,
    metadata: { [METER_META]: meter.eventName },
  };
}

/** The parameters that create one package price: recurring and licensed, or the one-time setup fee. */
export function packagePriceParams(
  pkg: Package,
  want: DesiredPrice,
  ids: { productId: string; transferLookupKey: boolean },
): Stripe.PriceCreateParams {
  return {
    product: ids.productId,
    currency: "usd",
    unit_amount: want.amountCents,
    lookup_key: want.lookupKey,
    transfer_lookup_key: ids.transferLookupKey,
    nickname: want.nickname,
    // The setup fee is deliberately NOT recurring: `recurring` absent makes
    // Stripe create a one_time price, which Checkout can only add as a
    // one-off line item — so a setup fee cannot be re-billed by accident.
    ...(want.kind === "setup" ? {} : { recurring: { interval: want.kind, usage_type: "licensed" as const } }),
    metadata: {
      [PACKAGE_META]: pkg.id,
      // The plan a price bills. On a PRICE this key has always meant the plan;
      // only on a product does it mark the 5 October packages.
      ...(want.planId ? { [LEGACY_PLAN_META]: want.planId } : {}),
      healdesk_price_kind: want.kind,
    },
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
 * The per-unit keys the 5 October catalog created, one per rate ($0.80 a
 * voice minute; $0.40 and $0.30 a chat conversation): what a dry run, which
 * reads nothing from Stripe, says the live run will archive. Written out
 * because the catalog that computed them is gone; the live run archives every
 * active per-unit key it finds, these or any older rate's.
 */
const PER_UNIT_KEYS_OF_5_OCTOBER: Record<MeterId, readonly string[]> = {
  voiceMinutes: ["healdesk_meter_voice_minutes_80"],
  chatConversations: ["healdesk_meter_chat_conversations_30", "healdesk_meter_chat_conversations_40"],
};

export function legacyPerUnitKeys(meter: MeterId): string[] {
  return [...PER_UNIT_KEYS_OF_5_OCTOBER[meter]];
}

/**
 * What the step pricing of 13 October left behind, for the dry run's account
 * of what the live run will list STALE: the seven packages of 5 October and
 * the block prices of 6 October. Only a description; the live run reports
 * whatever active key the catalog no longer names, these or any other.
 */
export const SUPERSEDED_13_OCTOBER = {
  packageIds: ["chat-web", "chat-meta", "voice", "chat-dual", "web-voice", "meta-voice", "complete"],
  blockKeys: [
    "healdesk_meter_voice_minutes_block100_8000",
    "healdesk_meter_chat_conversations_block100_4000",
    "healdesk_meter_chat_conversations_block100_3000",
  ],
} as const;

/**
 * Active prices with our prefix that the catalog no longer names: a previous
 * catalog's package prices and block prices, still billing the subscriptions
 * on them. Never touched, only surfaced, because archiving one under a live
 * subscription is a manual decision with a migration attached. A per-unit
 * metered price is left out: its meter's own section archived it or said why
 * it kept it.
 */
export function staleLookupKeys(activeKeys: Iterable<string>, desired: Desired): string[] {
  const wanted = wantedLookupKeys(desired);
  return [...activeKeys]
    .filter((k) => k.startsWith(KEY_PREFIX) && !wanted.has(k) && !isLegacyMeteredKey(k))
    .sort();
}

/** Products of the 5 October packages: keyed by the old metadata key and not the new one. */
export function legacyPackageProducts<P extends { metadata: Record<string, string> }>(products: readonly P[]): P[] {
  return products.filter((p) => Boolean(p.metadata[LEGACY_PLAN_META]) && !p.metadata[PACKAGE_META]);
}

/** Coupons with one of our setup-credit prefixes that the catalog no longer names. */
export function staleCouponIds(couponIds: Iterable<string>, desired: Desired): string[] {
  const wanted = new Set(desired.packages.flatMap((p) => p.coupons.map((c) => c.id)));
  // "healdesk-demo-setup" is the prefix every demo coupon has had: the 5
  // October half, the homepage demo's 30% of the morning of 13 October (one
  // per old package, no amount in the id), and today's two; matching on it
  // finds every generation.
  const prefixes = [COHORT_SETUP_CREDIT.couponId, "healdesk-demo-setup", SITE_SETUP_CREDIT.couponId];
  return [...couponIds].filter((id) => prefixes.some((p) => id.startsWith(`${p}-`)) && !wanted.has(id)).sort();
}

// ---------------------------------------------------------------------------
// Pacing. A thousand creates must not trip Stripe's rate limit, and a 429
// that does arrive must cost a pause, not the run.
// ---------------------------------------------------------------------------

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Starts at most `perSecond` requests a second, however many workers ask:
 * each caller takes the next free slot, spaced 1000 / perSecond apart.
 */
export class Throttle {
  private nextStart = 0;
  private readonly gapMs: number;

  constructor(
    perSecond: number,
    private readonly clock: Clock = realClock,
  ) {
    this.gapMs = 1000 / perSecond;
  }

  async slot(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.nextStart);
    this.nextStart = at + this.gapMs;
    if (at > now) await this.clock.sleep(at - now);
  }
}

function isRateLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { statusCode?: unknown; type?: unknown };
  return e.statusCode === 429 || e.type === "StripeRateLimitError";
}

/**
 * Run one request, through the throttle, retrying a 429 with exponential
 * backoff and jitter (1 s, 2 s, 4 s … capped at 16 s; six attempts). A 429 is
 * refused before Stripe executes anything, so sending it again is safe, and
 * the creates carry an idempotency key in any case. Anything else is thrown
 * at once: the SDK has already retried what is safe to retry.
 */
export async function withRateLimitRetry<T>(
  throttle: Throttle,
  request: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; clock?: Clock } = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const baseMs = options.baseMs ?? 1000;
  const clock = options.clock ?? realClock;
  for (let attempt = 1; ; attempt += 1) {
    await throttle.slot();
    try {
      return await request();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= attempts) throw error;
      const wait = Math.min(baseMs * 2 ** (attempt - 1), 16_000) * (0.5 + Math.random() / 2);
      await clock.sleep(wait);
    }
  }
}

/**
 * `fn` over every item, at most `concurrency` at once, results in input
 * order. The first failure stops new items from starting; those already
 * running finish, and then it is thrown, so the report never claims a price
 * that was not made.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  async function worker(): Promise<void> {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}

// ---------------------------------------------------------------------------
// Reporting. A line per product, coupon and meter price, a summary per
// package for its prices (every one with --full), every drift always, and a
// non-zero exit when anything drifted so a deploy step that runs this cannot
// shrug it off.
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

type Glyph = "✓" | "+" | "✗" | "~" | "-" | "·";

function line(glyph: Glyph, text: string): void {
  console.log(`  ${glyph} ${text}`);
}

function created(text: string, print = true): void {
  tally.created += 1;
  if (print) line("+", text);
}
function verified(text: string, print = true): void {
  tally.verified += 1;
  if (print) line("✓", text);
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

/**
 * Every price this script could have written, by lookup_key, active and
 * archived, in one paginated pass: the active ones are what is verified, and
 * an archived one is a holder its replacement must take the key from
 * (`transfer_lookup_key`). Listing once is what keeps a run of a thousand
 * prices to a dozen reads instead of a read per price.
 */
async function listOurPrices(
  stripe: Stripe,
): Promise<{ active: Map<string, Stripe.Price>; inactive: Map<string, Stripe.Price> }> {
  const active = new Map<string, Stripe.Price>();
  const inactive = new Map<string, Stripe.Price>();
  for await (const price of stripe.prices.list({ limit: 100 })) {
    if (!price.lookup_key?.startsWith(KEY_PREFIX)) continue;
    (price.active ? active : inactive).set(price.lookup_key, price);
  }
  return { active, inactive };
}

/**
 * Find a product by its metadata key, or create it. An existing product's
 * name and description ARE brought in line with the catalog: they carry what
 * a buyer reads on Checkout and on the invoice, and a product created before
 * a catalog change would otherwise keep advertising the old terms while
 * apps/app enforces the new ones. That is the one edit this script makes to a
 * product, because it changes no amount: prices stay immutable here.
 */
async function findOrCreateProduct(
  stripe: Stripe,
  throttle: Throttle,
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
    const updated = await withRateLimitRetry(throttle, () =>
      stripe.products.update(found.id, { name: params.name, description: params.description }),
    );
    products[products.indexOf(found)] = updated;
    tally.updated += 1;
    line("~", `UPDATED: product  ${updated.name.padEnd(36)} ${updated.id}  (name or description now matches the catalog)`);
    return updated;
  }
  const product = await withRateLimitRetry(throttle, () =>
    stripe.products.create({ ...params, metadata: { [metaKey]: metaValue } }),
  );
  products.push(product);
  created(`product  ${product.name.padEnd(36)} ${product.id}`);
  return product;
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
export function packagePriceProblems(price: Stripe.Price, want: DesiredPrice): string[] {
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
 * bill $104 for every single minute, and a different divisor or rounding a
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

/** The coupon comparison: amount, currency and duration cannot change in place, so any difference is drift. */
export function couponProblems(coupon: Stripe.Coupon, want: DesiredCoupon): string[] {
  const problems: string[] = [];
  if (coupon.amount_off !== want.amountOffCents) problems.push(`amount_off is ${coupon.amount_off}, want ${want.amountOffCents}`);
  if (coupon.percent_off !== null && coupon.percent_off !== undefined) problems.push(`percent_off is ${coupon.percent_off}, want none`);
  if (coupon.currency !== "usd") problems.push(`currency is ${coupon.currency}`);
  if (coupon.duration !== "once") problems.push(`duration is ${coupon.duration}, want once`);
  if (!coupon.valid) problems.push("coupon is no longer valid");
  return problems;
}

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------

type Run = {
  stripe: Stripe;
  throttle: Throttle;
  /** Names this run in every create's idempotency key. */
  runId: string;
  full: boolean;
  products: Stripe.Product[];
  activePrices: Map<string, Stripe.Price>;
  inactivePrices: Map<string, Stripe.Price>;
  coupons: Map<string, Stripe.Coupon>;
};

async function createPrice(run: Run, params: Stripe.PriceCreateParams): Promise<Stripe.Price> {
  return withRateLimitRetry(run.throttle, () =>
    run.stripe.prices.create(params, { idempotencyKey: `stripe-setup:${run.runId}:${params.lookup_key}` }),
  );
}

async function syncPackage(run: Run, pkg: DesiredPackage): Promise<void> {
  console.log(`\n${pkg.productName}  (package ${pkg.pkg.id})`);

  const product = await findOrCreateProduct(run.stripe, run.throttle, run.products, PACKAGE_META, pkg.pkg.id, {
    name: pkg.productName,
    description: pkg.description,
    statement_descriptor: STATEMENT_DESCRIPTOR,
  });

  // Verify what exists, then create what is missing, a few at a time.
  const missing: DesiredPrice[] = [];
  const counts = { verified: 0, created: 0 };
  for (const want of pkg.prices) {
    const label = `${want.kind.padEnd(6)} ${want.lookupKey.padEnd(48)} ${usd(want.amountCents)}`;
    const existing = run.activePrices.get(want.lookupKey);
    if (!existing) {
      missing.push(want);
      continue;
    }
    const problems = packagePriceProblems(existing, want);
    if (problems.length === 0) {
      counts.verified += 1;
      verified(`${label}  ${existing.id}`, run.full || want.kind === "setup");
    } else {
      drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
    }
  }

  const made = await mapLimited(missing, CONCURRENCY, async (want) => {
    const holder = run.inactivePrices.get(want.lookupKey);
    const price = await createPrice(
      run,
      packagePriceParams(pkg.pkg, want, { productId: product.id, transferLookupKey: holder !== undefined }),
    );
    run.activePrices.set(want.lookupKey, price);
    if (holder) run.inactivePrices.delete(want.lookupKey);
    return { want, price, holder };
  });
  for (const { want, price, holder } of made) {
    counts.created += 1;
    created(
      `${want.kind.padEnd(6)} ${want.lookupKey.padEnd(48)} ${usd(want.amountCents)}  ${price.id}` +
        (holder ? `  (lookup_key moved off archived ${holder.id})` : ""),
      run.full || want.kind === "setup",
    );
  }

  const recurring = pkg.prices.filter((p) => p.kind !== "setup").length;
  line("·", `${recurring} plan prices (month and year): ${summaryCounts(counts)}${run.full ? "" : "  (--full lists each)"}`);

  await syncCoupons(run, pkg);
}

function summaryCounts(counts: { verified: number; created: number }): string {
  return `${counts.verified} verified, ${counts.created} created`;
}

/**
 * The package's setup-credit coupons (see the header). A coupon whose amount,
 * currency or duration disagrees is drift, never fixed here: its amount cannot
 * be changed in place, and a coupon already applied keeps its discount however
 * it is edited afterwards. The name can, and Stripe prints it on Checkout and
 * the invoice, so it follows the catalog.
 */
async function syncCoupons(run: Run, pkg: DesiredPackage): Promise<void> {
  for (const want of pkg.coupons) {
    const label = `coupon ${want.id.padEnd(48)} ${usd(want.amountOffCents)} off (${want.percentOfSetupFee}%)`;
    const existing = run.coupons.get(want.id);
    if (existing) {
      const problems = couponProblems(existing, want);
      if (problems.length > 0) {
        drift(`${label}: ${problems.join("; ")}`);
        continue;
      }
      if (existing.name !== want.name) {
        await withRateLimitRetry(run.throttle, () => run.stripe.coupons.update(existing.id, { name: want.name }));
        tally.updated += 1;
        line("~", `UPDATED: ${label}  (name now matches the catalog)`);
        continue;
      }
      verified(label);
      continue;
    }
    const made = await withRateLimitRetry(run.throttle, () =>
      run.stripe.coupons.create(
        {
          id: want.id,
          // Stripe caps a coupon name at 40 characters; the id names the package.
          name: want.name,
          amount_off: want.amountOffCents,
          currency: "usd",
          duration: "once",
          metadata: { [PACKAGE_META]: pkg.pkg.id, healdesk_offer: want.offer },
        },
        { idempotencyKey: `stripe-setup:${run.runId}:coupon:${want.id}` },
      ),
    );
    run.coupons.set(made.id, made);
    created(label);
  }
}

// ---------------------------------------------------------------------------
// The deferred start's $0 monthly line (contracts §2).
//
// Checkout bills the setup fee and this line, so a subscription exists, holds
// the card and bills nothing monthly until AYA first answers a patient; then
// the plan's price replaces it. A $0 price rather than a trial, so Stripe
// never treats the wait as one. Verified like a package price: the amount and
// the shape, because a placeholder that billed anything would be a charge
// nobody agreed to.
// ---------------------------------------------------------------------------
const PLACEHOLDER_META = "healdesk_placeholder";

async function syncPlaceholder(run: Run, want: DesiredPlaceholder): Promise<void> {
  console.log(`\n${want.productName}`);
  const product = await findOrCreateProduct(run.stripe, run.throttle, run.products, PLACEHOLDER_META, "plan_start", {
    name: want.productName,
    description: want.description,
    statement_descriptor: STATEMENT_DESCRIPTOR,
  });
  const label = `month  ${want.lookupKey.padEnd(48)} ${usd(0)}`;
  const existing = run.activePrices.get(want.lookupKey);
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
  const holder = run.inactivePrices.get(want.lookupKey);
  const price = await createPrice(run, {
    product: product.id,
    currency: "usd",
    unit_amount: 0,
    lookup_key: want.lookupKey,
    transfer_lookup_key: holder !== undefined,
    nickname: "Plan start placeholder ($0 until the first answer)",
    recurring: { interval: "month", usage_type: "licensed" },
    metadata: { healdesk_price_kind: "plan_start_placeholder" },
  });
  run.activePrices.set(want.lookupKey, price);
  created(`${label}  ${price.id}` + (holder ? `  (lookup_key moved off archived ${holder.id})` : ""));
}

async function listActiveMeters(stripe: Stripe): Promise<Stripe.Billing.Meter[]> {
  const out: Stripe.Billing.Meter[] = [];
  for await (const meter of stripe.billing.meters.list({ status: "active", limit: 100 })) {
    out.push(meter);
  }
  return out;
}

async function listCoupons(stripe: Stripe): Promise<Map<string, Stripe.Coupon>> {
  const out = new Map<string, Stripe.Coupon>();
  for await (const coupon of stripe.coupons.list({ limit: 100 })) out.set(coupon.id, coupon);
  return out;
}

async function syncMeter(run: Run, meters: Stripe.Billing.Meter[], want: DesiredMeter): Promise<void> {
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
    meter = await withRateLimitRetry(run.throttle, () =>
      run.stripe.billing.meters.create({
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
      }),
    );
    meters.push(meter);
    created(`meter    ${want.eventName.padEnd(36)} ${meter.id}`);
  }
  const meterId = meter.id;

  // One product per meter so the invoice line reads "Voice minutes over
  // allowance" rather than a package name the overage does not belong to.
  const product = await findOrCreateProduct(run.stripe, run.throttle, run.products, METER_META, want.eventName, {
    name: want.productName,
    description: want.productDescription,
    statement_descriptor: STATEMENT_DESCRIPTOR,
  });

  let meterDrifted = false;
  for (const rate of want.prices) {
    const label = `price  ${rate.lookupKey.padEnd(48)} ${blockLabel(rate.blockCents, want.unitLabel)}`;
    const existing = run.activePrices.get(rate.lookupKey);
    if (existing) {
      const problems = meteredPriceProblems(existing, rate, meterId);
      if (problems.length === 0) verified(`${label}  ${existing.id}`);
      else {
        meterDrifted = true;
        drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
      }
      continue;
    }

    const holder = run.inactivePrices.get(rate.lookupKey);
    const price = await createPrice(
      run,
      meteredPriceParams(want, rate, {
        productId: product.id,
        meterId,
        transferLookupKey: holder !== undefined,
      }),
    );
    run.activePrices.set(rate.lookupKey, price);
    created(`${label}  ${price.id}` + (holder ? `  (lookup_key moved off archived ${holder.id})` : ""));
  }

  await archiveLegacyMeteredPrices(run.stripe, run.activePrices, want.meterId, { keep: meterDrifted });
}

/**
 * Archive a meter's per-unit prices of 5 October (`active: false`), once its
 * block prices are in place, and drop them from `activePrices` so they are
 * not reported STALE as well. See the header for why this one archive is
 * safe: Stripe keeps billing a subscription item already on an archived
 * price, and apps/app's reconcile moves the item onto the block price. With
 * `keep` (a block price on this meter drifted) they stay active and are
 * listed, so there is always a price on the meter that bills as it should.
 * The block prices of 6 October are not per-unit keys and are never archived
 * here; they are reported STALE.
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
 * What the catalog no longer names: prices (a previous catalog's package and
 * block prices, still billing the subscriptions on them), the products of the
 * 5 October packages, and setup-credit coupons for packages or amounts that
 * are gone. Never touched, only surfaced — see the header.
 */
function reportStale(run: Run, desired: Desired): void {
  const keys = staleLookupKeys(run.activePrices.keys(), desired);
  const products = legacyPackageProducts(run.products);
  const coupons = staleCouponIds(run.coupons.keys(), desired);
  if (keys.length + products.length + coupons.length === 0) return;
  console.log("\nNot in the current catalog (left as they are)");
  for (const product of products) {
    stale(
      `product  ${product.name.padEnd(36)} ${product.id}  [${LEGACY_PLAN_META}=${product.metadata[LEGACY_PLAN_META]}]` +
        `  — a 5 October package; archive once none of its prices bills`,
    );
  }
  for (const key of keys) {
    stale(`${key.padEnd(48)} ${run.activePrices.get(key)!.id}  — archive once no subscription bills on it`);
  }
  for (const id of coupons) {
    stale(`coupon   ${id.padEnd(48)}  — no Session names it any more; delete it by hand if you like`);
  }
}

// ---------------------------------------------------------------------------
// Dry run: the same desired state, printed instead of applied.
// ---------------------------------------------------------------------------

function range<T>(items: readonly T[], show: (item: T) => string): string {
  if (items.length === 0) return "none";
  return items.length === 1 ? show(items[0]!) : `${show(items[0]!)} … ${show(items[items.length - 1]!)}`;
}

export function printDryRun(desired: Desired, options: { full: boolean } = { full: false }): void {
  console.log("DRY RUN — nothing below is sent to Stripe.\n");
  console.log("Would find-or-create, then verify against the catalog:");
  for (const pkg of desired.packages) {
    console.log(`\n${pkg.productName}  (package ${pkg.pkg.id})`);
    line("·", `product  ${pkg.productName}  [${PACKAGE_META}=${pkg.pkg.id}]`);
    line("·", `         "${pkg.description}"`);
    const setup = pkg.prices.find((p) => p.kind === "setup")!;
    line("·", `setup  ${setup.lookupKey.padEnd(48)} ${usd(setup.amountCents).padEnd(9)} one_time`);
    for (const kind of ["month", "year"] as const) {
      const prices = pkg.prices.filter((p) => p.kind === kind);
      if (options.full) {
        for (const want of prices) {
          line("·", `${kind.padEnd(6)} ${want.lookupKey.padEnd(48)} ${usd(want.amountCents).padEnd(9)} recurring/${kind}/licensed  "${want.nickname}"`);
        }
        continue;
      }
      line(
        "·",
        `${kind.padEnd(6)} ${String(prices.length).padStart(3)} prices, recurring/${kind}/licensed, ` +
          `${range(prices, (p) => usd(p.amountCents))}  ` +
          `(${range(prices, (p) => p.lookupKey)})`,
      );
    }
    for (const coupon of pkg.coupons) {
      line("·", `coupon ${coupon.id.padEnd(48)} ${usd(coupon.amountOffCents).padEnd(9)} amount_off/once  (${coupon.percentOfSetupFee}% of setup, "${coupon.name}")`);
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
          `round ${BLOCK_TRANSFORM.round}  (${rate.packageIds.join(", ")})`,
      );
    }
    // A dry run reads nothing from Stripe, so it names the per-unit keys the
    // 5 October catalog created; the live run archives every active one it finds.
    line(
      "·",
      `archive  active per-unit prices ${METERS[m.meterId].lookupKeyPrefix}_<cents> (no _block), ` +
        `once the block prices above are in place: ${legacyPerUnitKeys(m.meterId).join(", ")}`,
    );
  }
  console.log(`\n${desired.placeholder.productName}`);
  line("·", `product  ${desired.placeholder.productName}  [${PLACEHOLDER_META}=plan_start]`);
  line("·", `price    ${desired.placeholder.lookupKey.padEnd(48)} ${usd(0).padEnd(9)} recurring/month/licensed`);
  console.log(
    `\nWould also list as STALE, never archive or delete: every other active ${KEY_PREFIX}* price, among them\n` +
      `the 5 October packages' (${SUPERSEDED_13_OCTOBER.packageIds.join(", ")}) and the 6 October block\n` +
      `prices (${SUPERSEDED_13_OCTOBER.blockKeys.join(", ")});\n` +
      `the products keyed ${LEGACY_PLAN_META}; and setup coupons the catalog no longer names.`,
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

export function summaryLine(desired: Desired): string {
  const planPrices = desired.packages.reduce((n, p) => n + p.prices.filter((x) => x.kind !== "setup").length, 0);
  const coupons = desired.packages.reduce((n, p) => n + p.coupons.length, 0);
  const meteredPrices = desired.meters.reduce((n, m) => n + m.prices.length, 0);
  return (
    `${desired.packages.length} packages carrying ${planPrices.toLocaleString("en-US")} plan prices ` +
    `(month and year, ${(planPrices / 2).toLocaleString("en-US")} plans) and ${desired.packages.length} setup prices, ` +
    `${coupons} setup coupons, ${desired.meters.length} meters carrying ${meteredPrices} metered prices ` +
    `(per started block of ${OVERAGE_BLOCK_UNITS}), no trial`
  );
}

export function parseArgs(argv: readonly string[]): { dryRun: boolean; full: boolean } | { error: string } {
  const known = new Set(["--dry-run", "--full"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return { error: `Unknown argument(s): ${unknown.join(" ")}\nUsage: stripe-setup.ts [--dry-run] [--full]` };
  }
  return { dryRun: argv.includes("--dry-run"), full: argv.includes("--full") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  const { dryRun, full } = args;

  // Computed before touching the key so a catalog problem (a package selling
  // a channel with no overage rate, or a rate that is not whole cents) fails
  // in a dry run too — it is a catalog problem, not a Stripe one.
  const desired = computeDesired();

  if (dryRun) {
    console.log(`healdesk → Stripe (dry run)\n${summaryLine(desired)}\n`);
    printDryRun(desired, { full });
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
  // The SDK retries network errors, conflicts and 5xx itself, with an
  // idempotency key; withRateLimitRetry adds the 429s it does not.
  const stripe = new Stripe(key, { maxNetworkRetries: 2 });

  console.log(`healdesk → Stripe (${live ? "LIVE" : "test"} mode)\n${summaryLine(desired)}\n`);

  const [products, prices, meters, coupons] = await Promise.all([
    listActiveProducts(stripe),
    listOurPrices(stripe),
    listActiveMeters(stripe),
    listCoupons(stripe),
  ]);
  const run: Run = {
    stripe,
    throttle: new Throttle(REQUESTS_PER_SECOND),
    runId: randomUUID(),
    full,
    products,
    activePrices: prices.active,
    inactivePrices: prices.inactive,
    coupons,
  };

  for (const pkg of desired.packages) {
    await syncPackage(run, pkg);
  }
  for (const meter of desired.meters) {
    await syncMeter(run, meters, meter);
  }
  await syncPlaceholder(run, desired.placeholder);
  reportStale(run, desired);

  console.log(
    `\n${tally.created} created, ${tally.verified} verified, ${tally.updated} updated, ` +
      `${tally.archived} archived, ${tally.drift} drifted, ${tally.stale} stale.`,
  );
  printNext(live);

  if (tally.drift > 0) {
    console.error(
      `${tally.drift} object(s) disagree with the catalog. Nothing was changed ` +
        `for them; resolve by hand (archive the wrong price or delete the wrong ` +
        `coupon, re-run) and never by editing the catalog to match Stripe.`,
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
