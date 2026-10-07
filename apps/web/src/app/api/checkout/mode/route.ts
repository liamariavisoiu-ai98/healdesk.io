import { COHORT_SETUP_CREDIT } from "@healdesk/catalog";

import { replyByDate } from "@/lib/reply-by";
import { creditUntil, gateState } from "@/lib/setup-gate";
import { readCookie, SETUP_COOKIE } from "@/lib/setup-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/checkout/mode: what the purchase modal should show.
 *
 * The homepage and pricing pages are static, so they cannot read the
 * environment or the setup cookie at request time. The modal asks here
 * instead, uncached, each time it opens:
 * - `public`: the purchase flow;
 * - pilot with a valid setup link: the purchase flow, pre-filled from the
 *   request, its email fixed;
 * - pilot otherwise: "Tell us about your clinic", with a note when a link
 *   was expired, replaced or already used, and the date we reply by.
 *
 * What comes back about the request is what the person who holds the link
 * already gave us: their name, clinic, website and address. Nothing else.
 * Beside the purchase goes one setting of this server's, whether Stripe Tax
 * is on, so Review and pay can say "Plus sales tax where it applies".
 */
export async function GET(request: Request): Promise<Response> {
  const state = await gateState(readCookie(request.headers, SETUP_COOKIE));
  const headers = { "Cache-Control": "no-store" };

  const salesTax = process.env.STRIPE_AUTOMATIC_TAX === "true";

  if (state.mode === "public") return Response.json({ mode: "public", salesTax }, { headers });
  if (state.link !== "valid") {
    // The date the form promises a reply by, worked out here so the page and
    // the acknowledgement email can't name different days.
    return Response.json({ mode: "pilot", link: state.link, replyBy: replyByDate() }, { headers });
  }

  const until = await creditUntil(state.request, COHORT_SETUP_CREDIT.validDays).catch(() => null);
  return Response.json(
    {
      mode: "pilot",
      link: "valid",
      setup: {
        name: state.request.name,
        clinicName: state.request.clinicName,
        email: state.request.email,
        website: state.request.website,
      },
      creditUntil: until?.toISOString() ?? null,
      salesTax,
    },
    { headers },
  );
}
