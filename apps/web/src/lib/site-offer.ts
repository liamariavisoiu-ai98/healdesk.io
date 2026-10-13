import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { isSetupCreditLive, SITE_SETUP_CREDIT, setupCreditEndsAt } from "@healdesk/catalog";

/**
 * The website's setup offer: 30% off the setup fee for 48 hours from the
 * moment a visitor is first shown it (catalog `SITE_SETUP_CREDIT`, owner,
 * 13 October 2026).
 *
 * The moment lives in an httpOnly cookie, `<offeredAtMs>.<mac>`, signed with
 * a key derived from `HEALDESK_GATE_SECRET` under its own purpose string, like
 * the setup link (lib/setup-link.ts). Signed because /api/checkout reads it
 * to decide whether the coupon goes on the Session: a cookie the browser
 * could write would let anyone restart the clock, or name a moment in the
 * future, and keep the discount for good. A visitor who clears their cookies
 * is shown the offer again from that moment; that is the nature of an offer
 * made to a browser, and the server never trusts anything else about it.
 *
 * Set by POST /api/site-offer, which the pricing page and the funnel call on
 * first view; it never moves a moment already set.
 */

export const SITE_OFFER_COOKIE = "hd_offer";

const KEY_PURPOSE = "healdesk.site-offer.v1";
const DEV_ONLY_SECRET = "dev-only-insecure-secret";

function signingKey(): Buffer | null {
  const configured = process.env.HEALDESK_GATE_SECRET;
  if (configured !== undefined && configured.length > 0) {
    return createHmac("sha256", configured).update(KEY_PURPOSE).digest();
  }
  if (process.env.NODE_ENV === "production") return null;
  return createHmac("sha256", DEV_ONLY_SECRET).update(KEY_PURPOSE).digest();
}

function mac(key: Buffer, offeredAtMs: string): string {
  return createHmac("sha256", key).update(offeredAtMs).digest("base64url");
}

function equals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

/** The cookie value for an offer made at `now`, or null when there is nothing safe to sign with. */
export function siteOfferToken(now: Date = new Date()): string | null {
  const key = signingKey();
  if (!key) return null;
  const at = String(now.getTime());
  return `${at}.${mac(key, at)}`;
}

/** When the offer in a cookie value was made, or null for anything unsigned, malformed or in the future. */
export function readSiteOfferToken(token: string | null | undefined, now: number = Date.now()): Date | null {
  if (typeof token !== "string") return null;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const key = signingKey();
  if (!key || !equals(mac(key, match[1]!), match[2]!)) return null;
  const at = Number(match[1]);
  return at <= now ? new Date(at) : null;
}

/** The offer's moment from a raw Cookie header. */
export function siteOfferFromCookieHeader(header: string | null | undefined, now: number = Date.now()): Date | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SITE_OFFER_COOKIE) return readSiteOfferToken(decodeURIComponent(rest.join("=")), now);
  }
  return null;
}

export type SiteOfferState = {
  /** ISO time the 30% ends; null when it has ended. */
  endsAt: string | null;
};

/** What a page shows for an offer made at `offeredAt`. */
export function siteOfferState(offeredAt: Date, now: number = Date.now()): SiteOfferState {
  return {
    endsAt: isSetupCreditLive(SITE_SETUP_CREDIT, offeredAt, now)
      ? setupCreditEndsAt(SITE_SETUP_CREDIT, offeredAt).toISOString()
      : null,
  };
}

/** Whether checkout should apply the website's credit, from the request's Cookie header. */
export function siteOfferLive(header: string | null | undefined, now: number = Date.now()): boolean {
  const at = siteOfferFromCookieHeader(header, now);
  return at !== null && isSetupCreditLive(SITE_SETUP_CREDIT, at, now);
}

/**
 * When the website's credit in a Cookie header ends, or null when there is
 * none or it has ended: what checkout and /api/checkout/mode compare against
 * the other setup offers (lib/billing.ts `chooseSetupOffer`). Never starts
 * the clock; only POST /api/site-offer does that.
 */
export function siteOfferEndsAt(header: string | null | undefined, now: number = Date.now()): Date | null {
  const at = siteOfferFromCookieHeader(header, now);
  return at !== null && isSetupCreditLive(SITE_SETUP_CREDIT, at, now) ? setupCreditEndsAt(SITE_SETUP_CREDIT, at) : null;
}

/**
 * Cookie options. It outlives the offer by a long way on purpose: a visitor
 * who comes back on day three must find the offer over, not a fresh one.
 */
export function siteOfferCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  };
}
