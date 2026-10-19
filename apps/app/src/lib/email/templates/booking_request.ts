import { compose } from "./compose";
import { alertFixture, fixtureBookingsUrl, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L7, "Booking request" (Annex X5): a request was taken, sent the moment it
 * is, at any hour (the spec: "Booking requests go out the moment they are
 * made"). Queued by notifyBookingAlert in the request's own transaction, from
 * every channel and from the booking engine; a booking AYA made itself sends
 * nothing, because it is in the clinic's calendar and the daily summary.
 *
 * It replaces the desk email that carried a /booking/<token> link: the
 * request now opens at its own row in Bookings, in the signed-in portal
 * behind the passkey step-up, where staff confirm it, propose other times or
 * decline it, never on a page whose link is its only key.
 */

export const renderBookingRequest: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "New booking request",
      preheader: "Someone asked to book. Open healdesk to see who, and when suits them.",
      blocks: [
        {
          type: "paragraph",
          text: `AYA took a booking request ${wherePhrase(payload)} ${practiceOf(ctx)}. Nothing is booked yet: they were told your team will be in touch to confirm a time.`,
        },
        ...openBlocks(payload, ctx),
      ],
    },
    ctx,
  );

export const BOOKING_REQUEST_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderBookingRequest,
  get fixture(): BookingAlertPayload {
    return alertFixture({
      bookingRequestId: "8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
      portalUrl: fixtureBookingsUrl("request-8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f"),
    });
  },
};
