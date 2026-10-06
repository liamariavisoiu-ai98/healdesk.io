import {
  CHANNELS,
  channelList,
  FIRST_PERIOD_REFUND_DAYS,
  FORWARDING_PASS_THROUGH_DAYS,
  getPlan,
  isCarrier,
  type BillingInterval,
  type Channel,
  type Plan,
} from "@healdesk/catalog";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingTransitions,
  clinicChannels,
  clinics,
  overageInvoices,
  type BillingActor,
  type BillingEventOutcome,
  type BillingStatus,
  type Entitlements,
} from "@/db/schema";
import type { NoticeKind } from "@/lib/email/kinds";
import { linkProblem } from "@/lib/email/lint";
import { log } from "@/lib/log";
import {
  DESTROY_AFTER_DAYS,
  DESTROY_WITHOUT_EXPORT_AFTER_DAYS,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { coverageModeOf } from "./answering";
import {
  applyBilledPlan,
  getEntitlements,
  getEntitlementsForUpdate,
  hasPlanStarted,
  markFirstPlanInvoice,
  markPlanStartApplied,
  markPlanStarted,
  openAllowanceWindow,
  parseLookupKey,
  recordFirstInvoice,
  recordInvoicePaid,
  recordOpenInvoice,
  recordSetupFeePaid,
  resetUsage,
  setCancelAt,
  setGrace,
  setLocations,
  setMeteredPriceKeys,
  storeStripeIds,
} from "./entitlements";
import { enqueueNotice, type ForwardingFacts, type NoticePayloads } from "./notices";
import { cachedLookupKeyForPriceId } from "./prices";
import { clinicIdForStripe } from "./resolve";
import { canTransition, recordBillingNote, transition } from "./state-machine";
import { getStripe } from "./stripe-client";
import { workerRequestOptions } from "./stripe-helpers";

/**
 * The Stripe subscription lifecycle, applied to entitlements.
 *
 * apps/web verifies the signature (it holds the Stripe secret) and forwards
 * the event here over the same HMAC channel provisioning uses. This module
 * decides what the event means for the clinic and writes it, inside a tenant
 * transaction, through the state machine.
 *
 * ## Delivered at least once, processed at most once
 *
 * Every event is first written to billing_events keyed on Stripe's event id,
 * in its own statement, before anything is done with it. A second delivery
 * finds the row and answers with the stored outcome; that is the whole dedupe.
 * It has to be a separate statement rather than part of the processing
 * transaction because the ledger must survive the processing FAILING — a
 * failure that rolled its own record back would be invisible.
 *
 * ## Failures retry, then dead-letter — never disable the endpoint
 *
 * Stripe retries any non-2xx for three days and then disables the endpoint,
 * which loses EVERY clinic's renewals, not just the one that broke. So a
 * thrown error is recorded (`outcome = 'failed'`, `failures + 1`) and rethrown
 * so the route answers 500 and Stripe retries — twice. On the third failure
 * the event is marked `dead_letter`, the route answers 200, ops is told
 * (`billing_event_dead_lettered`), and the event sits in billing_events with
 * its full payload and last error until a person replays it with
 * `replayBillingEvent()`. Three is enough to ride out a deploy or a transient
 * database error and few enough that a deterministic bug parks quickly rather
 * than hammering for days.
 *
 * ## What a missing clinic means
 *
 * One Stripe account serves healdesk and scalabid, so events for
 * subscriptions we know nothing about WILL arrive. Those are `ignored`, not
 * failed. But the first `invoice.paid` for a NEW clinic can also arrive before
 * `checkout.session.completed` has finished provisioning it — Stripe does not
 * order deliveries — and ignoring that one would leave the clinic stuck in
 * `provisioning` for ever. The marker apps/web writes into subscription
 * metadata tells the two apart: an unresolvable event that carries our marker
 * throws, retries, and resolves once provisioning has landed.
 *
 * That retry still counts towards MAX_FAILURES, on purpose: an event with our
 * marker whose provisioning was REJECTED (a 422 on /api/provision) will never
 * resolve, and one that retried for three days would take the endpoint down
 * with it. What stops the ordinary race from stranding a clinic is the other
 * direction — provisioning, once it has written the entitlements row, calls
 * `replayParkedBillingEvents()` with the new Stripe ids, and any first invoice
 * that dead-lettered while waiting for it is re-run then. A renewal invoice
 * also activates a clinic still in `provisioning`, so even a first invoice
 * that was lost outright cannot strand it past the first renewal.
 *
 * ## What Stripe says now beats what the event said then (R11)
 *
 * Deliveries are unordered, and a retried event can arrive days after the
 * change it describes. So three event types are re-read from Stripe BEFORE
 * the tenant transaction opens (never inside it: a slow API call must not
 * hold the entitlements row locked):
 *
 *   - `customer.subscription.updated` applies the LIVE subscription, not the
 *     payload's snapshot. Two updates delivered in the wrong order both apply
 *     the state that is true now, so a stale one can no longer undo a newer
 *     one: the subscription itself is the newest record there is. A
 *     cancellation scheduled and reversed before either event is processed
 *     therefore moves nothing and emails nobody, which is the truth. An
 *     update older than one already applied is skipped as well
 *     (newerUpdateApplied), which closes the gap between two concurrent
 *     deliveries' reads and their commits.
 *   - `invoice.payment_failed` and `invoice.payment_action_required` re-read
 *     the invoice and ignore one that is `void` or `paid` by now: a
 *     plan change that failed under `error_if_incomplete` voids its invoice,
 *     and a failure delivered after the retry that paid it must not mark a
 *     paid-up clinic past due or tell it so.
 *   - `charge.refunded` names a charge, not a refund, so the charge's refunds
 *     are listed.
 *
 * `invoice.paid` reads Stripe only for a clinic's first plan invoice, whose
 * line names its price by id alone: the price says which package Stripe
 * billed, which the plan-started email must name. A failed read throws like
 * any other failure: the event retries and, at MAX_FAILURES, parks.
 *
 * ## Bought and billed (BD7, BD31)
 *
 * A row with `bought_plan_id` set was sold under the deferred start: checkout
 * charged the setup fee and a $0 placeholder, and the plan starts at the
 * clinic's first answer, when the worker swaps the placeholder for the
 * package matching the channels in service. invoice.paid is classified for
 * those rows by its lines and the row, not by `billing_reason` alone (see
 * onInvoicePaid). A row without one is LEGACY, written before the deferred
 * start, and keeps the behaviour it always had.
 *
 * ## Notices (BD8)
 *
 * Every email this module causes is a billing_notices row written in the
 * same transaction as the change it describes, so a transaction that rolls
 * back emails nobody, under the R22 dedupe key, so a redelivery queues
 * nothing twice. The tenant is always a BILLING clinic: a Stripe id resolves
 * through the entitlements row, which only a billing clinic has. A critical
 * kind (payment_failed, payment_action_required, suspended, plan_started) is
 * flagged on the result, and the route hands it to deliverCriticalAfterCommit
 * once the transaction has committed. The webhook keeps entitlements in step
 * with the subscription but never queues `plan_changed` or `location_added`:
 * only our own actions know why the subscription changed.
 *
 * ## Pausing is a field, not an event
 *
 * `customer.subscription.paused` and `.resumed` are NOT handled, because they
 * cannot fire here: Stripe's own reference says a subscription "can only enter
 * a `paused` status when a trial ends without a payment method", and there is
 * no trial. The pause a clinic or an operator can actually cause — pausing
 * collection from the Dashboard or the portal — leaves `subscription.status`
 * unchanged and arrives as `customer.subscription.updated` with
 * `pause_collection` set. onSubscriptionUpdated() reads that field; the
 * `paused` billing status means exactly "collection is paused". A subscription
 * that is `trialing` is an error (contracts §2: healdesk never uses a Stripe
 * trial), and parks for a person instead of being applied.
 *
 * ## Handlers are idempotent by inspection, not by the ledger alone
 *
 * The ledger stops a second delivery, but a crash between the processing
 * transaction committing and the ledger row being marked leaves an event that
 * WILL be processed again. So every handler reads the current state first,
 * under the row lock, and does nothing when the clinic is already where the
 * event wanted it, rather than trusting that it runs once.
 */

export const MAX_FAILURES = 3;

/** How long service continues after a failed renewal before suspension. */
export const GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Must match APP_MARKER in apps/web/src/lib/billing.ts, which writes it into
 * every Session and subscription's metadata. Duplicated rather than shared:
 * the catalog is the contract between the two apps and this value is a
 * Stripe-account detail, not a product one.
 */
export const HEALDESK_APP_MARKER = "healdesk";

/**
 * The comment our setup-window closure worker passes to
 * `subscriptions.cancel` (R12). A deletion carrying it sends no `canceled`
 * email: the funnel's closure email, keyed on the offboarding reason
 * `setup_closure`, is the only one.
 */
export const SETUP_CLOSURE_COMMENT = "hd_setup_closure";

export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.dispute.created",
  "charge.refunded",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export type HandleContext = {
  /** Correlates the audit rows this event produces. A uuid; audit_log.request_id is typed as one. */
  requestId?: string;
  /** When the event is processed. Grace windows and fallback dates are measured from it. */
  now?: Date;
};

export type HandleResult = {
  outcome: Exclude<BillingEventOutcome, "failed">;
  /** True when this delivery did no work because an earlier one already had. */
  duplicate: boolean;
  clinicId: string | null;
  /**
   * Present, and true, when this delivery queued a critical notice on
   * `clinicId` (the billing clinic). handleStripeEvent has committed by the
   * time it returns, so the caller may hand the clinic to
   * deliverCriticalAfterCommit; whatever that misses, the minute queue sends.
   */
  criticalNotice?: true;
};

/**
 * Thrown when an event that carries our marker names a customer or
 * subscription no clinic has yet. Retryable by design: provisioning is
 * probably still in flight.
 */
export class UnresolvedClinicError extends Error {
  constructor(readonly eventId: string) {
    super(
      `Stripe event ${eventId} carries the healdesk marker but no clinic ` +
        `matches its customer or subscription yet.`,
    );
    this.name = "UnresolvedClinicError";
  }
}

/**
 * Stripe reports one of our subscriptions as `trialing`. Nothing of ours
 * creates a trial (contracts §2; Stripe would print "TRIAL OVER" on the first
 * charge), so this is somebody's hand in the Dashboard or a bug, and applying
 * it would bill and gate on a state the product does not have. It fails the
 * event, which retries and parks, and the dead letter tells ops.
 */
export class TrialingSubscriptionError extends Error {
  constructor() {
    super("Stripe reports the subscription as trialing; healdesk never uses a Stripe trial.");
    this.name = "TrialingSubscriptionError";
  }
}

const STRIPE_WEBHOOK_ACTOR = {
  type: "service",
  serviceName: "stripe-webhook",
} as const;

export async function handleStripeEvent(
  event: Stripe.Event,
  context: HandleContext = {},
): Promise<HandleResult> {
  // 1. Claim the event id. The primary key arbitrates between deliveries.
  const claimed = await unsafeDb
    .insert(billingEvents)
    .values({ stripeEventId: event.id, type: event.type, payload: event })
    .onConflictDoNothing()
    .returning({ stripeEventId: billingEvents.stripeEventId });

  if (claimed.length === 0) {
    const existing = await unsafeDb
      .select({
        outcome: billingEvents.outcome,
        resolvedClinicId: billingEvents.resolvedClinicId,
      })
      .from(billingEvents)
      .where(eq(billingEvents.stripeEventId, event.id))
      .limit(1);

    const seen = existing[0];
    if (
      seen &&
      (seen.outcome === "processed" ||
        seen.outcome === "ignored" ||
        seen.outcome === "dead_letter")
    ) {
      return {
        outcome: seen.outcome,
        duplicate: true,
        clinicId: seen.resolvedClinicId,
      };
    }
    // `failed`, or null (a process died mid-event): this delivery is the retry.
  }

  const now = context.now ?? new Date();
  let clinicId: string | null = null;
  try {
    // A const, so the narrowing survives into the withTenant() callback below.
    const type = event.type;
    if (!isHandledEventType(type)) {
      return finish(event.id, "ignored", null, `unhandled type ${type}`);
    }

    // 2. Find the tenant. See the header for what a miss means.
    const object: unknown = event.data.object;
    const ids = stripeIdsOf(type, object);
    clinicId = await clinicIdForStripe(ids.customerId, ids.subscriptionId);
    if (!clinicId) {
      if (hasHealdeskMarker(type, object)) {
        throw new UnresolvedClinicError(event.id);
      }
      return finish(event.id, "ignored", null, "no clinic for stripe ids");
    }

    // 3. What Stripe says now, read before any transaction opens (header).
    const resolved = clinicId;
    const live = await readLive(type, object, resolved, context);
    if ("ignore" in live) return finish(event.id, "ignored", clinicId, live.ignore);

    // 4. Apply it, as a tenant, through the state machine.
    const delivery: Delivery = {
      type,
      eventId: event.id,
      createdAt: typeof event.created === "number" ? new Date(event.created * 1000) : now,
      object,
      ids,
      live,
      now,
    };
    const effects = await withTenant(
      {
        clinicId: resolved,
        actor: STRIPE_WEBHOOK_ACTOR,
        request: { requestId: context.requestId },
      },
      (tx) => dispatch(tx, delivery),
    );

    const result = effects.ignored
      ? await finish(event.id, "ignored", clinicId, effects.ignored)
      : await finish(event.id, "processed", clinicId);
    return effects.critical ? { ...result, criticalNotice: true } : result;
  } catch (error) {
    const failures = await recordFailure(event.id, clinicId, error);
    if (failures >= MAX_FAILURES) {
      // Parked. 200 to Stripe so the endpoint lives; a person replays it, so
      // a person is told. Ids and the type only: the payload stays in the row.
      log.error("billing event dead-lettered", {
        event: event.id,
        type: event.type,
        failures,
      });
      await notifyOps("billing_event_dead_lettered", {
        eventId: event.id,
        type: event.type,
        failures,
        clinicId,
      });
      return { outcome: "dead_letter", duplicate: false, clinicId };
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Ledger
// -----------------------------------------------------------------------------

async function finish(
  eventId: string,
  outcome: "processed" | "ignored",
  clinicId: string | null,
  note?: string,
): Promise<HandleResult> {
  await unsafeDb
    .update(billingEvents)
    .set({
      outcome,
      resolvedClinicId: clinicId,
      processedAt: new Date(),
      error: note ?? null,
    })
    .where(eq(billingEvents.stripeEventId, eventId));
  return { outcome, duplicate: false, clinicId };
}

/**
 * One statement, so the count and the outcome it decides cannot disagree
 * under two concurrent deliveries of the same event.
 */
async function recordFailure(
  eventId: string,
  clinicId: string | null,
  error: unknown,
): Promise<number> {
  const rows = await unsafeDb
    .update(billingEvents)
    .set({
      failures: sql`${billingEvents.failures} + 1`,
      outcome: sql`case when ${billingEvents.failures} + 1 >= ${MAX_FAILURES} then 'dead_letter' else 'failed' end`,
      error: describeError(error),
      resolvedClinicId: clinicId,
      processedAt: new Date(),
    })
    .where(eq(billingEvents.stripeEventId, eventId))
    .returning({ failures: billingEvents.failures });
  return rows[0]?.failures ?? MAX_FAILURES;
}

/** Name and message only, capped. Never the payload. */
function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 1_000);
}

/**
 * Re-run a parked event from its stored payload.
 *
 * The replay tool for the dead-letter queue, and the primitive the
 * self-heal below is built on. The row is reset to "in flight" with a fresh
 * failure count, so a replay gets its own MAX_FAILURES attempts rather than
 * dead-lettering again on the first throw; the reset and the run are separate
 * statements for the same reason the original claim is (see the header).
 * Returns null when the id names no parked event — already processed, or
 * never seen — so a replay cannot re-process something that succeeded.
 */
export async function replayBillingEvent(
  stripeEventId: string,
  context: HandleContext = {},
): Promise<HandleResult | null> {
  const rows = await unsafeDb
    .update(billingEvents)
    .set({ outcome: null, failures: 0, error: null, processedAt: null })
    .where(
      and(
        eq(billingEvents.stripeEventId, stripeEventId),
        inArray(billingEvents.outcome, ["failed", "dead_letter"]),
      ),
    )
    .returning({ payload: billingEvents.payload });

  const row = rows[0];
  if (!row) return null;
  return handleStripeEvent(row.payload as Stripe.Event, context);
}

/**
 * Replay every parked event that names the given Stripe customer or
 * subscription. Called by provisioning once the entitlements row exists, so
 * an `invoice.paid` that beat `checkout.session.completed` to the endpoint
 * and dead-lettered while waiting is applied the moment it can be.
 *
 * Reads the whole parked set (the attention index makes that cheap; it is
 * the dead-letter queue, and it is small or somebody is already looking at
 * it) and matches ids in code with the same reader the handler uses, rather
 * than a JSON-path query that would have to know both API versions' shapes.
 * Errors are logged, never thrown: provisioning has already succeeded and
 * a failed replay is back on the queue with its error recorded.
 */
export async function replayParkedBillingEvents(
  ids: { customerId?: string | null; subscriptionId?: string | null },
  context: HandleContext = {},
): Promise<{ replayed: number; processed: number }> {
  if (!ids.customerId && !ids.subscriptionId) return { replayed: 0, processed: 0 };

  const parked = await unsafeDb
    .select({
      stripeEventId: billingEvents.stripeEventId,
      type: billingEvents.type,
      payload: billingEvents.payload,
    })
    .from(billingEvents)
    .where(
      and(
        inArray(billingEvents.outcome, ["failed", "dead_letter"]),
        isNull(billingEvents.resolvedClinicId),
      ),
    )
    .orderBy(billingEvents.receivedAt);

  let replayed = 0;
  let processed = 0;
  for (const row of parked) {
    if (!isHandledEventType(row.type)) continue;
    const eventIds = stripeIdsOf(row.type, prop(prop(row.payload, "data"), "object"));
    const matches =
      (ids.subscriptionId && eventIds.subscriptionId === ids.subscriptionId) ||
      (ids.customerId && eventIds.customerId === ids.customerId);
    if (!matches) continue;

    replayed += 1;
    try {
      const result = await replayBillingEvent(row.stripeEventId, context);
      if (result?.outcome === "processed") processed += 1;
    } catch (error) {
      log.error("parked billing event replay failed", {
        event: row.stripeEventId,
        type: row.type,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { replayed, processed };
}

// -----------------------------------------------------------------------------
// What Stripe says now (R11), read before the tenant transaction
// -----------------------------------------------------------------------------

type Live = {
  /** invoice.payment_failed and payment_action_required: the invoice as it stands. */
  invoice?: unknown;
  /** charge.refunded: every refund on the charge. */
  refunds?: unknown[];
  /** customer.subscription.updated: the subscription as it stands. */
  subscription?: unknown;
  /** invoice.paid, for a first plan invoice only: the lookup key of its plan line's price. */
  planLookupKey?: string | null;
};

async function readLive(
  type: HandledEventType,
  object: unknown,
  clinicId: string,
  context: HandleContext,
): Promise<Live | { ignore: string }> {
  switch (type) {
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const id = asString(prop(object, "id"));
      if (!id) throw new Error(`A ${type} event carries no invoice id.`);
      const invoice = await getStripe().invoices.retrieve(id, {}, workerRequestOptions());
      const status = asString(prop(invoice, "status"));
      if (status === "void" || status === "paid") return { ignore: `invoice is ${status} now` };
      return { invoice };
    }
    case "charge.refunded": {
      const charge = asString(prop(object, "id"));
      if (!charge) throw new Error("A charge.refunded event carries no charge id.");
      const page = await getStripe().refunds.list({ charge, limit: 100 }, workerRequestOptions());
      return { refunds: page.data };
    }
    case "customer.subscription.updated": {
      const id = asString(prop(object, "id"));
      if (!id) throw new Error("A customer.subscription.updated event carries no subscription id.");
      const subscription = await getStripe().subscriptions.retrieve(id, {}, workerRequestOptions());
      if (asString(prop(subscription, "status")) === "trialing") {
        throw new TrialingSubscriptionError();
      }
      return { subscription };
    }
    case "invoice.paid":
      return { planLookupKey: await firstPlanLookupKey(object, clinicId, context) };
    default:
      return {};
  }
}

/**
 * The lookup key of the price on a FIRST plan invoice's plan line, or null
 * for any other invoice. A webhook line names its price by id alone, and the
 * plan-started email has to name the package Stripe billed, which is the
 * channels in service and need not be the one bought. Reading `plan_code`
 * instead would race the plan-start worker, which writes it in its own
 * transaction after Stripe's update returns, while Stripe is already sending
 * this invoice.paid.
 *
 * Only a deferred-start row whose plan has not started yet asks Stripe, so a
 * renewal never depends on the API: the row is read in a short read-only
 * transaction of its own, which is committed before the call.
 */
async function firstPlanLookupKey(
  invoice: unknown,
  clinicId: string,
  context: HandleContext,
): Promise<string | null> {
  if (asString(prop(invoice, "billing_reason")) === "subscription_create") return null;
  if (!subscriptionOf(invoice)) return null;
  const line = planLine(invoice);
  if (!line) return null;
  const direct = lookupKeyOf(line.raw);
  if (direct) return direct;
  const priceId = priceIdOf(line.raw);
  if (!priceId) return null;

  const beforeStart = await withTenant(
    { clinicId, actor: STRIPE_WEBHOOK_ACTOR, request: { requestId: context.requestId } },
    async (tx) => {
      const row = await getEntitlements(tx.db, tx.clinicId);
      return row !== null && row.boughtPlanId !== null && row.planStartedAt === null;
    },
  );
  if (!beforeStart) return null;

  const cached = cachedLookupKeyForPriceId(priceId);
  if (cached) return cached;
  const price = await getStripe().prices.retrieve(priceId, {}, workerRequestOptions());
  return asString(prop(price, "lookup_key"));
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

type StripeIds = { customerId: string | null; subscriptionId: string | null };

type Delivery = {
  type: HandledEventType;
  eventId: string;
  /** When Stripe recorded the change (`event.created`). */
  createdAt: Date;
  object: unknown;
  ids: StripeIds;
  live: Live;
  now: Date;
};

type Effects = {
  /** A critical notice was queued: the caller delivers it once the transaction commits. */
  critical: boolean;
  /** Set when the delivery turned out to need nothing; recorded as the ledger's note. */
  ignored: string | null;
};

async function dispatch(tx: TenantTx, delivery: Delivery): Promise<Effects> {
  const effects: Effects = { critical: false, ignored: null };
  const { type } = delivery;
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // Provisioning already stored these when apps/web called /api/provision;
      // this is the path for a session forwarded here as well. Status stays
      // `provisioning` — only a paid invoice activates.
      await storeStripeIds(tx.db, tx.clinicId, delivery.ids);
      break;

    case "invoice.paid":
      await onInvoicePaid(tx, delivery, effects);
      break;

    case "invoice.payment_failed":
    case "invoice.payment_action_required":
      await onInvoiceUnpaid(tx, delivery, effects);
      break;

    case "customer.subscription.updated":
      await onSubscriptionUpdated(tx, delivery, effects);
      break;

    case "customer.subscription.deleted":
      await onSubscriptionDeleted(tx, delivery);
      break;

    case "charge.dispute.created":
      await onDispute(tx, delivery.eventId, effects);
      break;

    case "charge.refunded":
      await onChargeRefunded(tx, delivery);
      break;

    default: {
      // Exhaustive: a type added to HANDLED_EVENT_TYPES without a case here
      // fails the typecheck instead of being recorded as processed unread.
      const unhandled: never = type;
      throw new Error(`No handler for ${String(unhandled)}.`);
    }
  }
  return effects;
}

/**
 * A chargeback. Service is withheld until it resolves; support lifts it.
 *
 * Withheld where there is service to withhold, and the clinic is told
 * (`suspended`, critical) with the steps for undoing its call forwarding. The
 * common late dispute — the clinic cancels, then disputes the last charge —
 * lands on a `canceled` or `purged` clinic, and a `paused` one can dispute
 * too. Where the edge to `suspended` exists it is taken; where it does not,
 * or the clinic is already suspended, the dispute is still written into the
 * history as a note, because "why is this clinic suspended" and "did this
 * clinic ever dispute" are both questions support asks, and because the note
 * is what stops a later payment lifting a suspension that a dispute now
 * stands behind (R10, suspendedForNonPayment).
 */
async function onDispute(tx: TenantTx, eventId: string, effects: Effects): Promise<void> {
  const current = await currentStatus(tx);
  const options = { actor: "system", reason: "dispute", stripeEventId: eventId } as const;
  if (current !== "suspended" && canTransition(current, "suspended")) {
    await transition(tx, "suspended", options);
    if (await queueSuspendedNotice(tx, "dispute", eventId)) effects.critical = true;
    return;
  }
  await recordBillingNote(tx, options);
}

/**
 * Transition unless the clinic is already somewhere the event does not need
 * to move it from. Anything else that is not an allowed edge throws out of
 * transition(), which is the intended way an out-of-order event surfaces.
 */
async function moveUnless(
  tx: TenantTx,
  to: BillingStatus,
  alreadyFine: readonly BillingStatus[],
  options: { reason: string; stripeEventId: string },
): Promise<void> {
  const current = await currentStatus(tx);
  if (alreadyFine.includes(current)) return;
  await transition(tx, to, { actor: "system", ...options });
}

async function currentStatus(tx: TenantTx): Promise<BillingStatus> {
  const row = await getEntitlements(tx.db, tx.clinicId);
  if (!row) {
    // getEntitlements returns null rather than throwing so read paths can
    // treat "no billing yet" as a state; here it is an error.
    throw new Error(`No entitlements row for clinic ${tx.clinicId}.`);
  }
  return row.status;
}

/**
 * The row, locked for the rest of the event's transaction. Every handler that
 * decides from the row takes this first, so a concurrent delivery for the
 * same clinic (Stripe sends invoice.paid and customer.subscription.updated for
 * one renewal within the same second) waits and then decides from what the
 * first one committed, not from what it read before.
 */
async function lockedEntitlements(tx: TenantTx): Promise<Entitlements> {
  const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
  if (!row) throw new Error(`No entitlements row for clinic ${tx.clinicId}.`);
  return row;
}

// -----------------------------------------------------------------------------
// invoice.paid (BD7, R9, R10, R34)
// -----------------------------------------------------------------------------

/** One-off invoices whose own email already links Stripe's receipt: no `receipt` for them. */
const INVOICES_WITH_THEIR_OWN_EMAIL: ReadonlySet<string> = new Set([
  "annual_overage",
  "location_setup",
  "plan_change_setup",
]);

/**
 * A paid invoice.
 *
 * Legacy rows keep what they always did (BD31). For a row bought under the
 * deferred start, the invoice is classified by its lines and the row, never
 * by `billing_reason` alone, because the reason cannot tell the $0
 * placeholder's monthly invoice from the first plan invoice, or the swap
 * invoice from a step-up:
 *
 *   - `subscription_create`: the setup fee and the $0 placeholder. It records
 *     the fee and activates, and opens NO window and sends NO email (the
 *     funnel's welcome covers it). An invoice from the checkout used before
 *     the deferred start also carries a plan line, and starts the plan there
 *     and then (R34), still without an email.
 *   - a one-off (`manual`) invoice: the annual overage, the setup fee of a
 *     plan change or an extra location, or anything an operator raised.
 *   - a subscription invoice before the plan has started: with a plan line
 *     it is the FIRST plan invoice, and starts the plan; without one it is
 *     the placeholder's $0 month, and records only that it was paid.
 *   - after the start: a renewal (`subscription_cycle`) moves the window; an
 *     action invoice (`subscription_update`: an annual step-up, a plan change,
 *     an extra location) only pushes `paid_through`, since the action's own
 *     email covers it.
 *
 * Every branch that settles a subscription invoice, and a one-off invoice
 * that was the one the clinic owed, applies R10's status rules
 * (settlePayment).
 */
async function onInvoicePaid(tx: TenantTx, delivery: Delivery, effects: Effects): Promise<void> {
  const invoice = delivery.object;
  const row = await lockedEntitlements(tx);
  const invoiceId = asString(prop(invoice, "id"));

  if (row.boughtPlanId === null) {
    await onLegacyInvoicePaid(tx, delivery.eventId, invoice);
    // Bookkeeping only, which nothing a legacy row shows depends on: the
    // last paid invoice is what makes a late payment_failed for it stale.
    if (invoiceId) await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId });
    return;
  }

  if (!invoiceId) throw new Error("An invoice.paid event carries no invoice id.");
  const reason = asString(prop(invoice, "billing_reason"));

  if (reason === "subscription_create") {
    await onFirstInvoicePaid(tx, delivery, row, invoiceId);
    return;
  }
  if (!isSubscriptionReason(reason)) {
    await onOneOffInvoicePaid(tx, delivery, row, invoiceId);
    return;
  }
  if (row.planStartedAt === null) {
    await onInvoicePaidBeforeStart(tx, delivery, row, invoiceId, effects);
    return;
  }
  await onInvoicePaidAfterStart(tx, delivery, row, invoiceId, reason);
}

/**
 * The checkout's invoice (BD7, R34). The setup fee is recorded gross, from its
 * line: the cohort credit shows in the invoice's discounts, not on the line,
 * and the fee a later plan change is measured against is the list price.
 */
async function onFirstInvoicePaid(
  tx: TenantTx,
  delivery: Delivery,
  row: Entitlements,
  invoiceId: string,
): Promise<void> {
  const invoice = delivery.object;
  await recordSetupFeePaid(tx.db, tx.clinicId, {
    usd: setupFeeUsd(invoice),
    at: paidAtOf(invoice, delivery.now),
  });
  if (row.status === "provisioning") {
    // This is the moment the clinic has actually paid, which is why
    // activation happens here and not at checkout completion.
    await transition(tx, "active", {
      actor: "system",
      reason: "invoice.paid",
      stripeEventId: delivery.eventId,
    });
  }

  // R34: the checkout before the deferred start billed the package at once,
  // so its first invoice carries a plan line above $0 beside the setup fee.
  // That purchase started its plan when it paid; recording it as started
  // (and as applied, R8) is what keeps the plan-start worker and the gate
  // from treating it as a clinic still waiting for its first answer. The
  // welcome email covers it, so no plan_started.
  const line = planLine(invoice);
  if (line && row.planStartedAt === null) {
    await startPlanFromLine(tx, invoiceId, line, { appliedAt: line.period.start });
  }
  await recordInvoicePaid(tx.db, tx.clinicId, {
    invoiceId,
    paidThrough: line ? line.period.end : null,
  });
}

/**
 * A one-off invoice (BD7 `manual`). The annual overage's row is marked; the
 * setup fee of a plan change or an extra location has its action's email.
 * R10's status rules apply only when this was the invoice the clinic owed:
 * paying a setup-fee difference while a renewal sits unpaid settles nothing.
 */
async function onOneOffInvoicePaid(
  tx: TenantTx,
  delivery: Delivery,
  row: Entitlements,
  invoiceId: string,
): Promise<void> {
  const invoice = delivery.object;
  const hdKind = hdKindOf(invoice);
  const amountPaid = amountPaidOf(invoice);
  const wasOwed = row.openInvoiceId !== null && row.openInvoiceId === invoiceId;

  if (hdKind === "annual_overage") {
    await markOverageInvoicePaid(tx, invoice, invoiceId, paidAtOf(invoice, delivery.now));
  }
  await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId });

  const { restored } = wasOwed
    ? await settlePayment(tx, row, invoiceId, amountPaid, delivery.eventId)
    : { restored: false };
  if (restored) {
    await queueRestored(tx, invoiceId, invoice);
    return;
  }
  if (amountPaid > 0 && !(hdKind && INVOICES_WITH_THEIR_OWN_EMAIL.has(hdKind))) {
    await enqueueNotice(tx, "receipt", invoiceId, receiptPayload(invoice, amountPaid, null));
  }
}

/**
 * A subscription invoice before the plan has started (BD7). With a plan line
 * it is the first plan invoice: the plan starts on that line's period, the
 * first allowance window opens from it (counters from zero: usage before it
 * was never counted against anything, BD6), `paid_through` is its end, its id
 * is kept for the refunds (R9), and the clinic is told (`plan_started`,
 * critical). Without one it is the $0 placeholder's month, which bought
 * nothing: it records that it was paid and nothing else, so it opens no
 * window, moves no counter, sets no `paid_through` the renewal reminder could
 * fire on, and emails nobody (R37).
 */
async function onInvoicePaidBeforeStart(
  tx: TenantTx,
  delivery: Delivery,
  row: Entitlements,
  invoiceId: string,
  effects: Effects,
): Promise<void> {
  const invoice = delivery.object;
  const line = planLine(invoice);
  if (!line) {
    await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId });
    return;
  }

  await startPlanFromLine(tx, invoiceId, line, {});
  await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId, paidThrough: line.period.end });
  const { restored } = await settlePayment(
    tx,
    row,
    invoiceId,
    amountPaidOf(invoice),
    delivery.eventId,
  );
  if (restored) await queueRestored(tx, invoiceId, invoice);

  const payload = await planStartedPayload(tx, row, invoice, line, delivery.live.planLookupKey);
  if (payload && (await enqueueNotice(tx, "plan_started", "plan_started", payload))) {
    effects.critical = true;
  }
}

/**
 * A subscription invoice once the plan has started (BD7). A renewal resets
 * the counters from its period and pushes `paid_through`; it gets a receipt
 * unless the payment lifted a suspension, when `restored` goes instead and
 * carries the receipt link. An action invoice (an annual step-up, a plan
 * change, an extra location) pushes `paid_through` only as far as its lines
 * reach and never resets the window: the action's own email covers it, so no
 * receipt. Anything else Stripe bills on the subscription (a usage threshold
 * invoice) is receipted.
 */
async function onInvoicePaidAfterStart(
  tx: TenantTx,
  delivery: Delivery,
  row: Entitlements,
  invoiceId: string,
  reason: string | null,
): Promise<void> {
  const invoice = delivery.object;
  const amountPaid = amountPaidOf(invoice);
  const lines = recurringPeriod(invoice);

  if (reason === "subscription_cycle") {
    const period = invoicePeriod(invoice);
    await resetUsage(tx.db, tx.clinicId, period.start, period.end);
    await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId, paidThrough: period.end });
  } else if (reason === "subscription_update") {
    await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId, paidThrough: lines?.end ?? null });
  } else {
    await recordInvoicePaid(tx.db, tx.clinicId, { invoiceId });
  }

  const { restored } = await settlePayment(tx, row, invoiceId, amountPaid, delivery.eventId);
  if (restored) {
    await queueRestored(tx, invoiceId, invoice);
    return;
  }
  if (reason !== "subscription_update" && amountPaid > 0) {
    await enqueueNotice(tx, "receipt", invoiceId, receiptPayload(invoice, amountPaid, lines));
  }
}

/**
 * The first plan invoice's facts, written once (BD7, R9): the paid start,
 * the first allowance window (from the invoiced period through
 * `allowanceWindow`, so an annual plan's first month), and the invoice's id.
 * `appliedAt` is for R34's old-checkout purchase, whose plan was applied by
 * the checkout itself rather than by the plan-start worker.
 */
async function startPlanFromLine(
  tx: TenantTx,
  invoiceId: string,
  line: PlanLine,
  options: { appliedAt?: Date },
): Promise<void> {
  await markPlanStarted(tx.db, tx.clinicId, line.period.start);
  await openAllowanceWindow(tx.db, tx.clinicId, line.period);
  await markFirstPlanInvoice(tx.db, tx.clinicId, invoiceId);
  if (options.appliedAt) await markPlanStartApplied(tx.db, tx.clinicId, options.appliedAt);
}

/** Suspensions that a payment can lift (R10): the ones that were for not paying. */
const NON_PAYMENT_SUSPENSIONS: ReadonlySet<string> = new Set([
  "grace_expired",
  "subscription_unpaid",
]);

/**
 * R10's status rules for a paid invoice that settles what the clinic owed.
 * Grace ends, and `past_due` returns to `active` (so does `provisioning`, the
 * self-heal for a first invoice that never arrived). `suspended` returns to
 * `active` only when every one of these holds, because a suspension is also
 * how a chargeback and an operator withhold service, and paying an invoice
 * must not override either:
 *
 *   - money moved (a $0 invoice proves nothing about the card);
 *   - this invoice is the one recorded as owed, or none is recorded;
 *   - the clinic was suspended for not paying, and no dispute has been
 *     recorded since (suspendedForNonPayment).
 *
 * A clinic suspended out of `canceling` (R21) goes back to `canceling` when a
 * cancellation is still scheduled, so the scheduled end and the Billing
 * screen survive the round trip and the next subscription update has nothing
 * to move (and no second cancellation email to send).
 *
 * `row` is the row as locked at the start of the event, before this event
 * cleared the open invoice.
 */
async function settlePayment(
  tx: TenantTx,
  row: Entitlements,
  invoiceId: string,
  amountPaid: number,
  eventId: string,
): Promise<{ restored: boolean }> {
  if (row.graceEndsAt !== null) await setGrace(tx.db, tx.clinicId, null);

  const paidUp = { actor: "system", reason: "invoice.paid", stripeEventId: eventId } as const;
  const status = await currentStatus(tx);
  if (status === "past_due" || status === "provisioning") {
    await transition(tx, "active", paidUp);
    return { restored: false };
  }
  if (status !== "suspended" || amountPaid <= 0) return { restored: false };
  if (row.openInvoiceId !== null && row.openInvoiceId !== invoiceId) return { restored: false };
  if (!(await suspendedForNonPayment(tx))) return { restored: false };

  await transition(tx, "active", paidUp);
  if (row.cancelAt !== null) {
    await transition(tx, "canceling", {
      actor: "system",
      reason: "cancel_at_period_end",
      stripeEventId: eventId,
    });
  }
  return { restored: true };
}

/**
 * Whether the clinic's current suspension was for not paying: the last move
 * INTO `suspended` (a note has from = to and is not a move) had a non-payment
 * cause, and no dispute has been written into the history since it. A dispute
 * on a clinic already suspended is recorded as a note for exactly this reason
 * (onDispute).
 */
async function suspendedForNonPayment(tx: TenantTx): Promise<boolean> {
  const [last] = await tx.db
    .select({ reason: billingTransitions.reason, createdAt: billingTransitions.createdAt })
    .from(billingTransitions)
    .where(
      and(
        eq(billingTransitions.clinicId, tx.clinicId),
        eq(billingTransitions.toStatus, "suspended"),
        or(isNull(billingTransitions.fromStatus), ne(billingTransitions.fromStatus, "suspended")),
      ),
    )
    .orderBy(desc(billingTransitions.createdAt))
    .limit(1);
  if (!last || !NON_PAYMENT_SUSPENSIONS.has(last.reason)) return false;

  const [dispute] = await tx.db
    .select({ id: billingTransitions.id })
    .from(billingTransitions)
    .where(
      and(
        eq(billingTransitions.clinicId, tx.clinicId),
        eq(billingTransitions.reason, "dispute"),
        gte(billingTransitions.createdAt, last.createdAt),
      ),
    )
    .limit(1);
  return !dispute;
}

/** `restored` (R10, R22), carrying the receipt link instead of a separate receipt. */
async function queueRestored(tx: TenantTx, invoiceId: string, invoice: unknown): Promise<void> {
  await enqueueNotice(tx, "restored", `restored:${invoiceId}`, {
    receiptUrl: emailLink(asString(prop(invoice, "hosted_invoice_url")), "restored"),
  });
}

/**
 * The plan-started email (L2). The package named is the one Stripe billed
 * (the channels in service), from the plan line's price; `plan_code` only
 * when the price could not be read. Returns null, and the email is skipped
 * with a warning, when neither names a package in the catalog: a wrong
 * package name in a critical email is worse than none, and the plan still
 * starts.
 */
async function planStartedPayload(
  tx: TenantTx,
  row: Entitlements,
  invoice: unknown,
  line: PlanLine,
  lookupKey: string | null | undefined,
): Promise<NoticePayloads["plan_started"] | null> {
  const parsed = lookupKey ? parseLookupKey(lookupKey) : null;
  const fromPrice = parsed && parsed.kind !== "setup" ? getPlan(parsed.planId) : undefined;
  const billed = fromPrice ?? getPlan(row.planCode);
  if (!billed || !row.boughtPlanId) {
    log.warn("plan_started not queued: no catalog package for the billed price", {
      clinicId: row.clinicId,
    });
    return null;
  }
  const interval: BillingInterval =
    fromPrice && parsed && parsed.kind !== "setup" ? parsed.kind : row.billingInterval;
  return {
    planName: billed.name,
    boughtPlanId: row.boughtPlanId,
    channel: await firstAnsweredChannel(tx, billed),
    amountCents: asNumber(prop(invoice, "amount_paid")) ?? line.amount,
    interval,
    periodEndsOn: isoDay(line.period.end),
    receiptUrl: emailLink(asString(prop(invoice, "hosted_invoice_url")), "plan_started"),
    isBilledByChannelsInService: billed.id !== row.boughtPlanId,
  };
}

/**
 * The channel whose first answer started the plan: the billing clinic's
 * earliest `first_answer_at`, else the billed package's only channel. A
 * location's channels sit in another tenant and are not read here; until
 * locations exist (LOCATION_CLINICS_READY) every first answer is the billing
 * clinic's own. Null when neither says, and the email names no channel.
 */
async function firstAnsweredChannel(tx: TenantTx, billed: Plan): Promise<Channel | null> {
  const [first] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), isNotNull(clinicChannels.firstAnswerAt)))
    .orderBy(clinicChannels.firstAnswerAt)
    .limit(1);
  if (first) return first.channel;
  const channels = channelList(billed);
  return channels.length === 1 ? channels[0]! : null;
}

/**
 * The annual overage invoice was paid (BD7): its overage_invoices row is
 * `invoiced`, with the invoice id, whatever the overage job managed to record
 * before Stripe answered. Found by the invoice id, else by the `hd_ref`
 * the job stamps on it (`<clinicId>:<windowStart>`, R17), which is how a run
 * that died between Stripe's answer and its own write is still matched.
 */
async function markOverageInvoicePaid(
  tx: TenantTx,
  invoice: unknown,
  invoiceId: string,
  paidAt: Date,
): Promise<void> {
  const values = {
    status: "invoiced" as const,
    stripeInvoiceId: invoiceId,
    invoicedAt: sql`coalesce(${overageInvoices.invoicedAt}, ${paidAt}::timestamptz)`,
  };
  const byId = await tx.db
    .update(overageInvoices)
    .set(values)
    .where(
      and(
        eq(overageInvoices.clinicId, tx.clinicId),
        eq(overageInvoices.stripeInvoiceId, invoiceId),
      ),
    )
    .returning({ id: overageInvoices.id });
  if (byId.length > 0) return;

  const windowStart = overageWindowOf(invoice, tx.clinicId);
  if (!windowStart) return;
  await tx.db
    .update(overageInvoices)
    .set(values)
    .where(
      and(
        eq(overageInvoices.clinicId, tx.clinicId),
        eq(overageInvoices.windowStart, windowStart),
        inArray(overageInvoices.status, ["pending", "failed", "invoiced"]),
        or(isNull(overageInvoices.stripeInvoiceId), eq(overageInvoices.stripeInvoiceId, invoiceId)),
      ),
    );
}

/** The window an annual overage invoice's `hd_ref` names, when it names this clinic. */
function overageWindowOf(invoice: unknown, clinicId: string): Date | null {
  const ref = asString(prop(prop(invoice, "metadata"), "hd_ref"));
  if (!ref) return null;
  const at = ref.indexOf(":");
  if (at < 0 || ref.slice(0, at) !== clinicId) return null;
  const when = new Date(ref.slice(at + 1));
  return Number.isNaN(when.getTime()) ? null : when;
}

function receiptPayload(
  invoice: unknown,
  amountPaid: number,
  period: { start: Date; end: Date } | null,
): NoticePayloads["receipt"] {
  return {
    amountCents: amountPaid,
    hostedInvoiceUrl: emailLink(asString(prop(invoice, "hosted_invoice_url")), "receipt"),
    periodStartsOn: period ? isoDay(period.start) : null,
    periodEndsOn: period ? isoDay(period.end) : null,
  };
}

/** What a legacy row (no bought package, BD31) has always done with a paid invoice. */
async function onLegacyInvoicePaid(
  tx: TenantTx,
  eventId: string,
  invoice: unknown,
): Promise<void> {
  const billingReason = asString(prop(invoice, "billing_reason"));
  const period = invoicePeriod(invoice);

  if (billingReason === "subscription_create") {
    // The first invoice: recurring period plus the setup fee. This is the
    // moment the clinic has actually paid, which is why activation happens
    // here and not at checkout completion.
    await recordFirstInvoice(tx.db, tx.clinicId, {
      periodStart: period.start,
      periodEnd: period.end,
      setupFeePaidUsd: setupFeeUsd(invoice),
    });
    if ((await currentStatus(tx)) === "provisioning") {
      await transition(tx, "active", {
        actor: "system",
        reason: "invoice.paid",
        stripeEventId: eventId,
      });
    }
    return;
  }

  if (
    billingReason === "subscription_cycle" ||
    billingReason === "subscription_update"
  ) {
    // A renewal, or the proration invoice for a mid-period plan change. Either
    // way a new allowance starts now (see entitlements.ts on why a plan change
    // gets the full allowance rather than a prorated one).
    await resetUsage(tx.db, tx.clinicId, period.start, period.end);
    await setGrace(tx.db, tx.clinicId, null);

    // `provisioning` is in the list so a first invoice that was lost outright
    // — never delivered, or dead-lettered and never replayed — cannot strand
    // the clinic past its first renewal: a paid renewal is proof of payment.
    const status = await currentStatus(tx);
    if (status === "past_due" || status === "suspended" || status === "provisioning") {
      await transition(tx, "active", {
        actor: "system",
        reason: "invoice.paid",
        stripeEventId: eventId,
      });
    }
    return;
  }

  // `manual`, `subscription_threshold` (a metered overage bill mid-period),
  // anything Stripe adds later: money moved, nothing about the allowance did.
}

// -----------------------------------------------------------------------------
// invoice.payment_failed and invoice.payment_action_required (R11)
// -----------------------------------------------------------------------------

/**
 * An invoice the clinic has not paid: the card was declined, or the bank
 * wants the clinic to confirm the payment (3-D Secure). Read from the LIVE
 * invoice (readLive has already ignored one that is void or paid by now).
 *
 * Also ignored: the invoice recorded as the last one paid (a failure that
 * arrives after the payment). Recorded as a note only, with no dunning: a
 * clinic that has left (Stripe stopped collecting when the subscription
 * ended), and the setup fee of a plan change or an extra location, whose
 * failed invoice the action voids before refusing, so nothing is owed.
 *
 * Otherwise the invoice is recorded as the one owed, with Stripe's pay page,
 * and the clinic is told at once (critical). A failed payment also moves
 * `active` to `past_due` and opens the grace window, once: Stripe's smart
 * retries send one of these per attempt, spread over weeks, and a grace
 * period that re-opened on every retry would never close. The email for each
 * invoice goes once whatever the retries (dedupe on the invoice id).
 * `isFirstPlanCharge` tells the clinic nothing had started yet: the plan's
 * paid start (`plan_started_at`) is still unset and this invoice carries a
 * plan line. It is deliberately not R8's "started": the worker marks the plan
 * applied the moment Stripe accepts the swap, which is usually before this
 * failure arrives.
 */
async function onInvoiceUnpaid(tx: TenantTx, delivery: Delivery, effects: Effects): Promise<void> {
  const failed = delivery.type === "invoice.payment_failed";
  const invoice = delivery.live.invoice ?? delivery.object;
  const invoiceId = asString(prop(invoice, "id")) ?? asString(prop(delivery.object, "id"));
  if (!invoiceId) throw new Error(`A ${delivery.type} event carries no invoice id.`);

  const row = await lockedEntitlements(tx);
  if (invoiceId === row.lastPaidInvoiceId) {
    effects.ignored = "invoice already paid";
    return;
  }

  const note = {
    actor: "system",
    reason: failed ? "invoice.payment_failed" : "authentication_required",
    stripeEventId: delivery.eventId,
  } as const;
  const hdKind = hdKindOf(invoice);
  if (
    row.status === "canceled" ||
    row.status === "purged" ||
    hdKind === "plan_change_setup" ||
    hdKind === "location_setup"
  ) {
    await recordBillingNote(tx, note);
    return;
  }

  const amountDueCents = asNumber(prop(invoice, "amount_due")) ?? 0;
  const hostedUrl = asString(prop(invoice, "hosted_invoice_url"));
  await recordOpenInvoice(tx.db, tx.clinicId, { invoiceId, url: hostedUrl, amountDueCents });

  if (!failed) {
    // Not a failure yet, so the status stays; the note is the history's
    // record and the email is the clinic's prompt to confirm.
    await recordBillingNote(tx, note);
    const queued = await enqueueNotice(tx, "payment_action_required", invoiceId, {
      amountDueCents,
      hostedInvoiceUrl: emailLink(hostedUrl, "payment_action_required"),
    });
    if (queued) effects.critical = true;
    return;
  }

  let status = row.status;
  if (status === "active") {
    await transition(tx, "past_due", {
      actor: "system",
      reason: "invoice.payment_failed",
      stripeEventId: delivery.eventId,
    });
    status = "past_due";
  }
  let grace = row.graceEndsAt;
  if (!grace) {
    grace = new Date(delivery.now.getTime() + GRACE_DAYS * DAY_MS);
    await setGrace(tx.db, tx.clinicId, grace);
  }
  // The date service stops, only while it is still ahead: a suspended
  // clinic's next failed invoice has no grace left to promise.
  const graceRuns =
    (status === "past_due" || status === "canceling") &&
    grace.getTime() > delivery.now.getTime();
  const queued = await enqueueNotice(tx, "payment_failed", invoiceId, {
    amountDueCents,
    hostedInvoiceUrl: emailLink(hostedUrl, "payment_failed"),
    graceEndsAt: graceRuns ? grace.toISOString() : null,
    isFirstPlanCharge: row.planStartedAt === null && planLine(invoice) !== null,
  });
  if (queued) effects.critical = true;
}

// -----------------------------------------------------------------------------
// Subscriptions (BD8, BD10, R11, R12, R21)
// -----------------------------------------------------------------------------

/**
 * The subscription changed. Applied from the LIVE subscription (readLive), so
 * the order deliveries arrive in stops mattering (header).
 *
 * First the snapshots, which keep entitlements in step with Stripe whatever
 * changed it (BD8): the package Stripe bills (`plan_code` and the allowances;
 * `channels_enabled` moves with it only on a legacy row, because on a
 * deferred-start row it follows the package BOUGHT), the metered items' lookup
 * keys, the locations (the package item's quantity, never the $0
 * placeholder's) and the scheduled end (`cancel_at`, or the item period end
 * under `cancel_at_period_end`).
 *
 * Then three fields map to a status, read in the order of how final they
 * are. `status` is tracked locally across the steps so a single update that
 * clears a pause AND schedules a cancellation walks paused → active →
 * canceling in one delivery.
 */
async function onSubscriptionUpdated(
  tx: TenantTx,
  delivery: Delivery,
  effects: Effects,
): Promise<void> {
  const { eventId } = delivery;
  await storeStripeIds(tx.db, tx.clinicId, delivery.ids);

  const subscription = delivery.live.subscription ?? delivery.object;
  const stripeStatus = asString(prop(subscription, "status"));
  // Ended since the event was sent: customer.subscription.deleted owns the
  // end, and walking a finished subscription's last flags (a cancellation
  // that has already happened) would only email the clinic about the past.
  if (stripeStatus === "canceled" || stripeStatus === "incomplete_expired") return;

  const row = await lockedEntitlements(tx);
  if (await newerUpdateApplied(tx, delivery)) {
    effects.ignored = "a newer subscription update was applied";
    return;
  }

  const priced = packageItemOf(subscription);
  if (priced) {
    const { changed } = await applyBilledPlan(tx.db, tx.clinicId, priced.plan, priced.interval);
    if (changed) {
      await recordBillingNote(tx, {
        actor: "system",
        reason: "plan_change",
        stripeEventId: eventId,
      });
      tx.audit.record({
        action: "update",
        resourceType: "entitlements",
        resourceId: tx.clinicId,
        metadata: {
          field: "plan",
          planCode: priced.plan.id,
          interval: priced.interval,
        },
      });
    }
    if (priced.quantity !== null && priced.quantity !== row.locations) {
      await setLocations(tx.db, tx.clinicId, priced.quantity);
    }
  }

  const meteredKeys = meteredLookupKeys(subscription);
  if (meteredKeys.join(",") !== [...row.meteredPriceKeys].sort().join(",")) {
    await setMeteredPriceKeys(tx.db, tx.clinicId, meteredKeys);
  }

  const cancellation = scheduledCancellation(subscription);
  const endsAt = cancellation.scheduled ? (cancellation.at ?? row.paidThrough) : null;
  if ((endsAt?.getTime() ?? null) !== (row.cancelAt?.getTime() ?? null)) {
    await setCancelAt(tx.db, tx.clinicId, endsAt);
  }

  let status = row.status;
  const move = async (to: BillingStatus, actor: BillingActor, reason: string) => {
    await transition(tx, to, { actor, reason, stripeEventId: eventId });
    status = to;
  };

  // `unpaid`: Stripe exhausted its retries and, with the Dashboard set to
  // "do not cancel", parked the subscription. Invoices are still created and
  // immediately closed, so nothing further will ever arrive to move the
  // clinic — this is the terminal signal of a failed renewal, and it means
  // suspended whether or not the sweep's grace window has run out yet. A
  // clinic serving out a cancelled period is no exception (R21).
  if (
    stripeStatus === "unpaid" &&
    (status === "active" || status === "past_due" || status === "canceling")
  ) {
    await move("suspended", "system", "subscription_unpaid");
    if (await queueSuspendedNotice(tx, "unpaid", eventId)) effects.critical = true;
  }

  // `pause_collection` is the only pause that can happen here (see the
  // header). Non-null while collection is paused; cleared on resume. Both
  // directions are the clinic's own act through the portal, or support's on
  // their behalf, hence the actor.
  const collectionPaused = isObject(prop(subscription, "pause_collection"));
  if (collectionPaused && (status === "active" || status === "past_due")) {
    await move("paused", "client", "pause_collection");
  } else if (!collectionPaused && status === "paused") {
    await move("active", "client", "pause_collection_cleared");
  }

  // A scheduled end is `cancel_at_period_end` (what auto-renew Off sets,
  // BD10) or a dated `cancel_at` (what a flexible-mode subscription gets from
  // the portal or the Dashboard): either is "cancellation scheduled", and it
  // can be undone right up to the end — hence the reversal edge. Each move
  // emails the clinic once per event (E1), worded for before the plan has
  // started when it has not (R8).
  if (cancellation.scheduled && (status === "active" || status === "past_due")) {
    await move("canceling", "client", "cancel_at_period_end");
    await enqueueNotice(
      tx,
      "cancel_scheduled",
      eventId,
      cancelScheduledPayload(row, endsAt ?? delivery.now, delivery.createdAt),
    );
  } else if (!cancellation.scheduled && status === "canceling") {
    await move("active", "client", "cancel_reversed");
    await enqueueNotice(tx, "cancel_reversed", eventId, { isBeforeStart: !hasPlanStarted(row) });
  }
}

/**
 * Whether a NEWER customer.subscription.updated for this clinic has already
 * been applied (§5's stale-event guard, beside R11's live read). Asked under
 * the row lock, so the answer cannot change before this event commits.
 *
 * The live read alone leaves one gap: it is taken before the transaction, so
 * two deliveries processed at once can commit in the opposite order to their
 * reads. Auto-renew turned off and straight back on: the first event reads
 * "scheduled", the second reads "reversed" and commits, and the first would
 * then commit "scheduled" over it, with no further event ever coming to put
 * it right. Skipping an event older than one already applied closes that,
 * and loses nothing: the newer event applied what Stripe held when it was
 * processed, which already includes this older change, and anything changed
 * since has an event of its own on the way. Nothing new is stored: the
 * ledger keeps each event's payload, and its `created` is the comparison.
 */
async function newerUpdateApplied(tx: TenantTx, delivery: Delivery): Promise<boolean> {
  const created = Math.floor(delivery.createdAt.getTime() / 1000);
  const [newer] = await tx.db
    .select({ id: billingEvents.stripeEventId })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.resolvedClinicId, tx.clinicId),
        eq(billingEvents.type, "customer.subscription.updated"),
        eq(billingEvents.outcome, "processed"),
        ne(billingEvents.stripeEventId, delivery.eventId),
        sql`(${billingEvents.payload} ->> 'created')::bigint > ${created}`,
      ),
    )
    .limit(1);
  return newer !== undefined;
}

/**
 * E1's facts. Before the plan has started the account closes at the earlier
 * of the scheduled end and the setup deadline (BD10), and the email says so.
 * After the start, inside the first-period refund window and with nothing
 * refunded yet, it carries the window's last day, so the email can say a
 * refund is due and the team will be in touch (R15, R31).
 */
function cancelScheduledPayload(
  row: Entitlements,
  endsAt: Date,
  scheduledAt: Date,
): NoticePayloads["cancel_scheduled"] {
  const started = hasPlanStarted(row);
  const closes =
    !started && row.setupDeadlineAt && row.setupDeadlineAt.getTime() < endsAt.getTime()
      ? row.setupDeadlineAt
      : endsAt;
  let refundWindowEndsOn: string | null = null;
  if (started && row.planStartedAt && !row.firstPeriodRefundedAt) {
    const windowEnd = new Date(row.planStartedAt.getTime() + FIRST_PERIOD_REFUND_DAYS * DAY_MS);
    if (scheduledAt.getTime() < windowEnd.getTime()) refundWindowEndsOn = isoDay(windowEnd);
  }
  return { endsAt: closes.toISOString(), isBeforeStart: !started, refundWindowEndsOn };
}

/**
 * The subscription ended: `canceled`, and the return-or-destroy clock
 * starts (lib/offboarding).
 *
 * Our own setup-window closure (R12) is told apart by the comment its worker
 * passes to `subscriptions.cancel`: it sends no `canceled` email, and starts
 * offboarding with the reason `setup_closure`, which the funnel's closure
 * email keys on. Every other end emails the clinic (E2, dedupe on the
 * subscription) with how long calls still pass through, how to undo its call
 * forwarding, and when its data goes.
 */
async function onSubscriptionDeleted(tx: TenantTx, delivery: Delivery): Promise<void> {
  const subscription = delivery.object;
  const row = await lockedEntitlements(tx);
  await moveUnless(tx, "canceled", ["canceled", "purged"], {
    reason: delivery.type,
    stripeEventId: delivery.eventId,
  });

  const comment = asString(prop(prop(subscription, "cancellation_details"), "comment"));
  if (comment === SETUP_CLOSURE_COMMENT) {
    await startOffboarding(tx, "setup_closure", delivery.now);
    return;
  }

  // The customer left: start the return-or-destroy clock (lib/offboarding).
  await startOffboarding(tx, delivery.type, delivery.now);
  // A clinic already destroyed has nobody left to tell.
  if (row.status === "purged") return;
  const subscriptionId = asString(prop(subscription, "id")) ?? delivery.ids.subscriptionId;
  if (!subscriptionId) return;
  await enqueueNotice(
    tx,
    "canceled",
    subscriptionId,
    await canceledPayload(tx, row, subscription, delivery.now),
  );
}

/**
 * E2's facts (R31). The two data dates follow dueForDestruction's rule
 * (lib/offboarding): the data may go `destroy_after` (30 days after the end)
 * once the export has been delivered, and goes 90 days after the end if it
 * never is. So `exportByOn` is the first of those, the day to have the export
 * by, and `destroyByOn` the second, the day the data is gone whatever
 * happens; each is true in both cases, which a single date would not be.
 */
async function canceledPayload(
  tx: TenantTx,
  row: Entitlements,
  subscription: unknown,
  now: Date,
): Promise<NoticePayloads["canceled"]> {
  const clinic = await ownClinic(tx);
  const endedAt =
    unixDate(prop(subscription, "ended_at")) ?? unixDate(prop(subscription, "canceled_at")) ?? now;
  const offboardingFrom = clinic?.offboardingStartedAt ?? now;
  return {
    passThroughDays: FORWARDING_PASS_THROUGH_DAYS,
    endedAt: endedAt.toISOString(),
    isBeforeStart: !hasPlanStarted(row),
    channels: CHANNELS.filter((channel) => row.channelsEnabled[channel]),
    exportByOn: isoDay(clinic?.destroyAfter ?? addDays(offboardingFrom, DESTROY_AFTER_DAYS)),
    destroyByOn: isoDay(addDays(offboardingFrom, DESTROY_WITHOUT_EXPORT_AFTER_DAYS)),
    ...forwardingFactsOf(clinic),
  };
}

export type SuspensionCause = "grace_expired" | "unpaid" | "dispute" | "ops";

/**
 * Queue `suspended` for a move to suspended made in `tx` (R11), on the
 * billing clinic, deduplicated per cause and what caused it (R22:
 * `<cause>:<eventId | graceEndsAtIso>`). Critical: the caller makes sure it
 * is delivered after the commit. It carries the invoice owed and its pay page
 * when one is recorded, and the facts the template needs to print the steps
 * for undoing call forwarding (R31). Exported for the billing sweep, whose
 * grace expiry is the other way a clinic is suspended.
 */
export async function queueSuspendedNotice(
  tx: TenantTx,
  cause: SuspensionCause,
  ref: string,
): Promise<boolean> {
  const row = await getEntitlements(tx.db, tx.clinicId);
  const clinic = await ownClinic(tx);
  return enqueueNotice(tx, "suspended", `${cause}:${ref}`, {
    hostedInvoiceUrl: emailLink(row?.openInvoiceUrl ?? null, "suspended"),
    amountDueCents: row?.openInvoiceAmountCents ?? null,
    ...forwardingFactsOf(clinic),
  });
}

async function ownClinic(tx: TenantTx): Promise<typeof clinics.$inferSelect | undefined> {
  const [clinic] = await tx.db.select().from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  return clinic;
}

/**
 * How the clinic's calls reach us, as catalog ids (R31): the carrier, when it
 * was collected and is one the catalog knows (else null, and the template
 * keeps its "ask your carrier" branch), the phone system, and the coverage
 * mode through `coverageModeOf`, the one accessor the funnel switches to
 * `clinic_settings.coverage_mode` when that column lands. The billing
 * clinic's own line; a location's are not read from the billing tenant.
 */
function forwardingFactsOf(clinic: typeof clinics.$inferSelect | undefined): ForwardingFacts {
  if (!clinic) return { carrier: null, phoneSystem: "unknown", routing: "overflow_after_hours" };
  return {
    carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
    phoneSystem: clinic.phoneSystemType,
    routing: coverageModeOf(clinic),
  };
}

// -----------------------------------------------------------------------------
// charge.refunded (R11)
// -----------------------------------------------------------------------------

/**
 * A charge was refunded, by our own refund action or by hand in the
 * Dashboard. Every refund on the charge that went through queues
 * `refund_issued`, once per refund (`refund:<refundId>`, R22), so a partial
 * refund delivered again, or the action's own notice for the same refund,
 * emails once. The kind is the one our action stamped (`hd_kind`), else
 * `other`. A failed or cancelled refund moved no money and tells nobody.
 */
async function onChargeRefunded(tx: TenantTx, delivery: Delivery): Promise<void> {
  for (const refund of delivery.live.refunds ?? []) {
    const id = asString(prop(refund, "id"));
    const amount = asNumber(prop(refund, "amount"));
    const status = asString(prop(refund, "status"));
    if (!id || amount === null || amount <= 0) continue;
    if (status !== "succeeded" && status !== "pending") continue;
    const kindStamped = asString(prop(prop(refund, "metadata"), "hd_kind"));
    await enqueueNotice(tx, "refund_issued", `refund:${id}`, {
      amountCents: amount,
      kind:
        kindStamped === "first_period_cancel" || kindStamped === "guarantee"
          ? kindStamped
          : "other",
      refundedAt: (unixDate(prop(refund, "created")) ?? delivery.now).toISOString(),
    });
  }
  // In the history, so "was this clinic ever refunded" has an answer beside
  // every other billing question.
  await recordBillingNote(tx, {
    actor: "system",
    reason: "charge_refunded",
    stripeEventId: delivery.eventId,
  });
}

// -----------------------------------------------------------------------------
// Reading Stripe objects
//
// Deliberately structural rather than typed against the SDK's object types.
// The shape of a webhook payload follows the API version pinned on the
// ENDPOINT in the Dashboard, not the SDK apps/web installed, and the fields
// this module needs moved between versions: an invoice's subscription went
// from `invoice.subscription` to `invoice.parent.subscription_details`, and a
// line's price from `line.price` to `line.pricing.price_details.price`. Each
// reader below accepts both, so a version bump on the endpoint cannot silently
// turn every renewal into a no-op.
// -----------------------------------------------------------------------------

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Stripe references are an id string, or the expanded object carrying one. */
function refId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return asString(prop(value, "id"));
}

/** A Stripe timestamp (Unix seconds), or null. */
function unixDate(value: unknown): Date | null {
  const seconds = asNumber(value);
  return seconds === null ? null : new Date(seconds * 1000);
}

/** The UTC calendar date, YYYY-MM-DD: what every `…On` payload field carries. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function metadataApp(value: unknown): string | null {
  return asString(prop(prop(value, "metadata"), "app"));
}

/**
 * A Stripe-hosted link for an email, or null when the email's link scanner
 * would refuse it (an origin off its allowlist), which would kill the whole
 * notice at send time. The pay page is in the Billing screen either way;
 * losing the link is better than losing the email. Exported for the billing
 * sweep's notices.
 */
export function emailLink(url: string | null, kind: NoticeKind): string | null {
  if (!url) return null;
  try {
    if (linkProblem(url, kind) === null) return url;
  } catch {
    // No public origin to compare with; treated as refused.
  }
  log.warn("Stripe link left out of a billing email", { kind });
  return null;
}

function stripeIdsOf(type: HandledEventType, object: unknown): StripeIds {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return {
        customerId: refId(prop(object, "customer")),
        subscriptionId: refId(prop(object, "subscription")),
      };

    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required":
      return {
        customerId: refId(prop(object, "customer")),
        subscriptionId: subscriptionOf(object),
      };

    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return {
        customerId: refId(prop(object, "customer")),
        subscriptionId: asString(prop(object, "id")),
      };

    case "charge.dispute.created": {
      // A dispute names a charge, and only an expanded charge names the
      // customer. apps/web expands it before forwarding; an unexpanded one
      // resolves to nothing and is ignored with the reason recorded.
      const charge = prop(object, "charge");
      const intent = prop(object, "payment_intent");
      return {
        customerId:
          refId(prop(charge, "customer")) ?? refId(prop(intent, "customer")),
        subscriptionId: null,
      };
    }

    case "charge.refunded":
      // The charge names its customer; it names no subscription or invoice in
      // this API version, and the customer is all the resolution needs.
      return { customerId: refId(prop(object, "customer")), subscriptionId: null };
  }
}

function hasHealdeskMarker(type: HandledEventType, object: unknown): boolean {
  // A refund arrives unmarked (apps/web relays it whatever its metadata) and
  // long after provisioning, so a charge no clinic's customer matches is
  // another app's on the shared account: ignored, never retried.
  if (type === "charge.refunded") return false;
  const candidates = [
    metadataApp(object),
    // Invoices carry a frozen copy of the subscription's metadata, in one of
    // two places depending on the API version.
    metadataApp(prop(prop(object, "parent"), "subscription_details")),
    metadataApp(prop(object, "subscription_details")),
    // A dispute's marker, if any, is on the charge.
    type === "charge.dispute.created" ? metadataApp(prop(object, "charge")) : null,
  ];
  return candidates.includes(HEALDESK_APP_MARKER);
}

/** The invoice's subscription, in either API version's place. */
function subscriptionOf(invoice: unknown): string | null {
  return (
    refId(prop(prop(prop(invoice, "parent"), "subscription_details"), "subscription")) ??
    refId(prop(invoice, "subscription"))
  );
}

function isSubscriptionReason(reason: string | null): boolean {
  return (
    reason === "subscription_cycle" ||
    reason === "subscription_update" ||
    reason === "subscription_threshold" ||
    reason === "subscription"
  );
}

function hdKindOf(invoice: unknown): string | null {
  return asString(prop(prop(invoice, "metadata"), "hd_kind"));
}

function amountPaidOf(invoice: unknown): number {
  return asNumber(prop(invoice, "amount_paid")) ?? 0;
}

function paidAtOf(invoice: unknown, fallback: Date): Date {
  return unixDate(prop(prop(invoice, "status_transitions"), "paid_at")) ?? fallback;
}

function invoiceLines(invoice: unknown): unknown[] {
  const data = prop(prop(invoice, "lines"), "data");
  return Array.isArray(data) ? data : [];
}

function lookupKeyOf(line: unknown): string | null {
  const current = prop(prop(prop(line, "pricing"), "price_details"), "price");
  const legacy = prop(line, "price");
  return (
    asString(prop(current, "lookup_key")) ?? asString(prop(legacy, "lookup_key"))
  );
}

/** The id of a line's price, in either API version's place. */
function priceIdOf(line: unknown): string | null {
  return (
    refId(prop(prop(prop(line, "pricing"), "price_details"), "price")) ??
    refId(prop(line, "price"))
  );
}

function isRecurringLine(line: unknown): boolean {
  const key = lookupKeyOf(line);
  if (key) {
    const parsed = parseLookupKey(key);
    return parsed !== null && parsed.kind !== "setup";
  }
  return (
    prop(prop(line, "parent"), "type") === "subscription_item_details" ||
    prop(line, "type") === "subscription"
  );
}

/** A line billed by a subscription item (not an invoice item), in either API version's shape. */
function isSubscriptionItemLine(line: unknown): boolean {
  return (
    prop(prop(line, "parent"), "type") === "subscription_item_details" ||
    prop(line, "type") === "subscription"
  );
}

/** A proration credit or debit, in either API version's shape. */
function isProrationLine(line: unknown): boolean {
  const parent = prop(line, "parent");
  return (
    prop(prop(parent, "subscription_item_details"), "proration") === true ||
    prop(prop(parent, "invoice_item_details"), "proration") === true ||
    prop(line, "proration") === true
  );
}

/**
 * The setup fee is the line whose price key parses as a `setup` price
 * (`healdesk_<plan>_setup_<cents>`). When the price is not expanded on the
 * payload — the current API version sends an id — it is the one-time invoice
 * item, because a subscription-mode Session only ever puts one one-time line
 * on the first invoice and that is the fee.
 *
 * Parsed, not matched on a suffix: the key ends in the amount, so an
 * `endsWith("_setup")` test never matched a real key and recorded a paid $997
 * fee as $0 whenever the price arrived expanded.
 */
function isSetupLine(line: unknown): boolean {
  const key = lookupKeyOf(line);
  if (key) return parseLookupKey(key)?.kind === "setup";
  return (
    prop(prop(line, "parent"), "type") === "invoice_item_details" ||
    prop(line, "type") === "invoiceitem"
  );
}

function setupFeeUsd(invoice: unknown): number {
  let cents = 0;
  for (const line of invoiceLines(invoice)) {
    if (isSetupLine(line)) cents += asNumber(prop(line, "amount")) ?? 0;
  }
  return cents / 100;
}

type PlanLine = { raw: unknown; amount: number; period: { start: Date; end: Date } };

/**
 * The invoice's PLAN line, or null when it has none: a subscription item's
 * line that is not a proration and bills more than $0, the one whose period
 * ends latest when there are several (BD7).
 *
 * That is what tells the deferred start's invoices apart while webhook lines
 * name their prices by id alone. The $0 placeholder's line bills $0. A
 * metered item bills in arrears, so its line never reaches as far as the plan
 * line it sits beside, and none exists before the plan starts anyway. A
 * proration is a step-up's or a plan change's adjustment, not a period
 * bought. When a price does arrive with its lookup key, the key must parse as
 * a package price, which rules out the placeholder and the metered prices by
 * name as well.
 */
function planLine(invoice: unknown): PlanLine | null {
  let best: PlanLine | null = null;
  for (const line of invoiceLines(invoice)) {
    if (!isSubscriptionItemLine(line) || isProrationLine(line) || isSetupLine(line)) continue;
    const key = lookupKeyOf(line);
    if (key !== null) {
      const parsed = parseLookupKey(key);
      if (!parsed || parsed.kind === "setup") continue;
    }
    const amount = asNumber(prop(line, "amount")) ?? 0;
    if (amount <= 0) continue;
    const start = unixDate(prop(prop(line, "period"), "start"));
    const end = unixDate(prop(prop(line, "period"), "end"));
    if (!start || !end) continue;
    if (!best || end.getTime() > best.period.end.getTime()) {
      best = { raw: line, amount, period: { start, end } };
    }
  }
  return best;
}

/**
 * The period the recurring lines bought, from the ONE line whose period ends
 * latest, or null when the invoice has no recurring line with a period.
 *
 * From one line and not min(start) over every recurring line. When the price
 * arrives as an id there is no lookup key to tell the package line from a
 * metered overage line, and overage is billed in arrears for the period that
 * just ended: a min/max across both would open a two-month window on every
 * renewal that carries overage. The package line is the one that reaches
 * furthest into the future, and its own start is the start of the period it
 * bought.
 */
function recurringPeriod(invoice: unknown): { start: Date; end: Date } | null {
  let start: number | null = null;
  let end: number | null = null;

  for (const line of invoiceLines(invoice)) {
    if (!isRecurringLine(line)) continue;
    const period = prop(line, "period");
    const lineStart = asNumber(prop(period, "start"));
    const lineEnd = asNumber(prop(period, "end"));
    if (lineStart === null || lineEnd === null) continue;
    if (end === null || lineEnd > end) {
      start = lineStart;
      end = lineEnd;
    }
  }
  if (start === null || end === null) return null;
  return { start: new Date(start * 1000), end: new Date(end * 1000) };
}

/**
 * The paid period: the recurring lines' (recurringPeriod), not the
 * invoice's own `period_start`/`period_end`, which on a first invoice are the
 * moment of creation and only the line knows the month it bought. Falls back
 * to the invoice's own period, then to now, for an invoice with no recurring
 * line at all.
 */
function invoicePeriod(invoice: unknown): { start: Date; end: Date } {
  const fromLines = recurringPeriod(invoice);
  if (fromLines) return fromLines;
  const start = asNumber(prop(invoice, "period_start")) ?? Math.floor(Date.now() / 1000);
  const end = asNumber(prop(invoice, "period_end")) ?? start;
  return { start: new Date(start * 1000), end: new Date(end * 1000) };
}

/**
 * The package a subscription is on: the first item whose price is ours and
 * not metered, with its quantity (the locations). The metered overage items
 * are skipped here, but they DO depend on the package since 5 October 2026
 * (the chat rate is $0.40 on chat-web and chat-meta and $0.30 elsewhere;
 * packages/catalog `planMeteredPrices`), so a plan change must also swap them
 * — reading the package from the licensed item alone says nothing about
 * whether the metered items still match it. The $0 placeholder's key does not
 * parse as a package price, so before the plan starts there is no package
 * item and nothing here moves.
 */
function packageItemOf(
  subscription: unknown,
): { plan: Plan; interval: BillingInterval; quantity: number | null } | null {
  const items = prop(prop(subscription, "items"), "data");
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    const price = prop(item, "price");
    if (prop(prop(price, "recurring"), "usage_type") === "metered") continue;

    const key = asString(prop(price, "lookup_key"));
    if (!key) continue;
    const parsed = parseLookupKey(key);
    if (!parsed || parsed.kind === "setup") continue;

    const plan = getPlan(parsed.planId);
    if (!plan) continue;
    const quantity = asNumber(prop(item, "quantity"));
    return {
      plan,
      interval: parsed.kind,
      quantity: quantity !== null && Number.isInteger(quantity) && quantity >= 1 ? quantity : null,
    };
  }
  return null;
}

/** The metered items' lookup keys, sorted and deduplicated, as setMeteredPriceKeys stores them. */
function meteredLookupKeys(subscription: unknown): string[] {
  const items = prop(prop(subscription, "items"), "data");
  if (!Array.isArray(items)) return [];
  const keys = new Set<string>();
  for (const item of items) {
    const price = prop(item, "price");
    if (prop(prop(price, "recurring"), "usage_type") !== "metered") continue;
    const key = asString(prop(price, "lookup_key"));
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Whether an end is scheduled, and when: Stripe's dated `cancel_at`, else
 * the latest item period end under `cancel_at_period_end` (billing periods
 * live on the items in this API version, not on the subscription).
 */
function scheduledCancellation(subscription: unknown): { scheduled: boolean; at: Date | null } {
  const cancelAt = unixDate(prop(subscription, "cancel_at"));
  if (cancelAt) return { scheduled: true, at: cancelAt };
  if (prop(subscription, "cancel_at_period_end") !== true) return { scheduled: false, at: null };

  let latest: number | null = null;
  const items = prop(prop(subscription, "items"), "data");
  for (const item of Array.isArray(items) ? items : []) {
    const end = asNumber(prop(item, "current_period_end"));
    if (end !== null && (latest === null || end > latest)) latest = end;
  }
  return { scheduled: true, at: latest === null ? null : new Date(latest * 1000) };
}
