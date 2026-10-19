import type { ForwardingFacts } from "@/lib/billing/notices";

import { dayLong, dayShort, undoForwarding } from "./billing-copy";
import { compose } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * E3, "Calls stop passing through on {date}" (Annex X5): 7 days and 1 day
 * before the pass-through ends, and only while calls were still being
 * forwarded to us in the last 14 days (lib/offboarding/after-cancellation.ts
 * decides both and queues it).
 *
 * When the service ends, calls still forwarded to healdesk pass straight
 * through to the clinic's direct line for the Terms' pass-through days (§7,
 * FORWARDING_PASS_THROUGH_DAYS, counted from the end, as E2 counts them).
 * This is the reminder that they stop, with the steps for undoing the
 * forwarding on the clinic's own carrier: the catalog's undo codes, through
 * the same helper E2 and the suspension email use, so a code we are not sure
 * of is never printed.
 *
 * The date is printed, never "tomorrow": the email waits for the clinic's
 * daytime, so the day it is read may not be the day it was queued.
 */

export type PassThroughEndingPayload = {
  /** The end of the service plus the pass-through days: when forwarded calls stop reaching the direct line. */
  passThroughEndsAt: string;
  /** Which of the two this is: a week ahead, or a day ahead. */
  noticeDays: 7 | 1;
} & ForwardingFacts;

export const renderPassThroughEnding: EmailTemplate<PassThroughEndingPayload> = (payload, ctx) => {
  const clinic = ctx.clinicName ?? "your practice";
  const ends = dayLong(payload.passThroughEndsAt, ctx);
  return compose(
    {
      subject: `Calls stop passing through on ${dayShort(payload.passThroughEndsAt, ctx)}`,
      preheader:
        payload.noticeDays === 1
          ? `Undo your call forwarding now, so callers keep reaching you after ${dayShort(payload.passThroughEndsAt, ctx)}.`
          : `Undo your call forwarding this week, so callers keep reaching you after ${dayShort(payload.passThroughEndsAt, ctx)}.`,
      blocks: [
        {
          type: "paragraph",
          text: `Calls to ${clinic} were still being forwarded to healdesk in the last 14 days. Since your service ended we have passed them straight through to your direct line, and that stops on ${ends}. After that, a call still forwarded to us won't reach you.`,
        },
        ...undoForwarding(
          payload,
          `Undo the forwarding before ${ends}, so callers keep reaching you directly.`,
        ),
        {
          type: "paragraph",
          text: "Once it's undone, calls ring your own line as they did before healdesk, and nothing is forwarded to us.",
        },
      ],
    },
    ctx,
  );
};

export const PASS_THROUGH_ENDING_ENTRY: TemplateEntry<PassThroughEndingPayload> = {
  render: renderPassThroughEnding,
  fixture: {
    passThroughEndsAt: "2026-12-06T14:32:00.000Z",
    noticeDays: 7,
    carrier: "att",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  },
};
