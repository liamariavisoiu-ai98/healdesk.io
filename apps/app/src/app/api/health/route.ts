import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { unsafeDb } from "@/db";
import { heartbeatAgeSeconds } from "@/lib/scheduler/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — the load balancer's question, and the on-call's.
 *
 * Two answers, deliberately separated:
 *
 *   * The HTTP status is LIVENESS: 200 means this process is up and can
 *     serve a request. A database outage does not turn it into 503, because
 *     the host's reaction to 503 is to replace the task, and a new task
 *     cannot reach the database either — that turns one outage into a
 *     restart loop with no capacity left to serve the "we are down" page.
 *   * The body carries READINESS and the worker's vital signs: `db`, the
 *     worker heartbeat age, and the queue's oldest pending job and failed
 *     count. Alarm on those; do not route on them (docs/on-call.md).
 *
 * Nothing here reads a tenant table, sets a tenant, or returns anything a
 * caller could not learn from the fact that the port is open. It is
 * unauthenticated by design and rate-limited by the host, not by us.
 */
export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();
  let db: "ok" | "unreachable" = "unreachable";
  let heartbeat: number | null = null;
  let queue: { oldestPendingSeconds: number | null; failed: number } | null = null;
  try {
    await Promise.race([
      unsafeDb.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000)),
    ]);
    db = "ok";
    heartbeat = await heartbeatAgeSeconds();
    // pg-boss's own table. Absent (queue never installed) reads as null, not
    // as an error: the web server can be healthy on a database where the
    // worker has not been set up yet.
    try {
      const result = await unsafeDb.execute<{ oldest: number | null; failed: number }>(sql`
        select extract(epoch from now() - min(created_on))::int as oldest,
               count(*) filter (where state = 'failed')::int as failed
          from pgboss.job
         where state in ('created', 'retry', 'failed')
      `);
      const row = (result as unknown as { rows?: { oldest: number | null; failed: number }[] }).rows?.[0];
      queue = { oldestPendingSeconds: row?.oldest ?? null, failed: Number(row?.failed ?? 0) };
    } catch {
      queue = null;
    }
  } catch {
    db = "unreachable";
  }
  return NextResponse.json(
    { ok: true, db, heartbeatAgeSeconds: heartbeat, queue, latencyMs: Date.now() - startedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
