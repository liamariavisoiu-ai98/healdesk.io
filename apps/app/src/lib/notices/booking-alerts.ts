import { log } from "@/lib/log";
import type { TenantTx } from "@/lib/tenant";

/**
 * Booking alerts to the clinic: L7-L12 and L20 in Annex X5 of the funnel and
 * portal plan. A signature until M5, so Package D and the runtime are written
 * against it now.
 */

export type BookingAlertKind =
  /** L7: a booking request was taken, sent the moment it is, at any hour. */
  | "booking_request"
  /** L8: a request is still open at the next opening hour, while the daily summary is off. */
  | "request_still_open"
  /** L9: a request expired; they were told the clinic would call. */
  | "request_missed"
  /** L10: a deposit is flagged or held, or a booking was refused for want of one. */
  | "deposit_to_collect"
  /** L11: someone asked for a person. */
  | "handover"
  /** L12: the urgent matcher fired. Critical. */
  | "urgent"
  /** L20: a message left on the website's contact form while chat was off or paused. */
  | "website_message";

/** What the alert points at. Ids only: the portal shows the rest behind sign-in and step-up. */
export type BookingAlertRef = {
  appointmentId?: string;
  bookingRequestId?: string;
  conversationId?: string;
};

/**
 * Tell the clinic a booking needs it. The email is a pointer: the kind, the
 * clinic and a link into Bookings, never who, when or which service.
 *
 * Called inside the caller's tenant transaction (Package D calls it from its
 * deposit transactions), so in M5 it queues an outbox row in that same
 * transaction and the email goes after commit; nothing is sent for work that
 * rolls back. It replaces notifyDesk (lib/meta/booking-requests.ts) and
 * sendLiveAlert (lib/reporting/alerts.ts), which email report recipients
 * directly (Annex X6).
 *
 * Until M5 it records and sends nothing and writes one info line. It never
 * throws: a throw here would roll back the booking or deposit it reports on.
 */
export async function notifyBookingAlert(
  tx: TenantTx,
  kind: BookingAlertKind,
  ref: BookingAlertRef,
): Promise<void> {
  void ref;
  try {
    log.info("booking alert not sent: alerts land in M5", { clinicId: tx.clinicId, kind });
  } catch {
    // Nothing reaches the caller; see above.
  }
}
