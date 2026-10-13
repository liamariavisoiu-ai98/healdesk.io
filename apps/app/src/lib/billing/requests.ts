import {
  channelList,
  getPlan,
  parseLookupKey,
  planForChannels,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  recurringUsd,
  stripeLookupKey,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
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
  type Entitlements,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  applyBilledPlan,
  claimStripeMutationLease,
  getEntitlements,
  getEntitlementsForUpdate,
  hasPlanStarted,
  markPlanStartApplied,
  releaseStripeMutationLease,
  setMeteredPriceKeys,
} from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { enqueueNotice } from "@/lib/billing/notices";
import { PriceNotFoundError, pricesForLookupKeys } from "@/lib/billing/prices";
import { recordBillingNote } from "@/lib/billing/state-machine";
import { getStripe, StripeNotConfiguredError } from "@/lib/billing/stripe-client";
import { stripeRefId, workerRequestOptions } from "@/lib/billing/stripe-helpers";
import { channelsInService, readChannelStates, type ChannelState } from "@/lib/channels/state";
import { THIRD_PARTY_LINK_ORIGINS } from "@/lib/email/lint";
import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import {
  getJob,
  JOB_BILLING_REQUESTS,
  JOB_SETUP_CLOSURE,
  runSwitchedJob,
  type JobOutcome,
} from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The billing-request ledger: recording what the engine asks Stripe to do,
 * and doing it. Build decisions BD1 to BD3 and BD11, R2 to R8, R15 and R16.
 *
 * Recording happens inside the transaction of the event that asked: the
 * transaction that records a channel's first answer records the plan start
 * or step-up with it, so either both commit or neither does, and no crash
 * between "the clinic answered" and "ask Stripe" can lose a plan start. The
 * request lands on the BILLING clinic through the definer
 * `app_record_billing_request` (drizzle/0050), which resolves it from the
 * caller's own tenant, so a location's transaction can record one and no
 * second transaction is opened. One request per (clinic, kind, channel): a
 * second call is a no-op that returns `recorded: false`.
 *
 * Carrying a request out is the drainer's (`drainBillingRequests`), every
 * minute from the `billing-minute` queue and hourly from the tick:
 *
 *   - it finds due rows through `app_due_billing_requests`, which walks the
 *     billing clinics' tenants, and takes at most one row per billing clinic
 *     per batch, `close_setup` only while the `setup-closure` switch is on;
 *   - it CLAIMS a row by a conditional UPDATE in the billing clinic's tenant
 *     that leases it for five minutes and counts the attempt, so two drainers
 *     (the minute queue and the hourly backstop) never both own one row;
 *   - every attempt re-reads Stripe before acting, because Stripe forgets an
 *     idempotency key after a day and caches an error under it, and because
 *     a crash after Stripe applied a change but before we recorded it must
 *     resolve to "already done", not to a second charge;
 *   - each worker holds the billing clinic's Stripe mutation lease (R5) across
 *     its Stripe calls, so a plan start, a step-up, a cancellation and the
 *     portal's actions never read the subscription, decide, and overwrite one
 *     another; a worker that finds it busy waits a minute without spending an
 *     attempt;
 *   - both leases are renewed before EACH Stripe call, and every write after
 *     the claim is fenced on the attempt it claimed (`epoch = e and attempts
 *     = n and done_at is null`), so a worker that stalled past its lease and
 *     was overtaken writes nothing, even after a re-arm restarted the count;
 *   - Stripe is never called inside a transaction: claim, commit, call, then
 *     record the outcome in a new transaction;
 *   - a failed attempt waits 1, 5, 30, 120, 360, 720, then 1440 minutes, and
 *     the tenth failure dead-letters the row and tells ops.
 *
 * The hourly reconcile (lib/billing/reconcile.ts) is the other half: it
 * records what is due but missing and re-arms what can now go through.
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
 * Cancel the subscription at once because the practice's agreement ended
 * (BAA 1.3.0 clauses 1, 17 and 20: every ending ends the Services, and stops
 * the Fees, that day): `requestCancelNow`, recorded by a termination
 * (lib/agreements/termination.ts) in the BILLING clinic's own transaction.
 * Its worker cancels with no proration, so Stripe credits nothing on top of
 * any refund the operator then confirms (commitRefund's
 * `agreement_terminated`). One row per kind: a cancellation that already
 * finished without cancelling (dead-lettered, or skipped) is re-armed, and a
 * pending or done one is left as it is.
 */
export async function requestCancelForAgreementEnd(
  tx: TenantTx,
  clinicId: string,
): Promise<RecordedRequest> {
  const recorded = await requestCancelNow(tx, clinicId);
  if (recorded.recorded) return recorded;
  const [existing] = await tx.db
    .select({ id: billingRequests.id, outcome: billingRequests.outcome })
    .from(billingRequests)
    .where(
      and(
        eq(billingRequests.clinicId, tx.clinicId),
        eq(billingRequests.kind, "cancel_now"),
        eq(billingRequests.channelKey, "-"),
      ),
    )
    .limit(1);
  if (existing && existing.outcome !== null && existing.outcome !== "done") {
    return { recorded: await rearmBillingRequest(tx, existing.id, "ops") };
  }
  return { recorded: false };
}

/**
 * Whether the billing clinic's organisation has a terminated agreement and
 * none left in effect, read in the billing clinic's tenant (baa_acceptances
 * is FORCE RLS, drizzle/0031): only to label the cancellation in Stripe.
 */
async function agreementEnded(tx: TenantTx): Promise<boolean> {
  const result = await tx.db.execute<{ ended: boolean }>(
    sql`select (not exists (select 1 from app_agreement_in_effect(c.organization_id))
                and exists (select 1 from baa_acceptances b
                             where b.organization_id = c.organization_id
                               and b.terminated_at is not null)) as ended
          from clinics c
         where c.id = ${tx.clinicId}`,
  );
  return result.rows[0]?.ended === true;
}

/**
 * Make a request due again (R2, R6): clear its outcome and lease, set its
 * attempts to 0, its next attempt to `now` and its reason to why it was
 * re-armed. For the hourly reconcile and the console's retry, in the BILLING
 * clinic's tenant, where every request lives.
 *
 * The epoch goes up by one (review fix). Attempts restart at 1 for the
 * backoff and the dead-letter count, so without it the next attempt would
 * send `…:<id>:1` again, an idempotency key Stripe may still hold a cached
 * 5xx under for 24 hours: each replayed failure would back off in turn, and a
 * console Retry pressed after an incident would first reach Stripe half an
 * hour later. Every key, lease owner and fenced write carries the epoch, so a
 * re-armed request reaches Stripe afresh and a worker left over from before
 * the re-arm can write nothing.
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
      epoch: sql`${billingRequests.epoch} + 1`,
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

// -----------------------------------------------------------------------------
// The billing group's channels
// -----------------------------------------------------------------------------

/** One channel's state at one clinic of a billing group. */
export type GroupChannelState = ChannelState & { clinicId: string };

export type BillingGroupChannels = {
  /** The billing clinic and every location billed on it, billing clinic first. */
  clinicIds: string[];
  states: GroupChannelState[];
  /** The channels the price is made of: in service at any clinic of the group. */
  inService: Set<Channel>;
  /** Whether any clinic of the group has a channel with `live_at` set. */
  anyLive: boolean;
};

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The billing clinic and its locations, through the 0043 definer (ids only). */
export async function billingGroupClinicIds(billingClinicId: string): Promise<string[]> {
  const result = await unsafeDb.execute(
    sql`select id from app_location_clinics(${billingClinicId}::uuid) as id`,
  );
  return rowsOf<{ id: string }>(result).map((row) => String(row.id));
}

/**
 * Every channel state across a billing group: the package Stripe bills is
 * made of the channels in service at ANY of its clinics (BD2, BD13). Each
 * clinic is read in its own tenant transaction, one after another and never
 * nested, because a second pooled connection opened while one is held is how
 * a ten-connection pool deadlocks without Postgres ever noticing.
 */
export async function readBillingGroupChannels(
  billingClinicId: string,
  now: Date,
  actor: ActorContext,
): Promise<BillingGroupChannels> {
  const clinicIds = await billingGroupClinicIds(billingClinicId);
  const states: GroupChannelState[] = [];
  for (const clinicId of clinicIds) {
    const read = await withTenant({ clinicId, actor }, (tx) =>
      readChannelStates(tx.db, clinicId, now),
    );
    for (const state of read) states.push({ ...state, clinicId });
  }
  return {
    clinicIds,
    states,
    inService: new Set(channelsInService(states)),
    anyLive: states.some((state) => state.liveAt !== null),
  };
}

// -----------------------------------------------------------------------------
// Reading a subscription
// -----------------------------------------------------------------------------

export type PackageItem = {
  id: string;
  plan: Plan;
  interval: BillingInterval;
  priceId: string;
  quantity: number | null;
};

export type SubscriptionShape = {
  /** The $0 item a subscription carries until the plan starts, or null. */
  placeholderItemId: string | null;
  /** The licensed item priced at a catalog package, or null before the start. */
  packageItem: PackageItem | null;
  /** The metered items' lookup keys, sorted. */
  meteredKeys: string[];
};

/**
 * What a subscription carries, read from its items (whose prices always
 * arrive as full objects, lookup key included). The placeholder is the item
 * priced at PLAN_START_PLACEHOLDER_LOOKUP_KEY, else a licensed item at $0
 * (BD2 step 4), for a placeholder price created before its key existed.
 */
export function subscriptionShape(sub: Stripe.Subscription): SubscriptionShape {
  let placeholderItemId: string | null = null;
  let packageItem: PackageItem | null = null;
  const meteredKeys: string[] = [];
  const zeroPriced: string[] = [];
  for (const item of sub.items?.data ?? []) {
    const price = item.price;
    const key = price?.lookup_key ?? null;
    if (price?.recurring?.usage_type === "metered") {
      if (key) meteredKeys.push(key);
      continue;
    }
    if (key === PLAN_START_PLACEHOLDER_LOOKUP_KEY) {
      placeholderItemId ??= item.id;
      continue;
    }
    const parsed = key ? parseLookupKey(key) : null;
    const plan = parsed && parsed.kind !== "setup" ? getPlan(parsed.planId) : undefined;
    if (parsed && plan) {
      packageItem ??= {
        id: item.id,
        plan,
        interval: parsed.kind === "year" ? "year" : "month",
        priceId: price.id,
        quantity: item.quantity ?? null,
      };
      continue;
    }
    if (price?.unit_amount === 0) zeroPriced.push(item.id);
  }
  return {
    placeholderItemId: placeholderItemId ?? zeroPriced[0] ?? null,
    packageItem,
    meteredKeys: [...new Set(meteredKeys)].sort(),
  };
}

function hasEnded(sub: Stripe.Subscription): boolean {
  return sub.status === "canceled" || sub.status === "incomplete_expired";
}

/** A Stripe-hosted invoice page the payload allowlist accepts, or null. */
function hostedInvoiceUrlOf(invoice: unknown): string | null {
  if (!invoice || typeof invoice !== "object") return null;
  const url = (invoice as { hosted_invoice_url?: unknown }).hosted_invoice_url;
  if (typeof url !== "string") return null;
  return THIRD_PARTY_LINK_ORIGINS.some((origin) => url.startsWith(`${origin}/`)) ? url : null;
}

// -----------------------------------------------------------------------------
// The drainer
// -----------------------------------------------------------------------------

const ACTOR = { type: "service", serviceName: "billing-requests" } as const;

/** How long a claim holds a request (R4), renewed before each Stripe call. */
export const BILLING_REQUEST_LEASE_MS = 5 * 60_000;
/** Minutes to wait after the 1st, 2nd, … failed attempt; the last repeats (R4). */
export const BILLING_REQUEST_RETRY_MINUTES = [1, 5, 30, 120, 360, 720, 1440] as const;
/** The tenth failed attempt dead-letters the request (R4). */
export const MAX_BILLING_REQUEST_ATTEMPTS = 10;
/** A step-up waits this long for the plan to start, without spending an attempt (BD3). */
export const STEP_UP_WAIT_MS = 5 * 60_000;
/** A worker waits this long for another holder's Stripe mutation lease (R5). */
export const MUTATION_LEASE_WAIT_MS = 60_000;

const DEFAULT_DRAIN_MAX = 25;
/** The definer's own cap. */
const DUE_ROWS_CAP = 500;

/**
 * Within one billing clinic, the order its due requests go in. A cancellation
 * after a first-period refund goes before anything that would price the
 * subscription up; a plan start before the step-ups that wait for it.
 */
const KIND_PRIORITY: Record<BillingRequestKind, number> = {
  cancel_now: 0,
  close_setup: 1,
  plan_start: 2,
  step_up: 3,
};

/** Statuses in which a plan start would charge for a service that is ending or withheld (BD2). */
const CANCEL_PENDING_STATUSES: ReadonlySet<string> = new Set([
  "canceling",
  "canceled",
  "suspended",
  "purged",
]);

/** The wait after attempt `attempt` failed (1-based); the last step repeats. */
export function retryDelayMs(attempt: number): number {
  const steps = BILLING_REQUEST_RETRY_MINUTES;
  const index = Math.min(Math.max(1, Math.floor(attempt)), steps.length) - 1;
  return steps[index]! * 60_000;
}

export type DrainOptions = { now?: Date; max?: number; stripe?: Stripe };
export type DrainResult = { processed: number; deferred: number; failed: number };

type DueRow = {
  clinicId: string;
  id: string;
  kind: BillingRequestKind;
  nextAttemptAt: Date;
};

/** A text[] of request kinds, checked against the list before it reaches SQL. */
function kindsArray(kinds: readonly BillingRequestKind[]) {
  for (const kind of kinds) {
    if (!(BILLING_REQUEST_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`Not a billing request kind: ${kind}`);
    }
  }
  return sql`array[${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )}]::text[]`;
}

/** Due rows of these kinds across every billing clinic, earliest first (R3). */
async function dueRequests(
  at: Date,
  limit: number,
  kinds: readonly BillingRequestKind[],
): Promise<DueRow[]> {
  if (kinds.length === 0) return [];
  const result = await unsafeDb.execute(
    sql`select clinic_id, id, kind, next_attempt_at
          from app_due_billing_requests(${at}::timestamptz, ${limit}::integer, ${kindsArray(kinds)})`,
  );
  return rowsOf<{ clinic_id: string; id: string; kind: string; next_attempt_at: Date | string }>(
    result,
  ).map((row) => ({
    clinicId: String(row.clinic_id),
    id: String(row.id),
    kind: row.kind as BillingRequestKind,
    nextAttemptAt: new Date(row.next_attempt_at),
  }));
}

/**
 * At most one request per billing clinic per batch (R3), in due order: a
 * clinic's requests all need its Stripe mutation lease, so a second one in
 * the same batch could only wait for the first.
 */
function onePerClinic(rows: readonly DueRow[], max: number): DueRow[] {
  const byClinic = new Map<string, DueRow[]>();
  for (const row of rows) {
    const list = byClinic.get(row.clinicId) ?? [];
    list.push(row);
    byClinic.set(row.clinicId, list);
  }
  const picked: DueRow[] = [];
  for (const list of byClinic.values()) {
    list.sort(
      (a, b) =>
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
        a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime(),
    );
    picked.push(list[0]!);
    if (picked.length >= max) break;
  }
  return picked;
}

async function setupClosureSwitchedOn(): Promise<boolean> {
  return (await getJob(JOB_SETUP_CLOSURE))?.enabled === true;
}

/**
 * Whether the billing-requests job, the only thing that carries a recorded
 * request out on Stripe, is switched on. It ships off (drizzle/0050), and
 * while it is off a recorded `cancel_now` waits and the subscription keeps
 * billing; its stuck and dead-letter alerts come from the same job, so they
 * are silent too. A caller that records a cancellation the customer is owed
 * at once (a termination, a first-period refund) asks this and tells ops.
 */
export async function billingRequestsSwitchedOn(): Promise<boolean> {
  return (await getJob(JOB_BILLING_REQUESTS))?.enabled === true;
}

/**
 * The clock a drain runs on: the `now` it was started with, moving forward
 * with real time. Every lease, wait and outcome stamp is taken from it, so a
 * test that pins `now` gets the same answers every run, and a drain that
 * spends a minute on Stripe never leases from the minute it started.
 */
function runningClock(start: Date): () => Date {
  const startedAt = Date.now();
  return () => new Date(start.getTime() + (Date.now() - startedAt));
}

type DrainContext = { clock: () => Date; stripe: () => Stripe };

/**
 * Carry out the due requests (BD1 to BD3, BD11, R3 to R5, R15): at most one
 * per billing clinic per batch, `close_setup` only while `setup-closure` is
 * on. Never inside a transaction. A request's own failure is recorded on it
 * and counted; only a database failure rejects.
 */
export async function drainBillingRequests(options: DrainOptions = {}): Promise<DrainResult> {
  const now = options.now ?? new Date();
  const max = Math.max(1, Math.min(options.max ?? DEFAULT_DRAIN_MAX, DUE_ROWS_CAP));
  const ctx: DrainContext = {
    clock: runningClock(now),
    // Resolved only when a worker reaches Stripe: a drain with nothing due,
    // or only local outcomes, must not fail on a missing key.
    stripe: () => options.stripe ?? getStripe(),
  };

  // `close_setup` stays out of the query, not merely skipped after it, while
  // the switch is off: held rows are due on every run, and left in the query
  // they would fill the batch and starve every plan start behind them.
  const kinds: BillingRequestKind[] = ["cancel_now", "plan_start", "step_up"];
  if (await setupClosureSwitchedOn()) kinds.push("close_setup");

  const due = await dueRequests(now, Math.min(max * 4, DUE_ROWS_CAP), kinds);
  const result: DrainResult = { processed: 0, deferred: 0, failed: 0 };
  for (const row of onePerClinic(due, max)) {
    let tally: Tally;
    try {
      tally = await processRequest(row, ctx);
    } catch (error) {
      // Only a database failure gets here (every Stripe failure is recorded
      // on its row). One clinic's must not stop the batch for the rest; the
      // row's lease runs out and the next run retries it.
      log.error("billing request could not be recorded", {
        clinicId: row.clinicId,
        requestId: row.id,
        kind: row.kind,
        code: failureOf(error).code,
      });
      tally = "failed";
    }
    if (tally === "processed") result.processed += 1;
    else if (tally === "deferred") result.deferred += 1;
    else if (tally === "failed") result.failed += 1;
  }
  return result;
}

/**
 * The `billing-requests` job: every minute from the `billing-minute` queue and
 * hourly from the tick (R17). Behind its switch, but without runJob's
 * 60-minute lock, because each request is leased on its own row and a crash
 * must not stop the minute worker for an hour.
 *
 * The drain runs on the later of `now` and the real clock. The tick passes
 * the hour it is running for, and by the time its earlier jobs have finished
 * that can be minutes old; leases taken from it would already have run out
 * against the minute worker, which leases on the real clock, and the two
 * would then claim the same request.
 */
export async function runBillingRequestsJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_BILLING_REQUESTS,
    async () => {
      const drainAt = new Date(Math.max(now.getTime(), Date.now()));
      const result = await drainBillingRequests({ now: drainAt, stripe: options.stripe });
      const held = (await setupClosureSwitchedOn())
        ? 0
        : (await dueRequests(drainAt, DUE_ROWS_CAP, ["close_setup"])).length;
      return (
        `${result.processed} finished, ${result.deferred} deferred, ${result.failed} failed` +
        (held ? `; ${held} setup closures held while setup-closure is off` : "") +
        "."
      );
    },
    now,
  );
}

// -----------------------------------------------------------------------------
// One attempt
// -----------------------------------------------------------------------------

type Claim = {
  id: string;
  /** The billing clinic: every request lives on one (R2). */
  clinicId: string;
  kind: BillingRequestKind;
  channelKey: BillingRequestChannelKey;
  reason: BillingRequestReason;
  /** How many times the row had been re-armed when it was claimed (review fix). */
  epoch: number;
  /** This attempt's number: the row's `attempts` after the claim counted it. */
  attempt: number;
  /** This attempt's name on the Stripe mutation lease. */
  owner: string;
};

type Finish = {
  type: "finish";
  outcome: "done" | "skipped";
  reason: string;
  /** Local writes, in the outcome's own transaction, only if the fenced write matched. */
  apply?: (tx: TenantTx) => Promise<void>;
  /** After commit, outside any transaction. */
  afterCommit?: () => Promise<void>;
};
type Defer = { type: "defer"; delayMs: number };
type Fail = { type: "fail"; code: string; permanent: boolean };
type WorkerResult = Finish | Defer | Fail;
type Proceed<T> = { type: "proceed"; value: T };

function skip(reason: string, afterCommit?: () => Promise<void>): Finish {
  return { type: "finish", outcome: "skipped", reason, afterCommit };
}

function defer(delayMs: number): Defer {
  return { type: "defer", delayMs };
}

/** A failure with a closed code: never a Stripe payload or an exception's text. */
class RequestFailure extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = "RequestFailure";
  }
}

/** The claim was overtaken: another attempt owns the row now, so this one writes nothing. */
class LeaseLostError extends Error {
  constructor() {
    super("The billing request's lease was lost to another attempt.");
    this.name = "LeaseLostError";
  }
}

const STRIPE_ERROR_FAMILIES: Readonly<Record<string, string>> = {
  StripeCardError: "card_error",
  StripeInvalidRequestError: "invalid_request",
  StripeAPIError: "api_error",
  StripeAuthenticationError: "authentication",
  StripePermissionError: "permission",
  StripeRateLimitError: "rate_limit",
  StripeConnectionError: "connection",
  StripeIdempotencyError: "idempotency",
};

function stripeErrorType(error: unknown): string | null {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === "string" && /^Stripe[A-Za-z]*Error$/.test(type) ? type : null;
}

/** The closed code a failure is recorded under (`last_error`, at most 300 characters). */
function failureOf(error: unknown): { code: string; permanent: boolean } {
  if (error instanceof RequestFailure) return { code: error.code, permanent: error.permanent };
  if (error instanceof PriceNotFoundError) {
    return { code: `price_not_found:${error.lookupKey}`.slice(0, 300), permanent: false };
  }
  if (error instanceof StripeNotConfiguredError) {
    return { code: "stripe_not_configured", permanent: false };
  }
  const type = stripeErrorType(error);
  if (type) {
    const family = STRIPE_ERROR_FAMILIES[type] ?? "error";
    const raw = (error as { code?: unknown }).code;
    const code = typeof raw === "string" && /^[a-z0-9_]{1,60}$/.test(raw) ? `:${raw}` : "";
    return { code: `stripe:${family}${code}`, permanent: false };
  }
  const name =
    error instanceof Error && /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "unknown";
  return { code: `internal:${name}`, permanent: false };
}

function isRequestKind(value: string): value is BillingRequestKind {
  return (BILLING_REQUEST_KINDS as readonly string[]).includes(value);
}

/**
 * Every write after the claim is conditional on the attempt it claimed (R4),
 * in the epoch it claimed it in: a re-arm restarts the attempt count, so the
 * attempt number alone would let a worker stalled from before the re-arm
 * match the new attempt that bears its number.
 */
function fenced(claim: Claim) {
  return and(
    eq(billingRequests.id, claim.id),
    eq(billingRequests.clinicId, claim.clinicId),
    eq(billingRequests.epoch, claim.epoch),
    eq(billingRequests.attempts, claim.attempt),
    isNull(billingRequests.doneAt),
  );
}

/**
 * One attempt in progress: the claim, the clock, and the two leases it
 * renews before each Stripe call.
 */
class Attempt {
  constructor(
    readonly claim: Claim,
    private readonly ctx: DrainContext,
  ) {}

  now(): Date {
    return this.ctx.clock();
  }

  stripe(): Stripe {
    return this.ctx.stripe();
  }

  /** A transaction on the billing clinic's tenant, where the request and its entitlements live. */
  inBilling<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant({ clinicId: this.claim.clinicId, actor: ACTOR }, fn);
  }

  /** Take (or renew) the billing clinic's Stripe mutation lease for this attempt (R5). */
  holdMutationLease(tx: TenantTx): Promise<boolean> {
    return claimStripeMutationLease(tx.db, this.claim.clinicId, this.claim.owner, {
      now: this.now(),
    });
  }

  /**
   * Renew both leases, then make the call. A renewal that matches nothing
   * means another attempt has taken the row (or the mutation lease): this one
   * stops before Stripe rather than act on a decision someone else now owns.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const renewed = await this.inBilling(async (tx) => {
      const at = this.now();
      const rows = await tx.db
        .update(billingRequests)
        .set({ leaseUntil: new Date(at.getTime() + BILLING_REQUEST_LEASE_MS) })
        .where(fenced(this.claim))
        .returning({ id: billingRequests.id });
      if (rows.length === 0) return false;
      return this.holdMutationLease(tx);
    });
    if (!renewed) throw new LeaseLostError();
    return fn();
  }

  /**
   * Stripe's idempotency key for this attempt (R4): a new attempt never
   * inherits a cached failure, and neither does a re-armed request, whose
   * attempts start again from 1 in a new epoch.
   */
  key(prefix: string): string {
    const { clinicId, id, epoch, attempt } = this.claim;
    return `${prefix}:${clinicId}:${id}:${epoch}:${attempt}`;
  }
}

/** Claim a due row: lease it and count the attempt, in its billing clinic's tenant. */
async function claimRequest(row: DueRow, ctx: DrainContext): Promise<Claim | null> {
  return withTenant({ clinicId: row.clinicId, actor: ACTOR }, async (tx) => {
    const at = ctx.clock();
    const [claimed] = await tx.db
      .update(billingRequests)
      .set({
        leaseUntil: new Date(at.getTime() + BILLING_REQUEST_LEASE_MS),
        attempts: sql`${billingRequests.attempts} + 1`,
      })
      .where(
        and(
          eq(billingRequests.id, row.id),
          eq(billingRequests.clinicId, row.clinicId),
          isNull(billingRequests.doneAt),
          lte(billingRequests.nextAttemptAt, at),
          or(isNull(billingRequests.leaseUntil), lt(billingRequests.leaseUntil, at)),
        ),
      )
      .returning();
    if (!claimed || !isRequestKind(claimed.kind)) return null;
    return {
      id: claimed.id,
      clinicId: claimed.clinicId,
      kind: claimed.kind,
      channelKey: claimed.channelKey,
      reason: claimed.reason,
      epoch: claimed.epoch,
      attempt: claimed.attempts,
      owner: `billing_request:${claimed.id}:${claimed.epoch}:${claimed.attempts}`,
    };
  });
}

type Tally = "processed" | "deferred" | "failed" | "lost" | "not_claimed";

async function processRequest(row: DueRow, ctx: DrainContext): Promise<Tally> {
  let claim: Claim | null;
  try {
    claim = await claimRequest(row, ctx);
  } catch (error) {
    log.error("billing request could not be claimed", {
      clinicId: row.clinicId,
      requestId: row.id,
      kind: row.kind,
      code: failureOf(error).code,
    });
    return "failed";
  }
  if (!claim) return "not_claimed";

  const attempt = new Attempt(claim, ctx);
  let result: WorkerResult;
  try {
    result = await runWorker(attempt);
  } catch (error) {
    if (error instanceof LeaseLostError) {
      await releaseQuietly(attempt);
      log.warn("billing request lease lost; another attempt owns it", {
        clinicId: claim.clinicId,
        requestId: claim.id,
        kind: claim.kind,
        attempt: claim.attempt,
      });
      return "lost";
    }
    result = { type: "fail", ...failureOf(error) };
  }

  try {
    return await settle(attempt, result);
  } catch (error) {
    // The outcome's transaction failed (a local write threw): record the
    // attempt as failed instead, so the row backs off and, if it keeps
    // failing, dead-letters to a person rather than spinning.
    if (result.type !== "fail") {
      return settle(attempt, { type: "fail", ...failureOf(error) });
    }
    throw error;
  }
}

async function runWorker(attempt: Attempt): Promise<WorkerResult> {
  switch (attempt.claim.kind) {
    case "plan_start":
      return planStartWorker(attempt);
    case "step_up":
      return stepUpWorker(attempt);
    case "close_setup":
      return closeSetupWorker(attempt);
    case "cancel_now":
      return cancelNowWorker(attempt);
  }
}

async function releaseQuietly(attempt: Attempt): Promise<void> {
  try {
    await attempt.inBilling((tx) =>
      releaseStripeMutationLease(tx.db, attempt.claim.clinicId, attempt.claim.owner),
    );
  } catch {
    // The lease runs out on its own in five minutes.
  }
}

/**
 * Record what the attempt came to, fenced on the attempt it claimed, and
 * release the mutation lease in the same transaction. A finished request's
 * local writes run in that transaction too, and only when the fenced write
 * matched: an attempt that was overtaken leaves the Stripe-derived writes to
 * the attempt that overtook it, which re-reads Stripe and makes them itself.
 */
async function settle(attempt: Attempt, result: WorkerResult): Promise<Tally> {
  const { claim } = attempt;
  const at = attempt.now();
  const deadLetter =
    result.type === "fail" && (result.permanent || claim.attempt >= MAX_BILLING_REQUEST_ATTEMPTS);

  const written = await attempt.inBilling(async (tx) => {
    const values =
      result.type === "finish"
        ? {
            doneAt: at,
            outcome: result.outcome,
            outcomeReason: result.reason,
            leaseUntil: null,
          }
        : result.type === "defer"
          ? {
              // A wait is not an attempt: give it back.
              attempts: claim.attempt - 1,
              nextAttemptAt: new Date(at.getTime() + result.delayMs),
              leaseUntil: null,
            }
          : deadLetter
            ? {
                doneAt: at,
                outcome: "dead_letter" as const,
                outcomeReason: result.permanent ? "permanent_error" : "attempts_exhausted",
                lastError: result.code.slice(0, 300),
                leaseUntil: null,
              }
            : {
                nextAttemptAt: new Date(at.getTime() + retryDelayMs(claim.attempt)),
                lastError: result.code.slice(0, 300),
                leaseUntil: null,
              };
    const rows = await tx.db
      .update(billingRequests)
      .set(values)
      .where(fenced(claim))
      .returning({ id: billingRequests.id });
    if (rows.length > 0 && result.type === "finish" && result.apply) await result.apply(tx);
    await releaseStripeMutationLease(tx.db, claim.clinicId, claim.owner);
    return rows.length > 0;
  });

  if (!written) return "lost";

  const fields = {
    clinicId: claim.clinicId,
    requestId: claim.id,
    kind: claim.kind,
    ...(claim.channelKey !== "-" ? { channel: claim.channelKey } : {}),
  };
  switch (result.type) {
    case "finish":
      log.info("billing request finished", {
        ...fields,
        outcome: result.outcome,
        reason: result.reason,
      });
      if (result.afterCommit) await result.afterCommit();
      return "processed";
    case "defer":
      return "deferred";
    case "fail":
      if (deadLetter) {
        await notifyOps("billing_request_dead_lettered", {
          ...fields,
          attempts: claim.attempt,
          code: result.code,
        });
      } else {
        log.warn("billing request attempt failed", {
          ...fields,
          attempt: claim.attempt,
          code: result.code,
        });
      }
      return "failed";
  }
}

// -----------------------------------------------------------------------------
// The workers
// -----------------------------------------------------------------------------

/** The package bought; a legacy row (no bought package) bought what it is billed. */
function boughtPlanOf(row: Entitlements): Plan | undefined {
  return getPlan(row.boughtPlanId ?? row.planCode);
}

async function requestsOf(tx: TenantTx): Promise<BillingRequest[]> {
  return tx.db.select().from(billingRequests).where(eq(billingRequests.clinicId, tx.clinicId));
}

/** healdesk never uses a Stripe trial: a trialing subscription means someone made one by hand. */
function refuseTrial(sub: Stripe.Subscription): void {
  if (sub.status === "trialing") throw new RequestFailure("subscription_trialing", true);
}

async function retrieveSubscription(
  attempt: Attempt,
  subscriptionId: string,
  params: Stripe.SubscriptionRetrieveParams = {},
) {
  const stripe = attempt.stripe();
  return attempt.call(() =>
    stripe.subscriptions.retrieve(subscriptionId, params, workerRequestOptions()),
  );
}

/**
 * After a failed mutation, read the subscription again (R4): a 5xx, a
 * dropped connection or an idempotency error can arrive after Stripe
 * applied the change. Returns the fresh subscription for the caller to
 * judge; rethrows the original error when it was not Stripe's, or when the
 * re-read fails too (the next attempt, under a new key, retries cleanly).
 */
async function rereadAfter(
  attempt: Attempt,
  subscriptionId: string,
  error: unknown,
  params: Stripe.SubscriptionRetrieveParams = {},
): Promise<Stripe.Subscription> {
  if (!stripeErrorType(error)) throw error;
  try {
    return await retrieveSubscription(attempt, subscriptionId, params);
  } catch (reread) {
    if (reread instanceof LeaseLostError) throw reread;
    throw error;
  }
}

/**
 * Plan start (BD2, R4, R5, R8, R16): swap the $0 placeholder for the package
 * the channels in service make, anchored now, so Stripe invoices and charges
 * the first period inside the update.
 */
async function planStartWorker(attempt: Attempt): Promise<WorkerResult> {
  const { claim } = attempt;
  const group = await readBillingGroupChannels(claim.clinicId, attempt.now(), ACTOR);

  const ready = await attempt.inBilling(
    async (
      tx,
    ): Promise<WorkerResult | Proceed<{ row: Entitlements; bought: Plan; billed: Plan }>> => {
      // Locked (review fix): the package bought, the interval and the
      // locations decide what the placeholder is swapped for. changePlan's
      // last transaction writes them and releases the mutation lease together;
      // committed between a plain read and the lease claim below, it left
      // this attempt pricing the old package on the lease it had just freed.
      const row = await getEntitlementsForUpdate(tx.db, claim.clinicId);
      if (!row) return skip("no_entitlements");
      if (hasPlanStarted(row)) return skip("already_started");
      if (CANCEL_PENDING_STATUSES.has(row.status) || row.cancelAt !== null) {
        return skip("cancel_pending");
      }
      // A first-period refund ends the subscription; nothing may price it up first.
      if ((await requestsOf(tx)).some((request) => request.kind === "cancel_now")) {
        return skip("cancel_pending");
      }
      if (!row.stripeSubscriptionId || !row.stripeCustomerId) return skip("no_subscription");
      if (group.inService.size === 0) return skip("no_channel_in_service");
      // A plan change still being completed may have charged for a package
      // this row does not show yet: wait for it, like a busy lease.
      if (row.pendingPlanChangeRequestId !== null) return defer(MUTATION_LEASE_WAIT_MS);
      const bought = boughtPlanOf(row);
      if (!bought) return { type: "fail", code: "unknown_plan", permanent: true };
      const billed = planForChannels(bought, group.inService);
      if (!billed) return skip("nothing_to_bill");
      if (!(await attempt.holdMutationLease(tx))) return defer(MUTATION_LEASE_WAIT_MS);
      return { type: "proceed", value: { row, bought, billed } };
    },
  );
  if (ready.type !== "proceed") return ready;
  const { row, bought, billed } = ready.value;
  const interval = row.billingInterval;
  const subscriptionId = row.stripeSubscriptionId!;
  const customerId = row.stripeCustomerId!;
  const stripe = attempt.stripe();

  const sub = await retrieveSubscription(attempt, subscriptionId);
  refuseTrial(sub);
  const shape = subscriptionShape(sub);
  // Already on a package price: an earlier attempt's update went through and
  // its outcome was never recorded. Record it now, from what Stripe holds,
  // before looking at any cancellation, so the clinic is never left looking
  // "not started" while Stripe has charged its first period.
  if (shape.packageItem && !shape.placeholderItemId) {
    return started(attempt, sub, "already_started", { plan: billed, interval });
  }
  if (hasEnded(sub) || sub.cancel_at_period_end || sub.cancel_at !== null) {
    return skip("cancel_pending");
  }
  if (!shape.placeholderItemId || shape.packageItem) {
    return { type: "fail", code: "unexpected_subscription_items", permanent: true };
  }

  // The bought package's metered rates, on monthly plans only (BD2), less any
  // the subscription already carries: one price may appear on it only once.
  const metered = (expectedMeteredKeys(bought.id, interval) ?? []).filter(
    (key) => !shape.meteredKeys.includes(key),
  );
  const packageKey = stripeLookupKey(billed, interval);
  const prices = await attempt.call(() =>
    pricesForLookupKeys([packageKey, ...metered], { stripe }),
  );

  // R16: the customer's default card is the one source of truth. Checkout
  // left the card on the subscription, where it overrides the customer
  // default the portal updates, so a card replaced in the portal would never
  // be charged. Copy it to the customer when the customer has none, then
  // clear the subscription's in the update itself.
  const subscriptionCard = stripeRefId(sub.default_payment_method);
  if (subscriptionCard) {
    const customer = await attempt.call(() =>
      stripe.customers.retrieve(customerId, {}, workerRequestOptions()),
    );
    if ("deleted" in customer && customer.deleted) {
      return { type: "fail", code: "customer_deleted", permanent: true };
    }
    if (!stripeRefId(customer.invoice_settings?.default_payment_method)) {
      await attempt.call(() =>
        stripe.customers.update(
          customerId,
          { invoice_settings: { default_payment_method: subscriptionCard } },
          workerRequestOptions(attempt.key("hd-pm-sync")),
        ),
      );
    }
  }

  const params: Stripe.SubscriptionUpdateParams = {
    items: [
      { id: shape.placeholderItemId, deleted: true },
      // Always the quantity: a price change without one resets it to 1.
      { price: prices.get(packageKey)!.id, quantity: row.locations },
      ...metered.map((key) => ({ price: prices.get(key)!.id })),
    ],
    billing_cycle_anchor: "now",
    proration_behavior: "none",
    payment_behavior: "allow_incomplete",
    off_session: true,
    // A constant marker, never the existing metadata spread back: Stripe
    // merges keys, and a spread would replay stale values.
    metadata: { hd_plan_start: claim.id },
    expand: ["latest_invoice"],
    ...(subscriptionCard ? { default_payment_method: "" } : {}),
  };

  let updated: Stripe.Subscription;
  try {
    updated = await attempt.call(() =>
      stripe.subscriptions.update(
        subscriptionId,
        params,
        workerRequestOptions(attempt.key("hd-plan-start")),
      ),
    );
  } catch (error) {
    const reread = await rereadAfter(attempt, subscriptionId, error);
    const after = subscriptionShape(reread);
    if (!(after.packageItem && !after.placeholderItemId)) throw error;
    updated = reread;
  }
  return started(attempt, updated, "started", { plan: billed, interval });
}

/**
 * The plan has started on Stripe: stamp it (R8), and move the billed package,
 * interval and metered keys to what the subscription Stripe returned holds.
 * `plan_started_at`, the allowance window and the plan-started email come
 * from the first plan invoice's invoice.paid (BD7), never from here.
 */
function started(
  attempt: Attempt,
  sub: Stripe.Subscription,
  reason: "started" | "already_started",
  fallback: { plan: Plan; interval: BillingInterval },
): Finish {
  const { claim } = attempt;
  const shape = subscriptionShape(sub);
  const plan = shape.packageItem?.plan ?? fallback.plan;
  const interval = shape.packageItem?.interval ?? fallback.interval;
  // R5: the cancellation was set while this update was on its way. The first
  // period has been charged; a person decides whether it should stand.
  const cancelScheduled =
    reason === "started" && (sub.cancel_at_period_end === true || sub.cancel_at != null);
  return {
    type: "finish",
    outcome: "done",
    reason,
    apply: async (tx) => {
      await markPlanStartApplied(tx.db, claim.clinicId, attempt.now());
      await applyBilledPlan(tx.db, claim.clinicId, plan, interval);
      await setMeteredPriceKeys(tx.db, claim.clinicId, shape.meteredKeys);
      await recordBillingNote(tx, { actor: "system", reason: "plan_start" });
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: claim.clinicId,
        metadata: { field: "plan", planCode: plan.id, interval, reason: "plan_start" },
      });
    },
    afterCommit: cancelScheduled
      ? () =>
          notifyOps("plan_start_after_cancel", { clinicId: claim.clinicId, requestId: claim.id })
      : undefined,
  };
}

/**
 * Step-up (BD3, R6, R7): price a channel into the billed package. Waits for
 * the plan to start, without spending attempts, so it is never dropped; the
 * target never loses a channel Stripe already bills.
 */
async function stepUpWorker(attempt: Attempt): Promise<WorkerResult> {
  const { claim } = attempt;
  const channel = claim.channelKey as Channel;

  const gate = await attempt.inBilling(async (tx): Promise<WorkerResult | Proceed<null>> => {
    const row = await getEntitlements(tx.db, claim.clinicId);
    if (!row) return skip("no_entitlements");
    const requests = await requestsOf(tx);
    if (requests.some((request) => request.kind === "cancel_now")) return skip("cancel_pending");
    const planStart = requests.find((request) => request.kind === "plan_start");
    // A legacy row was billed for its package from its first invoice.
    const isStarted =
      hasPlanStarted(row) || planStart?.outcome === "done" || row.boughtPlanId === null;
    if (!isStarted) {
      // R6: a start that will never come finishes the step-up; any other
      // wait defers it, and the plan start prices this channel in if it is
      // in service by then.
      const closed = requests.some(
        (request) => request.kind === "close_setup" && request.outcome === "done",
      );
      if (
        row.status === "canceled" ||
        row.status === "purged" ||
        closed ||
        planStart?.outcome === "skipped" ||
        planStart?.outcome === "dead_letter"
      ) {
        return skip("plan_never_started");
      }
      return defer(STEP_UP_WAIT_MS);
    }
    if (!row.stripeSubscriptionId) return skip("no_subscription");
    return { type: "proceed", value: null };
  });
  if (gate.type !== "proceed") return gate;

  const group = await readBillingGroupChannels(claim.clinicId, attempt.now(), ACTOR);
  const ready = await attempt.inBilling(
    async (tx): Promise<WorkerResult | Proceed<{ row: Entitlements; bought: Plan }>> => {
      // Locked, as in the plan start (review fix): a downgrade committed
      // between a plain read and the lease claim would leave `bought` stale,
      // and the target below could price back in a channel just dropped.
      const row = await getEntitlementsForUpdate(tx.db, claim.clinicId);
      if (!row || !row.stripeSubscriptionId) return skip("no_subscription");
      // And for the same reason, no step-up while a plan change is still
      // being completed: its new package is not on this row yet.
      if (row.pendingPlanChangeRequestId !== null) return defer(MUTATION_LEASE_WAIT_MS);
      const bought = boughtPlanOf(row);
      if (!bought) return { type: "fail", code: "unknown_plan", permanent: true };
      if (!(await attempt.holdMutationLease(tx))) return defer(MUTATION_LEASE_WAIT_MS);
      return { type: "proceed", value: { row, bought } };
    },
  );
  if (ready.type !== "proceed") return ready;
  const { row, bought } = ready.value;
  const subscriptionId = row.stripeSubscriptionId!;
  const stripe = attempt.stripe();
  // The latest invoice comes with every read: an annual step-up's L3 links
  // the invoice its update raised, including one an earlier attempt raised.
  const withInvoice: Stripe.SubscriptionRetrieveParams = { expand: ["latest_invoice"] };

  // `current` is read from Stripe just before the update (R7), not from our
  // row: a step-up decided on a stale plan_code could swap away a channel
  // another step-up priced in a minute ago.
  const sub = await retrieveSubscription(attempt, subscriptionId, withInvoice);
  refuseTrial(sub);
  if (hasEnded(sub)) return skip("subscription_canceled");
  const item = subscriptionShape(sub).packageItem;
  if (!item) return { type: "fail", code: "no_package_item", permanent: false };
  const current = item.plan;
  const interval = item.interval;
  const target = planForChannels(bought, [...channelList(current), ...group.inService, channel]);
  if (!target) return skip("nothing_to_bill");
  if (target.id === current.id) {
    // Our own marker: an earlier attempt's update went through and its
    // outcome was never recorded (a lost response, or a crash before the
    // outcome's transaction). The clinic has been charged for the step-up,
    // so it finishes as one, with its L3 and its history (review fix).
    if (sub.metadata?.hd_step_up === claim.id) {
      return steppedUp(attempt, {
        channel,
        target: current,
        interval,
        priceId: item.priceId,
        locations: row.locations,
        latestInvoice: sub.latest_invoice,
        isRecovered: true,
      });
    }
    // Already priced in (the plan start took it in, or another step-up did):
    // no price change and no email (BD3). Our row follows Stripe either way.
    return {
      type: "finish",
      outcome: "done",
      reason: "no_change",
      apply: async (tx) => {
        await applyBilledPlan(tx.db, claim.clinicId, current, interval);
      },
    };
  }

  const key = stripeLookupKey(target, interval);
  const prices = await attempt.call(() => pricesForLookupKeys([key], { stripe }));
  const priceId = prices.get(key)!.id;
  const params: Stripe.SubscriptionUpdateParams = {
    // The package item only: metered items stay at the bought package's
    // rates, no setup fee is charged and the allowance window is untouched.
    items: [{ id: item.id, price: priceId, quantity: row.locations }],
    proration_behavior: interval === "month" ? "create_prorations" : "always_invoice",
    payment_behavior: "allow_incomplete",
    off_session: true,
    metadata: { hd_step_up: claim.id },
    expand: ["latest_invoice"],
  };

  let updated: Stripe.Subscription;
  try {
    updated = await attempt.call(() =>
      stripe.subscriptions.update(
        subscriptionId,
        params,
        workerRequestOptions(attempt.key("hd-step-up")),
      ),
    );
  } catch (error) {
    const reread = await rereadAfter(attempt, subscriptionId, error, withInvoice);
    if (subscriptionShape(reread).packageItem?.priceId !== priceId) throw error;
    updated = reread;
  }

  return steppedUp(attempt, {
    channel,
    target,
    interval,
    priceId,
    locations: row.locations,
    latestInvoice: updated.latest_invoice,
    isRecovered: false,
  });
}

/**
 * The step-up went through on Stripe: the billed package follows it, the
 * clinic gets L3 (`price_stepped_up`, once per channel and price) and the
 * history its note. An annual step-up is invoiced at once, and L3 links that
 * invoice: only a `subscription_update` invoice, never an older one the
 * subscription happens to name last.
 *
 * `isRecovered` is a step-up an earlier attempt applied (its marker found).
 * Its L3 dedupe key is the one the earlier attempt would have used, so an L3
 * already queued is not queued again, and then nothing else is written
 * either: that outcome was recorded before.
 */
function steppedUp(
  attempt: Attempt,
  input: {
    channel: Channel;
    target: Plan;
    interval: BillingInterval;
    priceId: string;
    locations: number;
    latestInvoice: unknown;
    isRecovered: boolean;
  },
): Finish {
  const { claim } = attempt;
  const { channel, target, interval } = input;
  const invoicedNow = interval === "year";
  const raised =
    (input.latestInvoice as { billing_reason?: unknown } | null)?.billing_reason ===
    "subscription_update";
  const payload = {
    channel,
    planName: target.name,
    amountCents: Math.round(recurringUsd(target, interval) * 100) * input.locations,
    interval,
    isInvoicedNow: invoicedNow,
    hostedInvoiceUrl: invoicedNow && raised ? hostedInvoiceUrlOf(input.latestInvoice) : null,
    // allow_incomplete applies the step-up even when the card declines and
    // leaves its invoice open, so "charged" only when that invoice, the
    // step-up's own, was paid.
    isPaid:
      invoicedNow &&
      raised &&
      (input.latestInvoice as { status?: unknown } | null)?.status === "paid",
  };
  return {
    type: "finish",
    outcome: "done",
    reason: "stepped_up",
    apply: async (tx) => {
      await applyBilledPlan(tx.db, claim.clinicId, target, interval);
      const queued = await enqueueNotice(
        tx,
        "price_stepped_up",
        `step_up:${channel}:${input.priceId}`,
        payload,
      );
      if (input.isRecovered && !queued) return;
      await recordBillingNote(tx, { actor: "system", reason: "step_up" });
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: claim.clinicId,
        metadata: { field: "plan", planCode: target.id, interval, reason: "step_up", channel },
      });
    },
  };
}

/**
 * The customer's pending invoice items for this subscription, deleted before
 * an immediate cancellation: Stripe still charges pending items at the end of
 * the period unless they are removed, which would bill a clinic whose account
 * was closed or whose first period was refunded.
 */
async function deletePendingInvoiceItems(
  attempt: Attempt,
  customerId: string,
  subscriptionId: string,
): Promise<void> {
  const stripe = attempt.stripe();
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const list = await attempt.call(() =>
      stripe.invoiceItems.list(
        {
          customer: customerId,
          pending: true,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
        workerRequestOptions(),
      ),
    );
    for (const item of list.data) {
      const owner =
        stripeRefId(item.parent?.subscription_details?.subscription) ??
        stripeRefId((item as { subscription?: unknown }).subscription);
      if (owner !== subscriptionId) continue;
      try {
        await attempt.call(() => stripe.invoiceItems.del(item.id, {}, workerRequestOptions()));
      } catch (error) {
        // Already gone (another attempt deleted it) is what we wanted.
        if ((error as { code?: unknown }).code !== "resource_missing") throw error;
      }
    }
    if (!list.has_more || list.data.length === 0) return;
    startingAfter = list.data[list.data.length - 1]!.id;
  }
}

/**
 * Cancel at once, after the state check: `subscriptions.cancel` is a DELETE,
 * so Stripe ignores any idempotency key on it (the key is sent only to label
 * the request in Stripe's log). The re-read before it, and after a failure,
 * is what makes a retry safe.
 */
async function cancelSubscriptionNow(
  attempt: Attempt,
  subscriptionId: string,
  comment: "hd_setup_closure" | "hd_first_period_refund" | "hd_agreement_terminated",
  keyPrefix: string,
): Promise<void> {
  const stripe = attempt.stripe();
  try {
    await attempt.call(() =>
      stripe.subscriptions.cancel(
        subscriptionId,
        { prorate: false, invoice_now: false, cancellation_details: { comment } },
        workerRequestOptions(attempt.key(keyPrefix)),
      ),
    );
  } catch (error) {
    const reread = await rereadAfter(attempt, subscriptionId, error);
    if (!hasEnded(reread)) throw error;
  }
}

/**
 * Setup closure (BD11, R12): close an account whose setup window ended with
 * nothing live. Only while the `setup-closure` switch is on (the drainer does
 * not even list these otherwise). A live channel anywhere in the group stops
 * it and tells ops, checked again immediately before the cancel.
 */
async function closeSetupWorker(attempt: Attempt): Promise<WorkerResult> {
  const { claim } = attempt;
  const liveSkip = () =>
    skip("live_channel", () =>
      notifyOps("setup_closure_skipped_live_channel", { clinicId: claim.clinicId }));

  if ((await readBillingGroupChannels(claim.clinicId, attempt.now(), ACTOR)).anyLive) {
    return liveSkip();
  }
  const ready = await attempt.inBilling(
    async (tx): Promise<WorkerResult | Proceed<Entitlements>> => {
      const row = await getEntitlements(tx.db, claim.clinicId);
      if (!row) return skip("no_entitlements");
      if (hasPlanStarted(row)) return skip("plan_started");
      if (!row.stripeSubscriptionId || !row.stripeCustomerId) return skip("no_subscription");
      if (!(await attempt.holdMutationLease(tx))) return defer(MUTATION_LEASE_WAIT_MS);
      return { type: "proceed", value: row };
    },
  );
  if (ready.type !== "proceed") return ready;
  const subscriptionId = ready.value.stripeSubscriptionId!;
  const customerId = ready.value.stripeCustomerId!;

  const sub = await retrieveSubscription(attempt, subscriptionId);
  if (hasEnded(sub)) return { type: "finish", outcome: "done", reason: "already_canceled" };
  // Started on Stripe even if our row has not heard yet: never close a plan
  // that is being charged.
  if (subscriptionShape(sub).packageItem) return skip("plan_started");
  // R12: the last look, immediately before the cancel that cannot be undone.
  if ((await readBillingGroupChannels(claim.clinicId, attempt.now(), ACTOR)).anyLive) {
    return liveSkip();
  }
  await deletePendingInvoiceItems(attempt, customerId, subscriptionId);
  await cancelSubscriptionNow(attempt, subscriptionId, "hd_setup_closure", "hd-close-setup");
  return { type: "finish", outcome: "done", reason: "closed" };
}

/**
 * Cancel now (R15): recorded with a first-period refund. Retrieve; if the
 * subscription is still running, delete its pending items and cancel it
 * with no proration and no final invoice.
 */
async function cancelNowWorker(attempt: Attempt): Promise<WorkerResult> {
  const { claim } = attempt;
  const ready = await attempt.inBilling(
    async (tx): Promise<WorkerResult | Proceed<{ row: Entitlements; ended: boolean }>> => {
      const row = await getEntitlements(tx.db, claim.clinicId);
      if (!row) return skip("no_entitlements");
      if (!row.stripeSubscriptionId || !row.stripeCustomerId) return skip("no_subscription");
      const ended = await agreementEnded(tx);
      if (!(await attempt.holdMutationLease(tx))) return defer(MUTATION_LEASE_WAIT_MS);
      return { type: "proceed", value: { row, ended } };
    },
  );
  if (ready.type !== "proceed") return ready;
  const subscriptionId = ready.value.row.stripeSubscriptionId!;
  const customerId = ready.value.row.stripeCustomerId!;

  const sub = await retrieveSubscription(attempt, subscriptionId);
  if (hasEnded(sub)) return { type: "finish", outcome: "done", reason: "already_canceled" };
  // Overage not yet invoiced is NOT invoiced at this cancellation, on a
  // first-period refund or an agreement's termination alike: the
  // subscription's pending invoice items go first, and the cancel sends
  // prorate: false and invoice_now: false, so a monthly plan's metered usage
  // for the period in progress, the termination day included, is never
  // billed, and Stripe credits nothing for the unused time (a termination's
  // refund is the operator's, confirmed through commitRefund). An annual
  // plan's month in progress never closes once the subscription is
  // cancelled, so annual-overage.ts never invoices it either
  // (tests/annual-overage.test.ts); months that closed before the
  // cancellation are invoiced as they always are, for time already served.
  await deletePendingInvoiceItems(attempt, customerId, subscriptionId);
  await cancelSubscriptionNow(
    attempt,
    subscriptionId,
    ready.value.ended ? "hd_agreement_terminated" : "hd_first_period_refund",
    "hd-cancel-now",
  );
  return { type: "finish", outcome: "done", reason: "canceled" };
}
