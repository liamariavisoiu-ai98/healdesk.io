import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { runNurture } from "@/lib/email/run-nurture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/nurture — the follow-up clock.
 *
 * Same authentication as /api/cron/purge-leads: Vercel Cron's Bearer
 * CRON_SECRET, compared in constant time. Daily in vercel.json, because the
 * Hobby plan refuses to deploy a project with a more frequent cron: the hourly
 * schedule this had failed every deploy from 22 September to 3 October 2026.
 * Daily only delays the touches — the sequence is keyed on elapsed time since
 * consent, so nothing is sent twice and nothing is skipped.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "Cron is not configured." }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const run = await runNurture();
  console.info("[healdesk] nurture run", run);
  return NextResponse.json({ ok: true, ...run });
}
