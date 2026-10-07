import { headers } from "next/headers";

import type { RequestMeta } from "@/lib/factors/totp";

/**
 * The address and browser behind a portal request, for the security events
 * a factor change writes. Both are client-influenced text, recorded as a
 * trace and never trusted as identity: the session and the passkey are what
 * authenticate here.
 */
export async function requestMeta(): Promise<RequestMeta> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: (forwarded || incoming.get("x-real-ip") || null)?.slice(0, 64) ?? null,
    userAgent: incoming.get("user-agent")?.slice(0, 512) ?? null,
  };
}
