import { audienceFor } from "@healdesk/catalog";
import {
  googleCalendarAdapter,
  type ConnectorContext,
  type ConnectorError,
} from "@healdesk/connectors";
import { and, eq, inArray, sql } from "drizzle-orm";

import { agentConfigs, appointments, bookingRequests, clinics, slotHolds } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  calendarBreakOf,
  confirmCalendarTarget,
  isTokenBreak,
  markCalendarBroken,
} from "@/lib/connections/google-calendar";
import { describeError, log } from "@/lib/log";
import {
  recordAssistantWrite,
  releaseAssistantHold,
  type HoldFence,
  type RecordedLateWrite,
} from "@/lib/meta/booking-requests";
import { notifyBookingAlert, type BookingAlertKind } from "@/lib/notices/booking-alerts";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { openContext, serviceDuration } from "./availability";
import { writableConnection, type WritableConnection } from "./calendar";
import type { DepositLineFacts } from "./deposit-gate";
import { ANSWERED_AS_REQUEST, spentHolds } from "./holds";

/**
 * The assistant's own Google write (plan §7.7 step 7, §7.8, §7.9, §7.11),
 * and the five-minute watch's settling of writes nobody saw finish.
 *
 * The booking engine (lib/booking/book.ts) claims a hold first: the hold is
 * `writing`, with a lease, a request and a 15-minute blocking window, and
 * the claim has committed. Then, with no transaction open, exactly one
 * Google insert is made for it, under the id derived from "hold:" + the
 * hold's id, with the start and length read from the hold row and nothing
 * else: a first name, the service as the clinic's list names it, and the
 * time (packages/connectors/src/google/event.ts). Before it, HRC-04's check
 * that the calendar is still one the location may book into.
 *
 * What Google says decides the rest (plan §7.8):
 *
 *   written            the record step (recordAssistantWrite, fenced by the
 *                      lease): the hold converted, the booking recorded as
 *                      written, the request confirmed by the assistant;
 *   unknown            a timeout, the network, a 5xx, a reply we cannot
 *                      read: one immediate read-back; found is written;
 *                      otherwise the hold is `unknown` and the watch reads
 *                      it back later;
 *   broken             the grant or the location's calendar is gone: the
 *                      location is marked broken (manual booking in the same
 *                      turn) and the request is the desk's;
 *   refused            anything else Google refuses, a named provider's
 *                      calendar gone included: the request is the desk's.
 *
 * A record step that meets the span retaken (23P01) or the request decided
 * rolls back and releases the hold. Nothing is retried, and no event is ever
 * deleted.
 *
 * The clinic hears through booking alerts (lib/notices/booking-alerts.ts),
 * ids only, each raised inside the transaction that commits the state it
 * reports, so no state commits without its alert and no alert goes for work
 * that rolled back. No desk link is mailed and none re-issued (the design
 * record's §9, item 11). One alert per event:
 *
 *   a booking written, now or found later          none (the daily summary
 *                                                  lists it; a deposit left
 *                                                  to the desk is D's L10);
 *   the write unconfirmed (`unknown`)              calendar_check (L34);
 *   the write refused, the calendar broken, or     booking_request (L7): the
 *   the write no longer permitted                  request is the desk's;
 *   the write reached Google after its time was    calendar_check (L34): look
 *   retaken, or after its request was decided      for a duplicate;
 *   the watch giving up on a write it could not    calendar_check (L34).
 *   settle
 *
 * A caller already answered with a request while the write was in flight
 * (ANSWERED_AS_REQUEST; the engine raised L7 then) gets none of the first
 * three again.
 */

const WRITER_ACTOR: ActorContext = { type: "service", serviceName: "booking-engine" };
const WATCH_ACTOR: ActorContext = { type: "service", serviceName: "calendar-watch" };

/** Failure reasons after which Google may still hold the booking. */
const UNKNOWN_REASONS: ReadonlySet<string> = new Set(["timeout", "network", "unconfirmed"]);
/** How long after the insert attempt a write may still be on its way (plan §7.11). */
export const WRITE_GRACE_MINUTES = 2;

export type HeldWriteInput = {
  /** The caller's first name, validated by the engine; the event carries nothing more of them. */
  firstName: string;
  actor?: ActorContext;
  now?: Date;
};

export type HeldWrite =
  | {
      kind: "booked";
      appointmentId: string | null;
      startsAt: Date;
      minutes: number;
      /** A deposit left for the front desk, for the voice line; never a link. */
      deposit: DepositLineFacts | null;
    }
  /** Google did not confirm it; the hold is `unknown` and the watch reads it back. */
  | { kind: "unconfirmed" }
  /** The grant or the location's calendar is gone; the location books by request now. */
  | { kind: "calendar_broken" }
  | { kind: "refused" }
  /** It reached Google, but its time was retaken or its request decided first. */
  | { kind: "conflict" }
  /** The lease was lost: someone else (the watch, a change of calendar) settled the hold. */
  | { kind: "lost" };

type Prepared = {
  context: ConnectorContext;
  target: WritableConnection;
  calendarId: string;
  startsAt: Date;
  minutes: number;
  service: string | null;
  timeZone: string;
  audience: "patients" | "clients";
  key: string;
};

type Prepare = { kind: "go"; prepared: Prepared } | { kind: "lost" } | { kind: "not_permitted" };

type Attempt =
  | { kind: "written"; externalId: string }
  | { kind: "unknown"; reason: string }
  | { kind: "broken"; error: ConnectorError }
  | { kind: "refused"; reason: string };

/**
 * Write one claimed hold into Google and settle it (plan §7.8). `lease` is
 * the token the claim wrote; a hold no longer `writing` under it is someone
 * else's to settle. Never throws for Google's answers; a database failure
 * propagates to the engine, and the hold's lease runs out to the watch.
 */
export async function writeHeldBooking(
  clinicId: string,
  holdId: string,
  lease: string,
  input: HeldWriteInput,
): Promise<HeldWrite> {
  const actor = input.actor ?? WRITER_ACTOR;
  const fence: HoldFence = { lease };
  const step = await withTenant({ clinicId, actor }, (tx) => prepareWrite(tx, holdId, lease));
  if (step.kind === "lost") return { kind: "lost" };
  if (step.kind === "not_permitted") {
    // The terms, the connection or the location changed since the claim:
    // nothing was written, and the request is the desk's.
    await withTenant({ clinicId, actor }, (tx) =>
      letGoWithin(tx, holdId, fence, "calendar_not_permitted", "booking_request"),
    );
    return { kind: "refused" };
  }
  const p = step.prepared;

  let attempt: Attempt;
  try {
    attempt = await insertOnce(p, input.firstName);
  } catch (error) {
    log.error("assistant calendar write threw", {
      clinicId,
      connectionId: p.target.connectionId,
      error: describeError(error),
    });
    attempt = { kind: "unknown", reason: "threw" };
  }
  if (attempt.kind === "unknown") {
    // One immediate read-back (plan §7.8): a reply lost on the way is still
    // a booking made.
    const found = await googleCalendarAdapter
      .findAppointmentByKey(p.context, { idempotencyKey: p.key, around: p.startsAt })
      .catch(() => null);
    if (found?.ok && found.value) attempt = { kind: "written", externalId: found.value.externalId };
  }

  const now = input.now ?? new Date();
  if (attempt.kind === "written") {
    return recordWrite(clinicId, holdId, attempt.externalId, fence, now, actor);
  }
  if (attempt.kind === "unknown") {
    const reason = attempt.reason;
    const moved = await withTenant({ clinicId, actor }, async (tx) => {
      const [hold] = await tx.db
        .update(slotHolds)
        .set({
          status: "unknown",
          nextCheckAt: sql`clock_timestamp() + make_interval(mins => ${WRITE_GRACE_MINUTES})`,
          updatedAt: sql`now()`,
        })
        .where(and(holdFenced(holdId, fence), eq(slotHolds.clinicId, tx.clinicId)))
        .returning({
          outcomeReason: slotHolds.outcomeReason,
          requestId: slotHolds.bookingRequestId,
        });
      if (!hold) return false;
      tx.audit.record({
        action: "update",
        resourceType: "slot_hold",
        resourceId: holdId,
        metadata: { outcome: "unknown", reason: reason.slice(0, 40) },
      });
      if (hold.requestId && hold.outcomeReason !== ANSWERED_AS_REQUEST) {
        await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: hold.requestId });
      }
      return true;
    });
    return moved ? { kind: "unconfirmed" } : { kind: "lost" };
  }
  if (attempt.kind === "broken") {
    const code = calendarBreakOf(attempt.error);
    // A named provider's calendar gone is that calendar's problem, not the
    // location's (as availability reads it): the location stays live and
    // this one booking goes to the desk. The grant gone, or the location's
    // own calendar, breaks the connection.
    const locationWide =
      code !== null && (isTokenBreak(code) || p.calendarId === p.target.calendarId);
    // The hold is let go, with its request's alert, before the break is
    // recorded: markCalendarBroken lets go of the location's live holds,
    // and would otherwise take this one with it and tell the clinic to
    // check a calendar Google has just said nothing reached.
    await withTenant({ clinicId, actor }, (tx) =>
      letGoWithin(
        tx,
        holdId,
        fence,
        locationWide ? "calendar_broken" : refusalCode(code ?? "calendar_unavailable"),
        "booking_request",
      ),
    );
    if (locationWide && code) {
      try {
        await markCalendarBroken(clinicId, {
          code,
          connectionId: p.target.connectionId,
          credentialVersion: p.target.credentialVersion,
          actor,
        });
      } catch (error) {
        log.error("calendar break not recorded", { clinicId, error: describeError(error) });
      }
      return { kind: "calendar_broken" };
    }
    return { kind: "refused" };
  }
  const refused = attempt.reason;
  await withTenant({ clinicId, actor }, (tx) =>
    letGoWithin(tx, holdId, fence, refusalCode(refused), "booking_request"),
  );
  return { kind: "refused" };
}

/** The claimed hold, its request and the location's calendar, in one short transaction. */
async function prepareWrite(tx: TenantTx, holdId: string, lease: string): Promise<Prepare> {
  const [hold] = await tx.db
    .select({
      status: slotHolds.status,
      leaseToken: slotHolds.leaseToken,
      startsAt: slotHolds.startsAt,
      minutes: slotHolds.durationMinutes,
      calendarId: slotHolds.calendarId,
      requestId: slotHolds.bookingRequestId,
    })
    .from(slotHolds)
    .where(and(eq(slotHolds.id, holdId), eq(slotHolds.clinicId, tx.clinicId)))
    .limit(1);
  if (!hold || hold.status !== "writing" || hold.leaseToken !== lease || !hold.requestId) {
    return { kind: "lost" };
  }
  const [request] = await tx.db
    .select({ treatment: bookingRequests.treatment })
    .from(bookingRequests)
    .where(eq(bookingRequests.id, hold.requestId))
    .limit(1);
  const target = await writableConnection(tx);
  if (!target) return { kind: "not_permitted" };
  const [clinic] = await tx.db
    .select({ timezone: clinics.timezone, specialty: clinics.specialty })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const [agent] = await tx.db
    .select({ services: agentConfigs.services })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const context = await openContext(tx, target, "calendar_write");
  return {
    kind: "go",
    prepared: {
      context: { ...context, metadata: { ...context.metadata, calendarId: hold.calendarId } },
      target,
      calendarId: hold.calendarId,
      startsAt: hold.startsAt,
      minutes: hold.minutes,
      service: serviceDuration(agent?.services ?? [], request?.treatment).canonicalName,
      timeZone: clinic?.timezone ?? "UTC",
      audience: audienceFor(clinic?.specialty ?? ""),
      key: `hold:${holdId}`,
    },
  };
}

/** HRC-04's target check, then the one insert. */
async function insertOnce(p: Prepared, firstName: string): Promise<Attempt> {
  const checked = await confirmCalendarTarget({
    context: p.context,
    calendarId: p.calendarId,
    account: p.target.terms.account,
    writes: p.target.terms.allowsWrite,
    managed: p.target.managed,
  });
  if (!checked.allowed) {
    if (checked.error && calendarBreakOf(checked.error)) {
      return { kind: "broken", error: checked.error };
    }
    return { kind: "refused", reason: `target_${checked.reason}` };
  }
  const created = await googleCalendarAdapter.createAppointment(p.context, {
    startsAt: p.startsAt,
    durationMinutes: p.minutes,
    attendee: { name: firstName, timeZone: p.timeZone },
    origin: "assistant",
    audience: p.audience,
    service: p.service,
    idempotencyKey: p.key,
  });
  if (created.ok) {
    const end = p.startsAt.getTime() + p.minutes * 60_000;
    const same =
      created.value.startsAt.getTime() === p.startsAt.getTime() &&
      created.value.endsAt.getTime() === end;
    // Our own key at another time cannot be this hold's; never adopted.
    if (created.value.adopted && !same) return { kind: "refused", reason: "event_id_taken" };
    return { kind: "written", externalId: created.value.externalId };
  }
  if (calendarBreakOf(created.error)) return { kind: "broken", error: created.error };
  const reason = created.error.reason ?? created.error.code;
  return UNKNOWN_REASONS.has(reason) ? { kind: "unknown", reason } : { kind: "refused", reason };
}

/** The record step for the engine's own write (plan §7.9). */
async function recordWrite(
  clinicId: string,
  holdId: string,
  externalId: string,
  fence: HoldFence,
  now: Date,
  actor: ActorContext,
): Promise<HeldWrite> {
  let recorded: RecordedLateWrite;
  try {
    recorded = await withTenant({ clinicId, actor }, (tx) =>
      recordAssistantWrite(tx, holdId, externalId, now, fence),
    );
  } catch (error) {
    if (pgCodeOf(error) !== "23P01") throw error;
    await withTenant({ clinicId, actor }, (tx) => conflictWithin(tx, holdId, fence));
    return { kind: "conflict" };
  }
  if (recorded.kind === "recorded") {
    return {
      kind: "booked",
      appointmentId: recorded.appointmentId,
      startsAt: recorded.startsAt,
      minutes: recorded.minutes,
      deposit: recorded.deposit.isRequired
        ? { action: recorded.deposit.action, amountUsd: recorded.deposit.amountUsd }
        : null,
    };
  }
  // recordAssistantWrite let the hold go and raised calendar_check itself.
  if (recorded.kind === "request_decided") return { kind: "conflict" };
  // Someone else settled the hold meanwhile (the watch, after the lease ran
  // out): what it says now is the answer, the deposit it recorded included.
  return withTenant({ clinicId, actor }, async (tx) => {
    const [hold] = await tx.db
      .select({
        status: slotHolds.status,
        appointmentId: slotHolds.appointmentId,
        startsAt: slotHolds.startsAt,
        minutes: slotHolds.durationMinutes,
      })
      .from(slotHolds)
      .where(and(eq(slotHolds.id, holdId), eq(slotHolds.clinicId, tx.clinicId)))
      .limit(1);
    if (hold?.status !== "converted") return { kind: "lost" };
    return {
      kind: "booked",
      appointmentId: hold.appointmentId,
      startsAt: hold.startsAt,
      minutes: hold.minutes,
      deposit: hold.appointmentId ? await bookedDepositLine(tx, hold.appointmentId) : null,
    };
  });
}

/**
 * §7.9's conflict: the record rolled back because the span was retaken
 * after the hold stopped blocking. The hold is let go and the clinic told to
 * look for a duplicate (calendar_check), in one transaction, whatever the
 * caller was told: the event in Google is a new fact.
 */
async function conflictWithin(tx: TenantTx, holdId: string, fence: HoldFence): Promise<boolean> {
  return letGoWithin(tx, holdId, fence, "record_conflict", "calendar_check", {
    evenIfAnswered: true,
  });
}

/**
 * Let go of the assistant's hold, fenced, and raise `alert` for its request
 * in the same transaction. The hold's row is locked first, so its marker is
 * read as the engine left it. Unless `evenIfAnswered`, nothing is raised for
 * a caller already answered with a request (the engine raised L7 then).
 * False when the hold was no longer this fence's: whoever settled it raised
 * the alert for it.
 */
async function letGoWithin(
  tx: TenantTx,
  holdId: string,
  fence: HoldFence,
  reason: string,
  alert: BookingAlertKind | null,
  options: { evenIfAnswered?: boolean } = {},
): Promise<boolean> {
  const [hold] = await tx.db
    .select({ outcomeReason: slotHolds.outcomeReason, requestId: slotHolds.bookingRequestId })
    .from(slotHolds)
    .where(and(holdFenced(holdId, fence), eq(slotHolds.clinicId, tx.clinicId)))
    .for("update")
    .limit(1);
  if (!hold) return false;
  if (!(await releaseAssistantHold(tx, holdId, reason, fence))) return false;
  const answered = hold.outcomeReason === ANSWERED_AS_REQUEST;
  if (alert && hold.requestId && (options.evenIfAnswered || !answered)) {
    await notifyBookingAlert(tx, alert, { bookingRequestId: hold.requestId });
  }
  return true;
}

function holdFenced(holdId: string, fence: HoldFence) {
  return fence === "unknown"
    ? and(eq(slotHolds.id, holdId), eq(slotHolds.status, "unknown"))
    : and(
        eq(slotHolds.id, holdId),
        eq(slotHolds.status, "writing"),
        eq(slotHolds.leaseToken, fence.lease),
      );
}

/** outcome_reason is a short code: lower case, digits and underscores. */
function refusalCode(reason: string): string {
  const code = `write_${reason}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 40);
  return code === "write_" ? "write_refused" : code;
}

function pgCodeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// The hold sweep (plan §7.11, §9.2 step 5; called by the five-minute watch)
// -----------------------------------------------------------------------------

/** How many `unknown` holds one run reads back at most. */
export const HOLD_SWEEP_LIMIT = 20;
/** A read-back Google could not answer, or a record the database refused, is tried again after these waits, then given up. */
export const READ_BACK_BACKOFF_MINUTES = [2, 5, 15, 60] as const;
/** With nowhere to read back from, how long the watch waits before it looks again, until the booking's time. */
const NO_TARGET_RECHECK_MINUTES = 15;

export type HoldSweepResult = {
  /** `writing` holds whose writer's lease ran out, now `unknown`. */
  lapsed: number;
  /** `unknown` holds read back from Google. */
  checked: number;
  /** Found in Google and recorded as the assistant's booking. */
  confirmed: number;
  /** Let go: not written, deleted, given up on, or their time retaken. */
  released: number;
  /** Held and reserved holds past their window, marked expired. */
  expired: number;
  /** Locations or holds the sweep could not read or settle; logged, never fatal. */
  errors: number;
};

type Resolution = "confirmed" | "released" | "waiting" | "settled";

/**
 * The assistant's writes nobody saw finish, at every location (plan §7.11):
 *
 *   - a `writing` hold past its lease (its writer died or hung) becomes
 *     `unknown`, to be read back once its two-minute grace has passed, and
 *     the clinic is told to check its request (calendar_check), unless the
 *     caller was already answered with a request;
 *   - a due `unknown` hold is read back from Google under its own key:
 *     found, it is recorded as the assistant's booking; not there after the
 *     grace, or deleted by the clinic, it is let go and the request stays
 *     the desk's; a broken connection is marked; anything else, a record the
 *     database refused included, is tried again after 2, 5, 15 and 60
 *     minutes, then given up with calendar_check; with nowhere to read back
 *     from (the connection or its terms gone without letting the location's
 *     holds go), it waits until the booking's time, so a reconnect can still
 *     find it, then is given up the same way;
 *   - held and reserved holds past their window are marked expired, and
 *     finished holds older than a day are deleted (spentHolds).
 *
 * The alert for an `unknown` hold went when it became unknown; letting one
 * go raises nothing more, except the giving up. At most 20 read-backs a
 * run, oldest due first. Never throws.
 */
export async function sweepHolds(
  options: { now?: Date; limit?: number; actor?: ActorContext } = {},
): Promise<HoldSweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? HOLD_SWEEP_LIMIT;
  const actor = options.actor ?? WATCH_ACTOR;
  const result: HoldSweepResult = {
    lapsed: 0,
    checked: 0,
    confirmed: 0,
    released: 0,
    expired: 0,
    errors: 0,
  };

  let clinicIds: string[];
  try {
    clinicIds = (await listClinics()).filter((c) => !c.destroyedAt).map((c) => c.id);
  } catch (error) {
    log.error("hold sweep could not list its locations", { error: describeError(error) });
    return { ...result, errors: 1 };
  }

  for (const clinicId of clinicIds) {
    let due: string[];
    try {
      due = await withTenant({ clinicId, actor }, async (tx) => {
        const lapsed = await tx.db
          .update(slotHolds)
          .set({
            status: "unknown",
            nextCheckAt: sql`greatest(clock_timestamp(),
              coalesce(${slotHolds.insertAttemptedAt}, clock_timestamp())
                + make_interval(mins => ${WRITE_GRACE_MINUTES}))`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(slotHolds.clinicId, tx.clinicId),
              eq(slotHolds.status, "writing"),
              sql`${slotHolds.leaseUntil} < clock_timestamp()`,
            ),
          )
          .returning({
            id: slotHolds.id,
            outcomeReason: slotHolds.outcomeReason,
            requestId: slotHolds.bookingRequestId,
          });
        result.lapsed += lapsed.length;
        await alertLapsed(tx, lapsed);
        const expired = await tx.db
          .update(slotHolds)
          .set({ status: "expired", releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(slotHolds.clinicId, tx.clinicId),
              sql`((${slotHolds.status} = 'held' and ${slotHolds.expiresAt} <= clock_timestamp())
                   or (${slotHolds.status} = 'reserved' and ${slotHolds.blocksUntil} <= clock_timestamp()))`,
            ),
          )
          .returning({ id: slotHolds.id });
        result.expired += expired.length;
        await tx.db.delete(slotHolds).where(spentHolds(tx.clinicId));
        if (result.checked >= limit) return [];
        const rows = await tx.db
          .select({ id: slotHolds.id })
          .from(slotHolds)
          .where(
            and(
              eq(slotHolds.clinicId, tx.clinicId),
              eq(slotHolds.status, "unknown"),
              sql`coalesce(${slotHolds.nextCheckAt}, clock_timestamp()) <= clock_timestamp()`,
            ),
          )
          .orderBy(slotHolds.nextCheckAt)
          .limit(limit - result.checked);
        return rows.map((r) => r.id);
      });
    } catch (error) {
      result.errors += 1;
      log.error("hold sweep failed for a location", { clinicId, error: describeError(error) });
      continue;
    }
    for (const holdId of due) {
      result.checked += 1;
      try {
        const resolved = await resolveUnknownHold(clinicId, holdId, now, actor);
        if (resolved === "confirmed") result.confirmed += 1;
        else if (resolved === "released") result.released += 1;
      } catch (error) {
        result.errors += 1;
        log.error("hold sweep could not settle a write", {
          clinicId,
          error: describeError(error),
        });
      }
    }
  }
  return result;
}

/**
 * A lapsed write's request, told to the clinic (calendar_check) in the
 * transaction that made the hold `unknown`: its writer died or hung, and
 * nobody has said anything about it. Not for a caller already answered with
 * a request, nor a request no longer waiting.
 */
async function alertLapsed(
  tx: TenantTx,
  lapsed: { outcomeReason: string | null; requestId: string | null }[],
): Promise<void> {
  const untold = lapsed.flatMap((h) =>
    h.requestId && h.outcomeReason !== ANSWERED_AS_REQUEST ? [h.requestId] : [],
  );
  if (untold.length === 0) return;
  const waiting = await tx.db
    .select({ id: bookingRequests.id })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        inArray(bookingRequests.id, untold),
        eq(bookingRequests.status, "requested"),
      ),
    );
  for (const request of waiting) {
    await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: request.id });
  }
}

/** Read one `unknown` hold back from Google and settle it (plan §7.11). */
async function resolveUnknownHold(
  clinicId: string,
  holdId: string,
  now: Date,
  actor: ActorContext,
): Promise<Resolution> {
  const fence: HoldFence = "unknown";
  const read = await withTenant({ clinicId, actor }, async (tx) => {
    const [hold] = await tx.db
      .select({
        startsAt: slotHolds.startsAt,
        calendarId: slotHolds.calendarId,
        insertAttemptedAt: slotHolds.insertAttemptedAt,
        checkAttempts: slotHolds.checkAttempts,
      })
      .from(slotHolds)
      .where(
        and(
          eq(slotHolds.id, holdId),
          eq(slotHolds.clinicId, tx.clinicId),
          eq(slotHolds.status, "unknown"),
        ),
      )
      .limit(1);
    if (!hold) return null;
    const target = await writableConnection(tx);
    if (!target) return { hold, target: null, context: null };
    const context = await openContext(tx, target, "calendar_read_back");
    return {
      hold,
      target,
      context: { ...context, metadata: { ...context.metadata, calendarId: hold.calendarId } },
    };
  });
  if (!read) return "settled";
  const { hold } = read;
  const letGo = async (reason: string, alert: BookingAlertKind | null): Promise<Resolution> => {
    const released = await withTenant({ clinicId, actor }, (tx) =>
      letGoWithin(tx, holdId, fence, reason, alert, { evenIfAnswered: true }),
    );
    return released ? "released" : "settled";
  };
  const giveUp = () => letGo("unresolved", "calendar_check");

  if (!read.target || !read.context) {
    // Nowhere to read back from, while nothing let the hold go: the
    // connection's state or its terms changed under it (an unset Google
    // client, an outdated notice). A write that landed is still found if
    // the calendar comes back before the booking's time.
    if (hold.startsAt.getTime() <= now.getTime()) return giveUp();
    await withTenant({ clinicId, actor }, (tx) =>
      tx.db
        .update(slotHolds)
        .set({
          nextCheckAt: sql`least(${hold.startsAt}::timestamptz,
            clock_timestamp() + make_interval(mins => ${NO_TARGET_RECHECK_MINUTES}))`,
          updatedAt: sql`now()`,
        })
        .where(holdFenced(holdId, fence)),
    );
    return "waiting";
  }

  const found = await googleCalendarAdapter.findAppointmentByKey(read.context, {
    idempotencyKey: `hold:${holdId}`,
    around: hold.startsAt,
  });
  if (found.ok && found.value) {
    try {
      return await confirmLate(clinicId, holdId, found.value.externalId, now, actor);
    } catch (error) {
      // The database refused the record for a reason of its own (not the
      // time retaken): counted with Google's misses, so a write that can
      // never be recorded is given up on, and the clinic told, rather than
      // read back and refused every five minutes for ever. Rethrown so the
      // run counts it.
      try {
        await backOff(clinicId, holdId, hold.checkAttempts, actor, giveUp);
      } catch (inner) {
        log.error("hold sweep could not count a failed record", {
          clinicId,
          error: describeError(inner),
        });
      }
      throw error;
    }
  }
  if (found.ok) {
    const graceEnds = (hold.insertAttemptedAt?.getTime() ?? 0) + WRITE_GRACE_MINUTES * 60_000;
    if (graceEnds > now.getTime()) {
      await withTenant({ clinicId, actor }, (tx) =>
        tx.db
          .update(slotHolds)
          .set({ nextCheckAt: new Date(graceEnds), updatedAt: sql`now()` })
          .where(holdFenced(holdId, fence)),
      );
      return "waiting";
    }
    return letGo("not_written", null);
  }
  const reason = found.error.reason ?? found.error.code;
  if (reason === "deleted_in_calendar") return letGo("cancelled_in_calendar", null);
  if (reason === "not_ours") return letGo("not_ours", null);
  const code = calendarBreakOf(found.error);
  if (code) {
    if (isTokenBreak(code) || hold.calendarId === read.target.calendarId) {
      try {
        await markCalendarBroken(clinicId, {
          code,
          connectionId: read.target.connectionId,
          credentialVersion: read.target.credentialVersion,
          actor,
        });
      } catch (error) {
        log.error("calendar break not recorded", { clinicId, error: describeError(error) });
      }
    }
    // markCalendarBroken let the location's holds go; this one too if not.
    await letGo("calendar_broken", null);
    return "released";
  }
  return backOff(clinicId, holdId, hold.checkAttempts, actor, giveUp);
}

/** One more try later, after READ_BACK_BACKOFF_MINUTES; given up once they are spent. */
async function backOff(
  clinicId: string,
  holdId: string,
  attempts: number,
  actor: ActorContext,
  giveUp: () => Promise<Resolution>,
): Promise<Resolution> {
  if (attempts >= READ_BACK_BACKOFF_MINUTES.length) return giveUp();
  const wait = READ_BACK_BACKOFF_MINUTES[attempts]!;
  await withTenant({ clinicId, actor }, (tx) =>
    tx.db
      .update(slotHolds)
      .set({
        checkAttempts: sql`${slotHolds.checkAttempts} + 1`,
        nextCheckAt: sql`clock_timestamp() + make_interval(mins => ${wait})`,
        updatedAt: sql`now()`,
      })
      .where(holdFenced(holdId, "unknown")),
  );
  return "waiting";
}

/**
 * The assistant's write found in Google after the fact (plan §7.11): the
 * record step fenced on `unknown`. A booking found late raises no alert
 * (Annex X6); its request reads as confirmed after the call. A record that
 * meets the time retaken (23P01) lets the hold go with calendar_check.
 */
async function confirmLate(
  clinicId: string,
  holdId: string,
  externalId: string,
  now: Date,
  actor: ActorContext,
): Promise<Resolution> {
  let recorded: RecordedLateWrite;
  try {
    recorded = await withTenant({ clinicId, actor }, (tx) =>
      recordAssistantWrite(tx, holdId, externalId, now, "unknown"),
    );
  } catch (error) {
    if (pgCodeOf(error) !== "23P01") throw error;
    const released = await withTenant({ clinicId, actor }, (tx) =>
      conflictWithin(tx, holdId, "unknown"),
    );
    return released ? "released" : "settled";
  }
  if (recorded.kind === "recorded") return "confirmed";
  return recorded.kind === "request_decided" ? "released" : "settled";
}

/** The appointment's deposit as the desk sees it: for a booking's answer read back later. */
export async function bookedDepositOf(
  tx: TenantTx,
  appointmentId: string,
): Promise<{ depositStatus: string; depositUsd: number | null } | null> {
  const [row] = await tx.db
    .select({ depositStatus: appointments.depositStatus, depositUsd: appointments.depositUsd })
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
    .limit(1);
  if (!row) return null;
  const usd = row.depositUsd === null ? null : Number(row.depositUsd);
  return {
    depositStatus: row.depositStatus,
    depositUsd: usd !== null && Number.isFinite(usd) ? usd : null,
  };
}

/** What a voice line says about a booking already made: a deposit left to the desk, or nothing. */
export async function bookedDepositLine(
  tx: TenantTx,
  appointmentId: string,
): Promise<DepositLineFacts | null> {
  const booked = await bookedDepositOf(tx, appointmentId);
  return booked?.depositStatus === "pending_front_desk"
    ? { action: "book_and_flag", amountUsd: booked.depositUsd }
    : null;
}
