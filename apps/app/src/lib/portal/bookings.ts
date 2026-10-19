import { and, desc, eq, gt, inArray, isNull, min, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

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
 * you with the rest, worded by `requestWords`. Someone who asked AYA for a
 * person (L11) is a handover (drizzle/0092, lib/handovers/record.ts): open
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
  /** Open handovers, newest first, at most MAX_OPEN_HANDOVERS of them. */
  handovers: HandoverView[];
  /** How many handovers are open in all: more than `handovers` holds once the oldest are past the cap. */
  openHandoverCount: number;
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
  const openHandoverCount =
    asked.length < MAX_OPEN_HANDOVERS ? asked.length : await countOpenHandovers(tx);
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

  const deposits = booked.filter((a) => isDepositToCollect(a, now));
  return {
    timeZone: open[0]?.timeZone ?? missed[0]?.timeZone ?? (await clinicZone(tx)),
    open,
    handovers: asked,
    openHandoverCount,
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
 * Open handovers are not counted here: Bookings lists them under Needs
 * you until the desk marks them handled, and each was emailed the moment it
 * happened.
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

/**
 * How many open handovers Needs you lists at most: the newest first, so the
 * one an L11 email has just pointed at is always on the screen it links to,
 * however many older ones nobody marked. The page says how many more there
 * are (openHandoverCount). Unlike a request, a handover never lapses: it
 * names no time the person was promised, so there is nothing to miss, and
 * the record clock deletes it with the rest (lib/retention/purge.ts).
 */
export const MAX_OPEN_HANDOVERS = 100;

/**
 * The open handovers, newest first, with a name and number to call: the one
 * a web chat visitor gave for the call back, or a call's caller. A Meta handover has neither: the desk answers it in
 * the platform's own inbox. A call's conversation is written when the call
 * ends, so one still going has none yet.
 */
async function readOpenHandovers(tx: TenantTx): Promise<HandoverView[]> {
  // A call's handover is linked to its conversation by the database when
  // the call's row is written; one raised in the same instant may miss the
  // link, so a call is also found by its call id.
  const call = alias(conversations, "handover_call");
  const rows = await tx.db
    .select({
      id: handovers.id,
      channel: handovers.channel,
      platform: handovers.platform,
      askedAt: handovers.createdAt,
      conversationId: sql<string | null>`coalesce(${handovers.conversationId}, ${call.id})`,
      firstName: sql<string | null>`coalesce(${handovers.callbackFirstName}, ${contacts.fullName})`,
      phone: sql<string | null>`coalesce(${handovers.callbackPhone}, ${contacts.phone})`,
    })
    .from(handovers)
    .leftJoin(
      call,
      and(
        isNull(handovers.conversationId),
        eq(call.clinicId, handovers.clinicId),
        eq(call.externalCallId, handovers.externalCallId),
      ),
    )
    .leftJoin(
      conversations,
      and(
        eq(conversations.clinicId, handovers.clinicId),
        eq(conversations.id, sql`coalesce(${handovers.conversationId}, ${call.id})`),
      ),
    )
    .leftJoin(
      contacts,
      and(eq(contacts.clinicId, conversations.clinicId), eq(contacts.id, conversations.contactId)),
    )
    .where(and(eq(handovers.clinicId, tx.clinicId), isNull(handovers.handledAt)))
    .orderBy(desc(handovers.createdAt), desc(handovers.id))
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

/** Every open handover, counted without reading one: only how many. */
async function countOpenHandovers(tx: TenantTx): Promise<number> {
  const [row] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(handovers)
    .where(and(eq(handovers.clinicId, tx.clinicId), isNull(handovers.handledAt)));
  return row?.n ?? 0;
}

/**
 * What Needs you says under its handovers when there are more open than it
 * lists: how many older ones are not shown, and how they come into view.
 */
export function olderHandoversLine(total: number, shown: number): string {
  const older = total - shown;
  return `Showing the ${shown} most recent of ${total}. ${
    older === 1 ? "One older one is" : `${older} older ones are`
  } not shown: mark the ones your team has dealt with, and the rest appear here.`;
}

/** How Bookings words a handover: where they asked, and how the desk reaches them. */
export function handoverWords(view: Pick<HandoverView, "channel" | "platform" | "conversationId" | "phone">): {
  /** "on the phone", "in your website chat", "on Instagram". */
  via: string;
  /** What to do, or where the number they gave is, beside any number to call. */
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
    // A number the caller gave AYA is not kept on the handover: it is in
    // the call's transcript, the only copy of what was said.
    const given = "it's in the call's transcript, which is emailed to you when the call ends.";
    return {
      via: "on the phone",
      reach: view.phone
        ? `This is the number they called from. If they gave AYA a different one, ${given}`
        : view.conversationId
          ? `The caller's number wasn't shown. If they gave AYA one, ${given}`
          : `The caller's number appears here once the call ends, if it was shown. If they gave AYA one, ${given}`,
    };
  }
  return {
    via: "in your website chat",
    reach: view.phone
      ? null
      : "They haven't left a number. The chat's transcript is emailed to you when it ends.",
  };
}

/** Thrown inside the patient transaction for an id that is not this clinic's handover, so it rolls back with no row. */
export class HandoverNotFoundError extends Error {
  constructor() {
    super("Not one of this clinic's handovers.");
    this.name = "HandoverNotFoundError";
  }
}

export type HandoverResult =
  | { ok: true; changed: boolean }
  /** The clinic is closing: its portal is read-only (the page hides the button; this holds for a hand-made post). */
  | { ok: false; reason: "read_only" };

/**
 * The desk has dealt with a handover: marked once, by the device whose
 * passkey is live, in the action's patient transaction (withPatientPage),
 * with an access row for the handover it read and an update row for the
 * change, each naming the passkey. The database stamps the time and never
 * reopens it (drizzle/0092), so marking one already handled changes
 * nothing. A clinic whose offboarding has started is read-only, and nothing
 * is written. An id that is not one of this clinic's handovers throws
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
  const [clinic] = await tx.db
    .select({ offboardingStartedAt: clinics.offboardingStartedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (clinic?.offboardingStartedAt) return { ok: false, reason: "read_only" };
  if (row.handledAt) return { ok: true, changed: false };
  const label = tx.page.stepUp.deviceLabel.trim().slice(0, 200) || "Your team";
  await tx.db
    .update(handovers)
    .set({ handledAt: sql`clock_timestamp()`, handledByLabel: label, handledByUserId: tx.page.portal.userId })
    .where(and(eq(handovers.id, handoverId), eq(handovers.clinicId, tx.clinicId), isNull(handovers.handledAt)));
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
  return { ok: true, changed: true };
}
