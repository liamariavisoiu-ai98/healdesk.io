import { timingSafeEqual } from "node:crypto";

import { after, NextResponse } from "next/server";

import { runRetriedBuilds, sweepStalledDemos } from "@/lib/demo/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The retried builds run after the response (`after()`); this bounds them, as the console page does. */
export const maxDuration = 300;

/**
 * GET /api/cron/demo-sweep — stalled demo builds, started again once, then
 * handed to a person (lib/demo/sweep.ts).
 *
 * Same authentication as the other crons: Vercel Cron's Bearer CRON_SECRET,
 * compared in constant time. Daily in vercel.json, 12:37 UTC, before the
 * New York working morning, because the Hobby plan refuses to deploy a
 * project with a more frequent cron (the hourly nurture schedule failed every
 * deploy from 22 September to 3 October 2026, d306a264). The route itself
 * has no notion of its schedule: on a plan that allows it, `7 * * * *` in
 * vercel.json is the only change. Until then a stalled build waits at most
 * a day for its retry, and "Retry all stalled" on /admin/demos is the same
 * sweep by hand, now.
 *
 * The builds it starts again run after the response, inside maxDuration,
 * the way the webhook's and the console's do. The Sheet unreachable is a
 * thrown error and a 500, so the cron shows red rather than a quiet day.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "Cron is not configured." }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== expected.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const sweep = await sweepStalledDemos();
  const retried = sweep.retried.map((s) => s.slug);
  if (retried.length > 0) after(() => runRetriedBuilds(retried));
  // Slugs, as every build log line names them; never an address.
  console.info("[healdesk] demo stall sweep", { retried, gaveUp: sweep.gaveUp.map((s) => s.slug) });
  return NextResponse.json({ ok: true, retried: retried.length, gaveUp: sweep.gaveUp.length });
}
