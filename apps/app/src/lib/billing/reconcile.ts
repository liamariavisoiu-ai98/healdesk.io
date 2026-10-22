import {
  CHANNELS,
  channelList,
  getPlan,
  planForChannels,
  recurringUsd,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingNotices,
  billingRequests,
  clinics,
  entitlements,
  type BillingRequest,
  type BillingRequestKind,
  type BillingRequestReason,
  type ChannelWaitingOn,
  type Entitlements,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  claimStripeMutationLease,
  getEntitlements,
  hasPlanStarted,
  releaseStripeMutationLease,
} from "@/lib/billing/entitlements";
import { reconcileTerminations } from "@/lib/agreements/termination";
import { disconnectStripeConnect } from "@/lib/billing/connect";
import { enqueueNotice } from "@/lib/billing/notices";
import { resumeLocationSetup } from "@/lib/billing/stripe-actions";
import {
  billingGroupClinicIds,
  closeUnfinishedSetup,
  readBillingGroupChannels,
  rearmBillingRequest,
  startPlan,
  stepUpPackage,
  type BillingGroupChannels,
  type BillingRequestChannelKey,
} from "@/lib/billing/requests";
import { resumePlanChange, STALE_PLAN_CHANGE_MS } from "@/lib/billing/stripe-actions";
import { activatePendingLocation } from "@/lib/location-add";
import { locationsReady, phoneHeldByLocations } from "@/lib/locations";
import { describeError, log } from "@/lib/log";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import {
  getJob,
  JOB_BILLING_RECONCILE,
  JOB_SETUP_CLOSURE,
  runJob,
  type JobOutcome,
} from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The hourly billing reconcile (BD1, BD4, R6, R12, R14, R33): the
 * self-healing half of the billing-request ledger. The engine records a plan
 * start or a step-up inside the transaction of a channel's first answer; this
 * job catches everything that path cannot, for every billing clinic with a
 * bought package:
 *
 *   - a plan start that is due but missing (a channel in service, the plan
 *     not started, no cancellation pending), or one that was skipped or
 *     dead-lettered and can now go through, such as a start skipped for a
 *     cancellation that has since been reversed;
 *   - a step-up for a channel in service that the billed package lacks, once
 *     the plan has started, including one whose earlier step-up finished
 *     without pricing it in;
 *   - a channel ready on our side and waiting on the clinic: a week's notice
 *     (L4), then its step-up 30 days after the later of its readiness and the
 *     plan start, never sooner than a week after that notice was queued;
 *   - a setup closure at the end of the 30-day setup window, when nothing is
 *     live anywhere in the group and the plan has not started;
 *   - an extra location charged but not yet active, activated once its
 *     package may add locations (locationsReady);
 *   - an extra location left pending with no charge on record, settled from
 *     Stripe's evidence once nobody holds the mutation lease;
 *   - a request pending for more than a day, told to ops once;
 *   - a terminated practice whose termination stopped half way, its
 *     locations not offboarding or its cancellation not recorded, finished
 *     and told to ops (reconcileTerminations, lib/agreements/termination.ts).
 *
 * It only records, with one exception: the billing-requests worker carries
 * out every request, and the only Stripe calls made from here are the
 * pending location's settling, which reads Stripe's evidence and never
 * charges (`resumeLocationSetup`). Every clinic of a group is read in its own
 * transaction, one after another, never nested.
 */

const ACTOR = { type: "service", serviceName: "billing-reconcile" } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A request pending this long is stuck (R6). */
export const STUCK_AFTER_MS = DAY_MS;
/** A dead-lettered request is re-armed only once it has rested this long (R6). */
export const DEAD_LETTER_REST_MS = DAY_MS;
/** A waiting channel joins the price this many days after the later of readiness and the start (BD4). */
export const WAITING_JOIN_DAYS = 30;
/** And never with less notice than this (BD4, R33). */
export const STEP_UP_NOTICE_DAYS = 7;

/** Statuses in which the worker would skip a plan start straight away (BD2), so re-arming one would only spin. */
const PLAN_START_BLOCKED: ReadonlySet<string> = new Set([
  "canceling",
  "canceled",
  "suspended",
  "purged",
]);
const ENDED: ReadonlySet<string> = new Set(["canceled", "purged"]);
/** No renewal to join: a waiting channel neither joins nor is announced. */
const WAITING_BLOCKED: ReadonlySet<string> = new Set([
  "canceling",
  "canceled",
  "suspended",
  "purged",
]);

type RequestRef = Pick<BillingRequest, "id" | "kind" | "channelKey">;

export type ReconcileAction =
  | { type: "record"; kind: "plan_start" }
  | { type: "record"; kind: "step_up"; channel: Channel; reason: "reconcile" | "waiting" }
  | { type: "record"; kind: "close_setup" }
  | { type: "rearm"; request: RequestRef; reason: BillingRequestReason; wasDeadLetter: boolean }
  | {
      type: "remind";
      channel: Channel;
      /** ISO date the channel joins the price. */
      joinsOn: string;
      waitingOn: ChannelWaitingOn;
      plan: Plan;
      interval: BillingInterval;
      amountCents: number;
    }
  | { type: "stuck"; request: RequestRef }
  /**
   * Phone is in service (or waiting) and the bought package has it, but the
   * account has more than one location, or one being added: no step-up is
   * recorded and no reminder promises a date; ops are told once.
   */
  | { type: "phone_held"; channel: Channel }
  | { type: "resume_location" }
  | { type: "settle_location"; requestId: string; count: number };

export type ReconcileInput = {
  now: Date;
  row: Entitlements;
  requests: readonly BillingRequest[];
  /** Per channel, the latest join date a step_up_reminder has already promised. */
  promised: ReadonlyMap<Channel, Date>;
  group: Pick<BillingGroupChannels, "inService" | "anyLive" | "states">;
  setupClosureOn: boolean;
};

/** The next UTC midnight at or after `at`: a channel joins at the start of the day it was promised. */
export function startOfJoinDay(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return new Date(midnight === at.getTime() ? midnight : midnight + DAY_MS);
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Channels ready on our side and waiting on the clinic, and not in service
 * anywhere in the group, with the earliest readiness across its clinics and
 * the one thing that clinic still has to do.
 */
function waitingChannels(
  group: ReconcileInput["group"],
): Map<Channel, { readyAt: Date; waitingOn: ChannelWaitingOn }> {
  const out = new Map<Channel, { readyAt: Date; waitingOn: ChannelWaitingOn }>();
  for (const state of group.states) {
    if (group.inService.has(state.channel)) continue;
    if (state.readyAt === null || state.waitingOn === null) continue;
    const seen = out.get(state.channel);
    if (!seen || state.readyAt.getTime() < seen.readyAt.getTime()) {
      out.set(state.channel, { readyAt: state.readyAt, waitingOn: state.waitingOn });
    }
  }
  return out;
}

/**
 * What one billing clinic needs this hour, decided from what was read. Pure,
 * so every rule is tested on its own; `reconcileClinic` carries it out.
 */
export function decideReconcile(input: ReconcileInput): ReconcileAction[] {
  const { now, row, requests, group } = input;
  const actions: ReconcileAction[] = [];
  const find = (kind: BillingRequestKind, channel: BillingRequestChannelKey = "-") =>
    requests.find((request) => request.kind === kind && request.channelKey === channel);
  const restedDeadLetter = (request: BillingRequest) =>
    request.outcome === "dead_letter" &&
    request.doneAt !== null &&
    request.doneAt.getTime() <= now.getTime() - DEAD_LETTER_REST_MS;
  /** Record it when missing; re-arm it when it finished and is due again. */
  const ensure = (
    existing: BillingRequest | undefined,
    record: ReconcileAction,
    reason: BillingRequestReason,
    rearmDone: boolean,
  ) => {
    if (!existing) actions.push(record);
    else if (existing.outcome === "skipped" || (rearmDone && existing.outcome === "done")) {
      actions.push({ type: "rearm", request: existing, reason, wasDeadLetter: false });
    } else if (restedDeadLetter(existing)) {
      actions.push({ type: "rearm", request: existing, reason, wasDeadLetter: true });
    }
  };

  // Stuck: pending for more than a day. A setup closure held by its own
  // switch is waiting by design, not stuck.
  for (const request of requests) {
    if (request.doneAt !== null) continue;
    if (request.kind === "close_setup" && !input.setupClosureOn) continue;
    if (request.requestedAt.getTime() <= now.getTime() - STUCK_AFTER_MS) {
      actions.push({ type: "stuck", request });
    }
  }

  // Everything else is the deferred start's, on a row with a bought package
  // and a subscription. A legacy row was billed in full from its first
  // invoice and has nothing to start, step up or close.
  const bought = row.boughtPlanId ? getPlan(row.boughtPlanId) : undefined;
  if (!bought || !row.stripeSubscriptionId || !row.stripeCustomerId) return actions;
  const billedPlan = getPlan(row.planCode);
  const billed = new Set<Channel>(billedPlan ? channelList(billedPlan) : []);
  const isStarted = hasPlanStarted(row);
  const refunded = requests.some((request) => request.kind === "cancel_now");

  // Plan start (BD1, R6). The conditions mirror the worker's own re-check,
  // so a start recorded or re-armed here is never skipped again at once and
  // re-armed again an hour later, round and round.
  if (
    !isStarted &&
    [...group.inService].some((channel) => bought.channels[channel]) &&
    !PLAN_START_BLOCKED.has(row.status) &&
    row.cancelAt === null &&
    !refunded
  ) {
    ensure(find("plan_start"), { type: "record", kind: "plan_start" }, "reconcile", false);
  }

  // Phone is per location, which the extra-locations plan's slice 2 builds:
  // while the account has more than one location, or one being added, a
  // step-up into phone is held (phoneHeldByLocations) rather than recorded,
  // so it is neither charged nor skipped by the worker and re-armed here
  // every hour; ops are told once.
  const phoneHeld = phoneHeldByLocations(row);
  // What a reminder may price in: phone, while it is held, only if already billed.
  const pricedInService = [...group.inService].filter(
    (channel) => channel !== "voice" || !phoneHeld || billed.has("voice"),
  );
  let toldPhoneHeld = false;
  const holdPhone = (channel: Channel) => {
    if (toldPhoneHeld) return;
    toldPhoneHeld = true;
    actions.push({ type: "phone_held", channel });
  };

  // Step-ups for channels in service that the billed package lacks (R6),
  // only once the plan has started: before that the start itself prices in
  // every channel in service. A finished step-up whose channel is still
  // missing is re-armed.
  if (isStarted && !ENDED.has(row.status) && !refunded) {
    for (const channel of CHANNELS) {
      if (!group.inService.has(channel) || !bought.channels[channel] || billed.has(channel))
        continue;
      if (channel === "voice" && phoneHeld) {
        holdPhone(channel);
        continue;
      }
      ensure(
        find("step_up", channel),
        { type: "record", kind: "step_up", channel, reason: "reconcile" },
        "reconcile",
        true,
      );
    }
  }

  // Waiting channels (BD4, R33).
  const startedAt = row.planStartedAt ?? row.planStartAppliedAt;
  if (
    isStarted &&
    startedAt &&
    !WAITING_BLOCKED.has(row.status) &&
    row.cancelAt === null &&
    !refunded
  ) {
    for (const [channel, waiting] of waitingChannels(group)) {
      if (!bought.channels[channel] || billed.has(channel)) continue;
      if (channel === "voice" && phoneHeld) {
        holdPhone(channel);
        continue;
      }
      const due = startOfJoinDay(
        new Date(
          Math.max(waiting.readyAt.getTime(), startedAt.getTime()) + WAITING_JOIN_DAYS * DAY_MS,
        ),
      );
      // A reminder promising a date before this due date belongs to an
      // earlier wait, not this one.
      const promised = input.promised.get(channel);
      const joinsAt = promised && promised.getTime() >= due.getTime() ? promised : null;
      if (!joinsAt) {
        if (now.getTime() >= due.getTime() - STEP_UP_NOTICE_DAYS * DAY_MS) {
          // R33: never less than a week's notice. A reminder queued late
          // (the job was off, or switched on after the date) moves the join
          // date to a week after it is queued, and the step-up waits for it.
          const joins = new Date(
            Math.max(
              due.getTime(),
              startOfJoinDay(new Date(now.getTime() + STEP_UP_NOTICE_DAYS * DAY_MS)).getTime(),
            ),
          );
          const plan = planForChannels(bought, [...billed, ...pricedInService, channel]);
          if (plan) {
            actions.push({
              type: "remind",
              channel,
              joinsOn: isoDate(joins),
              waitingOn: waiting.waitingOn,
              plan,
              interval: row.billingInterval,
              amountCents:
                Math.round(recurringUsd(plan, row.billingInterval) * 100) * row.locations,
            });
          }
        }
        continue;
      }
      if (now.getTime() < joinsAt.getTime()) continue;
      ensure(
        find("step_up", channel),
        { type: "record", kind: "step_up", channel, reason: "waiting" },
        "waiting",
        true,
      );
    }
  }

  // Setup closure (R12): the deadline has passed, nothing has started,
  // nothing is live anywhere in the group, and the account is not already
  // over. The unique row makes it idempotent with any funnel caller.
  if (
    !isStarted &&
    row.setupDeadlineAt !== null &&
    row.setupDeadlineAt.getTime() <= now.getTime() &&
    !ENDED.has(row.status) &&
    !group.anyLive &&
    !find("close_setup")
  ) {
    actions.push({ type: "record", kind: "close_setup" });
  }

  // An extra location charged but not created (R14).
  if (row.pendingLocationRequestId && row.pendingLocationCount && row.pendingLocationChargedAt) {
    actions.push({ type: "resume_location" });
  }

  // An extra location pending with no charge on record (review fix): the
  // charge's answer was lost, or the process died around it. Nothing else
  // would ever settle it, and every retry the clinic makes carries a fresh
  // request id and is refused while it is pending. Once the mutation lease
  // is free the original request is no longer in flight, and Stripe's
  // evidence decides: charged, the location is finished; not, the request
  // is cleared.
  const leaseFree =
    row.stripeMutationLeaseUntil === null || row.stripeMutationLeaseUntil.getTime() < now.getTime();
  if (
    row.pendingLocationRequestId &&
    row.pendingLocationCount &&
    !row.pendingLocationChargedAt &&
    leaseFree
  ) {
    actions.push({
      type: "settle_location",
      requestId: row.pendingLocationRequestId,
      count: row.pendingLocationCount,
    });
  }

  return actions;
}

export type ReconcileSummary = {
  clinics: number;
  recorded: number;
  rearmed: number;
  reminders: number;
  stuck: number;
  /** Accounts whose step-up into phone is held because they have more than one location. */
  phoneHeld: number;
  locationsResumed: number;
  locationsHeld: number;
  /** Pending locations Stripe shows were never charged: cleared, for the clinic to add again. */
  locationsCleared: number;
  connectsDisconnected: number;
  /** Terminated practices whose offboarding or cancellation this pass finished (R5). */
  terminationsFinished: number;
  failures: number;
};

/** Every billing clinic, through the 0008 enumeration definer (ids only). */
async function billingClinicIds(): Promise<string[]> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where billing_clinic_id is null`,
  );
  return result.rows.map((row) => String(row.id));
}

/** The join date each reminder already promised, per channel: the latest. */
function promisedDates(
  reminders: readonly { dedupeKey: string; payload: Record<string, unknown> }[],
): Map<Channel, Date> {
  const out = new Map<Channel, Date>();
  for (const reminder of reminders) {
    const [, fromKey, dateFromKey] = reminder.dedupeKey.split(":");
    const channel = (reminder.payload.channel ?? fromKey) as Channel;
    if (!CHANNELS.includes(channel)) continue;
    const joinsOn =
      typeof reminder.payload.joinsOn === "string" ? reminder.payload.joinsOn : dateFromKey;
    const at = joinsOn ? new Date(`${joinsOn.slice(0, 10)}T00:00:00Z`) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const seen = out.get(channel);
    if (!seen || at.getTime() > seen.getTime()) out.set(channel, at);
  }
  return out;
}

/**
 * A request this run recorded is due at the run's own `now`, not at the
 * database's insert time: the tick runs the worker straight after this job
 * with the same `now`, and a request recorded this hour should go this hour.
 */
async function dueAt(
  tx: TenantTx,
  kind: BillingRequestKind,
  channelKey: BillingRequestChannelKey,
  now: Date,
): Promise<void> {
  await tx.db
    .update(billingRequests)
    .set({ nextAttemptAt: now })
    .where(
      and(
        eq(billingRequests.clinicId, tx.clinicId),
        eq(billingRequests.kind, kind),
        eq(billingRequests.channelKey, channelKey),
        isNull(billingRequests.doneAt),
        eq(billingRequests.attempts, 0),
      ),
    );
}

async function reconcileClinic(
  billingClinicId: string,
  now: Date,
  setupClosureOn: boolean,
  summary: ReconcileSummary,
): Promise<void> {
  const snapshot = await withTenant({ clinicId: billingClinicId, actor: ACTOR }, async (tx) => {
    const row = await getEntitlements(tx.db, billingClinicId);
    if (!row) return null;
    const requests = await tx.db
      .select()
      .from(billingRequests)
      .where(eq(billingRequests.clinicId, billingClinicId));
    const reminders = await tx.db
      .select({ dedupeKey: billingNotices.dedupeKey, payload: billingNotices.payload })
      .from(billingNotices)
      .where(
        and(
          eq(billingNotices.clinicId, billingClinicId),
          eq(billingNotices.kind, "step_up_reminder"),
        ),
      );
    return { row, requests, reminders };
  });
  // A demo, or a clinic provisioned before entitlements existed.
  if (!snapshot) return;
  summary.clinics += 1;

  const group = await readBillingGroupChannels(billingClinicId, now, ACTOR);
  const actions = decideReconcile({
    now,
    row: snapshot.row,
    requests: snapshot.requests,
    promised: promisedDates(snapshot.reminders),
    group,
    setupClosureOn,
  });
  if (actions.length === 0) return;

  const rearmedDeadLetters: RequestRef[] = [];
  const stuck: RequestRef[] = [];
  const phoneHeld: Channel[] = [];
  await withTenant({ clinicId: billingClinicId, actor: ACTOR }, async (tx) => {
    for (const action of actions) {
      switch (action.type) {
        case "record": {
          const recorded =
            action.kind === "plan_start"
              ? await startPlan(tx, billingClinicId, "reconcile")
              : action.kind === "step_up"
                ? await stepUpPackage(tx, billingClinicId, action.channel, action.reason)
                : await closeUnfinishedSetup(tx, billingClinicId, "deadline");
          if (recorded.recorded) {
            await dueAt(tx, action.kind, action.kind === "step_up" ? action.channel : "-", now);
            summary.recorded += 1;
          }
          break;
        }
        case "rearm":
          if (await rearmBillingRequest(tx, action.request.id, action.reason, now)) {
            summary.rearmed += 1;
            if (action.wasDeadLetter) rearmedDeadLetters.push(action.request);
          }
          break;
        case "remind": {
          const queued = await enqueueNotice(
            tx,
            "step_up_reminder",
            `step_up_reminder:${action.channel}:${action.joinsOn}`,
            {
              channel: action.channel,
              joinsOn: action.joinsOn,
              planName: action.plan.name,
              amountCents: action.amountCents,
              interval: action.interval,
              waitingOn: action.waitingOn,
            },
          );
          if (queued) summary.reminders += 1;
          break;
        }
        case "stuck":
          stuck.push(action.request);
          break;
        case "phone_held":
          phoneHeld.push(action.channel);
          break;
        case "resume_location":
        case "settle_location":
          break;
      }
    }
  });

  // After commit, and outside the transaction: each sends an email of its own.
  const fieldsOf = (request: RequestRef) => ({
    clinicId: billingClinicId,
    requestId: request.id,
    kind: request.kind,
    ...(request.channelKey !== "-" ? { channel: request.channelKey } : {}),
  });
  for (const request of rearmedDeadLetters) {
    // R6: a dead letter retried a day later is still something a person
    // should look at.
    await notifyOps("billing_request_dead_lettered", { ...fieldsOf(request), status: "rearmed" });
  }
  for (const request of stuck) {
    // Once per request, ever: every hour would find it again until it moves.
    await notifyOpsOnce("billing_request_stuck", fieldsOf(request));
    summary.stuck += 1;
  }
  for (const channel of phoneHeld) {
    // Once per account, ever: it stays held until phone per location exists.
    await notifyOpsOnce("step_up_phone_held", {
      clinicId: billingClinicId,
      channel,
      count: snapshot.row.locations,
    });
    summary.phoneHeld += 1;
  }

  if (actions.some((action) => action.type === "resume_location")) {
    const resumed = await resumePendingLocation(billingClinicId, { now });
    if (resumed === "resumed") summary.locationsResumed += 1;
    else if (resumed === "not_ready" || resumed === "busy" || resumed === "failed") {
      summary.locationsHeld += 1;
    }
  }

  for (const action of actions) {
    if (action.type !== "settle_location") continue;
    const settled = await settleUnchargedLocation(billingClinicId, action, now);
    if (settled === "resumed") summary.locationsResumed += 1;
    else if (settled === "cleared") summary.locationsCleared += 1;
    else summary.locationsHeld += 1;
  }
}

/**
 * Settle an extra location left pending with no charge on record (review
 * fix), through the console's own resume (`resumeLocationSetup`): it claims
 * the mutation lease under its own name, so it is `busy` while anything else
 * holds it; it asks Stripe whether the charge went through (the
 * subscription's `hd_location` marker, or a paid one-off invoice for the
 * request); charged, it records the charge and creates the location;
 * not, it voids any invoice the attempt left open and clears the request, so
 * the clinic can add the location again. It never charges.
 *
 * Whatever it cannot settle (Stripe did not answer, or the location is
 * charged and still not created) is told to ops once, under the same alert
 * and identity as a charged location the resume cannot create, so a request
 * that moves from one to the other is still one email.
 */
async function settleUnchargedLocation(
  billingClinicId: string,
  pending: { requestId: string; count: number },
  now: Date,
): Promise<"resumed" | "cleared" | "busy" | "held"> {
  const result = await resumeLocationSetup(
    { clinicId: billingClinicId, actorLabel: ACTOR.serviceName },
    { now },
  );
  if (result.status === "added") return "resumed";
  if (result.status === "cleared") return "cleared";
  if (result.status === "busy") return "busy";
  // A request settled by someone else since this run read it (the clinic's
  // own retry of it, or an operator) is not one to report.
  const isStillPending = await withTenant(
    { clinicId: billingClinicId, actor: ACTOR },
    async (tx) => {
      const row = await getEntitlements(tx.db, billingClinicId);
      return row?.pendingLocationRequestId === pending.requestId;
    },
  );
  if (isStillPending) {
    await notifyOpsOnce("location_charged_not_created", {
      clinicId: billingClinicId,
      requestId: pending.requestId,
      count: pending.count,
    });
  }
  return "held";
}

export type LocationResume = "resumed" | "not_ready" | "nothing_pending" | "busy" | "failed";

/**
 * Finish an extra location that was charged but never made active (R14
 * step 4 onwards): activate the location row the add wrote before its charge
 * (lib/location-add.ts), clear the pending marker and queue
 * `location_added`. Under the billing clinic's Stripe mutation lease, so it
 * never races addLocation resuming the same request. While the package
 * bought may not add locations (`locationsReady` false) the location stays
 * pending, untouched; addLocation refuses before any charge in that state,
 * so nothing new can arrive here until it is switched on.
 *
 * Exported for the console's retry (R35 retryLocationSetup), so there is one
 * way to resume a location.
 */
export async function resumePendingLocation(
  billingClinicId: string,
  options: { now?: Date; actor?: ActorContext } = {},
): Promise<LocationResume> {
  const actor = options.actor ?? ACTOR;
  // The lease is compared with the worker's real clock, so it is never taken
  // from an hour that has already gone by.
  const leaseNow = new Date(Math.max((options.now ?? new Date()).getTime(), Date.now()));

  const pending = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlements(tx.db, billingClinicId);
    if (
      !row?.pendingLocationRequestId ||
      !row.pendingLocationCount ||
      !row.pendingLocationChargedAt
    ) {
      return "nothing_pending" as const;
    }
    if (!locationsReady(row.boughtPlanId)) return "not_ready" as const;
    const owner = `location:${row.pendingLocationRequestId}`;
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner, { now: leaseNow }))) {
      return "busy" as const;
    }
    return { row, owner, requestId: row.pendingLocationRequestId, count: row.pendingLocationCount };
  });
  if (typeof pending === "string") return pending;

  try {
    // Idempotent: a location the first attempt activated returns the same
    // time rather than anything being made twice. An add with no location
    // row (marked pending before 0108) cannot be finished here.
    const activated = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
      activatePendingLocation(tx, pending.requestId),
    );
    if (!activated) throw new Error("the add has no pending location to activate");
  } catch (error) {
    await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
      releaseStripeMutationLease(tx.db, billingClinicId, pending.owner),
    );
    log.warn("extra location still not active", {
      clinicId: billingClinicId,
      error: describeError(error),
    });
    await notifyOpsOnce("location_charged_not_created", {
      clinicId: billingClinicId,
      requestId: pending.requestId,
      count: pending.count,
    });
    return "failed";
  }

  const { row } = pending;
  const isStarted = hasPlanStarted(row);
  const billedPlan = getPlan(row.planCode);
  const bought = getPlan(row.boughtPlanId ?? row.planCode);
  await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    // Cleared only while it is still this request: a newer one is not ours.
    const cleared = await tx.db
      .update(entitlements)
      .set({
        pendingLocationRequestId: null,
        pendingLocationCount: null,
        pendingLocationChargedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(entitlements.clinicId, billingClinicId),
          eq(entitlements.pendingLocationRequestId, pending.requestId),
        ),
      )
      .returning({ clinicId: entitlements.clinicId });
    if (cleared.length > 0) {
      await enqueueNotice(tx, "location_added", `location:${pending.requestId}`, {
        locations: pending.count,
        recurringCents: billedPlan
          ? Math.round(recurringUsd(billedPlan, row.billingInterval) * 100)
          : 0,
        setupFeeCents: bought ? Math.round(bought.setupFeeUsd * 100) : 0,
        // The charge's own invoice belongs to the request that made it.
        hostedInvoiceUrl: null,
        isBeforeStart: !isStarted,
        billedPlanId: isStarted ? row.planCode : null,
      });
    }
    await releaseStripeMutationLease(tx.db, billingClinicId, pending.owner);
  });
  return "resumed";
}

/**
 * How long a billing group stays connected after its service ends (R12): a
 * deposit's Checkout Session lasts at most 24 hours, so a day after the end
 * every link the clinic sent has been paid or has expired, and nothing a
 * patient could still pay is cut off.
 */
const CONNECT_KEPT_AFTER_END_MS = DAY_MS;

/**
 * R12's last step: healdesk's access to a clinic's Stripe account ends with the
 * service. A day after a billing group was canceled or purged (clinics.
 * offboarding_started_at, which the deletion webhook stamps), every clinic of
 * the group still holding a connected account is disconnected as
 * "offboarding". disconnectStripeConnect revokes only an account no other
 * clinic uses, so a sibling elsewhere keeps its deposits; and a group whose
 * service has not ended is never touched. Returns how many it disconnected.
 */
async function disconnectEndedAccounts(billingClinicId: string, now: Date): Promise<number> {
  const endedAt = await withTenant({ clinicId: billingClinicId, actor: ACTOR }, async (tx) => {
    const row = await getEntitlements(tx.db, billingClinicId);
    if (!row || (row.status !== "canceled" && row.status !== "purged")) return null;
    const [clinic] = await tx.db
      .select({ offboardingStartedAt: clinics.offboardingStartedAt })
      .from(clinics)
      .where(eq(clinics.id, billingClinicId))
      .limit(1);
    return clinic?.offboardingStartedAt ?? null;
  });
  if (!endedAt || now.getTime() - endedAt.getTime() < CONNECT_KEPT_AFTER_END_MS) return 0;

  let disconnected = 0;
  for (const clinicId of await billingGroupClinicIds(billingClinicId)) {
    const isConnected = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const [clinic] = await tx.db
        .select({ account: clinics.stripeConnectAccountId })
        .from(clinics)
        .where(eq(clinics.id, clinicId))
        .limit(1);
      return Boolean(clinic?.account);
    });
    if (!isConnected) continue;
    const result = await disconnectStripeConnect({
      clinicId,
      actorLabel: "offboarding",
      source: "ops",
      now,
    });
    if (result.status === "disconnected") disconnected += 1;
  }
  return disconnected;
}

/** One pass over every billing clinic. Exported without the job wrapper for tests and operators. */
export async function reconcileBilling(now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    clinics: 0,
    recorded: 0,
    rearmed: 0,
    reminders: 0,
    stuck: 0,
    phoneHeld: 0,
    locationsResumed: 0,
    locationsHeld: 0,
    locationsCleared: 0,
    connectsDisconnected: 0,
    terminationsFinished: 0,
    failures: 0,
  };
  // First, so a cancellation it records is in the ledger the pass below reads.
  try {
    const terminations = await reconcileTerminations();
    summary.terminationsFinished = terminations.practices;
    summary.failures += terminations.failures;
  } catch (error) {
    summary.failures += 1;
    log.error("termination reconcile failed", { error: describeError(error) });
  }
  const setupClosureOn = (await getJob(JOB_SETUP_CLOSURE))?.enabled === true;
  for (const billingClinicId of await billingClinicIds()) {
    try {
      await reconcileClinic(billingClinicId, now, setupClosureOn, summary);
      summary.connectsDisconnected += await disconnectEndedAccounts(billingClinicId, now);
      // A plan change whose outcome was lost and that nobody came back for
      // (review fix of 7 October 2026): finished from what Stripe holds, or
      // dropped when nothing was charged. It never charges, and a clinic with
      // nothing pending costs a read and no Stripe call.
      await resumePlanChange(
        {
          clinicId: billingClinicId,
          actorLabel: "billing-reconcile",
          staleAfterMs: STALE_PLAN_CHANGE_MS,
        },
        { now },
      );
    } catch (error) {
      // One clinic's failure must not stop the reconcile for the rest.
      summary.failures += 1;
      log.error("billing reconcile failed for a clinic", {
        clinicId: billingClinicId,
        error: describeError(error),
      });
    }
  }
  return summary;
}

/**
 * The `billing-reconcile` job, hourly from the tick, behind its switch.
 * runJob's lock is right here: an hourly job that overlaps itself would only
 * record the same rows twice, harmlessly but pointlessly.
 */
export async function runBillingReconcileJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_BILLING_RECONCILE,
    async () => {
      const s = await reconcileBilling(now);
      return (
        `${s.clinics} billing clinics: ${s.recorded} requests recorded, ${s.rearmed} re-armed, ` +
        `${s.reminders} step-up reminders queued, ${s.stuck} stuck` +
        (s.phoneHeld ? `, ${s.phoneHeld} phone step-ups held for more than one location` : "") +
        (s.locationsResumed ? `, ${s.locationsResumed} locations resumed` : "") +
        (s.locationsHeld ? `, ${s.locationsHeld} locations still pending` : "") +
        (s.locationsCleared ? `, ${s.locationsCleared} uncharged location requests cleared` : "") +
        (s.connectsDisconnected
          ? `, ${s.connectsDisconnected} Stripe accounts disconnected after the end`
          : "") +
        (s.terminationsFinished
          ? `, ${s.terminationsFinished} terminated practices finished`
          : "") +
        (s.failures ? `, ${s.failures} failed` : "") +
        "."
      );
    },
    now,
  );
}
