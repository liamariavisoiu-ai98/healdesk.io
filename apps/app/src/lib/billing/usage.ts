import { getPlan, OVERAGE_RATES_PROVISIONAL } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import {
  entitlements,
  usageEvents,
  type Entitlements,
  type UsageMeter,
  type UsageSource,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { resolveBillingClinicId } from "./billing-clinic";
import { effectiveIncluded, getEntitlementsForUpdate, rollAllowancePeriod } from "./entitlements";
import { deliverCriticalAfterCommit, enqueueNotice } from "./notices";
import { recordBillingNote } from "./state-machine";

/**
 * Counting what a clinic uses: one row in `usage_events` per call (its
 * minutes, rounded up per call) or chat conversation, against the BILLING
 * clinic's pooled allowance, and the entitlements counter beside it (build
 * decisions BD5, BD6, R18 to R20; maps2/usage-gate.md §10).
 *
 * A row cannot change after it is written, apart from the three columns the
 * Stripe reporter fills in, so every billing fact on it (the window, the
 * allowance, the usage before it, the units past the allowance) has to be
 * right at the moment of insert. That is why the recorder locks the billing
 * clinic's entitlements row before it reads the counter: every recorder for
 * one billing group queues on that one row, so `used_before` is exact and two
 * calls ending together are counted one after the other, never both against
 * the same remaining allowance. The unique index on (clinic, meter, source,
 * reference) is what decides whether the event already happened, so a
 * redelivered webhook or a conversation's tenth message inserts nothing and
 * moves no counter.
 *
 * Callers run it outside any transaction (it opens the location's and then
 * the billing clinic's, one after the other, never nested: the pool holds ten
 * connections and a nested wait on the entitlements row is a deadlock
 * Postgres cannot see). They never record test calls, forwarding-test calls,
 * the clinic's own numbers, the preview or practice questions (BD6, the
 * contracts' `first_answer` exclusions).
 */

/** Which meter each source counts: a call counts minutes; every chat counts conversations. */
export const USAGE_SOURCE_METER: Readonly<Record<UsageSource, UsageMeter>> = {
  voice_call: "voice_minutes",
  meta: "chat_conversations",
  web_chat: "chat_conversations",
};

/** An identifierRef() (lib/identifier-ref.ts): the only shape a usage reference may take. */
const IDENTIFIER_REF = /^v1:[0-9a-f]{64}$/;

export type UsageCrossing = 80 | 100;

export type RecordUsageInput = {
  /** The clinic that answered: a location or a billing clinic. */
  locationClinicId: string;
  meter: UsageMeter;
  /** Whole units: billable minutes for a call (billableVoiceMinutes), 1 for a conversation. */
  quantity: number;
  source: UsageSource;
  /**
   * `identifierRef("call", clinicId, callId)` or
   * `identifierRef("chat_conversation", clinicId, conversationId)`: never the
   * vendor's id itself, which is refused.
   */
  sourceRef: string;
  /** When the call started or the message was sent: which allowance window it falls in. */
  occurredAt: Date;
  actor: ActorContext;
  /**
   * The clock an annual window is rolled to before counting; `occurredAt`
   * when left out, so a call ingested after it ended still lands in the
   * window it was made in.
   */
  now?: Date;
};

export type RecordUsageResult =
  | {
      recorded: true;
      billingClinicId: string;
      usageEventId: string;
      /** The window it counted against; null when none was open at `occurredAt` (BD6, R20). */
      windowStart: Date | null;
      /** The pooled allowance it was measured against (effectiveIncluded). */
      included: number;
      usedBefore: number;
      usedAfter: number;
      /** Units of this event past the allowance: what overage bills. */
      overAllowance: number;
      /** The 80% and 100% marks this event crossed. */
      crossed: UsageCrossing[];
    }
  | { recorded: false; reason: "no_entitlements" | "duplicate" | "zero_quantity" };

type WindowRow = Pick<Entitlements, "currentPeriodStart" | "currentPeriodEnd">;

/**
 * The allowance window `at` falls in, or null: before the first one opens
 * (BD6), and once the open window has ended and the renewal has not moved it
 * yet (R20). A monthly window moves only on the renewal's invoice.paid, which
 * can come an hour or days after the period ends; usage in that gap is
 * counted against no window, never against the old allowance, so a clinic
 * already over it is not billed overage the new allowance covers, and the
 * hard cap does not keep refusing into the new period.
 */
export function openWindowAt(row: WindowRow, at: Date): { start: Date; end: Date } | null {
  const start = row.currentPeriodStart;
  const end = row.currentPeriodEnd;
  if (!start || !end) return null;
  if (at.getTime() < start.getTime() || at.getTime() >= end.getTime()) return null;
  return { start, end };
}

/**
 * The counter for a meter. Voice minutes are a numeric column, which Drizzle
 * reads as a string; every increment is whole minutes, so it rounds exactly.
 */
export function usedOf(
  row: Pick<Entitlements, "usedVoiceMinutes" | "usedChatConversations">,
  meter: UsageMeter,
): number {
  return meter === "voice_minutes"
    ? Math.round(Number(row.usedVoiceMinutes))
    : row.usedChatConversations;
}

/**
 * The overage rate for a meter in cents, at the BOUGHT package's rate (the
 * metered prices stay the bought package's, BD3); a legacy row has only its
 * billed package. 0 when the package does not sell the meter.
 */
export function overageRateCentsFor(
  row: Pick<Entitlements, "boughtPlanId" | "planCode">,
  meter: UsageMeter,
): number {
  const plan = getPlan(row.boughtPlanId ?? row.planCode);
  if (!plan) return 0;
  const usd =
    meter === "voice_minutes" ? plan.overagePerVoiceMinuteUsd : plan.overagePerChatConversationUsd;
  return Math.round(usd * 100);
}

/** The `${meter}:${windowStartIso}` key the allowance notices share (R22). */
export function allowanceDedupeKey(meter: UsageMeter, windowStart: Date): string {
  return `${meter}:${windowStart.toISOString()}`;
}

/** The ISO date a window ends on, as the allowance notices carry it. */
export function windowEndsOn(end: Date): string {
  return end.toISOString().slice(0, 10);
}

/**
 * "Stop and fall back" engaged (L19): queue `allowance_fallback` on the
 * billing clinic, once per meter per window, whatever the usage-alerts switch
 * says (BD21). `tx` must be the billing clinic's tenant. Returns whether this
 * call queued it; the caller sends critical notices after its commit.
 */
export async function enqueueAllowanceFallback(
  tx: TenantTx,
  input: { meter: UsageMeter; included: number; window: { start: Date; end: Date } },
): Promise<boolean> {
  return enqueueNotice(
    tx,
    "allowance_fallback",
    allowanceDedupeKey(input.meter, input.window.start),
    { meter: input.meter, included: input.included, windowEndsOn: windowEndsOn(input.window.end) },
  );
}

/** Units of one event past the allowance: the overage it adds, never what was over already. */
function overDelta(before: number, quantity: number, included: number): number {
  return Math.max(0, before + quantity - included) - Math.max(0, before - included);
}

function crossings(before: number, after: number, included: number): UsageCrossing[] {
  if (included <= 0) return [];
  return ([80, 100] as const).filter(
    (mark) => before * 100 < mark * included && after * 100 >= mark * included,
  );
}

type Counted = Extract<RecordUsageResult, { recorded: true }> & { fallbackQueued: boolean };

/**
 * Count one call or chat conversation against its billing clinic's pooled
 * allowance (maps2/usage-gate.md §10, with BD5, BD6, R19 and R20):
 *
 *   1. resolve the billing clinic, then work in its own transaction;
 *   2. lock its entitlements row (none: `no_entitlements`, the normal answer
 *      for a synthetic or demo clinic, never an error);
 *   3. roll an annual window that is due, noting it in the billing history;
 *   4. `used_before` from the counter, the allowance from effectiveIncluded;
 *   5. units past the allowance: none outside a window (BD6, R20), none
 *      under the hard cap (R19: "Stop and fall back" never produces an
 *      invoice; the usage still counts), none on a meter the clinic was never
 *      sold, and otherwise only the part of this event beyond it;
 *   6. insert the row ON CONFLICT DO NOTHING, and move the counter only when
 *      the row went in and a window is open;
 *   7. return the 80% and 100% crossings, and queue `allowance_fallback` the
 *      moment the hard cap's 100% is reached.
 *
 * While OVERAGE_RATES_PROVISIONAL is true the units past the allowance are
 * still recorded; the billing jobs are the ones that skip them, so the ledger
 * stays true if the flag is cleared later.
 */
export async function recordUsage(input: RecordUsageInput): Promise<RecordUsageResult> {
  const { meter, source, quantity, occurredAt } = input;
  if (USAGE_SOURCE_METER[source] !== meter) {
    throw new RangeError(
      `recordUsage: ${source} counts ${USAGE_SOURCE_METER[source]}, not ${meter}.`,
    );
  }
  if (!IDENTIFIER_REF.test(input.sourceRef)) {
    // The reference is stored and reported; a vendor id (a WhatsApp number,
    // a call id) must never be. Callers pass identifierRef(...).
    throw new RangeError("recordUsage: the source reference is not an identifierRef().");
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError("recordUsage: the quantity is a whole number of units.");
  }
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    throw new RangeError("recordUsage: occurredAt is not a date.");
  }
  // A call too short to bill (billableVoiceMinutes of 0) is not an event;
  // the table refuses a quantity of 0 anyway.
  if (quantity === 0) return { recorded: false, reason: "zero_quantity" };
  const rollTo = input.now ?? occurredAt;

  const billingClinicId = await withTenant(
    { clinicId: input.locationClinicId, actor: input.actor },
    (tx) => resolveBillingClinicId(tx),
  );

  const outcome = await withTenant(
    { clinicId: billingClinicId, actor: input.actor },
    async (tx): Promise<Counted | Exclude<RecordUsageResult, { recorded: true }>> => {
      // Already counted? Answered without the lock, so a conversation's
      // every later message does not queue behind the group's recorders.
      const [seen] = await tx.db
        .select({ id: usageEvents.id })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.clinicId, billingClinicId),
            eq(usageEvents.meter, meter),
            eq(usageEvents.source, source),
            eq(usageEvents.sourceRef, input.sourceRef),
          ),
        )
        .limit(1);
      if (seen) return { recorded: false, reason: "duplicate" };

      let row = await getEntitlementsForUpdate(tx.db, billingClinicId);
      if (!row) return { recorded: false, reason: "no_entitlements" };

      const roll = await rollAllowancePeriod(tx.db, billingClinicId, rollTo);
      if (roll.rolled > 0) {
        // In the history, beside every other reason a counter moved, as the
        // billing sweep records its own rolls.
        await recordBillingNote(tx, { actor: "system", reason: "allowance_rolled" });
        row = (await getEntitlementsForUpdate(tx.db, billingClinicId)) ?? row;
      }

      const window = openWindowAt(row, occurredAt);
      const included = effectiveIncluded(row, meter);
      const usedBefore = usedOf(row, meter);
      // A meter with no allowance is one the clinic was never sold (BD5 gives
      // every bought channel its package's allowance): usage on it, a call
      // the pre-Retell agent answered anyway, is counted but never billed.
      const billsOverage = window !== null && row.overageMode === "allow" && included > 0;
      const overAllowance = billsOverage ? overDelta(usedBefore, quantity, included) : 0;

      const [inserted] = await tx.db
        .insert(usageEvents)
        .values({
          clinicId: billingClinicId,
          locationClinicId: input.locationClinicId,
          meter,
          source,
          sourceRef: input.sourceRef,
          quantity,
          occurredAt,
          windowStart: window?.start ?? null,
          included,
          usedBefore,
          overAllowance,
        })
        .onConflictDoNothing({
          target: [
            usageEvents.clinicId,
            usageEvents.meter,
            usageEvents.source,
            usageEvents.sourceRef,
          ],
        })
        .returning({ id: usageEvents.id });
      // Lost the race to an identical event, which committed while this one
      // waited on the lock: it was counted there.
      if (!inserted) return { recorded: false, reason: "duplicate" };

      const counted = {
        recorded: true as const,
        billingClinicId,
        usageEventId: inserted.id,
        windowStart: window?.start ?? null,
        included,
        usedBefore,
        overAllowance,
      };
      // Outside a window the counter stays put: the first window opens at
      // zero (openAllowanceWindow), and a renewal's reset must not inherit
      // usage from the gap before it.
      if (!window) return { ...counted, usedAfter: usedBefore, crossed: [], fallbackQueued: false };

      // The counter moves in the statement that reads it back, under the row
      // lock taken above. `updated_at` is left alone: it records changes to
      // what the clinic is entitled to, and usage is not one.
      const [after] = await tx.db
        .update(entitlements)
        .set(
          meter === "voice_minutes"
            ? { usedVoiceMinutes: sql`${entitlements.usedVoiceMinutes} + ${quantity}` }
            : { usedChatConversations: sql`${entitlements.usedChatConversations} + ${quantity}` },
        )
        .where(eq(entitlements.clinicId, billingClinicId))
        .returning({
          usedVoiceMinutes: entitlements.usedVoiceMinutes,
          usedChatConversations: entitlements.usedChatConversations,
        });
      const usedAfter = after ? usedOf(after, meter) : usedBefore + quantity;
      const crossed = crossings(usedBefore, usedAfter, included);
      const fallbackQueued =
        crossed.includes(100) && row.overageMode === "hard_cap"
          ? await enqueueAllowanceFallback(tx, { meter, included, window })
          : false;
      return { ...counted, usedAfter, crossed, fallbackQueued };
    },
  );

  if (!outcome.recorded) return outcome;
  const { fallbackQueued, ...result } = outcome;
  // After the commit, never inside it: a notice sent before commit is a
  // notice about something that may yet roll back. It never rejects.
  if (fallbackQueued) await deliverCriticalAfterCommit(billingClinicId);
  return result;
}

/** One meter of the pooled allowance, as the Billing screen and the console show it. */
export type UsageMeterSnapshot = {
  meter: UsageMeter;
  /** Counted in the current window. */
  used: number;
  /** effectiveIncluded (BD5): the allowance for the window, times the locations. */
  included: number;
  remaining: number;
  /** Units past the allowance so far this window. */
  overUnits: number;
  /**
   * What those units bill at the bought package's rate: 0 under "Stop and
   * fall back" (R19) and while OVERAGE_RATES_PROVISIONAL says overage is not
   * billed.
   */
  overageCents: number;
  /** Whole percent of the allowance used; null when the meter has no allowance. */
  percent: number | null;
  /** ISO timestamps of the window; null before the plan starts (BD6). */
  windowStart: string | null;
  windowEnd: string | null;
  /** `now` falls inside the window (not before it opens, not after it ended, R20). */
  isWindowOpen: boolean;
};

/**
 * Both meters of a billing clinic's entitlements row, pure: voice minutes,
 * then chat conversations. Every allowance comes from effectiveIncluded, the
 * one function recordUsage, the gate and the usage alerts use (BD5), so a
 * channel bought but not yet billed never shows a zero allowance and phantom
 * overage.
 */
export function usageSnapshot(
  row: Pick<
    Entitlements,
    | "usedVoiceMinutes"
    | "usedChatConversations"
    | "includedVoiceMinutes"
    | "includedChatConversations"
    | "boughtPlanId"
    | "planCode"
    | "locations"
    | "overageMode"
    | "currentPeriodStart"
    | "currentPeriodEnd"
  >,
  now: Date = new Date(),
): UsageMeterSnapshot[] {
  const isWindowOpen = openWindowAt(row, now) !== null;
  return (["voice_minutes", "chat_conversations"] as const).map((meter) => {
    const used = usedOf(row, meter);
    const included = effectiveIncluded(row, meter);
    const overUnits = included > 0 ? Math.max(0, used - included) : 0;
    const billed = row.overageMode === "allow" && !OVERAGE_RATES_PROVISIONAL;
    return {
      meter,
      used,
      included,
      remaining: Math.max(0, included - used),
      overUnits,
      overageCents: billed ? overUnits * overageRateCentsFor(row, meter) : 0,
      percent: included > 0 ? Math.floor((used * 100) / included) : null,
      windowStart: row.currentPeriodStart?.toISOString() ?? null,
      windowEnd: row.currentPeriodEnd?.toISOString() ?? null,
      isWindowOpen,
    };
  });
}
