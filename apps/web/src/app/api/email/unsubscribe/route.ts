import { NextResponse } from "next/server";

import { verifyUnsubscribeToken } from "@/lib/email";
import { markUnsubscribed } from "@/lib/leads";
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
  const leadId = verifyUnsubscribeToken(url.searchParams.get("t"));
  if (!leadId) {
    return html("That link is not valid. Email us and we will remove you by hand.", 400);
  }
  await markUnsubscribed(leadId, "link");
  if (request.method === "POST") return NextResponse.json({ ok: true });
  return html("Done. You will not get another marketing email from us.", 200);
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
