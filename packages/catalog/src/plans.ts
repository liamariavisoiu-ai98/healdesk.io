/**
 * Billing: five packages, each sold in usage steps of 100.
 *
 * Since 13 October 2026 (the owner's pricing sheet, "Healdesk pricing", per
 * location, USD) a clinic picks a PACKAGE and then a STEP for each thing it
 * uses: voice in minutes, chat in conversations, 100 to 1,500 in steps of 100.
 * Every step of a product costs the same, so a plan's monthly price is the
 * product's price per 100 times its steps, and a package with voice and chat
 * adds the two:
 *
 *   product    per 100 a month   each extra 100   setup (list)
 *   voice           $80              $104            $697
 *   webchat         $40               $52            $259
 *   metachat        $60               $78            $697   (includes website chat)
 *
 * The packages are voice, webchat, metachat, voice + webchat and voice +
 * metachat; a combined package's setup fee is the sum of its products'
 * ($956 and $1,394). Meta is never sold without website chat: Metachat
 * includes the website, which a practice without one simply never switches
 * on (`planNeedsWebsite`). This replaced the seven fixed packages of
 * 5 October, whose allowances were fixed per package.
 *
 * ## One plan id per package and step, one Stripe price per plan
 *
 * A plan is a package and its steps, and its id says both:
 * `voice-500`, `webchat-300`, `metachat-300`, `voice-webchat-500-300` (voice
 * minutes first, then chat conversations). `getPlan()` parses an id rather
 * than looking one up, so any well-formed id on the grid is a plan and
 * anything off it (a step of 150, a step above 1,500, a package that does not
 * exist) is not.
 *
 * Every plan has its own Stripe price per interval, created by stripe:setup
 * from `allPlans()`. That is 495 plans and 990 recurring prices, which is a lot
 * of prices and deliberately so: apps/app's billing engine reads a
 * subscription as ONE package price whose quantity is the number of
 * locations, and a plan that was two prices (a voice line and a chat line)
 * or a per-100 price with quantity steps × locations would have changed what
 * every reconcile, plan change and location action in apps/app reads off a
 * subscription. A price per plan keeps quantity meaning locations.
 *
 * The setup fee is per PACKAGE, not per plan (it does not change with how
 * much a clinic uses), so its lookup key carries the package id.
 *
 * ## The setup fee is real, and charged once per location
 *
 * The setup fee pays for the location's set-up, its number where it has
 * phone, and a QA pass before it answers anyone. For the first location that
 * is provisioning the clinic's AYA, and it is charged on the first invoice;
 * a further location is answered by the same AYA (the owner's central model
 * of 20 October 2026), and its fee is charged when it is added
 * (`additionalLocationChargeUsd`). There is no trial. The setup credits below
 * take a share of the first location's fee off, never anything off the
 * subscription.
 *
 * ## Annual pricing is a flat 20% off, stated per month
 *
 * `annualMonthlyUsd` is the per-month figure the sheet quotes ($320 a month
 * for 500 voice minutes); the annual invoice is that times 12, computed by
 * `annualTotalUsd()` so the multiplication lives in one place. Every product's
 * per-100 price is a multiple of $5, so 20% off is always whole dollars.
 *
 * ## Overage: the extra-100 price, per started block of 100
 *
 * Past the included amount, each STARTED block of 100 is billed at the
 * product's extra-100 price: $104 for voice minutes, $52 for webchat
 * conversations and $78 for metachat conversations (`OVERAGE_BLOCK_UNITS`).
 * 1 unit over is one block, 101 is two. The extra-100 price is 30% over the
 * step price, so an upgrade to the next step is the better deal for a clinic
 * that goes over regularly, and the 90% email says so (`USAGE_ALERT_PERCENT`).
 * Above the top step (1,500) the same blocks apply.
 *
 * The rates were set by the owner on 13 October 2026. They are still a
 * judgement, not a measurement: the spec sets overage prices from measured
 * cost times a target margin, and launch step 3.5 measures that cost on pilot
 * traffic. Any copy that prints these rates must say they are provisional.
 *
 * Each metered key encodes its rate, like the package keys, so a rate change
 * cannot silently bill the old rate: checkout fails loudly until
 * `stripe:setup` has been re-run. Stripe holds one metered price per distinct
 * rate (three, on two meters) and a subscription carries its own package's.
 * A plan change must therefore swap the metered items as well as the package
 * price; Stripe's Customer Portal cannot update a subscription that carries
 * metered prices at all, so plan changes do not go through it.
 *
 * `OVERAGE_RATES_PROVISIONAL` still stays false, on purpose. While it is
 * true, `meteredLookupKeysFor()` in apps/web/src/lib/billing.ts attaches no
 * metered price, and the terms replace their overage sentence with "Until
 * those prices are published, usage above the allowance is not billed."
 * Flipping it would change what Stripe bills and what the service agreement
 * says. That is a billing and counsel decision, not a copy one.
 *
 * Both halves of overage billing are built (apps/app, run by the scheduler's
 * tick), and each ships OFF, as every job does, until it is switched on in the
 * ops console: until `usage-meter-report` is on, nothing reports usage to
 * Stripe's meters and the metered lines of a monthly package bill zero.
 * `lib/billing/usage-report.ts` sends every usage row past the allowance to
 * the clinic's meter. An ANNUAL package attaches no metered price, because
 * Stripe cannot mix a yearly and a monthly price on one subscription, so
 * `lib/billing/annual-overage.ts` invoices each closed allowance month on an
 * invoice of its own when `annual-overage-invoice` is on, which is why the
 * terms say "invoiced separately" for annual packages. Whether either has
 * run against live Stripe is not shown here; the ops console says.
 *
 * ## The included amounts are the clinic's choice now
 *
 * A clinic picks its step, so the included minutes and conversations are no
 * longer a guess made for it. What is still unmeasured is the COST of a step:
 * chat cost per conversation is the product's largest unknown (the spec's
 * "Unit economics and infrastructure"), and the 1,500-conversation metachat
 * step is the worst case the price promises.
 *
 * ## WhatsApp starts costing the clinic on 1 October 2026
 *
 * Metachat includes WhatsApp, and its conversations count against
 * `includedChatConversations` like any other chat. From 1 October 2026 Meta
 * also charges for WhatsApp service replies inside the 24-hour window, and it
 * bills the clinic directly. Healdesk does not resell WhatsApp messages
 * (docs/v1-product-spec.md → "Pricing consequences" and "Meta bot
 * onboarding"). Meta's rate is $0.0034 per delivered service message in North
 * America, after 1,000 free per number each month; nothing here counts
 * billable WhatsApp messages per clinic yet.
 *
 * ## The setup-fee delta on an upgrade is owed, not yet invoiced
 *
 * `setupFeeDeltaUsd()` says what an upgrading clinic owes: a move between
 * steps of the same package owes nothing, a move to a package with a larger
 * setup fee owes the difference. Nothing invoices it yet; until that is built
 * the delta is collected by hand (docs/handover.md), and the pricing page
 * makes no promise about it either way.
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

// -----------------------------------------------------------------------------
// Products, packages and steps
// -----------------------------------------------------------------------------

/** What is metered and priced per 100: voice minutes, or one of the two chat products. */
export type ProductId = "voice" | "webchat" | "metachat";

/** The chat products. Metachat includes website chat. */
export type ChatProductId = Exclude<ProductId, "voice">;

export type Product = {
  id: ProductId;
  /** AYA's name for it (owner, 7 October 2026: never "chatbot" or "AI voice agent"). */
  name: string;
  /** What a step counts. */
  unit: "minute" | "conversation";
  /** The channels it answers on. */
  channels: readonly Channel[];
  /** The monthly price of one step of 100. */
  perStepMonthlyUsd: number;
  /** The monthly-equivalent price of one step of 100 on annual billing: 20% off. */
  perStepAnnualMonthlyUsd: number;
  /** One unit over the included amount, in dollars; billed in started blocks of 100. */
  overagePerUnitUsd: number;
  /** One-time, list price. */
  setupFeeUsd: number;
};

/** Annual billing takes this percent off the monthly price. */
export const ANNUAL_DISCOUNT_PERCENT = 20;

function product(
  id: ProductId,
  name: string,
  unit: Product["unit"],
  channels: readonly Channel[],
  perStepMonthlyUsd: number,
  overagePerUnitUsd: number,
  setupFeeUsd: number,
): Product {
  return {
    id,
    name,
    unit,
    channels,
    perStepMonthlyUsd,
    perStepAnnualMonthlyUsd: (perStepMonthlyUsd * (100 - ANNUAL_DISCOUNT_PERCENT)) / 100,
    overagePerUnitUsd,
    setupFeeUsd,
  };
}

/**
 * Set by the owner on 13 October 2026 (the pricing sheet). Whole cents only
 * for the overage rates: each is encoded in its Stripe lookup key.
 */
export const PRODUCTS: Readonly<Record<ProductId, Product>> = {
  voice: product("voice", "AYA Voice", "minute", ["voice"], 80, 1.04, 697),
  webchat: product("webchat", "AYA Web Chat", "conversation", ["web"], 40, 0.52, 259),
  metachat: product("metachat", "AYA Meta Chat", "conversation", ["web", "meta"], 60, 0.78, 697),
};

/**
 * Whether checkout leaves the metered overage prices off and the terms say
 * overage is not billed. It is NOT a "these rates are final" flag: the rates
 * are provisional either way. See the header for why it stays false.
 */
export const OVERAGE_RATES_PROVISIONAL = false;

/** A step is this many minutes or conversations. */
export const STEP_UNITS = 100;
/** The smallest and largest step on sale. Above the top step, usage is overage. */
export const MIN_STEP_UNITS = 100;
export const MAX_STEP_UNITS = 1_500;

/** Every step on sale, smallest first: 100, 200, … 1,500. */
export const USAGE_STEPS: readonly number[] = Array.from(
  { length: MAX_STEP_UNITS / STEP_UNITS },
  (_, i) => (i + 1) * STEP_UNITS,
);

export function isUsageStep(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_STEP_UNITS &&
    value <= MAX_STEP_UNITS &&
    value % STEP_UNITS === 0
  );
}

/** The steps the funnel and the pricing page start on: the sheet's own examples. */
export const DEFAULT_STEPS = { voiceMinutes: 500, chatConversations: 300 } as const;

export type PackageId = "voice" | "webchat" | "metachat" | "voice-webchat" | "voice-metachat";

export type Package = {
  id: PackageId;
  name: string;
  /** The products it bills: voice, a chat product, or one of each. */
  voice: boolean;
  chat: ChatProductId | null;
  highlight?: string;
};

/** In the sheet's order. Recommended: voice with Meta chat, every channel. */
export const PACKAGES: readonly Package[] = [
  { id: "voice", name: "AYA Voice", voice: true, chat: null },
  { id: "webchat", name: "AYA Web Chat", voice: false, chat: "webchat" },
  { id: "metachat", name: "AYA Meta Chat", voice: false, chat: "metachat" },
  { id: "voice-webchat", name: "AYA Voice + Web Chat", voice: true, chat: "webchat" },
  { id: "voice-metachat", name: "AYA Voice + Meta Chat", voice: true, chat: "metachat", highlight: "Recommended" },
] as const;

export function getPackage(id: string): Package | undefined {
  return PACKAGES.find((p) => p.id === id);
}

export function isPackageId(id: unknown): id is PackageId {
  return typeof id === "string" && PACKAGES.some((p) => p.id === id);
}

/** The package that bills exactly these products, or undefined for none. */
export function packageFor(voice: boolean, chat: ChatProductId | null): Package | undefined {
  return PACKAGES.find((p) => p.voice === voice && p.chat === chat);
}

/** A package's setup fee at list price: the sum of its products'. */
export function packageSetupFeeUsd(pkg: Package): number {
  return (pkg.voice ? PRODUCTS.voice.setupFeeUsd : 0) + (pkg.chat ? PRODUCTS[pkg.chat].setupFeeUsd : 0);
}

export type Plan = {
  /** `voice-500`, `webchat-300`, `voice-metachat-500-300`; see the header. */
  id: string;
  packageId: PackageId;
  /** "AYA Voice, 500 minutes" — the package and its steps. */
  name: string;
  /** The package's name alone. */
  packageName: string;
  /**
   * Channels the plan includes. `meta` is the Meta bot: Instagram DMs,
   * Facebook Messenger and WhatsApp. It is sold as one channel because one
   * Healdesk Meta app serves all three, but the clinic connects it in two
   * steps. One Facebook login connects Instagram and Messenger together.
   * WhatsApp uses Meta's embedded signup, cannot send until the clinic has
   * added its own payment method in Meta, and may go live after the other
   * two. Meta bills the clinic directly for WhatsApp; see the header.
   * Metachat includes `web`.
   */
  channels: { web: boolean; meta: boolean; voice: boolean };
  /** The chat product, or null for voice alone. */
  chatProduct: ChatProductId | null;
  monthlyUsd: number;
  /** Per-month price when billed annually. The annual invoice is 12× this. */
  annualMonthlyUsd: number;
  /** One-time, on the first invoice only, list price. Never recurring. Per package. */
  setupFeeUsd: number;
  /** Per month: the voice step. 0 when the plan has no voice. */
  includedVoiceMinutes: number;
  /** Per month: the chat step. 0 when the plan has no chat. */
  includedChatConversations: number;
  overagePerVoiceMinuteUsd: number;
  overagePerChatConversationUsd: number;
  /**
   * Locations the plan covers at checkout, which is one for every plan.
   * Prices are per location: each extra location is added later from the
   * portal on the same subscription and renewal date, at the plan's own price
   * plus its setup fee (`additionalLocationChargeUsd`), as more quantity of
   * the same plan price; checkout itself still sells one.
   */
  locations: number;
};

const minutes = (n: number) => `${n.toLocaleString("en-US")} minutes`;
const conversations = (n: number) => `${n.toLocaleString("en-US")} conversations`;

/** The id of a package at the given steps; throws on a step off the grid or one the package does not have. */
export function planIdFor(
  packageId: PackageId,
  steps: { voiceMinutes?: number; chatConversations?: number },
): string {
  const pkg = getPackage(packageId);
  if (!pkg) throw new Error(`Unknown package ${packageId}.`);
  const parts: number[] = [];
  if (pkg.voice) {
    if (!isUsageStep(steps.voiceMinutes)) throw new Error(`Voice step ${steps.voiceMinutes} is not on sale.`);
    parts.push(steps.voiceMinutes);
  }
  if (pkg.chat) {
    if (!isUsageStep(steps.chatConversations)) {
      throw new Error(`Chat step ${steps.chatConversations} is not on sale.`);
    }
    parts.push(steps.chatConversations);
  }
  return [pkg.id, ...parts].join("-");
}

/** The plan for a package at the given steps. Throws like `planIdFor`. */
export function planFor(
  packageId: PackageId,
  steps: { voiceMinutes?: number; chatConversations?: number },
): Plan {
  return getPlan(planIdFor(packageId, steps))!;
}

const PLAN_ID = /^(voice|webchat|metachat|voice-webchat|voice-metachat)-([1-9]\d{2,3})(?:-([1-9]\d{2,3}))?$/;

/**
 * The plan an id names, computed from the products, or undefined for an id
 * that is not on the grid. Pure: the same id is always the same plan.
 */
export function getPlan(id: string): Plan | undefined {
  if (typeof id !== "string") return undefined;
  const match = PLAN_ID.exec(id);
  if (!match) return undefined;
  const pkg = getPackage(match[1]!)!;
  const first = Number(match[2]);
  const second = match[3] === undefined ? undefined : Number(match[3]);
  const both = pkg.voice && pkg.chat !== null;
  if (both !== (second !== undefined)) return undefined;
  const voiceMinutes = pkg.voice ? first : 0;
  const chatConversations = pkg.chat ? (both ? second! : first) : 0;
  if (pkg.voice && !isUsageStep(voiceMinutes)) return undefined;
  if (pkg.chat && !isUsageStep(chatConversations)) return undefined;

  const voice = PRODUCTS.voice;
  const chat = pkg.chat ? PRODUCTS[pkg.chat] : null;
  const voiceSteps = voiceMinutes / STEP_UNITS;
  const chatSteps = chatConversations / STEP_UNITS;
  const sizes = [
    ...(pkg.voice ? [minutes(voiceMinutes)] : []),
    ...(chat ? [conversations(chatConversations)] : []),
  ];
  return {
    id,
    packageId: pkg.id,
    name: `${pkg.name}, ${sizes.join(" and ")}`,
    packageName: pkg.name,
    channels: {
      web: chat !== null && chat.channels.includes("web"),
      meta: chat !== null && chat.channels.includes("meta"),
      voice: pkg.voice,
    },
    chatProduct: pkg.chat,
    monthlyUsd: voiceSteps * voice.perStepMonthlyUsd + (chat ? chatSteps * chat.perStepMonthlyUsd : 0),
    annualMonthlyUsd:
      voiceSteps * voice.perStepAnnualMonthlyUsd + (chat ? chatSteps * chat.perStepAnnualMonthlyUsd : 0),
    setupFeeUsd: packageSetupFeeUsd(pkg),
    includedVoiceMinutes: voiceMinutes,
    includedChatConversations: chatConversations,
    overagePerVoiceMinuteUsd: pkg.voice ? voice.overagePerUnitUsd : 0,
    overagePerChatConversationUsd: chat ? chat.overagePerUnitUsd : 0,
    locations: 1,
  };
}

export function isPlanId(id: unknown): id is string {
  return typeof id === "string" && getPlan(id) !== undefined;
}

/**
 * Every plan on sale: each package at every step (both steps, for a package
 * with voice and chat). 495 of them. For stripe:setup and the tests; a page
 * that lists plans wants `PACKAGES` and `USAGE_STEPS` instead.
 */
export function allPlans(): Plan[] {
  const out: Plan[] = [];
  for (const pkg of PACKAGES) {
    const voiceSteps = pkg.voice ? USAGE_STEPS : [undefined];
    const chatSteps = pkg.chat ? USAGE_STEPS : [undefined];
    for (const voiceMinutes of voiceSteps) {
      for (const chatConversations of chatSteps) {
        out.push(planFor(pkg.id, { voiceMinutes, chatConversations }));
      }
    }
  }
  return out;
}

/** The chat channel a buyer may be asked about: website chat or the Meta bot. */
export type ChatChannel = Exclude<Channel, "voice">;

export function isChatChannel(value: unknown): value is ChatChannel {
  return value === "web" || value === "meta";
}

// -----------------------------------------------------------------------------
// Setup credits
// -----------------------------------------------------------------------------

export type SetupCredit = {
  /** Stripe coupon id prefix; stripe:setup creates one per package (`setupCouponId`). */
  couponId: string;
  /** Shown by Stripe on Checkout and the invoice, so it is client copy. */
  name: string;
  percentOfSetupFee: number;
  /** How long the offer holds, from the moment it is made. */
  validHours: number;
};

/**
 * The founding-cohort setup credit — kept, by decision of 21 September 2026.
 *
 * Offered in the Day 7 nurture email and honoured at checkout as one Stripe
 * coupon per package whose `amount_off` is that package's own setup fee, so
 * the credit IS the fee and the subscription is untouched. The copy therefore
 * says "the setup fee in full" and quotes the range, never one round number.
 * It is valid for the fourteen days after the email that offers it, tied to
 * the lead it was sent to, and never applied from a URL parameter alone.
 */
export const COHORT_SETUP_CREDIT = {
  couponId: "healdesk-cohort-setup",
  name: "Setup credit",
  percentOfSetupFee: 100,
  validHours: 14 * 24,
  /** Days after the offer email during which checkout honours it. */
  validDays: 14,
} as const satisfies SetupCredit & { validDays: number };

/**
 * Half the setup fee off, for a clinic that buys from a personalised demo an
 * operator built and sent it, within 48 hours of the demo being ready (owner,
 * 7 October 2026 for the half; 13 October for the 48 hours, a week until
 * then).
 */
export const DEMO_SETUP_CREDIT = {
  couponId: "healdesk-demo-setup-50",
  name: "Your demo: 50% off setup",
  percentOfSetupFee: 50,
  validHours: 48,
} as const satisfies SetupCredit;

/**
 * 30% off, from a demo the visitor asked for themselves on the homepage's
 * "See it in your own branding" ("Send me my own free AI assistant"), within
 * 48 hours of the demo being ready (owner, 13 October 2026). The same share
 * as the website's own offer, but its clock starts when the demo is ready, and
 * Stripe names it after the demo.
 */
export const SELF_SERVE_DEMO_SETUP_CREDIT = {
  couponId: "healdesk-demo-setup-30",
  name: "Your demo: 30% off setup",
  percentOfSetupFee: 30,
  validHours: 48,
} as const satisfies SetupCredit;

export const DEMO_SETUP_CREDITS = [DEMO_SETUP_CREDIT, SELF_SERVE_DEMO_SETUP_CREDIT] as const;

/**
 * 30% off the setup fee for a clinic that buys through the website, within
 * 48 hours of first being shown the offer (owner, 13 October 2026). The
 * moment is held in a signed cookie by apps/web (lib/site-offer.ts), so the
 * server, not the browser, decides whether it still holds.
 */
export const SITE_SETUP_CREDIT = {
  couponId: "healdesk-site-setup-30",
  name: "30% off setup",
  percentOfSetupFee: 30,
  validHours: 48,
} as const satisfies SetupCredit;

export const SETUP_CREDITS = [
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  SELF_SERVE_DEMO_SETUP_CREDIT,
  SITE_SETUP_CREDIT,
] as const;

/**
 * What a buyer pays for setup under a credit, in whole dollars, ROUNDED UP:
 * 50% of $697 is $348.50 and the sheet says "$349". The credit is whatever
 * that leaves (`setupCreditUsd`), so the page and Stripe's amount_off agree
 * to the dollar.
 */
export function setupAfterCreditUsd(
  plan: { setupFeeUsd: number },
  credit: { percentOfSetupFee: number },
): number {
  return Math.ceil((plan.setupFeeUsd * (100 - credit.percentOfSetupFee)) / 100);
}

/** The credit itself, in whole dollars: the list fee less `setupAfterCreditUsd`. */
export function setupCreditUsd(
  plan: { setupFeeUsd: number },
  credit: { percentOfSetupFee: number },
): number {
  return plan.setupFeeUsd - setupAfterCreditUsd(plan, credit);
}

/** A demo credit for one plan, in whole dollars: the operator demo's unless another is named. */
export function demoSetupCreditUsd(
  plan: { setupFeeUsd: number },
  credit: { percentOfSetupFee: number } = DEMO_SETUP_CREDIT,
): number {
  return setupCreditUsd(plan, credit);
}

/** The website credit for one plan, in whole dollars. */
export function siteSetupCreditUsd(plan: { setupFeeUsd: number }): number {
  return setupCreditUsd(plan, SITE_SETUP_CREDIT);
}

/**
 * The Stripe coupon for one credit on one package. The amount is in the id,
 * like a price's lookup key: a coupon's amount_off can never change, so a new
 * setup fee is a new coupon rather than the old one silently applied.
 */
export function setupCouponId(credit: SetupCredit, plan: { packageId: PackageId; setupFeeUsd: number }): string {
  return `${credit.couponId}-${plan.packageId}-${setupCreditUsd(plan, credit) * 100}`;
}

/** Whether an offer made at `offeredAt` still holds at `now`. */
export function isSetupCreditLive(
  credit: { validHours: number },
  offeredAt: Date | number,
  now: number = Date.now(),
): boolean {
  const from = typeof offeredAt === "number" ? offeredAt : offeredAt.getTime();
  return Number.isFinite(from) && now >= from && now - from < credit.validHours * 60 * 60 * 1000;
}

/** When an offer made at `offeredAt` ends. */
export function setupCreditEndsAt(credit: { validHours: number }, offeredAt: Date | number): Date {
  const from = typeof offeredAt === "number" ? offeredAt : offeredAt.getTime();
  return new Date(from + credit.validHours * 60 * 60 * 1000);
}

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

/**
 * The share of an included amount at which the clinic is emailed (the
 * pricing sheet: "When you use 90% of your included amount, we send you a
 * short email"), with the choice to move up a step or let the next block of
 * 100 bill at the extra-100 price.
 */
export const USAGE_ALERT_PERCENT = 90;

// -----------------------------------------------------------------------------
// What is billed
// -----------------------------------------------------------------------------

/**
 * The $0 recurring price a subscription carries until AYA first answers a
 * patient (the deferred start, contracts §2). Checkout bills the setup fee and
 * this; at the first answer Package C swaps it for the plan's price. It is
 * what makes the start deferred without being a trial: Stripe never sees a
 * trial, so nothing is ever "trialing" and no charge reads "TRIAL OVER".
 */
export const PLAN_START_PLACEHOLDER_LOOKUP_KEY = "healdesk_plan_start_placeholder_month";
export const PLAN_START_PLACEHOLDER_NAME = "Monthly plan: starts when AYA first answers";

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * The plan-start sentence (plan Part A3): one wording, in the Checkout page's
 * custom text, on Home and Billing, in the welcome email and in the Terms.
 * "Monthly billing ($400) starts the day AYA first answers a patient."
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

/** The recurring amount for one billing period, in whole dollars. */
export function recurringUsd(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? annualTotalUsd(plan) : plan.monthlyUsd;
}

/** The annual invoice amount. Exactly 12 × the quoted per-month annual price. */
export function annualTotalUsd(plan: Plan): number {
  return plan.annualMonthlyUsd * 12;
}

/**
 * Setup fee owed on an upgrade: the difference between the two packages'
 * fees, never negative. A step change within a package owes nothing; Web Chat
 * ($259) to Voice + Web Chat ($956) owes $697. Downgrades never refund one.
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
 * The plan to bill for the channels in service, at the steps bought, or null
 * for none.
 *
 * Billing follows the channels in service, not the package bought (the
 * owner's decision of 6 October 2026): a clinic that bought Voice + Meta Chat
 * and whose website chat answered first is billed as Web Chat, at its chat
 * step, until its next channel answers. Voice bills when voice is in service;
 * chat bills as Meta Chat once the Meta bot is in service and as Web Chat
 * while only the website is. A channel the bought plan does not include is
 * ignored. An empty result is null, never a plan: no channel in service means
 * nothing to bill yet, and a caller must not start or change a plan on it.
 */
export function planForChannels(bought: Plan, channels: Iterable<Channel>): Plan | null {
  const live = new Set([...channels].filter((c) => bought.channels[c]));
  const voice = live.has("voice");
  const chat: ChatProductId | null = live.has("meta") ? "metachat" : live.has("web") ? "webchat" : null;
  const pkg = packageFor(voice, chat);
  if (!pkg) return null;
  return planFor(pkg.id, {
    voiceMinutes: voice ? bought.includedVoiceMinutes : undefined,
    chatConversations: chat ? bought.includedChatConversations : undefined,
  });
}

/**
 * Stripe price lookup keys.
 *
 * The key encodes the amount, so a catalog price change cannot silently resolve
 * to an old Stripe price: it fails loudly until `stripe:setup` has been re-run.
 * The interval is in the key too, because monthly and annual are different
 * prices on the same product and a key without it would find whichever was
 * created first. A recurring key names the PLAN
 * (`healdesk_voice-webchat-500-300_month_60000`); the setup key names the
 * PACKAGE (`healdesk_voice-webchat_setup_95600`), because the setup fee does
 * not change with the steps.
 */
export type PriceKind = "month" | "year" | "setup";

export function stripeLookupKey(plan: Plan, kind: PriceKind): string {
  const cents =
    kind === "setup"
      ? plan.setupFeeUsd * 100
      : recurringUsd(plan, kind) * 100;
  return `healdesk_${kind === "setup" ? plan.packageId : plan.id}_${kind}_${cents}`;
}

export type ParsedLookupKey = {
  /** The plan id for a recurring key; the PACKAGE id for a setup key. */
  planId: string;
  kind: PriceKind;
  /** The amount the key was minted with. Compare against the catalog to spot a stale price. */
  cents: number;
};

/**
 * The inverse of `stripeLookupKey()`: `healdesk_<plan>_<kind>_<cents>`.
 *
 * Plan and package ids contain hyphens and digits and never underscores,
 * which is what makes the split unambiguous; plans.test.ts round-trips every plan and kind through
 * both functions so the two cannot drift apart. (It lived in apps/app until 5
 * October 2026, when the plan-change and metered-item code there started
 * needing it in more than one place; apps/app re-exports it.)
 *
 * Returns null for anything that is not a package price — the metered
 * overage prices, scalabid's prices on the same Stripe account — and the
 * caller decides what that means for the event it is holding. A key from a
 * plan no longer on the grid (the seven packages of 5 October) parses, and
 * `getPlan()` of its id is undefined.
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
 * today one voice price ($104 a block of 100 minutes) and two chat prices
 * ($52 a block of 100 conversations on Web Chat, $78 on Meta Chat). A subscription carries the price for its own package's rate, so the
 * usage reporter sends every event to the meter by `eventName`, in single
 * units, and never has to know the rate or the block: the price turns the
 * period's units into started blocks (OVERAGE_BLOCK_UNITS).
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
 * Overage is billed per STARTED block of this many units (the owner's decision
 * of 6 October 2026, kept by the pricing sheet of 13 October): $104 for each
 * started block of 100 extra voice minutes, $52 (Web Chat) or $78 (Meta Chat)
 * for each started block of 100 extra chat conversations. Per unit amounts
 * left odd figures on every invoice.
 *
 * The per-unit rates on each plan stay the source, and a block is the rate
 * times this. The meters still count single units. Stripe divides a monthly
 * period's total by this and rounds up (the metered price's
 * `transform_quantity`, set by stripe-setup), and the annual overage invoice
 * does the same sum per closed month. So 1 unit over is one block, 100 is one,
 * and 101 is two.
 */
export const OVERAGE_BLOCK_UNITS = 100;

/** The price of one started block, in whole cents: the per-unit rate × OVERAGE_BLOCK_UNITS. */
export function overageBlockCents(rateUsd: number): number {
  return overageRateCents(rateUsd) * OVERAGE_BLOCK_UNITS;
}

/** Started blocks for a number of units over the allowance. None for nothing (or nonsense). */
export function overageBlocks(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return Math.ceil(units / OVERAGE_BLOCK_UNITS);
}

/**
 * What `units` over the allowance cost at `rateUsd` a unit, billed in started
 * blocks, in cents. Nothing over costs nothing whatever the rate, so a meter
 * the package does not sell (rate 0) and has counted nothing on is $0 rather
 * than a throw; units over with no rate still throw, because billing them at
 * $0 would hide a catalog fault.
 */
export function overageChargeCents(units: number, rateUsd: number): number {
  const blocks = overageBlocks(units);
  return blocks === 0 ? 0 : blocks * overageBlockCents(rateUsd);
}

/**
 * The lookup key of one metered price: the meter, the block size and the block
 * price in cents, e.g. `healdesk_meter_chat_conversations_block100_3000`. Both
 * numbers are in the key for the same reason the amount is in a package key: a
 * Stripe price's amount and transform can never change, so a new rate or block
 * is a new price, and a key that named only the meter would silently resolve to
 * the old one. The per-unit keys of 5 October
 * (`healdesk_meter_voice_minutes_80`) are archived by stripe-setup.
 */
export function meteredPriceLookupKey(meter: MeterId, rateUsd: number): string {
  return `${METERS[meter].lookupKeyPrefix}_block${OVERAGE_BLOCK_UNITS}_${overageBlockCents(rateUsd)}`;
}

/**
 * The metered prices one package bills: the voice meter at its voice rate when
 * it has voice, the chat meter at its chat rate when it has web or Meta.
 */
export function planMeteredPrices(
  plan: Plan,
): { meter: MeterId; rateUsd: number; blockCents: number; lookupKey: string }[] {
  const out: { meter: MeterId; rateUsd: number; blockCents: number; lookupKey: string }[] = [];
  if (plan.channels.voice) {
    out.push({
      meter: "voiceMinutes",
      rateUsd: plan.overagePerVoiceMinuteUsd,
      blockCents: overageBlockCents(plan.overagePerVoiceMinuteUsd),
      lookupKey: meteredPriceLookupKey("voiceMinutes", plan.overagePerVoiceMinuteUsd),
    });
  }
  if (plan.channels.web || plan.channels.meta) {
    out.push({
      meter: "chatConversations",
      rateUsd: plan.overagePerChatConversationUsd,
      blockCents: overageBlockCents(plan.overagePerChatConversationUsd),
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
 * What one additional location costs (owner decision of 5 October 2026;
 * "Prices are per location" on the sheet of 13 October): the plan's
 * recurring price again — monthly, or the annual total — on the SAME
 * subscription and renewal date (Stripe prorates the first period), plus the
 * package's setup fee once, at list price. Included minutes and conversations
 * add up across locations: the pooled allowance is the plan's steps × locations.
 */
export function additionalLocationChargeUsd(
  plan: Plan,
  interval: BillingInterval,
): { recurringUsd: number; setupFeeUsd: number } {
  return { recurringUsd: recurringUsd(plan, interval), setupFeeUsd: plan.setupFeeUsd };
}

// -----------------------------------------------------------------------------
// The refund window (terms § 5), here so apps/web's terms and apps/app's refund
// actions read the same number
// -----------------------------------------------------------------------------

/**
 * Days after the plan start (the day AYA first answers a patient) within
 * which the first period's subscription fee is refundable in full. The setup
 * fee is never refunded (owner, 6 October 2026).
 */
export const FIRST_PERIOD_REFUND_DAYS = 14;

/**
 * Days after the service ends for which calls still forwarded to us are
 * passed straight through to the clinic's direct line, the floor terms § 7
 * promises (it stops sooner only when the clinic removes its own call
 * forwarding). Here so apps/app's end-of-service email states the same number
 * as apps/web's terms, whose `POLICY.forwardingPassThroughDays` a test holds
 * to this one.
 */
export const FORWARDING_PASS_THROUGH_DAYS = 30;

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
