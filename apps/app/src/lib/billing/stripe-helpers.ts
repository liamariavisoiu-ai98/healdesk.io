import type Stripe from "stripe";

/**
 * Small Stripe helpers shared by the billing workers and actions.
 */

/**
 * Per-request options for every Stripe call a worker makes (build spec R4).
 *
 * The SDK defaults to an 80-second timeout and two network retries, so one
 * call could outlive the worker's 5-minute lease and let a second worker
 * claim the same request mid-call. Twenty seconds and one retry keep the
 * worst case under a minute.
 */
export const WORKER_STRIPE_OPTIONS = { timeout: 20_000, maxNetworkRetries: 1 } as const;

/** Worker request options, with an idempotency key when the call moves money or state. */
export function workerRequestOptions(idempotencyKey?: string): Stripe.RequestOptions {
  return idempotencyKey
    ? { ...WORKER_STRIPE_OPTIONS, idempotencyKey }
    : { ...WORKER_STRIPE_OPTIONS };
}

/** A Stripe reference is an id string, or the expanded object carrying one. */
export function stripeRefId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

/**
 * The payment method Stripe will charge (build spec R16): the customer's
 * invoice default, else the subscription's own default.
 *
 * The customer default is the single source of truth. Checkout leaves the card
 * on the subscription, and the Customer Portal's payment-method update sets
 * only the customer default, which a subscription-level default overrides. So
 * the plan start copies the card to the customer (when the customer has none)
 * and clears the subscription's, and every one-off invoice and expiring-card
 * check reads the customer first. A card replaced in the portal is then the
 * card charged next.
 */
export async function effectivePaymentMethod(
  stripe: Stripe,
  input: { customerId: string; subscription?: { default_payment_method?: unknown } | null },
  options: Stripe.RequestOptions = WORKER_STRIPE_OPTIONS,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(input.customerId, {}, options);
  if (!("deleted" in customer && customer.deleted)) {
    const fromCustomer = stripeRefId(customer.invoice_settings?.default_payment_method);
    if (fromCustomer) return fromCustomer;
  }
  return stripeRefId(input.subscription?.default_payment_method ?? null);
}
