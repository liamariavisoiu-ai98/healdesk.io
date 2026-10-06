import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Retell's `X-Retell-Signature` on a tool call or webhook.
 *
 * The header is `v={unix ms},d={hex}`, where the digest is
 * HMAC-SHA256(rawBody + timestamp) keyed with the Retell API key that carries
 * the webhook badge in Retell's dashboard. Done by hand rather than with
 * retell-sdk, which would be a dependency for one function. The scheme is
 * transcribed from https://docs.retellai.com/features/secure-webhook.md
 * ("Verify Without SDK").
 *
 * It must be given the raw body exactly as received: JSON that has been
 * parsed and re-serialised can differ in whitespace or key order and will
 * not verify. Signatures older than five minutes are refused, so a captured
 * request cannot be replayed later.
 */

const MAX_SKEW_MS = 5 * 60_000;

export function verifyRetellSignature(
  rawBody: string,
  header: string | null | undefined,
  key: string,
  now: number = Date.now(),
): boolean {
  const match = /^v=(\d+),d=([0-9a-f]+)$/i.exec(header?.trim() ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_SKEW_MS) return false;

  const expected = createHmac("sha256", key).update(rawBody + match[1]).digest();
  const given = Buffer.from(match[2]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
