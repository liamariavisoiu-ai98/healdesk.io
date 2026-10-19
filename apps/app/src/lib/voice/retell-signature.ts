import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Retell's `X-Retell-Signature` on a webhook to the engine
 * (app/api/webhooks/retell/[clinicId]).
 *
 * The same scheme apps/web's demo routes check (apps/web/src/lib/retell-signature.ts),
 * copied rather than shared because the two apps share no code on purpose:
 * the header is `v={unix ms},d={hex}`, the digest HMAC-SHA256(rawBody +
 * timestamp) keyed with the Retell API key that carries the webhook badge,
 * transcribed from https://docs.retellai.com/features/secure-webhook.md
 * ("Verify Without SDK"). Here the key is HEALDESK_RETELL_API_KEY, the
 * engine's own Retell key, never the demo line's.
 *
 * It must be given the raw body exactly as received. Signatures more than
 * five minutes from now are refused, so a captured delivery cannot be
 * replayed later; within the five minutes a replay only asks the backstop
 * again for a call it is already deciding once.
 */

const MAX_SKEW_MS = 5 * 60_000;

export function verifyRetellSignature(
  rawBody: string,
  header: string | null | undefined,
  key: string,
  now: number = Date.now(),
): boolean {
  const match = /^v=(\d{1,16}),d=([0-9a-f]{64})$/i.exec(header?.trim() ?? "");
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_SKEW_MS) return false;

  const expected = createHmac("sha256", key).update(rawBody + match[1]).digest();
  const given = Buffer.from(match[2]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
