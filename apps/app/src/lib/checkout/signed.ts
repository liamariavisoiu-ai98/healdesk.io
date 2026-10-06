import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "@healdesk/catalog";

import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * The body of a request apps/web signed with `HEALDESK_PROVISION_SECRET`, or
 * the response to send instead. Verified before it is parsed, so an
 * unauthenticated caller makes us do no work, and bounded, so a signed but
 * oversized body is refused before it is held in memory twice.
 */
export async function readSignedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const secret = env.provisionSecret();
  if (!secret) {
    log.error("HEALDESK_PROVISION_SECRET is not set");
    return { ok: false, response: problem("Checkout is unavailable.", 503) };
  }
  const raw = await request.text();
  if (raw.length > maxBytes) return { ok: false, response: problem("Request too large.", 413) };
  const verification = verify(
    raw,
    request.headers.get(TIMESTAMP_HEADER),
    request.headers.get(SIGNATURE_HEADER),
    secret,
  );
  if (!verification.ok) {
    log.warn("signed checkout request rejected", { outcome: verification.reason });
    return { ok: false, response: problem("Unauthorized.", 401) };
  }
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: problem("Invalid request body.", 400) };
  }
}

export function problem(message: string, status: number, field?: string): Response {
  return Response.json({ error: message, ...(field ? { field } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}
