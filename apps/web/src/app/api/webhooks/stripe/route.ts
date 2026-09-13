import {
  getPlan,
  isBillingInterval,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";
import type Stripe from "stripe";

import { APP_MARKER, isBillingConfigured, stripeClient } from "@/lib/billing";
import { markCheckoutAbandoned, markConverted } from "@/lib/leads";
import { isChatChannelChoice } from "@/lib/pricing";

/**
 * POST /api/webhooks/stripe — every Stripe event we act on, verified here and
 * relayed to apps/app.
 *
 * Two kinds of event, two destinations:
 *
 *   - `checkout.session.completed` (and its async twin) provisions the
 *     account, via /api/provision. This is the ONLY place provisioning is
 *     triggered from in the paid flow. Not the success URL: a buyer who closes
 *     the tab after paying still gets their account, and a stranger who
 *     hand-crafts a success URL gets nothing.
 *   - Everything in LIFECYCLE_EVENTS — the first invoice paying, renewals,
 *     failed cards, plan changes, pauses, cancellations, chargebacks — goes to
 *     /api/billing/events as the full verified event, where apps/app applies
 *     it to the clinic's entitlements (apps/app/src/lib/billing/events.ts).
 *     A pause is a FIELD on `customer.subscription.updated`
 *     (`pause_collection`), not a `customer.subscription.paused` event: that
 *     event only fires when a trial ends without a card, and there is no
 *     trial, so it is not subscribed to and not relayed.
 *
 * ## Stripe retries EVERY non-2xx, for up to three days
 *
 * That single fact shapes every status code below, and it is the thing most
 * webhook handlers get wrong. There is no "4xx means don't retry" rule for
 * webhook deliveries. That rule exists, but for custom actions and remote
 * functions, a different product surface. So a status code here is not a
 * retry-suppression mechanism; it is a choice between "try me again" and "stop,
 * this is handled".
 *
 * The consequence that matters: any failure which a later attempt could fix
 * must be non-2xx, and any failure which no attempt will ever fix must be 2xx
 * plus a loud noise, because three days of retries against a permanent error
 * ends with the endpoint disabled and every subsequent sale — and every
 * clinic's renewal — lost.
 *
 * ## Why apps/web and not apps/app
 *
 * The Stripe secret lives here and the database lives there. This route
 * verifies the signature, then hands the payload to apps/app over the same
 * HMAC channel checkout uses, so exactly one service still holds a connection
 * to the database that will eventually contain PHI.
 */

/**
 * Node is the default in this Next version and `edge` is deprecated, so this
 * export is redundant, kept for the same reason every other route here has it,
 * and because the dependency is hard rather than incidental: `constructEvent`
 * needs Node crypto, and @healdesk/catalog's request signing imports
 * `node:crypto` directly. Under an edge runtime Stripe falls back to a
 * SubtleCrypto provider whose synchronous verify throws, failing every delivery.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bigger than any Stripe event. Checked AFTER the signature, and answered
 * with a 200 when exceeded — see the size check in POST for why a 413 here
 * would be the "permanent failure answered with a retryable status" the
 * header warns about.
 */
const MAX_BODY_BYTES = 1_000_000;

type EventType = Stripe.Event["type"];

const PROVISIONING_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/**
 * The buyer left. Nothing to provision and nothing to relay; the lead store
 * records the abandonment so the one follow-up email can go (lib/email).
 * Subscribe the endpoint to this event too (docs/handover.md).
 */
const ABANDONMENT_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["checkout.session.expired"]);

/**
 * Must match HANDLED_EVENT_TYPES in apps/app/src/lib/billing/events.ts, minus
 * the two above. Anything else Stripe is configured to send is acknowledged
 * and dropped here rather than relayed, so apps/app's ledger only ever holds
 * events somebody meant to handle.
 */
const LIFECYCLE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.dispute.created",
]);

/**
 * Deliberately NOT rate limited.
 *
 * `clientKey` buckets by IP, and Stripe delivers from a small pool, so every
 * delivery would share one bucket. Worse, the natural time to exceed a limit is
 * the retry burst after an apps/app outage, i.e. exactly when the events matter
 * most; 429s would then extend the outage into an escalating retry loop. The
 * signature is the access control here, and it is a better one than a counter.
 */
export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const appUrl = process.env.HEALDESK_APP_URL;
  const provisionSecret = process.env.HEALDESK_PROVISION_SECRET;

  // Config gate BEFORE verification, and 500 rather than 400.
  //
  // A missing or wrong STRIPE_WEBHOOK_SECRET makes every GENUINE event fail
  // verification. That is the single most likely fault at launch, and it is
  // self-healing once the value is set, so it must return non-2xx and let
  // Stripe re-deliver the backlog. Answering 400 here would acknowledge and
  // discard every real sale while the secret was wrong.
  if (!isBillingConfigured() || !webhookSecret || !appUrl || !provisionSecret) {
    console.error(
      "[healdesk] stripe webhook not configured; asking Stripe to retry",
    );
    return new Response("Webhook not configured.", { status: 500 });
  }

  // The RAW body. Next's App Router never parses it for you and there is no
  // bodyParser segment config to disable, but re-serialising it (JSON.parse
  // then stringify) changes bytes and the signature will not verify.
  const raw = await request.text();

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature.", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripeClient().webhooks.constructEvent(
      raw,
      signature,
      webhookSecret,
    );
  } catch (error) {
    // 400 here is a convention, not a retry-suppressor. Reached only when the
    // secret IS configured, so the likely cause is a forged request, which
    // Stripe never sent and therefore never retries.
    console.warn("[healdesk] stripe signature rejected", error);
    return new Response("Invalid signature.", { status: 400 });
  }

  // Size, AFTER verification. A body this large that Stripe genuinely signed
  // is one Stripe will re-send, unchanged, for three days if it gets anything
  // but a 2xx — so it is acknowledged, loudly, and skipped, and the endpoint
  // stays up. Before verification the check was reachable by anyone and its
  // 413 protected nothing the signature does not: `constructEvent` bounds the
  // work, and a forged body of any size ends at the 400 above.
  if (raw.length > MAX_BODY_BYTES) {
    console.error("[healdesk] stripe event too large to relay; skipped", {
      event: event.id,
      type: event.type,
      bytes: raw.length,
    });
    return Response.json({ received: true, skipped: "too-large" });
  }

  const relay = { appUrl, secret: provisionSecret };

  if (PROVISIONING_EVENTS.has(event.type)) {
    return provision(event, relay);
  }
  if (ABANDONMENT_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.app === APP_MARKER && session.customer_email) {
      await markCheckoutAbandoned(session.customer_email);
    }
    return Response.json({ received: true });
  }
  if (LIFECYCLE_EVENTS.has(event.type)) {
    return forwardLifecycle(event, relay);
  }
  return Response.json({ received: true });
}

type Relay = { appUrl: string; secret: string };

// -----------------------------------------------------------------------------
// Provisioning
// -----------------------------------------------------------------------------

async function provision(event: Stripe.Event, relay: Relay): Promise<Response> {
  const session = event.data.object as Stripe.Checkout.Session;

  // One Stripe account serves healdesk and scalabid, and the endpoint's
  // event-type filter does not separate them. Anything without our marker is
  // someone else's traffic: acknowledge so it never counts against this
  // endpoint's failure rate, but say so, a healdesk sale arriving without
  // metadata would be money taken with no account, and that must not be a
  // silent 200 the way the payment_status trap was.
  if (session.metadata?.app !== APP_MARKER) {
    console.warn(
      "[healdesk] stripe session without healdesk marker; ignoring",
      event.id,
      session.id,
    );
    return Response.json({ received: true, skipped: "not-healdesk" });
  }

  /**
   * Gate on `status`, NEVER on `payment_status`.
   *
   * `payment_status` is the trap this whole flow was rebuilt around: it is
   * `paid | unpaid | no_payment_required`, and which one you get depends on
   * the payment method and on `payment_method_collection` at session
   * creation. A card charged on the spot reports `paid`; a delayed method
   * (a bank debit) completes the Session with the invoice still open and
   * reports `unpaid` until it settles. A `payment_status !== "paid"` guard
   * therefore looks correct, passes review, and silently drops every
   * delayed-method signup — and it is not even the right question, because
   * "has the first invoice been paid" is answered by `invoice.paid` in
   * apps/app, which is what moves the clinic from `provisioning` to
   * `active`. Provisioning only needs to know the buyer finished checkout.
   *
   * `status === "complete"` means exactly that, under every setting.
   */
  if (session.status !== "complete") {
    console.warn(
      "[healdesk] stripe session not complete; ignoring",
      event.id,
      session.status,
    );
    return Response.json({ received: true, skipped: session.status });
  }

  const body = JSON.stringify({
    ...provisionRequestFromMetadata(session.metadata),
    // Stamped here, from the verified event, never from the browser. Returning
    // a prior result for a caller-chosen key would leak another clinic's ids.
    // The SESSION id, not the event id: every event about this purchase carries
    // the same `cs_…`, so this dedupes the purchase rather than the delivery.
    idempotencyKey: session.id,
    // The ids every later lifecycle event will be matched back to the clinic
    // with. From the verified Session for the same reason as the key above:
    // a browser-supplied subscription id would let anyone attach their
    // account to somebody else's paid subscription.
    stripeCustomerId: refId(session.customer),
    stripeSubscriptionId: refId(session.subscription),
  });

  const result = await relayTo("/api/provision", body, relay);

  switch (result.kind) {
    case "ok":
      // 200 (replayed) and 201 (created) are both success. The idempotency
      // ledger in apps/app is what makes a duplicate delivery a no-op rather
      // than a second account, so retries land here harmlessly.
      //
      // Close the funnel loop: the lead becomes a customer, with the plan and
      // its monthly revenue, so the cold-email question ("which campaign paid")
      // has an answer in the lead store. Best-effort and after the account
      // exists — a lead-store outage must never fail a paid provisioning.
      await recordConversion(session);
      return Response.json({ received: true });

    case "unreachable":
      console.error(
        "[healdesk] provisioning unreachable from stripe webhook",
        event.id,
        session.id,
        result.error,
      );
      return new Response("Provisioning unreachable.", { status: 500 });

    case "retryable":
      console.error(
        "[healdesk] provisioning failed, retryable",
        event.id,
        result.status,
      );
      return new Response("Provisioning failed.", { status: 500 });

    case "rejected":
      // 400/422: deterministic, built from metadata we wrote ourselves, and so
      // identical on all three days of retries. Acknowledge to save the
      // endpoint, but this is money taken with no account, so it must be the
      // loudest line in the file. Never echo apps/app's error body: the reader
      // here is the Stripe Dashboard event log.
      console.error(
        "[healdesk] PROVISIONING REJECTED, paid customer has no account",
        { event: event.id, session: session.id, status: result.status },
      );
      return Response.json({ received: true, provisioned: false });
  }
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

async function forwardLifecycle(
  event: Stripe.Event,
  relay: Relay,
): Promise<Response> {
  // The marker check, with one difference from provisioning: a lifecycle
  // event's marker lives on the subscription (or the invoice's frozen copy of
  // its metadata), not on a Session, and some events carry none at all. A
  // marker that names ANOTHER app is skipped — that is scalabid's traffic on
  // the shared account. A marker that is simply absent is forwarded with a
  // warning, because a healdesk subscription's renewal invoice must never be
  // dropped for a missing field; apps/app resolves the clinic by Stripe id
  // and ignores what it does not recognise.
  const marker = markerOf(event);
  if (marker !== null && marker !== APP_MARKER) {
    return Response.json({ received: true, skipped: "not-healdesk" });
  }
  if (marker === null) {
    console.warn(
      "[healdesk] stripe lifecycle event without app marker; forwarding anyway",
      event.id,
      event.type,
    );
  }

  const forwarded = await expandForResolution(event);
  const result = await relayTo("/api/billing/events", JSON.stringify(forwarded), relay);

  switch (result.kind) {
    case "ok":
      return Response.json({ received: true });

    case "unreachable":
      console.error(
        "[healdesk] billing events unreachable from stripe webhook",
        event.id,
        event.type,
        result.error,
      );
      return new Response("Billing events unreachable.", { status: 500 });

    case "retryable":
      // apps/app answers 500 only when it recorded a failure and wants the
      // retry; after MAX_FAILURES it dead-letters and answers 200 itself.
      console.error(
        "[healdesk] billing event failed, retryable",
        event.id,
        event.type,
        result.status,
      );
      return new Response("Billing event failed.", { status: 500 });

    case "rejected":
      // A 400 from apps/app means the relay is broken, not the event: the
      // body is Stripe's own JSON. Loud, and 200 so the endpoint survives.
      console.error(
        "[healdesk] BILLING EVENT REJECTED, clinic state may be stale",
        { event: event.id, type: event.type, status: result.status },
      );
      return Response.json({ received: true, applied: false });
  }
}

/**
 * A dispute names a charge by id, and only the charge names the customer —
 * which is the only handle apps/app has to find the clinic (a dispute has no
 * subscription). So the charge is expanded here, where the Stripe key is,
 * exactly as `expand: ["charge"]` would have: the forwarded JSON is still the
 * verified event of the same type, with one reference resolved into the
 * object it referenced. If Stripe cannot be reached the event goes as it is,
 * and apps/app records it as unresolvable rather than losing it.
 */
async function expandForResolution(event: Stripe.Event): Promise<Stripe.Event> {
  if (event.type !== "charge.dispute.created") return event;

  const dispute = event.data.object;
  if (typeof dispute.charge !== "string") return event;

  try {
    const charge = await stripeClient().charges.retrieve(dispute.charge);
    return {
      ...event,
      data: { ...event.data, object: { ...dispute, charge } },
    };
  } catch (error) {
    console.warn(
      "[healdesk] could not expand disputed charge; forwarding unexpanded",
      event.id,
      error,
    );
    return event;
  }
}

/**
 * Where the `app` marker is on each object, allowing for the API version the
 * endpoint is pinned to: an invoice's copy of the subscription metadata moved
 * from `invoice.subscription_details` to `invoice.parent.subscription_details`.
 */
function markerOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const invoice = event.data.object;
      const legacy = (
        invoice as { subscription_details?: { metadata?: Stripe.Metadata | null } | null }
      ).subscription_details;
      return (
        invoice.parent?.subscription_details?.metadata?.app ??
        legacy?.metadata?.app ??
        invoice.metadata?.app ??
        null
      );
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return event.data.object.metadata?.app ?? null;
    case "charge.dispute.created": {
      // Only present once expanded, which happens after this check; a dispute
      // is therefore always forwarded, and apps/app decides.
      const charge = event.data.object.charge;
      return typeof charge === "string" ? null : (charge.metadata?.app ?? null);
    }
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// The relay
// -----------------------------------------------------------------------------

type RelayResult =
  | { kind: "ok" }
  | { kind: "unreachable"; error: unknown }
  /** 5xx, 401, 429: a later attempt can succeed. */
  | { kind: "retryable"; status: number }
  /** Any other 4xx: deterministic, no attempt will ever succeed. */
  | { kind: "rejected"; status: number };

/**
 * POST a signed body to apps/app and classify the answer.
 *
 * 401 reads permanent but is the one 4xx that retrying fixes: a desynced
 * HEALDESK_PROVISION_SECRET mid-rotation, or clock skew past the signing
 * window. Both self-heal. 429 and 5xx likewise. Everything else 4xx is
 * something a retry cannot change.
 */
async function relayTo(
  path: string,
  body: string,
  relay: Relay,
): Promise<RelayResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL(path, relay.appUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, relay.secret),
      },
      body,
    });
  } catch (error) {
    return { kind: "unreachable", error };
  }

  if (response.ok) return { kind: "ok" };
  if (
    response.status >= 500 ||
    response.status === 401 ||
    response.status === 429
  ) {
    return { kind: "retryable", status: response.status };
  }
  return { kind: "rejected", status: response.status };
}

/** A Stripe reference is an id, or the expanded object carrying one. */
function refId(
  value: string | { id: string } | null | undefined,
): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

/**
 * Rebuild the provisioning request from Stripe metadata.
 *
 * Metadata values are ALWAYS strings, and provisioning requires
 * `averageTreatmentValueUsd` to be a number. Spreading the metadata object
 * straight through therefore 422s every estimated-attribution signup, which is
 * the default and by far the most common path, so the coercion below is the
 * difference between this working and silently rejecting nearly every sale.
 *
 * `billingInterval` and `chatChannelChoice` are checked against the catalog
 * rather than passed through as whatever string was stored: provisioning
 * validates them too, but a bad value there is a 422 on a paid sale, and the
 * only way one gets into the metadata is a bug in createCheckout(). Dropping
 * an unrecognised value falls back to provisioning's own defaults (monthly,
 * web), which is a wrong allowance that support can fix, rather than no
 * account at all.
 */
export function provisionRequestFromMetadata(
  metadata: Stripe.Metadata,
): Record<string, unknown> {
  const {
    app: _app,
    // Attribution rides on the Session for the lead store, never for apps/app.
    campaign: _campaign,
    leadId: _leadId,
    averageTreatmentValueUsd,
    billingInterval,
    chatChannelChoice,
    ...rest
  } = metadata as Record<string, string | undefined>;

  const request: Record<string, unknown> = { ...rest };

  if (averageTreatmentValueUsd !== undefined) {
    request.averageTreatmentValueUsd = Number(averageTreatmentValueUsd);
  }
  if (isBillingInterval(billingInterval)) {
    request.billingInterval = billingInterval;
  }
  if (isChatChannelChoice(chatChannelChoice)) {
    request.chatChannelChoice = chatChannelChoice;
  }
  return request;
}

/** The lead store's view of a completed purchase. Never throws. */
async function recordConversion(session: Stripe.Checkout.Session): Promise<void> {
  try {
    const email = session.customer_email ?? session.customer_details?.email;
    if (!email) return;
    const plan = getPlan(String(session.metadata?.plan ?? ""));
    const interval = session.metadata?.billingInterval;
    const mrr = plan ? (interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd) : 0;
    await markConverted({ email, plan: plan?.id ?? "unknown", mrrUsd: mrr });
  } catch (error) {
    console.error("[healdesk] could not record conversion in the lead store", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
