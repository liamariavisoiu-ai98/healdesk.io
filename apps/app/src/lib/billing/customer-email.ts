import { eq } from "drizzle-orm";

import { entitlements } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";

import { withBillingTenant } from "./billing-clinic";
import { getStripe } from "./stripe-client";
import { workerRequestOptions } from "./stripe-helpers";

/**
 * The Stripe customer's email, kept equal to the clinic's one address
 * (plan Part D5; Terms §18: the clinic's address is its sign-in, the Stripe
 * customer's email and the agreement's notice address, and the three change
 * together). Called only by the address change, when it takes effect
 * (lib/sign-in/address-change.ts), before the sign-in itself moves, so a
 * Stripe failure leaves all three where they were and the change is retried
 * the next hour.
 *
 * The one Stripe write in the address change, kept here, in billing, for
 * billing's review. It changes the customer's email and nothing else: no
 * invoice, no subscription, no payment method.
 */

/** The Stripe customer of the clinic that pays for `clinicId`, or null when it has none yet. */
export async function stripeCustomerOf(
  clinicId: string,
  actor: ActorContext,
): Promise<string | null> {
  return withBillingTenant(clinicId, actor, async (tx) => {
    const [row] = await tx.db
      .select({ customerId: entitlements.stripeCustomerId })
      .from(entitlements)
      .where(eq(entitlements.clinicId, tx.clinicId))
      .limit(1);
    return row?.customerId ?? null;
  });
}

/**
 * Set one customer's email. Idempotent under `idempotencyKey` (one per
 * change and customer), and harmless to repeat: setting the same email twice
 * is the same customer. Throws what Stripe throws; the caller decides.
 */
export async function updateStripeCustomerEmail(
  customerId: string,
  email: string,
  idempotencyKey: string,
): Promise<void> {
  await getStripe().customers.update(customerId, { email }, workerRequestOptions(idempotencyKey));
}
