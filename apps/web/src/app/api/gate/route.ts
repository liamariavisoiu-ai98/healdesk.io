import { isSpecialtyId } from "@healdesk/catalog";
import { NextResponse } from "next/server";

import {
  CONSENT_NOTICE_VERSION,
  MARKETING_CONSENT_LABEL,
} from "@/lib/consent";
import {
  GATE_COOKIE,
  createGateToken,
  gateCookieOptions,
  isBusinessEmail,
  isValidEmail,
} from "@/lib/gate";
import { recordDemoUnlock } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/gate, unlock the chat demo with an email.
 *
 * Every unlock is a lead, and now it is a row: `recordDemoUnlock()` upserts
 * on the normalised address in the marketing database (src/lib/db — not
 * apps/app's; this is a clinic operator's business email, not patient data).
 *
 * Two things arrive with the email and are recorded as separate facts:
 *
 *   - `marketingConsent`: did the visitor tick the "email me about AYA" box.
 *     Default false. Unlocking the demo is the service they asked for and is
 *     never treated as consent to marketing. When true, the exact wording of
 *     the box and the notice version are frozen onto the row — the same
 *     discipline the product's consent ledger uses: what the person saw at the
 *     moment of assent is what makes the record defensible later.
 *   - `noticeVersion`: which text they saw. The server compares it to the
 *     current constant and records the server's own copy of the wording, so a
 *     stale or tampered client cannot write a consent it never displayed.
 *
 * The store fails open: if it is unreachable the cookie is still set and the
 * demo runs. Losing a lead is bad; refusing a demo to someone who just typed
 * their email is worse.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const limit = await rateLimit(`gate:${clientKey(request.headers)}`, 10, 60 * 60 * 1000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const fields = (body ?? {}) as {
    email?: unknown;
    marketingConsent?: unknown;
    noticeVersion?: unknown;
    specialty?: unknown;
    campaign?: unknown;
  };

  const email = fields.email;
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const normalized = email.trim().toLowerCase();
  const business = isBusinessEmail(normalized);

  // Consent counts only when the box was ticked AND the client saw the notice
  // version the server currently publishes. Any other combination is stored
  // as no consent — never as an error, because the demo is not conditional on it.
  const consented =
    fields.marketingConsent === true &&
    fields.noticeVersion === CONSENT_NOTICE_VERSION;

  const specialty =
    typeof fields.specialty === "string" && isSpecialtyId(fields.specialty)
      ? fields.specialty
      : undefined;

  const campaign =
    typeof fields.campaign === "string" && /^[a-z0-9_-]{1,64}$/i.test(fields.campaign)
      ? fields.campaign
      : null;

  await recordDemoUnlock({
    email,
    isBusinessEmail: business,
    specialty,
    marketingConsent: consented,
    noticeVersion: consented ? CONSENT_NOTICE_VERSION : undefined,
    consentText: consented ? MARKETING_CONSENT_LABEL : undefined,
    referrer: request.headers.get("referer"),
    campaign,
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    GATE_COOKIE,
    createGateToken(normalized),
    gateCookieOptions(),
  );
  return response;
}
