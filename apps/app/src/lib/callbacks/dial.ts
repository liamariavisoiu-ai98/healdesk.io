import { resolveBookingRequirements, type BookingField } from "@healdesk/catalog";
import { and, count, eq, gte, inArray, lt, lte, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { bookingRequests, clinics, contactAttempts, contacts, outboundCalls, type OutboundCallPurpose, type ProposedSlot } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { canContact, localClockIn, QUIET_HOURS_END, recordAttempt, SUNDAY, type ContactRefusalCode } from "@/lib/compliance/contact-policy";
import { callbackDisclosure } from "@/lib/compliance/disclosure";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { missingRequirementFields } from "@/lib/voice/ingest";
import { isUsSynthflowBase, VoiceOutboundError, type VoiceOutboundClient } from "@/lib/voice/outbound";
import { joinSpoken, spokenPhone, spokenSlot } from "@/lib/voice/spoken";

/**
 * The pre-dial gate and the dial (design of 23 September 2026, §F.5), plus
 * the two ledger sweeps that decide whether a call is ever followed by
 * another (§F.4, §F.6).
 *
 * `scheduleCallback` (schedule.ts) writes a `due` row and checks every gate
 * it can at that moment. This file checks every gate AGAIN at dial time,
 * because between the two the switch may have been pulled, the number
 * suppressed, the consent revoked, the request decided, or the clock moved
 * into quiet hours — and a call placed under a permission that no longer
 * holds is $500 to $1,500, per call. The order below is the order of how
 * expensive the mistake would be: the switches and the vendor first
 * (nothing may leave), then the person's own protections (suppression
 * outranks consent, quiet hours in THEIR clock), then the request's state,
 * then the caps, and only then the attempt — recorded on `contact_attempts`
 * and on the row as `placing` BEFORE the vendor is asked, in a transaction
 * that commits before the network call, so a crash mid-dial counts against
 * the person rather than allowing a retry storm.
 *
 * Every row is taken `FOR UPDATE SKIP LOCKED`, so two workers cannot dial
 * the same row and a stuck row does not stall the rest.
 *
 * Two outcomes leave the row `due`: quiet hours, which consumes no attempt
 * and records the next 08:00 in the recipient's clock on `gate_basis` so
 * the row is not re-evaluated until then (the design moved `not_before`,
 * but 0040's column grant keeps `not_before` as evidence of when the row
 * was first due, so the deferral is recorded beside it instead); and an
 * unconfirmed clinic timezone, which records nothing because there is no
 * clock to compute an opening in. Every other refusal is final for that
 * row — a `refused` row is evidence of why nothing was placed.
 */

/** A `placed` row with no webhook after this long is `unknown`, and an unknown call is never followed by another (§F.6). */
export const UNKNOWN_AFTER_HOURS = 2;
/** Attempt 2, when attempt 1 positively went unanswered, at least this long after it (§F.4). */
export const SECOND_ATTEMPT_AFTER_HOURS = 4;
/** No more than this many calls to one number in thirty days, whatever the request (§F.5 step 3). */
export const NUMBER_CAP_PER_30_DAYS = 4;
/** A request is not called about more than this long after it was made, whatever its link says (§F.4). */
export const REQUEST_CALL_WINDOW_DAYS = 7;

const DIALER_ACTOR: ActorContext = { type: "service", serviceName: "callback-dialer" };
const OPEN_STATUSES = ["requested", "accepted", "rescheduling"] as const;
const HOUR_MS = 60 * 60 * 1000;

export type DialSummary = {
  considered: number;
  placed: number;
  /** The vendor refused or did not answer; attempt 2 may follow. */
  failed: number;
  /** A gate refused the row for good. */
  refused: number;
  /** Left `due` for a later run: quiet hours, an unconfirmed timezone, or a call to the number still outstanding. */
  deferred: number;
};

type Gate =
  | { kind: "refuse"; code: string; basis: string }
  | { kind: "defer"; code: string; basis: string }
  | { kind: "go"; basis: string; call: Parameters<VoiceOutboundClient["placeCall"]>[0]; attemptNo: number; requestId: string };

const QUIET_UNTIL = /^quiet hours until (\S+)$/;

/** The deferral a quiet-hours refusal leaves on the row, carrying the next opening. */
export function quietHoursBasis(opensAt: Date | null): string {
  return opensAt ? `quiet hours until ${opensAt.toISOString()}` : "quiet hours";
}

/** When a row deferred for quiet hours may be looked at again, or null when it carries no deferral. */
export function deferredUntil(gateBasis: string | null): Date | null {
  const match = gateBasis ? QUIET_UNTIL.exec(gateBasis) : null;
  if (!match) return null;
  const at = new Date(match[1]!);
  return Number.isFinite(at.getTime()) ? at : null;
}

/**
 * Place every callback whose time has come, across every clinic. Returns
 * counts only; the ledger holds the rest.
 */
export async function dialDue(now: Date, deps: { client: VoiceOutboundClient }): Promise<DialSummary> {
  const summary: DialSummary = { considered: 0, placed: 0, failed: 0, refused: 0, deferred: 0 };
  for (const clinic of await listClinics()) {
    const dueRows = await withTenant({ clinicId: clinic.id, actor: DIALER_ACTOR }, (tx) =>
      tx.db
        .select({ id: outboundCalls.id, gateBasis: outboundCalls.gateBasis })
        .from(outboundCalls)
        .where(and(eq(outboundCalls.clinicId, tx.clinicId), eq(outboundCalls.status, "due"), lte(outboundCalls.notBefore, now)))
        .orderBy(outboundCalls.notBefore),
    );
    for (const { id, gateBasis } of dueRows) {
      // Deferred for quiet hours until an instant still ahead: not yet.
      const until = deferredUntil(gateBasis);
      if (until && until.getTime() > now.getTime()) continue;
      summary.considered += 1;
      const outcome = await dialOne(clinic.id, id, now, deps.client);
      summary[outcome] += 1;
    }
  }
  return summary;
}

/** Skipped rows (another worker holds the lock, or the row moved) count as deferred: they are still `due` somewhere. */
async function dialOne(clinicId: string, rowId: string, now: Date, client: VoiceOutboundClient): Promise<"placed" | "failed" | "refused" | "deferred"> {
  // 1. The gate, and the attempt, in one transaction that commits before
  //    the vendor is asked.
  const gate = await withTenant({ clinicId, actor: DIALER_ACTOR }, async (tx): Promise<Gate | null> => {
    const [row] = await tx.db
      .select({
        id: outboundCalls.id,
        bookingRequestId: outboundCalls.bookingRequestId,
        contactId: outboundCalls.contactId,
        purpose: outboundCalls.purpose,
        phone: outboundCalls.phone,
        attemptNo: outboundCalls.attemptNo,
      })
      .from(outboundCalls)
      .where(and(eq(outboundCalls.id, rowId), eq(outboundCalls.clinicId, tx.clinicId), eq(outboundCalls.status, "due"), lte(outboundCalls.notBefore, now)))
      .for("update", { skipLocked: true });
    if (!row) return null;

    const verdict = await evaluateGate(tx, row, now);
    await applyGate(tx, row, verdict);
    return verdict;
  });
  if (!gate) return "deferred";
  if (gate.kind === "refuse") return "refused";
  if (gate.kind === "defer") return "deferred";

  // 2. The vendor, with no transaction open.
  let vendorCallId: string | null = null;
  let failure: { code: string } | null = null;
  try {
    vendorCallId = (await client.placeCall(gate.call)).vendorCallId;
  } catch (error) {
    failure = { code: error instanceof VoiceOutboundError ? error.code : "threw" };
    log.error("callback not placed", { clinicId, requestId: gate.requestId, code: failure.code, error: describeError(error) });
  }

  // 3. The outcome.
  await withTenant({ clinicId, actor: DIALER_ACTOR }, async (tx) => {
    if (vendorCallId) {
      await tx.db
        .update(outboundCalls)
        .set({ status: "placed", vendorCallId, placedAt: now })
        .where(and(eq(outboundCalls.id, rowId), eq(outboundCalls.clinicId, tx.clinicId)));
      tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: rowId, resourceIds: [gate.requestId], metadata: { outcome: "placed", attempt: gate.attemptNo, basis: gate.basis } });
    } else {
      // `completed_at` marks when the attempt concluded, which is what the
      // second attempt is timed from when nothing was ever placed.
      await tx.db
        .update(outboundCalls)
        .set({ status: "failed", refusalCode: "vendor_error", completedAt: now })
        .where(and(eq(outboundCalls.id, rowId), eq(outboundCalls.clinicId, tx.clinicId)));
      tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: rowId, resourceIds: [gate.requestId], metadata: { outcome: "failed", attempt: gate.attemptNo, code: failure?.code } });
    }
  });
  return vendorCallId ? "placed" : "failed";
}

type DueRow = { id: string; bookingRequestId: string; contactId: string; purpose: OutboundCallPurpose; phone: string; attemptNo: number };

/** Steps 1–3 of §F.5, in order, first refusal wins. Reads; writes nothing. */
async function evaluateGate(tx: TenantTx, row: DueRow, now: Date): Promise<Gate> {
  const [clinic] = await tx.db
    .select({
      name: clinics.name,
      timezone: clinics.timezone,
      specialty: clinics.specialty,
      bookingRequirements: clinics.bookingRequirements,
      outboundCallbacksEnabled: clinics.outboundCallbacksEnabled,
      timezoneConfirmedAt: clinics.timezoneConfirmedAt,
      publishedPhoneE164: clinics.publishedPhoneE164,
      synthflowNumberE164: clinics.synthflowNumberE164,
      callbackAgentId: clinics.synthflowCallbackAgentId,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return { kind: "refuse", code: "outbound_disabled", basis: "no such clinic" };

  // Step 1: the switches and the vendor. Nothing may leave.
  if (!env.outboundCallbacksEnabled()) return { kind: "refuse", code: "outbound_disabled", basis: "environment switch off" };
  if (!clinic.outboundCallbacksEnabled) return { kind: "refuse", code: "outbound_disabled", basis: "clinic switch off" };
  if (!env.synthflowApiKey()) return { kind: "refuse", code: "outbound_disabled", basis: "no vendor" };
  if (!isUsSynthflowBase(env.synthflowApiBase())) return { kind: "refuse", code: "vendor_base", basis: "non-US vendor base" };
  if (!clinic.publishedPhoneE164) return { kind: "refuse", code: "no_published_phone", basis: "no published phone" };
  if (!clinic.callbackAgentId) return { kind: "refuse", code: "no_agent", basis: "no callback agent" };

  // Step 2: the person's protections, in their clock. A provisioning
  // default is not a clock, so an unconfirmed timezone leaves the row where
  // it is; quiet hours move it to the next opening.
  if (!clinic.timezoneConfirmedAt) return { kind: "defer", code: "quiet_hours", basis: "clinic timezone unconfirmed" };
  const [contact] = await tx.db.select({ timezone: contacts.timezone, fullName: contacts.fullName }).from(contacts).where(and(eq(contacts.id, row.contactId), eq(contacts.clinicId, tx.clinicId))).limit(1);
  const decision = await canContact(tx.db, {
    clinicId: tx.clinicId,
    phone: row.phone,
    channel: "voice",
    purpose: "callback",
    recipientTimezone: contact?.timezone ?? null,
    clinicEnabled: clinic.outboundCallbacksEnabled,
    now,
  });
  if (!decision.allowed) {
    if (decision.code === "quiet_hours") {
      return { kind: "defer", code: "quiet_hours", basis: quietHoursBasis(nextWindowOpen(contact?.timezone ?? clinic.timezone, now)) };
    }
    return { kind: "refuse", code: decision.code, basis: basisFor(decision.code) };
  }

  // Step 3: the request's state, the caps, and no call outstanding.
  const [request] = await tx.db
    .select({
      status: bookingRequests.status,
      createdAt: bookingRequests.createdAt,
      expiresAt: bookingRequests.expiresAt,
      preferredWindow: bookingRequests.preferredWindow,
      alternativeWindows: bookingRequests.alternativeWindows,
      treatment: bookingRequests.treatment,
      collectedFields: bookingRequests.collectedFields,
      proposedSlots: bookingRequests.proposedSlots,
      confirmedFor: bookingRequests.confirmedFor,
    })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.id, row.bookingRequestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .limit(1);
  if (!request) return { kind: "refuse", code: "request_terminal", basis: "no such request" };
  const open = (OPEN_STATUSES as readonly string[]).includes(request.status) || (row.purpose === "confirm_time" && request.status === "confirmed");
  if (!open) return { kind: "refuse", code: "request_terminal", basis: `request ${request.status}` };
  if (now.getTime() >= callDeadline(request).getTime()) return { kind: "refuse", code: "request_expired", basis: "request past its call window" };

  const [attempts] = await tx.db
    .select({ n: count() })
    .from(contactAttempts)
    .where(and(eq(contactAttempts.clinicId, tx.clinicId), eq(contactAttempts.phone, row.phone), gte(contactAttempts.attemptedAt, new Date(now.getTime() - 30 * 24 * HOUR_MS))));
  if ((attempts?.n ?? 0) >= NUMBER_CAP_PER_30_DAYS) return { kind: "refuse", code: "number_cap", basis: `${NUMBER_CAP_PER_30_DAYS} calls to this number in 30 days` };

  const [outstanding] = await tx.db
    .select({ id: outboundCalls.id })
    .from(outboundCalls)
    .where(and(eq(outboundCalls.clinicId, tx.clinicId), eq(outboundCalls.phone, row.phone), ne(outboundCalls.id, row.id), inArray(outboundCalls.status, ["placing", "placed"])))
    .limit(1);
  if (outstanding) return { kind: "defer", code: "call_outstanding", basis: "another call to this number is outstanding" };

  // Everything passed: what the agent will say.
  const requirements = resolveBookingRequirements(clinic.specialty, clinic.bookingRequirements ?? null);
  const timeZone = contact?.timezone ?? clinic.timezone;
  const firstName = firstNameOf(contact?.fullName);
  const clinicPhoneSpoken = spokenPhone(clinic.publishedPhoneE164);
  const variables = callbackVariables({
    firstName,
    purpose: row.purpose,
    clinicName: clinic.name,
    clinicPhoneSpoken,
    preferredWindow: request.preferredWindow,
    alternativeWindows: request.alternativeWindows,
    missingFields: missingRequirementFields(requirements, request),
    proposedSlots: request.proposedSlots,
    confirmedFor: request.confirmedFor,
    timeZone,
  });
  return {
    kind: "go",
    basis: decision.basis,
    attemptNo: row.attemptNo,
    requestId: row.bookingRequestId,
    call: {
      clinicId: tx.clinicId,
      agentId: clinic.callbackAgentId,
      toPhone: row.phone,
      fromPhone: clinic.synthflowNumberE164,
      name: firstName,
      greeting: callbackDisclosure({ clinicName: clinic.name, clinicPhoneSpoken }),
      timeZone,
      variables,
    },
  };
}

/** Write what the gate decided: the refusal, the deferral, or the attempt and `placing`. */
async function applyGate(tx: TenantTx, row: DueRow, gate: Gate): Promise<void> {
  const where = and(eq(outboundCalls.id, row.id), eq(outboundCalls.clinicId, tx.clinicId));
  if (gate.kind === "refuse") {
    await tx.db.update(outboundCalls).set({ status: "refused", refusalCode: gate.code, gateBasis: gate.basis }).where(where);
    tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: row.id, resourceIds: [row.bookingRequestId], metadata: { outcome: "refused_by_gate", code: gate.code, basis: gate.basis, attempt: row.attemptNo } });
    return;
  }
  if (gate.kind === "defer") {
    await tx.db.update(outboundCalls).set({ gateBasis: gate.basis }).where(where);
    // The instant stays on the row: an ISO timestamp is a digit run the audit scanner reads as a number.
    tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: row.id, resourceIds: [row.bookingRequestId], metadata: { outcome: "deferred", code: gate.code, basis: gate.basis.replace(/ until .*$/, "") } });
    return;
  }
  // The attempt is on the ledger BEFORE the vendor is asked (§F.5 step 4).
  await recordAttempt(tx.db, { clinicId: tx.clinicId, phone: row.phone, channel: "voice", purpose: "callback" });
  await tx.db.update(outboundCalls).set({ status: "placing", gateBasis: gate.basis }).where(where);
  tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: row.id, resourceIds: [row.bookingRequestId], metadata: { outcome: "placing", attempt: row.attemptNo, purpose: row.purpose } });
}

function basisFor(code: ContactRefusalCode): string {
  switch (code) {
    case "suppressed":
      return "number suppressed";
    case "no_consent":
      return "no consent on file";
    case "needs_written_consent":
      return "written consent required";
    case "daily_cap":
    case "weekly_cap":
      return "frequency cap";
    case "quiet_hours":
      return "quiet hours";
    case "outbound_disabled":
      return "switch off";
  }
}

/** LEAST(expires_at, created_at + 7 days): the latest instant a call about this request may be placed. */
export function callDeadline(request: { createdAt: Date; expiresAt: Date }): Date {
  return new Date(Math.min(request.expiresAt.getTime(), request.createdAt.getTime() + REQUEST_CALL_WINDOW_DAYS * 24 * HOUR_MS));
}

function firstNameOf(fullName: string | null | undefined): string {
  const first = fullName?.trim().split(/\s+/)[0];
  return first || "there";
}

// -----------------------------------------------------------------------------
// What the callback agent is told (§F.9)
// -----------------------------------------------------------------------------

export type CallbackVariableInput = {
  firstName: string;
  purpose: OutboundCallPurpose;
  clinicName: string;
  clinicPhoneSpoken: string;
  preferredWindow: string;
  alternativeWindows: readonly string[];
  /** The practice's requirement fields the request still lacks; the agent hears their labels. */
  missingFields: readonly BookingField[];
  proposedSlots: readonly ProposedSlot[];
  confirmedFor: Date | null;
  timeZone: string;
};

/**
 * The `custom_variables` the callback agent's script is driven by: strings
 * only, every one of them spoken-form, and `missing_fields` as catalogue
 * LABELS, never ids — the script reads "Last name, Service asked about" out
 * loud. Pure, so a test can assert the requirement set drives it.
 */
export function callbackVariables(input: CallbackVariableInput): Record<string, string> {
  return {
    first_name: input.firstName,
    purpose: input.purpose,
    clinic_name: input.clinicName,
    clinic_phone_spoken: input.clinicPhoneSpoken,
    primary_window: input.preferredWindow,
    alternative_windows: joinSpoken(input.alternativeWindows),
    missing_fields: input.missingFields.map((f) => f.label).join(", "),
    proposed_slots_spoken: input.proposedSlots.map((s) => spokenSlot(new Date(s.at), input.timeZone)).join("; "),
    confirmed_slot_spoken: input.confirmedFor ? spokenSlot(input.confirmedFor, input.timeZone) : "",
  };
}

// -----------------------------------------------------------------------------
// The window
// -----------------------------------------------------------------------------

/**
 * The next instant the window opens in the given zone: 08:00 local today if
 * that is still ahead, else 08:00 on the next day that is not a Sunday. Null
 * when the zone is not one Intl knows — the row then stays where it is and
 * the gate refuses it again next run, which is the fail-closed answer.
 */
export function nextWindowOpen(timeZone: string | null | undefined, now: Date): Date | null {
  if (!timeZone) return null;
  const today = localDate(timeZone, now);
  if (!today) return null;
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead, 12));
    const clock = localClockIn(timeZone, day);
    if (!clock || clock.weekday === SUNDAY) continue;
    const candidate = zonedToUtc(timeZone, { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: QUIET_HOURS_END, minute: 0 });
    if (candidate && candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

function localDate(timeZone: string, at: Date): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    const out = { year: get("year"), month: get("month"), day: get("day") };
    return Number.isInteger(out.year) && Number.isInteger(out.month) && Number.isInteger(out.day) ? out : null;
  } catch {
    return null;
  }
}

/** A wall-clock time in a zone, as an instant: two passes so the zone's offset at THAT instant is used. */
function zonedToUtc(timeZone: string, wall: { year: number; month: number; day: number; hour: number; minute: number }): Date | null {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const read = localDate(timeZone, new Date(guess));
    const clock = localClockIn(timeZone, new Date(guess));
    if (!read || !clock) return null;
    const readAsUtc = Date.UTC(read.year, read.month - 1, read.day, clock.hour, clock.minute);
    guess = guess - (readAsUtc - asUtc);
  }
  return new Date(guess);
}

// -----------------------------------------------------------------------------
// The ledger sweeps (§F.4, §F.6)
// -----------------------------------------------------------------------------

export type SweepSummary = { unknown: number; secondAttempts: number };

/**
 * Two rules about what follows a placed call, applied across every clinic:
 *
 *   - a `placed` row whose webhook has not arrived after two hours becomes
 *     `unknown` — never `failed`, because the call may well have connected
 *     and the webhook been lost — and an unknown call is never followed by
 *     another;
 *   - attempt 2 is inserted only for an attempt-1 row that positively went
 *     unanswered (`failed`: the webhook said no answer, busy or a vendor
 *     error, or the vendor refused the dial), at least four hours after it,
 *     only while the request is still open and only before its deadline.
 *     The consent-match trigger and the attempt index refuse anything else
 *     by shape; a consent revoked meanwhile surfaces as 42501 and is
 *     recorded, not retried.
 */
export async function sweepOutboundCalls(now: Date): Promise<SweepSummary> {
  const summary: SweepSummary = { unknown: 0, secondAttempts: 0 };
  for (const clinic of await listClinics()) {
    const result = await withTenant({ clinicId: clinic.id, actor: DIALER_ACTOR }, async (tx) => {
      const stale = await tx.db
        .update(outboundCalls)
        .set({ status: "unknown" })
        .where(and(eq(outboundCalls.clinicId, tx.clinicId), eq(outboundCalls.status, "placed"), lt(outboundCalls.placedAt, new Date(now.getTime() - UNKNOWN_AFTER_HOURS * HOUR_MS))))
        .returning({ id: outboundCalls.id, requestId: outboundCalls.bookingRequestId });
      for (const r of stale) {
        tx.audit.record({ action: "update", resourceType: "outbound_call", resourceId: r.id, resourceIds: [r.requestId], metadata: { outcome: "unknown", reason: "no webhook", afterHours: UNKNOWN_AFTER_HOURS } });
      }

      const second = alias(outboundCalls, "second");
      const candidates = await tx.db
        .select({
          id: outboundCalls.id,
          requestId: outboundCalls.bookingRequestId,
          contactId: outboundCalls.contactId,
          consentRecordId: outboundCalls.consentRecordId,
          purpose: outboundCalls.purpose,
          phone: outboundCalls.phone,
          concludedAt: sql<Date | null>`coalesce(${outboundCalls.placedAt}, ${outboundCalls.completedAt})`,
          requestStatus: bookingRequests.status,
          requestCreatedAt: bookingRequests.createdAt,
          requestExpiresAt: bookingRequests.expiresAt,
        })
        .from(outboundCalls)
        .innerJoin(bookingRequests, eq(bookingRequests.id, outboundCalls.bookingRequestId))
        .where(
          and(
            eq(outboundCalls.clinicId, tx.clinicId),
            eq(outboundCalls.attemptNo, 1),
            eq(outboundCalls.status, "failed"),
            notExists(
              tx.db
                .select({ one: sql`1` })
                .from(second)
                .where(and(eq(second.bookingRequestId, outboundCalls.bookingRequestId), eq(second.attemptNo, 2))),
            ),
          ),
        );
      let inserted = 0;
      for (const c of candidates) {
        const open = (OPEN_STATUSES as readonly string[]).includes(c.requestStatus) || (c.purpose === "confirm_time" && c.requestStatus === "confirmed");
        if (!open || !c.concludedAt) continue;
        const notBefore = new Date(new Date(c.concludedAt).getTime() + SECOND_ATTEMPT_AFTER_HOURS * HOUR_MS);
        if (notBefore.getTime() >= callDeadline({ createdAt: c.requestCreatedAt, expiresAt: c.requestExpiresAt }).getTime()) continue;
        try {
          // A savepoint: the consent-match trigger raising must not abort
          // the sweep's transaction for the other clinics' rows.
          const [row] = await tx.db.transaction((sp) =>
            sp
              .insert(outboundCalls)
              .values({ clinicId: tx.clinicId, contactId: c.contactId, bookingRequestId: c.requestId, consentRecordId: c.consentRecordId, purpose: c.purpose, phone: c.phone, attemptNo: 2, notBefore, status: "due" })
              .onConflictDoNothing({ target: [outboundCalls.bookingRequestId, outboundCalls.attemptNo] })
              .returning({ id: outboundCalls.id }),
          );
          if (row) {
            inserted += 1;
            tx.audit.record({ action: "create", resourceType: "outbound_call", resourceId: row.id, resourceIds: [c.requestId], metadata: { purpose: c.purpose, attempt: 2, after: c.id } });
          }
        } catch (error) {
          // The consent-match trigger: revoked since attempt 1. Recorded, never retried.
          if (isPermissionDenied(error)) {
            tx.audit.record({ action: "create", resourceType: "outbound_call", resourceIds: [c.requestId], metadata: { outcome: "refused", attempt: 2, reason: "consent_no_longer_matches" } });
            continue;
          }
          throw error;
        }
      }
      return { unknown: stale.length, secondAttempts: inserted };
    });
    summary.unknown += result.unknown;
    summary.secondAttempts += result.secondAttempts;
  }
  return summary;
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "42501";
}
