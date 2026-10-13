import { getPlan, planStartSentence, type BillingInterval } from "@healdesk/catalog";

import { formatReplyBy } from "@/lib/reply-by";

import { includedEachMonth } from "./billing-copy";
import { compose, EmailCompositionError } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * B3: "Your order is confirmed: one step on our side" (Annex X5). Sent once,
 * to the address that paid, when provisioning refused a paid purchase.
 *
 * The buyer has paid and has no account, and /welcome has just told them
 * we'll write by a named day. This email says the same in writing, with the
 * order's terms (B1's: what was bought, at which steps, and when billing
 * starts), so the terms are on record from the first day even though the
 * welcome email has to wait for the account. Ops is told separately
 * (notifyOps).
 */

export type OrderConfirmedDelayedPayload = {
  planId: string;
  interval: BillingInterval;
  /** The next business day, as an ISO date: the day we promise to write by. */
  replyByOn: string;
};

export const renderOrderConfirmedDelayed: EmailTemplate<OrderConfirmedDelayedPayload> = (
  payload,
  ctx,
) => {
  const plan = getPlan(payload.planId);
  if (!plan) throw new EmailCompositionError(`There is no plan "${payload.planId}".`);
  const replyBy = formatReplyBy(payload.replyByOn);
  const audience = ctx.audience === "clients" ? "client" : "patient";
  const account = ctx.clinicName ? `${ctx.clinicName}'s account` : "your account";

  return compose(
    {
      subject: "Your healdesk order is confirmed: one step on our side",
      preheader: `Your payment is safe. We'll email your sign-in link by ${replyBy}.`,
      blocks: [
        {
          type: "paragraph",
          text: "Thank you for your order. Your payment went through, and it is safe.",
        },
        {
          type: "paragraph",
          text: `Setting up ${account} needs one step on our side. We'll email your sign-in link to this address by ${replyBy}. There's nothing you need to do before then.`,
        },
        {
          type: "facts",
          rows: [
            ["Package", plan.packageName],
            ["Included each month", includedEachMonth(plan)],
            ["Billing", payload.interval === "year" ? "Annual" : "Monthly"],
          ],
        },
        {
          type: "paragraph",
          text: `${planStartSentence(plan, payload.interval, audience)} The setup fee is non-refundable.`,
        },
        {
          type: "paragraph",
          text: "If you have a question in the meantime, reply to this email and a person will answer.",
        },
      ],
    },
    ctx,
  );
};

export const ORDER_CONFIRMED_DELAYED_ENTRY: TemplateEntry<OrderConfirmedDelayedPayload> = {
  render: renderOrderConfirmedDelayed,
  fixture: { planId: "voice-webchat-500-300", interval: "month", replyByOn: "2026-10-07" },
};
