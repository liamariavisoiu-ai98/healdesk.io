import { COHORT_SETUP_CREDIT } from "@healdesk/catalog";

import { chooseSetupOffer, demoOfferFor, SETUP_OFFER_CREDITS, type SetupOffer } from "@/lib/billing";
import { demoSlugFromCookieHeader } from "@/lib/demo/attribution";
import { demoOfferEndsAt, demoSetupCredit, getDemoSession } from "@/lib/demo/sessions";
import { replyByDate } from "@/lib/reply-by";
import { creditUntil, gateState } from "@/lib/setup-gate";
import { requestChannels } from "@/lib/setup-requests";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";
import { siteOfferEndsAt } from "@/lib/site-offer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The setup offer the purchase would carry if the buyer paid now: the same
 * choice /api/checkout makes (lib/billing.ts `chooseSetupOffer`), from the
 * same server-side facts, so "Due today" and the Session agree. Null for none.
 * `kind` is the offer's name as the Session's metadata carries it.
 */
export type ModeOffer = { kind: SetupOffer; percentOfSetupFee: number; endsAt: string } | null;

/**
 * GET /api/checkout/mode: what the purchase modal should show.
 *
 * The homepage and the other marketing pages are static, so they cannot read the
 * environment or the setup cookie at request time. The modal asks here
 * instead, uncached, each time it opens:
 * - `public`: the purchase flow;
 * - pilot with a valid setup link: the purchase flow, pre-filled from the
 *   request, its email fixed;
 * - pilot otherwise: "Tell us about your clinic", with a note when a link
 *   was expired, replaced or already used, and the date we reply by.
 *
 * What comes back about the request is what the person who holds the link
 * already gave us: their name, clinic, website, address and the channels they
 * asked for. Nothing else.
 * Beside the purchase goes one setting of this server's, whether Stripe Tax
 * is on, so Review and pay can say "Plus sales tax where it applies", and the
 * setup offer that would apply (`offer`, since 13 October 2026): the
 * founding-cohort credit of the lead a setup link came from, the 50% of the
 * personalised demo the buyer came from, or the website's 30% once the
 * buyer's browser has been shown it (POST /api/site-offer starts that clock;
 * this only reads it). `creditUntil` is the cohort credit's end alone, kept
 * for the modal that reads it.
 */
export async function GET(request: Request): Promise<Response> {
  const state = await gateState(readCookie(request.headers, SETUP_COOKIE));
  const headers = { "Cache-Control": "no-store" };

  const salesTax = process.env.STRIPE_AUTOMATIC_TAX === "true";
  const cookieHeader = request.headers.get("cookie");

  if (state.mode === "public") {
    const offer = await offerFor(cookieHeader, null);
    return Response.json({ mode: "public", salesTax, offer }, { headers });
  }
  if (state.link !== "valid") {
    // The date the form promises a reply by, worked out here so the page and
    // the acknowledgement email can't name different days.
    return Response.json({ mode: "pilot", link: state.link, replyBy: replyByDate() }, { headers });
  }

  const until = await creditUntil(state.request, COHORT_SETUP_CREDIT.validDays).catch(() => null);
  const offer = await offerFor(cookieHeader, until);
  return Response.json(
    {
      mode: "pilot",
      link: "valid",
      setup: {
        name: state.request.name,
        clinicName: state.request.clinicName,
        email: state.request.email,
        website: state.request.website,
        // What they asked AYA on, so the purchase opens on that package.
        channels: requestChannels(state.request),
      },
      creditUntil: until?.toISOString() ?? null,
      salesTax,
      offer,
    },
    { headers },
  );
}

/** The offer, from the cohort credit's end (if any), the demo cookie and the offer cookie. Never throws. */
async function offerFor(cookieHeader: string | null, cohortEndsAt: Date | null): Promise<ModeOffer> {
  const slug = demoSlugFromCookieHeader(cookieHeader);
  const demo = slug ? await getDemoSession(slug).catch(() => null) : null;
  const chosen = chooseSetupOffer({
    cohort: cohortEndsAt,
    demo: demo ? demoOfferEndsAt(demo) : null,
    demoOffer: demo ? demoOfferFor(demoSetupCredit(demo)) : undefined,
    site: siteOfferEndsAt(cookieHeader),
  });
  if (!chosen) return null;
  return {
    kind: chosen.offer,
    percentOfSetupFee: SETUP_OFFER_CREDITS[chosen.offer].percentOfSetupFee,
    endsAt: chosen.endsAt.toISOString(),
  };
}
