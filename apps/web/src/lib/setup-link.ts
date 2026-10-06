import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { site } from "@/lib/site";

/**
 * The setup link: what an operator sends a clinic that asked for setup, and
 * the only thing that opens the checkout while the purchase is by invitation
 * (`lib/checkout-mode.ts`).
 *
 * ## The token
 *
 * `<requestId>.<expiresAt>.<mac>`, where the MAC covers the request id, the
 * expiry and the email the request was made with. The id is readable because
 * the checkout has to find the request it pre-fills from; the email is not in
 * the token at all, so it never sits in a URL, a referrer or a log line. The
 * verifier reads the email back from the stored request, so a token minted
 * for one request cannot be presented against another, and an operator who
 * corrects a request's email invalidates the links sent to the old one.
 *
 * Built like `lib/agreement-download.ts`: a key derived from
 * `HEALDESK_GATE_SECRET` under its own purpose string, an injective MAC input
 * (base64url segments joined by dots), the expiry signed as the exact digits
 * stored, and a constant-time comparison of digests.
 *
 * ## What it is not
 *
 * It is not a sign-in. It proves the browser holds the link we emailed, for
 * fourteen days, and nothing about who is typing. Single use is enforced on
 * top: once the request is paid, the checkout refuses the link however valid
 * its signature, and from M2 a unique `invite_ref` on the checkout intent
 * makes that a database constraint as well.
 */

export const SETUP_COOKIE = "hd_setup";

/** Fourteen days: long enough for a clinic owner to find a quiet hour. */
export const SETUP_LINK_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY_PURPOSE = "healdesk.setup-link.v1";
const DEV_ONLY_SECRET = "dev-only-insecure-secret";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingKey(): Buffer | null {
  const configured = process.env.HEALDESK_GATE_SECRET;
  if (configured !== undefined && configured.length > 0) {
    return createHmac("sha256", configured).update(KEY_PURPOSE).digest();
  }
  if (process.env.NODE_ENV === "production") return null;
  return createHmac("sha256", DEV_ONLY_SECRET).update(KEY_PURPOSE).digest();
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function mac(key: Buffer, requestId: string, expiresAt: string, email: string): string {
  return createHmac("sha256", key)
    .update(`${b64(requestId)}.${expiresAt}.${b64(email.trim().toLowerCase())}`)
    .digest("base64url");
}

function equals(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );
}

/** When a link minted now stops working. */
export function setupLinkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SETUP_LINK_TTL_DAYS * DAY_MS);
}

/**
 * The token for one setup request. Deterministic for a given expiry, so the
 * reminder (P5) carries the very link the first email did. Throws when there
 * is nothing safe to sign with.
 */
export function issueSetupToken(requestId: string, email: string, expiresAt: Date): string {
  if (!UUID.test(requestId)) throw new Error("A setup link needs the request's uuid.");
  if (!email.includes("@")) throw new Error("A setup link needs the request's email.");
  const key = signingKey();
  if (!key) throw new Error("HEALDESK_GATE_SECRET is required in production to sign setup links.");
  const expiry = String(expiresAt.getTime());
  return `${requestId}.${expiry}.${mac(key, requestId, expiry, email)}`;
}

/**
 * The request id a token names, from its shape alone, or null. Never trust
 * the id until `verifySetupToken` has checked it against the stored request.
 */
export function setupTokenRequestId(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [requestId, expiry] = parts as [string, string, string];
  if (!UUID.test(requestId) || !/^[0-9]{1,15}$/.test(expiry)) return null;
  return requestId;
}

export type SetupTokenCheck =
  | { ok: true; requestId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "forged" | "expired" };

/**
 * Is this token one we minted for this request's email, and still in date?
 * Never throws: the token is attacker-chosen.
 */
export function verifySetupToken(
  token: string | null | undefined,
  email: string,
  now: Date = new Date(),
): SetupTokenCheck {
  const requestId = setupTokenRequestId(token);
  if (!requestId) return { ok: false, reason: "malformed" };
  const key = signingKey();
  if (!key) return { ok: false, reason: "forged" };
  const [, expiry, signature] = (token as string).split(".") as [string, string, string];
  if (!equals(mac(key, requestId, expiry, email), signature)) return { ok: false, reason: "forged" };
  const expiresAt = new Date(Number(expiry));
  if (now.getTime() >= expiresAt.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, requestId, expiresAt };
}

/** The address in the email: a route that swaps the token for a cookie. */
export function setupLinkUrl(token: string): string {
  return `${site.url}/start?t=${encodeURIComponent(token)}`;
}

export type SetupCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

/**
 * `lax`, not `strict`: the link is clicked from an email, which is a
 * cross-site navigation, and the cookie is set on that very response, so it
 * only has to ride along on this site's own requests afterwards. Path `/`
 * because the page that reads it (/get-started) and the routes that enforce
 * it (/api/checkout, /api/agreement) share no narrower prefix.
 */
export function setupCookieOptions(expiresAt: Date, now: Date = new Date()): SetupCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  };
}

/** One cookie's value from a raw Cookie header, so route handlers stay testable without Next. */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
