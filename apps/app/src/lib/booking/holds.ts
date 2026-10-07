import { and, eq, inArray, sql } from "drizzle-orm";

import { slotHolds, type SlotHoldStatus } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Slot holds: the time the assistant is holding on a location's calendar
 * (plan §7). The overlap guard, the states and the write-once fields are the
 * database's (drizzle/0056, app_slot_hold_guard and app_slot_hold_transition);
 * placing, claiming and converting a hold arrive with the booking engine
 * (C12, C13). What is here already is the one step every change of calendar
 * needs: letting go of what the location holds.
 */

/** Every state that has not reached its end. */
const UNFINISHED: SlotHoldStatus[] = ["held", "reserved", "writing", "unknown"];

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
 */
export async function releaseLiveHolds(tx: TenantTx, reason: string): Promise<number> {
  if (!REASON.test(reason)) {
    throw new Error("A hold's outcome reason is a short code: lower case, digits and underscores.");
  }
  const released = await tx.db
    .update(slotHolds)
    .set({
      status: sql`case when ${slotHolds.status} = 'held' and ${slotHolds.expiresAt} <= clock_timestamp()
                       then 'expired' else 'released' end`,
      outcomeReason: reason,
      releasedAt: sql`clock_timestamp()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.status, UNFINISHED)))
    .returning({ id: slotHolds.id });
  return released.length;
}
