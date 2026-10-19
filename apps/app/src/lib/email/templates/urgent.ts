import { compose } from "./compose";
import { alertFixture, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L12, URGENT (Annex X5): the urgent matcher fired. Queued by
 * notifyBookingAlert in the transaction that records the urgent message, on
 * every channel, once per conversation (once per call while the call is
 * up), and the one critical alert: it goes in-process the moment that
 * transaction commits (deliverCriticalAfterCommit), at any hour, and a copy
 * still unsent ten minutes later turns /api/health red.
 *
 * A pointer like the other alerts (booking-alert-copy.ts): that someone
 * reported something urgent, where, and that AYA gave the fixed urgent
 * reply, never what they said.
 */

function subjectFor(payload: BookingAlertPayload): string {
  switch (payload.channel) {
    case "voice":
      return "Urgent: AYA heard something urgent on a call";
    case "web":
      return "Urgent: someone wrote something urgent in your website chat";
    case "meta":
      return "Urgent: someone sent AYA an urgent message";
    default:
      return "Urgent: someone told AYA about something urgent";
  }
}

export const renderUrgent: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: subjectFor(payload),
      preheader: "Please check on them now. Open healdesk to see who it is.",
      blocks: [
        {
          type: "paragraph",
          text: `Someone described a complication or an urgent symptom ${wherePhrase(payload.channel)} ${practiceOf(ctx)}. AYA gave them the fixed urgent reply, which sends them to emergency help first and then gives your urgent-help number. Please check on them now.`,
        },
        ...openBlocks(payload, ctx),
      ],
    },
    ctx,
  );

export const URGENT_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderUrgent,
  // A call still going on: no conversation to open yet.
  get fixture(): BookingAlertPayload {
    return alertFixture({ channel: "voice", conversationId: null });
  },
};
