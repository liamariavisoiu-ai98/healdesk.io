import {
  annualTotalUsd,
  type BillingInterval,
  type Channel,
  DEFAULT_STEPS,
  getPackage,
  getPlan,
  MIN_STEP_UNITS,
  type MeterId,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  overageBlocks,
  overageChargeCents,
  type Package,
  PACKAGES,
  packageSetupFeeUsd,
  type Plan,
  planFor,
  planMeteredPrices,
  planStartSentence,
  type ProductId,
  PRODUCTS,
  setupAfterCreditUsd,
  STEP_UNITS,
} from "@healdesk/catalog";

/**
 * How a plan is described wherever a price is shown.
 *
 * /pricing, the checkout's package step and Review and pay all quote the same
 * products, steps and setup fees, and before this file each did its own
 * arithmetic and its own labelling. That is how a site ends up saying
 * "$317/mo" on one page and "$3,800 a year" on the next for the same plan:
 * the numbers are both true and they still do not agree. So the arithmetic is
 * delegated to the catalog (`planFor`, `annualTotalUsd`, `planStartSentence`,
 * `setupAfterCreditUsd`) and the wording lives here, once.
 *
 * Since 13 October 2026 (the owner's pricing sheet) a clinic picks a package
 * and then a usage step for each product in it, so there are no fixed cards
 * to describe any more: a plan is a package at its steps, and the helpers
 * below take a `Plan` the caller has already built with `planFor`.
 *
 * Nothing in this file knows about React. It is deliberately a plain module so
 * the due-today figures can be asserted in a test without rendering the step.
 */

/**
 * Shown to buyers. "Meta" means nothing to a clinic; the platform names do,
 * and they are the names the clinic portal uses for its channels: phone,
 * website chat, Instagram, Messenger, WhatsApp. The Meta channel is all three
 * of Instagram, Messenger and WhatsApp, so every label for it names all three.
 */
export const CHANNEL_LABELS: Record<Channel, string> = {
  web: "Website chat",
  meta: "Instagram, Messenger + WhatsApp",
  voice: "Phone",
};

/**
 * Where checkout opens for a `?plan=` value: a plan id (`voice-webchat-500-300`)
 * opens that plan, and a package id (`voice-metachat`) opens the package at
 * the sheet's default steps (`DEFAULT_STEPS`), so a link to a package lands on
 * that package with a sensible step already chosen. Null for anything else,
 * including the seven package ids of 5 October (`complete`, `chat-web`), and
 * the caller falls back to its own default: a stale link should land on the
 * flow, not on an error.
 */
export function checkoutStart(id: unknown): Plan | null {
  if (typeof id !== "string") return null;
  const plan = getPlan(id);
  if (plan) return plan;
  const pkg = getPackage(id);
  return pkg ? planFor(pkg.id, DEFAULT_STEPS) : null;
}

/** Whole dollars, with a thousands separator: "$1,394". */
export const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * The channels a package or plan answers on, as buyers name them, chat first.
 * Meta Chat includes the website, so it carries both chat chips.
 */
export function channelChips(plan: Pick<Plan, "channels">): string[] {
  const chat = (["web", "meta"] as const).filter((c) => plan.channels[c]).map((c) => CHANNEL_LABELS[c]);
  return plan.channels.voice ? [...chat, CHANNEL_LABELS.voice] : chat;
}

/** The channel chips of a package, which do not depend on its steps. */
export function packageChips(pkg: Package): string[] {
  const channels = new Set<Channel>([
    ...(pkg.voice ? PRODUCTS.voice.channels : []),
    ...(pkg.chat ? PRODUCTS[pkg.chat].channels : []),
  ]);
  return channelChips({ channels: { web: channels.has("web"), meta: channels.has("meta"), voice: channels.has("voice") } });
}

export type AllowanceRow = { label: string; value: string };

/**
 * The two allowance rows every plan summary shows: the steps chosen.
 *
 * Both rows, always, with an em dash for a zero. A voice-only plan has no
 * chat conversations and a chat-only plan has no voice minutes, and a summary
 * that silently omits "Included voice minutes" invites the reader to assume
 * voice is included and simply uncapped. One helper so the money surfaces
 * cannot state that policy differently.
 */
export function allowanceRows(plan: Plan): AllowanceRow[] {
  const perMonth = (n: number) => (n > 0 ? `${n.toLocaleString("en-US")}/mo` : "—");
  return [
    { label: "Included voice minutes", value: perMonth(plan.includedVoiceMinutes) },
    {
      label: "Included chat conversations",
      value: perMonth(plan.includedChatConversations),
    },
  ];
}

/** What a meter counts: "minutes" where the block is named, "voice minutes" in a sentence. */
const METER_UNITS: Record<MeterId, { short: string; long: string }> = {
  voiceMinutes: { short: "minutes", long: "voice minutes" },
  chatConversations: { short: "conversations", long: "chat conversations" },
};

const usdCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

export type OverageBlockPrice = {
  meter: MeterId;
  /** "$104": what one started block of OVERAGE_BLOCK_UNITS costs on this meter. */
  price: string;
  /** "minutes" or "conversations". */
  units: string;
  /** "voice minutes" or "chat conversations". */
  unitsLong: string;
};

/**
 * The overage a plan bills, voice first: one price per meter, for one started
 * block of the catalog's OVERAGE_BLOCK_UNITS. On the sheet of 13 October 2026
 * this is the product's "each extra 100" price: $104 for voice, $52 for Web
 * Chat and $78 for Meta Chat.
 *
 * Overage is billed per started block of 100 extra minutes or conversations,
 * never per unit (docs/v1-product-spec.md, "Overage prices"). The prices come
 * from `planMeteredPrices()`, the function that picks the metered prices
 * Stripe bills a plan, which prices each block with `overageBlockCents()`. So
 * a page cannot print a price Stripe does not charge, and
 * src/lib/overage-copy.test.ts holds every surface to it.
 */
export function overageBlockPrices(plan: Plan): OverageBlockPrice[] {
  return planMeteredPrices(plan).map(({ meter, blockCents }) => ({
    meter,
    price: (blockCents % 100 === 0 ? usd : usdCents).format(blockCents / 100),
    units: METER_UNITS[meter].short,
    unitsLong: METER_UNITS[meter].long,
  }));
}

/**
 * What happens past the steps chosen, as one line: "$104 per block of 100
 * minutes · $52 per block of 100 conversations".
 *
 * `null` while `OVERAGE_RATES_PROVISIONAL` is set: checkout then attaches no
 * metered price, so no number may be printed. The caller renders the
 * published-rate wording instead.
 *
 * With the flag off the block prices are printed. Every caller that prints
 * this line also says a started block is billed whole, and none says anything
 * of our own costs (owner, 30 October 2026).
 */
export function overageLine(plan: Plan): string | null {
  if (OVERAGE_RATES_PROVISIONAL) return null;
  const parts = overageBlockPrices(plan).map(
    (block) => `${block.price} per block of ${OVERAGE_BLOCK_UNITS} ${block.units}`,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The smallest step of a package: every product at 100. */
function entryPlanOf(pkg: Package): Plan {
  return planFor(pkg.id, { voiceMinutes: MIN_STEP_UNITS, chatConversations: MIN_STEP_UNITS });
}

/** The entry price on every surface that quotes one: the cheapest package at its smallest step. */
export function cheapestPlan(): Plan {
  return PACKAGES.map(entryPlanOf).reduce((best, plan) => (plan.monthlyUsd < best.monthlyUsd ? plan : best));
}

/**
 * The cheapest plan that answers the phone: AYA Voice at 100 minutes. The
 * like-for-like entry figure wherever "from" is said of the phone; a
 * comparison with a receptionist or an answering service uses a realistic
 * step instead (`comparisonVoicePlan`).
 */
export function cheapestVoicePlan(): Plan {
  return PACKAGES.filter((pkg) => pkg.voice)
    .map(entryPlanOf)
    .reduce((best, plan) => (plan.monthlyUsd < best.monthlyUsd ? plan : best));
}

/**
 * The voice plan set against a receptionist and an answering service: AYA
 * Voice at the sheet's own example step, 500 minutes. Both alternatives cover
 * a full month of calls, and 100 minutes would not, so quoting the entry step
 * there would be a comparison a reader could fairly call rigged.
 */
export function comparisonVoicePlan(): Plan {
  return planFor("voice", { voiceMinutes: DEFAULT_STEPS.voiceMinutes });
}

/**
 * The annual discount as a whole percentage, derived rather than typed.
 *
 * The catalog states annual pricing as a per-month figure, and the "save 20%"
 * badge on the toggle is a claim about that figure. Computing it means the
 * badge cannot keep saying 20% after someone changes the annual price to 15%
 * off. Every product carries the same discount (ANNUAL_DISCOUNT_PERCENT), so
 * any plan is representative; if that ever stops being true, the toggle
 * should say "up to".
 */
export function annualSavingsPercent(plan: Plan = cheapestPlan()): number {
  return Math.round((1 - plan.annualMonthlyUsd / plan.monthlyUsd) * 100);
}

/** A product's price for one step of 100, per month, on the chosen interval. */
export function perStepUsd(product: ProductId, interval: BillingInterval): number {
  const p = PRODUCTS[product];
  return interval === "year" ? p.perStepAnnualMonthlyUsd : p.perStepMonthlyUsd;
}

/** A product's "each extra 100" price, in whole dollars: its overage block. */
export function extraBlockUsd(product: ProductId): number {
  return overageChargeCents(STEP_UNITS, PRODUCTS[product].overagePerUnitUsd) / 100;
}

/** "$259–$1,394": the smallest and largest setup fee at list price, across the packages. */
export function setupFeeRangeLabel(): string {
  const fees = PACKAGES.map(packageSetupFeeUsd);
  const lo = Math.min(...fees);
  const hi = Math.max(...fees);
  return lo === hi ? usd.format(lo) : `${usd.format(lo)}–${usd.format(hi)}`;
}

export type OverageExample = {
  /** The step bought: 500 minutes. */
  step: number;
  /** What was used: 580 minutes. */
  used: number;
  /** The step's monthly price: $400. */
  stepUsd: number;
  /** Started blocks over the step: 1. */
  blocks: number;
  /** What those blocks cost: $104. */
  extraUsd: number;
  /** The smallest step that covers what was used: 600. */
  nextStep: number;
  /** That step's monthly price: $480. */
  nextStepUsd: number;
};

/**
 * The sheet's worked example of going over a voice step: 500 minutes bought,
 * 580 used, so one started block of 100 at the extra-100 price ($400 + $104),
 * against moving up to 600 minutes ($480). Computed from the catalog so the
 * example cannot drift from what Stripe bills.
 */
export function overageExample(step = 500, used = 580): OverageExample {
  const plan = planFor("voice", { voiceMinutes: step });
  const extraCents = overageChargeCents(used - plan.includedVoiceMinutes, plan.overagePerVoiceMinuteUsd);
  const nextStep = Math.ceil(used / STEP_UNITS) * STEP_UNITS;
  return {
    step,
    used,
    stepUsd: plan.monthlyUsd,
    blocks: overageBlocks(used - step),
    extraUsd: extraCents / 100,
    nextStep,
    nextStepUsd: planFor("voice", { voiceMinutes: nextStep }).monthlyUsd,
  };
}

export type DueToday = {
  /** The one-time setup fee at list price. */
  setupFeeUsd: number;
  /** The setup credit taken off it, in whole dollars; 0 without one. */
  creditUsd: number;
  /** What the card is charged today, the number on the Pay button: the setup fee after any credit. */
  totalUsd: number;
  /** "Monthly billing ($400) starts the day AYA first answers a patient." */
  planStart: string;
  /** "$400/mo" or "$3,840/yr": what the plan bills once it has started. */
  planPrice: string;
};

/**
 * The "Due today" breakdown on the payment step and the label on its button.
 *
 * The deferred start (lib/billing.ts): Checkout charges the setup fee and a
 * $0 monthly line, so today is the setup fee alone, less the one setup credit
 * that applies (the catalog's cohort, demo or website credit, rounded the way
 * `setupAfterCreditUsd` rounds it so the page and Stripe's amount_off agree to
 * the dollar), and the plan's price starts the day AYA first answers a
 * patient. The sentence saying so is the catalog's, the one Stripe's Checkout
 * page and the Terms also print, so the button, the page and the receipt
 * cannot disagree.
 */
export function dueToday(
  plan: Plan,
  interval: BillingInterval,
  credit: { percentOfSetupFee: number } | null = null,
): DueToday {
  const total = credit ? setupAfterCreditUsd(plan, credit) : plan.setupFeeUsd;
  return {
    setupFeeUsd: plan.setupFeeUsd,
    creditUsd: plan.setupFeeUsd - total,
    totalUsd: total,
    planStart: planStartSentence(plan, interval),
    planPrice:
      interval === "year"
        ? `${usd.format(annualTotalUsd(plan))}/yr`
        : `${usd.format(plan.monthlyUsd)}/mo`,
  };
}

/** "$3,840", the annual invoice, for the line under an annual per-month figure. */
export function annualTotalLabel(plan: Plan): string {
  return usd.format(annualTotalUsd(plan));
}

/** The headline figure for the chosen interval, always stated per month. */
export function monthlyFigureUsd(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd;
}
