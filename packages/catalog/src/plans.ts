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
 * ## Overage rates are a judgement until measured
 *
 * Past the allowance a package bills $0.80 a voice minute, and $0.40 a chat
 * conversation on the single-channel chat package (`chat-single`) or $0.30 on
 * every other package with chat. The owner set these on 5 October 2026,
 * replacing the $0.35 and $0.25 signed off on 21 September, before any cost
 * had been measured. They are still a judgement, not a measurement: the spec
 * (docs/v1-product-spec.md → "Unit economics and infrastructure" → "What still
 * has to be computed") sets overage prices from measured cost times a target
 * margin, and launch step 3.5 measures that cost on pilot traffic. Retell's
 * own share is about $0.085 to $0.12 a minute before the Claude cost, plus
 * about a penny a minute for redaction. Nobody has measured chat cost per
 * conversation yet. Any copy that prints these rates must say they are
 * provisional.
 *
 * The chat rate differs by package, so one meter carries two prices: Stripe
 * holds three metered prices on two meters (`meteredPriceLookupKey()` below),
 * and checkout gives each subscription the price for its own package's rate.
 * A plan change must therefore swap the metered items as well as the package
 * price; Stripe's Customer Portal cannot update a subscription that carries
 * metered prices at all, so plan changes do not go through it.
 * Every metered key encodes its rate, like the package keys, so a rate change
 * cannot silently bill the old rate: checkout fails loudly until
 * `stripe:setup` has been re-run.
 *
 * `OVERAGE_RATES_PROVISIONAL` still stays false, on purpose. The flag does
 * more than change what the page displays. While it is true,
 * `meteredLookupKeysFor()` in apps/web/src/lib/billing.ts attaches no metered
 * price to a monthly checkout. The terms also replace their overage sentence
 * with "Until those rates are published, usage above the allowance is not
 * billed." Flipping it would change what Stripe bills and what the service
 * agreement says. That is a billing and counsel decision, not a copy one.
 * Until someone makes it, false means: the pricing page prints these numbers,
 * the terms name them, and a MONTHLY checkout attaches its package's metered
 * prices.
 *
 * Two things are still open, and they are recorded in the task list rather
 * than hidden here. First, nothing reports usage to Stripe's meters yet, so the
 * metered lines bill zero until `usage-meter-events` is built. Second, an
 * ANNUAL package attaches no metered price, because Stripe cannot mix a yearly
 * and a monthly price on one subscription. Annual overage is invoiced monthly
 * by hand until `annual-overage-invoicing` is built, which is why the terms
 * say "invoiced separately" for annual packages.
 *
 * ## The allowances are unmeasured too
 *
 * The included voice minutes and chat conversations below were set before
 * anyone measured a real conversation. The owner cut them with the rates on 5
 * October 2026: chat from 1,500 / 3,000 / 1,500 / 4,000 to 1,000 / 2,000 /
 * 1,000 / 2,000 (chat-single, chat-dual, chat-voice, complete), and the top
 * tier's voice from 1,500 minutes to 1,000. The spec asks for each package to
 * be modelled three ways: light use, expected use, and the allowance fully
 * used. The third matters most, because it is the worst case the pricing
 * promises. The spec also names chat cost per conversation as the product's
 * largest unknown: the top tier's 2,000 included conversations cannot be
 * priced until it is measured on real traffic. Change the numbers only after
 * that exercise. They are not part of the Stripe lookup keys, so changing one
 * creates no new price, but re-run `stripe:setup` anyway: it rewrites each
 * Stripe product's description, which states the allowances on Checkout and
 * on the invoice.
 *
 * ## WhatsApp starts costing the clinic on 1 October 2026
 *
 * Every package that includes `meta` includes WhatsApp, and its conversations
 * count against `includedChatConversations` like any other chat. The packages
 * were priced when inbound Meta conversations were free. From 1 October 2026
 * Meta also charges for WhatsApp service replies inside the 24-hour window,
 * and it bills the clinic directly. Healdesk does not resell WhatsApp messages
 * (docs/v1-product-spec.md → "Pricing consequences" and "Meta bot
 * onboarding"). Meta's rate is $0.0034 per delivered service message in North
 * America, after 1,000 free per number each month; nothing here counts
 * billable WhatsApp messages per clinic yet.
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
 * See docs/v1-product-spec.md → "Unit economics and infrastructure".
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
   * Channels the package includes. `meta` is the Meta bot: Instagram DMs,
   * Facebook Messenger and WhatsApp. It is sold as one channel because one
   * Healdesk Meta app serves all three, but the clinic connects it in two
   * steps. One Facebook login connects Instagram and Messenger together.
   * WhatsApp uses Meta's embedded signup, cannot send until the clinic has
   * added its own payment method in Meta, and may go live after the other
   * two. Meta bills the clinic directly for WhatsApp; see the header.
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
  /**
   * Locations the package covers, which is one for every package. The spec
   * sells Healdesk per location, with each extra location billed on the same
   * subscription and renewal date. No additional-location price or lookup key
   * exists yet, so nobody can buy a second location at checkout.
   */
  locations: number;
  highlight?: string;
};

/**
 * Whether checkout leaves the metered overage prices off and the terms say
 * overage is not billed. It is NOT a "these rates are final" flag: the rates
 * below are placeholders either way. See the header for why it stays false.
 */
export const OVERAGE_RATES_PROVISIONAL = false;

// Set by the owner on 5 October 2026; provisional until measured cost times a
// target margin replaces them (see the header). Whole cents only: each rate is
// encoded in its Stripe lookup key.
const VOICE_OVERAGE = 0.8;
const CHAT_OVERAGE_SINGLE_CHANNEL = 0.4;
const CHAT_OVERAGE = 0.3;

/**
 * The founding-cohort setup credit — kept, by decision of 21 September 2026.
 *
 * Offered in the Day 7 nurture email and honoured at checkout as one Stripe
 * coupon per package whose `amount_off` is that package's own setup fee, so
 * the credit IS the fee ($497 for the single-channel chat package, $997 for
 * the rest) and the subscription is untouched. The copy therefore says "the
 * setup fee in full" and quotes the range, never one round number that is
 * right for one package and wrong for four. It is valid for the fourteen
 * days after the email that offers it, tied to the lead it was sent to, and
 * never applied from a URL parameter alone.
 */
export const COHORT_SETUP_CREDIT = {
  /** Stripe coupon id; stripe:setup creates it. */
  couponId: "healdesk-cohort-setup",
  name: "Founding-cohort setup credit",
  /** Days after the offer email during which checkout honours it. */
  validDays: 14,
} as const;

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
    includedChatConversations: 1_000,
    overagePerVoiceMinuteUsd: 0,
    overagePerChatConversationUsd: CHAT_OVERAGE_SINGLE_CHANNEL,
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
    includedChatConversations: 2_000,
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
    includedChatConversations: 1_000,
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
    includedVoiceMinutes: 1_000,
    includedChatConversations: 2_000,
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
 * The two account-wide meters. Each counts one unit past the allowance, by
 * Stripe customer, and backs one metered price per distinct overage rate:
 * today one voice price ($0.80) and two chat prices ($0.40 on the
 * single-channel chat package, $0.30 on the rest). A subscription carries the
 * price for its own package's rate, so the usage reporter sends every event
 * to the meter by `eventName` and never has to know the rate.
 */
export const METERS = {
  voiceMinutes: {
    eventName: "healdesk_voice_minutes",
    displayName: "Voice minutes over allowance",
    lookupKeyPrefix: "healdesk_meter_voice_minutes",
    unitLabel: "minute",
  },
  chatConversations: {
    eventName: "healdesk_chat_conversations",
    displayName: "Chat conversations over allowance",
    lookupKeyPrefix: "healdesk_meter_chat_conversations",
    unitLabel: "conversation",
  },
} as const;

export type MeterId = keyof typeof METERS;

/**
 * An overage rate in whole cents. Throws on a fractional cent, because the
 * cents are written into the price's lookup key and a key like `_3.5` would
 * be a second spelling of an amount the code cannot compare.
 */
export function overageRateCents(rateUsd: number): number {
  const cents = Math.round(rateUsd * 100);
  if (!Number.isFinite(rateUsd) || rateUsd <= 0 || Math.abs(cents - rateUsd * 100) > 1e-6) {
    throw new Error(`Overage rate $${rateUsd} is not a positive whole number of cents.`);
  }
  return cents;
}

/**
 * The lookup key of one metered price: the meter plus the rate in cents, e.g.
 * `healdesk_meter_chat_conversations_30`. The rate is in the key for the same
 * reason the amount is in a package key: a rate change cannot silently resolve
 * to the old price.
 */
export function meteredPriceLookupKey(meter: MeterId, rateUsd: number): string {
  return `${METERS[meter].lookupKeyPrefix}_${overageRateCents(rateUsd)}`;
}

/**
 * The metered prices one package bills: the voice meter at its voice rate when
 * it has voice, the chat meter at its chat rate when it has web or Meta.
 */
export function planMeteredPrices(
  plan: Plan,
): { meter: MeterId; rateUsd: number; lookupKey: string }[] {
  const out: { meter: MeterId; rateUsd: number; lookupKey: string }[] = [];
  if (plan.channels.voice) {
    out.push({
      meter: "voiceMinutes",
      rateUsd: plan.overagePerVoiceMinuteUsd,
      lookupKey: meteredPriceLookupKey("voiceMinutes", plan.overagePerVoiceMinuteUsd),
    });
  }
  if (plan.channels.web || plan.channels.meta) {
    out.push({
      meter: "chatConversations",
      rateUsd: plan.overagePerChatConversationUsd,
      lookupKey: meteredPriceLookupKey(
        "chatConversations",
        plan.overagePerChatConversationUsd,
      ),
    });
  }
  return out;
}

/**
 * What a clinic is displacing, for the comparison on the pricing page.
 * Sourced ranges, not invented — see docs/launch-plan.md.
 */
export const ALTERNATIVES = {
  inHouseReceptionistMonthlyUsd: [3_900, 4_830] as const,
  answeringServiceMonthlyUsd: [400, 1_500] as const,
  /**
   * The U.S. median receptionist wage, for the "why pay this just to keep the
   * phone covered" line on the pricing page. U.S. Bureau of Labor Statistics,
   * Occupational Outlook Handbook, Receptionists: median $38,010 a year and
   * $18.27 an hour in May 2025. Wage only; the loaded range above adds payroll
   * taxes and benefits, which is why the two figures differ and why the page
   * shows both. Update the period and the figures together when BLS publishes
   * the next May release.
   */
  receptionistMedianWage: {
    annualUsd: 38_010,
    hourlyUsd: 18.27,
    period: "May 2025",
    source: "U.S. Bureau of Labor Statistics, Occupational Outlook Handbook",
  },
} as const;
