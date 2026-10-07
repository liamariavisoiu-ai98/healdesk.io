import type { NoticePayloads } from "@/lib/billing/notices";

import { money, portalUrl } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the clinic's bank wants the payment confirmed (Annex X5). Critical.
 *
 * Nothing has failed yet: the bank is asking for its own check, so the email
 * says that plainly rather than reading like a decline. Stripe's hosted
 * invoice page runs the check; without that link the clinic confirms it from
 * Billing, where Stripe's portal holds the invoice.
 */

export type PaymentActionRequiredPayload = NoticePayloads["payment_action_required"];

export const renderPaymentActionRequired: EmailTemplate<PaymentActionRequiredPayload> = (
  payload,
  ctx,
) => {
  const amount = money(payload.amountDueCents);
  return compose(
    {
      subject: "Your bank needs you to confirm a healdesk payment",
      preheader: `Confirm the ${amount} payment so it can go through.`,
      blocks: [
        {
          type: "paragraph",
          text: `Your bank wants you to confirm your healdesk payment of ${amount} before it goes through. It's a security check your bank runs on some payments, not a problem with your card.`,
        },
        payload.hostedInvoiceUrl
          ? { type: "action", label: "Confirm the payment", url: payload.hostedInvoiceUrl }
          : { type: "action", label: "Confirm it in Billing", url: portalUrl() },
        {
          type: "paragraph",
          text: "Until it's confirmed, the payment hasn't been made.",
        },
      ],
    },
    ctx,
  );
};

export const PAYMENT_ACTION_REQUIRED_ENTRY: TemplateEntry<PaymentActionRequiredPayload> = {
  render: renderPaymentActionRequired,
  fixture: {
    amountDueCents: 89_700,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
  },
};
