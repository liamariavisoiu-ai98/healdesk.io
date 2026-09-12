import { randomUUID } from "node:crypto";

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "@healdesk/catalog";
import type Stripe from "stripe";

import { handleStripeEvent } from "@/lib/billing/events";
import { env } from "@/lib/env";

/**
 * POST /api/billing/events — a verified Stripe event, relayed by apps/web.
 *
 * The Stripe secret lives on the marketing site and the database lives here,
 * so apps/web verifies Stripe's signature and forwards the event over the same
 * HMAC channel /api/provision uses: same headers, same shared secret, same
 * "verify before parse" ordering, so an unauthenticated caller cannot make us
 * do work — or make us record a billing event Stripe never sent.
 *
 * ## Status codes are a retry decision
 *
 * apps/web maps our status straight back to Stripe, and Stripe retries every
 * non-2xx for three days. So: 500 means "not applied, try again" and is only
 * returned when lib/billing/events.ts rethrew, which it does for the first
 * MAX_FAILURES - 1 attempts. Everything else — processed, ignored, a
 * duplicate, a dead-lettered event — is 200, because a retry would change
 * nothing and a fourth day of them ends with the endpoint disabled.
 *
 * Nothing about the buyer or the clinic is logged here: the event id and type
 * are enough to find the row in billing_events.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function problem(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * The least that has to be true for handleStripeEvent() to record it.
 *
 * Not a validation of the event — the HMAC already says apps/web sent it,
 * and apps/web only sends what Stripe signed. This catches a malformed relay
 * (a wrapped body, a bare object) so it fails as a 400 with a clear reason
 * rather than as a not-null violation on the ledger insert.
 */
function isStripeEvent(value: unknown): value is Stripe.Event {
  if (value === null || typeof value !== "object") return false;
  const event = value as { id?: unknown; type?: unknown; data?: unknown };
  const object = (event.data as { object?: unknown } | undefined)?.object;
  return (
    typeof event.id === "string" &&
    event.id.startsWith("evt_") &&
    typeof event.type === "string" &&
    object !== null &&
    typeof object === "object"
  );
}

export async function POST(request: Request): Promise<Response> {
  const secret = env.provisionSecret();
  if (!secret) {
    console.error("[healdesk] HEALDESK_PROVISION_SECRET is not set");
    return problem("Billing events are unavailable.", 503);
  }

  // 1. Authenticate — before parsing, before touching the database.
  const raw = await request.text();
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    console.warn("[healdesk] billing event rejected:", verification.reason);
    return problem("Unauthorized.", 401);
  }

  // 2. Parse.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return problem("Invalid request body.", 400);
  }
  if (!isStripeEvent(body)) {
    return problem("Not a Stripe event.", 400);
  }

  // 3. Apply. One request id per delivery correlates its audit rows.
  try {
    const result = await handleStripeEvent(body, { requestId: randomUUID() });
    return Response.json({
      received: true,
      outcome: result.outcome,
      duplicate: result.duplicate,
    });
  } catch (error) {
    // Recorded in billing_events already; this is the retry signal. Never
    // echo the payload — it carries the buyer's contact details.
    console.error("[healdesk] billing event failed; asking Stripe to retry", {
      event: body.id,
      type: body.type,
      error: error instanceof Error ? error.name : "unknown",
    });
    return problem("Could not apply event.", 500);
  }
}
