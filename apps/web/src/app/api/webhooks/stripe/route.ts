import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";
import type Stripe from "stripe";

import { APP_MARKER, isBillingConfigured, stripeClient } from "@/lib/billing";

/**
 * POST /api/webhooks/stripe — turn a completed checkout into an account.
 *
 * This is the ONLY place provisioning is triggered from in the paid flow. Not
 * the success URL: a buyer who closes the tab after paying still gets their
 * account, and a stranger who hand-crafts a success URL gets nothing.
 *
 * ## Stripe retries EVERY non-2xx, for up to three days
 *
 * That single fact shapes every status code below, and it is the thing most
 * webhook handlers get wrong. There is no "4xx means don't retry" rule for
 * webhook deliveries — that rule exists, but for custom actions and remote
 * functions, a different product surface. So a status code here is not a
 * retry-suppression mechanism; it is a choice between "try me again" and "stop,
 * this is handled".
 *
 * The consequence that matters: any failure which a later attempt could fix
 * must be non-2xx, and any failure which no attempt will ever fix must be 2xx
 * plus a loud noise, because three days of retries against a permanent error
 * ends with the endpoint disabled and every subsequent sale lost.
 *
 * ## Why apps/web and not apps/app
 *
 * The Stripe secret lives here and the database lives there. This route
 * verifies the signature, then hands the payload to apps/app over the same
 * HMAC channel checkout uses — so exactly one service still holds a connection
 * to the database that will eventually contain PHI.
 */

/**
 * Node is the default in this Next version and `edge` is deprecated, so this
 * export is redundant — kept for the same reason every other route here has it,
 * and because the dependency is hard rather than incidental: `constructEvent`
 * needs Node crypto, and @healdesk/catalog's request signing imports
 * `node:crypto` directly. Under an edge runtime Stripe falls back to a
 * SubtleCrypto provider whose synchronous verify throws, failing every delivery.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bigger than any Stripe event, small enough to be cheap. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Deliberately NOT rate limited.
 *
 * `clientKey` buckets by IP, and Stripe delivers from a small pool — so every
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
  // self-healing once the value is set — so it must return non-2xx and let
  // Stripe re-deliver the backlog. Answering 400 here would acknowledge and
  // discard every real sale while the secret was wrong.
  if (!isBillingConfigured() || !webhookSecret || !appUrl || !provisionSecret) {
    console.error(
      "[healdesk] stripe webhook not configured; asking Stripe to retry",
    );
    return new Response("Webhook not configured.", { status: 500 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return new Response("Payload too large.", { status: 413 });
  }

  // The RAW body. Next's App Router never parses it for you and there is no
  // bodyParser segment config to disable — but re-serialising it (JSON.parse
  // then stringify) changes bytes and the signature will not verify.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response("Payload too large.", { status: 413 });
  }

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
    // secret IS configured, so the likely cause is a forged request — which
    // Stripe never sent and therefore never retries.
    console.warn("[healdesk] stripe signature rejected", error);
    return new Response("Invalid signature.", { status: 400 });
  }

  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded"
  ) {
    return Response.json({ received: true });
  }

  const session = event.data.object;

  // One Stripe account serves healdesk and scalabid, and the endpoint's
  // event-type filter does not separate them. Anything without our marker is
  // someone else's traffic: acknowledge so it never counts against this
  // endpoint's failure rate, but say so — a healdesk sale arriving without
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
   * `payment_method_collection` at session creation. With a card collected
   * Stripe processes a $0 trial invoice and reports `paid`; with
   * `if_required` and a trial it reports `no_payment_required`. A
   * `payment_status !== "paid"` guard therefore looks correct, passes review,
   * and silently drops every trial signup the day someone flips that setting.
   *
   * `status === "complete"` means the customer finished checkout, which is the
   * thing we actually care about, under either setting.
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
    // Stamped here, from the verified event — never from the browser. Returning
    // a prior result for a caller-chosen key would leak another clinic's ids.
    // The SESSION id, not the event id: every event about this purchase carries
    // the same `cs_…`, so this dedupes the purchase rather than the delivery.
    idempotencyKey: session.id,
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL("/api/provision", appUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, provisionSecret),
      },
      body,
    });
  } catch (error) {
    console.error(
      "[healdesk] provisioning unreachable from stripe webhook",
      event.id,
      session.id,
      error,
    );
    return new Response("Provisioning unreachable.", { status: 500 });
  }

  // 200 (replayed) and 201 (created) are both success. The idempotency ledger
  // in apps/app is what makes a duplicate delivery a no-op rather than a second
  // account, so retries land here harmlessly.
  if (response.ok) {
    return Response.json({ received: true });
  }

  // 401 reads permanent but is the one 4xx that retrying fixes: a desynced
  // HEALDESK_PROVISION_SECRET mid-rotation, or clock skew past the signing
  // window. Both self-heal. 429 and 5xx likewise.
  if (
    response.status >= 500 ||
    response.status === 401 ||
    response.status === 429
  ) {
    console.error(
      "[healdesk] provisioning failed, retryable",
      event.id,
      response.status,
    );
    return new Response("Provisioning failed.", { status: 500 });
  }

  // 400/422: deterministic, built from metadata we wrote ourselves, and so
  // identical on all three days of retries. Acknowledge to save the endpoint —
  // but this is money taken with no account, so it must be the loudest line in
  // the file. Never echo apps/app's error body: the reader here is the Stripe
  // Dashboard event log.
  console.error(
    "[healdesk] PROVISIONING REJECTED — paid customer has no account",
    { event: event.id, session: session.id, status: response.status },
  );
  return Response.json({ received: true, provisioned: false });
}

/**
 * Rebuild the provisioning request from Stripe metadata.
 *
 * Metadata values are ALWAYS strings, and provisioning requires
 * `averageTreatmentValueUsd` to be a number. Spreading the metadata object
 * straight through therefore 422s every estimated-attribution signup — which is
 * the default and by far the most common path — so the coercion below is the
 * difference between this working and silently rejecting nearly every sale.
 */
export function provisionRequestFromMetadata(
  metadata: Stripe.Metadata,
): Record<string, unknown> {
  const {
    app: _app,
    averageTreatmentValueUsd,
    ...rest
  } = metadata as Record<string, string | undefined>;

  const request: Record<string, unknown> = { ...rest };

  if (averageTreatmentValueUsd !== undefined) {
    request.averageTreatmentValueUsd = Number(averageTreatmentValueUsd);
  }
  return request;
}
