import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { unsafeDb } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — the load balancer's question.
 *
 * Two answers, deliberately separated:
 *
 *   * The HTTP status is LIVENESS: 200 means this process is up and can
 *     serve a request. A database outage does not turn it into 503, because
 *     the host's reaction to 503 is to replace the task, and a new task
 *     cannot reach the database either — that turns one outage into a
 *     restart loop with no capacity left to serve the "we are down" page.
 *   * The body carries READINESS: `db` is "ok" when a one-row query answered
 *     inside two seconds, otherwise "unreachable". Alarm on that string; do
 *     not route on it.
 *
 * Nothing here reads a tenant table, sets a tenant, or returns anything a
 * caller could not learn from the fact that the port is open. It is
 * unauthenticated by design and rate-limited by the host, not by us.
 */
export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  let db: "ok" | "unreachable" = "unreachable";
  try {
    await Promise.race([
      unsafeDb.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ]);
    db = "ok";
  } catch {
    db = "unreachable";
  }
  return NextResponse.json(
    { ok: true, db, latencyMs: Date.now() - startedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
