import { FIRST_PERIOD_REFUND_DAYS } from "@healdesk/catalog";

import type { NoticePayloads } from "@/lib/billing/notices";

import { dayLong, money } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L27: a refund was issued (Annex X5), from the operator's commitRefund or a
 * refund Stripe reports. Never a setup-fee refund: there is none (R0,
 * amendment 5), so no wording here offers one.
 *
 * The amount, the card it went back to and what it was for. The first-period
 * refund also ends the plan (BD14, R15), which the clinic hears about
 * separately when the subscription ends, with the steps for its calls and its
 * data; the guarantee refund leaves the plan running.
 */

export type RefundIssuedPayload = NoticePayloads["refund_issued"];

const WHAT_FOR: Record<RefundIssuedPayload["kind"], string> = {
  first_period_cancel: `It refunds your first period's fee in full, under the ${FIRST_PERIOD_REFUND_DAYS}-day refund in our Terms, and your plan is cancelled with it. A separate email confirms when your service has ended, with what happens to your calls and your data.`,
  guarantee:
    "It's your first-month guarantee refund: one month's fee. Your plan carries on as before.",
  other: "If you have a question about it, reply to this email.",
};

export const renderRefundIssued: EmailTemplate<RefundIssuedPayload> = (payload, ctx) => {
  const amount = money(payload.amountCents);
  return compose(
    {
      subject: `We've refunded ${amount} to your card`,
      preheader: "Refunds usually take 5 to 10 business days to reach your account.",
      blocks: [
        {
          type: "paragraph",
          text: `On ${dayLong(payload.refundedAt, ctx)} we refunded ${amount} to the card you paid healdesk with.`,
        },
        { type: "paragraph", text: WHAT_FOR[payload.kind] },
        {
          type: "paragraph",
          text: "Refunds usually take 5 to 10 business days to reach your account, depending on your bank.",
        },
      ],
    },
    ctx,
  );
};

export const REFUND_ISSUED_ENTRY: TemplateEntry<RefundIssuedPayload> = {
  render: renderRefundIssued,
  fixture: {
    amountCents: 89_700,
    kind: "first_period_cancel",
    refundedAt: "2026-10-06T14:20:00.000Z",
  },
};
