import { NextResponse } from "next/server";

import { getDemoSessionById } from "@/lib/demo/sessions";
import { verifyUnsubscribeTarget } from "@/lib/email";
import { findLeadByEmail, markUnsubscribed } from "@/lib/leads";
import { updateSetupRequest } from "@/lib/setup-requests";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The unsubscribe link in every marketing email, and the RFC 8058 one-click
 * endpoint mail clients POST to. Both do the same thing: a signed token names
 * the lead, and the lead is marked unsubscribed, permanently, with no
 * confirmation step — a "are you sure?" page is the dark pattern the privacy
 * policy says we do not use.
 */
async function handle(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const target = verifyUnsubscribeTarget(url.searchParams.get("t"));
  if (!target) {
    return html("That link is not valid. Email us and we will remove you by hand.", 400);
  }
  // A setup-link email (P4, P5) is about one request, not one lead: stopping
  // it stops that request's reminder. Still one click, as the privacy policy
  // promises; unsubscribing too easily only ever errs on the reader's side.
  if (target.kind === "setup") await updateSetupRequest(target.id, { unsubscribedAt: new Date() });
  // The demo's "discount just expired" email (lib/demo/offer-ended.ts) is
  // the only one a demo sends after its link, and it has gone by the time its
  // link can be clicked, so the opt-out lands on the address's lead row, if
  // it has one, where every later email is checked.
  else if (target.kind === "demo") await unsubscribeDemoAddress(target.id);
  else await markUnsubscribed(target.id, "link");
  if (request.method === "POST") return NextResponse.json({ ok: true });
  return html("Done. You will not get another marketing email from us.", 200);
}

async function unsubscribeDemoAddress(demoId: string): Promise<void> {
  const demo = await getDemoSessionById(demoId);
  const lead = demo?.leadEmail ? await findLeadByEmail(demo.leadEmail) : null;
  if (lead) await markUnsubscribed(lead.id, "link");
}

export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}

function html(message: string, status: number): NextResponse {
  const body =
    `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
    `<h1 style="font-size:1.4rem">${message}</h1>` +
    `<p>Questions: <a href="mailto:${site.email}">${site.email}</a></p></body>`;
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
