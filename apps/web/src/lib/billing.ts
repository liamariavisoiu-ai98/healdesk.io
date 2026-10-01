import {
  type BillingInterval,
  METERS,
  COHORT_SETUP_CREDIT,
  OVERAGE_RATES_PROVISIONAL,
  type Plan,
  type PriceKind,
  stripeLookupKey,
} from "@healdesk/catalog";
import Stripe from "stripe";

import type { ChatChannelChoice } from "@/lib/pricing";

/**
 * Billing, behind an interface.
 *
 * A real implementation when `STRIPE_SECRET_KEY` is present, and one that skips
 * straight to provisioning when it isn't, so the purchase flow stays testable
 * end to end without Stripe keys, while production refuses to hand out free
 * accounts.
 *
 * ## What a Session charges
 *
 * Two line items on one subscription-mode Session: the package's recurring
 * price for the chosen interval, and the package's one-time setup fee. A
 * one-time price is a valid line item in `mode: "subscription"` and Stripe
 * bills it on the FIRST invoice only, alongside the first recurring period:
 * https://docs.stripe.com/payments/checkout/subscriptions/one-time-fees. The
 * SDK's own API reference for `line_items` (stripe-node 22.6.1, generated from
 * Stripe's OpenAPI spec) says the same: "For `subscription` mode, there is a
 * maximum of 20 line items with recurring Prices and 20 line items with
 * one-time Prices. Line items with one-time Prices will be on the initial
 * invoice only."
 *
 * So the first invoice is recurring + setup, exactly the "Due today" figure
 * the checkout step shows (`firstInvoiceUsd` in the catalog), and there is no
 * trial. There used to be one; the catalog header explains why a trial and a
 * setup fee do not compose, and nothing here should reintroduce it.
 *
 * ## The metered overage prices, and when they are attached
 *
 * `stripe:setup` creates one metered price per meter (voice minutes, chat
 * conversations). A subscription only bills meter events for a customer when
 * it carries the metered price as an item, so a Session that omits them sells
 * a package whose overage can never be invoiced. They are omitted here ON
 * PURPOSE while `OVERAGE_RATES_PROVISIONAL` is true: the pricing page refuses
 * to print the rates then, and attaching them would bill a number the buyer
 * was never shown.
 *
 * The flag is off: the owner signed the catalog's rates off on 21 September
 * 2026, so `meteredLookupKeysFor()` attaches both prices to a MONTHLY Session
 * (each only for a package that has the channel) with no `quantity`, which is
 * what the SDK's reference for `line_items` requires of a metered price.
 *
 * Those rates are still placeholders as far as the v1 spec is concerned:
 * overage prices are to be set from measured cost times a target margin
 * (docs/v1-product-spec.md, "What still has to be computed"). That is a
 * pricing decision, not a billing mechanic, so nothing in this module changes
 * because of it, and nothing is billed at them yet either (see the end of the
 * next paragraph). The measured rates, when they exist, change in
 * packages/catalog; until then, setting the flag back to true is the one
 * switch that stops a Session carrying them.
 *
 * An ANNUAL Session gets none, on purpose and not as an oversight: the
 * metered prices bill monthly, the annual package price bills yearly, and one
 * subscription cannot carry both intervals. The decision (21 September 2026)
 * is that annual overage is invoiced separately, monthly in arrears, by hand
 * from the usage the product records — docs/handover.md, "Decisions log",
 * and the `annual-overage-invoicing` task. The terms say exactly that, so an
 * annual buyer is not sold a package whose overage is secretly free; it is
 * just not on the Stripe subscription. Until `usage-meter-events` is built
 * the meters on a monthly subscription bill zero as well.
 *
 * ## The founding-cohort setup credit
 *
 * Day 7 of the nurture sequence offers the first cohort their setup fee
 * back (packages/catalog `COHORT_SETUP_CREDIT`). It is honoured as a Stripe
 * coupon per package — `amount_off` equal to that package's setup fee,
 * `duration: "once"` — created by `stripe:setup`, and attached here as a
 * `discounts` entry only when the checkout route established that the lead
 * was actually offered it within the window. The line item for the setup
 * fee stays on the Session, so the invoice shows the fee and the credit
 * rather than a package that quietly cost less.
 *
 * ## Where the provisioning payload lives
 *
 * In Stripe Session metadata, as one key per field rather than a single JSON
 * blob. Stripe's limits are 50 keys, 40 characters per key, 500 per value; the
 * whole payload serialised as JSON lands around 495 characters for an ordinary
 * customer, which is under the limit only until someone signs up with a long
 * practice name and a hyphenated surname. Per-field, the largest value is
 * `clinicName` at 120 and `contactEmail` at 254, both with room to spare, and
 * 14 keys against a limit of 50 now that `billingInterval` and
 * `chatChannelChoice` ride along with `plan`.
 *
 * It is business contact data, a clinic's name, its owner's work email, not
 * patient data, and Stripe already receives the email as the customer record.
 * Nothing patient-identifying may ever be added here.
 *
 * ## Where the account is created, and where service is switched on
 *
 * Not in this module, and not on the browser returning to the success URL: a
 * customer who closes the tab after paying still gets their account, and
 * someone who hand-crafts a success URL gets nothing. It takes two webhook
 * events, both verified in app/api/webhooks/stripe and relayed to apps/app:
 *
 *   1. `checkout.session.completed` records the account. The webhook forwards
 *      this metadata, `billingInterval` and `chatChannelChoice` included, to
 *      apps/app, which creates the clinic in the `provisioning` billing state.
 *      Nothing is active at this point.
 *   2. The first invoice's `invoice.paid` (`billing_reason:
 *      "subscription_create"`) moves the clinic from `provisioning` to
 *      `active`. Service activates only on that paid invoice, never on the
 *      checkout Session alone.
 *
 * Two steps, because the first invoice carries real money (recurring + setup)
 * rather than a $0 trial invoice, so "completed" is not the same thing as
 * "paid": a delayed payment method can complete the Session with the invoice
 * still open. The activation belongs to the subscription lifecycle handler in
 * apps/app (lib/billing), which also handles renewals, failed payments and
 * cancellation. This module only creates the Session, and the metadata it
 * writes is what those later events are matched back to the clinic with.
 */

export type CheckoutIntent = {
  plan: Plan;
  interval: BillingInterval;
  /**
   * Only meaningful for a package with `chatChannelChoice`, where the buyer
   * picked which chat channel provisioning should enable. Omitted otherwise,
   * so the metadata never carries a choice the package does not offer.
   */
  chatChannelChoice?: ChatChannelChoice;
  clinicName: string;
  contactEmail: string;
  /** Field-per-key on the Session; read back by the webhook. */
  provisionPayload: Record<string, unknown>;
  /**
   * Which cold email, and which lead, this purchase came from. Session-only
   * metadata (not copied to the subscription), stripped by the webhook before
   * the provisioning payload is built, and written back to the lead store as
   * the conversion. Null when organic.
   */
  attribution?: {
    campaign: string | null;
    leadId: string | null;
    /** "cohort-setup" when the lead was offered the founding-cohort credit inside its window. */
    offer?: "cohort-setup" | null;
  };
};

/** The coupon `stripe:setup` creates for one package's setup credit. */
export function cohortCouponIdFor(plan: Plan): string {
  return `${COHORT_SETUP_CREDIT.couponId}-${plan.id}`;
}

export type CheckoutResult =
  /** Send the browser here to pay. */
  | { kind: "redirect"; url: string }
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
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured;
  if (isProductionDeployment()) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is not set. Refusing to send a paying customer back to localhost.",
    );
  }
  return "http://localhost:3000";
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

  // The billing terms are written from the validated intent, not copied from
  // whatever the browser put in the payload under the same names, so the
  // metadata the webhook forwards is the terms Stripe actually charged.
  const metadata = toMetadata({
    ...intent.provisionPayload,
    plan: intent.plan.id,
    billingInterval: intent.interval,
    chatChannelChoice: intent.chatChannelChoice,
  });

  // All looked up by the stable keys the setup script writes, so pricing lives
  // in one place (packages/catalog) and cannot drift into a state where the
  // site quotes $397 and the card is charged $797.
  const [recurringPriceId, setupPriceId, meteredPriceIds] = await Promise.all([
    priceIdFor(stripe, intent.plan, intent.interval),
    priceIdFor(stripe, intent.plan, "setup"),
    Promise.all(
      meteredLookupKeysFor(intent.plan, intent.interval).map((key) =>
        priceIdByLookupKey(stripe, key),
      ),
    ),
  ]);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: intent.contactEmail,

    line_items: [
      { price: recurringPriceId, quantity: 1 },
      // One-time. Billed on the first invoice only; see the header for the
      // Stripe reference. Never on a renewal.
      { price: setupPriceId, quantity: 1 },
      // Metered, so no quantity. Empty while the rates are provisional; see
      // the header.
      ...meteredPriceIds.map((price) => ({ price })),
    ],

    subscription_data: {
      // Also on the subscription, so later invoice and subscription events can
      // be traced back to this clinic without re-reading the Session. The
      // lifecycle handler in apps/app reads `plan` and `billingInterval` from
      // here when an invoice event arrives.
      metadata,
    },

    /**
     * Collect the card up front.
     *
     * This is the subscription-mode default, and it is also the deliberate
     * choice: at $397–1,197/mo sold to clinics, a card at signup is the norm,
     * and with a setup fee on the first invoice there is nothing to defer it
     * for. It also decides what `payment_status` will be on the way back: with
     * a card collected and charged, Stripe reports `paid`; with a delayed
     * method it reports `unpaid` until the invoice settles. See the webhook for
     * why that field must still never be used as the gate.
     */
    payment_method_collection: "always",

    // The founding-cohort credit, only when the route established the offer
    // (see the header). Stripe rejects a Session naming a coupon that does
    // not exist, which is the right failure: run `stripe:setup` first.
    ...(intent.attribution?.offer === "cohort-setup"
      ? { discounts: [{ coupon: cohortCouponIdFor(intent.plan) }] }
      : {}),

    metadata: {
      ...metadata,
      ...(intent.attribution?.campaign ? { campaign: intent.attribution.campaign } : {}),
      ...(intent.attribution?.leadId ? { leadId: intent.attribution.leadId } : {}),
      ...(intent.attribution?.offer ? { offer: intent.attribution.offer } : {}),
    },
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
 * The metered overage prices a package can bill: the voice meter for a
 * package with voice, the chat meter for one with web or Meta. Pure, so the
 * pairing is testable without Stripe. Which of these a Session actually
 * attaches is `meteredLookupKeysFor()`'s decision.
 */
export function overageLookupKeys(plan: Plan): string[] {
  const keys: string[] = [];
  if (plan.channels.voice) keys.push(METERS.voiceMinutes.lookupKey);
  if (plan.channels.web || plan.channels.meta) {
    keys.push(METERS.chatConversations.lookupKey);
  }
  return keys;
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
