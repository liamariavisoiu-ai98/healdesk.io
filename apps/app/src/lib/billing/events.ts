import { getPlan, type BillingInterval } from "@healdesk/catalog";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type Stripe from "stripe";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  type BillingActor,
  type BillingEventOutcome,
  type BillingStatus,
} from "@/db/schema";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  applyPlanChange,
  getEntitlements,
  parseLookupKey,
  recordFirstInvoice,
  resetUsage,
  setGrace,
  storeStripeIds,
} from "./entitlements";
import { clinicIdForStripe } from "./resolve";
import { canTransition, recordBillingNote, transition } from "./state-machine";
import { log } from "@/lib/log";

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
 * the event is marked `dead_letter`, the route answers 200, and the event sits
 * in billing_events with its full payload and last error until a person
 * replays it with `replayBillingEvent()`. Three is enough to ride out a
 * deploy or a transient database error and few enough that a deterministic
 * bug parks quickly rather than hammering for days.
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
 * ## Pausing is a field, not an event
 *
 * `customer.subscription.paused` and `.resumed` are NOT handled, because they
 * cannot fire here: Stripe's own reference says a subscription "can only enter
 * a `paused` status when a trial ends without a payment method", and there is
 * no trial. The pause a clinic or an operator can actually cause — pausing
 * collection from the Dashboard or the portal — leaves `subscription.status`
 * unchanged and arrives as `customer.subscription.updated` with
 * `pause_collection` set. onSubscriptionUpdated() reads that field; the
 * `paused` billing status means exactly "collection is paused".
 *
 * ## Handlers are idempotent by inspection, not by the ledger alone
 *
 * The ledger stops a second delivery, but a crash between the processing
 * transaction committing and the ledger row being marked leaves an event that
 * WILL be processed again. So every handler reads the current status first and
 * does nothing when the clinic is already where the event wanted it, rather
 * than trusting that it runs once.
 */

export const MAX_FAILURES = 3;

/** How long service continues after a failed renewal before suspension. */
export const GRACE_DAYS = 7;

/**
 * Must match APP_MARKER in apps/web/src/lib/billing.ts, which writes it into
 * every Session and subscription's metadata. Duplicated rather than shared:
 * the catalog is the contract between the two apps and this value is a
 * Stripe-account detail, not a product one.
 */
export const HEALDESK_APP_MARKER = "healdesk";

export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.dispute.created",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

export type HandleContext = {
  /** Correlates the audit rows this event produces. A uuid; audit_log.request_id is typed as one. */
  requestId?: string;
};

export type HandleResult = {
  outcome: Exclude<BillingEventOutcome, "failed">;
  /** True when this delivery did no work because an earlier one already had. */
  duplicate: boolean;
  clinicId: string | null;
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

  let clinicId: string | null = null;
  try {
    // A const, so the narrowing survives into the withTenant() callback below.
    const type = event.type;
    if (!isHandledEventType(type)) {
      return finish(event.id, "ignored", null, `unhandled type ${type}`);
    }

    // 2. Find the tenant. See the header for what a miss means.
    const ids = stripeIdsOf(type, event.data.object);
    clinicId = await clinicIdForStripe(ids.customerId, ids.subscriptionId);
    if (!clinicId) {
      if (hasHealdeskMarker(type, event.data.object)) {
        throw new UnresolvedClinicError(event.id);
      }
      return finish(event.id, "ignored", null, "no clinic for stripe ids");
    }

    // 3. Apply it, as a tenant, through the state machine.
    const resolved = clinicId;
    await withTenant(
      {
        clinicId: resolved,
        actor: STRIPE_WEBHOOK_ACTOR,
        request: { requestId: context.requestId },
      },
      (tx) => dispatch(tx, type, event.id, event.data.object, ids),
    );

    return finish(event.id, "processed", clinicId);
  } catch (error) {
    const failures = await recordFailure(event.id, clinicId, error);
    if (failures >= MAX_FAILURES) {
      // Parked. 200 to Stripe so the endpoint lives; a person replays it.
      log.error("billing event dead-lettered", {
        event: event.id,
        type: event.type,
        failures,
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
// Dispatch
// -----------------------------------------------------------------------------

type StripeIds = { customerId: string | null; subscriptionId: string | null };

async function dispatch(
  tx: TenantTx,
  type: HandledEventType,
  eventId: string,
  object: unknown,
  ids: StripeIds,
): Promise<void> {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // Provisioning already stored these when apps/web called /api/provision;
      // this is the path for a session forwarded here as well. Status stays
      // `provisioning` — only a paid invoice activates.
      await storeStripeIds(tx.db, tx.clinicId, ids);
      return;

    case "invoice.paid":
      await onInvoicePaid(tx, eventId, object);
      return;

    case "invoice.payment_failed":
      await onPaymentFailed(tx, eventId);
      return;

    case "invoice.payment_action_required":
      // 3-D Secure or a bank redirect is pending on the buyer's side. Not a
      // failure yet, so the status stays; the row is what the reminder email
      // (a later task) will key off.
      await recordBillingNote(tx, {
        actor: "system",
        reason: "authentication_required",
        stripeEventId: eventId,
      });
      return;

    case "customer.subscription.updated":
      await onSubscriptionUpdated(tx, eventId, object, ids);
      return;

    case "customer.subscription.deleted":
      await moveUnless(tx, "canceled", ["canceled", "purged"], {
        reason: type,
        stripeEventId: eventId,
      });
      return;

    case "charge.dispute.created":
      await onDispute(tx, eventId);
      return;
  }
}

/**
 * A chargeback. Service is withheld until it resolves; support lifts it.
 *
 * Withheld where there is service to withhold. The common late dispute — the
 * clinic cancels, then disputes the last charge — lands on a `canceling`,
 * `canceled` or `purged` clinic, and a `paused` one can dispute too. Where
 * the edge to `suspended` exists it is taken; where it does not, the dispute
 * is still written into the history as a note, because "why is this clinic
 * suspended" and "did this clinic ever dispute" are both questions support
 * asks, and a delivery that dead-lettered for want of an edge would answer
 * neither.
 */
async function onDispute(tx: TenantTx, eventId: string): Promise<void> {
  const current = await currentStatus(tx);
  if (current === "suspended") return;
  const options = { actor: "system", reason: "dispute", stripeEventId: eventId } as const;
  if (canTransition(current, "suspended")) {
    await transition(tx, "suspended", options);
  } else {
    await recordBillingNote(tx, options);
  }
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

async function onInvoicePaid(
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

async function onPaymentFailed(tx: TenantTx, eventId: string): Promise<void> {
  const current = await getEntitlements(tx.db, tx.clinicId);
  if (!current) throw new Error(`No entitlements row for clinic ${tx.clinicId}.`);

  if (current.status === "active") {
    await transition(tx, "past_due", {
      actor: "system",
      reason: "invoice.payment_failed",
      stripeEventId: eventId,
    });
  }

  // Stripe's smart retries send one of these per attempt, spread over weeks.
  // The window opens on the FIRST failure and is kept on the rest: a grace
  // period that re-opened on every retry would never close.
  if (!current.graceEndsAt) {
    await setGrace(
      tx.db,
      tx.clinicId,
      new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000),
    );
  }
}

async function onSubscriptionUpdated(
  tx: TenantTx,
  eventId: string,
  subscription: unknown,
  ids: StripeIds,
): Promise<void> {
  await storeStripeIds(tx.db, tx.clinicId, ids);

  const priced = planFromSubscription(subscription);
  if (priced) {
    const { changed } = await applyPlanChange(
      tx.db,
      tx.clinicId,
      priced.plan,
      priced.interval,
    );
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
  }

  // Three fields on the subscription each map to a status, read in the order
  // of how final they are. `status` is tracked locally across the steps so a
  // single update that clears a pause AND sets cancel-at-period-end walks
  // paused → active → canceling in one delivery.
  let status = await currentStatus(tx);
  const move = async (to: BillingStatus, actor: BillingActor, reason: string) => {
    await transition(tx, to, { actor, reason, stripeEventId: eventId });
    status = to;
  };

  // `unpaid`: Stripe exhausted its retries and, with the Dashboard set to
  // "do not cancel", parked the subscription. Invoices are still created and
  // immediately closed, so nothing further will ever arrive to move the
  // clinic — this is the terminal signal of a failed renewal, and it means
  // suspended whether or not the sweep's grace window has run out yet.
  const stripeStatus = asString(prop(subscription, "status"));
  if (stripeStatus === "unpaid" && (status === "active" || status === "past_due")) {
    await move("suspended", "system", "subscription_unpaid");
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

  // `cancel_at_period_end` is the customer's "cancel at renewal", and it can be
  // undone from the portal right up to the renewal — hence the reversal edge.
  const cancelAtPeriodEnd = prop(subscription, "cancel_at_period_end") === true;
  if (cancelAtPeriodEnd && (status === "active" || status === "past_due")) {
    await move("canceling", "client", "cancel_at_period_end");
  } else if (!cancelAtPeriodEnd && status === "canceling") {
    await move("active", "client", "cancel_reversed");
  }
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

function metadataApp(value: unknown): string | null {
  return asString(prop(prop(value, "metadata"), "app"));
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
        subscriptionId:
          refId(prop(prop(prop(object, "parent"), "subscription_details"), "subscription")) ??
          refId(prop(object, "subscription")),
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
  }
}

function hasHealdeskMarker(type: HandledEventType, object: unknown): boolean {
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

/**
 * The setup fee is the line whose price key ends in `_setup`. When the price
 * is not expanded on the payload — the current API version sends an id — it
 * is the one-time invoice item, because a subscription-mode Session only ever
 * puts one one-time line on the first invoice and that is the fee.
 */
function isSetupLine(line: unknown): boolean {
  const key = lookupKeyOf(line);
  if (key) return key.endsWith("_setup");
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

/**
 * The paid period, from the recurring lines rather than the invoice's own
 * `period_start`/`period_end`: on a first invoice those two are the moment
 * of creation, and only the line knows the month it bought.
 *
 * From ONE line — the one whose period ends latest — and not min(start) over
 * every recurring line. When the price arrives as an id there is no lookup
 * key to tell the package line from a metered overage line, and overage is
 * billed in arrears for the period that just ended: a min/max across both
 * would open a two-month window on every renewal that carries overage. The
 * package line is the one that reaches furthest into the future, and its own
 * start is the start of the period it bought.
 */
function invoicePeriod(invoice: unknown): { start: Date; end: Date } {
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

  start ??= asNumber(prop(invoice, "period_start")) ?? Math.floor(Date.now() / 1000);
  end ??= asNumber(prop(invoice, "period_end")) ?? start;

  return { start: new Date(start * 1000), end: new Date(end * 1000) };
}

/**
 * The package a subscription is on: the first item whose price is ours and
 * not metered. The metered overage prices, when apps/web attaches them (only
 * once the rates stop being provisional — see its lib/billing.ts), are the
 * same two on every subscription and say nothing about the package.
 */
function planFromSubscription(
  subscription: unknown,
): { plan: NonNullable<ReturnType<typeof getPlan>>; interval: BillingInterval } | null {
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
    return { plan, interval: parsed.kind };
  }
  return null;
}
