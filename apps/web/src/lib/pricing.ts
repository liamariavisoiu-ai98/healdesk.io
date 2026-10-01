import {
  annualTotalUsd,
  type BillingInterval,
  type Channel,
  channelList,
  firstInvoiceUsd,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
  plans,
  recurringUsd,
} from "@healdesk/catalog";

/**
 * How a package is described wherever a price is shown.
 *
 * /pricing, the checkout's package cards and the closing CTA all render the
 * same five packages, and before this file each of them did its own arithmetic
 * and its own labelling. That is how a site ends up saying "$317/mo" on one
 * page and "$3,800 a year" on the next for the same package: the numbers are
 * both true and they still do not agree. So the arithmetic is delegated to the
 * catalog (`firstInvoiceUsd`, `recurringUsd`) and the wording lives here, once.
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

export const CHAT_CHANNEL_CHOICES = [
  { id: "web", label: "Website" },
  { id: "meta", label: "Instagram, Messenger + WhatsApp" },
] as const;

export type ChatChannelChoice = (typeof CHAT_CHANNEL_CHOICES)[number]["id"];

export function isChatChannelChoice(value: unknown): value is ChatChannelChoice {
  return value === "web" || value === "meta";
}

/** Whole dollars, with a thousands separator: "$1,197". */
export const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * The channel chips on a package card.
 *
 * A "Web OR Meta" package lists both channels in the catalog because either can
 * be provisioned, but a card that shows two chips promises two channels. It
 * gets one chip that says "or", and the choice is made at checkout.
 */
export function channelChips(plan: Plan): string[] {
  const chat = plan.chatChannelChoice
    ? [`${CHANNEL_LABELS.web} or ${CHANNEL_LABELS.meta}`]
    : channelList(plan)
        .filter((channel) => channel !== "voice")
        .map((channel) => CHANNEL_LABELS[channel]);
  return plan.channels.voice ? [...chat, CHANNEL_LABELS.voice] : chat;
}

export type AllowanceRow = { label: string; value: string };

/**
 * The two allowance rows every package card shows, on /pricing and in the
 * checkout's package cards alike.
 *
 * Both rows, always, with an em dash for a zero. A voice-only package has no
 * chat allowance and a chat-only package has no voice minutes, and a card
 * that silently omits "Included voice minutes" invites the reader to assume
 * voice is included and simply uncapped. One helper so the two money surfaces
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

/**
 * What happens past the allowance, as one line.
 *
 * `null` while `OVERAGE_RATES_PROVISIONAL` is set: checkout then attaches no
 * metered price, so no number may be printed. The caller renders the
 * published-rate wording instead.
 *
 * With the flag off the rates are printed, but they are still placeholders
 * until measured cost times a target margin replaces them (catalog header,
 * and docs/v1-product-spec.md "What still has to be computed"). Every caller
 * that prints this line also says the rates are provisional.
 */
export function overageLine(plan: Plan): string | null {
  if (OVERAGE_RATES_PROVISIONAL) return null;
  const parts: string[] = [];
  if (plan.overagePerVoiceMinuteUsd > 0) {
    parts.push(`$${plan.overagePerVoiceMinuteUsd.toFixed(2)}/min`);
  }
  if (plan.overagePerChatConversationUsd > 0) {
    parts.push(`$${plan.overagePerChatConversationUsd.toFixed(2)}/conversation`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The annual discount as a whole percentage, derived rather than typed.
 *
 * The catalog states annual pricing as a per-month figure, and the "save 20%"
 * badge on the toggle is a claim about that figure. Computing it means the
 * badge cannot keep saying 20% after someone changes the annual price to 15%
 * off. Every package carries the same discount today, so `plans[0]` is
 * representative; if that ever stops being true, the toggle should say "up to".
 */
export function annualSavingsPercent(plan: Plan = cheapestPlan()): number {
  return Math.round((1 - plan.annualMonthlyUsd / plan.monthlyUsd) * 100);
}

/** The entry price on every surface that quotes one. Never `plans[0]` by position. */
export function cheapestPlan(): Plan {
  return plans.reduce((best, plan) =>
    plan.monthlyUsd < best.monthlyUsd ? plan : best,
  );
}

/**
 * The cheapest package that answers the phone. The like-for-like figure
 * wherever healdesk is set against a receptionist or an answering service:
 * both of those answer calls, and the cheapest package overall does not.
 */
export function cheapestVoicePlan(): Plan {
  return plans
    .filter((plan) => plan.channels.voice)
    .reduce((best, plan) => (plan.monthlyUsd < best.monthlyUsd ? plan : best));
}

export type DueToday = {
  /** "First month" or "First year". */
  periodLabel: string;
  /** The recurring charge for that first period, in whole dollars. */
  recurringUsd: number;
  setupFeeUsd: number;
  /** The first invoice: recurring plus setup. From the catalog, not re-added here. */
  totalUsd: number;
  /** "$397/mo" or "$3,804/yr". What the card is charged at the next renewal. */
  renewsAt: string;
};

/**
 * The "Due today" breakdown on the payment step and the label on its button.
 *
 * The total is the catalog's `firstInvoiceUsd`, and the two lines above it are
 * the catalog's `recurringUsd` and the package's own fee, so the breakdown
 * cannot fail to add up to the number the button promises to charge. Stripe
 * bills the same two prices on the same first invoice (see lib/billing.ts).
 */
export function dueToday(plan: Plan, interval: BillingInterval): DueToday {
  const recurring = recurringUsd(plan, interval);
  return {
    periodLabel: interval === "year" ? "First year" : "First month",
    recurringUsd: recurring,
    setupFeeUsd: plan.setupFeeUsd,
    totalUsd: firstInvoiceUsd(plan, interval),
    renewsAt:
      interval === "year"
        ? `${usd.format(annualTotalUsd(plan))}/yr`
        : `${usd.format(plan.monthlyUsd)}/mo`,
  };
}

/** "$3,804", the annual invoice, for the line under an annual per-month figure. */
export function annualTotalLabel(plan: Plan): string {
  return usd.format(annualTotalUsd(plan));
}

/** The headline figure on a card for the chosen interval, always stated per month. */
export function monthlyFigureUsd(plan: Plan, interval: BillingInterval): number {
  return interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd;
}
