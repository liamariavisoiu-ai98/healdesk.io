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
 * ## Overage: two meters, two prices, shared by every package
 *
 * Voice minutes and chat conversations over the allowance are billed through
 * Stripe Billing Meters: the app sends a meter event per unit consumed, Stripe
 * sums them per period, and a metered Price attached to the subscription turns
 * the sum into an invoice line. Each meter is keyed by its `event_name`, which
 * is what the app sends, and each metered price by a stable lookup_key. The
 * prices are created here unconditionally; whether Checkout ATTACHES them is
 * decided in apps/web/src/lib/billing.ts, and it does not while the rates are
 * provisional (nor does anything send meter events yet).
 *
 * Every package currently shares one voice rate and one chat rate, so a single
 * per_unit price per meter is enough. That is ASSERTED at runtime rather than
 * assumed: the day a package gets its own rate, this script refuses to run
 * until the metered prices are split per package (tiers or per-package keys),
 * because silently billing the shared rate to a package with a different one
 * is mis-billing with extra steps.
 *
 * ## Idempotent by lookup_key, not by name
 *
 * Every price carries a `lookup_key` from `stripeLookupKey()`, which encodes
 * the plan id, the kind and the amount (`healdesk_chat-voice_month_89700`).
 * Re-running finds the existing price by that key, checks that it still says
 * what the catalog says, and leaves it alone. A catalog price CHANGE produces a
 * new key, so it is a new price; the previous one stays active for the
 * subscriptions already on it and is reported here as STALE so a human can
 * archive it once nobody is billing on it.
 *
 * Nothing here is destructive: nothing is archived, updated or deleted. The
 * one write beyond create is `transfer_lookup_key`, used only when the key is
 * held by an INACTIVE price — Stripe keeps lookup keys unique across prices,
 * so without the transfer an archived price would block its own replacement.
 */

import {
  annualTotalUsd,
  channelList,
  METERS,
  OVERAGE_RATES_PROVISIONAL,
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

type DesiredMeter = {
  eventName: string;
  displayName: string;
  lookupKey: string;
  /** Per unit (one minute, one conversation). May be fractional cents. */
  unitCents: number;
  unitLabel: string;
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

  const channelText = plan.chatChannelChoice
    ? `Web OR Meta chat (chosen at onboarding)${plan.channels.voice ? " + AI voice agent" : ""}`
    : [
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

  return (
    `${channelText}. ` +
    `Includes ${allowances.join(" and ")}, ${plural(plan.locations, "location")}. ` +
    `One-time setup fee ${usd(plan.setupFeeUsd * 100)}; ` +
    `usage over the allowance billed at the published overage rate.`
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
 * The single rate shared by every package that has the channel.
 *
 * Throws, rather than picking one, when packages disagree. The catalog's
 * METERS comment says the per-package rate is "applied by the meter's price
 * tiers in Stripe" — that is the design for the day rates diverge, and it is
 * not built. Until it is, the only safe thing a shared metered price can do
 * with divergent rates is refuse.
 */
function sharedOverageCents(
  channel: "voice" | "chat",
  hasChannel: (plan: Plan) => boolean,
  rateOf: (plan: Plan) => number,
): number {
  const rates = new Map<number, string[]>();
  for (const plan of plans) {
    if (!hasChannel(plan)) continue;
    const list = rates.get(rateOf(plan)) ?? [];
    list.push(plan.id);
    rates.set(rateOf(plan), list);
  }
  if (rates.size !== 1) {
    const detail = [...rates]
      .map(([rate, ids]) => `${ids.join(", ")} → $${rate}`)
      .join("; ")
      .replace(/^$/, "no package has this channel");
    throw new Error(
      `Packages do not share one ${channel} overage rate (${detail}). ` +
        `A single metered price per meter cannot bill that: per-package ` +
        `overage tiers are needed before this script can run.`,
    );
  }
  const [rate] = rates.keys();
  return rate! * 100;
}

function computeDesired(): Desired {
  const voiceCents = sharedOverageCents(
    "voice",
    (p) => p.channels.voice,
    (p) => p.overagePerVoiceMinuteUsd,
  );
  const chatCents = sharedOverageCents(
    "chat",
    (p) => p.channels.web || p.channels.meta,
    (p) => p.overagePerChatConversationUsd,
  );

  return {
    packages: plans.map((plan) => ({
      plan,
      productName: `healdesk ${plan.name}`,
      description: describePackage(plan),
      prices: desiredPrices(plan),
    })),
    meters: [
      {
        ...METERS.voiceMinutes,
        unitCents: voiceCents,
        unitLabel: "minute",
      },
      {
        ...METERS.chatConversations,
        unitCents: chatCents,
        unitLabel: "conversation",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Reporting. One line per object, one glyph per outcome, and a non-zero exit
// when anything drifted so a deploy step that runs this cannot shrug it off.
// ---------------------------------------------------------------------------

type Tally = { created: number; verified: number; drift: number; stale: number };

const tally: Tally = { created: 0, verified: 0, drift: 0, stale: 0 };

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

async function findOrCreateProduct(
  stripe: Stripe,
  products: Stripe.Product[],
  metaKey: string,
  metaValue: string,
  params: Omit<Stripe.ProductCreateParams, "metadata">,
): Promise<Stripe.Product> {
  const found = products.find((p) => p.metadata[metaKey] === metaValue);
  if (found) {
    verified(`product  ${found.name.padEnd(36)} ${found.id}`);
    return found;
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
  want: DesiredMeter,
  meterId: string,
): string[] {
  const problems: string[] = [];
  // Metered prices are created with unit_amount_decimal so sub-cent rates are
  // representable; Stripe echoes it back as a Decimal in cents. Compared as
  // decimals, not floats — 35 and "35.0000" are the same amount.
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
      name: `healdesk ${want.displayName}`,
      description: `Billed per ${want.unitLabel} beyond the package allowance, monthly in arrears.`,
    },
  );

  const label = `price  ${want.lookupKey.padEnd(40)} ${usd(want.unitCents)}/${want.unitLabel}`;
  const existing = activePrices.get(want.lookupKey);
  if (existing) {
    const problems = meteredPriceProblems(existing, want, meter.id);
    if (problems.length === 0) verified(`${label}  ${existing.id}`);
    else drift(`${label}  ${existing.id}: ${problems.join("; ")}`);
    return;
  }

  const holder = await inactiveHolder(stripe, want.lookupKey);
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    billing_scheme: "per_unit",
    // Decimal so a rate like $0.035/min is representable; integer cents are a
    // valid decimal too, so this is the one form that covers both.
    unit_amount_decimal: Stripe.Decimal.from(want.unitCents),
    recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    lookup_key: want.lookupKey,
    transfer_lookup_key: holder !== undefined,
    nickname: `${want.displayName} — ${usd(want.unitCents)}/${want.unitLabel}`,
    metadata: { [METER_META]: want.eventName },
  });
  activePrices.set(want.lookupKey, price);
  created(
    `${label}  ${price.id}` +
      (holder ? `  (lookup_key moved off archived ${holder.id})` : ""),
  );
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
    ...desired.meters.map((m) => m.lookupKey),
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
    line("·", `product  healdesk ${m.displayName}  [${METER_META}=${m.eventName}]`);
    line(
      "·",
      `price    ${m.lookupKey.padEnd(40)} ${usd(m.unitCents)}/${m.unitLabel}  recurring/month/metered per_unit`,
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
      `     Events: checkout.session.completed\n` +
      `             checkout.session.async_payment_succeeded\n` +
      `             invoice.paid\n` +
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
      `     ON:  switch plan — limited to the ${plans.length} healdesk products above,\n` +
      `          monthly and annual prices only (never the setup or metered prices)\n` +
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

  // Computed before touching the key so the divergent-rate assertion fires in
  // a dry run too — it is a catalog problem, not a Stripe one.
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
    console.log(`healdesk → Stripe (dry run)\n${plans.length} packages, 2 meters, no trial\n`);
    printDryRun(desired);
    printNext(false);
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set. (Use --dry-run to preview without a key.)");
    process.exit(1);
  }

  const live = key.startsWith("sk_live_");
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
      `${plans.length} packages, 2 meters, no trial\n`,
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
  reportStale(activePrices, desired);

  console.log(
    `\n${tally.created} created, ${tally.verified} verified, ` +
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
