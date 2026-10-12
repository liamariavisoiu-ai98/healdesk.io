import { createHash } from "node:crypto";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { bookingRequests, slotHolds, type SlotHoldChannel, type SlotHoldStatus } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * Slot holds: the time the assistant is holding on a location's calendar
 * (plan §7). The overlap guard, the states and the write-once fields are the
 * database's (drizzle/0057, app_slot_hold_guard and app_slot_hold_transition);
 * claiming and converting a hold are the booking engine's (lib/booking/book.ts
 * and writer.ts). Here: the location's calendar lock, placing a 60-second
 * hold on one calendar, and the one step every change of calendar needs,
 * letting go of what the location holds.
 */

/** How long a `held` hold lasts: the minute the assistant has to take the details (Q7). */
export const HOLD_SECONDS = 60;

/**
 * The outcome code a `writing` hold carries once the caller has been
 * answered with a request while its write was still in flight (the engine's
 * budget ran out, lib/booking/book.ts): the clinic has had the request's
 * alert, so nothing that settles the hold afterwards raises another for it,
 * and a booking that lands is labelled as confirmed after the call. Set under
 * the hold's row lock, which every settling transaction takes first.
 */
export const ANSWERED_AS_REQUEST = "answered_as_request";

/**
 * Take the location's calendar lock for the rest of the transaction (plan
 * §7.2): the advisory lock app_slot_hold_guard, app_slot_hold_transition and
 * app_appointment_time_guard take, keyed on the clinic. Re-entrant, so a
 * transaction that takes it first and then writes a hold or a booking, whose
 * trigger takes it again, waits once. Everything that reads what occupies
 * time and then occupies some takes it first, so the read and the write see
 * the same state.
 */
export async function lockClinicCalendar(tx: TenantTx): Promise<void> {
  await tx.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || ${tx.clinicId}::text, 0))`,
  );
}

/** sha256 hex of a holder key ("voice:" + the call id, …): what slot_holds keeps. Never the key. */
export function holderRefOf(holderKey: string): string {
  return createHash("sha256").update(holderKey, "utf8").digest("hex");
}

export type HoldInput = {
  channel: SlotHoldChannel;
  holderKey: string;
  /** The calendar the time is on: the location's own, or a named provider's (availability). */
  calendarId: string;
  startsAt: Date;
  minutes: number;
  contactId?: string | null;
  /** sha256 of the call or session, for the audit row; never a raw vendor id. */
  callRef?: string;
};

export type HoldPlaced =
  | { kind: "held"; holdId: string; expiresAt: Date; startsAt: Date; minutes: number }
  /** Another holder's live hold, or a healdesk booking, already has that time on that calendar. */
  | { kind: "slot_taken" };

/**
 * Hold `minutes` from `startsAt` on one calendar for 60 seconds (plan §7.5
 * step 5), in the caller's transaction: take the calendar lock; let go of
 * this holder's own `held` holds (a holder holds one time at once;
 * `superseded`); mark the location's lapsed `held` holds expired; delete
 * spent holds older than a day (spentHolds); insert. The database refuses
 * the insert (23P01) when another holder's live hold or a healdesk booking
 * overlaps it on the same calendar (app_slot_hold_guard, drizzle/0060),
 * which rolls the whole transaction back: the caller answers `slot_taken`
 * (placeHold does).
 *
 * The audit row carries the hold's id, the call reference and the length:
 * never a time, which assertNoPhi would read as a number.
 */
export async function holdSpanWithin(tx: TenantTx, input: HoldInput): Promise<HoldPlaced> {
  if (!Number.isInteger(input.minutes) || input.minutes < 5 || input.minutes > 480) {
    throw new Error("A hold lasts 5 to 480 minutes.");
  }
  const holderRef = holderRefOf(input.holderKey);
  await lockClinicCalendar(tx);
  await tx.db
    .update(slotHolds)
    .set({
      status: sql`case when ${slotHolds.expiresAt} <= clock_timestamp() then 'expired' else 'released' end`,
      outcomeReason: "superseded",
      releasedAt: sql`clock_timestamp()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, holderRef),
        eq(slotHolds.status, "held"),
      ),
    );
  await tx.db
    .update(slotHolds)
    .set({ status: "expired", releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.status, "held"),
        sql`${slotHolds.expiresAt} <= clock_timestamp()`,
      ),
    );
  await tx.db.delete(slotHolds).where(spentHolds(tx.clinicId));
  const [hold] = await tx.db
    .insert(slotHolds)
    .values({
      clinicId: tx.clinicId,
      channel: input.channel,
      holderRef,
      calendarId: input.calendarId,
      startsAt: input.startsAt,
      durationMinutes: input.minutes,
      endsAt: new Date(input.startsAt.getTime() + input.minutes * 60_000),
      contactId: input.contactId ?? null,
    })
    .returning({ id: slotHolds.id, expiresAt: slotHolds.expiresAt });
  if (!hold) throw new Error("Slot hold: no row returned.");
  tx.audit.record({
    action: "create",
    resourceType: "slot_hold",
    resourceId: hold.id,
    metadata: { holdId: hold.id, callRef: input.callRef, minutes: input.minutes },
  });
  return {
    kind: "held",
    holdId: hold.id,
    expiresAt: hold.expiresAt,
    startsAt: input.startsAt,
    minutes: input.minutes,
  };
}

const HOLD_ACTOR: ActorContext = { type: "service", serviceName: "slot-hold" };

/** holdSpanWithin in its own transaction, a lost race answered as `slot_taken`. */
export async function holdSpan(
  clinicId: string,
  input: HoldInput,
  options: { actor?: ActorContext } = {},
): Promise<HoldPlaced> {
  try {
    return await withTenant({ clinicId, actor: options.actor ?? HOLD_ACTOR }, (tx) =>
      holdSpanWithin(tx, input),
    );
  } catch (error) {
    if (pgCodeOf(error) === "23P01") return { kind: "slot_taken" };
    throw error;
  }
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

/** Every state that has not reached its end. */
const UNFINISHED: SlotHoldStatus[] = ["held", "reserved", "writing", "unknown"];
/** Every state that has. */
const FINISHED: SlotHoldStatus[] = ["converted", "released", "expired"];

/**
 * The location's finished holds older than a day, which the hold paths
 * delete as they go (here and the watch's hold sweep), except one whose
 * request staff can still decide. The desk writes a confirmation under that
 * hold's key ("hold:" + its id) so an assistant event that did reach Google
 * meets it there (a 409, read back and adopted) instead of a second event
 * under the request's own key; so the hold lasts as long as the request can
 * still be confirmed.
 * The retention purge (lib/retention/purge.ts) takes the rest after a week,
 * by which time the request's link has lapsed.
 */
export function spentHolds(clinicId: string) {
  return and(
    eq(slotHolds.clinicId, clinicId),
    inArray(slotHolds.status, FINISHED),
    lt(slotHolds.createdAt, sql`clock_timestamp() - interval '1 day'`),
    sql`not exists (
      select 1 from booking_requests r
       where r.id = ${slotHolds.bookingRequestId}
         and r.status in ('requested', 'accepted', 'rescheduling')
         and r.expires_at > now())`,
  );
}

/**
 * Whether the holder has a write unsettled: a hold `writing`, or `unknown`
 * until the watch reads it back, whatever its blocking window says. While it
 * has, the holder holds and books nothing else (plan §7.7 step 4): the record
 * step for that write inserts its booking through the time guard, which
 * counts every holder's live hold, this one's included, so a new hold of
 * its own over the same time would turn a booking already in Google into a
 * record conflict.
 */
export async function writeInFlight(tx: TenantTx, holderRef: string): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: slotHolds.id })
    .from(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, holderRef),
        inArray(slotHolds.status, ["writing", "unknown"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** outcome_reason's CHECK: a short code, never free text. */
const REASON = /^[a-z0-9_]{1,40}$/;

/**
 * Release every hold of the tenant's location that has not finished, with
 * one reason (plan §4.12): when its Google connection is erased or broken, or
 * an election takes its terms away. A `held` hold whose minute has already
 * run out is marked `expired`, as the engine marks a superseded one; every
 * other is `released`, a write in flight included. The writer that started
 * it finds its lease gone and records nothing (plan §7.9), and nothing stays
 * blocked behind a calendar healdesk can no longer read.
 *
 * Releasing only ever frees time, so it takes no calendar lock: the guard's
 * lock serialises what occupies time, not what lets it go. Returns how many
 * holds it released.
 *
 * A write in flight that is let go here may already be in Google, with no
 * booking recorded and nobody to record it, so the clinic is told to check
 * (`calendar_check`, L34), in this transaction, for each such hold whose
 * request is still waiting. Every other hold that carries a request has had
 * its alert already: an `unknown` one when it became unknown, a deposit
 * reservation when it was made (D's L10), a write answered as a request when
 * that answer was given (ANSWERED_AS_REQUEST). A `held` hold carries none.
 */
export async function releaseLiveHolds(tx: TenantTx, reason: string): Promise<number> {
  if (!REASON.test(reason)) {
    throw new Error("A hold's outcome reason is a short code: lower case, digits and underscores.");
  }
  const live = await tx.db
    .select({
      id: slotHolds.id,
      status: slotHolds.status,
      outcomeReason: slotHolds.outcomeReason,
      requestId: slotHolds.bookingRequestId,
    })
    .from(slotHolds)
    .where(and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.status, UNFINISHED)))
    .for("update");
  if (live.length === 0) return 0;
  const released = await tx.db
    .update(slotHolds)
    .set({
      status: sql`case when ${slotHolds.status} = 'held' and ${slotHolds.expiresAt} <= clock_timestamp()
                       then 'expired' else 'released' end`,
      outcomeReason: reason,
      releasedAt: sql`clock_timestamp()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        inArray(
          slotHolds.id,
          live.map((h) => h.id),
        ),
        inArray(slotHolds.status, UNFINISHED),
      ),
    )
    .returning({ id: slotHolds.id });
  const untold = live.flatMap((h) =>
    h.status === "writing" && h.requestId && h.outcomeReason !== ANSWERED_AS_REQUEST
      ? [h.requestId]
      : [],
  );
  if (untold.length > 0) {
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
  return released.length;
}
