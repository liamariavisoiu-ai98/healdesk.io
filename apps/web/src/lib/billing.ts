import {
  type BillingInterval,
  COHORT_SETUP_CREDIT,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planMeteredPrices,
  planStartSentence,
  type PriceKind,
  stripeLookupKey,
} from "@healdesk/catalog";
import Stripe from "stripe";

import { normalizeSiteUrl } from "@/lib/site";

/**
 * Billing, behind an interface.
 *
 * A real implementation when `STRIPE_SECRET_KEY` is present, and one that skips
 * straight to provisioning when it isn't, so the purchase flow stays testable
 * end to end without Stripe keys, while production refuses to hand out free
 * accounts.
 *
 * ## What a Session charges (the deferred start, contracts §2)
 *
 * Two line items on one subscription-mode Session: the package's one-time
 * setup fee, and a $0 monthly price, "Monthly plan: starts when AYA first
 * answers" (`PLAN_START_PLACEHOLDER_LOOKUP_KEY`). Stripe bills the one-time
 * price on the first invoice only
 * (https://docs.stripe.com/payments/checkout/subscriptions/one-time-fees); the
 * $0 line makes the subscription that holds the card and bills nothing until
 * the day AYA first answers a patient, when apps/app swaps it for the
 * package's price (Package C). So "Due today" is the setup fee alone.
 *
 * No trial anywhere. Stripe would treat a trial as one, with the card networks'
 * trial rules and Stripe's "TRIAL OVER" statement wording behind it, and the
 * wait here gives nothing free. Nothing in this module may reintroduce
 * `trial_end`.
 *
 * Subscription mode even when the setup credit brings the total to $0: payment
 * mode collects no card for a $0 total, and the plan's first period needs one.
 * The Session's custom text carries the plan-start sentence and says the setup
 * fee is non-refundable, the two facts a buyer needs at the moment they pay.
 *
 * ## No metered prices at checkout
 *
 * The overage meters only make sense beside a package price, so they join the
 * subscription with it at the plan start, never at checkout.
 * `meteredLookupKeysFor()` keeps the rules for which apply: none while
 * `OVERAGE_RATES_PROVISIONAL` is true, the package's own on a monthly plan,
 * and none on an annual one, whose overage is invoiced separately (the
 * 21 September 2026 decision in docs/handover.md).
 *
 * ## The setup credit
 *
 * Day 7 of the nurture sequence offers the setup fee back (packages/catalog
 * `COHORT_SETUP_CREDIT`). It is a Stripe coupon per package, `amount_off`
 * equal to that package's setup fee and `duration: "once"`, created by
 * `stripe:setup` and attached here only when the checkout route established
 * the lead was offered it within the window. The setup-fee line stays on the
 * Session, so the invoice shows the fee and the credit.
 *
 * ## What Stripe carries
 *
 * An opaque ref and nothing about the buyer (design D1). Before this Session
 * exists, apps/app stores the validated purchase as a checkout intent
 * (POST /api/checkout/intents) and answers with its ref and the success URL,
 * which is apps/app's /welcome on its public origin. The Session and its
 * subscription carry `{ app, ref, plan, billingInterval }`, and the Session
 * also carries the attribution ids the lead store reads back: campaign, lead
 * and setup request. Ids and package names only: no name, no address.
 *
 * ## Where the account is created
 *
 * On the first paid invoice, never on the Session and never on the browser
 * returning (plan C1, design D2): the webhook relays `invoice.paid` with
 * `billing_reason: "subscription_create"` to apps/app as `{ ref,
 * idempotencyKey: <subscription id> }`, and apps/app provisions from the
 * stored intent before the event itself is applied. A paid first invoice is
 * money cleared, so the account and its activation are one moment.
 */

export type CheckoutIntent = {
  plan: Plan;
  interval: BillingInterval;
  contactEmail: string;
  /** The intent apps/app stored for this purchase, and which press of Pay this is. */
  intent: {
    ref: string;
    attempt: number;
    /** apps/app's /welcome, with Stripe's `{CHECKOUT_SESSION_ID}` placeholder. */
    successUrl: string;
    /** The previous attempt's Session, expired before this one is created. */
    previousOpenSessionId: string | null;
  };
  /**
   * Which cold email, and which lead, this purchase came from, and the setup
   * request whose link opened it. Session-only metadata, read back by the
   * webhook for the lead store. Null when organic.
   */
  attribution?: {
    campaign: string | null;
    leadId: string | null;
    /** "cohort-setup" when the lead was offered the setup credit inside its window. */
    offer?: "cohort-setup" | null;
    /** The personalised demo's slug, when the buyer came from its "Book Onboarding" (lib/demo). */
    demo?: string | null;
    /**
     * The setup request whose link opened this purchase, while purchases are
     * by invitation. The webhook stamps the request paid, which is what
     * makes the link single-use (lib/setup-gate.ts).
     */
    setupRequestId?: string | null;
  };
};

/** The coupon `stripe:setup` creates for one package's setup credit. */
export function cohortCouponIdFor(plan: Plan): string {
  return `${COHORT_SETUP_CREDIT.couponId}-${plan.id}`;
}

export type CheckoutResult =
  /** Send the browser here to pay. */
  | { kind: "redirect"; url: string; sessionId: string }
  /** No payment configured (development only); the caller provisions immediately. */
  | { kind: "skipped"; reason: string };

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * True on a production deployment, where nothing may be provisioned without
 * payment and nothing may fall back to a development default.
 *
 * `next build` sets NODE_ENV=production, and Vercel's preview deployments run
 * that same build, so NODE_ENV covers every deployment there. VERCEL_ENV is
 * checked as well so that a production deployment is still recognised if it
 * ever runs under some other NODE_ENV. Local development (`next dev`) and the
 * test runner are the only places this is false.
 */
export function isProductionDeployment(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  );
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

/**
 * The origin Stripe sends the buyer back to, for `success_url` and
 * `cancel_url`.
 *
 * Falls back to the local dev server in development, which is where a test
 * checkout should return. In production it refuses instead: NEXT_PUBLIC_SITE_URL
 * is inlined at build time, and a build that lacked it would otherwise charge
 * the customer and then redirect them to localhost on their own machine. The
 * throw lands in /api/checkout's catch, which answers with an error before any
 * Session exists, so nobody is charged. An empty value counts as unset: it
 * would make both URLs relative, which Stripe rejects anyway.
 */
export function siteUrl(): string {
  const configured = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
  if (configured) return configured;
  if (isProductionDeployment()) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is not set. Refusing to send a paying customer back to localhost.",
    );
  }
  return "http://localhost:3000";
}


export async function createCheckout(
  input: CheckoutIntent,
): Promise<CheckoutResult> {
  if (!isBillingConfigured()) {
    if (isProductionDeployment()) {
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

  // A buyer who cancelled at Stripe and pressed Pay again must never hold two
  // Sessions they could both complete. Best effort: a Session already
  // expired, or completed a moment ago, refuses, and that refusal is fine.
  if (input.intent.previousOpenSessionId) {
    await stripe.checkout.sessions.expire(input.intent.previousOpenSessionId).catch(() => undefined);
  }

  // Looked up by the stable keys the setup script writes, so pricing lives in
  // one place (packages/catalog) and a stale price fails loudly here.
  const [setupPriceId, placeholderPriceId] = await Promise.all([
    priceIdFor(stripe, input.plan, "setup"),
    priceIdByLookupKey(stripe, PLAN_START_PLACEHOLDER_LOOKUP_KEY),
  ]);

  const marker = {
    app: APP_MARKER,
    ref: input.intent.ref,
    plan: input.plan.id,
    billingInterval: input.interval,
  };

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer_email: input.contactEmail,
      line_items: [
        // One-time: on the first invoice only. Never on a renewal.
        { price: setupPriceId, quantity: 1 },
        // $0 a month until AYA first answers a patient; see the header.
        { price: placeholderPriceId, quantity: 1 },
      ],
      // On the subscription too, so every later invoice and subscription
      // event, the first invoice above all, can be traced back to the intent.
      subscription_data: { metadata: marker },
      // Collect the card even on a $0 total (a setup credit): the plan's
      // first period is charged to it the day AYA first answers.
      payment_method_collection: "always",
      ...(process.env.STRIPE_AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true } } : {}),
      ...(input.attribution?.offer === "cohort-setup"
        ? { discounts: [{ coupon: cohortCouponIdFor(input.plan) }] }
        : {}),
      custom_text: {
        submit: {
          message: `${planStartSentence(input.plan, input.interval)} The setup fee is non-refundable.`,
        },
      },
      metadata: {
        ...marker,
        ...(input.attribution?.campaign ? { campaign: input.attribution.campaign } : {}),
        ...(input.attribution?.leadId ? { leadId: input.attribution.leadId } : {}),
        ...(input.attribution?.offer ? { offer: input.attribution.offer } : {}),
        ...(input.attribution?.demo ? { demo: input.attribution.demo } : {}),
        ...(input.attribution?.setupRequestId ? { setupRequest: input.attribution.setupRequestId } : {}),
      },
      // Finds the purchase from the Dashboard without opening metadata.
      client_reference_id: input.intent.ref,
      success_url: input.intent.successUrl,
      cancel_url: `${siteUrl()}/get-started?cancelled=1`,
    },
    // One Session per press of Pay: a retried request returns the same one.
    { idempotencyKey: `checkout:${input.intent.ref}:${input.intent.attempt}` },
  );

  if (!session.url) {
    throw new Error("Stripe returned a session with no checkout URL.");
  }
  return { kind: "redirect", url: session.url, sessionId: session.id };
}

/**
 * The metered overage prices a package can bill: the voice meter for a
 * package with voice, the chat meter for one with web or Meta, each at that
 * package's own rate. Pure, so the pairing is testable without Stripe. Which
 * of these a Session actually attaches is `meteredLookupKeysFor()`'s decision.
 */
export function overageLookupKeys(plan: Plan): string[] {
  return planMeteredPrices(plan).map((price) => price.lookupKey);
}

/**
 * The metered prices to put on a Session. None while the rates are
 * provisional; the package's meters for a monthly Session once they are not;
 * and none for an annual one, whose overage is invoiced separately — see the
 * header for all three.
 */
export function meteredLookupKeysFor(
  plan: Plan,
  interval: BillingInterval,
): string[] {
  if (OVERAGE_RATES_PROVISIONAL) return [];
  if (interval === "year") return [];
  return overageLookupKeys(plan);
}

/**
 * Resolve a catalog plan to one of its Stripe prices: the monthly or annual
 * recurring price, or the one-time setup fee.
 *
 * By `lookup_key`, not by a price id in an env var: an env var is a second
 * place for the price to live and a second place for it to be wrong, and the
 * failure mode is charging a customer the wrong amount. The key encodes the
 * amount and the interval (see `stripeLookupKey` in the catalog), so a catalog
 * price change cannot silently resolve to the old price: it fails loudly here
 * until the setup script has been re-run.
 */
async function priceIdFor(
  stripe: Stripe,
  plan: Plan,
  kind: PriceKind,
): Promise<string> {
  return priceIdByLookupKey(stripe, stripeLookupKey(plan, kind));
}

async function priceIdByLookupKey(stripe: Stripe, key: string): Promise<string> {
  const found = await stripe.prices.list({
    lookup_keys: [key],
    active: true,
    limit: 1,
  });

  const price = found.data[0];
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup_key "${key}". ` +
        `Run: STRIPE_SECRET_KEY=… npm run stripe:setup --workspace @healdesk/web ` +
        `(apps/web/scripts/stripe-setup.ts)`,
    );
  }
  return price.id;
}
