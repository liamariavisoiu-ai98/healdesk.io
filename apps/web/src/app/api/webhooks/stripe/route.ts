import { getPlan, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import type Stripe from "stripe";

import type { SealedRecord } from "@healdesk/catalog/checkout-record";

import { APP_MARKER, isBillingConfigured, stripeClient } from "@/lib/billing";
import {
  findAgreementRecord,
  intentRecordsFor,
  markAgreementProvisioned,
  markIntentProvisioned,
  recordsConfigured,
} from "@/lib/checkout/records";
import { postInternalAlert } from "@/lib/demo/alert";
import { wakeHostForPaidInvoice } from "@/lib/host/wake";
import { demoVariant } from "@/lib/demo/close";
import { recordDemoEvent } from "@/lib/demo/events";
import { displayName, markDemoClaimed } from "@/lib/demo/sessions";
import { markCheckoutAbandoned, markConverted } from "@/lib/leads";
import { updateSetupRequest } from "@/lib/setup-requests";

/**
 * POST /api/webhooks/stripe — every Stripe event we act on, verified here and
 * relayed to apps/app.
 *
 * Three moments:
 *
 *   - `checkout.session.completed` (and its async twin) closes the funnel in
 *     the lead store (the conversion, and the setup link spent) once its
 *     payment has gone through, and creates nothing. A completed Session is
 *     not money cleared.
 *   - The FIRST invoice's `invoice.paid` (`billing_reason:
 *     "subscription_create"`) creates the account: it is relayed to
 *     /api/provision as `{ ref, idempotencyKey: <subscription id>, attempt,
 *     plan, billingInterval, hostedInvoiceUrl, records }`, `records` being
 *     the sealed purchase record of the press that was paid and the sealed
 *     agreement record it names, read from the marketing Sheet, where they
 *     have been kept since 14 October 2026 so a buyer can sign and pay while
 *     the AWS host is in standby (lib/checkout/records.ts,
 *     docs/design/checkout-records-on-vercel-2026-10-14.md). apps/app checks
 *     both seals, imports them and provisions, if the purchase names the
 *     press and the terms that were paid (plan C1, design D2); the invoice's
 *     hosted page is the setup-fee receipt the welcome email links. Only then is
 *     the event itself forwarded, so the clinic it activates exists. The
 *     account is made on the first
 *     paid invoice, as docs/v1-product-spec.md ("Stage 1, payment") says, and
 *     never on the success URL: a buyer who closes the tab still gets it, and
 *     a stranger who hand-crafts that URL gets nothing.
 *   - Everything else in LIFECYCLE_EVENTS (renewals, failed cards, plan
 *     changes, cancellations, refunds, chargebacks) goes to
 *     /api/billing/events as the full verified event, where apps/app applies
 *     it (apps/app/src/lib/billing/events.ts). A pause is a FIELD on
 *     `customer.subscription.updated` (`pause_collection`), not a
 *     `customer.subscription.paused` event: that event only fires when a
 *     trial ends without a card, and there is no trial, so it is not
 *     subscribed to and not relayed.
 *
 * No branch reads a purchase out of Session metadata any more. That path
 * carried the buyer's details through Stripe and provisioned on a completed
 * Session; it was removed with the move to intents, when no live Session
 * could still carry it (production checkout was closed, by invitation and by
 * an unset HEALDESK_APP_URL, for the whole of the 24 hours before).
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

/**
 * Checkout completion closes the funnel in the lead store and creates
 * nothing: the account is made on the first paid invoice (see the header).
 */
const COMPLETION_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

/**
 * The buyer left. Nothing to provision and nothing to relay; the lead store
 * records the expiry, with the purchase's ref, so the one follow-up email (P7,
 * 24 hours later, lib/email/nurture.ts) can go.
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
  // Refunds (the first-period guarantee; the setup fee is never refunded).
  // apps/app records what it does not handle yet as ignored, so relaying it
  // ahead of Package C's handler loses nothing.
  "charge.refunded",
  "charge.dispute.created",
]);

/**
 * Lifecycle events whose object normally carries no marker: a charge has no
 * subscription metadata, so a refund or a dispute is forwarded unmarked as a
 * matter of course, and apps/app finds the clinic by customer. Only a marker
 * naming another app skips one.
 */
const UNMARKED_BY_NATURE: ReadonlySet<EventType> = new Set<EventType>([
  "charge.refunded",
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

  if (COMPLETION_EVENTS.has(event.type)) {
    return recordCompletion(event);
  }
  if (ABANDONMENT_EVENTS.has(event.type)) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.metadata?.app === APP_MARKER && session.customer_email) {
      // The ref lets P7 read the purchase's own records when it is due.
      await markCheckoutAbandoned(session.customer_email, { ref: session.metadata?.ref ?? null });
    }
    return Response.json({ received: true });
  }
  if (LIFECYCLE_EVENTS.has(event.type)) {
    const first = firstInvoiceOf(event);
    if (first) {
      const provisioned = await provisionFromIntent(event, first, relay);
      if (provisioned) return provisioned;
    }
    return forwardLifecycle(event, relay);
  }
  return Response.json({ received: true });
}

type Relay = { appUrl: string; secret: string };

// -----------------------------------------------------------------------------
// Checkout completion, and the first paid invoice
// -----------------------------------------------------------------------------

/**
 * A paid Session closes the funnel in the lead store, and nothing more: the
 * conversion is recorded and the setup link spent only once the money has
 * moved, which is `payment_status` "paid" (or "no_payment_required", a setup
 * credit's $0 total), or the async-succeeded event. Checkout is cards only,
 * but a Session that completes with its payment still pending must not
 * spend the link: if that payment then failed, no account would ever be made
 * and the buyer could not try again. The account itself is the first paid
 * invoice's business.
 */
async function recordCompletion(event: Stripe.Event): Promise<Response> {
  const session = event.data.object as Stripe.Checkout.Session;
  // One Stripe account serves healdesk and scalabid, and the endpoint's
  // event-type filter does not separate them.
  if (session.metadata?.app !== APP_MARKER) {
    return Response.json({ received: true, skipped: "not-healdesk" });
  }
  if (session.status !== "complete") {
    return Response.json({ received: true, skipped: session.status });
  }
  const paid =
    event.type === "checkout.session.async_payment_succeeded" ||
    session.payment_status === "paid" ||
    session.payment_status === "no_payment_required";
  if (!paid) {
    return Response.json({ received: true, skipped: "awaiting-payment" });
  }
  await recordConversion(session);
  await markSetupLinkUsed(session);
  return Response.json({ received: true });
}

/**
 * The purchase a paid first invoice completes, and what was paid: the press
 * of Pay (`attempt`) and the package and billing period its Session charged
 * for, from the subscription metadata createCheckout wrote. apps/app refuses
 * to provision when they are not the intent's latest terms. A value that is
 * missing or malformed is relayed as null, and refused there, loudly.
 */
type FirstInvoice = {
  ref: string;
  subscriptionId: string;
  customerId: string | undefined;
  attempt: number | null;
  plan: string | null;
  billingInterval: string | null;
  /** Stripe's hosted page for this paid invoice: the setup-fee receipt the welcome email links. */
  hostedInvoiceUrl: string | null;
};

/**
 * The purchase a paid first invoice completes, or null for every other event:
 * `invoice.paid` with `billing_reason: "subscription_create"`, our marker,
 * and an intent ref on the subscription's metadata (the invoice's frozen copy
 * of it, wherever the pinned API version keeps it).
 */
function firstInvoiceOf(event: Stripe.Event): FirstInvoice | null {
  if (event.type !== "invoice.paid") return null;
  const invoice = event.data.object;
  if (invoice.billing_reason !== "subscription_create") return null;
  const legacy = invoice as {
    subscription?: string | { id: string } | null;
    subscription_details?: { metadata?: Stripe.Metadata | null } | null;
  };
  const metadata = invoice.parent?.subscription_details?.metadata ?? legacy.subscription_details?.metadata ?? null;
  if (metadata?.app !== APP_MARKER || !metadata.ref) return null;
  const subscriptionId = refId(invoice.parent?.subscription_details?.subscription ?? legacy.subscription);
  if (!subscriptionId) return null;
  const attempt = /^[1-9][0-9]{0,8}$/.test(metadata.attempt ?? "") ? Number(metadata.attempt) : null;
  return {
    ref: metadata.ref,
    subscriptionId,
    customerId: refId(invoice.customer),
    attempt,
    plan: metadata.plan || null,
    billingInterval: metadata.billingInterval || null,
    hostedInvoiceUrl: typeof invoice.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : null,
  };
}

/**
 * Make the account from the intent, before the invoice event itself is
 * forwarded. Returns the response to send when the event must NOT be
 * forwarded yet (provisioning unreachable or failing in a way a retry can
 * fix: Stripe redelivers, and the event goes on once the account exists), or
 * null to forward it.
 */
async function provisionFromIntent(event: Stripe.Event, first: FirstInvoice, relay: Relay): Promise<Response | null> {
  // The two records, from the Sheet. Unreadable is retryable: Stripe
  // redelivers, and the records are still there when it does.
  let records: { intent?: SealedRecord; agreement?: SealedRecord; agreementId?: string };
  try {
    records = await checkoutRecordsFor(first);
  } catch (error) {
    console.error("[healdesk] checkout records unreadable from stripe webhook", event.id, {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Checkout records unreadable.", { status: 500 });
  }
  const body = JSON.stringify({
    ref: first.ref,
    // The SUBSCRIPTION id, stamped here from the verified event and never
    // from a browser: every redelivery of this purchase carries the same one,
    // so it dedupes the purchase, not the delivery.
    idempotencyKey: first.subscriptionId,
    stripeCustomerId: first.customerId,
    stripeSubscriptionId: first.subscriptionId,
    // What was paid for. apps/app provisions only if the intent still says
    // the same, so the account is built from the terms that were charged.
    attempt: first.attempt,
    plan: first.plan,
    billingInterval: first.billingInterval,
    // The setup-fee receipt: apps/app keeps it with the purchase and the
    // welcome email links it, so no separate receipt goes for this invoice.
    hostedInvoiceUrl: first.hostedInvoiceUrl,
    // Exactly as the Sheet holds them, sealed: apps/app is the judge of both,
    // and refuses, to ops and to the buyer, what does not open or match.
    ...(records.intent || records.agreement
      ? {
          records: {
            ...(records.intent ? { intent: records.intent } : {}),
            ...(records.agreement ? { agreement: records.agreement } : {}),
          },
        }
      : {}),
  });
  const result = await relayTo("/api/provision", body, relay);
  // Nothing answered (the AWS host in standby, say): turn it on, then answer
  // 500 below as before, so Stripe retries until the account is made.
  await wakeHostForPaidInvoice(result, event.id);
  switch (result.kind) {
    case "ok":
      // 200 (replayed) and 201 (created) are both success. The purchase and
      // its agreement are spent: no later press of Pay may use them.
      await markIntentProvisioned(first.ref);
      if (records.agreementId) await markAgreementProvisioned(records.agreementId);
      return null;
    case "unreachable":
      console.error("[healdesk] provisioning unreachable from stripe webhook", event.id, result.error);
      return new Response("Provisioning unreachable.", { status: 500 });
    case "retryable":
      console.error("[healdesk] provisioning failed, retryable", event.id, result.status);
      return new Response("Provisioning failed.", { status: 500 });
    case "rejected":
      // Deterministic, so identical on every retry. Money taken with no
      // account: apps/app has already told ops on every refusal (an unknown
      // purchase, a second subscription for one that is set up, terms that
      // moved on, or a purchase provisioning cannot take), and marked the
      // intent where there is one to mark. The event still goes on, so it
      // parks against the subscription and replays if the account is made by
      // hand. Never echo apps/app's body.
      console.error("[healdesk] PROVISIONING REJECTED, paid customer has no account", {
        event: event.id,
        status: result.status,
      });
      return null;
  }
}

/**
 * The sealed records a paid first invoice provisions from: the record of the
 * press of Pay that was paid (its attempt, from the subscription's metadata;
 * the latest press when the metadata names none), and the agreement it names.
 * Each is relayed as the Sheet holds it, opened or not: apps/app checks the
 * seals, and a record that does not open is refused there, with ops told and,
 * for the agreement, the buyer written to. A purchase with no record at all
 * is relayed bare, and apps/app provisions from an intent it already holds
 * (an import that ran before) or refuses it as unknown.
 */
async function checkoutRecordsFor(
  first: FirstInvoice,
): Promise<{ intent?: SealedRecord; agreement?: SealedRecord; agreementId?: string }> {
  if (!recordsConfigured()) throw new Error("The checkout records are not configured.");
  const { records, refused } = await intentRecordsFor(first.ref);
  const ofAttempt = (attempt: number | null) =>
    records.filter((r) => attempt === null || r.record.attempt === attempt);
  const matching = ofAttempt(first.attempt);
  // A press that opened a Session is the one paid; one withdrawn opened none.
  const paid = matching.filter((r) => r.withdrawnAt === null).at(-1) ?? matching.at(-1) ?? null;
  if (!paid) {
    const raw = refused.filter((r) => first.attempt === null || r.attempt === first.attempt).at(-1);
    return raw?.sealed ? { intent: raw.sealed } : {};
  }
  const agreementId = paid.intent.agreementId;
  const agreement = await findAgreementRecord(agreementId);
  return {
    intent: paid.sealed,
    agreementId,
    ...(agreement.status === "found" ? { agreement: agreement.sealed } : {}),
    ...(agreement.status === "refused" && agreement.sealed ? { agreement: agreement.sealed } : {}),
  };
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
  if (marker === null && !UNMARKED_BY_NATURE.has(event.type)) {
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
    case "charge.refunded":
      // A subscription's charge usually carries no metadata of its own, so
      // this is mostly null, and apps/app finds the clinic by customer.
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
 * The setup link that opened this purchase is spent: the checkout refuses it
 * from now on (lib/setup-gate.ts). Never throws, like the conversion: a Sheet
 * outage must not fail the event. A link left unstamped still cannot buy
 * twice: its purchase records share the link's own id as their ref, a press
 * of Pay on it finds this paid Session and creates nothing (/api/checkout and
 * createCheckout both ask Stripe), the records are marked provisioned once
 * the account is made, and apps/app refuses a second subscription for the
 * purchase outright.
 */
async function markSetupLinkUsed(session: Stripe.Checkout.Session): Promise<void> {
  const id = session.metadata?.setupRequest;
  if (!id) return;
  try {
    await updateSetupRequest(id, { status: "paid", paidAt: new Date() });
  } catch (error) {
    console.error("[healdesk] could not mark the setup link used", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The plan id a Session's metadata names, as sent, and the catalog's plan for
 * it. A Session opened before the step pricing of 13 October names one of the
 * seven packages of 5 October ("complete"), which `getPlan` no longer knows:
 * the lead store still records which package it was, with no price, rather
 * than "unknown".
 */
function sessionPlan(session: Stripe.Checkout.Session): { id: string; plan: ReturnType<typeof getPlan> } {
  const id = String(session.metadata?.plan ?? "").slice(0, 64);
  return { id: id || "unknown", plan: getPlan(id) };
}

/** The lead store's view of a completed purchase. Never throws. */
async function recordConversion(session: Stripe.Checkout.Session): Promise<void> {
  try {
    const email = session.customer_email ?? session.customer_details?.email;
    if (!email) return;
    const { id, plan } = sessionPlan(session);
    const interval = session.metadata?.billingInterval;
    const mrr = plan ? (interval === "year" ? plan.annualMonthlyUsd : plan.monthlyUsd) : 0;
    await markConverted({ email, plan: id, mrrUsd: mrr });
  } catch (error) {
    console.error("[healdesk] could not record conversion in the lead store", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await recordDemoClaim(session);
}

/**
 * A purchase that came from a personalised demo: mark the demo claimed and
 * tell the team. Best effort and never throws, like the conversion above.
 * The prospect's own receipt, agreement copy and setup link are not sent
 * from here: Stripe sends the receipt, the agreement copy went at signature
 * (app/api/agreement/route.ts), and apps/app sends the welcome email and its
 * links once /api/provision has made the account, because every
 * clinic-facing link is composed there (root CLAUDE.md).
 */
async function recordDemoClaim(session: Stripe.Checkout.Session): Promise<void> {
  const slug = session.metadata?.demo;
  if (!slug) return;
  try {
    const { id, plan } = sessionPlan(session);
    const claimed = await markDemoClaimed(slug, id);
    if (!claimed?.newly) return;
    // The last step of the demo's close, beside the page's own events.
    await recordDemoEvent({ slug, variant: demoVariant(slug), name: "checkout_paid" });
    await postInternalAlert(
      `Demo claimed: ${displayName(claimed.session)} bought ${plan?.name ?? "a package"} from their personalised demo (${slug}).`,
    );
  } catch (error) {
    console.error("[healdesk] could not mark the demo claimed", {
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
