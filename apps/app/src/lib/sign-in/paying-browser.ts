import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/**
 * The browser that paid: the one that spent the checkout sign-in link at
 * /welcome (plan Part C3), marked so the device email (O3) can tell it apart.
 *
 * O3 goes to the clinic's address whenever a passkey is added, "except the
 * first, in the paying browser" (Annex X5): there, the person adding the
 * device is the person who just paid and is reading that inbox, so the email
 * tells them nothing. Anywhere else, a first passkey is a device gaining the
 * power to open patient details from a session nobody watched being made,
 * and the address must hear of it.
 *
 * The mark is a cookie, set when the checkout link is spent and the session
 * starts (app/link/[token]), because the session row records nothing about
 * the link that made it and this needs no migration: HttpOnly, scoped to the
 * whole app, SameSite=Lax, and holding only an expiry and an HMAC over the
 * user it was set for, keyed from BETTER_AUTH_SECRET. It names no clinic and
 * no address. It is read only for the one user it was set for, so another
 * sign-in in the same browser is not "the paying browser", and it lapses
 * after the plan's seven-day same-browser window for first enrolment
 * (Part D3). Losing it, or a browser that refuses it, costs one extra email,
 * never a missing one.
 *
 * It is that window too (lib/factors/authority.ts, basis `paying_browser`):
 * for its seven days, this browser may add the sign-in's first passkey ever
 * even once a clinic has gone live, so a buyer who skipped the Protect
 * screen after /welcome is not locked out of patient pages from the very
 * browser that paid. Losing the cookie then means a code from the backup or
 * the human route, never a device added on less.
 */

export const PAYING_BROWSER_COOKIE = "hd_paying_browser";

/** Part D3's same-browser window for first enrolment. */
export const PAYING_BROWSER_DAYS = 7;

const MAX_AGE_SECONDS = PAYING_BROWSER_DAYS * 24 * 60 * 60;

function mac(userId: string, expiresAt: number): Buffer {
  return createHmac("sha256", env.betterAuthSecret())
    .update(`paying-browser:${userId}:${expiresAt}`)
    .digest();
}

/** The cookie's value for `userId`, good for PAYING_BROWSER_DAYS from `now`. */
export function payingBrowserValue(userId: string, now: Date = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + MAX_AGE_SECONDS;
  return `${expiresAt}.${mac(userId, expiresAt).toString("base64url")}`;
}

/** The cookie as Next's cookies().set takes it. */
export function payingBrowserCookie(
  userId: string,
  now: Date = new Date(),
): {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    name: PAYING_BROWSER_COOKIE,
    value: payingBrowserValue(userId, now),
    httpOnly: true,
    secure: env.isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/**
 * Whether `value` marks this browser as the one `userId` paid in: a value
 * this app minted for that user, not yet expired. Constant-time on the MAC.
 */
export function isPayingBrowser(
  userId: string,
  value: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!value) return false;
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt * 1000 <= now.getTime()) return false;
  const given = Buffer.from(match[2]!, "base64url");
  const expected = mac(userId, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Mark this browser when the link it just spent is the checkout link, the
 * one only the paying browser is handed (lib/checkout/welcome.ts). Called by
 * /link/<token> once the session has started; any other link marks nothing.
 */
export function markPayingBrowser(
  link: { purpose: string; userId: string },
  store: { set(cookie: ReturnType<typeof payingBrowserCookie>): unknown },
  now: Date = new Date(),
): boolean {
  if (link.purpose !== "checkout") return false;
  store.set(payingBrowserCookie(link.userId, now));
  return true;
}
