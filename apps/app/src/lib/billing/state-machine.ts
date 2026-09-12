import { eq } from "drizzle-orm";

import {
  billingTransitions,
  entitlements,
  type BillingActor,
  type BillingStatus,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { EntitlementsNotFoundError } from "./entitlements";

/**
 * The billing status state machine.
 *
 * `entitlements.status` is written here and nowhere else. Every change goes
 * through `transition()`, which locks the row, checks the edge against
 * ALLOWED_TRANSITIONS, and records the change in billing_transitions and the
 * audit log inside the same transaction as the update. A status that moved
 * without a row saying why is the failure this file exists to make impossible.
 *
 * ## Why an explicit edge list
 *
 * Stripe events arrive out of order and at least once. Without a guard, a
 * delayed `customer.subscription.deleted` would cancel a clinic that has since
 * re-subscribed, and a replayed `invoice.paid` would "activate" a clinic that
 * support suspended for a chargeback an hour ago. The list below is what makes
 * those deliveries throw instead — and a throw here is deliberate: the webhook
 * records it, retries, and dead-letters it for a person to look at (see
 * events.ts), which is exactly what an event that no longer fits the clinic's
 * state deserves.
 *
 * ## The edges
 *
 *   demo         → provisioning                 a demo converts to a purchase
 *   provisioning → active | suspended | canceled
 *                                               first invoice paid; a chargeback
 *                                               on it; or it never was paid
 *   active       → past_due | paused | canceling | suspended | canceled
 *   past_due     → active | paused | suspended | canceling | canceled
 *   suspended    → active | canceled            paid up, or gave up
 *   paused       → active | canceled
 *   canceling    → active | suspended | canceled
 *                                               the cancel can be reversed; a
 *                                               chargeback during the paid-out
 *                                               period still withholds service
 *   canceled     → purged                       data destroyed after retention
 *   purged       → (nothing)                    terminal
 *
 * `past_due → paused` exists because Stripe allows collection to be paused on
 * a past-due subscription, and the pause arrives as a field on
 * `customer.subscription.updated` (see events.ts) whatever the status was.
 */
export const ALLOWED_TRANSITIONS: Record<BillingStatus, readonly BillingStatus[]> =
  {
    demo: ["provisioning"],
    provisioning: ["active", "suspended", "canceled"],
    active: ["past_due", "paused", "canceling", "suspended", "canceled"],
    past_due: ["active", "paused", "suspended", "canceling", "canceled"],
    suspended: ["active", "canceled"],
    paused: ["active", "canceled"],
    canceling: ["active", "suspended", "canceled"],
    canceled: ["purged"],
    purged: [],
  };

/** Pure. A same-status "transition" is not one and returns false. */
export function canTransition(from: BillingStatus, to: BillingStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class BillingTransitionError extends Error {
  constructor(
    readonly from: BillingStatus,
    readonly to: BillingStatus,
  ) {
    super(`Billing status cannot move from '${from}' to '${to}'.`);
    this.name = "BillingTransitionError";
  }
}

export type TransitionOptions = {
  actor: BillingActor;
  /** Short and machine-readable: the event type, or "dispute", "support". */
  reason: string;
  stripeEventId?: string;
};

/**
 * Move the tenant's clinic to `to`, or throw.
 *
 * `FOR UPDATE` on the read, because two deliveries of related events can
 * overlap — Stripe sends `invoice.paid` and `customer.subscription.updated`
 * for the same renewal within the same second — and the edge check is only
 * meaningful against a status nobody else is changing underneath it. The lock
 * is held to the end of the surrounding withTenant() transaction, which is
 * where the audit entry flushes.
 *
 * Returns the edge taken so the caller can log it without a second read.
 */
export async function transition(
  tx: TenantTx,
  to: BillingStatus,
  options: TransitionOptions,
): Promise<{ from: BillingStatus; to: BillingStatus }> {
  const from = await lockedStatus(tx);

  if (!canTransition(from, to)) {
    throw new BillingTransitionError(from, to);
  }

  await tx.db
    .update(entitlements)
    .set({ status: to, updatedAt: new Date() })
    .where(eq(entitlements.clinicId, tx.clinicId));

  await tx.db.insert(billingTransitions).values({
    clinicId: tx.clinicId,
    fromStatus: from,
    toStatus: to,
    actor: options.actor,
    reason: options.reason,
    stripeEventId: options.stripeEventId ?? null,
  });

  // The Stripe event id is on the transitions row, not here: the audit guard
  // rejects anything that looks like a phone number, and an opaque id with a
  // long digit run would fail the whole webhook at random. See assertNoPhi().
  tx.audit.record({
    action: "update",
    resourceType: "entitlements",
    resourceId: tx.clinicId,
    metadata: {
      field: "status",
      from,
      to,
      actor: options.actor,
      reason: options.reason,
    },
  });

  return { from, to };
}

/**
 * Record something worth a row in the history WITHOUT moving the status:
 * `invoice.payment_action_required`, a support note. Same shape as a
 * transition with from = to, so the history reads in one query.
 */
export async function recordBillingNote(
  tx: TenantTx,
  options: TransitionOptions,
): Promise<BillingStatus> {
  const status = await lockedStatus(tx);

  await tx.db.insert(billingTransitions).values({
    clinicId: tx.clinicId,
    fromStatus: status,
    toStatus: status,
    actor: options.actor,
    reason: options.reason,
    stripeEventId: options.stripeEventId ?? null,
  });

  return status;
}

async function lockedStatus(tx: TenantTx): Promise<BillingStatus> {
  const rows = await tx.db
    .select({ status: entitlements.status })
    .from(entitlements)
    .where(eq(entitlements.clinicId, tx.clinicId))
    .for("update");

  const row = rows[0];
  if (!row) throw new EntitlementsNotFoundError(tx.clinicId);
  return row.status;
}
