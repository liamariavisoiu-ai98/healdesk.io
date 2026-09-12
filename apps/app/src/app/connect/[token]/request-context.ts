import { headers } from "next/headers";

import type { RequestContext } from "@/lib/audit";

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
 * ⚠️ Both values are attacker-influenced text, and the first hop of a
 * forwarded-for chain is whatever the client typed. They are recorded as a
 * trace, never trusted as an identity — the token is the only thing that
 * authenticates here. `normaliseIp()` in links.ts is what stops a strange
 * header reaching the `inet` column and refusing a clinic's credential.
 */
export async function connectRequestContext(): Promise<RequestContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();

  return {
    ipAddress: forwarded || incoming.get("x-real-ip") || undefined,
    userAgent: incoming.get("user-agent") ?? undefined,
  };
}
