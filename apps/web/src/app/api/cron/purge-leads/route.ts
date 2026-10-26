import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { purgeStaleDemoCallbacks } from "@/lib/demo/callbacks";
import { DEMO_RETENTION_AFTER_EXPIRY_DAYS, purgeExpiredDemoSessions } from "@/lib/demo/sessions";
import { purgeStaleCallConsents, purgeStaleLeads } from "@/lib/leads";
import { POLICY } from "@/lib/legal";
import { purgeStaleSetupRequests } from "@/lib/setup-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/purge-leads — the retention clock for demo leads.
 *
 * Vercel Cron calls this daily (apps/web/vercel.json) with
 * `Authorization: Bearer $CRON_SECRET`, which Vercel sets on the project and
 * sends on every cron invocation. Anything else gets 401. The comparison is
 * constant-time because the secret is the only thing standing between the
 * public internet and a delete.
 *
 * What it deletes is exactly what the privacy policy says: leads not seen
 * for POLICY.leadRetentionMonths, and setup requests not updated for as long.
 * The count is logged; the addresses never are.
 *
 * It also deletes personalised demos (lib/demo) that expired more than
 * DEMO_RETENTION_AFTER_EXPIRY_DAYS ago and never sold. Each holds an owner's
 * work email and phone beside their clinic's public website, and once the
 * link is dead there is no reason to keep them.
 *
 * And call backs asked for on a demo call (lib/demo/callbacks.ts) that nobody
 * marked called within POLICY.demoCallbackRetentionDays: the Privacy page
 * keeps the number until the team has called or that long, whichever first.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No secret configured means the route must not be callable at all.
    return NextResponse.json({ error: "Cron is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const deleted = await purgeStaleLeads(POLICY.leadRetentionMonths);
  const consentsDeleted = await purgeStaleCallConsents(POLICY.callConsentRetentionYears);
  const setupRequestsDeleted = await purgeStaleSetupRequests(POLICY.leadRetentionMonths);
  const demosDeleted = await purgeExpiredDemoSessions(DEMO_RETENTION_AFTER_EXPIRY_DAYS);
  const callbacksDeleted = await purgeStaleDemoCallbacks(POLICY.demoCallbackRetentionDays);
  console.info("[healdesk] lead retention purge", {
    deleted,
    consentsDeleted,
    setupRequestsDeleted,
    demosDeleted,
    callbacksDeleted,
    olderThanMonths: POLICY.leadRetentionMonths,
    consentsOlderThanYears: POLICY.callConsentRetentionYears,
  });
  return NextResponse.json({ ok: true, deleted, consentsDeleted, setupRequestsDeleted, demosDeleted, callbacksDeleted });
}
