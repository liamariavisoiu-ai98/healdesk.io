import { FIRST_PERIOD_REFUND_DAYS } from "@healdesk/catalog";

import type { NoticePayloads } from "@/lib/billing/notices";
import { formatReplyBy, replyByDay } from "@/lib/reply-by";

import { dayLong, dayShort, people, portalUrl } from "./billing-copy";
import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E1: auto-renew was turned off (Annex X5), sent from the webhook that saw it.
 *
 * Cancelling is the auto-renew switch, so the email's one action is turning it
 * back on, and it says by when. Before the plan has started it has its own
 * variant, in the portal's words (plan F6): the plan won't start and nothing
 * more is charged; and while auto-renew is off AYA does not answer, because
 * the answer gate refuses a plan that is set to close before it starts (BD9).
 *
 * Turning it off inside the first-period refund window makes a refund due
 * (R15): ops is alerted at the same moment, and the email promises a reply by
 * a named day (X1.3), reckoned from when the notice was raised so a retry
 * renders the same day.
 */

export type CancelScheduledPayload = NoticePayloads["cancel_scheduled"];

export const renderCancelScheduled: EmailTemplate<CancelScheduledPayload> = (payload, ctx) => {
  const action: Block = { type: "action", label: "Turn auto-renew back on", url: portalUrl() };

  if (payload.isBeforeStart) {
    return compose(
      {
        subject: "Your healdesk plan won't start",
        preheader: "Auto-renew is off, so nothing more is charged.",
        blocks: [
          {
            type: "paragraph",
            text: "Auto-renew is off, so your plan won't start, and nothing more is charged.",
          },
          { type: "paragraph", text: `While it's off, AYA doesn't answer ${people(ctx)}.` },
          {
            type: "paragraph",
            text: `Changed your mind? Turn auto-renew back on in Billing any time before ${dayLong(payload.endsAt, ctx)}.`,
          },
          action,
        ],
      },
      ctx,
    );
  }

  const ends = dayLong(payload.endsAt, ctx);
  const refund: Block[] = payload.refundWindowEndsOn
    ? [
        {
          type: "paragraph",
          text: `Because you turned it off within ${FIRST_PERIOD_REFUND_DAYS} days of your plan starting, your first period's fee is due back to you in full. We'll email you by ${formatReplyBy(replyByDay(ctx.raisedAt))} to arrange the refund.`,
        },
      ]
    : [];

  return compose(
    {
      subject: `Your healdesk plan ends on ${dayShort(payload.endsAt, ctx)}`,
      preheader: "Turn auto-renew back on before then to keep it.",
      blocks: [
        {
          type: "paragraph",
          text: `Auto-renew is off, so your healdesk plan ends on ${ends}. AYA keeps answering until then.`,
        },
        ...refund,
        {
          type: "paragraph",
          text: "Changed your mind? Turn auto-renew back on in Billing before then, and nothing changes.",
        },
        action,
        {
          type: "paragraph",
          text: "When the plan ends, we'll email you how to undo call forwarding and what happens to your data.",
        },
      ],
    },
    ctx,
  );
};

export const CANCEL_SCHEDULED_ENTRY: TemplateEntry<CancelScheduledPayload> = {
  render: renderCancelScheduled,
  fixture: {
    endsAt: "2026-11-06T14:32:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: "2026-10-20",
  },
};
