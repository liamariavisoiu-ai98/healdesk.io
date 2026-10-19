import { compose } from "./compose";
import { alertFixture, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L11, "Someone asked for a person" (Annex X5): a handover. Queued by
 * notifyBookingAlert when AYA hands a call or a website chat to the team,
 * once per conversation, and sent from the minute queue at any hour.
 *
 * A pointer (booking-alert-copy.ts): that someone asked for a person, where,
 * and what they were told, never who or why.
 */

export const renderHandover: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Someone asked to speak to a person",
      preheader: "Open healdesk to see who it is, and get back to them.",
      blocks: [
        {
          type: "paragraph",
          text: `Someone asked to speak to a person ${wherePhrase(payload.channel)} ${practiceOf(ctx)}. AYA told them your team will get back to them.`,
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
