import { and, eq, gt, isNull } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { checkoutIntents } from "@/db/schema";
import { clinicIdForStripe } from "@/lib/billing/resolve";

/**
 * Which clinic a parked Stripe event that resolved to none belongs to now,
 * and whether provisioning will replay it by itself.
 *
 * An event parks with no clinic in two ways. Before provisioning: an
 * `invoice.paid` that beat the checkout to the endpoint; provisioning
 * replays every such event once the account exists
 * (lib/billing/events.ts replayParkedBillingEvents), so it is not the
 * owner's to approve while that purchase is still waiting to be
 * provisioned. Or for a clinic that exists, when the database failed before
 * the event was resolved: nothing replays that one (Stripe's redelivery is a
 * duplicate), so it is proposed.
 *
 * The ids are read as events.ts `stripeIdsOf` reads them, mirrored here
 * because that function is not exported (lib/billing/events.ts is not this
 * lane's file); tests/approvals.test.ts holds the two to the same paths.
 */

export type StripeIds = { customerId: string | null; subscriptionId: string | null };

function prop(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function refId(value: unknown): string | null {
  if (typeof value === "string") return value;
  const id = prop(value, "id");
  return typeof id === "string" ? id : null;
}

/** events.ts stripeIdsOf, type for type. */
export function stripeIdsOfEvent(type: string, object: unknown): StripeIds {
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return { customerId: refId(prop(object, "customer")), subscriptionId: refId(prop(object, "subscription")) };
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required":
      return {
        customerId: refId(prop(object, "customer")),
        subscriptionId:
          refId(prop(prop(prop(object, "parent"), "subscription_details"), "subscription")) ?? refId(prop(object, "subscription")),
      };
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const id = prop(object, "id");
      return { customerId: refId(prop(object, "customer")), subscriptionId: typeof id === "string" ? id : null };
    }
    case "charge.dispute.created":
      return {
        customerId: refId(prop(prop(object, "charge"), "customer")) ?? refId(prop(prop(object, "payment_intent"), "customer")),
        subscriptionId: null,
      };
    case "charge.refunded":
      return { customerId: refId(prop(object, "customer")), subscriptionId: null };
    default:
      return { customerId: null, subscriptionId: null };
  }
}

export type UnresolvedEvent =
  /** Its ids match a clinic now: propose it about that clinic. */
  | { state: "resolved"; clinicId: string }
  /** A purchase still waiting to be provisioned names it: provisioning will replay it. */
  | { state: "provisioning_pending" }
  /** Nothing will replay it: propose it with no clinic. */
  | { state: "orphaned" };

export async function classifyUnresolvedEvent(type: string, payload: unknown, now: Date): Promise<UnresolvedEvent> {
  const ids = stripeIdsOfEvent(type, prop(prop(payload, "data"), "object"));
  const clinicId = await clinicIdForStripe(ids.customerId, ids.subscriptionId);
  if (clinicId) return { state: "resolved", clinicId };
  if (ids.subscriptionId) {
    const [pending] = await unsafeDb
      .select({ ref: checkoutIntents.ref })
      .from(checkoutIntents)
      .where(
        and(
          eq(checkoutIntents.stripeSubscriptionId, ids.subscriptionId),
          isNull(checkoutIntents.consumedAt),
          gt(checkoutIntents.expiresAt, now),
        ),
      )
      .limit(1);
    if (pending) return { state: "provisioning_pending" };
  }
  return { state: "orphaned" };
}
