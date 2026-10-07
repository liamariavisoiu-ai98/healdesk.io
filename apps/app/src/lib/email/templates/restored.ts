import type { NoticePayloads } from "@/lib/billing/notices";

import { cancelOnline } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: a payment cleared a suspension (Annex X5; R10).
 *
 * The payment's receipt rides on this email rather than a separate one (X3's
 * merges), with how to cancel online beside it. A clinic that undid its call
 * forwarding while suspended, as the suspension email offered, has to set it
 * again, or calls keep going straight to its own line; the email says so.
 */

export type RestoredPayload = NoticePayloads["restored"];

export const renderRestored: EmailTemplate<RestoredPayload> = (payload, ctx) => {
  const receipt: Block[] = payload.receiptUrl
    ? [{ type: "action", label: "View your receipt", url: payload.receiptUrl }, cancelOnline()]
    : [];
  return compose(
    {
      subject: "AYA is answering again: your payment went through",
      preheader: "Your healdesk service is back on.",
      blocks: [
        {
          type: "paragraph",
          text: "Thank you: your payment went through, and your healdesk service is back on. AYA is answering again.",
        },
        {
          type: "paragraph",
          text: "If you undid call forwarding while the service was suspended, set it up again so calls reach AYA. The steps are in healdesk.",
        },
        ...receipt,
      ],
    },
    ctx,
  );
};

export const RESTORED_ENTRY: TemplateEntry<RestoredPayload> = {
  render: renderRestored,
  fixture: { receiptUrl: "https://pay.stripe.com/receipts/invoices/test_receipt" },
};
