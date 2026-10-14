import {
  type BillingInterval,
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planMeteredPrices,
  planStartSentence,
  type PriceKind,
  type SetupCredit,
  setupCouponId,
  SITE_SETUP_CREDIT,
  stripeLookupKey,
  SELF_SERVE_DEMO_SETUP_CREDIT,
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
 * setup fee (one price per package, whatever steps were chosen), and a $0
 * monthly price, "Monthly plan: starts when AYA first
 * answers" (`PLAN_START_PLACEHOLDER_LOOKUP_KEY`). Stripe bills the one-time
 * price on the first invoice only
 * (https://docs.stripe.com/payments/checkout/subscriptions/one-time-fees); the
 * $0 line makes the subscription that holds the card and bills nothing until
 * the day AYA first answers a patient, when apps/app swaps it for the
 * plan's price, the package at the steps bought (Package C). So "Due today"
 * is the setup fee alone, after any setup credit.
 *
 * No trial anywhere. Stripe would treat a trial as one, with the card networks'
 * trial rules and Stripe's "TRIAL OVER" statement wording behind it, and the
 * wait here gives nothing free. Nothing in this module may reintroduce
 * `trial_end`.
 *
 * Subscription mode even when a setup credit brings the total to $0: payment
 * mode collects no card for a $0 total, and the plan's first period needs one.
 * The Session's custom text carries the plan-start sentence and says the setup
 * fee is non-refundable, the two facts a buyer needs at the moment they pay.
 *
 * ## No metered prices at checkout
 *
 * The overage meters only make sense beside a plan price, so they join the
 * subscription with it at the plan start, never at checkout.
 * `meteredLookupKeysFor()` keeps the rules for which apply: the package's own
 * on a monthly plan, and none on an annual one, whose overage is invoiced
 * separately (the 21 September 2026 decision in docs/handover.md).
 *
 * ## The setup credits: one offer, the strongest
 *
 * Three offers take a share of the setup fee off (packages/catalog; owner,
 * 13 October 2026), and a Session carries at most one, the strongest that
 * holds (`chooseSetupOffer`):
 *
 *   - "cohort-setup": the whole fee, offered by Day 7 of the nurture
 *     sequence to one lead, for 14 days (`COHORT_SETUP_CREDIT`);
 *   - "demo-setup-50": half, for a clinic buying from the personalised demo
 *     it was sent, for 48 hours from the demo being ready (`DEMO_SETUP_CREDIT`);
 *   - "site-setup-30": 30%, for anyone buying through the website, for 48
 *     hours from first being shown it (`SITE_SETUP_CREDIT`, lib/site-offer.ts).
 *
 * Each is a Stripe coupon per package (`setupCouponId`), `amount_off` the
 * credit in whole dollars after the catalog's rounding and `duration:
 * "once"`, created by `stripe:setup`. The checkout route decides which applies
 * from server-side facts only (the lead row, the demo row, the signed offer
 * cookie), never from anything the browser says. The setup-fee line stays on
 * the Session, so the invoice shows the fee and the credit.
 *
 * Sessions created before 13 October named "demo-setup-half" and a coupon per
 * 5 October package. Nothing reads the offer back from a Session (the webhook
 * reads only the plan, the demo and the setup request), and Stripe applies the
 * coupon the Session was made with, so an in-flight Session needs nothing
 * here.
 *
 * ## What Stripe carries
 *
 * An opaque ref and nothing about the buyer (design D1). Before this Session
 * exists, the validated purchase is recorded as a sealed purchase record in
 * the marketing Sheet (since 14 October 2026; lib/checkout/records.ts and
 * docs/design/checkout-records-on-vercel-2026-10-14.md), under its ref and
 * which press of Pay this is, and the success URL is this site's own
 * /welcome, which answers while the AWS host is in standby and hands the
 * browser on to apps/app's once the account exists. The Session and its
 * subscription carry `{ app, ref, plan,
 * billingInterval, attempt }`, which bind the payment to the terms of that
 * press, and the Session also carries the attribution ids the lead store
 * reads back: campaign, lead, demo, setup request and the setup offer. Ids,
 * plan ids (`voice-webchat-500-300`) and offer names only: no name, no
 * address, nothing clinical.
 *
 * Cards only, as the contract says: a delayed method would complete the
 * Session, and spend the setup link, before any money had moved.
 *
 * ## Where the account is created
 *
 * On the first paid invoice, never on the Session and never on the browser
 * returning (plan C1, design D2): the webhook relays `invoice.paid` with
 * `billing_reason: "subscription_create"` to apps/app as `{ ref,
 * idempotencyKey: <subscription id>, attempt, plan, billingInterval,
 * records }`, the records being the purchase and the agreement read from the
 * Sheet, and apps/app imports them and provisions from the intent, if it
 * describes what was paid, before the event itself is applied. A paid first invoice is money
 * cleared, so the account and its activation are one moment.
 */

export type CheckoutIntent = {
  plan: Plan;
  interval: BillingInterval;
  contactEmail: string;
  /** The purchase record this Session is for, and which press of Pay this is. */
  intent: {
    ref: string;
    attempt: number;
    /** This site's /welcome, with Stripe's `{CHECKOUT_SESSION_ID}` placeholder (welcomeUrl). */
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
    /** The setup credit this Session carries, if any; see the header. */
    offer?: SetupOffer | null;
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

/** The setup offers a Session can carry, strongest first; see the header. */
export const SETUP_OFFERS = ["cohort-setup", "demo-setup-50", "demo-setup-30", "site-setup-30"] as const;
export type SetupOffer = (typeof SETUP_OFFERS)[number];

/** The catalog credit each offer is. */
export const SETUP_OFFER_CREDITS: Readonly<Record<SetupOffer, SetupCredit>> = {
  "cohort-setup": COHORT_SETUP_CREDIT,
  "demo-setup-50": DEMO_SETUP_CREDIT,
  "demo-setup-30": SELF_SERVE_DEMO_SETUP_CREDIT,
  "site-setup-30": SITE_SETUP_CREDIT,
};

export function isSetupOffer(value: unknown): value is SetupOffer {
  return typeof value === "string" && (SETUP_OFFERS as readonly string[]).includes(value);
}

/** The coupon `stripe:setup` creates for one offer on one plan's package. */
export function setupCouponFor(offer: SetupOffer, plan: Plan): string {
  return setupCouponId(SETUP_OFFER_CREDITS[offer], plan);
}

/** The demo offer a demo carries: 50% from an operator's, 30% from a homepage one (lib/demo `demoSetupCredit`). */
export type DemoOffer = "demo-setup-50" | "demo-setup-30";

export function demoOfferFor(credit: SetupCredit): DemoOffer {
  return credit.couponId === SELF_SERVE_DEMO_SETUP_CREDIT.couponId ? "demo-setup-30" : "demo-setup-50";
}

/**
 * The one setup offer that applies, from when each holds until (null for one
 * that does not hold): the strongest, cohort over demo over website (owner,
 * 13 October 2026). Only one ever applies; they never stack. A homepage
 * demo's 30% and the website's 30% are the same share, so the demo's ranks
 * first only because its clock is the one the buyer was shown. Pure, so the
 * checkout route and /api/checkout/mode cannot rank them differently.
 */
export function chooseSetupOffer(ends: {
  cohort: Date | null;
  demo: Date | null;
  /** Which demo offer `demo` is; the operator's 50% when not given. */
  demoOffer?: DemoOffer;
  site: Date | null;
}): { offer: SetupOffer; endsAt: Date } | null {
  if (ends.cohort) return { offer: "cohort-setup", endsAt: ends.cohort };
  if (ends.demo) return { offer: ends.demoOffer ?? "demo-setup-50", endsAt: ends.demo };
  if (ends.site) return { offer: "site-setup-30", endsAt: ends.site };
  return null;
}

export type CheckoutResult =
  /** Send the browser here to pay. */
  | { kind: "redirect"; url: string; sessionId: string }
  /** The previous attempt's Session was paid: this purchase is done, and nothing new was created. */
  | { kind: "already-paid" }
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
  // Sessions they could both complete, and one who already paid must never be
  // charged again. So the previous attempt's Session is closed first, or this
  // press creates nothing (closePreviousSession).
  if (input.intent.previousOpenSessionId) {
    const previous = await closePreviousSession(stripe, input.intent.previousOpenSessionId);
    if (previous === "paid") return { kind: "already-paid" };
  }

  // Looked up by the stable keys the setup script writes, so pricing lives in
  // one place (packages/catalog) and a stale price fails loudly here.
  const [setupPriceId, placeholderPriceId] = await Promise.all([
    priceIdFor(stripe, input.plan, "setup"),
    priceIdByLookupKey(stripe, PLAN_START_PLACEHOLDER_LOOKUP_KEY),
  ]);

  // The press of Pay this Session belongs to, and the terms it charges for.
  // The webhook relays the ref, the attempt, the plan and the interval from
  // the paid subscription to /api/provision, and apps/app refuses to build
  // the account from an intent that has moved on since (a later press,
  // another package or billing period).
  const marker = {
    app: APP_MARKER,
    ref: input.intent.ref,
    plan: input.plan.id,
    billingInterval: input.interval,
    attempt: String(input.intent.attempt),
  };

  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      // Cards only (funnel-portal-contracts §2): the account shares Stripe
      // with scalabid, whose dashboard settings would otherwise decide, and a
      // delayed method completes the Session before any money moves.
      payment_method_types: ["card"],
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
      // Collect the card even on a $0 total (the cohort credit): the plan's
      // first period is charged to it the day AYA first answers.
      payment_method_collection: "always",
      ...(process.env.STRIPE_AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true } } : {}),
      // At most one setup credit, already chosen by the route; never more
      // than one coupon, so the credits cannot stack.
      ...(input.attribution?.offer ? { discounts: [{ coupon: setupCouponFor(input.attribution.offer, input.plan) }] } : {}),
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
 * Where Stripe sends the browser that has just paid: this site's /welcome,
 * since 14 October 2026, which can answer while the AWS host is in standby
 * (app/welcome/route.ts). `{CHECKOUT_SESSION_ID}` is Stripe's own
 * placeholder. Built from NEXT_PUBLIC_SITE_URL, so production refuses rather
 * than send a paying customer to localhost (siteUrl).
 */
export function welcomeUrl(ref: string): string {
  return `${siteUrl()}/welcome?h=${encodeURIComponent(ref)}&cs={CHECKOUT_SESSION_ID}`;
}

/**
 * Whether Stripe says this Checkout Session completed: the previous press of
 * Pay was paid, and the purchase must not move past it (a second Session would
 * take the setup fee twice, and its nonce cookie would replace the one the paid
 * press's /welcome knows the browser by). Throws when Stripe errs or
 * does not answer within five seconds: the caller refuses the press with
 * nothing recorded, because a Session that may have been paid must never be
 * moved past.
 */
export async function checkoutSessionPaid(sessionId: string): Promise<boolean> {
  const { status } = await stripeClient().checkout.sessions.retrieve(sessionId, undefined, { timeout: 5_000 });
  return status === "complete";
}

/**
 * Whether this Checkout Session is paid, and is the one this purchase opened:
 * our marker, this ref, complete, and its payment through (or none needed, a
 * setup credit's $0). What /welcome asks before it says anything. Null when
 * Stripe cannot be asked.
 */
export async function paidSessionFor(
  sessionId: string,
  ref: string,
): Promise<{ paid: boolean; attempt: number | null } | null> {
  try {
    const session = await stripeClient().checkout.sessions.retrieve(sessionId, undefined, { timeout: 5_000 });
    const ours = session.metadata?.app === APP_MARKER && session.metadata?.ref === ref;
    const paid =
      ours &&
      session.status === "complete" &&
      (session.payment_status === "paid" || session.payment_status === "no_payment_required");
    const attempt = /^[1-9][0-9]{0,8}$/.test(session.metadata?.attempt ?? "") ? Number(session.metadata?.attempt) : null;
    return { paid, attempt };
  } catch (error) {
    console.warn("[healdesk] welcome: the checkout session could not be checked", {
      error: error instanceof Error ? error.name : "unknown error",
    });
    return null;
  }
}

/**
 * Make sure the previous attempt's Session can no longer be paid, or learn
 * that it already was.
 *
 * "paid" when it completed: that purchase is done, and a second Session would
 * take the non-refundable setup fee twice, on a second subscription. "closed"
 * when it is expired, by Stripe or by us now. Anything else throws, and the
 * caller answers 502 having created nothing: a Session that might still be
 * payable must never sit beside a new one.
 *
 * Stripe refuses to expire a Session that is no longer open, with no error
 * code that says which way it went, so a refusal is answered by asking again:
 * it may have been paid, or have expired, in the moment since it was read.
 */
async function closePreviousSession(stripe: Stripe, sessionId: string): Promise<"paid" | "closed"> {
  const settled = (status: string | null): "paid" | "closed" | null =>
    status === "complete" ? "paid" : status === "expired" ? "closed" : null;

  const before = settled((await stripe.checkout.sessions.retrieve(sessionId)).status);
  if (before) return before;
  try {
    await stripe.checkout.sessions.expire(sessionId);
    return "closed";
  } catch (error) {
    const after = settled((await stripe.checkout.sessions.retrieve(sessionId)).status);
    if (after) return after;
    throw error;
  }
}

/**
 * Expire a Session this request created but could not record on its intent:
 * the next press of Pay could not find it to expire it, and the webhook could
 * not bind its payment to the intent's latest terms, so it must never be
 * paid. Its URL is never handed out either. Never throws: the request is
 * refused whatever happens here.
 */
export async function expireUnrecordedCheckout(sessionId: string): Promise<void> {
  try {
    await stripeClient().checkout.sessions.expire(sessionId);
  } catch (error) {
    console.error("[healdesk] could not expire an unrecorded checkout session", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The metered overage prices a plan can bill: the voice meter for a package
 * with voice, the chat meter for one with Web Chat or Meta Chat, each at that
 * product's own rate. Pure, so the pairing is testable without Stripe. Which
 * of these a Session actually attaches is `meteredLookupKeysFor()`'s decision.
 */
export function overageLookupKeys(plan: Plan): string[] {
  return planMeteredPrices(plan).map((price) => price.lookupKey);
}

/**
 * The metered prices a subscription on this plan carries once it starts. None
 * while `OVERAGE_RATES_PROVISIONAL` is true; the plan's meters on a monthly
 * plan once it is not; and none on an annual one, whose overage is invoiced
 * separately — see the header.
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
 * recurring price, or the one-time setup fee (its package's).
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
