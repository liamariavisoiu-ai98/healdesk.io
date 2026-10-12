import { headers } from "next/headers";

import type { RequestContext } from "@/lib/audit";
import { clientIp } from "@/lib/client-ip";

/**
 * Who is at the other end of an anonymous connect request, as far as we can
 * honestly tell.
 *
 * Shared by the page and the server action rather than duplicated, because the
 * two are the same visitor doing two halves of one thing and an audit trail
 * where the open and the submission disagree about the address is worse than
 * one that records neither.
 *
 * It lives beside the route rather than in `lib/connections/` on purpose:
 * `next/headers` only answers inside a request, and links.ts is exercised
 * directly by tests/connect-links.test.ts with no request anywhere. Pulling
 * Next's request store into that module would trade a testable library for one
 * that can only run inside a route.
 *
 * ⚠️ Both values are a trace, never an identity — the token is the only thing
 * that authenticates here. The address is the one our load balancer saw
 * (lib/client-ip.ts), not the first forwarded-for entry, which the client
 * writes; the user agent is whatever the client sent. `normaliseIp()` in
 * links.ts still stands between the address and the `inet` column.
 */
export async function connectRequestContext(): Promise<RequestContext> {
  const incoming = await headers();

  return {
    ipAddress: clientIp(incoming),
    userAgent: incoming.get("user-agent") ?? undefined,
  };
}
