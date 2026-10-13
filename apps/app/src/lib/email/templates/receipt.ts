import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline, dayLong, dayShort, money } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: a receipt (Annex X5), for a paid invoice above $0 that no other email
 * covers: a renewal, mostly, since a plan start, a step-up, a plan change, an
 * added location, a lifted suspension and an annual overage each carry their
 * own (X3's merges). Stripe's own receipts are switched off once this is live
 * (X7).
 *
 * The amount, the period it pays for when the invoice has one, Stripe's
 * hosted receipt, and how to cancel online, which Visa recommends on every
 * subscription receipt (X7).
 */

export type ReceiptPayload = NoticePayloads["receipt"];

export const renderReceipt: EmailTemplate<ReceiptPayload> = (payload, ctx) => {
  const amount = money(payload.amountCents);
  const period =
    payload.periodStartsOn && payload.periodEndsOn
      ? ` It covers ${dayLong(payload.periodStartsOn, ctx)} to ${dayLong(payload.periodEndsOn, ctx)}.`
      : "";
  const receipt: Block[] = payload.hostedInvoiceUrl
    ? [{ type: "action", label: "View your receipt", url: payload.hostedInvoiceUrl }]
    : [];

  return compose(
    {
      subject: `Your healdesk receipt for ${amount}`,
      preheader:
        payload.periodEndsOn === null
          ? `Your payment of ${amount} went through.`
          : `Your payment of ${amount} went through, for the period to ${dayShort(payload.periodEndsOn, ctx)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `Thank you: your healdesk payment of ${amount} went through.${period}`,
        },
        ...receipt,
        cancelOnline(),
      ],
    },
    ctx,
  );
};

export const RECEIPT_ENTRY: TemplateEntry<ReceiptPayload> = {
  render: renderReceipt,
  fixture: {
    amountCents: 52_000,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    periodStartsOn: "2026-10-06",
    periodEndsOn: "2026-11-06",
  },
};
