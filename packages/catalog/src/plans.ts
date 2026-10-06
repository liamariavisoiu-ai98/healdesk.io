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
 * ## Overage rates are a judgement until measured
 *
 * Past the allowance a package bills $0.80 a voice minute, and $0.40 a chat
 * conversation on the single-channel chat packages (`chat-web`, `chat-meta`) or $0.30 on
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
 * 1,000 / 2,000 (single-channel chat, chat-dual, chat with voice, complete),
 * and the top tier's voice from 1,500 minutes to 1,000. The spec asks for each package to
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

/**
 * Every channel, in `channelList`'s order. The runtime list of `Channel`, so a
 * database CHECK on a channel column is built from it rather than retyped: a
 * clinic's channels are rows keyed by these ids, and billing steps up by them.
 */
export const CHANNELS: readonly Channel[] = ["web", "meta", "voice"];

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
   * Locations the package covers at checkout, which is one for every package.
   * Each extra location is added later from the portal on the same
   * subscription and renewal date, at the package's own price plus its setup
   * fee (`additionalLocationChargeUsd`), as more quantity of the same package
   * price; checkout itself still sells one.
   */
  locations: number;
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
  /**
   * Shown by Stripe on the Checkout page and the invoice, so it is client
   * copy: nothing that says we are new. Re-run stripe:setup after changing
   * it, because the coupon already in Stripe keeps its old name.
   */
  name: "Setup credit",
  /** Days after the offer email during which checkout honours it. */
  validDays: 14,
} as const;

/**
 * The days a clinic has to finish its own setup (the owner's decision of
 * 6 October 2026). While no channel is answering patients it gets a reminder
 * every five days, six in all; at the end of the last day an account with
 * nothing live is closed, and the setup fee, which is never refunded, is kept.
 * Provisioning stamps the deadline on the clinic, so changing these moves
 * only clinics bought afterwards.
 */
export const SETUP_WINDOW_DAYS = 30;
export const SETUP_REMINDER_EVERY_DAYS = 5;

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
    overagePerChatConversationUsd: CHAT_OVERAGE,
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
    overagePerChatConversationUsd: CHAT_OVERAGE,
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
    overagePerChatConversationUsd: CHAT_OVERAGE,
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
    highlight: "Recommended",
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
/**
 * The $0 recurring price a subscription carries until AYA first answers a
 * patient (the deferred start, contracts §2). Checkout bills the setup fee and
 * this; at the first answer Package C swaps it for the package's price. It is
 * what makes the start deferred without being a trial: Stripe never sees a
 * trial, so nothing is ever "trialing" and no charge reads "TRIAL OVER".
 */
export const PLAN_START_PLACEHOLDER_LOOKUP_KEY = "healdesk_plan_start_placeholder_month";
export const PLAN_START_PLACEHOLDER_NAME = "Monthly plan: starts when AYA first answers";

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * The plan-start sentence (plan Part A3): one wording, in the Checkout page's
 * custom text, on Home and Billing, in the welcome email and in the Terms.
 * "Monthly billing ($897) starts the day AYA first answers a patient."
 * Vets' practices say "client" (audienceFor).
 */
export function planStartSentence(
  plan: Plan,
  interval: BillingInterval,
  audience: "patient" | "client" = "patient",
): string {
  return interval === "year"
    ? `Annual billing (${usdWhole.format(annualTotalUsd(plan))} a year) starts the day AYA first answers a ${audience}.`
    : `Monthly billing (${usdWhole.format(plan.monthlyUsd)}) starts the day AYA first answers a ${audience}.`;
}

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

export type ParsedLookupKey = {
  planId: string;
  kind: PriceKind;
  /** The amount the key was minted with. Compare against the catalog to spot a stale price. */
  cents: number;
};

/**
 * The inverse of `stripeLookupKey()`: `healdesk_<plan>_<kind>_<cents>`.
 *
 * Plan ids contain hyphens and never underscores, which is what makes the
 * split unambiguous; plans.test.ts round-trips every plan and kind through
 * both functions so the two cannot drift apart. (It lived in apps/app until 5
 * October 2026, when the plan-change and metered-item code there started
 * needing it in more than one place; apps/app re-exports it.)
 *
 * Returns null for anything that is not a package price — the metered
 * overage prices, scalabid's prices on the same Stripe account, a key from a
 * plan that has since been removed from the catalog — and the caller decides
 * what that means for the event it is holding.
 */
export function parseLookupKey(key: string): ParsedLookupKey | null {
  const match = /^healdesk_([a-z0-9-]+)_(month|year|setup)_(\d+)$/.exec(key);
  if (!match) return null;
  return {
    planId: match[1]!,
    kind: match[2] as PriceKind,
    cents: Number(match[3]),
  };
}

/**
 * The two account-wide meters. Each counts one unit past the allowance, by
 * Stripe customer, and backs one metered price per distinct overage rate:
 * today one voice price ($0.80) and two chat prices ($0.40 on the
 * single-channel chat packages, $0.30 on the rest). A subscription carries the
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

// -----------------------------------------------------------------------------
// Usage: what one chat conversation and one voice minute are
// -----------------------------------------------------------------------------

/**
 * A chat conversation is one person's thread on one channel, from their first
 * message until this long passes with no message from them; their next
 * message after that starts a new conversation (owner decision of 5 October
 * 2026). The same 24 hours as Meta's customer-service window, so "one
 * conversation" and "one window in which we may reply" are the same thing.
 */
export const CHAT_CONVERSATION_SILENCE_MS = 24 * 60 * 60 * 1000;

/**
 * Billable voice minutes for ONE call: its length rounded up to the next
 * whole minute, so 61 seconds is 2 minutes (owner decision of 5 October
 * 2026). Calls are metered one at a time and never by summing seconds across
 * calls first. Zero, negative, NaN or infinite durations bill nothing: a
 * duration we cannot trust is not a reason to charge.
 */
export function billableVoiceMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

// -----------------------------------------------------------------------------
// Extra locations
// -----------------------------------------------------------------------------

/**
 * What one additional location costs (owner decision of 5 October 2026): the
 * package's recurring price again — monthly, or the annual total — on the SAME
 * subscription and renewal date (Stripe prorates the first period), plus the
 * package's setup fee once. Included minutes and conversations add up across
 * locations: the pooled allowance is the package allowance × locations.
 */
export function additionalLocationChargeUsd(
  plan: Plan,
  interval: BillingInterval,
): { recurringUsd: number; setupFeeUsd: number } {
  return { recurringUsd: recurringUsd(plan, interval), setupFeeUsd: plan.setupFeeUsd };
}

// -----------------------------------------------------------------------------
// Refund windows (terms § 3), here so apps/web's terms and apps/app's refund
// actions read the same two numbers
// -----------------------------------------------------------------------------

/**
 * The one exception to the non-refundable setup fee: refunded when none of the
 * practice's channels has gone live this many days after its payment, unless
 * the delay is something still waiting on the practice. Adopted 3 October 2026
 * (docs/counsel/guarantee-and-refund.md decision 5).
 */
export const SETUP_FEE_REFUND_NOT_LIVE_DAYS = 30;

/**
 * Days after purchase within which the first period's subscription fee is
 * refundable in full. The setup fee is never refunded under this window
 * (decision of 21 September 2026).
 */
export const FIRST_PERIOD_REFUND_DAYS = 14;

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
