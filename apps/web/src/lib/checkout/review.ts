import {
  additionalLocationChargeUsd,
  type BillingInterval,
  channelList,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
  planStartSentence,
  regimeFor,
  type SpecialtyId,
} from "@healdesk/catalog";

import { overageBlockPrices, usd } from "@/lib/pricing";

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

/** "Today: $997 setup fee", and what it pays for. */
export function setupFeeToday(plan: Plan, creditUsd = 0): { headline: string; covers: string } {
  return {
    headline: `Today: ${usd.format(plan.setupFeeUsd - creditUsd)} setup fee`,
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

/** "Included each month: 1,000 voice minutes and 1,000 chat conversations." */
export function includedLine(plan: Plan): string {
  const parts: string[] = [];
  if (plan.includedVoiceMinutes > 0)
    parts.push(`${count(plan.includedVoiceMinutes)} voice minutes`);
  if (plan.includedChatConversations > 0) {
    parts.push(`${count(plan.includedChatConversations)} chat conversations`);
  }
  return `Included each month: ${parts.join(" and ")}.`;
}

/**
 * Past the allowance: the package's own price for each started block of 100
 * extra minutes or conversations, which is how overage is billed since the
 * owner's decision of 6 October 2026 (docs/v1-product-spec.md, "Overage
 * prices"), said to be provisional because it is (CLAUDE.md, "Claims and
 * copy"). The block and its price are the catalog's (`overageBlockPrices`),
 * never a per-unit rate. While the rates are held back nothing is billed past
 * the allowance, and the line says that instead.
 */
export function overageSentence(plan: Plan, interval: BillingInterval): string {
  if (OVERAGE_RATES_PROVISIONAL) {
    return "Past that, nothing is billed until we publish the rates, and you'll see them in writing before they apply.";
  }
  const blocks = overageBlockPrices(plan).map(
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
 * What happens when the allowance runs out, for the channels this package
 * has: the usage alerts, and Billing's "Stop and fall back", worded for
 * each channel the way the portal's switch works (v1 spec, "Every switch in
 * the portal").
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
    "We email you at 80% and at 100% of your allowance. If you'd rather stop there than pay for more, " +
    `set Billing to Stop and fall back: past the allowance, ${said}.`
  );
}

export const SALES_TAX_LINE = "Plus sales tax where it applies.";

/** "This sets up one location. Add more from Billing after setup: $897/mo + $997 setup fee each." */
export function locationsLine(plan: Plan, interval: BillingInterval): string {
  const extra = additionalLocationChargeUsd(plan, interval);
  const per = interval === "year" ? "/yr" : "/mo";
  return (
    "This sets up one location. Add more from Billing after setup: " +
    `${usd.format(extra.recurringUsd)}${per} + ${usd.format(extra.setupFeeUsd)} setup fee each.`
  );
}

/** The button: the setup fee alone, which is all that is charged today. */
export function payLabel(plan: Plan, creditUsd = 0): string {
  return `Pay ${usd.format(plan.setupFeeUsd - creditUsd)} and start setup`;
}
