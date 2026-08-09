import type { Plan } from "@healdesk/catalog";

/**
 * Billing, behind an interface.
 *
 * Stripe keys don't exist yet, and waiting for them would block the entire
 * purchase flow from being built and tested. So checkout goes through this
 * boundary: a real implementation when `STRIPE_SECRET_KEY` is present, and one
 * that skips straight to provisioning when it isn't.
 *
 * The stub is deliberately loud. A silent fallback that quietly provisions
 * unpaid accounts in production is exactly the kind of thing that survives to
 * launch unnoticed.
 */

export type CheckoutIntent = {
  plan: Plan;
  clinicName: string;
  contactEmail: string;
  /** Opaque payload handed back to us after payment, to complete provisioning. */
  provisionPayload: Record<string, unknown>;
};

export type CheckoutResult =
  /** Send the browser here to pay. */
  | { kind: "redirect"; url: string }
  /** No payment configured; the caller should provision immediately. */
  | { kind: "skipped"; reason: string };

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function createCheckout(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _intent: CheckoutIntent,
): Promise<CheckoutResult> {
  if (!isBillingConfigured()) {
    if (process.env.NODE_ENV === "production") {
      // Refuse rather than hand out free accounts.
      throw new Error(
        "STRIPE_SECRET_KEY is not set. Refusing to provision without payment in production.",
      );
    }
    return {
      kind: "skipped",
      reason: "STRIPE_SECRET_KEY is not set; provisioning without payment.",
    };
  }

  // Deliberately not implemented yet. When the Stripe account exists this
  // creates a Checkout Session with the plan's price, a 14-day trial, and
  // `provisionPayload` in metadata so the webhook can complete setup.
  //
  // Provisioning must happen on `checkout.session.completed`, NOT on the
  // browser returning to the success URL — a customer who closes the tab after
  // paying still gets their account, and someone who hand-crafts a success URL
  // gets nothing.
  throw new Error(
    "Stripe checkout is not implemented yet. See docs/launch-plan.md, Phase 2.",
  );
}
