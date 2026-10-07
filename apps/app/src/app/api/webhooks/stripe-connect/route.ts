import Stripe from "stripe";

import { stripeKeyMode } from "@/lib/billing/connect";
import { handleConnectEvent } from "@/lib/billing/connect-events";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stripe events are small; anything larger is not one, and is refused before it is parsed. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * POST /api/webhooks/stripe-connect: events from clinics' connected Stripe
 * accounts (BD28, R23), sent by Stripe directly to apps/app. Deposits are
 * paid into a clinic's own account, so their events never pass through the
 * marketing site, and this endpoint has its own signing secret
 * (STRIPE_CONNECT_WEBHOOK_SECRET): a leaked platform-webhook secret must not
 * be able to forge "deposit paid".
 *
 * Verify before anything else, against the raw body. Unset secret, or a key
 * whose mode cannot be read (lib/billing/connect.ts stripeKeyMode), is a 503
 * and nothing recorded.
 *
 * ## Status codes are a retry decision
 *
 * 500 means "not applied, try again" and only follows a handler throw, which
 * lib/billing/connect-events.ts records and allows for the first two
 * failures. Everything else (applied, ignored, a duplicate, a parked event)
 * is 200, because a retry would change nothing. Nothing from the event is
 * logged but its id and type: a clinic's own Checkout traffic can carry a
 * patient's details.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = env.stripeConnectWebhookSecret();
  if (!secret || !stripeKeyMode()) {
    log.error("Connect webhook is not configured; refusing events", {
      reason: secret ? "no_key_mode" : "no_secret",
    });
    return Response.json({ error: "Connect events are unavailable." }, { status: 503 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(
      raw,
      request.headers.get("stripe-signature") ?? "",
      secret,
    );
  } catch {
    log.warn("connect event rejected", { reason: "bad_signature" });
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    const result = await handleConnectEvent(event);
    return Response.json({
      received: true,
      outcome: result.outcome,
      duplicate: result.duplicate,
    });
  } catch (error) {
    log.error("connect event failed; asking Stripe to retry", {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "Could not apply event." }, { status: 500 });
  }
}
