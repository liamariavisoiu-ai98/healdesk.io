import { sql } from "drizzle-orm";
import { after, NextResponse } from "next/server";

import { unsafeDb } from "@/db";
import { alertLateCriticalNotices, lateCriticalNotices } from "@/lib/email/outbox";
import { heartbeatAgeSeconds } from "@/lib/scheduler/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — the uptime check's question, and the on-call's.
 * GET /api/health?probe=liveness — the load balancer's.
 *
 * Two answers, deliberately separated:
 *
 *   * LIVENESS is the load balancer's: 200 means this process is up and can
 *     serve a request, and nothing else turns it red. A database outage does
 *     not, because the host's reaction to a failed probe is to replace the
 *     task, and a new task cannot reach the database either — that turns one
 *     outage into a restart loop with no capacity left to serve the "we are
 *     down" page. A mail outage must not either: replacing the web tier would
 *     take the patient-facing endpoints down to fix an email. Point the load
 *     balancer at `?probe=liveness`, which answers 200 without touching
 *     anything.
 *   * The plain GET is the uptime check's, and carries READINESS and the
 *     worker's vital signs in its body: `db`, the worker heartbeat age, the
 *     queue's oldest pending job and failed count, and the email platform's
 *     critical notices. One condition turns its status red, a 503 with the
 *     reason in `reasons`: a CRITICAL email notice (lib/email/kinds.ts)
 *     still unsent ten minutes after it was due (Annex X3). That is the
 *     alarm a mail outage cannot silence by being a mail outage, because the
 *     uptime check lives outside the thing it watches; notifyOps is told too,
 *     once per notice, after the response. Everything else in the body is an
 *     alarm to watch, not a status to route on (docs/on-call.md).
 *
 * Nothing here reads a tenant table directly, sets a tenant, or returns
 * anything a caller could not learn from the fact that the port is open: the
 * critical-notice count comes through app_pending_notices, as counts and
 * kinds, never a clinic or a payload. It is unauthenticated by design and
 * rate-limited by the host, not by us.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (new URL(request.url).searchParams.get("probe") === "liveness") {
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const startedAt = Date.now();
  let db: "ok" | "unreachable" = "unreachable";
  let heartbeat: number | null = null;
  let queue: { oldestPendingSeconds: number | null; failed: number } | null = null;
  let email: { lateCriticalNotices: number } | null = null;
  const reasons: string[] = [];
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
    // The email platform. Unreadable (a database without 0045 yet) reads as
    // null, like the queue above, rather than as a red the deploy caused.
    try {
      const late = await lateCriticalNotices();
      email = { lateCriticalNotices: late.length };
      if (late.length > 0) {
        reasons.push("critical_notice_undelivered");
        // After the response: the uptime check gets its answer at once, and
        // notifyOps (an email of its own) is raised once per notice however
        // often the check polls. Outside a request scope after() throws; the
        // alert then goes as a plain promise, which never rejects.
        try {
          after(() => alertLateCriticalNotices(late));
        } catch {
          void alertLateCriticalNotices(late);
        }
      }
    } catch {
      email = null;
    }
  } catch {
    db = "unreachable";
  }
  const red = reasons.length > 0;
  return NextResponse.json(
    {
      ok: !red,
      ...(red ? { reasons } : {}),
      db,
      heartbeatAgeSeconds: heartbeat,
      queue,
      email,
      latencyMs: Date.now() - startedAt,
    },
    { status: red ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
