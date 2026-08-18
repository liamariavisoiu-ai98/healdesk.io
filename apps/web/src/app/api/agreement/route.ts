import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";

import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/agreement — sign the BAA, before payment.
 *
 * Same shape as /api/checkout: the marketing site never talks to the product
 * database, it signs the payload and forwards it. What differs is when it runs.
 * This is called while the buyer is still on the signature step, BEFORE a
 * payment session is created — because a business associate may not receive
 * patient data without a written contract, and "we'll record it when the
 * webhook lands" is not a contract.
 *
 * The practical consequence is that an abandoned checkout leaves a signed
 * agreement with no organization attached. That is correct and deliberate. See
 * apps/app/src/lib/agreements.ts.
 *
 * Rate limited harder than checkout, because this endpoint writes a row on
 * every call and the caller is unauthenticated by construction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.HEALDESK_PROVISION_SECRET;
  const target = process.env.HEALDESK_APP_URL;

  if (!secret || !target) {
    console.error(
      "[healdesk] HEALDESK_PROVISION_SECRET or HEALDESK_APP_URL is not set",
    );
    return Response.json({ error: "Signing is unavailable." }, { status: 503 });
  }

  const limit = rateLimit(
    `agreement:${clientKey(request.headers)}`,
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
  const timestamp = Math.floor(Date.now() / 1000).toString();

  let response: Response;
  try {
    response = await fetch(new URL("/api/agreements", target), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(raw, timestamp, secret),
        // Forwarded so the acceptance record shows where the signature came
        // from, not where our server sits.
        "x-forwarded-for":
          request.headers.get("x-forwarded-for") ??
          request.headers.get("x-real-ip") ??
          "",
        "user-agent": request.headers.get("user-agent") ?? "",
      },
      body: raw,
    });
  } catch (error) {
    console.error("[healdesk] signing endpoint unreachable", error);
    return Response.json(
      { error: "We couldn't record your agreement. Please try again." },
      { status: 502 },
    );
  }

  const payload = await response.text();
  return new Response(payload, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
