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
 * restores everything at once (Terms §6). It says "what you owe" rather than
 * "the invoice": a second failed invoice keeps grace running out until both
 * are paid (R10). The day is in the subject, since
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
      subject: `AYA stops answering on ${dayShort(payload.graceEndsAt, ctx)} unless ${payload.amountDueCents === null ? "what you owe is paid" : `you pay ${money(payload.amountDueCents)}`}`,
      preheader: invoice,
      blocks: [
        {
          type: "paragraph",
          text: `${invoice} AYA keeps answering until ${momentLong(payload.graceEndsAt, ctx)}.`,
        },
        {
          type: "paragraph",
          text: `If what you owe is still unpaid then, AYA stops answering: ${WHEN_AYA_STOPS}. Paying any time after that turns her back on at once.`,
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
    amountDueCents: 52_000,
  },
};
