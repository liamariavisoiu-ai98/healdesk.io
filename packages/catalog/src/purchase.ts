import { getBookingSystem, type BookingSystemId } from "./booking-systems";
import { NO_PLATFORM_ID } from "./platforms";
import type { Plan } from "./plans";

/**
 * The purchase rules both sides of the boundary enforce: the funnel in
 * apps/web, before it asks anyone for anything, and the checkout intent in
 * apps/app, before anyone pays (plan Part A3 and A4).
 *
 * Here rather than in either app because a rule the two apply differently is
 * a buyer refused at Pay for something the form accepted, or, worse, a
 * purchase apps/web let through that apps/app should have stopped.
 */

/**
 * The website as the funnel keeps it: host and optional path, without the
 * scheme or a trailing slash, at most 200 characters, or null when it is not
 * a website at all. The setup request, the site read and the checkout all
 * read a typed website through this, and ClinicProfile's `website` is exactly
 * what it returns, so a profile and the purchase it rides on can be compared
 * by equality.
 */
export function cleanWebsite(value: unknown): string | null {
  const raw = (typeof value === "string" ? value.trim().slice(0, 200) : "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!raw) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i.test(raw) ? raw : null;
}

/**
 * Whether a plan needs the clinic to have a website: one whose only chat is
 * website chat (Web Chat, Voice + Web Chat). A practice with no website is not
 * sold web chat (v1 spec, "Stage 0": "Web chat is simply not sold to it"), so
 * the funnel offers it voice and Meta Chat, and both servers refuse the rest.
 * Meta Chat includes website chat but does not need it: Instagram, Messenger
 * and WhatsApp answer without one, and the website line is never switched on.
 */
export function planNeedsWebsite(plan: Plan): boolean {
  return plan.chatProduct === "webchat";
}

/**
 * The phase-two platform id an agreement before BAA 1.3.0 names, from the
 * v1 booking system: the same system on the phase-two list, or "none".
 *
 * The released agreement (1.2.1) still renders from `platform`, and apps/app
 * still requires it on a signature and on a purchase, so the funnel sends
 * both, and this is the one place the second is derived from the first. The
 * agreement's preview (buildBaaSelections with `platformId`), the signature
 * request and the checkout intent all pass this value, so the hash the buyer
 * saw and the one the server stores cannot drift apart over it.
 */
export function agreementPlatformFor(bookingSystem: BookingSystemId): string {
  return getBookingSystem(bookingSystem)?.phaseTwoPlatformId ?? NO_PLATFORM_ID;
}
