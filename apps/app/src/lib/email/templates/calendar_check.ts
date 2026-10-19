import { compose } from "./compose";
import { alertFixture, openBlocks, practiceOf, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L34, "Check a booking in your calendar": a booking AYA made may not be in
 * the clinic's Google Calendar, because the write was never confirmed or a
 * later decision by the team won. Queued by notifyBookingAlert from the
 * booking writer's own transaction (lib/booking/writer.ts, holds.ts, and the
 * desk's decision in lib/meta/booking-requests.ts), and sent at once, at any
 * hour, so the team checks before the appointment.
 */

export const renderCalendarCheck: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Check a booking in your calendar",
      preheader: "A booking AYA made may not be in your Google Calendar.",
      blocks: [
        {
          type: "paragraph",
          text: `A booking AYA made for ${practiceOf(ctx)} may not be in your Google Calendar: the calendar did not confirm it, or it crossed with a decision your team made. Please check your calendar against it before the appointment.`,
        },
        ...openBlocks(payload, ctx),
      ],
    },
    ctx,
  );

export const CALENDAR_CHECK_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderCalendarCheck,
  get fixture(): BookingAlertPayload {
    return alertFixture({ channel: "voice", bookingRequestId: "8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f" });
  },
};
