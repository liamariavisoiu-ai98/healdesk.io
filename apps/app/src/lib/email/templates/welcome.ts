import {
  annualTotalUsd,
  audienceSingular,
  CHANNEL_NAMES,
  getPlan,
  planStartSentence,
  type BillingInterval,
  type Channel,
} from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";
import { setupLine } from "@/lib/setup/channels";
import { formatPhone } from "@/lib/setup/help";
import { publicUrl } from "@/lib/public-url";

import { EXTRA_BLOCKS_PROVISIONAL, extraBlockPrices, includedEachMonth } from "./billing-copy";
import { compose, EmailCompositionError, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * B1: "Welcome: your order is confirmed" (plan Part C4, Annex X5), once per
 * clinic, sent the moment provisioning commits.
 *
 * It is the order's written record from the first day, so it carries the
 * terms the buyer agreed to: the package, the steps chosen (what it includes
 * each month) and the billing period, the extra-100 prices, marked
 * provisional (owner, 13 October 2026), the plan-start sentence and the
 * monthly price, the setup fee's rule and its receipt
 * (Stripe's hosted page for the paid first invoice: no separate receipt goes
 * for that invoice, contracts §3), how to cancel, and the Terms version
 * accepted at checkout, with the signed agreement's download. Then the way
 * back into setup: a fresh single-use "Continue setup" link for 72 hours,
 * which makes this a link email (X1.5), sent straight and never through the
 * outbox. Each bought channel's status is in words, never a date (owner,
 * 6 October 2026). Help closes it.
 *
 * Cancelling online is Billing's Auto-renew switch (plan Part F6): off before
 * the plan starts means it never starts and nothing more is charged. The
 * email names the switch and links Billing, as it names the agreement and
 * links its download; both are portal pages, behind the clinic's sign-in,
 * so neither link carries a token (X1.5: only "Continue setup" does).
 */

export type WelcomePayload = {
  planId: string;
  interval: BillingInterval;
  /** The bought channels, in the catalog's order. */
  channels: Channel[];
  /** publicUrl("/link/<token>"), landing on the wizard: the only place the token is written. */
  continueUrl: string;
  /** How long the link works, from SIGN_IN_LINK_TTL_MS.welcome. */
  validHours: number;
  /** The Terms version accepted at checkout, or null when the purchase recorded none. */
  version: string | null;
  /**
   * Stripe's hosted page for the paid first invoice, where the setup-fee
   * receipt is; null for a purchase that did not come through Stripe.
   */
  receiptUrl: string | null;
  /** The last day of the setup window, as an ISO date on the clinic's calendar. */
  setupEndsOn: string;
  /** The support voicemail line, while the owner has set one. */
  helpPhoneE164: string | null;
  /** This app's /help/call, while a scheduling page is set. */
  callUrl: string | null;
  /** publicUrl("/c/<slug>/billing#switches"): Auto-renew, the way to cancel online. */
  billingUrl: string;
  /** publicUrl("/c/<slug>/billing/agreement"): the signed agreement, as a PDF. */
  agreementUrl: string;
};

export const renderWelcome: EmailTemplate<WelcomePayload> = (payload, ctx) => {
  const plan = getPlan(payload.planId);
  if (!plan) throw new EmailCompositionError(`There is no plan "${payload.planId}".`);
  const clinic = ctx.clinicName ?? "your practice";
  const audience = audienceSingular(ctx.audience);
  const usd = (amount: number) => `$${amount.toLocaleString("en-US")}`;
  // The monthly price either way, as checkout quoted it: an annual plan's is
  // its per-month price, billed as the year's total.
  const price: [string, string] =
    payload.interval === "year"
      ? [
          "Price",
          `${usd(plan.annualMonthlyUsd)} a month, billed annually (${usd(annualTotalUsd(plan))} a year)`,
        ]
      : ["Monthly price", usd(plan.monthlyUsd)];
  const setupEnds = formatReplyBy(payload.setupEndsOn);

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Thank you for your order. ${clinic}'s AYA is ready for you to set up: four short steps, about fifteen minutes of your time.`,
    },
    { type: "action", label: "Continue setup", url: payload.continueUrl },
    {
      type: "paragraph",
      text: `The button works once, for the next ${payload.validHours} hours. After that, sign in at ${publicUrl("/sign-in")} with this address and setup picks up where you left it.`,
    },
    {
      type: "list",
      items: [
        "Your practice: check what we read from your website",
        "How AYA works: tone, greetings and where urgent calls go",
        "Calendar: how bookings reach your team",
        "Your channels: what each one needs from you",
      ],
    },
    {
      type: "paragraph",
      text: `Each step saves as you finish it, so you can stop and come back. You have until ${setupEnds} to finish: if nothing is answering ${audience}s by the end of that day, the account closes. We'll remind you before then.`,
    },
    { type: "paragraph", text: "Your channels:" },
    {
      type: "list",
      items: payload.channels.map((channel) => setupLine(channel, "finish_setup")),
    },
    { type: "paragraph", text: "Your order:" },
    {
      type: "facts",
      rows: [
        ["Package", plan.packageName],
        ["Included each month", includedEachMonth(plan)],
        ["Channels", payload.channels.map((c) => CHANNEL_NAMES[c]).join(", ")],
        ["Billing", payload.interval === "year" ? "Annual" : "Monthly"],
        price,
        ["Past the allowance", extraBlockPrices(plan).join(", and ")],
        ...(payload.receiptUrl ? [["Setup fee", "Paid"] as const] : []),
      ],
    },
    { type: "paragraph", text: EXTRA_BLOCKS_PROVISIONAL },
    ...(payload.receiptUrl
      ? [{ type: "action" as const, label: "Your setup-fee receipt", url: payload.receiptUrl }]
      : []),
    {
      type: "paragraph",
      text: `${planStartSentence(plan, payload.interval, audience)} Until then, nothing more is charged. The setup fee is non-refundable.`,
    },
    {
      type: "paragraph",
      text: "To cancel online, turn off Auto-renew in Billing. Before your plan starts, that means it won't start, and nothing more is charged.",
    },
    { type: "action", label: "Open Billing", url: payload.billingUrl },
    {
      type: "paragraph",
      text: payload.version
        ? `Your order is under healdesk's Terms of Service, version ${payload.version}, at healdesk.io/terms. Your signed agreement is in Billing too.`
        : "Your order is under healdesk's Terms of Service, at healdesk.io/terms. Your signed agreement is in Billing too.",
    },
    { type: "action", label: "Download your signed agreement (PDF)", url: payload.agreementUrl },
    { type: "paragraph", text: helpLine(payload, audience) },
  ];
  if (payload.callUrl) {
    blocks.push({ type: "action", label: "Book a five-minute call", url: payload.callUrl });
  }

  return compose(
    {
      subject: "Welcome to healdesk: your order is confirmed",
      preheader: "Continue setup: four short steps, about fifteen minutes.",
      blocks,
    },
    ctx,
  );
};

/**
 * Help, as the wizard's panel offers it (plan Part F7): the inbox always, and
 * the voicemail line, in the plan's words, while one is set.
 */
export function helpLine(
  payload: { helpPhoneE164: string | null },
  audience: "patient" | "client",
): string {
  const phone = payload.helpPhoneE164
    ? ` Or leave a message on ${formatPhone(payload.helpPhoneE164)}: we reply the next business day. Please don't include ${audience} details.`
    : "";
  return `Questions? Reply to this email, or write to hello@healdesk.io.${phone}`;
}

/** Token-shaped and never issued: what the snapshot tests and the seed script render. */
const FIXTURE_TOKEN = "kP3vXq9TzR7wYb2NcL5mHs8JdF4gA6eU1oIiQ0yBtVx";

export const WELCOME_ENTRY: TemplateEntry<WelcomePayload> = {
  render: renderWelcome,
  // A getter, so the links are built from BETTER_AUTH_URL when a test or the
  // seed script reads it, not when this module loads.
  get fixture(): WelcomePayload {
    return {
      planId: "voice-webchat-500-300",
      interval: "month",
      channels: ["web", "voice"],
      continueUrl: publicUrl(`/link/${FIXTURE_TOKEN}`),
      validHours: 72,
      version: "2026-10-07.1",
      receiptUrl: "https://invoice.stripe.com/i/acct_1Pfixture/test_YWNjdF8xUGZpeHR1cmU",
      setupEndsOn: "2026-11-06",
      helpPhoneE164: "+18885550100",
      callUrl: publicUrl("/help/call"),
      billingUrl: publicUrl("/c/glow-med-spa/billing#switches"),
      agreementUrl: publicUrl("/c/glow-med-spa/billing/agreement"),
    };
  },
};
