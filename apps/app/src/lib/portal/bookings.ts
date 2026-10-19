import { collectedFieldRows } from "@healdesk/catalog";
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  contacts,
  type CalendarWriteStatus,
  type DepositStatus,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  channelLabel,
  decideBookingRequest,
  deskFreeTimes,
  isOpenRequest,
  MAX_PROPOSED_SLOTS,
  readBookingRequest,
  readBookingRequests,
  type BookingDecision,
  type BookingRequestStatus,
  type DecisionInput,
  type DecisionOutcome,
  type ResolvedBookingRequest,
} from "@/lib/meta/booking-requests";
import { amendmentsFor, type RecordAmendment } from "@/lib/patient-rights/amendments";

import { logPatientAccess, withPatientPage, type PatientPage, type PatientTx } from "./patient-page";

/**
 * The Bookings screen (plan Part F5; spec, "Portal map": "What the AI booked,
 * with deposit status, and the queue of anything flagged for manual deposit
 * collection or manual confirmation"). Four lists, one page, nothing nested:
 *
 *   - **Waiting for you**: every open booking request, from every channel
 *     (calls, website chat, Instagram, Messenger and WhatsApp alike, which is
 *     why it reads booking_requests and not Conversations: a Meta request has
 *     no conversations row), oldest first. Requests AYA took in manual
 *     booking mode or with Auto-confirm off, a booking whose calendar write
 *     was never confirmed, a deposit reservation with the time it is kept
 *     until, and a booking AYA refused for want of a deposit. Staff confirm
 *     a time, accept and call, propose up to three other times, or decline,
 *     through decideBookingRequest.
 *   - **Missed**: requests that lapsed in the last week. They were told the
 *     practice would call, so a call is what is owed.
 *   - **Deposits to collect**: appointments whose deposit is the front desk's
 *     to take (L10), from yesterday on, with "Deposit paid".
 *   - **Booked**: appointments made through healdesk, by AYA or by staff
 *     confirming a request, from two weeks ago on, with the deposit's and the
 *     calendar's status, and the spec's one-click outcome (showed, no-show,
 *     cancelled) once the time has come.
 *
 * Everything here runs behind requirePatientPage, inside withPatientPage, and
 * writes its access-log row naming the device's passkey in the transaction
 * that reads: the requests as shown, the appointments as shown, and each
 * request or appointment an action touches. A decision opens its own
 * transactions as the same device (decideBookingRequest), after that row.
 *
 * Nothing here contacts a patient: staff call them. A decision sends nothing
 * on any channel, and the screen says so.
 */

/** How many rows each list shows. A list longer than this is a practice that should be told, not one that scrolls. */
export const LIST_LIMIT = 100;
/** How far back Missed reaches. */
export const MISSED_DAYS = 7;
/** How far back Booked reaches, so last week's outcomes can still be marked. */
export const BOOKED_DAYS = 14;
/** A deposit for an appointment that started within this is still listed: the desk may take it at the visit. */
export const DEPOSIT_GRACE_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBookingId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The device whose passkey step-up opened the page: the actor of everything done from it. */
function deviceActor(page: PatientPage): ActorContext {
  return { type: "user", userId: page.portal.userId, label: page.stepUp.deviceLabel };
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

// -----------------------------------------------------------------------------
// What the screen shows
// -----------------------------------------------------------------------------

export type BookingAmendment = Pick<RecordAmendment, "id" | "amendment" | "requestedBy"> & {
  recordedAt: string;
};

/** A booking request, as a row of Waiting for you or Missed. Times are ISO. */
export type ShownRequest = {
  id: string;
  /** "a phone call", "the website chat", "Instagram": where it was taken. */
  via: string;
  status: BookingRequestStatus;
  /** Past its seven days, whether or not the hourly tick has marked it yet. */
  lapsed: boolean;
  firstName: string | null;
  /** E.164. */
  phone: string | null;
  createdAt: string;
  expiresAt: string;
  preferredWindow: string;
  alternativeWindows: string[];
  /** The service asked for, on a call or a website chat; a Meta request names none. */
  service: string | null;
  /** What AYA collected besides, in the practice's words (collectedFieldRows). */
  collected: { id: string; label: string; value: string }[];
  /** AYA tried to book it but the calendar never confirmed the write. */
  unconfirmedDirect: boolean;
  /** When AYA held time for them on the call, and until when a deposit reservation keeps it. */
  heldFor: string | null;
  heldUntil: string | null;
  /** The times staff proposed, and when they lapse. */
  proposedSlots: { at: string; label: string }[];
  rescheduleExpiresAt: string | null;
  decidedAt: string | null;
  decidedByLabel: string | null;
  deskNote: string | null;
  /** The practice's amendments to it, oldest first: every screen that shows the request carries them (BAA clause 14(b)). */
  amendments: BookingAmendment[];
};

export type DepositToCollect = {
  appointmentId: string;
  /** The request it was confirmed from, if any. */
  requestId: string | null;
  firstName: string | null;
  phone: string | null;
  scheduledFor: string;
  service: string | null;
  /** Dollars as stored ("75.00"), or null when the practice set no amount. */
  depositUsd: string | null;
};

/** What staff may mark a booking as once its time has come: the spec's "cheap bridge". */
export const BOOKING_OUTCOMES = ["showed", "no_show", "cancelled"] as const;
export type BookingOutcome = (typeof BOOKING_OUTCOMES)[number];

export function isBookingOutcome(value: unknown): value is BookingOutcome {
  return (BOOKING_OUTCOMES as readonly unknown[]).includes(value);
}

export type BookedAppointment = {
  appointmentId: string;
  /** The request it was confirmed from, if any: its row's anchor, so a link to the request lands here. */
  requestId: string | null;
  firstName: string | null;
  phone: string | null;
  scheduledFor: string;
  service: string | null;
  /** AYA booked it; otherwise staff confirmed it from a request. */
  bookedByAssistant: boolean;
  /** Who confirmed it, for a staff confirmation. */
  confirmedBy: string | null;
  depositStatus: DepositStatus;
  depositUsd: string | null;
  status: "scheduled" | "confirmed" | "showed" | "no_show" | "cancelled" | "rescheduled";
  calendar: { status: CalendarWriteStatus; error: string | null };
  /** Its time has come, so its outcome may be marked. */
  started: boolean;
};

export type BookingsScreen = {
  waiting: ShownRequest[];
  missed: ShownRequest[];
  deposits: DepositToCollect[];
  booked: BookedAppointment[];
};

function shownRequest(req: ResolvedBookingRequest, amendments: RecordAmendment[] | undefined): ShownRequest {
  const direct = req.status === "confirmed" && (req.decidedByLabel ?? "").startsWith("assistant");
  return {
    id: req.id,
    via: channelLabel(req.channel, req.platform),
    status: req.status,
    lapsed: req.status === "expired" || (req.expired && isOpenStatus(req.status)),
    firstName: req.firstName,
    phone: req.phone,
    createdAt: req.createdAt.toISOString(),
    expiresAt: req.expiresAt.toISOString(),
    preferredWindow: req.preferredWindow,
    alternativeWindows: req.alternativeWindows,
    // `treatment` is frozen at creation; a service collected later lands in
    // collected_fields (the column's own note in db/schema.ts).
    service: req.treatment ?? req.collectedFields.service ?? null,
    collected: collectedFieldRows(req.collectedFields, req.audience).filter((row) => row.id !== "service"),
    unconfirmedDirect: req.bookedVia === "agent_direct" && !direct,
    heldFor: iso(req.heldFor),
    heldUntil: iso(req.heldUntil),
    proposedSlots: req.proposedSlots.map((s) => ({ at: s.at, label: s.label })),
    rescheduleExpiresAt: iso(req.rescheduleExpiresAt),
    decidedAt: iso(req.decidedAt),
    decidedByLabel: req.decidedByLabel,
    deskNote: req.deskNote,
    amendments: (amendments ?? []).map((a) => ({
      id: a.id,
      amendment: a.amendment,
      requestedBy: a.requestedBy,
      recordedAt: a.recordedAt.toISOString(),
    })),
  };
}

const OPEN_STATUSES = ["requested", "accepted", "rescheduling"] as const;

function isOpenStatus(status: BookingRequestStatus): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

/** Every open request that has not lapsed, oldest first: the queue. */
function waitingWhere() {
  return and(inArray(bookingRequests.status, [...OPEN_STATUSES]), gt(bookingRequests.expiresAt, sql`now()`))!;
}

/** Requests that lapsed since `since`: marked expired by the hourly tick, or past their seven days and not yet marked. */
function missedWhere(since: Date) {
  return or(
    and(eq(bookingRequests.status, "expired"), gte(bookingRequests.decidedAt, since)),
    and(
      inArray(bookingRequests.status, [...OPEN_STATUSES]),
      lte(bookingRequests.expiresAt, sql`now()`),
      gte(bookingRequests.expiresAt, since),
    ),
  )!;
}

async function depositRows(tx: PatientTx, now: Date): Promise<DepositToCollect[]> {
  const rows = await tx.db
    .select({
      appointmentId: appointments.id,
      requestId: bookingRequests.id,
      firstName: contacts.fullName,
      phone: contacts.phone,
      scheduledFor: appointments.scheduledFor,
      service: appointments.treatment,
      depositUsd: appointments.depositUsd,
    })
    .from(appointments)
    .innerJoin(contacts, and(eq(contacts.clinicId, appointments.clinicId), eq(contacts.id, appointments.contactId)))
    .leftJoin(
      bookingRequests,
      and(eq(bookingRequests.clinicId, appointments.clinicId), eq(bookingRequests.appointmentId, appointments.id)),
    )
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        eq(appointments.depositStatus, "pending_front_desk"),
        gte(appointments.scheduledFor, new Date(now.getTime() - DEPOSIT_GRACE_HOURS * 60 * 60 * 1000)),
      ),
    )
    .orderBy(asc(appointments.scheduledFor), asc(appointments.id))
    .limit(LIST_LIMIT);
  return rows.map((r) => ({ ...r, scheduledFor: r.scheduledFor.toISOString() }));
}

async function bookedRows(tx: PatientTx, now: Date): Promise<BookedAppointment[]> {
  const rows = await tx.db
    .select({
      appointmentId: appointments.id,
      requestId: bookingRequests.id,
      decidedByLabel: bookingRequests.decidedByLabel,
      firstName: contacts.fullName,
      phone: contacts.phone,
      scheduledFor: appointments.scheduledFor,
      service: appointments.treatment,
      bookingOrigin: appointments.bookingOrigin,
      depositStatus: appointments.depositStatus,
      depositUsd: appointments.depositUsd,
      status: appointments.status,
      calendarWriteStatus: appointments.calendarWriteStatus,
      calendarWriteError: appointments.calendarWriteError,
    })
    .from(appointments)
    .innerJoin(contacts, and(eq(contacts.clinicId, appointments.clinicId), eq(contacts.id, appointments.contactId)))
    .leftJoin(
      bookingRequests,
      and(eq(bookingRequests.clinicId, appointments.clinicId), eq(bookingRequests.appointmentId, appointments.id)),
    )
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        gte(appointments.scheduledFor, new Date(now.getTime() - BOOKED_DAYS * DAY_MS)),
        // Made through healdesk: AYA's own, or confirmed from a request. A
        // phase-two row read back from a clinic's system is neither.
        or(isNotNull(appointments.bookingOrigin), isNotNull(bookingRequests.id)),
      ),
    )
    .orderBy(asc(appointments.scheduledFor), asc(appointments.id))
    .limit(LIST_LIMIT);
  return rows.map((r) => {
    const assistant = r.bookingOrigin === "assistant" || (r.decidedByLabel ?? "").startsWith("assistant");
    return {
      appointmentId: r.appointmentId,
      requestId: r.requestId,
      firstName: r.firstName,
      phone: r.phone,
      scheduledFor: r.scheduledFor.toISOString(),
      service: r.service,
      bookedByAssistant: assistant,
      confirmedBy: assistant ? null : r.decidedByLabel,
      depositStatus: r.depositStatus,
      depositUsd: r.depositUsd,
      status: r.status,
      calendar: { status: r.calendarWriteStatus, error: r.calendarWriteError },
      started: r.scheduledFor.getTime() <= now.getTime(),
    };
  });
}

/**
 * The screen as it renders: the four lists, read in one transaction behind
 * the step-up, with one access row for the requests shown and one for the
 * appointments shown, every id in each.
 */
export async function readBookingsScreen(
  page: PatientPage,
  options: { now?: Date } = {},
): Promise<BookingsScreen> {
  const now = options.now ?? new Date();
  return withPatientPage(page, async (tx) => {
    const open = await readBookingRequests(tx, waitingWhere(), LIST_LIMIT);
    const lapsed = (await readBookingRequests(tx, missedWhere(new Date(now.getTime() - MISSED_DAYS * DAY_MS)), LIST_LIMIT))
      // Newest first: the one they were most recently told about is the call to make first.
      .reverse();
    const amended = await amendmentsFor(tx, "booking_request", [...open, ...lapsed].map((r) => r.id));
    const screen: BookingsScreen = {
      waiting: open.map((r) => shownRequest(r, amended.get(r.id))),
      missed: lapsed.map((r) => shownRequest(r, amended.get(r.id))),
      deposits: await depositRows(tx, now),
      booked: await bookedRows(tx, now),
    };
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "booking_request",
      resourceIds: [...screen.waiting, ...screen.missed].map((r) => r.id),
    });
    const shownAppointments = [
      ...new Set([...screen.deposits, ...screen.booked].map((a) => a.appointmentId)),
    ];
    if (shownAppointments.length > 0) {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "appointment",
        resourceIds: shownAppointments,
      });
    }
    return screen;
  });
}

// -----------------------------------------------------------------------------
// Free times
// -----------------------------------------------------------------------------

export type FreeTimesResult =
  | { status: "ok"; slots: { at: string; label: string }[] }
  /** healdesk may not write to the practice's calendar, so there is nothing to pick from. */
  | { status: "no_calendar" }
  /** Decided or lapsed meanwhile. */
  | { status: "closed" }
  | { status: "not_found" };

/**
 * The free times in the practice's calendar for one open request, on
 * demand: the read of the request, with its access row, then Google, after
 * that transaction has committed (deskFreeTimes). An empty list is Google
 * not answering just now: staff type a time.
 */
export async function freeTimesFor(page: PatientPage, requestId: string): Promise<FreeTimesResult> {
  if (!isBookingId(requestId)) return { status: "not_found" };
  const req = await withPatientPage(page, async (tx) => {
    const found = await readBookingRequest(tx, requestId);
    await logPatientAccess(tx, { action: "read", resourceType: "booking_request", resourceId: requestId });
    return found;
  });
  if (!req) return { status: "not_found" };
  if (!isOpenRequest(req)) return { status: "closed" };
  const free = await deskFreeTimes(page.portal.clinicId, req, { actor: deviceActor(page) });
  return free ? { status: "ok", slots: free.slots } : { status: "no_calendar" };
}

// -----------------------------------------------------------------------------
// A decision
// -----------------------------------------------------------------------------

const DECISIONS: readonly BookingDecision[] = ["accepted", "declined", "confirmed", "rescheduling"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export type ParsedDecision =
  | { ok: true; decision: BookingDecision; input: DecisionInput; name: string | null }
  | { ok: false; message: string };

/**
 * What the decision form sent, read and checked: which decision, the time
 * confirmed (a calendar slot, an ISO instant the page rendered, or a typed
 * time read on the browser's clock, which is the practice's), the times
 * proposed, the service, and who and why. A time already an hour past is
 * refused; the decision itself refuses anything else it cannot take.
 */
export function parseDecision(form: FormData, now: Date = new Date()): ParsedDecision {
  const decision = form.get("decision");
  if (typeof decision !== "string" || !DECISIONS.includes(decision as BookingDecision)) {
    return { ok: false, message: "Choose what to do with this request." };
  }
  const text = (key: string, max: number): string | null => {
    const raw = form.get(key);
    return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
  };
  const offset = form.get("tzOffsetMinutes");
  const minutes = typeof offset === "string" && /^-?\d{1,4}$/.test(offset) ? Number(offset) : 0;
  // A typed time comes from a datetime-local input: no zone, read as the
  // desk's browser clock. The desk and the practice are in the same place.
  const fromLocal = (raw: FormDataEntryValue | null): Date | null => {
    if (typeof raw !== "string" || !LOCAL_INPUT.test(raw)) return null;
    const at = new Date(new Date(`${raw.slice(0, 16)}:00Z`).getTime() + minutes * 60_000);
    return Number.isFinite(at.getTime()) ? at : null;
  };
  // A calendar slot is an ISO instant the page rendered; nothing to adjust.
  const fromIso = (raw: FormDataEntryValue | null): Date | null => {
    if (typeof raw !== "string" || !ISO_INSTANT.test(raw)) return null;
    const at = new Date(raw);
    return Number.isFinite(at.getTime()) ? at : null;
  };
  const stillAhead = (at: Date) => at.getTime() >= now.getTime() - 60 * 60_000;

  let confirmedFor: Date | null = null;
  if (decision === "confirmed") {
    // A typed time is the deliberate choice when both are present.
    confirmedFor = fromLocal(form.get("confirmedFor")) ?? fromIso(form.get("slotAt"));
    if (!confirmedFor) return { ok: false, message: "Pick the date and time you are confirming." };
    if (!stillAhead(confirmedFor)) return { ok: false, message: "That time has already passed. Pick a time from now on." };
  }

  let proposedSlots: { at: Date; source: "calendar" | "desk" }[] = [];
  if (decision === "rescheduling") {
    const seen = new Set<number>();
    const add = (at: Date | null, source: "calendar" | "desk") => {
      if (at && !seen.has(at.getTime())) {
        seen.add(at.getTime());
        proposedSlots.push({ at, source });
      }
    };
    for (const raw of form.getAll("proposedSlot")) add(fromIso(raw), "calendar");
    for (const raw of form.getAll("proposedAt")) add(fromLocal(raw), "desk");
    proposedSlots = proposedSlots.slice(0, MAX_PROPOSED_SLOTS);
    if (proposedSlots.length === 0) return { ok: false, message: "Pick one to three times to propose." };
    if (!proposedSlots.every((s) => s.at.getTime() > now.getTime())) {
      return { ok: false, message: "One of those times has already passed. Propose times from now on." };
    }
  }

  const name = text("name", 80);
  return {
    ok: true,
    decision: decision as BookingDecision,
    name,
    input: {
      decidedByLabel: name,
      deskNote: text("note", 500),
      confirmedFor,
      treatment: text("treatment", 120),
      proposedSlots,
      addAnyway: decision === "confirmed" && form.get("addAnyway") === "1",
      now,
    },
  };
}

export type DecideResult =
  | { status: "done"; message: string }
  | { status: "refused"; message: string }
  /**
   * Google shows the time busy: the screen offers "Confirm anyway" for
   * exactly this time, carrying the name and note so the audited
   * confirmation keeps who made it and why.
   */
  | { status: "busy"; message: string; slotAt: string; treatment: string | null; name: string | null; note: string | null };

/** The refusals and outcomes (plan §7.10), in the desk's words. */
export const DECISION_LINES = {
  notFound: "That request isn't here any more. Reload the page.",
  lapsed: "That request has lapsed: it waited seven days. They were told you'd call, so call them.",
  alreadyDecided: "Someone at your practice has already answered this request. The page now shows where it stands.",
  checking: "We're still checking whether AYA's booking reached your calendar. Try again in a minute.",
  liveCall: "Someone is booking that time on a call right now. Pick another time, or try again in a minute.",
  taken: "Another booking made through healdesk already holds this time. Pick another time.",
  busy: "Your calendar shows that time as busy. Pick another time, or confirm it anyway if you know it is free.",
  alreadyInCalendar: "AYA's booking for this request reached your calendar after all, so it stands as booked.",
} as const;

/** What staff are told once a decision is made: what happened, and that the call is theirs. */
export function decidedLine(decision: BookingDecision, outcome: DecisionOutcome): string {
  switch (decision) {
    case "accepted":
      return "Accepted. Call them to arrange a time, then confirm it here.";
    case "rescheduling":
      return "Times saved. Call them to go through them, then confirm the one they choose here.";
    case "declined":
      return "Declined. They were told your team would call, so call them to find another time.";
    case "confirmed":
      switch (outcome.calendarWrite) {
        case "written":
          return "Confirmed and added to your calendar. Call them to tell them the time.";
        case "failed":
          return "Confirmed here, but it couldn't be added to your calendar: add it by hand, then call them.";
        case "unknown":
          return "Confirmed here. We're checking it reached your calendar, and the page says when it has. Call them to tell them the time.";
        default:
          return "Confirmed here. Add it to your own calendar or booking system, then call them to tell them the time.";
      }
  }
}

/**
 * One decision from Bookings: the request read, with its access row, as
 * this clinic's (another clinic's is not found), then decided as the device
 * whose passkey is live (decideBookingRequest), which takes the fresh look
 * at Google and the idempotent calendar write. Never sends anything to the
 * person.
 */
export async function decideFromBookings(
  page: PatientPage,
  requestId: string,
  parsed: Extract<ParsedDecision, { ok: true }>,
): Promise<DecideResult> {
  if (!isBookingId(requestId)) return { status: "refused", message: DECISION_LINES.notFound };
  const req = await withPatientPage(page, async (tx) => {
    const found = await readBookingRequest(tx, requestId);
    await logPatientAccess(tx, { action: "read", resourceType: "booking_request", resourceId: requestId });
    return found;
  });
  if (!req) return { status: "refused", message: DECISION_LINES.notFound };
  if (req.expired || req.status === "expired") return { status: "refused", message: DECISION_LINES.lapsed };

  const { decision, input } = parsed;
  const outcome = await decideBookingRequest(
    { clinicId: page.portal.clinicId, requestId, actor: deviceActor(page), request: page.request },
    decision,
    // Who decided, as the screen shows it afterwards: the name typed, else the device.
    { ...input, decidedByLabel: input.decidedByLabel ?? page.stepUp.deviceLabel },
  );
  switch (outcome.outcome) {
    case "decided":
      return { status: "done", message: decidedLine(decision, outcome) };
    case "already_in_calendar":
      return { status: "done", message: DECISION_LINES.alreadyInCalendar };
    case "already-decided":
      return { status: "refused", message: DECISION_LINES.alreadyDecided };
    case "invalid":
      return { status: "refused", message: DECISION_LINES.lapsed };
    case "checking":
      return { status: "refused", message: DECISION_LINES.checking };
    case "slot_taken":
      return {
        status: "refused",
        message: outcome.takenBy === "live_call" ? DECISION_LINES.liveCall : DECISION_LINES.taken,
      };
    case "calendar_busy":
      return {
        status: "busy",
        message: DECISION_LINES.busy,
        slotAt: input.confirmedFor!.toISOString(),
        treatment: input.treatment ?? null,
        name: parsed.name,
        note: input.deskNote,
      };
  }
}

// -----------------------------------------------------------------------------
// Deposits and outcomes
// -----------------------------------------------------------------------------

export type MarkResult = { ok: boolean; message: string };

/**
 * "Deposit paid": the front desk took a deposit healdesk left for it, so it
 * leaves Deposits to collect. Only from `pending_front_desk`; a link the
 * patient paid is marked by Stripe's own event (recordDepositPaid). Logged
 * as an access to the appointment and audited as the device's.
 */
export async function markDepositPaid(page: PatientPage, appointmentId: string): Promise<MarkResult> {
  if (!isBookingId(appointmentId)) return { ok: false, message: "That booking isn't here any more. Reload the page." };
  return withPatientPage(page, async (tx) => {
    await logPatientAccess(tx, { action: "read", resourceType: "appointment", resourceId: appointmentId });
    const moved = await tx.db
      .update(appointments)
      .set({ depositStatus: "paid", updatedAt: sql`now()` })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          eq(appointments.depositStatus, "pending_front_desk"),
        ),
      )
      .returning({ id: appointments.id });
    if (moved.length === 0) {
      return { ok: false, message: "That deposit isn't waiting for your team any more. Reload the page." };
    }
    tx.audit.record({
      action: "update",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { outcome: "deposit_marked_paid", by: "practice" },
    });
    return { ok: true, message: "Marked paid. It's off the list of deposits to collect." };
  });
}

const OUTCOME_WORDS: Record<BookingOutcome, string> = {
  showed: "showed",
  no_show: "a no-show",
  cancelled: "cancelled",
};

/**
 * The spec's one outcome control: showed, no-show or cancelled, once the
 * appointment's time has come, on a booking made through healdesk. One
 * click, changeable. It records what happened here only; a change to the
 * calendar is the practice's own.
 */
export async function markBookingOutcome(
  page: PatientPage,
  appointmentId: string,
  outcome: unknown,
  now: Date = new Date(),
): Promise<MarkResult> {
  if (!isBookingId(appointmentId)) return { ok: false, message: "That booking isn't here any more. Reload the page." };
  if (!isBookingOutcome(outcome)) return { ok: false, message: "Choose showed, no-show or cancelled." };
  return withPatientPage(page, async (tx) => {
    await logPatientAccess(tx, { action: "read", resourceType: "appointment", resourceId: appointmentId });
    const marked = await tx.db
      .update(appointments)
      .set({ status: outcome, updatedAt: sql`now()` })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          lte(appointments.scheduledFor, now),
          or(
            isNotNull(appointments.bookingOrigin),
            sql`exists (select 1 from ${bookingRequests} where ${bookingRequests.clinicId} = ${appointments.clinicId} and ${bookingRequests.appointmentId} = ${appointments.id})`,
          ),
        ),
      )
      .returning({ id: appointments.id });
    if (marked.length === 0) {
      return { ok: false, message: "You can mark a booking once its time has come." };
    }
    tx.audit.record({
      action: "update",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { outcome: "marked", status: outcome },
    });
    return { ok: true, message: `Marked as ${OUTCOME_WORDS[outcome]}.` };
  });
}
