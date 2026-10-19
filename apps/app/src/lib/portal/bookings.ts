import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  clinics,
  contacts,
  conversations,
  handovers,
  type BookedVia,
  type CalendarWriteStatus,
  type DepositStatus,
  type HandoverChannel,
  type HandoverPlatform,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { writableConnection } from "@/lib/booking/calendar";
import {
  channelLabel,
  deskFreeTimes,
  readBookingRequestViews,
  type BookingChannel,
  type BookingRequestView,
  type DeskActor,
} from "@/lib/meta/booking-requests";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { amendmentsFor } from "@/lib/patient-rights/amendments";
import type { TenantTx } from "@/lib/tenant";

import { logPatientAccess, type PatientPage, type PatientTx } from "./patient-page";

/**
 * The Bookings screen's data (plan Part F5; spec, "Portal map", 5. Bookings):
 * what AYA booked, with its deposit, and the queue of what needs staff.
 *
 * - **Needs you:** every open request, oldest first, to call, confirm,
 *   propose times for or decline; and every deposit a booking left for the
 *   front desk to collect, while the appointment is still ahead.
 * - **Missed:** requests that lapsed in the last 30 days without a decision.
 *   The person was told the practice would call.
 * - **Booked by AYA:** the appointments that came from AYA's conversations,
 *   the last 30 days and everything ahead: the ones she booked on the call,
 *   and the requests staff confirmed. Each takes one click for Showed,
 *   No-show or Cancelled (spec, "The claims": the cheap bridge that makes the
 *   numbers real).
 *
 * Patient data, so every reader here takes a `PatientTx`: the page or action
 * under app/c/[slug]/bookings calls requirePatientPage and then
 * withPatientPage itself, and each reader writes its access-log row naming
 * the passkey (logPatientAccess) in that transaction: one for the requests
 * shown, one for the appointments. A message left on the website while AYA
 * was off is a request (source 'contact_form', package F) and sits in Needs
 * you with the rest, worded by `requestWords`. Someone who asked AYA for a
 * person (L11) is a handover (drizzle/0085, lib/handovers/record.ts): open
 * ones sit in Needs you, with an access row of their own, until the desk
 * marks one handled (markHandoverHandled).
 *
 * Server only.
 */

/** How far back Missed reaches. */
export const MISSED_DAYS = 30;
/** How far back Booked by AYA reaches: long enough to mark how last week's appointments went. */
export const BOOKED_LOOKBACK_DAYS = 30;

/** The one-click outcomes on a booking (spec, "The claims"). */
export const APPOINTMENT_OUTCOMES = ["showed", "no_show", "cancelled"] as const;
export type AppointmentOutcome = (typeof APPOINTMENT_OUTCOMES)[number];

export type AppointmentStatus =
  "scheduled" | "confirmed" | "showed" | "no_show" | "cancelled" | "rescheduled";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How Bookings words a request: one AYA took in a conversation, or a message
 * left on the website's contact form while AYA was not answering (L20). The
 * person left only a name, a number and a time to call, and was told the
 * practice would call them back.
 */
export function requestWords(view: Pick<BookingRequestView, "source" | "channel" | "platform">): {
  /** Follows the person's first name: "Maria would like to book". */
  headline: string;
  /** "through Messenger", "on your website's contact form". */
  via: string;
  /** The row label for the time they gave. */
  timeLabel: string;
} {
  if (view.source === "contact_form") {
    return {
      headline: "left a message while AYA was off",
      via: "on your website's contact form",
      timeLabel: "Best time to call",
    };
  }
  return {
    headline: "would like to book",
    via: `through ${channelLabel(view.channel, view.platform)}`,
    timeLabel: "First choice",
  };
}

/** Bookings, or one request on it: where the emailed link, and a decision, land. */
export function bookingsPath(slug: string): string {
  return `/c/${slug}/bookings`;
}

/** One request on Bookings. The id is a UUID, never anything of the person. */
export function bookingRequestPath(slug: string, requestId: string): string {
  return `${bookingsPath(slug)}?request=${encodeURIComponent(requestId)}`;
}

/** The decision's actor: the sign-in, by the device whose passkey step-up opened the page. */
export function deskActorOf(page: PatientPage): DeskActor {
  return {
    userId: page.portal.userId,
    passkeyId: page.stepUp.passkeyId,
    stepUpId: page.stepUp.stepUpId,
    deviceLabel: page.stepUp.deviceLabel,
  };
}

function actorOf(page: PatientPage): ActorContext {
  return { type: "user", userId: page.portal.userId, label: page.stepUp.deviceLabel };
}

/** An appointment that came from one of AYA's conversations. */
export type BookedAppointment = {
  id: string;
  requestId: string;
  firstName: string | null;
  phone: string | null;
  scheduledFor: Date;
  treatment: string | null;
  status: AppointmentStatus;
  depositStatus: DepositStatus;
  /** Dollars as the column holds them ("50.00"), or null. */
  depositUsd: string | null;
  /** AYA booked it on the call, or staff confirmed AYA's request. */
  bookedBy: "assistant" | "team";
  decidedByLabel: string | null;
  bookedVia: BookedVia;
  channel: BookingChannel;
  platform: MetaPlatform | null;
  calendarWrite: { status: CalendarWriteStatus; error: string | null; attempts: number };
  amendments: { text: string; requestedAt: Date }[];
};

/** Someone asked AYA for a person, and the desk has not marked it handled. */
export type HandoverView = {
  id: string;
  channel: HandoverChannel;
  platform: HandoverPlatform | null;
  askedAt: Date;
  /** The call's or web chat's conversation, to open in Conversations; null for Meta, and for a call not yet written. */
  conversationId: string | null;
  /** From the conversation's contact: the caller's number, or the one a web chat visitor gave. */
  firstName: string | null;
  phone: string | null;
};

export type BookingsScreen = {
  timeZone: string;
  /** Open requests, oldest first. */
  open: BookingRequestView[];
  /** Open handovers, oldest first. */
  handovers: HandoverView[];
  /** Deposits a booking left for the front desk, while the appointment is ahead. */
  deposits: BookedAppointment[];
  /** Lapsed requests, newest first. */
  missed: BookingRequestView[];
  /** AYA's appointments, by time. */
  booked: BookedAppointment[];
  /**
   * The request the page was opened for (the emailed link, or a decision a
   * moment ago), wherever it now sits, with its calendar's free times when it
   * is open. Null when none was asked for, or it is not this clinic's.
   */
  focus: BookingRequestView | null;
  /** Whether healdesk may write to the location's calendar now, so free times can be offered. */
  writableCalendar: boolean;
};

/**
 * Everything Bookings shows, read inside the page's patient transaction
 * (withPatientPage), with its access rows. The free times for the request in
 * focus come after, from `withFreeTimes`, once the transaction has committed:
 * Google is never asked inside one.
 */
export async function readBookingsScreen(
  tx: PatientTx,
  opts: { focus?: string | null; now?: Date } = {},
): Promise<BookingsScreen> {
  const now = opts.now ?? new Date();
  const focusId = typeof opts.focus === "string" && UUID.test(opts.focus) ? opts.focus : null;

  const open = await readBookingRequestViews(tx, { kind: "open" }, { now, limit: 100 });
  const missed = await readBookingRequestViews(
    tx,
    { kind: "missed", days: MISSED_DAYS },
    { now, limit: 50 },
  );
  const booked = await readBookedAppointments(tx, now);
  const asked = await readOpenHandovers(tx);
  let focus: BookingRequestView | null = null;
  if (focusId !== null) {
    focus =
      open.find((r) => r.id === focusId) ??
      missed.find((r) => r.id === focusId) ??
      (await readBookingRequestViews(tx, { kind: "ids", ids: [focusId] }, { now }))[0] ??
      null;
  }
  const writableCalendar = (await writableConnection(tx)) !== null;

  const requestIds = [...new Set([...open, ...missed, ...(focus ? [focus] : [])].map((r) => r.id))];
  await logPatientAccess(tx, {
    action: "read",
    resourceType: "booking_request",
    resourceIds: requestIds,
  });
  if (booked.length > 0) {
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "appointment",
      resourceIds: booked.map((a) => a.id),
    });
  }
  if (asked.length > 0) {
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "handover",
      resourceIds: asked.map((h) => h.id),
    });
  }

  const deposits = booked.filter(
    (a) =>
      a.depositStatus === "pending_front_desk" &&
      (a.status === "scheduled" || a.status === "confirmed") &&
      a.scheduledFor.getTime() > now.getTime(),
  );
  return {
    timeZone: open[0]?.timeZone ?? missed[0]?.timeZone ?? (await clinicZone(tx)),
    open,
    handovers: asked,
    deposits,
    missed,
    booked,
    focus,
    writableCalendar,
  };
}

/**
 * The calendar's free times for the request in focus, when it is open and
 * healdesk may write to the calendar, after the page's transaction.
 */
export async function withFreeTimes(
  page: PatientPage,
  screen: BookingsScreen,
): Promise<BookingsScreen> {
  if (screen.focus && screen.writableCalendar && isDecidable(screen.focus)) {
    screen.focus.calendar = await deskFreeTimes(page.portal.clinicId, screen.focus, actorOf(page));
  }
  return screen;
}

/** Thrown inside the patient transaction for an id that is not this clinic's request, so it rolls back with no row. */
export class RequestNotFoundError extends Error {
  constructor() {
    super("Not one of this clinic's booking requests.");
    this.name = "RequestNotFoundError";
  }
}

/**
 * The request a decision is about, opened in the action's patient
 * transaction (withPatientPage) with its access row naming the passkey.
 * Throws RequestNotFoundError, logging nothing, when the id is not one of
 * this clinic's requests.
 */
export async function openRequestForDecision(tx: PatientTx, requestId: string): Promise<void> {
  if (!UUID.test(requestId)) throw new RequestNotFoundError();
  const [row] = await tx.db
    .select({ id: bookingRequests.id })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .limit(1);
  if (!row) throw new RequestNotFoundError();
  await logPatientAccess(tx, {
    action: "read",
    resourceType: "booking_request",
    resourceId: row.id,
  });
}

/** Whether staff can still decide a request: open, and not lapsed. */
export function isDecidable(view: BookingRequestView): boolean {
  return (
    !view.lapsed &&
    (view.status === "requested" || view.status === "accepted" || view.status === "rescheduling")
  );
}

async function clinicZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.db
    .select({ timeZone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row?.timeZone ?? "America/New_York";
}

/**
 * The appointments AYA's conversations produced: every healdesk appointment
 * comes from a request (lib/meta/booking-requests.ts is its one writer), so
 * the join keeps out anything a phase-two sync might have read back.
 */
async function readBookedAppointments(tx: TenantTx, now: Date): Promise<BookedAppointment[]> {
  const since = new Date(now.getTime() - BOOKED_LOOKBACK_DAYS * 86_400_000);
  const rows = await tx.db
    .select({
      id: appointments.id,
      requestId: bookingRequests.id,
      firstName: contacts.fullName,
      phone: contacts.phone,
      scheduledFor: appointments.scheduledFor,
      treatment: appointments.treatment,
      status: appointments.status,
      depositStatus: appointments.depositStatus,
      depositUsd: appointments.depositUsd,
      bookingOrigin: appointments.bookingOrigin,
      decidedByLabel: bookingRequests.decidedByLabel,
      bookedVia: bookingRequests.bookedVia,
      channel: bookingRequests.channel,
      platform: bookingRequests.platform,
      calendarWriteStatus: appointments.calendarWriteStatus,
      calendarWriteError: appointments.calendarWriteError,
      calendarWriteAttempts: appointments.calendarWriteAttempts,
    })
    .from(appointments)
    .innerJoin(
      bookingRequests,
      and(
        eq(bookingRequests.appointmentId, appointments.id),
        eq(bookingRequests.clinicId, appointments.clinicId),
      ),
    )
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .where(and(eq(appointments.clinicId, tx.clinicId), gt(appointments.scheduledFor, since)))
    .orderBy(appointments.scheduledFor, appointments.id)
    .limit(200);
  if (rows.length === 0) return [];
  const amended = await amendmentsFor(
    tx,
    "appointment",
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    requestId: r.requestId,
    firstName: r.firstName,
    phone: r.phone,
    scheduledFor: r.scheduledFor,
    treatment: r.treatment,
    status: r.status,
    depositStatus: r.depositStatus,
    depositUsd: r.depositUsd,
    bookedBy: r.bookingOrigin === "assistant" ? "assistant" : "team",
    decidedByLabel: r.decidedByLabel,
    bookedVia: r.bookedVia,
    channel: r.channel,
    platform: r.platform,
    calendarWrite: {
      status: r.calendarWriteStatus,
      error: r.calendarWriteError,
      attempts: r.calendarWriteAttempts,
    },
    amendments: (amended.get(r.id) ?? []).map((a) => ({
      text: a.amendment,
      requestedAt: a.requestedAt,
    })),
  }));
}

export type OutcomeResult =
  | { ok: true; status: AppointmentOutcome; changed: boolean }
  /**
   * `not_yet`: showed and no-show wait for the appointment's start.
   * `checking`: its calendar write has not settled, so it cannot be cancelled yet.
   * `confirm`: cancelling one still ahead asks first.
   */
  | { ok: false; reason: "not_found" | "not_yet" | "checking" | "confirm" | "invalid" };

/** Thrown inside the patient transaction for an id that is not this clinic's appointment, so it rolls back with no row. */
export class AppointmentNotFoundError extends Error {
  constructor() {
    super("Not one of this clinic's appointments.");
    this.name = "AppointmentNotFoundError";
  }
}

/** Whether a form's value is one of the one-click outcomes. */
export function isAppointmentOutcome(value: unknown): value is AppointmentOutcome {
  return typeof value === "string" && (APPOINTMENT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Showed, No-show or Cancelled on one of AYA's appointments, in the action's
 * patient transaction (withPatientPage), by the device whose passkey is
 * live: an access row for the appointment it read and an update row for the
 * change, each naming the passkey. Showed and No-show wait until the
 * appointment has started. Cancelled only marks it here: the clinic cancels
 * in its own calendar too. It frees the time in healdesk (availability no
 * longer counts it busy) and cannot be put back to booked, so for an
 * appointment still ahead it asks first (`confirmed`). It is refused while
 * the appointment's calendar write is still `writing` or `unknown`: under
 * this row lock, a write that has not settled could otherwise land a
 * cancelled booking in the clinic's calendar afterwards (the calendar
 * write's claim and the desk sweep never write one that is not on either).
 * An id that is not one of this clinic's appointments throws
 * AppointmentNotFoundError, so the transaction rolls back and leaves no row.
 */
export async function markAppointmentOutcome(
  tx: PatientTx,
  appointmentId: string,
  outcome: AppointmentOutcome,
  now: Date = new Date(),
  opts: { confirmed?: boolean } = {},
): Promise<OutcomeResult> {
  if (!UUID.test(appointmentId)) throw new AppointmentNotFoundError();
  const [row] = await tx.db
    .select({
      status: appointments.status,
      scheduledFor: appointments.scheduledFor,
      calendarWriteStatus: appointments.calendarWriteStatus,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.clinicId, tx.clinicId),
        inArray(
          appointments.id,
          tx.db
            .select({ id: bookingRequests.appointmentId })
            .from(bookingRequests)
            .where(eq(bookingRequests.clinicId, tx.clinicId)),
        ),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw new AppointmentNotFoundError();
  await logPatientAccess(tx, {
    action: "read",
    resourceType: "appointment",
    resourceId: appointmentId,
  });
  const ahead = row.scheduledFor.getTime() > now.getTime();
  if (outcome !== "cancelled" && ahead) return { ok: false, reason: "not_yet" };
  if (row.status === outcome) return { ok: true, status: outcome, changed: false };
  if (outcome === "cancelled") {
    if (row.calendarWriteStatus === "writing" || row.calendarWriteStatus === "unknown") {
      return { ok: false, reason: "checking" };
    }
    if (ahead && opts.confirmed !== true) return { ok: false, reason: "confirm" };
  }
  await tx.db
    .update(appointments)
    .set({ status: outcome, updatedAt: sql`now()` })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)));
  tx.audit.record({
    action: "update",
    resourceType: "appointment",
    resourceId: appointmentId,
    metadata: {
      outcome: "marked",
      status: outcome,
      from: row.status,
      passkeyId: tx.page.stepUp.passkeyId,
      stepUpId: tx.page.stepUp.stepUpId,
    },
  });
  return { ok: true, status: outcome, changed: true };
}

/** How many open handovers Needs you lists at most: the oldest first, so none is buried. */
export const MAX_OPEN_HANDOVERS = 100;

/**
 * The open handovers, oldest first, with the name and number of the
 * conversation's contact where it has one (a call's caller, or the number a
 * web chat visitor gave). A Meta handover has neither: the desk answers it in
 * the platform's own inbox. A call's conversation is written when the call
 * ends, so one still going has none yet.
 */
async function readOpenHandovers(tx: TenantTx): Promise<HandoverView[]> {
  const rows = await tx.db
    .select({
      id: handovers.id,
      channel: handovers.channel,
      platform: handovers.platform,
      askedAt: handovers.createdAt,
      conversationId: handovers.conversationId,
      firstName: contacts.fullName,
      phone: contacts.phone,
    })
    .from(handovers)
    .leftJoin(
      conversations,
      and(eq(conversations.clinicId, handovers.clinicId), eq(conversations.id, handovers.conversationId)),
    )
    .leftJoin(
      contacts,
      and(eq(contacts.clinicId, conversations.clinicId), eq(contacts.id, conversations.contactId)),
    )
    .where(and(eq(handovers.clinicId, tx.clinicId), isNull(handovers.handledAt)))
    .orderBy(asc(handovers.createdAt), asc(handovers.id))
    .limit(MAX_OPEN_HANDOVERS);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    platform: r.platform,
    askedAt: r.askedAt,
    conversationId: r.conversationId,
    firstName: r.firstName,
    phone: r.phone,
  }));
}

/** How Bookings words a handover: where they asked, and how the desk reaches them. */
export function handoverWords(view: Pick<HandoverView, "channel" | "platform" | "conversationId" | "phone">): {
  /** "on the phone", "in your website chat", "on Instagram". */
  via: string;
  /** What to do, when there is no number to call. */
  reach: string | null;
} {
  if (view.channel === "meta") {
    const platform =
      view.platform === "instagram" ? "Instagram" : view.platform === "whatsapp" ? "WhatsApp" : "Messenger";
    return {
      via: `on ${platform}`,
      reach: `Reply to them in your ${platform} inbox. Nothing they wrote is kept here.`,
    };
  }
  if (view.channel === "voice") {
    return {
      via: "on the phone",
      reach: view.phone
        ? null
        : view.conversationId
          ? "The caller's number wasn't shown. Their call is in Conversations."
          : "The call was still going. Its record and the caller's number appear here when it ends.",
    };
  }
  return {
    via: "in your website chat",
    reach: view.phone ? null : "They didn't leave a number. The chat's transcript was emailed to you.",
  };
}

/** Thrown inside the patient transaction for an id that is not this clinic's handover, so it rolls back with no row. */
export class HandoverNotFoundError extends Error {
  constructor() {
    super("Not one of this clinic's handovers.");
    this.name = "HandoverNotFoundError";
  }
}

export type HandoverResult = { ok: true; changed: boolean; handledAt: Date };

/**
 * The desk has dealt with a handover: marked once, by the device whose
 * passkey is live, in the action's patient transaction (withPatientPage),
 * with an access row for the handover it read and an update row for the
 * change, each naming the passkey. The database stamps the time and never
 * reopens it (drizzle/0085), so marking one already handled changes
 * nothing. An id that is not one of this clinic's handovers throws
 * HandoverNotFoundError, so the transaction rolls back and leaves no row.
 */
export async function markHandoverHandled(tx: PatientTx, handoverId: string): Promise<HandoverResult> {
  if (!UUID.test(handoverId)) throw new HandoverNotFoundError();
  const [row] = await tx.db
    .select({ handledAt: handovers.handledAt })
    .from(handovers)
    .where(and(eq(handovers.id, handoverId), eq(handovers.clinicId, tx.clinicId)))
    .for("update")
    .limit(1);
  if (!row) throw new HandoverNotFoundError();
  await logPatientAccess(tx, { action: "read", resourceType: "handover", resourceId: handoverId });
  if (row.handledAt) return { ok: true, changed: false, handledAt: row.handledAt };
  const label = tx.page.stepUp.deviceLabel.trim().slice(0, 200) || "Your team";
  const [updated] = await tx.db
    .update(handovers)
    .set({ handledAt: sql`clock_timestamp()`, handledByLabel: label, handledByUserId: tx.page.portal.userId })
    .where(and(eq(handovers.id, handoverId), eq(handovers.clinicId, tx.clinicId), isNull(handovers.handledAt)))
    .returning({ handledAt: handovers.handledAt });
  tx.audit.record({
    action: "update",
    resourceType: "handover",
    resourceId: handoverId,
    metadata: {
      outcome: "handled",
      passkeyId: tx.page.stepUp.passkeyId,
      stepUpId: tx.page.stepUp.stepUpId,
    },
  });
  return { ok: true, changed: true, handledAt: updated?.handledAt ?? new Date() };
}
