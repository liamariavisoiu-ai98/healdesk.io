import { createHash, randomBytes } from "node:crypto";

import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import {
  chooseSetupOffer,
  createCheckout,
  expireUnrecordedCheckout,
  demoOfferFor,
  isBillingConfigured,
  isProductionDeployment,
} from "@/lib/billing";
import { isCampaignCode } from "@/lib/attribution";
import { postToApp, welcomeCookieOptions, type AppAnswer } from "@/lib/checkout/app-client";
import { intentFields, validateOrder } from "@/lib/checkout/order";
import { demoSlugFromCookieHeader } from "@/lib/demo/attribution";
import { demoOfferEndsAt, demoSetupCredit, getDemoSession } from "@/lib/demo/sessions";
import { demoSiteProfile } from "@/lib/demo/to-clinic-profile";
import { LEGAL_VERSION } from "@/lib/legal";
import { cohortCreditEndsAt, findLeadById, markCheckoutStarted, normalizeEmail } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { demoInvitation, gateState, refuseOtherEmail, refuseWithoutLink } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";
import { siteOfferEndsAt } from "@/lib/site-offer";

/**
 * POST /api/checkout, start a purchase.
 *
 * The browser's Review and pay step calls this, once the buyer has signed the
 * agreement; the Stripe webhook never does. It validates the purchase against
 * an allowlist (lib/checkout/order.ts: the package and its terms, the clinic,
 * its booking system and Google account, the website rule, the website read's
 * shape and the terms tick-box), hands it to apps/app as a checkout intent
 * (which checks everything provisioning will), and only then sends the buyer
 * to a Stripe-hosted Checkout Session that carries the intent's ref. The
 * account is made on the first paid invoice, from that intent, in
 * app/api/webhooks/stripe (src/lib/billing.ts explains it), and Stripe brings
 * the buyer back to apps/app's /welcome, which this response's nonce cookie
 * lets in.
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;
/**
 * The purchase plus the website read, whose own caps (ClinicProfile's) bound
 * it well under this. apps/app refuses an intent over 256 kB in any case.
 */
const MAX_BODY_CHARS = 300_000;

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
  if (raw.length > MAX_BODY_CHARS) {
    return Response.json({ error: "Request too large." }, { status: 413 });
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  /*
   * Nothing the browser sends is forwarded as sent. What reaches apps/app is
   * built field by field from the validated order (intentFields), so a key
   * the client invents never travels. That matters most for one key: an
   * `idempotencyKey` chosen by the client would be signed and trusted, and
   * apps/app answers a known key by replaying the stored ids, which would
   * turn a dedupe key into an object-reference oracle. It is set server-side,
   * here or in the Stripe webhook, and nowhere else.
   */

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
    // A personalised demo is an invitation too (lib/setup-gate.ts).
    if (refused && !(await demoInvitation(request.headers.get("cookie")))) return refused;
    if (gate.link === "valid" && normalizeEmail(String(payload.contactEmail ?? "")) !== gate.request.emailNormalized) {
      return refuseOtherEmail(gate.request, "contactEmail");
    }
  }

  /**
   * The order, validated here on BOTH paths and before anything upstream.
   *
   * apps/app validates it again, but the package and the interval decide
   * what Stripe charges, the website rule decides whether web chat may be
   * sold at all, and the signed agreement is required before anybody can
   * pay (docs/v1-product-spec.md, "Who is what"). The place to refuse a value
   * the catalog does not know is before any of that has happened, under the
   * field name the form uses to send the buyer back to the right step.
   * The agreement is checked for shape only here; apps/app checks it exists,
   * is unbound and was signed by this address before the Session exists.
   */
  const validated = validateOrder(payload);
  if (!validated.ok) {
    return Response.json(validated.refusal, { status: 422 });
  }
  const order = validated.order;
  const plan = order.plan;
  const chosenInterval = order.interval;

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
  // The personalised demo the buyer came from, from the cookie its "Book
  // Onboarding" set, never from the body: the order carries no demo field,
  // so a slug the browser sends is never read. Kept only if the row exists,
  // like the lead id above.
  const demoSlug = demoSlugFromCookieHeader(request.headers.get("cookie"));
  const demo = demoSlug ? await getDemoSession(demoSlug) : null;
  const contactEmail = order.contactEmail;
  /*
   * The setup credit, at most one, the strongest that holds (lib/billing.ts
   * `chooseSetupOffer`; owner, 13 October 2026). Each is a fact the server
   * holds, never a claim from the browser: the founding-cohort credit is on
   * the lead row, offered by the Day 7 email and inside its 14 days; the
   * demo's share (50% from an operator's demo, 30% from a homepage one,
   * `demoSetupCredit`) holds for the demo row's own 48 hours from being ready
   * (`demoOfferEndsAt`); the website's 30% is the moment in the signed
   * httpOnly offer cookie, inside its 48 hours (lib/site-offer.ts). A body
   * field naming an offer is never read.
   */
  const chosen = chooseSetupOffer({
    cohort: claimedLead ? cohortCreditEndsAt(claimedLead) : null,
    demo: demo ? demoOfferEndsAt(demo) : null,
    demoOffer: demo ? demoOfferFor(demoSetupCredit(demo)) : undefined,
    site: siteOfferEndsAt(request.headers.get("cookie")),
  });
  const attribution = {
    campaign,
    leadId: claimedLead?.id ?? null,
    offer: chosen?.offer ?? null,
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

  // What the buyer's demo learned from the same website stands in when the
  // checkout's own read of it failed, so setup still starts from it rather
  // than from nothing (lib/demo/to-clinic-profile.ts). Built here from our
  // own row; apps/app parses and screens it again like any read.
  const demoRead = order.profileStatus === "failed" && order.website && demo ? demoSiteProfile(demo, order.website) : null;
  const purchase = demoRead ? { ...order, profile: demoRead, profileStatus: "read" as const } : order;

  const nonce = randomBytes(24).toString("base64url");
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const saved = await postToApp(
    "/api/checkout/intents",
    {
      ...intentFields(purchase),
      inviteRef: setupRequest?.id ?? null,
      nonceHash: createHash("sha256").update(nonce).digest("hex"),
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
      if (checkout.kind === "already-paid") {
        // The previous press of Pay was paid: the account is on its way, and
        // a second Session would charge the setup fee twice.
        return Response.json({ error: "This purchase is already paid. Check your email." }, { status: 409 });
      }
      if (checkout.kind === "redirect") {
        // Which Session this attempt opened, so the next press of Pay can
        // expire it. Not best effort: a Session the intent does not record
        // is one no later press could expire, so it is expired now and its
        // URL never handed out. A 409 means a newer press, in another tab,
        // recorded its own Session first; that one is the one to pay.
        const recorded = await postToApp(
          "/api/checkout/intents/session",
          { ref: intent.value.ref, attempt: intent.value.attempt, sessionId: checkout.sessionId },
          { target, secret },
        );
        if (!recorded.reached || recorded.status !== 200) {
          await expireUnrecordedCheckout(checkout.sessionId);
          if (recorded.reached && recorded.status === 409) {
            return Response.json(
              { error: "Another payment page was opened; use the latest one." },
              { status: 409 },
            );
          }
          console.error("[healdesk] checkout session not recorded on the intent; expired and refused", {
            status: recorded.reached ? recorded.status : "unreachable",
          });
          return Response.json(
            { error: "We couldn't start checkout. Nothing has been charged. Please try again." },
            { status: 502 },
          );
        }
        // The funnel's "checkout_started" is the Session existing, not the
        // button click: a lead row is created here if the demo never made one.
        await markCheckoutStarted({
          email: contactEmail,
          clinicName: order.clinicName,
          specialty: order.specialty,
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
  // the webhook would after payment, keyed on the intent, and naming the
  // press of Pay and the terms it was for, as a paid subscription does. Note
  // the colon: an underscore would survive the audit log's uuid stripper and
  // trip its PHI assertion on some ids and not others.
  const provisioned = await postToApp(
    "/api/provision",
    {
      ref: intent.value.ref,
      idempotencyKey: `dev:${intent.value.ref}`,
      attempt: intent.value.attempt,
      plan: plan.id,
      billingInterval: chosenInterval,
    },
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
