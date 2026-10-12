import { headers } from "next/headers";

import { clientIp } from "@/lib/client-ip";
import type { RequestMeta } from "@/lib/factors/totp";

/**
 * The address and browser behind a portal request, for the security events
 * a factor change writes. Recorded as a trace and never trusted as identity:
 * the session and the passkey are what authenticate here. The address is the
 * one our load balancer saw (lib/client-ip.ts); the user agent is whatever
 * the browser sent.
 */
export async function requestMeta(): Promise<RequestMeta> {
  const incoming = await headers();
  return {
    ipAddress: clientIp(incoming) ?? null,
    userAgent: incoming.get("user-agent")?.slice(0, 512) ?? null,
  };
}
