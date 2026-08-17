import { and, count, eq, gte, isNotNull, lt } from "drizzle-orm";

import { appointments, clinics, conversations } from "@/db/schema";
import {
  reconcilePeriod,
  type PeriodReconciliation,
} from "@/lib/sync/reconcile-store";

import type { ActorContext } from "../audit";
import { withTenant } from "../tenant";

import {
  computeAttribution,
  trend,
  type ActivityCounts,
  type AttributionResult,
  type VerifiedInput,
} from "./estimate";
import { monthContaining, previousMonth, type Period } from "./period";

/**
 * The monthly report.
 *
 * Everything this returns is an aggregate. That is a deliberate constraint, not
 * an accident of what was easy: this data ends up in an email, and an email is
 * the one channel we cannot secure. Counts and totals carry none of HIPAA's 18
 * identifiers, so they need no login and are safe in a shared front-desk inbox.
 *
 * The per-appointment detail — which patient, which treatment, which day —
 * exists and is computable, but it belongs inside the clinic's own software
 * where staff are already authenticated. It must never be added to this shape.
 *
 * Reading conversations is a PHI access even when only counting them, so every
 * call here writes an audit row.
 */

export type MonthlyReport = {
  clinicId: string;
  clinicName: string;
  period: Period;
  attribution: AttributionResult;
  /** Change against the previous month; null when there's nothing to compare. */
  trend: { deltaUsd: number; percent: number | null } | null;
  /** Whether the period is still in progress, so figures will move. */
  partial: boolean;
  /**
   * Money the matcher saw but could not place, for verified clinics.
   *
   * Aggregate only — a count and a total, no patient and no treatment — so it
   * is safe in the same email as everything else. It appears because a total
   * that quietly drops what it couldn't explain is worse than one that admits
   * to it.
   */
  unmatched: { count: number; amountUsd: string } | null;
};

/**
 * What counts as "recovered".
 *
 * v1 counts only conversations flagged as an automatic callback of a number
 * that rang out. After-hours calls arguably qualify too — nobody was going to
 * answer at 9pm — but that needs per-clinic business hours we don't collect
 * yet, and inventing them would inflate the number.
 *
 * This deliberately UNDERSTATES. If we're going to be wrong about the figure a
 * clinic judges us on, wrong-low is the survivable direction.
 */
const RECOVERED = eq(conversations.isRecoveredMissedCall, true);

export async function buildMonthlyReport(
  clinicId: string,
  options: {
    /** Any instant inside the month to report on. Defaults to last month. */
    within?: Date;
    /** "Current time", injectable so the scheduler is deterministic in tests. */
    now?: Date;
    actor?: ActorContext;
  } = {},
): Promise<MonthlyReport> {
  const actor: ActorContext = options.actor ?? {
    type: "service",
    serviceName: "monthly-report",
  };

  const now = options.now ?? new Date();

  return withTenant({ clinicId, actor }, async (tx) => {
    // The clinic row is read INSIDE the tenant transaction, not before it.
    // Outside one, the runtime role sees no clinics at all — the policy is
    // `id = app_current_clinic_id()` — so a lookup here would return nothing
    // and this would look like "unknown clinic" rather than "no tenant set".
    const [clinic] = await tx.db
      .select({
        name: clinics.name,
        timezone: clinics.timezone,
        attributionMode: clinics.attributionMode,
        averageTreatmentValueUsd: clinics.averageTreatmentValueUsd,
      })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);

    if (!clinic) throw new Error(`Unknown clinic: ${clinicId}`);

    const period = options.within
      ? monthContaining(options.within, clinic.timezone)
      : previousMonth(now, clinic.timezone);

    // period.START, not period.end. `end` is the first instant of the NEXT
    // month, so previousMonth(end) walks back to the period itself and the
    // trend silently compares July against July — always zero, never obviously
    // broken.
    const prior = previousMonth(period.start, clinic.timezone);

    const [current, previous] = await Promise.all([
      activityFor(tx.db, clinicId, period),
      activityFor(tx.db, clinicId, prior),
    ]);

    // Counting conversations is still reading PHI. Record the access, with
    // counts only — assertNoPhi() would reject anything patient-shaped here.
    tx.audit.record({
      action: "read",
      resourceType: "conversation",
      resultCount: current.conversationsHandled,
      metadata: { period: period.key, purpose: "monthly-report" },
    });

    const averageValue =
      clinic.averageTreatmentValueUsd === null
        ? null
        : Number(clinic.averageTreatmentValueUsd);

    const isVerified = clinic.attributionMode === "verified";

    // Reconcile both periods so the trend compares like with like. The current
    // period persists what it decided — matches and exceptions — while the
    // prior one is computed read-only: re-running last month's matcher would
    // reopen exceptions an operator has already worked.
    const [currentMatch, priorMatch] = isVerified
      ? await Promise.all([
          reconcilePeriod(tx.db, clinicId, period, { now }),
          reconcilePeriod(tx.db, clinicId, prior, { now, persist: false }),
        ])
      : [null, null];

    const attribution = computeAttribution(
      isVerified
        ? verifiedInput(current, currentMatch!)
        : {
            mode: "estimated",
            activity: current,
            averageTreatmentValueUsd: averageValue,
          },
    );

    const priorAttribution = computeAttribution(
      isVerified
        ? verifiedInput(previous, priorMatch!)
        : {
            mode: "estimated",
            activity: previous,
            averageTreatmentValueUsd: averageValue,
          },
    );

    return {
      clinicId,
      clinicName: clinic.name,
      period,
      attribution,
      trend: trend(attribution.revenueUsd, priorAttribution.revenueUsd),
      partial: now < period.end,
      unmatched: currentMatch
        ? {
            count: currentMatch.unmatchedCount,
            amountUsd: currentMatch.unmatchedUsd,
          }
        : null,
    };
  });
}

/**
 * Turn a reconciliation into the shape the attribution calculator wants.
 *
 * The one judgement here is when revenue is unmeasurable rather than zero. No
 * source produced a single sale row for the period, so we have no evidence
 * either way — and a verified clinic reading "$0" would conclude the agent
 * earned them nothing, which is a claim we cannot support.
 */
function verifiedInput(
  activity: ActivityCounts,
  reconciliation: PeriodReconciliation,
): VerifiedInput {
  const measurable = reconciliation.sources.length > 0;

  return {
    mode: "verified",
    activity,
    matchedRevenueUsd: measurable
      ? Number(reconciliation.recoveredMatchedUsd)
      : null,
    unmeasurableReason: measurable
      ? undefined
      : "No connected system reported any sales for this period, so we can't show verified revenue. This usually means the connection needs re-authorising.",
    unmatchedTransactionCount: reconciliation.unmatchedCount,
    unmatchedRevenueUsd: Number(reconciliation.unmatchedUsd),
    sources: reconciliation.sources,
    coverageStartedAt: reconciliation.coverageStartedAt,
  };
}

/**
 * Aggregate activity for one period.
 *
 * Note every predicate is clinic-scoped explicitly even though RLS would
 * enforce it anyway. Belt and braces: the policy is the safety net, not the
 * first line — and an explicit clinic_id also lets the planner use the
 * clinic-leading indexes.
 */
async function activityFor(
  db: Parameters<Parameters<typeof withTenant>[1]>[0]["db"],
  clinicId: string,
  period: Period,
) {
  const inPeriod = and(
    eq(conversations.clinicId, clinicId),
    gte(conversations.startedAt, period.start),
    lt(conversations.startedAt, period.end),
  );

  const [handled] = await db
    .select({ value: count() })
    .from(conversations)
    .where(inPeriod);

  const [recovered] = await db
    .select({ value: count() })
    .from(conversations)
    .where(and(inPeriod, RECOVERED));

  // Join to appointments so a "booking" means a real appointment row, not just
  // an outcome label the agent set on its way out of the call.
  const [recoveredBookings] = await db
    .select({ value: count() })
    .from(appointments)
    .innerJoin(
      conversations,
      eq(appointments.conversationId, conversations.id),
    )
    .where(
      and(
        eq(appointments.clinicId, clinicId),
        inPeriod,
        RECOVERED,
        isNotNull(appointments.id),
      ),
    );

  const [totalBookings] = await db
    .select({ value: count() })
    .from(appointments)
    .innerJoin(
      conversations,
      eq(appointments.conversationId, conversations.id),
    )
    .where(and(eq(appointments.clinicId, clinicId), inPeriod));

  return {
    conversationsHandled: handled?.value ?? 0,
    conversationsRecovered: recovered?.value ?? 0,
    recoveredBookings: recoveredBookings?.value ?? 0,
    totalBookings: totalBookings?.value ?? 0,
  };
}

/**
 * NOT IMPLEMENTED HERE: enumerating which clinics are due a report.
 *
 * A scheduler has to list every tenant before it has chosen one, and the
 * runtime role cannot do that by design — with no tenant set, `clinics` returns
 * nothing. That is the isolation working, not a bug to route around.
 *
 * The options, none of which should be picked casually:
 *
 *   1. Run the scheduler under a dedicated role with SELECT on clinics only.
 *      Narrower than the migrator, and the honest answer.
 *   2. Have the job accept a clinic id per invocation, so enumeration happens
 *      outside the database boundary entirely.
 *
 * Deliberately left undone rather than half-built with `unsafeDb`, which would
 * have silently returned an empty list and produced a scheduler that reported
 * on nobody while appearing to work. Phase 8 decides this.
 */
