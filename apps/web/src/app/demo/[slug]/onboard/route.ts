import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { planLink } from "@/lib/checkout/funnel";
import { DEMO_COOKIE, demoCookieOptions } from "@/lib/demo/attribution";
import { demoVariant } from "@/lib/demo/close";
import { demoEventDetail, recordDemoEvent } from "@/lib/demo/events";
import { getDemoSession, isDemoSlug } from "@/lib/demo/sessions";

/**
 * GET /demo/[slug]/onboard, the "Book Onboarding" button of a demo an
 * operator built. POST is the same cookie for a homepage demo's "Get AYA",
 * which opens the purchase in place (components/BuyModal.tsx) and so asks
 * for the cookie without leaving the page.
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
  const known = await remember(slug);
  const asked = new URL(request.url).searchParams;
  // Which button was pressed, counted here rather than from the page, so the
  // press is recorded even when the browser leaves before a beacon would land.
  if (known) {
    const from = demoEventDetail("cta_clicked", asked.get("from"));
    if (from) await recordDemoEvent({ slug, variant: demoVariant(slug), name: "cta_clicked", detail: from });
  }
  // The package the demo recommended, at its steps: checkout opens on it
  // (`planLink` decides; anything it does not know preselects nothing). Plan
  // ids are catalog names, not the slug, so analytics on /get-started may see them.
  const next = new URL("/get-started", request.url);
  const plan = asked.get("plan");
  if (plan && planLink(plan)) next.searchParams.set("plan", plan);
  return NextResponse.redirect(next, 303);
}

export async function POST(_request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  return new Response(null, { status: (await remember(slug)) ? 204 : 404 });
}

/** Set the cookie for a demo that exists. Expired is fine: a prospect who comes back after the week can still buy. */
async function remember(slug: string): Promise<boolean> {
  if (!isDemoSlug(slug)) return false;
  const session = await getDemoSession(slug);
  if (!session) return false;
  const store = await cookies();
  store.set(DEMO_COOKIE, slug, demoCookieOptions());
  return true;
}
