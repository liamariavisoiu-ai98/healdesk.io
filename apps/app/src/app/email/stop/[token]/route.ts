import { stopOptionalEmail } from "@/lib/email/stop";
import { readUnsubscribeToken } from "@/lib/email/unsubscribe";
import { describeError, log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /email/stop/<token>: the one-click way to stop an optional email (Annex
 * X1.9 and X1.10), the address in its footer and in its List-Unsubscribe
 * header.
 *
 *   - GET (a person clicking the footer link, or a link scanner) changes
 *     nothing: it sends the browser to the confirmation page, whose button
 *     posts back here. A scanner that follows every link in an inbox stops
 *     nobody's email.
 *   - POST stops it. A mail client's RFC 8058 one-click POST carries
 *     "List-Unsubscribe=One-Click" and gets a plain 200; the confirmation
 *     page's own form gets sent back to that page, saying it is done.
 *
 * The token names one clinic and one switch and is signed
 * (lib/email/unsubscribe.ts), so it stops that one email for that one clinic
 * and signs nobody in. An unknown token changes nothing and says only that
 * the link isn't one of ours.
 */

function confirmPath(token: string, done = false): string {
  return `/email/stop/${encodeURIComponent(token)}/confirm${done ? "?done=1" : ""}`;
}

function plain(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  return new Response(null, {
    status: 303,
    headers: {
      Location: confirmPath(token),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const read = readUnsubscribeToken(token);
  const body = (await request.text().catch(() => "")).slice(0, 200);
  const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/.test(body);
  if (!read) return plain("This link isn't one of ours, so nothing was changed.", 404);
  try {
    await stopOptionalEmail(read);
  } catch (error) {
    log.error("email stop link failed", { error: describeError(error), kind: read.scope });
    return plain("Something went wrong on our side, so nothing was changed. Try again later.", 500);
  }
  if (oneClick) return plain("Stopped.", 200);
  return new Response(null, {
    status: 303,
    headers: {
      Location: confirmPath(token, true),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
