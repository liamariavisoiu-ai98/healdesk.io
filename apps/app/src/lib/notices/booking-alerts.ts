import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { bookingRequests, clinics, conversations } from "@/db/schema";
import type { BookingAlertPayload } from "@/lib/email/templates/booking_alert";
import { describeError, log } from "@/lib/log";
import { sectionPath, type PortalSection } from "@/lib/portal/nav";
import { PublicUrlError, publicUrl } from "@/lib/public-url";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * Booking alerts to the clinic: L7-L12, L20 and L34 in Annex X5 of the funnel
 * and portal plan, queued in the outbox since M5 (package F).
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
  /** L20: a message left on the website's contact form while AYA was not answering (lib/chat/contact-form.ts). */
  | "website_message"
  /**
   * L34: a booking the assistant made may not be in the calendar (the write
   * was never confirmed, or a later desk decision won); staff check it in
   * Bookings. Sent at once, at any hour.
   */
  | "calendar_check";

/**
 * Whether an urgent alert (L12) reaches the clinic: true since package F,
 * which queues it in the outbox in the transaction that answers the urgent
 * message and sends it in-process right after commit
 * (deliverCriticalAfterCommit), with /api/health red if it is still unsent
 * ten minutes later. The fixed urgent reply says "I've told the team" only
 * while this is true (@healdesk/catalog, fixedUrgentReply), so the line never
 * promises an alert that was not sent, and the wizard's urgent screen says
 * AYA "tells your team at once".
 */
export const URGENT_ALERT_DELIVERED = true;

/** What the alert points at. Ids only: the portal shows the rest behind sign-in and step-up. */
export type BookingAlertRef = {
  appointmentId?: string;
  bookingRequestId?: string;
  conversationId?: string;
  /**
   * The vendor's id for a call still in progress, when no conversation row
   * exists yet (a Retell call writes its conversation when it ends). Only the
   * dedupe key carries it, so one call raises each alert once even across a
   * reconnect; it never enters the payload.
   */
  callId?: string;
  /** How the person reached the clinic, when the caller knows it; otherwise read from the request. */
  channel?: Channel;
  /**
   * L10 only: a deposit link that may already have been paid. Package D sets
   * it when a Stripe disconnect could not verify an open link, so the email
   * says to check Stripe before collecting the deposit again. A flag, not a
   * sentence: the template words it.
   */
  mayBePaid?: boolean;
};

/**
 * The portal screen each alert links to. An urgent message is a conversation,
 * not a booking: Conversations marks an urgent call or chat Urgent (a call
 * appears once it ends; a Meta thread carries no mark). Everything else is on
 * Bookings. A handover is there too, because the next thing staff do is reach
 * the person back: Bookings lists each open handover under Needs you, newest
 * first, until the desk marks it handled (lib/portal/bookings.ts,
 * readOpenHandovers; drizzle/0092). A Meta handover appears nowhere else.
 */
export const ALERT_SECTION: Readonly<Record<BookingAlertKind, PortalSection>> = {
  booking_request: "bookings",
  request_still_open: "bookings",
  request_missed: "bookings",
  deposit_to_collect: "bookings",
  handover: "bookings",
  urgent: "conversations",
  website_message: "bookings",
  calendar_check: "bookings",
};

const REQUEST_CHANNEL: Readonly<Record<"voice" | "meta" | "web_chat", Channel>> = {
  voice: "voice",
  meta: "meta",
  web_chat: "web",
};

/**
 * Tell the clinic a booking needs it. The email is a pointer: the kind, the
 * clinic and a link into the portal, never who, when or which service
 * (Annex X1; the spec's "Email").
 *
 * Called inside the caller's tenant transaction, and it queues the outbox row
 * in that same transaction, so nothing is sent for work that rolls back. The
 * minute queue sends it; L12 is critical, and its caller hands the clinic to
 * deliverCriticalAfterCommit (lib/email/outbox.ts) once the transaction has
 * committed. Each alert is queued once per event: the dedupe key is the
 * request, the appointment, the conversation or the call it is about.
 *
 * It replaced notifyDesk (lib/meta/booking-requests.ts) and sendLiveAlert
 * (lib/reporting/alerts.ts), which emailed every report recipient directly:
 * the alert goes to the clinic's one address, resolved when it is sent.
 *
 * It never throws, and never breaks the caller's transaction: the reads and
 * the insert run in a savepoint, so a failure here rolls back only itself
 * and the booking, deposit or conversation it reports on is still recorded.
 */
export async function notifyBookingAlert(
  tx: TenantTx,
  kind: BookingAlertKind,
  ref: BookingAlertRef,
): Promise<void> {
  try {
    await tx.db.transaction(async (savepoint) => {
      const scoped: TenantTx = { ...tx, db: savepoint };
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return;
      const alert: BookingAlertPayload = {
        portalUrl: alertUrl(tx.clinicId, clinic.slug, kind),
        channel: ref.channel ?? (await channelOf(scoped, ref)),
        bookingRequestId: ref.bookingRequestId ?? null,
        appointmentId: ref.appointmentId ?? null,
        conversationId: ref.conversationId ?? null,
      };
      const key = dedupeKey(kind, ref);
      switch (kind) {
        case "deposit_to_collect":
          await enqueuePlanNotice(savepoint, tx.clinicId, kind, key, {
            ...alert,
            isPossiblyPaid: ref.mayBePaid === true,
          });
          return;
        case "request_still_open":
          // A count, not one request: queued by the opening-hour job
          // (lib/scheduler/requests-still-open.ts) through queueRequestsStillOpen.
          log.error("booking alert not queued: L8 is queued by its job, with a count", {
            clinicId: tx.clinicId,
            kind,
          });
          return;
        default:
          await enqueuePlanNotice(savepoint, tx.clinicId, kind, key, alert);
      }
    });
  } catch (error) {
    try {
      log.error("booking alert not queued", {
        clinicId: tx.clinicId,
        kind,
        error: describeError(error),
      });
    } catch {
      // Nothing reaches the caller; see above.
    }
  }
}

/**
 * L8: the requests still waiting for the desk at the clinic's opening hour,
 * once per clinic-local date, with their count. Called by the opening-hour job
 * inside the clinic's tenant. Returns whether this call queued it. Throws
 * only when the database does: the job counts the failure and carries on.
 */
export async function queueRequestsStillOpen(
  tx: TenantTx,
  input: { localDate: string; openCount: number; closesAfterDays: number },
): Promise<boolean> {
  const [clinic] = await tx.db
    .select({ slug: clinics.slug })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || input.openCount < 1) return false;
  return enqueuePlanNotice(
    tx.db,
    tx.clinicId,
    "request_still_open",
    `request_still_open:${input.localDate}`,
    {
      portalUrl: alertUrl(tx.clinicId, clinic.slug, "request_still_open"),
      openCount: input.openCount,
      closesAfterDays: input.closesAfterDays,
    },
  );
}

/** The portal link, or null when there is no public origin to build it on (the email still goes). */
function alertUrl(clinicId: string, slug: string, kind: BookingAlertKind): string | null {
  try {
    return publicUrl(sectionPath(slug, ALERT_SECTION[kind]));
  } catch (error) {
    if (!(error instanceof PublicUrlError)) throw error;
    log.error("booking alert queued without a link: no public origin", { clinicId, kind });
    return null;
  }
}

/** Once per what: the most specific thing the alert is about, or a fresh key when it names nothing. */
export function dedupeKey(kind: BookingAlertKind, ref: BookingAlertRef): string {
  const about = ref.appointmentId
    ? `appointment:${ref.appointmentId}`
    : ref.bookingRequestId
      ? `request:${ref.bookingRequestId}`
      : ref.conversationId
        ? `conversation:${ref.conversationId}`
        : ref.callId
          ? `call:${ref.callId}`
          : `event:${randomUUID()}`;
  // A link that may already have been paid is its own alert, whatever was said before.
  const unchecked = kind === "deposit_to_collect" && ref.mayBePaid ? ":unchecked" : "";
  return `${kind}:${about}${unchecked}`.slice(0, 200);
}

/** The channel of the request or conversation the alert is about, when the caller did not say. */
async function channelOf(tx: TenantTx, ref: BookingAlertRef): Promise<Channel | null> {
  if (ref.bookingRequestId || ref.appointmentId) {
    const [request] = await tx.db
      .select({ channel: bookingRequests.channel })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.clinicId, tx.clinicId),
          ref.bookingRequestId
            ? eq(bookingRequests.id, ref.bookingRequestId)
            : eq(bookingRequests.appointmentId, ref.appointmentId!),
        ),
      )
      .limit(1);
    if (request) return REQUEST_CHANNEL[request.channel] ?? null;
  }
  if (ref.conversationId) {
    const [conversation] = await tx.db
      .select({ channel: conversations.channel })
      .from(conversations)
      .where(and(eq(conversations.clinicId, tx.clinicId), eq(conversations.id, ref.conversationId)))
      .limit(1);
    if (conversation?.channel === "voice") return "voice";
    if (conversation?.channel === "web_chat") return "web";
  }
  return null;
}
