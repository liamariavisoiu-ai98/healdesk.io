import {
  getPlan,
  isBillingInterval,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";

import { createCheckout, isBillingConfigured, isProductionDeployment } from "@/lib/billing";
import { isCampaignCode } from "@/lib/attribution";
import { cohortCreditLive, findLeadById, markCheckoutStarted } from "@/lib/leads";
import { type ChatChannelChoice, isChatChannelChoice } from "@/lib/pricing";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/checkout, start a purchase.
 *
 * The browser's checkout step calls this, once the buyer has signed the BAA;
 * the Stripe webhook never does. It validates the billing terms and hands the
 * buyer to a Stripe-hosted Checkout Session, and nothing is created in
 * apps/app here. The account is recorded when that Session completes and is
 * switched on only when the first invoice is paid, both in
 * app/api/webhooks/stripe (src/lib/billing.ts explains the two steps).
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
   * The billing terms, validated here on BOTH paths.
   *
   * apps/app validates the plan again, but the interval and the chat-channel
   * choice decide what Stripe charges and what provisioning enables, and the
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

  // Only a package sold as "Web OR Meta" carries a choice. For every other
  // package the field is dropped rather than validated, so a stray value can
  // never reach provisioning and enable a channel the package does not include.
  let chatChannelChoice: ChatChannelChoice | undefined;
  if (plan.chatChannelChoice) {
    const chosen = payload.chatChannelChoice ?? "web";
    if (!isChatChannelChoice(chosen)) {
      return Response.json(
        { error: "Unknown chat channel.", field: "chatChannelChoice" },
        { status: 422 },
      );
    }
    chatChannelChoice = chosen;
  }

  // The browser's spelling is replaced by the validated terms under the names
  // provisioning reads, so the paid path (via Session metadata) and the unpaid
  // path below deliver the same shape.
  delete payload.interval;
  delete payload.chatChannelChoice;
  payload.billingInterval = chosenInterval;
  if (chatChannelChoice) payload.chatChannelChoice = chatChannelChoice;

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
  const claimedLead = typeof payload.leadId === "string" ? await findLeadById(payload.leadId) : null;
  delete payload.campaign;
  delete payload.leadId;
  const contactEmail = String(payload.contactEmail ?? "");
  // The founding-cohort credit is a fact about the lead row, never a claim
  // from the browser: offered by the Day 7 email and still inside its window.
  const attribution = {
    campaign,
    leadId: claimedLead?.id ?? null,
    offer: claimedLead && cohortCreditLive(claimedLead) ? ("cohort-setup" as const) : null,
  };

  // Paid path: hand off to Stripe. The webhook records the account when the
  // Session completes, and the first paid invoice switches it on.
  if (isBillingConfigured()) {
    try {
      const checkout = await createCheckout({
        plan,
        interval: chosenInterval,
        chatChannelChoice,
        clinicName: String(payload.clinicName ?? ""),
        contactEmail,
        provisionPayload: payload,
        attribution,
      });
      if (checkout.kind === "redirect") {
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
        return Response.json({ checkoutUrl: checkout.url }, { status: 200 });
      }
    } catch (error) {
      console.error("[healdesk] could not start checkout", error);
      return Response.json(
        { error: "We couldn't start checkout. Please try again." },
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
   * anything is sent to apps/app, loudly in the log and plainly to the buyer.
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

  // Unpaid development path: provisioning without payment, on purpose, keyed
  // on the agreement, which is already unique per signature. Note the colon:
  // an underscore would survive the audit log's uuid stripper and trip its
  // PHI assertion on some ids and not others.
  const body = JSON.stringify({
    ...payload,
    idempotencyKey: `agr:${String(payload.agreementId ?? "")}`,
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL("/api/provision", target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(body, timestamp, secret),
      },
      body,
    });
  } catch (error) {
    console.error("[healdesk] provisioning unreachable", error);
    return Response.json(
      { error: "We couldn't finish setting up your account. Please try again." },
      { status: 502 },
    );
  }

  // Pass the product's own validation messages through. They name the field
  // that was wrong, which is what the form needs to highlight it.
  const answer = await response.text();
  return new Response(answer, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
