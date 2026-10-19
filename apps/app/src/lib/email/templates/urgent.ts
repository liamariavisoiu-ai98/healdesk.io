import { compose } from "./compose";
import { alertFixture, findThemShort, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
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
 * reply, never what they said. Past the hour's cap on one channel
 * (isBurst), one email says more came in and opens Conversations.
 */

function subjectFor(payload: BookingAlertPayload): string {
  if (payload.isBurst === true) {
    switch (payload.channel) {
      case "voice":
        return "Urgent: more urgent calls this hour";
      case "web":
        return "Urgent: more urgent messages in your website chat this hour";
      case "meta":
        return "Urgent: more urgent messages to AYA this hour";
      default:
        return "Urgent: more urgent messages this hour";
    }
  }
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
      preheader: `Please check on them now. ${findThemShort(payload)}`,
      blocks: [
        {
          type: "paragraph",
          text:
            payload.isBurst === true
              ? `More people described a complication or an urgent symptom ${wherePhrase(payload.channel)} ${practiceOf(ctx)} in the last hour than healdesk emails one by one. AYA gave each of them the fixed urgent reply, which sends them to emergency help first and then to your practice. Please check on them now.`
              : `Someone described a complication or an urgent symptom ${wherePhrase(payload.channel)} ${practiceOf(ctx)}. AYA gave them the fixed urgent reply, which sends them to emergency help first and then to your practice. Please check on them now.`,
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
