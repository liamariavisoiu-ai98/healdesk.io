import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { purgeStaleCallConsents, purgeStaleLeads } from "@/lib/leads";
import { POLICY } from "@/lib/legal";

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
 * for POLICY.leadRetentionMonths. The count is logged; the addresses never are.
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
  console.info("[healdesk] lead retention purge", {
    deleted,
    consentsDeleted,
    olderThanMonths: POLICY.leadRetentionMonths,
    consentsOlderThanYears: POLICY.callConsentRetentionYears,
  });
  return NextResponse.json({ ok: true, deleted, consentsDeleted });
}
