import { compose } from "./compose";
import { alertFixture, findThem, findThemShort, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L11, "Someone asked for a person" (Annex X5): a handover. Queued by
 * notifyBookingAlert when AYA hands a call, a website chat or an Instagram,
 * Messenger or WhatsApp message to the team, once per conversation, and sent
 * from the minute queue at any hour.
 *
 * A pointer (booking-alert-copy.ts): that someone asked for a person, where,
 * and what they were told, never who or why. Past the hour's cap on one
 * channel (isBurst), one email says more asked and opens Conversations.
 */

export const renderHandover: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: payload.isBurst === true ? "More people asked to speak to a person this hour" : "Someone asked to speak to a person",
      preheader:
        findThem(payload) === "portal" ? "Open healdesk to see who it is, and get back to them." : findThemShort(payload),
      blocks: [
        {
          type: "paragraph",
          text:
            payload.isBurst === true
              ? `More people asked to speak to a person ${wherePhrase(payload.channel)} ${practiceOf(ctx)} in the last hour than healdesk emails one by one. AYA told each of them your team will get back to them.`
              : `Someone asked to speak to a person ${wherePhrase(payload.channel)} ${practiceOf(ctx)}. AYA told them your team will get back to them.`,
        },
        ...openBlocks(payload, ctx),
      ],
    },
    ctx,
  );

export const HANDOVER_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderHandover,
  get fixture(): BookingAlertPayload {
    return alertFixture();
  },
};
