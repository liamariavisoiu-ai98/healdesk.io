import { NextResponse } from "next/server";

import {
  readSiteOfferToken,
  SITE_OFFER_COOKIE,
  siteOfferCookieOptions,
  siteOfferState,
  siteOfferToken,
} from "@/lib/site-offer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/site-offer: start the website's 48-hour setup offer for this
 * browser if it has not started, and say when it ends (lib/site-offer.ts).
 *
 * Idempotent: a browser whose cookie already holds a moment keeps it, so
 * reloading the page never restarts the clock. A POST, not a GET, so a
 * crawler or a link preview never starts one.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const now = new Date();
  const header = request.headers.get("cookie") ?? "";
  const existing = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SITE_OFFER_COOKIE}=`));
  const held = existing ? readSiteOfferToken(decodeURIComponent(existing.slice(SITE_OFFER_COOKIE.length + 1)), now.getTime()) : null;
  if (held) return NextResponse.json(siteOfferState(held, now.getTime()));

  const token = siteOfferToken(now);
  if (!token) return NextResponse.json({ endsAt: null });
  const response = NextResponse.json(siteOfferState(now, now.getTime()));
  response.cookies.set(SITE_OFFER_COOKIE, token, siteOfferCookieOptions());
  return response;
}
