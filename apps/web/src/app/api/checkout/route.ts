import {
  getPlan,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";

import { createCheckout, isBillingConfigured } from "@/lib/billing";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/checkout, complete a purchase.
 *
 * The marketing site never talks to the product database. It signs the payload
 * and forwards it to apps/app, which owns every write. That keeps exactly one
 * service holding a connection to the database that will eventually contain
 * PHI, even though nothing in this payload is PHI, a clinic owner's name and
 * work email are business contact data.
 *
 * Payment comes first in the real flow: this route is called by the Stripe
 * webhook / success handler, not directly by the browser form. Until Stripe
 * keys exist, `createCheckout` short-circuits and this is called inline,
 * see src/lib/billing.ts.
 */

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

  const limit = rateLimit(
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

  // Paid path: hand off to Stripe and let the webhook provision after payment.
  if (isBillingConfigured()) {
    const plan = getPlan(String(payload.plan ?? ""));
    if (!plan) {
      return Response.json({ error: "Unknown plan." }, { status: 422 });
    }
    try {
      const checkout = await createCheckout({
        plan,
        clinicName: String(payload.clinicName ?? ""),
        contactEmail: String(payload.contactEmail ?? ""),
        provisionPayload: payload,
      });
      if (checkout.kind === "redirect") {
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

  // Unpaid development path. createCheckout() throws in production when Stripe
  // is unconfigured, so reaching here means we are deliberately provisioning
  // without payment, key it on the agreement, which is already unique per
  // signature. Note the colon: an underscore would survive the audit log's
  // uuid stripper and trip its PHI assertion on some ids and not others.
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
