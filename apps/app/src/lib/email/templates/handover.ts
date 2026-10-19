import { compose } from "./compose";
import { alertFixture, findThem, findThemShort, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";

/**
 * L11, "Someone asked to speak to a person" (Annex X5): a handover. Queued by
 * notifyBookingAlert when the person asks for a person on a call, in a
 * website chat or in an Instagram, Messenger or WhatsApp message, once per
 * conversation, and sent from the minute queue at any hour.
 *
 * A pointer (booking-alert-copy.ts): that someone asked for a person, where,
 * and how to reach them, never who or why. It says nothing of what AYA told
 * them, because that is not always the same: the model's own words when its
 * reply passes the guard, a fixed line when it does not. The one exception
 * is WhatsApp, where nobody can answer the thread: there answerFrontDoor
 * always sends the fixed line that asks them to call the practice
 * (lib/meta/front-door.ts, whatsAppPersonLine), so the email can say so.
 * Past the hour's cap on a call or in the website chat (isBurst), one email
 * says more asked and opens Conversations, where each is marked.
 */

function bodyOf(payload: BookingAlertPayload, ctx: TemplateContext): string {
  if (payload.isBurst === true) {
    return `More people asked to speak to a person ${wherePhrase(payload)} ${practiceOf(ctx)} in the last hour than healdesk emails one by one, so this email stands for several of them.`;
  }
  const asked = `Someone asked to speak to a person ${wherePhrase(payload)} ${practiceOf(ctx)}.`;
  return findThem(payload) === "whatsapp"
    ? `${asked} AYA answers a request for a person on WhatsApp by asking them to call your practice.`
    : asked;
}

export const renderHandover: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: payload.isBurst === true ? "More people asked to speak to a person this hour" : "Someone asked to speak to a person",
      preheader:
        findThem(payload) === "portal" ? "Open healdesk to see who it is, and get back to them." : findThemShort(payload),
      blocks: [{ type: "paragraph", text: bodyOf(payload, ctx) }, ...openBlocks(payload, ctx)],
    },
    ctx,
  );

export const HANDOVER_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderHandover,
  get fixture(): BookingAlertPayload {
    return alertFixture();
  },
};
