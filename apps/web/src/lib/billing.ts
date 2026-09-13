import {
  type BillingInterval,
  METERS,
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
 * ## The metered overage prices, and why they are NOT attached yet
 *
 * `stripe:setup` creates one metered price per meter (voice minutes, chat
 * conversations). A subscription only bills meter events for a customer when
 * it carries the metered price as an item, so a Session that omits them sells
 * a package whose overage can never be invoiced. They are omitted here ON
 * PURPOSE while `OVERAGE_RATES_PROVISIONAL` is true: the rates in the catalog
 * are placeholders nobody signed, the pricing page refuses to print them, and
 * attaching them would bill a number the buyer was never shown. The pricing
 * page says overage is not billed until the rates are published, and this is
 * the line that makes that true.
 *
 * The moment the flag flips, `meteredLookupKeysFor()` attaches both prices
 * (each only for a package that has the channel) with no `quantity`, which is
 * what the SDK's reference for `line_items` requires of a metered price. It
 * also REFUSES an annual Session: the metered prices bill monthly, the annual
 * package price bills yearly, and one subscription cannot carry both
 * intervals without a decision this module must not make on its own — a
 * yearly metered price would bill a year of overage in one line, a separate
 * monthly subscription doubles every event handler's idea of "the
 * subscription". Deciding that is the price of flipping the flag; until then
 * annual clinics' overage is not billed either way, and the throw is what
 * makes sure the flip cannot quietly leave it that way.
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
 * ## Where provisioning actually happens
 *
 * Not in this module, and not on the browser returning to the success URL: a
 * customer who closes the tab after paying still gets their account, and
 * someone who hand-crafts a success URL gets nothing. The webhook in
 * app/api/webhooks/stripe fires provisioning on `checkout.session.completed`
 * and forwards this metadata, `billingInterval` and `chatChannelChoice`
 * included, to apps/app.
 *
 * Because the first invoice now carries real money (recurring + setup) rather
 * than a $0 trial invoice, "completed" is not the same thing as "paid": a
 * delayed payment method can complete the Session with the invoice still open.
 * Provisioning therefore has to gate on `invoice.paid`, and that is owned by the
 * subscription lifecycle handler in apps/app (lib/billing), which also handles
 * renewals, failed payments and cancellation. This module only creates the
 * Session, and the metadata it writes is what those later events are matched
 * back to the clinic with.
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
  attribution?: { campaign: string | null; leadId: string | null };
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

    metadata: {
      ...metadata,
      ...(intent.attribution?.campaign ? { campaign: intent.attribution.campaign } : {}),
      ...(intent.attribution?.leadId ? { leadId: intent.attribution.leadId } : {}),
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
 * and a refusal for an annual one — see the header for all three.
 */
export function meteredLookupKeysFor(
  plan: Plan,
  interval: BillingInterval,
): string[] {
  if (OVERAGE_RATES_PROVISIONAL) return [];
  if (interval === "year") {
    throw new Error(
      "Overage rates are live but annual overage billing is undecided: the " +
        "metered prices bill monthly and cannot share a subscription with a " +
        "yearly package price. Decide the annual path (see the header of " +
        "apps/web/src/lib/billing.ts) before selling annual packages.",
    );
  }
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
