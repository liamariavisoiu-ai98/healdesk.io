import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { and, eq, gt, like, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { appointments, billingNotices, bookingRequests, clinics } from "@/db/schema";
import type { BookingAlertPayload } from "@/lib/email/templates/booking-alert-copy";
import { describeError, log } from "@/lib/log";
import { sectionPath } from "@/lib/portal/nav";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * Booking alerts to the clinic: L7-L12, L20 and L34 in Annex X5 of the
 * funnel and portal plan, queued in the outbox (`billing_notices`) since
 * 19 October 2026 for the five that are built: L7 booking requests, L10
 * deposits to collect, L11 handovers, L12 urgent messages and L34 calendar
 * checks. They replace notifyDesk, which mailed a /booking/<token> link to
 * every report recipient, and sendLiveAlert (Annex X6): every alert now goes
 * to the clinic's one address (billingRecipients, read by the sender) and
 * links into the signed-in portal.
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
  | "website_message"
  /**
   * L34: a booking the assistant made may not be in the calendar (the write
   * was never confirmed, or a later desk decision won); staff check it in
   * Bookings. Sent at once, at any hour.
   */
  | "calendar_check";

/** The alerts that have a payload and a template: the ones notifyBookingAlert queues. */
export type SentAlertKind = "booking_request" | "deposit_to_collect" | "handover" | "urgent" | "calendar_check";

const SENT: ReadonlySet<BookingAlertKind> = new Set<SentAlertKind>([
  "booking_request",
  "deposit_to_collect",
  "handover",
  "urgent",
  "calendar_check",
]);

function isSent(kind: BookingAlertKind): kind is SentAlertKind {
  return SENT.has(kind);
}

/** What the alert points at. Ids only: the portal shows the rest behind sign-in and step-up. */
export type BookingAlertRef = {
  appointmentId?: string;
  bookingRequestId?: string;
  conversationId?: string;
  /** The channel it came in on, in the catalog's ids. Read from the request when absent. */
  channel?: Channel;
  /**
   * The call's Retell id, for an alert raised while the call is up: its
   * conversation row is written only when the call ends (lib/voice/ingest.ts),
   * so the call's id keys the alert instead. It keys the notice and is never
   * stored in it.
   */
  callId?: string;
  /**
   * L10 only: a deposit link that may already have been paid. Package D sets
   * it when a Stripe disconnect could not verify an open link, so the email
   * says to check Stripe before collecting the deposit again. A flag, not a
   * sentence: the template words it. Stored as `isPossiblyPaid`, the name the
   * payload allowlist reads as a flag.
   */
  mayBePaid?: boolean;
};

/** booking_requests.channel in the catalog's channel ids: `web_chat` is the website chat, `web`. */
function channelOfRequest(channel: "voice" | "meta" | "web_chat"): Channel {
  return channel === "web_chat" ? "web" : channel;
}

/**
 * Where an alert opens in the clinic portal: the conversation it came from in
 * Conversations, or Conversations itself while there is no conversation to
 * open (a call still going on, a request the engine logged mid-call). The
 * only place an alert's link is decided: the Bookings screen moves booking
 * requests, deposits and calendar checks to their own row there, here.
 */
export function alertPortalPath(
  slug: string,
  kind: SentAlertKind,
  target: { conversationId: string | null; bookingRequestId: string | null },
): string {
  void kind;
  const conversations = sectionPath(slug, "conversations");
  return target.conversationId ? `${conversations}/${target.conversationId}` : conversations;
}

/**
 * The key that makes an alert once: per request for L7 and L34, per
 * appointment (else request, else conversation) for L10, per call or
 * conversation for L11 and L12. A call is keyed on its Retell id whether the
 * alert is raised while it is up or by the ingest when it ends, so the
 * ingest's backstop never sends a call's alert twice. Null when the ref names
 * nothing to key on, except that an urgent alert or a handover is never
 * dropped for want of one: it is keyed on a fresh id, so each one alerts.
 */
function dedupeKeyFor(
  kind: SentAlertKind,
  channel: Channel | null,
  ref: BookingAlertRef,
  conversationId: string | null,
): string | null {
  switch (kind) {
    case "booking_request":
    case "calendar_check":
      return ref.bookingRequestId ? `${kind}:${ref.bookingRequestId}` : null;
    case "deposit_to_collect": {
      const id = ref.appointmentId ?? ref.bookingRequestId ?? conversationId;
      return id ? `${kind}:${id}` : null;
    }
    case "handover":
    case "urgent":
      return `${kind}:${channel ?? "unknown"}:${ref.callId ?? conversationId ?? randomUUID()}`;
  }
}

/**
 * How many urgent alerts, and how many handovers, one channel of one clinic
 * sends one by one in an hour. The urgent screen is a fixed matcher and every
 * new website chat is a new conversation, so anyone who can load a clinic's
 * widget could otherwise turn messages into emails without end: flooding the
 * clinic's inbox, and spending the Resend quota that every clinic's alerts
 * and sign-in links share. Past this many in the last hour, or while a burst
 * of the last hour stands, further ones on that channel go into one email
 * for the UTC hour that says more came in and to open Conversations, where
 * each conversation is still marked.
 */
export const ALERT_BURST_AFTER = 3;

/**
 * The burst key an urgent alert or a handover goes under, or null when it is
 * sent on its own: it already has its own row (a second message in the same
 * conversation, or the ingest's backstop for a call), or fewer than
 * ALERT_BURST_AFTER went on this channel in the last hour and no burst did.
 */
async function burstKeyFor(
  db: Transaction,
  clinicId: string,
  kind: "urgent" | "handover",
  channel: Channel | null,
  ownKey: string,
  now: Date,
): Promise<string | null> {
  const mine = and(eq(billingNotices.clinicId, clinicId), eq(billingNotices.kind, kind));
  const [own] = await db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(and(mine, eq(billingNotices.dedupeKey, ownKey)))
    .limit(1);
  if (own) return null;
  const prefix = `${kind}:${channel ?? "unknown"}:`;
  const recent = await db
    .select({ dedupeKey: billingNotices.dedupeKey })
    .from(billingNotices)
    .where(and(mine, like(billingNotices.dedupeKey, `${prefix}%`), gt(billingNotices.createdAt, sql`now() - interval '1 hour'`)));
  const bursting = recent.some((r) => r.dedupeKey.startsWith(`${prefix}burst:`));
  const single = recent.filter((r) => !r.dedupeKey.startsWith(`${prefix}burst:`)).length;
  if (!bursting && single < ALERT_BURST_AFTER) return null;
  return `${prefix}burst:${now.toISOString().slice(0, 13)}`;
}

/**
 * The conversation and channel a ref leads to: the ref's own, else the
 * request's (a website chat's or a finished call's request names its
 * conversation; a Meta request names a thread, which the caller passes), else
 * the appointment's.
 */
async function targetOf(
  db: Transaction,
  clinicId: string,
  ref: BookingAlertRef,
): Promise<{ channel: Channel | null; conversationId: string | null }> {
  let channel: Channel | null = ref.channel ?? null;
  let conversationId: string | null = ref.conversationId ?? null;
  if (ref.bookingRequestId && (!channel || !conversationId)) {
    const [request] = await db
      .select({ channel: bookingRequests.channel, conversationId: bookingRequests.conversationId })
      .from(bookingRequests)
      .where(and(eq(bookingRequests.id, ref.bookingRequestId), eq(bookingRequests.clinicId, clinicId)))
      .limit(1);
    if (request) {
      channel ??= channelOfRequest(request.channel);
      conversationId ??= request.conversationId;
    }
  }
  if (ref.appointmentId && !conversationId) {
    const [appointment] = await db
      .select({ conversationId: appointments.conversationId })
      .from(appointments)
      .where(and(eq(appointments.id, ref.appointmentId), eq(appointments.clinicId, clinicId)))
      .limit(1);
    conversationId = appointment?.conversationId ?? null;
  }
  return { channel, conversationId };
}

/**
 * Tell the clinic a booking, a deposit, a handover or something urgent needs
 * it. The email is a pointer (lib/email/templates/booking-alert-copy.ts): the
 * kind, the channel and a link into the portal, never who, when or which
 * service.
 *
 * Called inside the caller's tenant transaction (the runtimes, the booking
 * engine and Package D's deposit transactions), it queues the notice in that
 * same transaction, once per dedupe key, and the email goes after commit:
 * nothing is sent for work that rolls back. The urgent alert is critical, so
 * the caller hands it to deliverCriticalAfterCommit once its transaction
 * commits; the rest go from the minute queue, at any hour.
 *
 * Returns whether the alert is queued: true when the row is in the outbox
 * (written now, or already there under the same key), false when it could
 * not be. The urgent reply says "I've told the team" only on true. Past
 * ALERT_BURST_AFTER urgent alerts or handovers on one channel in an hour,
 * further ones share one email for the hour (burstKeyFor); one that comes
 * after that email has gone is false, since nothing more will tell the
 * clinic about it.
 *
 * It never throws, and it never breaks the caller's transaction: the insert
 * runs in a savepoint, so a failure here rolls back only itself, is logged
 * with ids only, and the booking, deposit or conversation it reports on is
 * still recorded.
 */
export async function notifyBookingAlert(
  tx: TenantTx,
  kind: BookingAlertKind,
  ref: BookingAlertRef,
): Promise<boolean> {
  try {
    if (!isSent(kind)) {
      // L8, L9 and L20 have no payload or template yet (PENDING_TEMPLATES).
      log.info("booking alert not queued: its email is not built", { clinicId: tx.clinicId, kind });
      return false;
    }
    if (publicOriginProblem()) {
      log.error("booking alert not queued: no public origin", { clinicId: tx.clinicId, kind });
      return false;
    }
    return await tx.db.transaction(async (savepoint) => {
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return false;
      const { channel, conversationId } = await targetOf(savepoint, tx.clinicId, ref);
      const own = dedupeKeyFor(kind, channel, ref, conversationId);
      if (!own) {
        log.error("booking alert not queued: nothing to key it on", { clinicId: tx.clinicId, kind });
        return false;
      }
      const burst =
        kind === "urgent" || kind === "handover"
          ? await burstKeyFor(savepoint, tx.clinicId, kind, channel, own, new Date())
          : null;
      const key = burst ?? own;
      // A burst's email is about the channel, not one conversation: it opens Conversations.
      const pointsAt = burst ? null : conversationId;
      const payload: BookingAlertPayload = {
        channel,
        conversationId: pointsAt,
        bookingRequestId: ref.bookingRequestId ?? null,
        appointmentId: ref.appointmentId ?? null,
        isPossiblyPaid: kind === "deposit_to_collect" && ref.mayBePaid === true,
        isBurst: burst !== null,
        portalUrl: publicUrl(
          alertPortalPath(clinic.slug, kind, { conversationId: pointsAt, bookingRequestId: ref.bookingRequestId ?? null }),
        ),
      };
      const inserted = await enqueuePlanNotice(savepoint, tx.clinicId, kind, key, payload);
      if (inserted || !burst) return true;
      // This hour's burst email was queued already. It covers this message
      // only while it has still to go: once sent, it told the clinic about
      // the ones before, and this one is in Conversations alone, so the reply
      // must not say the team was told.
      const [standing] = await savepoint
        .select({ sentAt: billingNotices.sentAt })
        .from(billingNotices)
        .where(and(eq(billingNotices.clinicId, tx.clinicId), eq(billingNotices.kind, kind), eq(billingNotices.dedupeKey, key)))
        .limit(1);
      if (standing?.sentAt) {
        log.warn("booking alert not queued: this hour's burst email has gone", { clinicId: tx.clinicId, kind });
        return false;
      }
      return true;
    });
  } catch (error) {
    try {
      log.error("booking alert not queued", { clinicId: tx.clinicId, kind, error: describeError(error) });
    } catch {
      // Nothing reaches the caller; see above.
    }
    return false;
  }
}
