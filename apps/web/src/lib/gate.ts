/**
 * Email gate for the live chat demo.
 *
 * The visitor submits an email, we set a signed HTTP-only cookie, and /api/chat
 * refuses to run without a valid one. The signature is what makes this worth
 * anything, an unsigned "gated=true" cookie is a one-line bypass in devtools.
 *
 * This is lead capture and abuse control, not authentication. It stops casual
 * scraping and turns each demo into a lead. It is not a security boundary, and
 * nothing behind it is sensitive.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { DEMO_ACCESS_DAYS } from "@/lib/consent";

export const GATE_COOKIE = "hd_demo";
// Seven days, by the owner's decision, and the same constant the privacy
// policy and the notice quote. It was 30 here while the decision log said 7.
const MAX_AGE_SECONDS = 60 * 60 * 24 * DEMO_ACCESS_DAYS;

function secret(): string {
  const value = process.env.HEALDESK_GATE_SECRET;
  if (value) return value;

  if (process.env.NODE_ENV === "production") {
    // Failing loudly beats silently signing every cookie with a known string.
    throw new Error(
      "HEALDESK_GATE_SECRET is required in production, the demo gate cannot be signed without it.",
    );
  }
  return "dev-only-insecure-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Reasonable email shape check. Deliberately permissive. This is a gate, not a validator. */
export function isValidEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

/** Free-mail domains still get through; this only flags them for lead scoring. */
export function isBusinessEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const consumer = new Set([
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ]);
  return domain.length > 0 && !consumer.has(domain);
}

export function createGateToken(email: string): string {
  const issuedAt = Date.now();
  const payload = `${Buffer.from(email).toString("base64url")}.${issuedAt}`;
  return `${payload}.${sign(payload)}`;
}

export type GateClaims = { email: string; issuedAt: number };

export function verifyGateToken(token: string | undefined): GateClaims | null {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedEmail, issuedAtRaw, signature] = parts as [
    string,
    string,
    string,
  ];
  const payload = `${encodedEmail}.${issuedAtRaw}`;

  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > MAX_AGE_SECONDS * 1000) return null;

  return {
    email: Buffer.from(encodedEmail, "base64url").toString("utf8"),
    issuedAt,
  };
}

export function gateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}
