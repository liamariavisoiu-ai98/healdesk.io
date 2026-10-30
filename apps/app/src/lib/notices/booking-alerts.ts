import { randomUUID } from "node:crypto";

import { fixedUrgentReply, type Channel, type UrgentLanguage } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { bookingRequests, clinics, conversations } from "@/db/schema";
import type { BookingAlertPayload } from "@/lib/email/templates/booking_alert";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
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
  | "calendar_check"
  /**
   * L35: a call ended unexpectedly (lib/voice/ended-early.ts), so staff can
   * call the person back themselves. Once per conversation.
   */
  | "ended_early";

/**
 * Whether an urgent alert (L12) reaches the clinic is no longer a constant:
 * package F queues it in the outbox in the transaction that answers the
 * urgent message and sends it in-process right after commit
 * (deliverCriticalAfterCommit), but only while the sender's switch, an email
 * transport and the clinic's address all exist. urgentAlertReadiness
 * (./urgent-readiness.ts) reads the three for each clinic when a
 * conversation's facts are read, and the fixed urgent reply says "I've told
 * the team" only when they hold (AssistantFacts and FrontDoorFacts,
 * urgentAlertsReady), as the wizard's urgent screen says AYA "tells your team
 * at once" only then.
 *
 * One turn's alert can still fail to queue (the database errs on the
 * insert): notifyBookingAlert then returns false and tells ops
 * (urgentAlertNotQueued), and a caller whose reply has not gone yet drops
 * the line from it (withoutTeamTold).
 */

/** Every language the fixed urgent reply is written in: a new one fails the typecheck until it is here. */
const URGENT_LANGUAGES: Readonly<Record<UrgentLanguage, true>> = { en: true, es: true };

/**
 * "I've told the team" in each of those languages, as the catalog's own
 * builder writes it: the one line `teamAlerted` adds, so this can never
 * drift from fixedUrgentReply.
 */
const TEAM_TOLD_LINES: readonly string[] = (Object.keys(URGENT_LANGUAGES) as UrgentLanguage[])
  .map((language) => {
    const input = { channel: "meta", emergency: "911", clinicName: "the clinic", clinicNumber: null, language } as const;
    const told = fixedUrgentReply({ ...input, teamAlerted: true });
    const untold = fixedUrgentReply({ ...input, teamAlerted: false });
    return told.startsWith(untold) ? told.slice(untold.length) : "";
  })
  .filter((line) => line.length > 0);

/**
 * A fixed urgent reply built while the alert was ready, as it reads
 * once that turn's alert turned out not to be queued: the same lines
 * without "I've told the team", in whichever language it was written. For a
 * caller that learns the alert failed after the reply was built and before
 * it is sent. Anything else comes back unchanged.
 */
export function withoutTeamTold(reply: string): string {
  let out = reply;
  for (const line of TEAM_TOLD_LINES) out = out.split(line).join("");
  return out;
}

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
  /**
   * L10 only: the payment link whose lapse hands the deposit to the front
   * desk. Only the dedupe key carries it, so a link that lapses after an
   * earlier L10 for the same booking was closed unsent (superseded because
   * a link went out, lib/email/superseded.ts) raises its own alert, instead
   * of being swallowed by that earlier row. An opaque id, never in the
   * payload.
   */
  depositId?: string;
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
  // A call, marked "Ended early" in Conversations, which is where staff find
  // who it was and the time it came in.
  ended_early: "conversations",
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
 * It returns whether the alert's row is queued (inserted now, or already
 * there under the same key), so a caller still building its reply can keep
 * it true. An urgent alert that is not queued is also told to ops
 * (urgentAlertNotQueued), whether or not the caller looks at the result.
 */
export async function notifyBookingAlert(
  tx: TenantTx,
  kind: BookingAlertKind,
  ref: BookingAlertRef,
): Promise<boolean> {
  let queued = false;
  try {
    queued = await tx.db.transaction(async (savepoint) => {
      const scoped: TenantTx = { ...tx, db: savepoint };
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return false;
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
          // Inserted now, or already queued under this key: queued either way.
          await enqueuePlanNotice(savepoint, tx.clinicId, kind, key, {
            ...alert,
            isPossiblyPaid: ref.mayBePaid === true,
          });
          return true;
        case "request_still_open":
          // A count, not one request: queued by the opening-hour job
          // (lib/scheduler/requests-still-open.ts) through queueRequestsStillOpen.
          log.error("booking alert not queued: L8 is queued by its job, with a count", {
            clinicId: tx.clinicId,
            kind,
          });
          return false;
        default:
          await enqueuePlanNotice(savepoint, tx.clinicId, kind, key, alert);
          return true;
      }
    });
  } catch (error) {
    queued = false;
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
  // Not awaited: ops is told on a connection of its own, so the caller's
  // transaction is never held for an email, and neither its rollback nor
  // its commit can lose the alert.
  if (!queued && kind === "urgent") void urgentAlertNotQueued(tx.clinicId, ref);
  return queued;
}

/**
 * An urgent message (L12) whose alert could not be queued: the clinic has
 * not been emailed and /api/health cannot see it (it reads only the rows
 * that exist), so ops is told at once, to phone the clinic. Ids and a
 * channel only, never anything the person said. notifyOps works without the
 * database, deduplicating in memory, so this still goes when the database
 * is what failed.
 *
 * notifyBookingAlert raises it for a savepoint that failed. A caller whose
 * whole transaction failed after the alert was queued in it, or never
 * reached notifyBookingAlert because its transaction could not start (a
 * call whose database went away mid-call), raises it itself once that
 * transaction has ended. Never throws.
 */
export async function urgentAlertNotQueued(
  clinicId: string,
  ref: Pick<BookingAlertRef, "conversationId" | "channel" | "callId">,
): Promise<void> {
  await notifyOps("urgent_alert_not_queued", {
    clinicId,
    channel: ref.channel ?? null,
    conversationId: ref.conversationId ?? null,
    // A call has no conversation row until it ends: its id keeps two
    // callers' misses at one clinic in one hour from being folded into one.
    ...(ref.callId ? { callId: ref.callId } : {}),
  });
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
  const link = kind === "deposit_to_collect" && ref.depositId ? `:link:${ref.depositId}` : "";
  return `${kind}:${about}${link}${unchecked}`.slice(0, 200);
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
