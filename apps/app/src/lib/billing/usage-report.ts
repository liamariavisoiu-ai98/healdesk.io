import { METERS, OVERAGE_RATES_PROVISIONAL, type MeterId } from "@healdesk/catalog";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { pool, unsafeDb } from "@/db";
import { usageEvents, type UsageMeter } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { JOB_USAGE_METER_REPORT, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { getEntitlements, hasPlanStarted } from "./entitlements";
import {
  expectedMeteredKeys,
  isRateLimitError,
  reconcileMeteredItems,
  stripeErrorCode,
} from "./metered-items";
import { getStripe } from "./stripe-client";
import { workerRequestOptions } from "./stripe-helpers";

/**
 * Overage on monthly plans, reported to Stripe's meters (BD19, R17).
 *
 * Every usage row past the pooled allowance (`over_allowance > 0`) becomes
 * one meter event on the clinic's Stripe customer; Stripe prices it through
 * the metered item the subscription carries at the BOUGHT package's rate, on
 * the next invoice. Promptness is the point: usage reported after an invoice
 * finalizes is never billed (Stripe's one-hour grace period), so the job runs
 * every minute from the `billing-minute` queue and hourly from the tick.
 *
 * The rules, and the failure each prevents:
 *
 *   - ONE reporter at a time: a session advisory lock on a dedicated
 *     connection (`pg_try_advisory_lock`). The minute queue and the hourly
 *     tick overlap at the top of every hour, and two reporters would send the
 *     same row twice, which Stripe's identifier dedupe only catches for a
 *     rolling day.
 *   - Sequential per customer and meter: Stripe allows one concurrent meter
 *     call per customer per meter, so rows go one at a time, oldest first.
 *   - A row is marked reported only AFTER Stripe accepts it. A failure counts
 *     an attempt and stores a closed code; repeated failures tell ops
 *     (`meter_report_failing`).
 *   - A 429 is "slow down", not a failure: the run stops where it is, records
 *     nothing against the row, and the next run carries on.
 *   - The metered items are reconciled first whenever the stored snapshot
 *     differs from what the bought package expects, and a clinic is reported
 *     only once they match: an event for a meter the subscription has no
 *     price for is accepted and bills nothing, and marking it reported would
 *     lose it.
 *   - Rows older than 34 days are left alone: Stripe refuses timestamps past
 *     35 days.
 *
 * The job reads its own switch on every run, without runJob's 60-minute
 * lock (R17): a crash must not stop a once-a-minute job for an hour.
 */

const REPORT_ACTOR: ActorContext = { type: "service", serviceName: "usage-meter-report" };

/** Stripe accepts meter timestamps up to 35 days old; a day's margin. */
const LOOKBACK_MS = 34 * 24 * 60 * 60 * 1000;
/** Rows sent per clinic per run, so one large backlog cannot starve the others. */
const ROWS_PER_CLINIC = 500;
/** A row that has failed this many times tells ops. */
const FAILING_AFTER_ATTEMPTS = 3;
/**
 * A row that has failed this many times is retried hourly, not every minute:
 * a permanent refusal (a deleted customer) must not cost a Stripe call a
 * minute for ever.
 */
const EAGER_ATTEMPTS = 10;
/** The reporter's advisory lock, a 64-bit key from a fixed name. */
const LOCK_NAME = "healdesk:usage-meter-report";

const METER_IDS: Record<UsageMeter, MeterId> = {
  voice_minutes: "voiceMinutes",
  chat_conversations: "chatConversations",
};

export type UsageReportSummary = {
  /** False when another reporter held the lock: this run did nothing. */
  ran: boolean;
  clinics: number;
  reported: number;
  failed: number;
  /** Clinics left for a later run: metered items that could not be reconciled. */
  deferred: number;
  /** Stripe answered 429: the run stopped early, the rest wait for the next. */
  rateLimited: boolean;
};

/** Billing clinics, by id only, through the SECURITY DEFINER overview (the runtime role cannot list clinics). */
async function billingClinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string; billing_clinic_id: string | null }>(
    sql`select id, billing_clinic_id from app_clinics_overview()`,
  );
  return result.rows.filter((row) => row.billing_clinic_id === null).map((row) => row.id);
}

/** Run `fn` holding the reporter's advisory lock, or return null when another reporter has it. */
async function withReporterLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [LOCK_NAME],
    );
    if (rows[0]?.locked !== true) return null;
    try {
      return await fn();
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]);
      } catch {
        // A connection that could not unlock must never go back to the pool
        // still holding the lock: destroy it, which releases the lock.
        broken = true;
      }
    }
  } finally {
    client.release(broken);
  }
}

function meterHasPrice(meter: UsageMeter, expected: readonly string[]): boolean {
  const prefix = `${METERS[METER_IDS[meter]].lookupKeyPrefix}_`;
  return expected.some((key) => key.startsWith(prefix));
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

/**
 * One pass over every monthly, started billing clinic. Exported without the
 * job wrapper so a test can drive it at a pinned `now`; the scheduled entry
 * point is `runUsageMeterReportJob`.
 */
export async function reportUsageToMeters(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<UsageReportSummary> {
  const now = options.now ?? new Date();
  const summary: UsageReportSummary = {
    ran: false,
    clinics: 0,
    reported: 0,
    failed: 0,
    deferred: 0,
    rateLimited: false,
  };
  if (OVERAGE_RATES_PROVISIONAL) return { ...summary, ran: true };

  await withReporterLock(async () => {
    summary.ran = true;
    let stripe = options.stripe ?? null;
    const cutoff = new Date(now.getTime() - LOOKBACK_MS);
    const hourly = now.getUTCMinutes() === 0;

    for (const clinicId of await billingClinicIds()) {
      if (summary.rateLimited) break;
      const row = await withTenant({ clinicId, actor: REPORT_ACTOR }, (tx) =>
        getEntitlements(tx.db, clinicId),
      );
      if (
        !row ||
        row.billingInterval !== "month" ||
        !row.stripeCustomerId ||
        !hasPlanStarted(row) ||
        row.status === "canceled" ||
        row.status === "purged"
      ) {
        continue;
      }
      // A plan change in flight (review fix): after a lost answer to an annual
      // to monthly change, the subscription webhook already says "month" while
      // the change's last step, which claims the annual months and keeps their
      // rows from this reporter, has not run. Reporting now would send an
      // annual month's overage to a meter, where it is never billed. The
      // change finishes or is dropped within the hour (resumePlanChange), and
      // its rows are reported on the next run.
      if (row.pendingPlanChangeRequestId !== null) {
        summary.deferred += 1;
        continue;
      }
      const expected = expectedMeteredKeys(row.boughtPlanId ?? row.planCode, "month");
      if (!expected || expected.length === 0) continue;

      const pending = await withTenant({ clinicId, actor: REPORT_ACTOR }, (tx) =>
        tx.db
          .select({
            id: usageEvents.id,
            meter: usageEvents.meter,
            overAllowance: usageEvents.overAllowance,
            occurredAt: usageEvents.occurredAt,
            attempts: usageEvents.stripeReportAttempts,
          })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.clinicId, clinicId),
              gt(usageEvents.overAllowance, 0),
              isNull(usageEvents.stripeReportedAt),
              gt(usageEvents.occurredAt, cutoff),
            ),
          )
          .orderBy(asc(usageEvents.occurredAt))
          .limit(ROWS_PER_CLINIC),
      );
      const due = pending.filter(
        (event) =>
          meterHasPrice(event.meter, expected) && (event.attempts < EAGER_ATTEMPTS || hourly),
      );
      if (due.length === 0) continue;
      summary.clinics += 1;
      stripe ??= getStripe();

      // Only our own metered keys are compared: a metered item another product
      // on the shared account added is never ours to reconcile.
      const ours = row.meteredPriceKeys.filter((key) => key.startsWith("healdesk_meter_"));
      if (!sameKeys(ours, expected)) {
        const reconciled = await reconcileMeteredItems(clinicId, { stripe });
        if (reconciled.status !== "ok" && reconciled.status !== "fixed") {
          summary.deferred += 1;
          log.warn("usage report deferred: metered items not reconciled", {
            clinicId,
            outcome: reconciled.status,
            reason: reconciled.reason ?? null,
          });
          continue;
        }
      }

      let failing = 0;
      for (const event of due) {
        try {
          await stripe.billing.meterEvents.create(
            {
              event_name: METERS[METER_IDS[event.meter]].eventName,
              payload: {
                stripe_customer_id: row.stripeCustomerId,
                value: String(event.overAllowance),
              },
              identifier: `hd_${event.id}`,
              // Never ahead of now: Stripe refuses a timestamp more than five
              // minutes in the future.
              timestamp: Math.floor(Math.min(event.occurredAt.getTime(), now.getTime()) / 1000),
            },
            workerRequestOptions(`hd-meter:${event.id}`),
          );
        } catch (error) {
          if (isRateLimitError(error)) {
            summary.rateLimited = true;
            break;
          }
          const code = stripeErrorCode(error);
          summary.failed += 1;
          if (event.attempts + 1 >= FAILING_AFTER_ATTEMPTS) failing += 1;
          await withTenant({ clinicId, actor: REPORT_ACTOR }, (tx) =>
            tx.db
              .update(usageEvents)
              .set({
                stripeReportAttempts: sql`${usageEvents.stripeReportAttempts} + 1`,
                stripeReportError: code,
              })
              .where(and(eq(usageEvents.id, event.id), isNull(usageEvents.stripeReportedAt))),
          );
          continue;
        }
        await withTenant({ clinicId, actor: REPORT_ACTOR }, (tx) =>
          tx.db
            .update(usageEvents)
            .set({
              stripeReportedAt: now,
              stripeReportAttempts: sql`${usageEvents.stripeReportAttempts} + 1`,
              stripeReportError: null,
            })
            .where(and(eq(usageEvents.id, event.id), isNull(usageEvents.stripeReportedAt))),
        );
        summary.reported += 1;
      }
      if (failing > 0) {
        await notifyOps("meter_report_failing", { clinicId, count: failing });
      }
    }
    return true;
  });
  return summary;
}

/**
 * The `usage-meter-report` job (R17): every minute from the `billing-minute`
 * queue and hourly from the tick. Reads its own switch and records the run,
 * without runJob's lock; the advisory lock inside keeps it to one reporter.
 */
export async function runUsageMeterReportJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_USAGE_METER_REPORT,
    async () => {
      if (OVERAGE_RATES_PROVISIONAL) return "Overage rates are provisional: nothing is reported.";
      const result = await reportUsageToMeters({ now, stripe: options.stripe });
      if (!result.ran) return "Another reporter is running; this run did nothing.";
      return (
        `Reported ${result.reported} overage events for ${result.clinics} clinics; ` +
        `${result.failed} failed, ${result.deferred} clinics deferred` +
        (result.rateLimited
          ? "; Stripe asked us to slow down, the rest wait for the next run."
          : ".")
      );
    },
    now,
  );
}
