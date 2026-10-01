// PHASE TWO: attribution (POS/EMR read-back, sync, reconciliation and the
// monthly revenue report). Not part of v1: kept, but fenced out of v1 flows,
// screens, emails and copy (HEALDESK_PHASE_TWO_ATTRIBUTION, lib/env.ts).
import { createHash } from "node:crypto";

/**
 * Tying money to visits.
 *
 * This is the product. Everything else — connectors, cursors, RLS — exists so
 * that this function has honest inputs, and the monthly figure a clinic judges
 * us on comes out of here.
 *
 * Three rules it enforces, in order of how much damage getting them wrong does:
 *
 *   1. **A deposit is not attendance.** Money taken at booking proves the
 *      appointment was made, nothing more. Treating it as evidence of a visit
 *      counts every forfeited deposit as a successful one, which inflates
 *      precisely the number we are asking to be trusted on.
 *
 *   2. **Ambiguity is not a guess.** A patient with two appointments in a week
 *      and one payment produces an exception, not a coin flip. A wrong match is
 *      worse than an unmatched one: the unmatched shows up as a caveat the
 *      clinic can check, the wrong one silently misattributes revenue.
 *
 *   3. **Unmatched money is surfaced, never absorbed.** Sales we cannot place
 *      go to the exception queue with an amount attached, and the total appears
 *      in the report as a caveat. A total that quietly omits what it couldn't
 *      explain is the failure mode this whole system exists to replace.
 *
 * The matcher is pure and takes plain records, so the interesting cases —
 * deposits, walk-ins, refunds, two visits one payment — are tested in
 * milliseconds without a database. `reconcile()` in ./reconcile-store.ts does
 * the persistence.
 */

export type MatchConfidence =
  /** The platform told us which visit this sale belongs to. */
  | "exact"
  /** Same person, money taken during or just after the visit. */
  | "high"
  /** Same person, one plausible visit in range, but the timing is loose. */
  | "medium";

export type AppointmentRecord = {
  id: string;
  contactId: string;
  scheduledFor: Date;
  checkedInAt: Date | null;
  status: "scheduled" | "confirmed" | "showed" | "no_show" | "cancelled" | "rescheduled";
  /** Set when an agent conversation produced the booking. */
  conversationId: string | null;
};

export type SaleRecord = {
  id: string;
  contactId: string | null;
  /** Platform-provided link, when the platform bothers to have one. */
  appointmentId: string | null;
  amountUsd: string;
  collectedAt: Date;
};

export type Match = {
  saleId: string;
  appointmentId: string;
  confidence: MatchConfidence;
  /**
   * Whether this payment is evidence the patient turned up.
   *
   * False for anything collected meaningfully before the appointment — see
   * rule 1. The revenue still counts; the attendance does not.
   */
  impliesAttendance: boolean;
};

export type Exception = {
  kind: "unmatched_sale" | "unmatched_appointment" | "ambiguous_match" | "missing_arrival";
  fingerprint: string;
  saleId?: string;
  appointmentId?: string;
  amountAtRiskUsd?: string;
  /** Plain sentence for the console. Never contains a patient identifier. */
  summary: string;
};

export type ReconcileResult = {
  matches: Match[];
  exceptions: Exception[];
};

/**
 * How long after an appointment a payment can still plausibly belong to it.
 *
 * A day. Clinics settle at the desk, but a card that declines gets re-run that
 * evening, and a treatment plan sold at the visit sometimes gets keyed the next
 * morning. Beyond that the link is speculation.
 */
const AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long before an appointment a payment can be a deposit for it.
 *
 * 30 days. Deposits get taken at booking, and high-ticket clinics book weeks
 * out — this is exactly the case that must count as revenue but not as
 * attendance.
 */
const DEPOSIT_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The grace period before a payment counts as evidence of arrival.
 *
 * Two hours before the slot: someone paying at 1:50pm for a 2pm appointment is
 * standing at the desk. Someone who paid three weeks ago is not.
 */
const ARRIVAL_GRACE_MS = 2 * 60 * 60 * 1000;

export type ReconcileOptions = {
  /**
   * "Now", for deciding whether an appointment is late enough to complain
   * about. Injectable so tests don't drift, and load-bearing: without it, every
   * appointment booked for next Tuesday raises "no payment found" the moment it
   * is created, and the exception queue fills with things that aren't wrong yet.
   */
  asOf?: Date;
  /**
   * Only raise appointment-side exceptions for visits inside this window.
   *
   * The caller reads a wider range of appointments than it reports on — a
   * deposit collected in March can belong to a May visit — but must not raise
   * exceptions for the months either side, or every report would re-complain
   * about its neighbours.
   */
  exceptionWindow?: { from: Date; to: Date };
};

export function reconcile(
  appointments: AppointmentRecord[],
  sales: SaleRecord[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const asOf = options.asOf ?? new Date();
  const inExceptionWindow = (appointment: AppointmentRecord): boolean => {
    if (!options.exceptionWindow) return true;
    const at = appointment.scheduledFor.getTime();
    return (
      at >= options.exceptionWindow.from.getTime() &&
      at < options.exceptionWindow.to.getTime()
    );
  };

  const byId = new Map(appointments.map((a) => [a.id, a]));
  const byContact = new Map<string, AppointmentRecord[]>();
  for (const appointment of appointments) {
    const list = byContact.get(appointment.contactId) ?? [];
    list.push(appointment);
    byContact.set(appointment.contactId, list);
  }

  const matches: Match[] = [];
  const exceptions: Exception[] = [];
  const matchedAppointments = new Set<string>();

  for (const sale of sales) {
    // --- Exact: the platform already linked it. Trust it. -------------------
    if (sale.appointmentId && byId.has(sale.appointmentId)) {
      const appointment = byId.get(sale.appointmentId)!;
      matches.push({
        saleId: sale.id,
        appointmentId: appointment.id,
        confidence: "exact",
        impliesAttendance: impliesAttendance(sale, appointment),
      });
      matchedAppointments.add(appointment.id);
      continue;
    }

    // --- No person, no match. Walk-in, or a sale the platform doesn't link. --
    if (!sale.contactId) {
      exceptions.push(unmatchedSale(sale, "no patient is attached to it"));
      continue;
    }

    const candidates = (byContact.get(sale.contactId) ?? []).filter((a) =>
      inRange(sale, a),
    );

    if (candidates.length === 0) {
      exceptions.push(
        unmatchedSale(sale, "no appointment for that patient falls near the payment date"),
      );
      continue;
    }

    // --- One candidate. Confidence depends on how tight the timing is. ------
    if (candidates.length === 1) {
      const appointment = candidates[0]!;
      matches.push({
        saleId: sale.id,
        appointmentId: appointment.id,
        confidence: tightWindow(sale, appointment) ? "high" : "medium",
        impliesAttendance: impliesAttendance(sale, appointment),
      });
      matchedAppointments.add(appointment.id);
      continue;
    }

    // --- Several. Only break the tie if one is dramatically closer. ---------
    const ranked = [...candidates].sort(
      (a, b) => distance(sale, a) - distance(sale, b),
    );
    const [closest, runnerUp] = ranked as [AppointmentRecord, AppointmentRecord];

    if (
      tightWindow(sale, closest) &&
      !tightWindow(sale, runnerUp)
    ) {
      matches.push({
        saleId: sale.id,
        appointmentId: closest.id,
        confidence: "high",
        impliesAttendance: impliesAttendance(sale, closest),
      });
      matchedAppointments.add(closest.id);
      continue;
    }

    // Genuinely ambiguous. Rule 2: no guess.
    exceptions.push({
      kind: "ambiguous_match",
      fingerprint: fingerprint("ambiguous", sale.id),
      saleId: sale.id,
      amountAtRiskUsd: sale.amountUsd,
      summary: `A payment of $${sale.amountUsd} could belong to ${candidates.length} different appointments for the same patient, so it is not counted.`,
    });
  }

  // --- Visits with no money against them. ----------------------------------
  for (const appointment of appointments) {
    if (matchedAppointments.has(appointment.id)) continue;
    if (!inExceptionWindow(appointment)) continue;
    // Not yet due. A booking for next week has no payment because it hasn't
    // happened, which is not a reconciliation problem.
    if (appointment.scheduledFor.getTime() > asOf.getTime()) continue;

    if (appointment.status === "showed") {
      exceptions.push({
        kind: "unmatched_appointment",
        fingerprint: fingerprint("unmatched_appointment", appointment.id),
        appointmentId: appointment.id,
        summary:
          "A patient attended an appointment but no payment was found for it, so no revenue is counted against that visit.",
      });
      continue;
    }

    // The gap that matters most: booked, the date has passed, and the platform
    // never told us whether they came. Reported as unmeasurable rather than
    // treated as a no-show, which would quietly deflate every clinic on a
    // platform without check-in.
    if (
      (appointment.status === "scheduled" || appointment.status === "confirmed") &&
      appointment.checkedInAt === null
    ) {
      exceptions.push({
        kind: "missing_arrival",
        fingerprint: fingerprint("missing_arrival", appointment.id),
        appointmentId: appointment.id,
        summary:
          "This appointment's date has passed but the booking system never recorded whether the patient arrived, so it is excluded from the attendance figures.",
      });
    }
  }

  return { matches, exceptions };
}

/** Total revenue from matches, as a fixed-2 string. Cents survive. */
export function matchedTotal(
  matches: Match[],
  sales: SaleRecord[],
): string {
  const amounts = new Map(sales.map((s) => [s.id, s.amountUsd]));
  let cents = 0n;

  for (const match of matches) {
    cents += toCents(amounts.get(match.saleId) ?? "0");
  }

  return fromCents(cents);
}

export function exceptionTotal(exceptions: Exception[]): string {
  let cents = 0n;
  for (const exception of exceptions) {
    if (exception.amountAtRiskUsd) cents += toCents(exception.amountAtRiskUsd);
  }
  return fromCents(cents);
}

// -----------------------------------------------------------------------------

function inRange(sale: SaleRecord, appointment: AppointmentRecord): boolean {
  const delta = sale.collectedAt.getTime() - appointment.scheduledFor.getTime();
  return delta <= AFTER_MS && delta >= -DEPOSIT_BEFORE_MS;
}

/** Paid at the desk, near enough that the link isn't a guess. */
function tightWindow(sale: SaleRecord, appointment: AppointmentRecord): boolean {
  const delta = sale.collectedAt.getTime() - appointment.scheduledFor.getTime();
  return delta >= -ARRIVAL_GRACE_MS && delta <= AFTER_MS;
}

function distance(sale: SaleRecord, appointment: AppointmentRecord): number {
  return Math.abs(
    sale.collectedAt.getTime() - appointment.scheduledFor.getTime(),
  );
}

/**
 * Rule 1, in one function.
 *
 * A recorded check-in settles it outright. Otherwise the payment has to have
 * happened at or after the appointment — anything earlier is a deposit, and a
 * deposit is compatible with never showing up.
 */
function impliesAttendance(
  sale: SaleRecord,
  appointment: AppointmentRecord,
): boolean {
  if (appointment.checkedInAt) return true;
  if (appointment.status === "no_show" || appointment.status === "cancelled") {
    return false;
  }
  return (
    sale.collectedAt.getTime() >=
    appointment.scheduledFor.getTime() - ARRIVAL_GRACE_MS
  );
}

function unmatchedSale(sale: SaleRecord, reason: string): Exception {
  return {
    kind: "unmatched_sale",
    fingerprint: fingerprint("unmatched_sale", sale.id),
    saleId: sale.id,
    amountAtRiskUsd: sale.amountUsd,
    summary: `A payment of $${sale.amountUsd} could not be tied to an appointment because ${reason}.`,
  };
}

/**
 * A stable id for "this same problem".
 *
 * Hashed rather than concatenated because the row is unique per clinic on this
 * value and the inputs are internal uuids — hashing keeps the column a fixed
 * width and stops anyone reading an identifier out of an index.
 */
function fingerprint(kind: string, subjectId: string): string {
  return createHash("sha256").update(`${kind}:${subjectId}`).digest("hex").slice(0, 32);
}

/** Money stays in integer cents through every sum. Floats lose pennies. */
function toCents(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.trim().replace(/^\+/, "").split(".");
  const padded = (fraction + "00").slice(0, 2);
  const negative = whole.startsWith("-");
  const magnitude =
    BigInt(whole.replace("-", "") || "0") * 100n + BigInt(padded || "0");
  return negative ? -magnitude : magnitude;
}

function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
