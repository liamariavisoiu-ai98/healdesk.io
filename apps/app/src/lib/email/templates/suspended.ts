import type { NoticePayloads } from "@/lib/billing/notices";

import { money, portalUrl, undoForwarding, WHEN_AYA_STOPS } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the service is suspended (Annex X5). Critical.
 *
 * A suspension has more than one cause, and the payload names it (`kind`).
 * Grace running out and Stripe's `unpaid` are suspensions for not paying: the
 * copy blames the unpaid invoice when it has one to point at, and says paying
 * what is owed restores everything, because a payment lifts exactly those two
 * (R10), once no other invoice is still owed. So it never promises that this
 * one invoice is enough: a second failed invoice keeps the service suspended,
 * and paying the first sends this email again for the next. A
 * dispute or an operator's suspension is another matter: paying lifts neither
 * (settlePayment refuses), so that copy never says an invoice caused it and
 * never promises a payment brings AYA back. It asks the clinic to reply, and
 * names an invoice still open only as money still owed. Without an invoice to
 * point at, every cause asks the clinic to reply.
 *
 * It says what still works (calls reach the direct line, the data is kept,
 * the portal still signs in: Terms §6) and, from the catalog, how to undo call
 * forwarding for the clinic's own carrier if it would rather calls did not
 * come through us at all meanwhile (R31). The payload carries no channel list,
 * so that part is worded for a clinic whose line forwards to AYA.
 */

export type SuspendedPayload = NoticePayloads["suspended"];

export const renderSuspended: EmailTemplate<SuspendedPayload> = (payload, ctx) => {
  const forNotPaying = payload.kind === "grace_expired" || payload.kind === "unpaid";
  const owesInvoice = payload.amountDueCents !== null || payload.hostedInvoiceUrl !== null;
  // The one case a payment restores the service by itself (R10).
  const paymentRestores = forNotPaying && owesInvoice;
  const invoice =
    payload.amountDueCents === null
      ? "Your healdesk invoice"
      : `Your healdesk invoice for ${money(payload.amountDueCents)}`;

  const action: Block[] = payload.hostedInvoiceUrl
    ? [{ type: "action", label: "Pay the invoice", url: payload.hostedInvoiceUrl }]
    : paymentRestores
      ? [{ type: "action", label: "Update your card", url: portalUrl() }]
      : [];

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: paymentRestores
        ? `${invoice} is unpaid, so we've suspended your service.`
        : payload.kind === "dispute"
          ? "A payment to healdesk has been disputed with your bank, so we've suspended your service."
          : "We've suspended your healdesk service.",
    },
    {
      type: "paragraph",
      text: `AYA has stopped answering: ${WHEN_AYA_STOPS}. Your data is kept, and you can still sign in to healdesk.`,
    },
    ...(owesInvoice && !forNotPaying
      ? [
          {
            type: "paragraph",
            text: `${invoice} is also still unpaid. Paying it settles what's owed, but doesn't restore the service on its own.`,
          } as const,
        ]
      : []),
    ...action,
    {
      type: "paragraph",
      text: paymentRestores
        ? "Paying what you owe healdesk restores everything at once."
        : "Reply to this email and we'll tell you what's needed to restore it.",
    },
    ...undoForwarding(
      payload,
      "If your clinic's line forwards to AYA, you can undo that while this is sorted out.",
    ),
  ];

  return compose(
    {
      subject: paymentRestores
        ? `AYA has stopped answering because ${payload.amountDueCents === null ? "your invoice is" : `${money(payload.amountDueCents)} is`} unpaid`
        : "AYA has stopped answering: your healdesk service is suspended",
      preheader: paymentRestores
        ? "Paying what you owe healdesk restores everything at once."
        : "Reply to this email and we'll help you restore it.",
      blocks,
    },
    ctx,
  );
};

export const SUSPENDED_ENTRY: TemplateEntry<SuspendedPayload> = {
  render: renderSuspended,
  fixture: {
    kind: "grace_expired",
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    amountDueCents: 52_000,
    carrier: "verizon",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  },
};
