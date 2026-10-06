/**
 * Billing packages.
 *
 * Seven packages, priced by CHANNEL rather than by minutes alone, because the
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
 * ## Overage rates are still unmeasured, and no longer uniform
 *
 * The owner re-set them on 5 October 2026: $0.80 a voice minute everywhere,
 * $0.40 a chat conversation on the single-channel chat packages and $0.30 on
 * every package that sells two or more channels. They replace the $0.35 and
 * $0.25 signed off on 21 September 2026, and they are still a judgement, not
 * a measurement. The spec (docs/v1-product-spec.md → "Unit economics and
 * infrastructure" → "What still has to be computed") asks for overage to be
 * set from measured cost times a target margin, and nothing has been measured
 * yet: voice costs roughly $0.13 to $0.31 a minute all in, plus about a penny
 * a minute for redaction, and chat cost per conversation is still the
 * product's largest unknown. Any copy that prints these rates must say they
 * are provisional, and the pilot (launch plan 3.5) is what replaces them.
 *
 * The chat rate now DIFFERS BY PACKAGE, which the billing layer has to carry.
 * A single metered price per meter cannot bill two rates, so a metered price
 * is keyed by its rate — `meterPriceLookupKey()` below — and a package asks
 * for the price that matches its own. One meter per channel still, because
 * the meter is the event stream and the app sends one event per unit however
 * the clinic is priced.
 *
 * `OVERAGE_RATES_PROVISIONAL` still stays false, on purpose. The flag does
 * more than change what the page displays. While it is true,
 * `meteredLookupKeysFor()` in apps/web/src/lib/billing.ts attaches no metered
 * price to a monthly checkout. The terms also replace their overage sentence
 * with "Until those rates are published, usage above the allowance is not
 * billed." Flipping it would change what Stripe bills and what the service
 * agreement says. That is a billing and counsel decision, not a copy one.
 * Until someone makes it, false means: the pricing page prints these numbers,
 * the terms name them, and a MONTHLY checkout attaches the two metered prices.
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
 * anyone measured a real conversation, and cut on 5 October 2026 — chat from
 * 1,500/3,000/1,500/4,000 to 1,000/2,000/1,000/2,000, and the top tier's
 * voice from 1,500 minutes to 1,000, so every voice package now includes the
 * same 1,000. The spec asks for each package to be modelled three ways: light
 * use, expected use, and the allowance fully used. The third matters most,
 * because it is the worst case the pricing promises, and it is the one the
 * cut moves: a smaller allowance lowers the worst case and raises how often
 * overage bills, which is why the overage rate and the allowance were changed
 * together. The spec also names chat cost per conversation as the product's
 * largest unknown, so these are still unmeasured numbers.
 * They are not part of the Stripe lookup keys, so changing one needs no
 * `stripe:setup` re-run.
 *
 * ## WhatsApp starts costing the clinic on 1 October 2026
 *
 * Every package that includes `meta` includes WhatsApp, and its conversations
 * count against `includedChatConversations` like any other chat. The packages
 * were priced when inbound Meta conversations were free. From 1 October 2026
 * Meta also charges for WhatsApp service replies inside the 24-hour window,
 * and it bills the clinic directly. Healdesk does not resell WhatsApp messages
 * (docs/v1-product-spec.md → "Pricing consequences" and "Meta bot
 * onboarding"). Nobody has pulled Meta's published rate yet, and nothing here
 * counts billable WhatsApp messages per clinic. Both are needed before the
 * pricing page ships.
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
 * ## Seven packages, five cards
 *
 * Two price points sell either website chat or the Meta bot, the buyer's
 * pick: $397 for chat alone and $897 with the phone. Since 5 October 2026
 * each pick is its own package — Web Chatbot and Meta Chatbot, Web + Voice
 * and Meta + Voice — with its own Stripe product, rather than one package
 * carrying a separate "which chat channel" field. The package id alone then
 * says which channels a clinic has, so nothing can disagree with it: a switch
 * between the two in Stripe's Customer Portal is a plan change like any
 * other, where a field beside the plan would have kept the old channel. The
 * twins are priced identically (plans.test.ts holds them to it), and the
 * pricing page still shows five cards; `pricingCards` groups each pair into
 * one, and checkout's chat-channel question picks the package within it.
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
};

/**
 * Whether checkout leaves the metered overage prices off and the terms say
 * overage is not billed. It is NOT a "these rates are final" flag: the rates
 * below are placeholders either way. See the header for why it stays false.
 */
export const OVERAGE_RATES_PROVISIONAL = false;

/**
 * Owner-set 5 October 2026, unmeasured. Voice is one rate everywhere; chat is
 * cheaper the more channels the package sells, so it is named per tier rather
 * than shared. See the header.
 */
const VOICE_OVERAGE = 0.8;
const CHAT_OVERAGE_SINGLE_CHANNEL = 0.4;
const CHAT_OVERAGE_MULTI_CHANNEL = 0.3;

/**
 * The founding-cohort setup credit — kept, by decision of 21 September 2026.
 *
 * Offered in the Day 7 nurture email and honoured at checkout as one Stripe
 * coupon per package whose `amount_off` is that package's own setup fee, so
 * the credit IS the fee ($497 for the single-channel chat packages, $997 for
 * the rest) and the subscription is untouched. The copy therefore says "the
 * setup fee in full" and quotes the range, never one round number that is
 * right for some packages and wrong for the others. It is valid for the fourteen
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
    id: "chat-web",
    name: "Web Chatbot",
    channels: { web: true, meta: false, voice: false },
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
    id: "chat-meta",
    name: "Meta Chatbot",
    channels: { web: false, meta: true, voice: false },
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
    monthlyUsd: 597,
    annualMonthlyUsd: 477,
    setupFeeUsd: 997,
    includedVoiceMinutes: 0,
    includedChatConversations: 2_000,
    overagePerVoiceMinuteUsd: 0,
    overagePerChatConversationUsd: CHAT_OVERAGE_MULTI_CHANNEL,
    locations: 1,
  },
  {
    id: "web-voice",
    name: "Web + Voice",
    channels: { web: true, meta: false, voice: true },
    monthlyUsd: 897,
    annualMonthlyUsd: 717,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 1_000,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: CHAT_OVERAGE_MULTI_CHANNEL,
    locations: 1,
  },
  {
    id: "meta-voice",
    name: "Meta + Voice",
    channels: { web: false, meta: true, voice: true },
    monthlyUsd: 897,
    annualMonthlyUsd: 717,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 1_000,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: CHAT_OVERAGE_MULTI_CHANNEL,
    locations: 1,
  },
  {
    id: "complete",
    name: "Complete FrontDesk AI",
    channels: { web: true, meta: true, voice: true },
    monthlyUsd: 1_197,
    annualMonthlyUsd: 957,
    setupFeeUsd: 997,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 2_000,
    overagePerVoiceMinuteUsd: VOICE_OVERAGE,
    overagePerChatConversationUsd: CHAT_OVERAGE_MULTI_CHANNEL,
    locations: 1,
  },
] as const;

export function getPlan(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export function isPlanId(id: unknown): id is string {
  return typeof id === "string" && plans.some((p) => p.id === id);
}

/** The chat channel a buyer picks on a card that sells one or the other. */
export type ChatChannel = Exclude<Channel, "voice">;

export function isChatChannel(value: unknown): value is ChatChannel {
  return value === "web" || value === "meta";
}

/**
 * One card on the pricing page and in checkout: a package, or a pair of
 * packages that differ only in which chat channel they include.
 *
 * The pair is offered as one card ("Web OR Meta Chatbot") because the buyer
 * is choosing a price point first and a channel second, and two cards with
 * the same price and the same allowances read as a mistake. A card's id is
 * what a `?plan=` link may carry, alongside a package id; the two twin cards
 * keep the ids their packages had before the split, so links already sent
 * still land on the right card. A card id is never stored and never reaches
 * Stripe or apps/app: checkout resolves it to a package with
 * `planForCard()` first.
 */
export type PricingCard = {
  id: string;
  name: string;
  /** One package, or two: the web twin first, then the Meta twin. */
  planIds: readonly [string] | readonly [string, string];
  highlight?: string;
};

export const pricingCards: readonly PricingCard[] = [
  { id: "chat-single", name: "Web OR Meta Chatbot", planIds: ["chat-web", "chat-meta"] },
  { id: "voice", name: "AI Voice Agent Alone", planIds: ["voice"] },
  { id: "chat-dual", name: "Web + Meta Chatbot", planIds: ["chat-dual"] },
  {
    id: "chat-voice",
    name: "Web OR Meta + Voice",
    planIds: ["web-voice", "meta-voice"],
    highlight: "Most clinics",
  },
  { id: "complete", name: "Complete FrontDesk AI", planIds: ["complete"] },
] as const;

export function getPricingCard(id: string): PricingCard | undefined {
  return pricingCards.find((c) => c.id === id);
}

/** The card a package is sold from. Every package is on exactly one. */
export function cardForPlan(plan: Plan): PricingCard {
  const card = pricingCards.find((c) => c.planIds.includes(plan.id));
  if (!card) throw new Error(`Package ${plan.id} is on no pricing card.`);
  return card;
}

/** Whether the buyer picks website chat or the Meta bot on this card. */
export function offersChatChoice(card: PricingCard): boolean {
  return card.planIds.length === 2;
}

/**
 * The package a card sells, given the chat channel picked. A card without the
 * choice ignores `chat`; one with it defaults to the website, which goes live
 * without waiting on anything from Meta.
 */
export function planForCard(card: PricingCard, chat: ChatChannel = "web"): Plan {
  const id = card.planIds.length === 2 && chat === "meta" ? card.planIds[1] : card.planIds[0];
  const plan = getPlan(id);
  if (!plan) throw new Error(`Pricing card ${card.id} names unknown package ${id}.`);
  return plan;
}

/**
 * The chat channel a package stands for on its card: `meta` for the Meta twin
 * of a pair, `web` for everything else.
 */
export function chatChannelOf(plan: Plan): ChatChannel {
  return plan.channels.meta && !plan.channels.web ? "meta" : "web";
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
 * Whether the Meta channel may be bought as a clinic's only channel.
 *
 * Until Meta's App Review of the messaging permissions passes, Instagram,
 * Messenger and WhatsApp cannot answer a clinic's patients
 * (docs/v1-product-spec.md, "External gates on the launch date"), so a
 * clinic that bought Meta Chatbot alone would pay for a package with no
 * channel that can go live. This was false for that reason. The owner set it
 * true on 5 October 2026, ahead of App Review: no marketing has launched, so
 * nobody is expected to buy before approval, and Meta Chatbot is on sale
 * from the first day there is anyone to sell it to. If App Review slips past
 * the first campaign, set it back to false: checkout reads it with
 * `sellsMetaAlone()`, in the UI and again in /api/checkout, which then
 * refuses the package.
 */
export const META_SOLD_ALONE = true;

/** True when Meta is the package's only channel. Today that is Meta Chatbot. */
export function sellsMetaAlone(plan: Plan): boolean {
  return plan.channels.meta && !plan.channels.web && !plan.channels.voice;
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
 * The two account-wide meters: one event stream per channel, shared by every
 * package. The app sends one event per unit consumed whatever the clinic pays,
 * so the meter never varies — only the price attached to the subscription does.
 *
 * A meter can carry SEVERAL metered prices, one per distinct rate, and that is
 * how divergent overage is billed since 5 October 2026: `meterPriceLookupKey()`
 * puts the rate in the key, `stripe:setup` creates one price per rate actually
 * used, and `overageLookupKeys()` in apps/web/src/lib/billing.ts asks for the
 * one matching the package. Stripe's own price tiers were the other option and
 * are not used: tiers bill by VOLUME within one subscription, and what varies
 * here is the package, not the volume.
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

export type Meter = (typeof METERS)[keyof typeof METERS];

/**
 * The lookup key of the metered price that bills `rateUsd` on `meter`.
 *
 * The rate is in the key, in whole cents, for the same reason the package
 * keys carry their amount (`stripeLookupKey`): a rate change produces a new
 * key, so it is a new price, and nothing can silently keep billing the old
 * one. A fractional-cent rate would not survive the rounding, so it is
 * refused here rather than mis-keyed — `unit_amount_decimal` could carry it,
 * but two rates a hundredth of a cent apart would collide in one key.
 */
export function meterPriceLookupKey(meter: Meter, rateUsd: number): string {
  const cents = rateUsd * 100;
  if (!Number.isInteger(Math.round(cents * 1e6) / 1e6) || cents <= 0) {
    throw new Error(
      `Overage rate $${rateUsd} for ${meter.eventName} must be a positive whole number of cents.`,
    );
  }
  return `${meter.lookupKeyPrefix}_${Math.round(cents)}`;
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
