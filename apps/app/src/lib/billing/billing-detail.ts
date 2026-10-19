import { getStripe } from "./stripe-client";
import { WORKER_STRIPE_OPTIONS } from "./stripe-helpers";

/**
 * "I can't get in" (plan Part D5, /sign-in/help): whether a billing detail
 * someone typed is one of the account's, checked against Stripe on the
 * server. Reads only: a card's last four digits and expiry among the
 * customer's saved cards, or an invoice number among its invoices. Nothing
 * here is shown to the person asking; the page answers the same way whether
 * it matched or not (lib/sign-in/help.ts).
 *
 * A match only ever sends a sign-in link to the address already on the
 * account, never anywhere else, and never adds a device. The receipts that
 * show a card's last digits reach that same shared inbox, which is why a
 * match is worth no more than that link.
 *
 * Kept in billing for billing's review: it reads the Stripe customer and
 * moves nothing.
 */

export type BillingDetail =
  | { kind: "card"; last4: string; expMonth: number; expYear: number }
  | { kind: "invoice"; number: string };

/** How many of a customer's saved cards and invoices are looked through: more than any clinic has. */
const MAX_CARDS = 20;
const MAX_INVOICES = 100;

export async function billingDetailMatches(
  customerId: string,
  detail: BillingDetail,
): Promise<boolean> {
  const stripe = getStripe();
  if (detail.kind === "card") {
    const cards = await stripe.paymentMethods.list(
      { customer: customerId, type: "card", limit: MAX_CARDS },
      WORKER_STRIPE_OPTIONS,
    );
    return cards.data.some(
      (pm) =>
        pm.card?.last4 === detail.last4 &&
        pm.card.exp_month === detail.expMonth &&
        pm.card.exp_year === detail.expYear,
    );
  }
  const wanted = detail.number.trim().toUpperCase();
  const invoices = await stripe.invoices.list(
    { customer: customerId, limit: MAX_INVOICES },
    WORKER_STRIPE_OPTIONS,
  );
  return invoices.data.some((invoice) => (invoice.number ?? "").toUpperCase() === wanted);
}
