import { NextResponse } from "next/server";

import { verifyUnsubscribeTarget, type UnsubscribeTarget } from "@/lib/email";
import { markUnsubscribed } from "@/lib/leads";
import { updateSetupRequest } from "@/lib/setup-requests";
import { site } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The unsubscribe link in every marketing email, and the RFC 8058 one-click
 * endpoint mail clients POST to. A signed token names the lead (or, on the
 * setup-link emails, the setup request), and stopping is permanent.
 *
 *   - GET (a person clicking the footer link, or a link scanner) changes
 *     nothing. It shows one sentence and one button, and the button posts
 *     back here (Annex X1.10: "The link in the body opens a confirmation page
 *     whose button posts the unsubscribe, so link scanners can't unsubscribe
 *     anyone"). Until 14 October 2026 a GET unsubscribed, so a mailbox whose
 *     security scanner opens every link stopped hearing from us unasked.
 *   - POST stops it. A mail client's one-click POST carries
 *     "List-Unsubscribe=One-Click" and gets a plain 200; the page's own button
 *     gets the page back, saying it is done.
 *
 * It is not an "are you sure?" step: the page asks nothing and offers nothing
 * else, the button is the whole page, and the mail client's own unsubscribe
 * button still stops the emails in one click with no page at all.
 */

const INVALID = "That link is not valid. Email us and we will remove you by hand.";

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get("t");
  if (!verifyUnsubscribeTarget(token)) return page(INVALID, 400);
  return page("Stop these emails?", 200, token);
}

export async function POST(request: Request): Promise<NextResponse> {
  const target = verifyUnsubscribeTarget(new URL(request.url).searchParams.get("t"));
  const body = (await request.text().catch(() => "")).slice(0, 200);
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body);
  if (!target) {
    return oneClick ? NextResponse.json({ ok: false }, { status: 400 }) : page(INVALID, 400);
  }
  await stop(target);
  if (oneClick) return NextResponse.json({ ok: true });
  return page("Done. You will not get another marketing email from us.", 200);
}

/**
 * A setup-link email (P4, P5, P7) is about one request, not one lead:
 * stopping it stops that request's emails. Anything else stops the lead's.
 */
async function stop(target: UnsubscribeTarget): Promise<void> {
  if (target.kind === "setup") await updateSetupRequest(target.id, { unsubscribedAt: new Date() });
  else await markUnsubscribed(target.id, "link");
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page: a sentence, and with a token the one button that posts it. */
function page(message: string, status: number, token?: string | null): NextResponse {
  const form = token
    ? `<form method="post" action="/api/email/unsubscribe?t=${escape(encodeURIComponent(token))}">` +
      `<button type="submit" style="font:inherit;font-weight:600;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#111;color:#fff;cursor:pointer">Stop these emails</button>` +
      `</form>`
    : "";
  const body =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Unsubscribe</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
    `<h1 style="font-size:1.4rem">${escape(message)}</h1>${form}` +
    `<p>Questions: <a href="mailto:${site.email}">${site.email}</a></p></body>`;
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
