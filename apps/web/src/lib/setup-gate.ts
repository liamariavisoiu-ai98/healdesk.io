import { demoSlugFromCookieHeader } from "@/lib/demo/attribution";
import { getDemoSession, type DemoSession } from "@/lib/demo/sessions";
import { cohortCreditLive, findLeadById } from "@/lib/leads";
import { checkoutMode } from "@/lib/checkout-mode";
import { findSetupRequest } from "@/lib/setup-requests";
import { setupTokenRequestId, verifySetupToken } from "@/lib/setup-link";
import type { SetupRequest } from "@/lib/sheets/schema";
import { site } from "@/lib/site";

/**
 * May this browser buy right now, and if so, as whom?
 *
 * The one place the answer is worked out, so the page that shows the
 * purchase flow, the route that tells the purchase modal what to render,
 * and the two routes that enforce it (/api/agreement, /api/checkout) cannot
 * disagree. In public mode anyone may. In pilot mode only a browser holding
 * a valid setup link for a request that is not paid or declined may, and the
 * purchase is bound to that request's email.
 */
export type SetupLinkState = "none" | "invalid" | "expired" | "replaced" | "used";

export type GateState =
  | { mode: "public" }
  | { mode: "pilot"; link: "valid"; request: SetupRequest; expiresAt: Date }
  | { mode: "pilot"; link: SetupLinkState };

export async function gateState(token: string | null | undefined, now: Date = new Date()): Promise<GateState> {
  if (checkoutMode() === "public") return { mode: "public" };
  if (!token) return { mode: "pilot", link: "none" };
  const requestId = setupTokenRequestId(token);
  if (!requestId) return { mode: "pilot", link: "invalid" };

  let request: SetupRequest | null;
  try {
    request = await findSetupRequest(requestId);
  } catch (error) {
    // A Sheet outage closes the gate rather than opening it.
    console.error("[healdesk] setup gate could not read the request", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { mode: "pilot", link: "invalid" };
  }
  if (!request || request.status === "declined") return { mode: "pilot", link: "invalid" };

  // The signature first: a forged token learns nothing about the request,
  // not even that it was paid. A genuine one, however old, is told the most
  // useful thing first: that the purchase already happened.
  const check = verifySetupToken(token, request.email, now);
  if (!check.ok && check.reason !== "expired") return { mode: "pilot", link: "invalid" };
  if (request.status === "paid" || request.paidAt) return { mode: "pilot", link: "used" };
  if (!check.ok) return { mode: "pilot", link: "expired" };
  // Only the latest link sent works. Resending mints a new expiry, and the
  // request keeps only that one, so a link from an earlier email (forwarded,
  // or sitting in a shared inbox) stops working the moment a new one goes.
  if (!request.linkExpiresAt) return { mode: "pilot", link: "invalid" };
  if (request.linkExpiresAt.getTime() !== check.expiresAt.getTime()) {
    return { mode: "pilot", link: "replaced" };
  }
  return { mode: "pilot", link: "valid", request, expiresAt: check.expiresAt };
}

/**
 * Until when the setup credit holds for this request, or null. A fact about
 * the lead row the request came from, never a claim from the browser, exactly
 * as the checkout has always treated it.
 */
export async function creditUntil(request: SetupRequest, validDays: number): Promise<Date | null> {
  if (!request.leadId) return null;
  const lead = await findLeadById(request.leadId);
  if (!lead || !cohortCreditLive(lead) || !lead.cohortCreditOfferedAt) return null;
  return new Date(lead.cohortCreditOfferedAt.getTime() + validDays * 24 * 60 * 60 * 1000);
}

/**
 * The refusal for a pilot-mode browser whose setup link can't buy, or null
 * when the link is good. /api/agreement and /api/checkout both answer with
 * it, so the two steps refuse in the same words and under the same field.
 */
export function refuseWithoutLink(gate: Extract<GateState, { mode: "pilot" }>): Response | null {
  if (gate.link === "valid") return null;
  const askAgain = `Ask for a new one at ${site.url}/get-started.`;
  const messages: Record<SetupLinkState, string> = {
    none: `Purchases open with your setup link. ${askAgain}`,
    invalid: `This setup link isn't valid. ${askAgain}`,
    expired: `Your setup link has expired. ${askAgain}`,
    replaced: "This setup link was replaced by a newer one. Use the link in our latest email.",
    used: "This setup link has already been used to complete a purchase.",
  };
  return Response.json(
    { error: messages[gate.link], field: "setupLink", link: gate.link },
    { status: gate.link === "used" ? 409 : 403 },
  );
}

/**
 * The refusal when the address given isn't the one the link was sent to.
 * That address becomes the clinic's sign-in, billing and notice address, so
 * a forwarded link cannot be used to buy, or sign, under another.
 */
export function refuseOtherEmail(request: SetupRequest, field: string): Response {
  return Response.json(
    {
      error: `Your setup link is for ${request.email}. Use that address, or reply to the email it came in and we'll send a new link.`,
      field,
    },
    { status: 422 },
  );
}

/**
 * A personalised demo counts as the invitation (owner, 7 October 2026).
 *
 * The operator built that demo for one prospect who asked for it, which is
 * the same act of choosing a buyer a setup link records, so its "Book
 * Onboarding" opens the purchase directly instead of "Tell us about your
 * clinic". The demo travels in the first-party cookie its onboard route
 * sets (lib/demo/attribution.ts) and is re-read here, never taken from the
 * browser's word: it must exist, be built, and not have been bought already.
 * The purchase is not bound to the demo's email, because the operator may
 * not have had the owner's own address when building it.
 */
export async function demoInvitation(cookieHeader: string | null): Promise<DemoSession | null> {
  const slug = demoSlugFromCookieHeader(cookieHeader);
  if (!slug) return null;
  const session = await getDemoSession(slug);
  return session && session.status === "ready" && !session.claimed ? session : null;
}
