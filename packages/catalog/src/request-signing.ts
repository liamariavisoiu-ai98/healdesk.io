import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signing for the server-to-server call from checkout to provisioning.
 *
 * The marketing site (Vercel) and the product (AWS) are different hosts, so
 * this crosses a network boundary. A bare bearer token would be enough to stop
 * casual abuse, but this endpoint creates accounts and records a legal
 * agreement, so it is worth the extra few lines:
 *
 *   - the signature covers the BODY, so the payload can't be altered in flight
 *   - it covers a TIMESTAMP, so a captured request can't be replayed later
 *   - comparison is timing-safe
 *
 * Shared by both apps. apps/web signs; apps/app verifies.
 */

export const SIGNATURE_HEADER = "x-healdesk-signature";
export const TIMESTAMP_HEADER = "x-healdesk-timestamp";

/** Requests older than this are rejected, bounding the replay window. */
export const MAX_SKEW_SECONDS = 300;

export function sign(body: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function verify(
  body: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  now: number = Date.now(),
): VerificationResult {
  if (!timestamp || !signature) {
    return { ok: false, reason: "Missing signature headers." };
  }

  const issued = Number(timestamp);
  if (!Number.isFinite(issued)) {
    return { ok: false, reason: "Invalid timestamp." };
  }

  // Both directions: a far-future timestamp is as suspicious as a stale one.
  if (Math.abs(now / 1000 - issued) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "Request timestamp outside allowed window." };
  }

  const expected = Buffer.from(sign(body, timestamp, secret));
  const received = Buffer.from(signature);

  // Length check first — timingSafeEqual throws on a length mismatch, which
  // would itself leak that the lengths differ.
  if (expected.length !== received.length) {
    return { ok: false, reason: "Signature mismatch." };
  }
  if (!timingSafeEqual(expected, received)) {
    return { ok: false, reason: "Signature mismatch." };
  }

  return { ok: true };
}
