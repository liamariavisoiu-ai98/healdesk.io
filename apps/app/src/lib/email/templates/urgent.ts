import { compose } from "./compose";
import { alertFixture, findThem, findThemShort, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
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
 * reply, never what they said. Each urgent conversation is its own email,
 * never folded into another (the spec: urgent messages go "immediately"),
 * so there is no burst wording here.
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

/**
 * What staff are asked to do. On WhatsApp there is no inbox and no number to
 * reach them on (findThem "whatsapp"), so the email never asks staff to check
 * on them: the fixed reply gave them the practice's number, and they may call.
 */
function askOf(payload: BookingAlertPayload): string {
  return findThem(payload) === "whatsapp" ? "They may call you." : "Please check on them now.";
}

export const renderUrgent: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: subjectFor(payload),
      preheader: `${askOf(payload)} ${findThemShort(payload)}`,
      blocks: [
        {
          type: "paragraph",
          text: `Someone described a complication or an urgent symptom ${wherePhrase(payload)} ${practiceOf(ctx)}. AYA gave them the fixed urgent reply, which sends them to emergency help first and then to your practice. ${askOf(payload)}`,
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
