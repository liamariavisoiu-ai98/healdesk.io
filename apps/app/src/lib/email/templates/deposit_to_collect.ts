import { compose, type Block } from "./compose";
import { alertFixture, fixtureBookingsUrl, openBlocks, practiceOf, wherePhrase, type BookingAlertPayload } from "./booking-alert-copy";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * L10, "Deposit to collect" (Annex X5): a deposit is flagged or held for the
 * team, or a booking was refused for want of one. Queued by
 * notifyBookingAlert from the deposit decision's own transaction
 * (lib/billing/deposits.ts) and sent from the minute queue at any hour.
 *
 * Two shapes, told apart by the payload alone: with an appointment, AYA
 * booked it and left the deposit to the team; without one, AYA did not book
 * and passed the request on. `isPossiblyPaid` adds the line that keeps a
 * patient from paying twice. The link opens the deposit's row in Bookings,
 * where staff mark it paid, or the request's (alertPortalPath).
 */

export const renderDepositToCollect: EmailTemplate<BookingAlertPayload> = (payload, ctx) => {
  const where = `${wherePhrase(payload)} ${practiceOf(ctx)}`;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: payload.appointmentId
        ? `AYA booked an appointment ${where} that needs a deposit, and left the deposit for your team to collect.`
        : `AYA did not book an appointment ${where} because it needs a deposit AYA could not take, and passed the request to your team. Please get in touch to book it and take the deposit.`,
    },
  ];
  if (payload.isPossiblyPaid) {
    blocks.push({
      type: "paragraph",
      text: "A deposit link went out for this booking and may already have been paid. Check the payment in your Stripe account before you ask for it again.",
    });
  }
  return compose(
    {
      subject: "A deposit to collect",
      preheader: payload.isPossiblyPaid
        ? "Check Stripe first: it may already have been paid."
        : "Open healdesk to see the booking and who to call.",
      blocks: [...blocks, ...openBlocks(payload, ctx)],
    },
    ctx,
  );
};

export const DEPOSIT_TO_COLLECT_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderDepositToCollect,
  // A link nobody could check, after a disconnect: the variant with the most to say.
  get fixture(): BookingAlertPayload {
    return alertFixture({
      appointmentId: "3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7",
      isPossiblyPaid: true,
      portalUrl: fixtureBookingsUrl("deposit-3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7"),
    });
  },
};

/** The decline shape: no appointment, the request passed to the team. */
export const DEPOSIT_DECLINED_FIXTURE = (): BookingAlertPayload =>
  alertFixture({
    channel: "voice",
    bookingRequestId: "8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
    portalUrl: fixtureBookingsUrl("request-8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f"),
  });
