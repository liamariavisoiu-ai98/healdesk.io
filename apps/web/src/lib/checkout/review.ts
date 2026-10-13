import {
  additionalLocationChargeUsd,
  type BillingInterval,
  channelList,
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  OVERAGE_BLOCK_UNITS,
  type Plan,
  planMeteredPrices,
  planStartSentence,
  regimeFor,
  type SetupCredit,
  setupAfterCreditUsd,
  SELF_SERVE_DEMO_SETUP_CREDIT,
  SITE_SETUP_CREDIT,
  type SpecialtyId,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";

import { usd } from "@/lib/pricing";

/**
 * What Review and pay says, in the order it says it (plan Part A3, step 4),
 * as plain strings a test can read. Every figure comes from the catalog, the
 * same one Stripe's line items and the Terms are built from.
 *
 * No line here says when a channel will answer. How each one goes live is
 * the package step's business, and when is nobody's before purchase (the
 * owner's rule of 6 October 2026).
 */

/** "patient", or "client" for a practice whose patients are animals. */
export function audienceFor(specialty: SpecialtyId | null): "patient" | "client" {
  return specialty !== null && regimeFor(specialty) === "non-hipaa" ? "client" : "patient";
}

// -----------------------------------------------------------------------------
// The setup offer
// -----------------------------------------------------------------------------

/**
 * The setup-fee discounts the funnel can show, strongest first (owner,
 * 13 October 2026). Only one ever applies:
 *
 *   cohort  the setup credit the Day 7 email offered: the fee in full, for
 *           fourteen days, tied to the lead it was sent to;
 *   demo    50% off, for 48 hours from the personalised demo the clinic asked
 *           to be sent being ready (lib/demo/sessions.ts, `demoOfferEndsAt`);
 *   site    30% off, for 48 hours from the website first showing it, held in
 *           a signed cookie (lib/site-offer.ts).
 *
 * The funnel shows the offer; /api/checkout decides it, from the lead row,
 * the demo row and the signed cookie, never from anything the browser says.
 * So the figure here is the catalog's own (`setupAfterCreditUsd`, rounded up
 * to whole dollars), the one the Stripe coupon is built from, and the page
 * and Stripe agree to the dollar.
 */
export type SetupOfferKind = "cohort" | "demo" | "site";

export const SETUP_OFFER_KINDS: readonly SetupOfferKind[] = ["cohort", "demo", "site"];

export type SetupOffer = {
  kind: SetupOfferKind;
  /** ISO time the offer ends. */
  endsAt: string;
  /**
   * A demo offer's share: 50 from an operator's demo (the default), 30 from a
   * homepage one (lib/demo/sessions.ts `demoSetupCredit`). Ignored on the
   * other kinds, whose share is fixed.
   */
  percentOfSetupFee?: number;
};

export const SETUP_OFFER_CREDITS: Readonly<Record<SetupOfferKind, SetupCredit>> = {
  cohort: COHORT_SETUP_CREDIT,
  demo: DEMO_SETUP_CREDIT,
  site: SITE_SETUP_CREDIT,
};

/** The catalog credit an offer is, so the figure shown is the one Stripe's coupon takes. */
export function offerCredit(offer: SetupOffer): SetupCredit {
  return offer.kind === "demo" && offer.percentOfSetupFee === SELF_SERVE_DEMO_SETUP_CREDIT.percentOfSetupFee
    ? SELF_SERVE_DEMO_SETUP_CREDIT
    : SETUP_OFFER_CREDITS[offer.kind];
}

export function isSetupOffer(value: unknown): value is SetupOffer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    SETUP_OFFER_KINDS.includes(v.kind as SetupOfferKind) &&
    typeof v.endsAt === "string" &&
    Number.isFinite(Date.parse(v.endsAt))
  );
}

/** The offer while it holds, or null once its clock has run out. */
export function liveOffer(
  offer: SetupOffer | null | undefined,
  now: number = Date.now(),
): SetupOffer | null {
  return offer && isSetupOffer(offer) && Date.parse(offer.endsAt) > now ? offer : null;
}

/** The one offer to show: the strongest of those still live, cohort over demo over site. */
export function strongestOffer(
  offers: readonly (SetupOffer | null | undefined)[],
  now: number = Date.now(),
): SetupOffer | null {
  const live = offers.map((offer) => liveOffer(offer, now)).filter((o) => o !== null);
  for (const kind of SETUP_OFFER_KINDS) {
    const found = live.find((offer) => offer.kind === kind);
    if (found) return found;
  }
  return null;
}

/** What the setup fee comes to under the offer, in whole dollars: the list fee without one. */
export function setupDueUsd(plan: Pick<Plan, "setupFeeUsd">, offer: SetupOffer | null = null): number {
  return offer ? setupAfterCreditUsd(plan, offerCredit(offer)) : plan.setupFeeUsd;
}

/** The headline of an offer: "30% off your setup fee", or the cohort credit's "the setup fee in full". */
export function offerHeadline(offer: SetupOffer): string {
  const percent = offerCredit(offer).percentOfSetupFee;
  return percent >= 100 ? "Your setup fee, in full, is on us" : `${percent}% off your setup fee`;
}

/** Where the offer comes from, said once beside the reduced figure. */
export function offerSource(offer: SetupOffer): string {
  switch (offer.kind) {
    case "cohort":
      return "Your setup credit.";
    case "demo":
      return "Your demo offer.";
    case "site":
      return "Our website offer.";
  }
}

/** The line under today's figure: "$1,394 less $418: 30% off setup. Our website offer." */
export function offerLine(plan: Pick<Plan, "setupFeeUsd">, offer: SetupOffer): string {
  const credit = plan.setupFeeUsd - setupDueUsd(plan, offer);
  const percent = offerCredit(offer).percentOfSetupFee;
  const what = percent >= 100 ? "the setup fee in full" : `${percent}% off setup`;
  return `${usd.format(plan.setupFeeUsd)} less ${usd.format(credit)}: ${what}. ${offerSource(offer)}`;
}

/** "Today: $976 setup fee", and what it pays for. */
export function setupFeeToday(
  plan: Plan,
  offer: SetupOffer | null = null,
): { headline: string; covers: string } {
  return {
    headline: `Today: ${usd.format(setupDueUsd(plan, offer))} setup fee`,
    covers: "It pays for building, configuring and testing your AYA, and it is never refunded.",
  };
}

/** The catalog's sentence, the one Stripe's page, the welcome email and the Terms print too. */
export function planStartLine(
  plan: Plan,
  interval: BillingInterval,
  specialty: SpecialtyId | null,
): string {
  return planStartSentence(plan, interval, audienceFor(specialty));
}

/** Only for a package with more than one channel: what is billed while some of them are not in service yet. */
export function channelsInServiceLine(plan: Plan, interval: BillingInterval): string | null {
  if (channelList(plan).length < 2) return null;
  const price = interval === "year" ? "annual price" : "monthly price";
  return `Until every channel in your package is in service, your ${price} is the price of the channels that are.`;
}

const count = (n: number) => n.toLocaleString("en-US");

/** "Included each month: 500 voice minutes and 300 chat conversations." The plan's steps. */
export function includedLine(plan: Plan): string {
  const parts: string[] = [];
  if (plan.includedVoiceMinutes > 0)
    parts.push(`${count(plan.includedVoiceMinutes)} voice minutes`);
  if (plan.includedChatConversations > 0) {
    parts.push(`${count(plan.includedChatConversations)} chat conversations`);
  }
  return `Included each month: ${parts.join(" and ")}.`;
}

/** What a meter counts, in a sentence. */
const METER_WORDS = { voiceMinutes: "voice minutes", chatConversations: "chat conversations" } as const;

const blockPrice = (cents: number) =>
  cents % 100 === 0
    ? usd.format(cents / 100)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * The plan's price for one started block of 100 extra units on each meter it
 * bills, voice first: "$104" a block of voice minutes, "$52" or "$78" a block
 * of chat conversations. From `planMeteredPrices`, the function that picks
 * the metered prices Stripe bills, so the funnel cannot print a price Stripe
 * does not charge.
 */
export function extraBlockPrices(
  plan: Plan,
): { meter: keyof typeof METER_WORDS; price: string; unitsLong: string }[] {
  return planMeteredPrices(plan).map(({ meter, blockCents }) => ({
    meter,
    price: blockPrice(blockCents),
    unitsLong: METER_WORDS[meter],
  }));
}

/**
 * Past the allowance: the package's own price for each started block of 100
 * extra minutes or conversations, which is how overage is billed (owner,
 * 6 October 2026; the prices are the sheet of 13 October), said to be
 * provisional because it is (CLAUDE.md, "Claims and copy"). The block and its
 * price, never a per-unit rate.
 */
export function overageSentence(plan: Plan, interval: BillingInterval): string {
  const blocks = extraBlockPrices(plan).map(
    (block) =>
      `${block.price} for each started block of ${OVERAGE_BLOCK_UNITS} extra ${block.unitsLong}`,
  );
  const when = interval === "year" ? "invoiced monthly" : "on your next invoice";
  return (
    `Past that: ${blocks.join(" and ")}, ${when}. These rates are provisional until we have ` +
    "measured what a minute and a conversation cost to serve."
  );
}

/**
 * What happens as the allowance runs out, for the channels this package
 * has: the email at 90% (the pricing sheet of 13 October 2026), the choice it
 * offers, and Billing's "Stop and fall back", worded for each channel the way
 * the portal's switch works (v1 spec, "Every switch in the portal").
 */
export function runOutLine(plan: Plan): string {
  const fallbacks: string[] = [];
  if (plan.channels.voice) fallbacks.push("calls go to your own direct line");
  if (plan.channels.web) fallbacks.push("website chat shows a contact form");
  if (plan.channels.meta)
    fallbacks.push("Instagram, Messenger and WhatsApp messages wait for your team");
  const last = fallbacks.pop()!;
  const said = fallbacks.length > 0 ? `${fallbacks.join(", ")} and ${last}` : last;
  return (
    `We email you at ${USAGE_ALERT_PERCENT}% of your included amount, so you can move up a step. ` +
    "If you'd rather stop there than pay for more, " +
    `set Billing to Stop and fall back: past the allowance, ${said}.`
  );
}

export const SALES_TAX_LINE = "Plus sales tax where it applies.";

/** "This sets up one location. Add more from Billing after setup: $520/mo + $1,394 setup fee each." */
export function locationsLine(plan: Plan, interval: BillingInterval): string {
  const extra = additionalLocationChargeUsd(plan, interval);
  const per = interval === "year" ? "/yr" : "/mo";
  return (
    "This sets up one location. Add more from Billing after setup: " +
    `${usd.format(extra.recurringUsd)}${per} + ${usd.format(extra.setupFeeUsd)} setup fee each.`
  );
}

/** The button: the setup fee after the offer, which is all that is charged today. */
export function payLabel(plan: Plan, offer: SetupOffer | null = null): string {
  return `Pay ${usd.format(setupDueUsd(plan, offer))} and start setup`;
}
