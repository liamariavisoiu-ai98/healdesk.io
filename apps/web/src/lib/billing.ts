import { TRIAL_DAYS, type Plan } from "@healdesk/catalog";
import Stripe from "stripe";

/**
 * Billing, behind an interface.
 *
 * A real implementation when `STRIPE_SECRET_KEY` is present, and one that skips
 * straight to provisioning when it isn't, so the purchase flow stays testable
 * end to end without Stripe keys, while production refuses to hand out free
 * accounts.
 *
 * ## Where the provisioning payload lives
 *
 * In Stripe Session metadata, as one key per field rather than a single JSON
 * blob. Stripe's limits are 50 keys, 40 characters per key, 500 per value; the
 * whole payload serialised as JSON lands around 495 characters for an ordinary
 * customer, which is under the limit only until someone signs up with a long
 * practice name and a hyphenated surname. Per-field, the largest value is
 * `clinicName` at 120 and `contactEmail` at 254, both with room to spare, and
 * 12 keys against a limit of 50.
 *
 * It is business contact data, a clinic's name, its owner's work email, not
 * patient data, and Stripe already receives the email as the customer record.
 * Nothing patient-identifying may ever be added here.
 *
 * ## Where provisioning actually happens
 *
 * On `checkout.session.completed`, in the webhook. NOT on the browser returning
 * to the success URL: a customer who closes the tab after paying still gets
 * their account, and someone who hand-crafts a success URL gets nothing.
 */

export type CheckoutIntent = {
  plan: Plan;
  clinicName: string;
  contactEmail: string;
  /** Field-per-key on the Session; read back by the webhook. */
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

/**
 * Constructed per call, never at module scope.
 *
 * `new Stripe(undefined)` throws synchronously ("Neither apiKey nor
 * config.authenticator provided"). At module scope that throw happens at import
 * time, so every route in the module 500s before any of its own guards run,
 * including the webhook's, which needs to answer Stripe's endpoint test even
 * while the key is missing.
 */
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  return new Stripe(key);
}

/** Marks a Session as ours. One Stripe account also serves scalabid. */
export const APP_MARKER = "healdesk";

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

/**
 * Flatten the provisioning payload into Stripe metadata.
 *
 * Every value becomes a string, because Stripe metadata has no other type,
 * which is exactly the trap on the way back: `averageTreatmentValueUsd` returns
 * as `"550"`, and provisioning requires a number. The reverse of this function
 * lives in the webhook and must coerce it.
 */
export function toMetadata(
  payload: Record<string, unknown>,
): Record<string, string> {
  const meta: Record<string, string> = { app: APP_MARKER };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") continue;
    meta[key] = String(value);
  }
  return meta;
}

export async function createCheckout(
  intent: CheckoutIntent,
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

  const stripe = stripeClient();
  const metadata = toMetadata(intent.provisionPayload);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: intent.contactEmail,

    line_items: [
      {
        // Looked up by the stable key the setup script writes, so pricing lives
        // in one place (packages/catalog) and cannot drift into a state where
        // the site quotes $249 and the card is charged $449.
        price: await priceIdForPlan(stripe, intent.plan),
        quantity: 1,
      },
    ],

    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      /**
       * A trial that ends with no card on file cancels rather than silently
       * lapsing into an unpaid subscription we'd keep serving.
       */
      trial_settings: {
        end_behavior: { missing_payment_method: "cancel" },
      },
      // Also on the subscription, so later invoice and subscription events can
      // be traced back to this clinic without re-reading the Session.
      metadata,
    },

    /**
     * Collect the card up front.
     *
     * This is the subscription-mode default, and it is also the deliberate
     * choice: at $249–799/mo sold to clinics, a card at signup is the norm and
     * a trial with no card converts far worse. It also decides what
     * `payment_status` will be on the way back, with a card collected, Stripe
     * processes a $0 trial invoice and reports `paid`. See the webhook for why
     * that field must still never be used as the gate.
     */
    payment_method_collection: "always",

    metadata,
    // Surfaces in the Dashboard next to the payment, so support can find a
    // clinic without opening metadata.
    client_reference_id: intent.clinicName.slice(0, 200),

    success_url: `${siteUrl()}/get-started/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/get-started?cancelled=1`,
  });

  if (!session.url) {
    throw new Error("Stripe returned a session with no checkout URL.");
  }
  return { kind: "redirect", url: session.url };
}

/**
 * Resolve a catalog plan to its Stripe price.
 *
 * By `lookup_key`, not by a price id in an env var: an env var is a second
 * place for the price to live and a second place for it to be wrong, and the
 * failure mode is charging a customer the wrong amount. The key encodes the
 * amount, so a catalog price change cannot silently resolve to the old price.
 * it fails loudly here until the setup script has been re-run.
 */
async function priceIdForPlan(stripe: Stripe, plan: Plan): Promise<string> {
  const key = `healdesk_${plan.id}_${plan.monthlyUsd * 100}`;
  const found = await stripe.prices.list({
    lookup_keys: [key],
    active: true,
    limit: 1,
  });

  const price = found.data[0];
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup_key "${key}". ` +
        `Run: STRIPE_SECRET_KEY=… npx tsx apps/web/scripts/stripe-setup.ts`,
    );
  }
  return price.id;
}
