import { createHash, randomBytes } from "node:crypto";

import {
  getPlan,
  isBillingInterval,
  META_SOLD_ALONE,
  sellsMetaAlone,
  WELCOME_NONCE_COOKIE,
} from "@healdesk/catalog";
import { NextResponse } from "next/server";

import { createCheckout, isBillingConfigured, isProductionDeployment } from "@/lib/billing";
import { isCampaignCode } from "@/lib/attribution";
import { postToApp, welcomeCookieOptions, type AppAnswer } from "@/lib/checkout/app-client";
import { demoSlugFromCookieHeader } from "@/lib/demo/attribution";
import { getDemoSession } from "@/lib/demo/sessions";
import { LEGAL_VERSION } from "@/lib/legal";
import { cohortCreditLive, findLeadById, markCheckoutStarted, normalizeEmail } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { gateState, refuseOtherEmail, refuseWithoutLink } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";

/**
 * POST /api/checkout, start a purchase.
 *
 * The browser's checkout step calls this, once the buyer has signed the
 * agreement; the Stripe webhook never does. It validates the billing terms,
 * hands the purchase to apps/app as a checkout intent (which checks everything
 * provisioning will), and only then sends the buyer to a Stripe-hosted
 * Checkout Session that carries the intent's ref. The account is made on the
 * first paid invoice, from that intent, in app/api/webhooks/stripe
 * (src/lib/billing.ts explains it), and Stripe brings the buyer back to
 * apps/app's /welcome, which this response's nonce cookie lets in.
 *
 * The marketing site never talks to the product database. What it sends is
 * signed and carried to apps/app, which owns every write. That keeps exactly
 * one service holding a connection to the database that will eventually
 * contain PHI, even though nothing in this payload is PHI, a clinic owner's
 * name and work email are business contact data.
 *
 * Without Stripe keys there is a development path at the bottom that
 * provisions inline, with no payment, so the purchase flow can be exercised
 * end to end on a laptop. It is refused in every production deployment; see
 * the guard in front of it.
 */

/** The shape apps/app issues agreement ids in, and checks again at provisioning. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;

  if (!secret || !target) {
    console.error(
      "[healdesk] HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return Response.json({ error: "Signup is unavailable." }, { status: 503 });
  }

  const limit = await rateLimit(
    `checkout:${clientKey(request.headers)}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return Response.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const raw = await request.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  /**
   * Whatever the browser sent for `idempotencyKey`, drop it.
   *
   * The HMAC below authenticates apps/web, not the buyer, so a key chosen by
   * the client would be signed and trusted, and apps/app answers a known key by
   * replaying the stored organizationId, clinicId and invitationId. That turns
   * a dedupe key into an object-reference oracle. It is set server-side, here
   * or in the Stripe webhook, and nowhere else.
   */
  delete payload.idempotencyKey;

  /**
   * The setup link, while the purchase is by invitation (lib/checkout-mode.ts).
   *
   * Checked before anything else about the order, so a browser without a
   * valid, unused link gets no further than this, and bound to the request's
   * email, so a forwarded link cannot be used to buy under another address.
   * Single use is the request's `paid_at`, stamped by the Stripe webhook.
   */
  const gate = await gateState(readCookie(request.headers, SETUP_COOKIE));
  if (gate.mode === "pilot") {
    const refused = refuseWithoutLink(gate);
    if (refused) return refused;
    if (gate.link === "valid" && normalizeEmail(String(payload.contactEmail ?? "")) !== gate.request.emailNormalized) {
      return refuseOtherEmail(gate.request, "contactEmail");
    }
  }

  /**
   * The billing terms, validated here on BOTH paths.
   *
   * apps/app validates the plan again, but the package and the interval
   * decide what Stripe charges and what provisioning enables, and the
   * place to refuse a value the catalog does not know is before either of
   * those has happened. A missing interval is monthly, which is what every
   * button that does not say otherwise has always meant; a wrong one is an
   * error, not a silent fallback to the cheaper option.
   */
  const plan = getPlan(String(payload.plan ?? ""));
  if (!plan) {
    return Response.json(
      { error: "Unknown plan.", field: "plan" },
      { status: 422 },
    );
  }

  const chosenInterval: unknown = payload.interval ?? "month";
  if (!isBillingInterval(chosenInterval)) {
    return Response.json(
      { error: "Unknown billing interval.", field: "interval" },
      { status: 422 },
    );
  }

  // Meta as the only channel waits for Meta's App Review (catalog,
  // META_SOLD_ALONE). The checkout UI already disables that choice; this is
  // the refusal a request from anywhere else meets, before Stripe is involved.
  if (!META_SOLD_ALONE && sellsMetaAlone(plan)) {
    return Response.json(
      {
        error:
          "Instagram, Messenger + WhatsApp is not sold on its own until Meta approves our app. Choose Website, or a package with website chat or the phone.",
        field: "plan",
      },
      { status: 422 },
    );
  }

  // The browser's spelling is replaced by the validated terms under the names
  // provisioning reads, so the paid path (via Session metadata) and the unpaid
  // path below deliver the same shape. The package id alone says which
  // channels it includes, so nothing else about channels is passed on, and a
  // stray `chatChannelChoice` from an old page is dropped rather than trusted.
  delete payload.interval;
  delete payload.chatChannelChoice;
  payload.billingInterval = chosenInterval;

  /**
   * The signed agreement, required before anybody can pay.
   *
   * The business associate agreement is a blocking step: checkout does not
   * complete without it (docs/v1-product-spec.md, "Who is what"). apps/app
   * refuses to provision without an agreement id of exactly this shape, but
   * it only finds out after the webhook, which on the paid path is after the
   * card was charged. Checked here, a buyer who skipped the signature step is
   * stopped before a Session exists, under the same field name, so the form
   * can send them back to the step they missed.
   *
   * This is a shape check, not proof of a signature. Whether the id names an
   * acceptance of the current BAA version, signed by this buyer and not yet
   * bound to an account, is only knowable in apps/app, and asking it before
   * the Session is created needs a signed endpoint that does not exist yet.
   */
  if (typeof payload.agreementId !== "string" || !UUID.test(payload.agreementId)) {
    return Response.json(
      { error: "Sign the Business Associate Agreement before paying.", field: "agreementId" },
      { status: 422 },
    );
  }

  // `attributionMode` and `averageTreatmentValueUsd` pass through untouched,
  // and only because apps/app provisioning still refuses a signup without
  // `attributionMode`. Revenue attribution is phase two, not v1: v1 reports
  // booked value from the clinic's own configured prices, never revenue
  // (docs/v1-product-spec.md, "What v1 can prove, and what it cannot"). Once
  // provisioning stops requiring them, drop both here the way `campaign` and
  // `leadId` are dropped below. The webhook keeps coercing them for Sessions
  // already in flight.

  /**
   * Attribution, treated like idempotencyKey: whatever the browser claims is
   * validated server-side, never trusted. The campaign is a slug; the lead id
   * must name a row in the lead store, else it is dropped. Neither reaches
   * provisioning — apps/app has no column for them — they ride on the Stripe
   * Session as metadata and are read back by the webhook to close the loop.
   */
  const campaign = isCampaignCode(payload.campaign) ? payload.campaign : null;
  // With a setup link, the lead is the one the request came from, so the
  // credit the Day 7 email offered follows the person who was offered it.
  const setupRequest = gate.mode === "pilot" && gate.link === "valid" ? gate.request : null;
  const leadSource = setupRequest ? setupRequest.leadId : payload.leadId;
  const claimedLead = typeof leadSource === "string" && leadSource ? await findLeadById(leadSource) : null;
  delete payload.campaign;
  delete payload.leadId;
  // The personalised demo the buyer came from, from the cookie its "Book
  // Onboarding" set, never from the body: a slug the browser sends is dropped.
  // Kept only if the row exists, like the lead id above.
  delete payload.demo;
  const demoSlug = demoSlugFromCookieHeader(request.headers.get("cookie"));
  const demo = demoSlug ? await getDemoSession(demoSlug) : null;
  const contactEmail = String(payload.contactEmail ?? "");
  // The founding-cohort credit is a fact about the lead row, never a claim
  // from the browser: offered by the Day 7 email and still inside its window.
  const attribution = {
    campaign,
    leadId: claimedLead?.id ?? null,
    offer: claimedLead && cohortCreditLive(claimedLead) ? ("cohort-setup" as const) : null,
    demo: demo?.slug ?? null,
    setupRequestId: setupRequest?.id ?? null,
  };

  /**
   * The intent: the purchase, stored by apps/app before Stripe sees anything
   * (design D1). apps/app runs provisioning's own validation and checks the
   * agreement is unbound and signed by this address, so a refusal here costs
   * the buyer nothing. The nonce binds /welcome to this browser: its hash goes
   * into the intent, the nonce itself into a cookie only this browser holds.
   */
  // Production without Stripe keys has nothing to do but refuse, and must do
  // it before apps/app is asked for anything (the guard below says why).
  if (!isBillingConfigured() && isProductionDeployment()) {
    console.error(
      "[healdesk] checkout reached the unpaid development path in production; refusing (is STRIPE_SECRET_KEY set?)",
    );
    return Response.json(
      { error: "Checkout is unavailable right now. Nothing has been charged. Please try again later." },
      { status: 503 },
    );
  }

  const nonce = randomBytes(24).toString("base64url");
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const saved = await postToApp(
    "/api/checkout/intents",
    {
      ...payload,
      plan: plan.id,
      contactEmail,
      inviteRef: setupRequest?.id ?? null,
      nonceHash: createHash("sha256").update(nonce).digest("hex"),
      profileStatus: "none",
      // The terms tick-box, as accepted: which text, when, and from where.
      terms: { version: LEGAL_VERSION, acceptedAt: new Date().toISOString(), ip: forwardedFor },
    },
    { target, secret },
  );
  const intent = intentFrom(saved);
  if (!intent.ok) return intent.response;

  // Paid path: hand off to Stripe. The webhook makes the account from the
  // intent once the first invoice is paid.
  if (isBillingConfigured()) {
    try {
      const checkout = await createCheckout({
        plan,
        interval: chosenInterval,
        contactEmail,
        intent: intent.value,
        attribution,
      });
      if (checkout.kind === "redirect") {
        // Which Session this attempt opened, so the next press of Pay can
        // expire it. Best effort: without it, /welcome asks Stripe instead.
        const recorded = await postToApp(
          "/api/checkout/intents/session",
          { ref: intent.value.ref, attempt: intent.value.attempt, sessionId: checkout.sessionId },
          { target, secret },
        );
        if (!recorded.reached || recorded.status !== 200) {
          console.warn("[healdesk] checkout session not recorded on the intent; /welcome will ask Stripe");
        }
        // The funnel's "checkout_started" is the Session existing, not the
        // button click: a lead row is created here if the demo never made one.
        await markCheckoutStarted({
          email: contactEmail,
          clinicName: typeof payload.clinicName === "string" ? payload.clinicName : undefined,
          specialty: typeof payload.specialty === "string" ? payload.specialty : undefined,
          plan: plan.id,
          interval: chosenInterval,
          campaign,
          leadId: attribution.leadId,
        });
        const response = NextResponse.json({ checkoutUrl: checkout.url }, { status: 200 });
        response.cookies.set(
          WELCOME_NONCE_COOKIE,
          nonce,
          welcomeCookieOptions(new URL(request.url).hostname, intent.value.successUrl),
        );
        return response;
      }
    } catch (error) {
      console.error("[healdesk] could not start checkout", error);
      return Response.json(
        { error: "We couldn't start checkout. Nothing has been charged. Please try again." },
        { status: 502 },
      );
    }
  }

  /**
   * Nothing below this line may run in production.
   *
   * With STRIPE_SECRET_KEY unset the paid path above is skipped entirely, so
   * createCheckout()'s own production refusal never runs, and the only thing
   * left to do would be to create an account nobody paid for. On any
   * production deployment (NODE_ENV or VERCEL_ENV "production", which covers
   * Vercel previews and a local `next start` too) that is refused before
   * anything is provisioned, loudly in the log and plainly to the buyer.
   * `next dev` and the test runner are the only places the path below runs.
   */
  if (isProductionDeployment()) {
    console.error(
      "[healdesk] checkout reached the unpaid development path in production; refusing (is STRIPE_SECRET_KEY set?)",
    );
    return Response.json(
      { error: "Checkout is unavailable right now. Nothing has been charged. Please try again later." },
      { status: 503 },
    );
  }

  // Unpaid development path: provision from the intent at once, exactly as
  // the webhook would after payment, keyed on the intent. Note the colon: an
  // underscore would survive the audit log's uuid stripper and trip its PHI
  // assertion on some ids and not others.
  const provisioned = await postToApp(
    "/api/provision",
    { ref: intent.value.ref, idempotencyKey: `dev:${intent.value.ref}` },
    { target, secret },
  );
  if (!provisioned.reached) {
    console.error("[healdesk] provisioning unreachable", provisioned.error);
    return Response.json(
      { error: "We couldn't finish setting up your account. Please try again." },
      { status: 502 },
    );
  }
  // Pass the product's own validation messages through. They name the field
  // that was wrong, which is what the form needs to highlight it.
  return new Response(provisioned.text, {
    status: provisioned.status,
    headers: { "Content-Type": "application/json" },
  });
}

type StoredIntent = { ref: string; attempt: number; successUrl: string; previousOpenSessionId: string | null };

/**
 * apps/app's answer to the intent, or the response to send the browser
 * instead. Its own refusals (a field that is wrong, a setup link already
 * used) pass through with their field, so the form can point at it; anything
 * else is "try again", with nothing charged.
 */
function intentFrom(answer: AppAnswer): { ok: true; value: StoredIntent } | { ok: false; response: Response } {
  if (!answer.reached) {
    console.error("[healdesk] checkout intents unreachable", answer.error);
    return { ok: false, response: Response.json({ error: "We couldn't start checkout. Nothing has been charged. Please try again." }, { status: 502 }) };
  }
  const json = answer.json ?? {};
  if (answer.status === 201 && typeof json.ref === "string" && typeof json.attempt === "number" && typeof json.successUrl === "string") {
    return {
      ok: true,
      value: {
        ref: json.ref,
        attempt: json.attempt,
        successUrl: json.successUrl,
        previousOpenSessionId: typeof json.previousOpenSessionId === "string" ? json.previousOpenSessionId : null,
      },
    };
  }
  if (answer.status === 409 || answer.status === 422) {
    return {
      ok: false,
      response: Response.json(
        { error: typeof json.error === "string" ? json.error : "Something in the purchase needs a second look.", field: json.field },
        { status: answer.status },
      ),
    };
  }
  console.error("[healdesk] checkout intent refused", { status: answer.status });
  return { ok: false, response: Response.json({ error: "We couldn't start checkout. Nothing has been charged. Please try again." }, { status: 502 }) };
}
