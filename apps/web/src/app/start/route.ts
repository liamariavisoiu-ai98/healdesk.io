import { NextResponse } from "next/server";

import { gateState } from "@/lib/setup-gate";
import { SETUP_COOKIE, setupCookieOptions } from "@/lib/setup-link";
import { updateSetupRequest } from "@/lib/setup-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /start?t=<setup link token>: where the setup link in P4 and P5 points.
 *
 * It swaps the token for an httpOnly cookie and redirects to a clean
 * /get-started, so the token never sits in the address bar, in the
 * browser's history of /get-started, or in an analytics page view. The page
 * and the purchase routes read the cookie (lib/setup-gate.ts).
 *
 * A link that is not valid still lands on /get-started, with a word for the
 * page to explain what happened, rather than on an error: an expired link
 * is a person who wants to buy, and the page offers them a new one.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  const state = await gateState(token);

  if (state.mode === "public") {
    return NextResponse.redirect(new URL("/get-started", url), 303);
  }
  if (state.link !== "valid") {
    return NextResponse.redirect(new URL(`/get-started?link=${state.link}`, url), 303);
  }

  if (!state.request.openedAt) {
    try {
      await updateSetupRequest(state.request.id, { openedAt: new Date() });
    } catch {
      // Progress tracking for /admin; never a reason to refuse the link.
    }
  }

  const response = NextResponse.redirect(new URL("/get-started", url), 303);
  response.cookies.set(SETUP_COOKIE, token as string, setupCookieOptions(state.expiresAt));
  return response;
}
