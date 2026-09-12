/**
 * Billing packages.
 *
 * Five packages, priced by CHANNEL rather than by minutes alone, because the
 * cost driver differs per channel: voice minutes are metered by the vendor,
 * chat conversations are metered by LLM tokens. Each package therefore carries
 * two allowances and two overage rates, and a package with no voice has a zero
 * voice allowance rather than a missing one — `0` is a fact the UI can render,
 * `undefined` is a bug waiting to be coerced.
 *
 * ## The setup fee is real and charged on the first invoice
 *
 * An earlier version of this file priced three plans with `setupFeeUsd: 0` and
 * a 14-day trial, and argued the free setup was the wedge. That argument is
 * gone with the pricing that replaced it: provisioning builds a voice agent,
 * allocates a number and runs a QA pass before the clinic sees anything, and
 * the setup fee is what pays for that work. A trial and a setup fee do not
 * compose — either nobody is provisioned for fourteen days or the agent ships
 * before a dollar clears — so there is no trial, and the trial-length constant
 * the old catalog exported is gone with it.
 *
 * ## Annual pricing is a flat 20% off, stated per month
 *
 * The pricing table quotes the annual option as a per-month figure ("$317/mo
 * billed annually"). `annualMonthlyUsd` is that number; the annual invoice is
 * `annualMonthlyUsd * 12`, computed by `annualTotalUsd()` so the multiplication
 * lives in one place and the site cannot quote $3,804 while Stripe charges
 * $3,800.
 *
 * ## Overage rates are PROVISIONAL
 *
 * The pricing table set the packages and the included allowances but not the
 * per-unit overage. The rates below are placeholders chosen to sit above the
 * vendor cost with a margin, and they are marked so the pricing page can say
 * the rate is published before the first bill rather than print a number
 * nobody signed off. While the flag is true, checkout attaches NO metered
 * price to the subscription (apps/web/src/lib/billing.ts), so overage is not
 * merely unquoted, it is unbilled — the page says exactly that. Replace the
 * rates and flip `OVERAGE_RATES_PROVISIONAL` to false once the Synthflow
 * per-minute cost and the LLM cost per conversation are known; flipping it
 * also requires deciding how an ANNUAL subscription bills monthly overage
 * (the metered prices are monthly, the annual package price is yearly), and
 * annual checkout refuses until that decision is made.
 *
 * ## The setup-fee delta on an upgrade is owed, not yet invoiced
 *
 * `setupFeeDeltaUsd()` says what an upgrading clinic owes. Nothing invoices it:
 * plan changes come through Stripe's Customer Portal, which swaps the
 * recurring price and nothing else, and no code creates the one-off invoice
 * item for the difference. Until that is built the delta is collected by hand
 * (docs/handover.md), and the pricing page makes no promise about it either
 * way.
 *
 * See docs/launch-plan.md → "Pricing and unit economics".
 */

export type Channel = "web" | "meta" | "voice";

export type BillingInterval = "month" | "year";

export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

export type Plan = {
  id: string;
  name: string;
  /**
   * Channels the package includes. `meta` covers Instagram DM, Facebook
   * Messenger and WhatsApp together — they share one Meta Business connection
   * and one set of platform terms, so they are sold as one channel.
   */
  channels: { web: boolean; meta: boolean; voice: boolean };
  /**
   * True when the package includes ONE of web or meta and the buyer chooses
   * which at onboarding ("Web OR Meta"). `channels` then lists both as
   * available and provisioning enables only the one chosen.
   */
  chatChannelChoice: boolean;
  monthlyUsd: number;
  /** Per-month price when billed annually. The annual invoice is 12× this. */
  annualMonthlyUsd: number;
  /** One-time, on the first invoice only. Never recurring. */
  setupFeeUsd: number;
  /** Per month. 0 when the package has no voice channel. */
  includedVoiceMinutes: number;
  /** Per month. 0 when the package has no chat channel. */
  includedChatConversations: number;
  overagePerVoiceMinuteUsd: number;
  overagePerChatConversationUsd: number;
  /** Locations covered before the next tier or an add-on is needed. */
  locations: number;
  highlight?: string;
};

/** See the header. Flip to false when the rates below are signed off. */
export const OVERAGE_RATES_PROVISIONAL = true;

const VOICE_OVERAGE = 0.35;
const CHAT_OVERAGE = 0.25;

export const plans: readonly Plan[] = [
  {
    id: "chat-single",
    name: "Web OR Meta Chatbot",
    channels: { web: true, meta: true, voice: false },
    chatChannelChoice: true,
    monthlyUsd: 397,
    annualMonthlyUsd: 317,
    setupFeeUsd: 497,
    includedVoiceMinutes: 0,
    includedChatConversations: 1_500,
    overagePerVoiceMinuteUsd: 0,
    overagePerChatConversationUsd: CHAT_OVERAGE,
    locations: 1,
  },
  {
    id: "voice",
    name: "AI Voice Agent Alone",
    channels: { web: false, meta: false, voice: true },
    chatChannelChoice: false,
    monthlyUsd: 797,
    annualMonthlyUsd: 637,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 0,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: 0,
    locations: 1,
  },
  {
    id: "chat-dual",
    name: "Web + Meta Chatbot",
    channels: { web: true, meta: true, voice: false },
    chatChannelChoice: false,
    monthlyUsd: 597,
    annualMonthlyUsd: 477,
    setupFeeUsd: 997,
    includedVoiceMinutes: 0,
    includedChatConversations: 3_000,
    overagePerVoiceMinuteUsd: 0,
    overagePerChatConversationUsd: CHAT_OVERAGE,
    locations: 1,
  },
  {
    id: "chat-voice",
    name: "Web OR Meta + Voice",
    channels: { web: true, meta: true, voice: true },
    chatChannelChoice: true,
    monthlyUsd: 897,
    annualMonthlyUsd: 717,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 1_500,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: CHAT_OVERAGE,
    locations: 1,
    highlight: "Most clinics",
  },
  {
    id: "complete",
    name: "Complete FrontDesk AI",
    channels: { web: true, meta: true, voice: true },
    chatChannelChoice: false,
    monthlyUsd: 1_197,
    annualMonthlyUsd: 957,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_500,
    includedChatConversations: 4_000,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: CHAT_OVERAGE,
    locations: 1,
  },
] as const;

export function getPlan(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export function isPlanId(id: unknown): id is string {
  return typeof id === "string" && plans.some((p) => p.id === id);
}

/** The recurring amount for one billing period, in whole dollars. */
export function recurringUsd(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? annualTotalUsd(plan) : plan.monthlyUsd;
}

/** The annual invoice amount. Exactly 12 × the quoted per-month annual price. */
export function annualTotalUsd(plan: Plan): number {
  return plan.annualMonthlyUsd * 12;
}

/** What the buyer pays on day one: first period plus the setup fee. */
export function firstInvoiceUsd(plan: Plan, interval: BillingInterval): number {
  return recurringUsd(plan, interval) + plan.setupFeeUsd;
}

/**
 * Setup fee owed on an upgrade: the difference between what was already paid
 * and the new package's fee, never negative. $497 paid → $997 package = $500;
 * $997 → $997 = $0. Downgrades never refund a setup fee.
 *
 * OWED, not charged: no caller invoices this yet — see the header.
 */
export function setupFeeDeltaUsd(from: Plan, to: Plan): number {
  return Math.max(0, to.setupFeeUsd - from.setupFeeUsd);
}

export function channelList(plan: Plan): Channel[] {
  const out: Channel[] = [];
  if (plan.channels.web) out.push("web");
  if (plan.channels.meta) out.push("meta");
  if (plan.channels.voice) out.push("voice");
  return out;
}

/**
 * Stripe price lookup keys.
 *
 * The key encodes the amount, so a catalog price change cannot silently resolve
 * to an old Stripe price: it fails loudly until `stripe:setup` has been re-run.
 * The interval is in the key too, because monthly and annual are different
 * prices on the same product and a key without it would find whichever was
 * created first.
 */
export type PriceKind = "month" | "year" | "setup";

export function stripeLookupKey(plan: Plan, kind: PriceKind): string {
  const cents =
    kind === "setup"
      ? plan.setupFeeUsd * 100
      : recurringUsd(plan, kind) * 100;
  return `healdesk_${plan.id}_${kind}_${cents}`;
}

/**
 * The two account-wide metered prices. One meter and one price each, shared by
 * every package; the per-package overage rate is applied by the meter's price
 * tiers in Stripe, seeded by `stripe:setup` from the rates above.
 */
export const METERS = {
  voiceMinutes: {
    eventName: "healdesk_voice_minutes",
    displayName: "Voice minutes over allowance",
    lookupKey: "healdesk_meter_voice_minutes",
  },
  chatConversations: {
    eventName: "healdesk_chat_conversations",
    displayName: "Chat conversations over allowance",
    lookupKey: "healdesk_meter_chat_conversations",
  },
} as const;

/**
 * What a clinic is displacing, for the comparison on the pricing page.
 * Sourced ranges, not invented — see docs/launch-plan.md.
 */
export const ALTERNATIVES = {
  inHouseReceptionistMonthlyUsd: [3_900, 4_830] as const,
  answeringServiceMonthlyUsd: [400, 1_500] as const,
} as const;
