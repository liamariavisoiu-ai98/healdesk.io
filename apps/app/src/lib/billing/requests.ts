import type { Channel } from "@healdesk/catalog";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";

import {
  BILLING_REQUEST_KINDS,
  BILLING_REQUEST_OUTCOMES,
  BILLING_REQUEST_REASONS,
  billingRequests,
  type BillingRequest,
  type BillingRequestChannelKey,
  type BillingRequestKind,
  type BillingRequestOutcome,
  type BillingRequestReason,
} from "@/db/schema";
import { JOB_BILLING_REQUESTS, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";
import type { TenantTx } from "@/lib/tenant";

/**
 * The billing-request ledger: recording what the engine asks Stripe to do,
 * and (Package C) doing it. Build decisions BD1 to BD3 and BD11, R2 to R6.
 *
 * Recording happens inside the transaction of the event that asked: the
 * transaction that records a channel's first answer records the plan start
 * or step-up with it, so either both commit or neither does, and no crash
 * between "the clinic answered" and "ask Stripe" can lose a plan start. The
 * request lands on the BILLING clinic through the definer
 * `app_record_billing_request` (drizzle/0048), which resolves it from the
 * caller's own tenant, so a location's transaction can record one and no
 * second transaction is opened. One request per (clinic, kind, channel): a
 * second call is a no-op that returns `recorded: false`.
 *
 * Carrying a request out is the worker's: it claims due rows (found through
 * `app_due_billing_requests`) with a lease, calls Stripe outside any
 * transaction and records the outcome in a new one. S0 writes the recorders
 * and the re-arm for real; `drainBillingRequests` and `runBillingRequestsJob`
 * are stubs until Package C-actions replaces their bodies.
 */

export {
  BILLING_REQUEST_KINDS,
  BILLING_REQUEST_OUTCOMES,
  BILLING_REQUEST_REASONS,
  type BillingRequest,
  type BillingRequestChannelKey,
  type BillingRequestKind,
  type BillingRequestOutcome,
  type BillingRequestReason,
};

export type RecordedRequest = { recorded: boolean };

/**
 * Record through the definer. `clinicId` must be the clinic the transaction
 * is open on: the definer reads the tenant, not an argument, so a mismatch
 * would record for a different clinic than the caller named, and is refused
 * before anything is written.
 */
async function recordBillingRequest(
  tx: TenantTx,
  clinicId: string,
  kind: BillingRequestKind,
  channelKey: BillingRequestChannelKey,
  reason: BillingRequestReason,
): Promise<RecordedRequest> {
  if (clinicId !== tx.clinicId) {
    throw new Error(
      `A billing request is recorded inside the clinic's own transaction: asked for ${clinicId}, open on ${tx.clinicId}.`,
    );
  }
  const result = await tx.db.execute<{ recorded: boolean }>(
    sql`select app_record_billing_request(${kind}, ${channelKey}, ${reason}) as recorded`,
  );
  return { recorded: result.rows[0]?.recorded === true };
}

/**
 * Start the plan (BD2): swap the $0 placeholder for the package that matches
 * the channels in service, charged that day. Recorded at the clinic's first
 * answer, by the hourly reconcile when one is missing, or by an operator.
 */
export async function startPlan(
  tx: TenantTx,
  clinicId: string,
  reason: "first_answer" | "reconcile" | "ops" = "first_answer",
): Promise<RecordedRequest> {
  return recordBillingRequest(tx, clinicId, "plan_start", "-", reason);
}

/**
 * Add a channel's price to the billed package (BD3): from its first answer,
 * 30 days after it was ready and waiting on the clinic (BD4), from the
 * reconcile, or by an operator. The worker defers it until the plan has
 * started, so it is never dropped.
 */
export async function stepUpPackage(
  tx: TenantTx,
  clinicId: string,
  channel: Channel,
  reason: "first_answer" | "waiting" | "reconcile" | "ops",
): Promise<RecordedRequest> {
  return recordBillingRequest(tx, clinicId, "step_up", channel, reason);
}

/**
 * Close an account whose 30-day setup window ended with nothing live (BD11,
 * R12): cancelled at once, no proration, no final invoice, the setup fee
 * kept. The worker carries it out only while the `setup-closure` switch is
 * on, and re-checks immediately before that no location has gone live.
 */
export async function closeUnfinishedSetup(
  tx: TenantTx,
  clinicId: string,
  reason: "deadline" | "ops" = "deadline",
): Promise<RecordedRequest> {
  return recordBillingRequest(tx, clinicId, "close_setup", "-", reason);
}

/**
 * Cancel the subscription at once (R15): recorded in the transaction that
 * stamps a first-period refund, so the refund and the cancellation cannot
 * come apart. Its worker checks Stripe's state first, because
 * `subscriptions.cancel` is a DELETE that ignores idempotency keys.
 */
export async function requestCancelNow(
  tx: TenantTx,
  clinicId: string,
  reason: "ops" = "ops",
): Promise<RecordedRequest> {
  return recordBillingRequest(tx, clinicId, "cancel_now", "-", reason);
}

/**
 * Make a request due again (R2, R6): clear its outcome and lease, set its
 * attempts to 0, its next attempt to `now` and its reason to why it was
 * re-armed. For the hourly reconcile and the console's retry, in the BILLING
 * clinic's tenant, where every request lives.
 *
 * A pending request whose lease is still running is left alone and false is
 * returned: re-arming it would let a second worker claim the row while the
 * first is still waiting on Stripe. A finished request can always be
 * re-armed. `last_error` is kept as the record of what went wrong before.
 */
export async function rearmBillingRequest(
  tx: TenantTx,
  requestId: string,
  reason: BillingRequestReason,
  now: Date = new Date(),
): Promise<boolean> {
  const rearmed = await tx.db
    .update(billingRequests)
    .set({
      doneAt: null,
      outcome: null,
      outcomeReason: null,
      leaseUntil: null,
      attempts: 0,
      nextAttemptAt: now,
      reason,
    })
    .where(
      and(
        eq(billingRequests.id, requestId),
        eq(billingRequests.clinicId, tx.clinicId),
        or(
          isNotNull(billingRequests.doneAt),
          isNull(billingRequests.leaseUntil),
          lt(billingRequests.leaseUntil, now),
        ),
      ),
    )
    .returning({ id: billingRequests.id });
  return rearmed.length > 0;
}

export type DrainOptions = { now?: Date; max?: number; stripe?: Stripe };
export type DrainResult = { processed: number; deferred: number; failed: number };

/**
 * Carry out the due requests (BD1 to BD3, BD11, R3 to R5): at most one per
 * billing clinic per batch, `close_setup` only while `setup-closure` is on.
 * Never inside a transaction.
 *
 * STUB until Package C-actions: does nothing and reports nothing done.
 */
export async function drainBillingRequests(options: DrainOptions = {}): Promise<DrainResult> {
  void options;
  return { processed: 0, deferred: 0, failed: 0 };
}

/**
 * The `billing-requests` job: every minute from the `billing-minute` queue and
 * hourly from the tick (R17). Behind its switch, but without runJob's
 * 60-minute lock, because each request is leased on its own row and a crash
 * must not stop the minute worker for an hour.
 *
 * STUB until Package C-actions: records "Not built yet." when switched on, and
 * "disabled" otherwise, like every other job behind its switch.
 */
export async function runBillingRequestsJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(JOB_BILLING_REQUESTS, async () => "Not built yet.", now);
}
