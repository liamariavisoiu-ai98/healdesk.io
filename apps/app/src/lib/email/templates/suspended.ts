import type { NoticePayloads } from "@/lib/billing/notices";

import { money, portalUrl, undoForwarding, WHEN_AYA_STOPS } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: the service is suspended (Annex X5). Critical.
 *
 * A suspension has more than one cause (grace ran out, the invoice went
 * unpaid, a dispute, an operator), and the payload names none of them, only
 * the open invoice when there is one. So the copy blames an unpaid invoice
 * only when it has one to point at, and otherwise asks the clinic to reply.
 *
 * It says what still works (calls reach the direct line, the data is kept,
 * the portal still signs in: Terms §6) and, from the catalog, how to undo call
 * forwarding for the clinic's own carrier if it would rather calls did not
 * come through us at all meanwhile (R31). The payload carries no channel list,
 * so that part is worded for a clinic whose line forwards to AYA.
 */

export type SuspendedPayload = NoticePayloads["suspended"];

export const renderSuspended: EmailTemplate<SuspendedPayload> = (payload, ctx) => {
  const owesInvoice = payload.amountDueCents !== null || payload.hostedInvoiceUrl !== null;
  const invoice =
    payload.amountDueCents === null
      ? "Your healdesk invoice"
      : `Your healdesk invoice for ${money(payload.amountDueCents)}`;

  const action: Block[] = payload.hostedInvoiceUrl
    ? [{ type: "action", label: "Pay the invoice", url: payload.hostedInvoiceUrl }]
    : owesInvoice
      ? [{ type: "action", label: "Update your card", url: portalUrl() }]
      : [];

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: owesInvoice
        ? `${invoice} is unpaid, so we've suspended your service.`
        : "We've suspended your healdesk service.",
    },
    {
      type: "paragraph",
      text: `AYA has stopped answering on every channel: ${WHEN_AYA_STOPS}. Your data is kept, and you can still sign in to healdesk.`,
    },
    ...action,
    {
      type: "paragraph",
      text: owesInvoice
        ? "Paying the invoice restores everything at once."
        : "Reply to this email and we'll tell you what's needed to restore it.",
    },
    ...undoForwarding(
      payload,
      "If your clinic's line forwards to AYA, you can undo that while this is sorted out.",
    ),
  ];

  return compose(
    {
      subject: "AYA has stopped answering: your healdesk service is suspended",
      preheader: owesInvoice
        ? "Paying the invoice restores everything at once."
        : "Reply to this email and we'll help you restore it.",
      blocks,
    },
    ctx,
  );
};

export const SUSPENDED_ENTRY: TemplateEntry<SuspendedPayload> = {
  render: renderSuspended,
  fixture: {
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_testplatform/test_invoice",
    amountDueCents: 89_700,
    carrier: "verizon",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  },
};
