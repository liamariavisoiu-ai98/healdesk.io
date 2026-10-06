import type { NoticePayloads } from "@/lib/billing/notices";

import { dayShort, money, momentLong, portalUrl, WHEN_AYA_STOPS } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: grace ends in 24 hours (Annex X5; the billing sweep enqueues it, BD18).
 *
 * The last warning before AYA stops answering, so it gives the exact moment in
 * the clinic's own time, what changes then, and that paying afterwards still
 * restores everything at once (Terms §6). The day is in the subject, since
 * that is the line an owner reads on a phone; it says when AYA stops rather
 * than "pay by", because grace can end in the small hours of that day.
 */

export type GraceEndingPayload = NoticePayloads["grace_ending"];

export const renderGraceEnding: EmailTemplate<GraceEndingPayload> = (payload, ctx) => {
  const invoice =
    payload.amountDueCents === null
      ? "Your healdesk invoice is still unpaid."
      : `Your healdesk invoice for ${money(payload.amountDueCents)} is still unpaid.`;
  return compose(
    {
      subject: `AYA stops answering on ${dayShort(payload.graceEndsAt, ctx)} unless your invoice is paid`,
      preheader: invoice,
      blocks: [
        {
          type: "paragraph",
          text: `${invoice} AYA keeps answering until ${momentLong(payload.graceEndsAt, ctx)}.`,
        },
        {
          type: "paragraph",
          text: `If it's still unpaid then, she stops answering on every channel: ${WHEN_AYA_STOPS}. Paying the invoice afterwards restores everything at once.`,
        },
        payload.hostedInvoiceUrl
          ? { type: "action", label: "Pay the invoice", url: payload.hostedInvoiceUrl }
          : { type: "action", label: "Update your card", url: portalUrl() },
      ],
    },
    ctx,
  );
};

export const GRACE_ENDING_ENTRY: TemplateEntry<GraceEndingPayload> = {
  render: renderGraceEnding,
  fixture: {
    graceEndsAt: "2026-10-13T14:32:00.000Z",
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    amountDueCents: 89_700,
  },
};
