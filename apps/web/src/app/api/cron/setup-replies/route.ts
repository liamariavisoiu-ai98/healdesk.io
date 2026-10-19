import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { relaySetupRepliesPastDue } from "@/lib/admin/ops-client";
import { emailKey, sendSafely } from "@/lib/email";
import { setupRequestsPastReply } from "@/lib/setup-requests";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/setup-replies — setup requests past the day we promised to
 * reply by (WP5; Annex X5's `setup_request_reply_past_due`).
 *
 * P2 tells a requester "We'll reply to {email} by {day}", the next business
 * day in New York. The request lives in the marketing Sheet, on this side,
 * because it is business contact data and a buyer can make one while the AWS
 * host is in standby; so the check runs here, daily (vercel.json, 13:07 UTC,
 * the start of New York's working morning). A request still `new` (no setup
 * link minted, not declined) after the whole of its day has passed is owed.
 *
 * Its ids are handed to apps/app's ops API (setupRepliesPastDue), which
 * raises one ops alert per request, once, in the one ops log every other
 * alert goes through. If the host does not answer, which before the first
 * paid clinic is the usual case, the alert goes from here instead: one email
 * a day to the administrator naming the ids, from this app's own sender,
 * like the host wake (lib/host/wake.ts). Only the Sheet's random request ids
 * appear in either; never a name, an address or a clinic.
 *
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`, compared in
 * constant time, as the other crons are.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
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

  const now = new Date();
  const due = (await setupRequestsPastReply(now)).map((r) => r.id).slice(0, 50);
  if (due.length === 0) return NextResponse.json({ ok: true, due: 0 });

  const relayed = await relaySetupRepliesPastDue(due);
  if (relayed.ok) {
    console.info("[healdesk] setup replies past due", {
      due: due.length,
      raised: relayed.data.raised,
    });
    return NextResponse.json({ ok: true, due: due.length, raised: relayed.data.raised });
  }

  // apps/app did not take it (in standby, unconfigured, failing): say it from here.
  // The administrator, as the host wake writes to them: HEALDESK_OPS_EMAIL is apps/app's.
  const to = process.env.HEALDESK_ADMIN_EMAIL?.trim();
  if (!to) {
    console.error("[healdesk] setup replies past due, and nobody to tell", {
      due: due.length,
      code: relayed.code,
    });
    return NextResponse.json({ ok: false, due: due.length, alerted: false }, { status: 500 });
  }
  const day = now.toISOString().slice(0, 10);
  const sent = await sendSafely({
    to,
    subject: `${due.length} setup request${due.length === 1 ? " is" : "s are"} past the reply day we gave`,
    text: [
      "These setup requests are still unanswered after the day we told each requester we would reply by.",
      "Reply to each today: mint its setup link from the console, or decline it there.",
      "",
      ...due.map((id) => `- Setup request ${id}`),
      "",
      `Look each one up at ${site.url}/admin/setup.`,
      "This came from the marketing site because apps/app did not answer; once it does, these alerts go through the ops log as usual.",
    ].join("\n"),
    tag: "setup-replies-past-due",
    idempotencyKey: emailKey("setup-replies-past-due", day),
  });
  console.warn("[healdesk] setup replies past due, told from apps/web", {
    due: due.length,
    code: relayed.code,
    sent: sent.status,
  });
  return NextResponse.json({
    ok: sent.status !== "failed",
    due: due.length,
    alerted: sent.status !== "failed",
  });
}
