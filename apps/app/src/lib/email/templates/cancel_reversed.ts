import type { NoticePayloads } from "@/lib/billing/notices";

import { person } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E1: auto-renew was turned back on (Annex X5), sent from the webhook that saw
 * it. Nothing to do, so no action: it confirms the plan carries on, or, before
 * the plan has started, that it starts with AYA's first answer and nothing more
 * is charged until then.
 */

export type CancelReversedPayload = NoticePayloads["cancel_reversed"];

export const renderCancelReversed: EmailTemplate<CancelReversedPayload> = (payload, ctx) =>
  compose(
    payload.isBeforeStart
      ? {
          subject: "Auto-renew is back on: your plan starts when AYA first answers",
          preheader: "Nothing more is charged until then.",
          blocks: [
            {
              type: "paragraph",
              text: `Auto-renew is back on. Your healdesk plan starts the day AYA first answers a ${person(ctx)}, and nothing more is charged until then.`,
            },
          ],
        }
      : {
          subject: "Auto-renew is back on: your healdesk plan continues",
          preheader: "Nothing else changes.",
          blocks: [
            {
              type: "paragraph",
              text: "Auto-renew is back on, so your healdesk plan carries on as before. Nothing else changes.",
            },
          ],
        },
    ctx,
  );

export const CANCEL_REVERSED_ENTRY: TemplateEntry<CancelReversedPayload> = {
  render: renderCancelReversed,
  fixture: { isBeforeStart: true },
};
