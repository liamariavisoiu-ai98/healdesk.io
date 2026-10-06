import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { DEMO_COOKIE, demoCookieOptions } from "@/lib/demo/attribution";
import { getDemoSession, isDemoSlug } from "@/lib/demo/sessions";

/**
 * GET /demo/[slug]/onboard, the "Book Onboarding" button.
 *
 * Remembers which demo the buyer came from in a first-party cookie, then
 * sends them to the normal checkout, where they choose voice, website chat or
 * a bundle and pay through Stripe. /get-started reads the cookie to prefill
 * the clinic's name and email, /api/checkout carries it to the Stripe Session
 * as metadata, and the Stripe webhook marks the demo claimed.
 *
 * A cookie rather than `/get-started?demo=<slug>`, because the slug is the
 * key to the demo and /get-started runs analytics: a query string would be
 * recorded with the pageview, and the cookie never leaves our own origin.
 */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const target = new URL("/get-started", request.url);
  if (!isDemoSlug(slug)) return NextResponse.redirect(target, 303);

  // Expired is fine: a prospect who comes back after the week can still buy.
  const session = await getDemoSession(slug);
  if (session) {
    const store = await cookies();
    store.set(DEMO_COOKIE, slug, demoCookieOptions());
  }
  return NextResponse.redirect(target, 303);
}
