import { and, eq, gt, inArray, min, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  clinics,
  contacts,
  type BookedVia,
  type CalendarWriteStatus,
  type DepositStatus,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { writableConnection } from "@/lib/booking/calendar";
import {
  channelLabel,
  deskFreeTimes,
  openRequestCondition,
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
 * you with the rest, worded by `requestWords`. A handover has no record of
 * its own to list: its alert (L11) and the conversation's transcript carry
 * it.
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

export { bookingRequestPath, bookingsPath } from "./booking-paths";

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

export type BookingsScreen = {
  timeZone: string;
  /** Open requests, oldest first. */
  open: BookingRequestView[];
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

  const deposits = booked.filter((a) => isDepositToCollect(a, now));
  return {
    timeZone: open[0]?.timeZone ?? missed[0]?.timeZone ?? (await clinicZone(tx)),
    open,
    deposits,
    missed,
    booked,
    focus,
    writableCalendar,
  };
}

/**
 * A deposit a booking left for the front desk to collect, while the
 * appointment is still ahead: Needs you lists it, and Home counts it.
 */
export function isDepositToCollect(
  a: Pick<BookedAppointment, "depositStatus" | "status" | "scheduledFor">,
  now: Date,
): boolean {
  return (
    a.depositStatus === "pending_front_desk" &&
    (a.status === "scheduled" || a.status === "confirmed") &&
    a.scheduledFor.getTime() > now.getTime()
  );
}

/** Home's "Waiting for you": how many of each thing on Needs you, never which. */
export type WaitingCounts = {
  /** Open requests, each a person the team has to call back. */
  toCallBack: number;
  /** When the longest-waiting of them was taken, or null when there are none. */
  oldestSince: Date | null;
  /** Deposits a booking left for the front desk, while the appointment is ahead. */
  depositsToCollect: number;
};

/**
 * The counts behind Home's "Waiting for you" card (plan Part F1): the same
 * requests and deposits Needs you lists on Bookings, by the same rules
 * (openRequestCondition, isDepositToCollect), counted in the database
 * without reading a single person. Home is not a patient page, so this takes
 * a plain tenant transaction and writes no access-log row: it learns no
 * name, number, time or service, only how many, and when the oldest request
 * was taken.
 *
 * A handover has no record that says whether anyone has dealt with it yet
 * (Bookings lists none either, above), so there is no count of handovers
 * waiting: each one was emailed the moment it happened.
 */
export async function readWaitingCounts(tx: TenantTx, now: Date = new Date()): Promise<WaitingCounts> {
  const [open] = await tx.db
    .select({ n: sql<number>`count(*)::int`, oldest: min(bookingRequests.createdAt) })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), openRequestCondition()));
  const [deposits] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(appointments)
    .innerJoin(
      bookingRequests,
      and(
        eq(bookingRequests.appointmentId, appointments.id),
        eq(bookingRequests.clinicId, appointments.clinicId),
      ),
    )
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        eq(appointments.depositStatus, "pending_front_desk"),
        inArray(appointments.status, ["scheduled", "confirmed"]),
        gt(appointments.scheduledFor, now),
      ),
    );
  const oldest = open?.oldest ?? null;
  return {
    toCallBack: open?.n ?? 0,
    oldestSince: oldest === null ? null : new Date(oldest),
    depositsToCollect: deposits?.n ?? 0,
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
