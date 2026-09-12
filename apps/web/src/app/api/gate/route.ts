import { NextResponse } from "next/server";

import {
  GATE_COOKIE,
  createGateToken,
  gateCookieOptions,
  isBusinessEmail,
  isValidEmail,
} from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/gate, unlock the chat demo with an email.
 *
 * Every unlock is a lead. Right now it only logs; wire this to your CRM
 * (or a Postgres table on the marketing side, note this is business contact
 * data, not PHI, so it does not belong in the apps/app boundary).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const limit = rateLimit(`gate:${clientKey(request.headers)}`, 10, 60 * 60 * 1000);
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

  const email = (body as { email?: unknown } | null)?.email;
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const normalized = email.trim().toLowerCase();

  // TODO: persist to CRM. Keep it out of the PHI boundary. This is a clinic
  // operator's business email, not patient data.
  console.info("[healdesk] demo unlocked", {
    email: normalized,
    business: isBusinessEmail(normalized),
    at: new Date().toISOString(),
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    GATE_COOKIE,
    createGateToken(normalized),
    gateCookieOptions(),
  );
  return response;
}
