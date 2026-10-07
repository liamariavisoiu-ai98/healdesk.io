import type { NoticePayloads } from "@/lib/billing/notices";

import { money, momentLong, person, portalUrl, WHEN_AYA_STOPS } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: a payment failed (Annex X5). Critical, so it goes in-process right
 * after the Stripe event commits.
 *
 * The one action is paying the open invoice on Stripe's hosted page, which
 * takes a new card if the old one is the problem; without that link, the card
 * is updated from Billing. The email names the moment AYA stops answering, in
 * the clinic's own time, because "you have a few days" is not a deadline (the
 * Terms' seven days of grace, §6). The first plan charge has its own opening:
 * the clinic was never told its plan had started (L2 goes only once a charge
 * succeeds), so "your payment failed" alone would not make sense.
 */

export type PaymentFailedPayload = NoticePayloads["payment_failed"];

export const renderPaymentFailed: EmailTemplate<PaymentFailedPayload> = (payload, ctx) => {
  const amount = money(payload.amountDueCents);
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: payload.isFirstPlanCharge
        ? `AYA answered her first ${person(ctx)}, which starts your healdesk plan, but the first charge of ${amount} didn't go through.`
        : `We couldn't take your healdesk payment of ${amount}.`,
    },
    {
      type: "paragraph",
      text: payload.graceEndsAt
        ? `AYA keeps answering until ${momentLong(payload.graceEndsAt, ctx)}. If the invoice is still unpaid then, she stops answering on every channel: ${WHEN_AYA_STOPS}, until it's paid.`
        : `Please pay it as soon as you can. If it stays unpaid, AYA stops answering on every channel: ${WHEN_AYA_STOPS}.`,
    },
    payload.hostedInvoiceUrl
      ? { type: "action", label: "Pay the invoice", url: payload.hostedInvoiceUrl }
      : { type: "action", label: "Update your card", url: portalUrl() },
    {
      type: "paragraph",
      text: payload.hostedInvoiceUrl
        ? "The invoice page takes a different card if this one is the problem."
        : "Sign in and update your card from Billing.",
    },
  ];

  return compose(
    {
      subject: payload.isFirstPlanCharge
        ? "Your first healdesk charge didn't go through"
        : "Your healdesk payment didn't go through",
      preheader: payload.hostedInvoiceUrl
        ? `Pay the ${amount} invoice to keep AYA answering.`
        : "Update your card to keep AYA answering.",
      blocks,
    },
    ctx,
  );
};

export const PAYMENT_FAILED_ENTRY: TemplateEntry<PaymentFailedPayload> = {
  render: renderPaymentFailed,
  fixture: {
    amountDueCents: 89_700,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    graceEndsAt: "2026-10-13T14:32:00.000Z",
    isFirstPlanCharge: false,
  },
};
