import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  agreementMismatch,
  INTENT_TTL_DAYS,
  IntentError,
  validateIntentRequest,
  WELCOME_NONCE_COOKIE,
  type IntentRequest,
} from "@healdesk/catalog";
import {
  acceptanceVariables,
  CheckoutRecordError,
  type IntentRecord,
} from "@healdesk/catalog/checkout-record";
import { NextResponse } from "next/server";

import {
  checkoutSessionPaid,
  chooseSetupOffer,
  createCheckout,
  expireUnrecordedCheckout,
  demoOfferFor,
  isBillingConfigured,
  isProductionDeployment,
  welcomeUrl,
} from "@/lib/billing";
import { isCampaignCode } from "@/lib/attribution";
import { postToApp, welcomeCookieOptions } from "@/lib/checkout/app-client";
import { intentFields, validateOrder, type Order } from "@/lib/checkout/order";
import {
  agreementSpent,
  appendIntentRecord,
  findAgreementRecord,
  intentRecordsFor,
  latestLive,
  markAgreementProvisioned,
  markIntentProvisioned,
  recordIntentSession,
  recordsConfigured,
  withdrawIntentRecord,
  type IntentRecords,
  type StoredAgreement,
  type StoredIntent,
} from "@/lib/checkout/records";
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
 * shape and the terms tick-box), checks it against the agreement record it
 * names and against provisioning's own rules (the catalog's
 * validateIntentRequest and agreementMismatch, which apps/app runs again when
 * it imports the purchase), records it as a sealed purchase record in the
 * marketing Sheet (lib/checkout/records.ts), and only then sends the buyer to
 * a Stripe-hosted Checkout Session that carries the purchase's ref. The
 * account is made on the first paid invoice, from that record, in
 * app/api/webhooks/stripe (src/lib/billing.ts explains it), and Stripe brings
 * the buyer back to this site's /welcome (app/welcome/route.ts), which this
 * response's nonce cookie lets in.
 *
 * ## Nothing here calls apps/app (owner, 14 October 2026)
 *
 * Until that day this route stored the purchase on apps/app (POST
 * /api/checkout/intents, then /api/checkout/intents/session). The AWS host
 * now has a standby mode that removes its database until the first clinic
 * pays, so a buyer must be able to pay with it off: the purchase is recorded
 * here, as business contact data, and apps/app imports it with the first paid
 * invoice (docs/design/checkout-records-on-vercel-2026-10-14.md). apps/web
 * still has no database client: the store is the marketing Sheet.
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
  // The records are sealed with the secret apps/app checks them with, and
  // kept in the marketing Sheet. HEALDESK_APP_URL is not needed to take a
  // payment any more: only the development path below provisions inline.
  if (!recordsConfigured()) {
    console.error(
      "[healdesk] checkout is unavailable: HEALDESK_PROVISION_SECRET, MARKETING_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is not set",
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
   * The agreement is checked for shape here, and against its record below,
   * before the Session exists.
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

  // Production without Stripe keys has nothing to do but refuse, and must do
  // it before anything is recorded (the guard below says why).
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

  /*
   * The agreement, from its record: it must exist and open, belong to no
   * account yet, have been signed by the buying address, and be the document
   * this purchase describes. Everything apps/app's checkout intent checked
   * before payment, against the record apps/app will import.
   */
  const signed = await agreementFor(purchase);
  if (!signed.ok) return signed.response;

  /*
   * ## What the Sheet cannot guarantee that the database did
   *
   * apps/app kept one intent per setup link with a unique `invite_ref` and an
   * atomic upsert: a press of Pay moved the attempt counter in one statement,
   * and a second press could not interleave with it. A spreadsheet has no
   * unique index, no transaction and no atomic increment, so here a press
   * reads the purchase's earlier records, computes the next attempt, and
   * appends a record of its own. Two presses on one setup link at the same
   * instant can therefore both read attempt N and both append N + 1: their
   * Sessions share Stripe's idempotency key (`checkout:<ref>:<attempt>`,
   * lib/billing.ts), so the same request returns one Session, and a request
   * whose terms differ is refused by Stripe and withdrawn here. Two presses
   * that read different attempts, which needs one to have appended between
   * the other's read and its append, can each create a Session the other
   * did not expire, and both could be paid; apps/app then refuses the second
   * subscription as a duplicate and tells ops (provision route,
   * `duplicate_subscription`), as it did for any second subscription. The
   * sequential case, which is the real one (Pay pressed again after
   * cancelling at Stripe), is covered as before: the previous press's
   * Session is asked about first and refused if paid, and expired before the
   * new one is created (createCheckout).
   *
   * One more thing the database gave: a press of Pay that wrote its intent
   * and then failed left nothing a later press could trip over. Here a
   * record that opened no Session is withdrawn (`withdrawn_at`), kept as the
   * evidence of the press, and never provisioned from.
   */
  const setupRef = setupRequest?.id ?? null;
  const ref = setupRef ?? randomUUID();
  let earlier: IntentRecords = { records: [], refused: [] };
  if (setupRef) {
    try {
      earlier = await intentRecordsFor(setupRef);
    } catch (error) {
      console.error("[healdesk] checkout: the purchase's earlier records could not be read", {
        error: error instanceof Error ? error.message : String(error),
      });
      return startFailed(502);
    }
  }
  if (earlier.records.some((r) => r.provisionedAt !== null)) {
    return Response.json(
      { error: "This setup link has already been used to complete a purchase.", field: "setupLink" },
      { status: 409 },
    );
  }
  const previous = latestLive(earlier.records);
  // The previous press's Session, if it was paid, ends this: a second
  // Session would take the setup fee twice, and its nonce cookie would
  // replace the one the paid press's /welcome knows this browser by.
  if (previous?.record.sessionId && isBillingConfigured()) {
    let paid: boolean;
    try {
      paid = await checkoutSessionPaid(previous.record.sessionId);
    } catch (error) {
      console.warn("[healdesk] checkout: the previous session could not be checked", {
        error: error instanceof Error ? error.name : "unknown error",
      });
      return Response.json(
        { error: "We couldn't check your earlier payment page. Nothing has been charged. Please try again." },
        { status: 503 },
      );
    }
    if (paid) {
      return Response.json({ error: "This purchase is already paid. Check your email." }, { status: 409 });
    }
  }
  const attempt =
    Math.max(0, ...earlier.records.map((r) => r.record.attempt), ...earlier.refused.map((r) => r.attempt ?? 0)) + 1;

  /*
   * The purchase, as apps/app will import it, held to provisioning's own
   * rules now (the catalog's validateIntentRequest, which apps/app runs again
   * at the import), so a purchase provisioning would refuse is refused before
   * anyone pays. The nonce binds /welcome to this browser: its hash goes into
   * the record, the nonce itself into a cookie only this browser holds.
   */
  const nonce = randomBytes(24).toString("base64url");
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const body: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      ...intentFields(purchase),
      inviteRef: setupRef,
      nonceHash: createHash("sha256").update(nonce).digest("hex"),
      // The terms tick-box, as accepted: which text, when, and from where.
      terms: { version: LEGAL_VERSION, acceptedAt: new Date().toISOString(), ip: forwardedFor },
    }),
  ) as Record<string, unknown>;
  let intent: IntentRequest;
  try {
    intent = validateIntentRequest(body);
  } catch (error) {
    if (error instanceof IntentError) {
      return Response.json({ error: error.message, field: error.field }, { status: error.status });
    }
    throw error;
  }

  const now = new Date();
  const record: IntentRecord = {
    record: "checkout_intent",
    v: 1,
    id: randomUUID(),
    ref,
    attempt,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INTENT_TTL_DAYS * 86_400_000).toISOString(),
    intent: body,
    sessionId: null,
  };
  let stored: StoredIntent;
  try {
    stored = await appendIntentRecord(record, intent);
  } catch (error) {
    if (error instanceof CheckoutRecordError && error.reason === "too_large") {
      // Only the website read can make a purchase this large: the purchase
      // goes on without it, and setup asks instead.
      return Response.json({ error: "The website read is too large to keep.", field: "profile" }, { status: 422 });
    }
    console.error("[healdesk] checkout: the purchase record was NOT written", {
      error: error instanceof Error ? error.message : String(error),
    });
    return startFailed(502);
  }

  // Paid path: hand off to Stripe. The webhook makes the account from the
  // records once the first invoice is paid.
  if (isBillingConfigured()) {
    try {
      const checkout = await createCheckout({
        plan,
        interval: chosenInterval,
        contactEmail,
        intent: {
          ref,
          attempt,
          successUrl: welcomeUrl(ref),
          previousOpenSessionId: previous?.record.sessionId ?? null,
        },
        attribution,
      });
      if (checkout.kind === "already-paid") {
        // The previous press of Pay was paid in the moment since it was asked
        // about: the account is on its way, and a second Session would charge
        // the setup fee twice. This press's record opened nothing.
        await withdrawIntentRecord(stored);
        return Response.json({ error: "This purchase is already paid. Check your email." }, { status: 409 });
      }
      if (checkout.kind === "redirect") {
        // Which Session this press opened, on its own record, so the next
        // press can expire it and /welcome and apps/app know it. Not best
        // effort: a Session the record does not name is one no later press
        // could expire, so it is expired now and its URL never handed out.
        let recorded = false;
        try {
          recorded = await recordIntentSession(stored, checkout.sessionId);
        } catch (error) {
          console.error("[healdesk] checkout: the session could not be recorded", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!recorded) {
          await expireUnrecordedCheckout(checkout.sessionId);
          await withdrawIntentRecord(stored);
          console.error("[healdesk] checkout session not recorded on its purchase record; expired and refused");
          return startFailed(502);
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
          welcomeCookieOptions(new URL(request.url).hostname, process.env.HEALDESK_APP_URL),
        );
        return response;
      }
    } catch (error) {
      console.error("[healdesk] could not start checkout", error);
      await withdrawIntentRecord(stored);
      return startFailed(502);
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

  // Unpaid development path: provision at once, exactly as the webhook would
  // after payment, keyed on the purchase, naming the press of Pay and the
  // terms it was for, and carrying the two records, as a paid subscription
  // does. Note the colon: an underscore would survive the audit log's uuid
  // stripper and trip its PHI assertion on some ids and not others.
  const secret = process.env.HEALDESK_PROVISION_SECRET!;
  const target = process.env.HEALDESK_APP_URL;
  if (!target) {
    console.error("[healdesk] checkout's development path needs HEALDESK_APP_URL to provision");
    return Response.json({ error: "Signup is unavailable." }, { status: 503 });
  }
  const provisioned = await postToApp(
    "/api/provision",
    {
      ref,
      idempotencyKey: `dev:${ref}`,
      attempt,
      plan: plan.id,
      billingInterval: chosenInterval,
      records: { intent: stored.sealed, agreement: signed.agreement.sealed },
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
  if (provisioned.status >= 200 && provisioned.status < 300) {
    await markIntentProvisioned(ref);
    await markAgreementProvisioned(signed.agreement.record.id);
  }
  // Pass the product's own validation messages through. They name the field
  // that was wrong, which is what the form needs to highlight it.
  return new Response(provisioned.text, {
    status: provisioned.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** "Try again", with nothing charged: every failure to start that a retry can fix. */
function startFailed(status: number): Response {
  return Response.json(
    { error: "We couldn't start checkout. Nothing has been charged. Please try again." },
    { status },
  );
}

/**
 * The agreement record a purchase names, or the refusal to send instead.
 * Each refusal of the document names `agreementId`, which sends the funnel
 * back to the signature; one signed under another address names
 * `contactEmail`. The same rules apps/app applies to the imported row
 * (checkIntentAgreement), so a purchase that passes here is one the import
 * accepts.
 */
async function agreementFor(
  purchase: Order,
): Promise<{ ok: true; agreement: StoredAgreement } | { ok: false; response: Response }> {
  const refuse = (error: string, field: string) => ({
    ok: false as const,
    response: Response.json({ error, field }, { status: 422 }),
  });
  let found: Awaited<ReturnType<typeof findAgreementRecord>>;
  let spent: boolean;
  try {
    found = await findAgreementRecord(purchase.agreementId);
    spent = found.status === "found" && (found.provisionedAt !== null || (await agreementSpent(purchase.agreementId)));
  } catch (error) {
    console.error("[healdesk] checkout: the agreement record could not be read", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, response: startFailed(502) };
  }
  if (found.status === "missing") return refuse("That agreement wasn't found. Please sign it again.", "agreementId");
  if (found.status === "refused") {
    console.error("[healdesk] checkout: an agreement record failed its check", {
      agreementId: purchase.agreementId,
      problem: found.problem,
    });
    return refuse("That agreement can't be used. Please sign it again.", "agreementId");
  }
  if (spent) return refuse("That agreement already belongs to an account. Please sign it again.", "agreementId");
  if (found.record.signatoryEmail.trim().toLowerCase() !== purchase.contactEmail) {
    return refuse("The agreement was signed with a different email address.", "contactEmail");
  }
  const mismatch = agreementMismatch(found.record.documentVersion, acceptanceVariables(found.record), {
    clinicName: purchase.clinicName,
    specialty: purchase.specialty,
    platform: purchase.platform,
    isCoveredEntity: purchase.isCoveredEntity,
    bookingSystem: purchase.bookingSystem,
    calendarAccount: purchase.calendarAccount,
  });
  if (mismatch) return refuse(mismatch, "agreementId");
  return { ok: true, agreement: found };
}
