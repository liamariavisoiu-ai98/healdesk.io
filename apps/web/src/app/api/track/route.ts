import { NextResponse } from "next/server";

import { EVENTS, sanitize, type EventName } from "@/lib/analytics";
import { GATE_COOKIE, verifyGateToken } from "@/lib/gate";
import { findLeadByEmail, recordLeadEvent } from "@/lib/leads";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/track — the first-party mirror of the funnel.
 *
 * PostHog runs only with consent and only in the browser. This endpoint is
 * the other half of the instrumentation: for a visitor the demo gate has
 * already identified (the signed hd_demo cookie), each named funnel step is
 * appended to lead_events, so the numbers survive a vendor change and can
 * be joined to the lead's segment and campaign server-side.
 *
 * It accepts only names from the EVENTS allowlist and only their allowlisted
 * properties, through the same sanitize() the browser client uses — an
 * email address or a phone number in a property is dropped before it lands.
 * Without a gate cookie it is a 204: nothing is recorded about anonymous
 * visitors here, ever.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const limit = await rateLimit(`track:${clientKey(request.headers)}`, 240, 60 * 60 * 1000);
  if (!limit.ok) return new NextResponse(null, { status: 429 });

  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GATE_COOKIE}=`))
    ?.slice(GATE_COOKIE.length + 1);
  const claims = verifyGateToken(token);
  if (!claims) return new NextResponse(null, { status: 204 });

  let body: { event?: unknown; props?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const name = typeof body.event === "string" && body.event in EVENTS ? (body.event as EventName) : null;
  if (!name) return new NextResponse(null, { status: 400 });

  const lead = await findLeadByEmail(claims.email);
  if (!lead) return new NextResponse(null, { status: 204 });

  const props =
    body.props && typeof body.props === "object" ? (body.props as Record<string, unknown>) : undefined;
  await recordLeadEvent(lead.id, name, sanitize(name, props));
  return new NextResponse(null, { status: 204 });
}
