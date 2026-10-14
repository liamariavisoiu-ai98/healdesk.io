import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { cookies } from "next/headers";

import { welcomeOutcome, type WelcomeOutcome } from "@/lib/checkout/welcome";
import { site } from "@/lib/site";

/**
 * GET /welcome?h=<ref>&cs=<Checkout Session id>: where Stripe sends the
 * browser that has just paid, since 14 October 2026
 * (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * The purchase is recorded on this site now, so a buyer can pay while the AWS
 * host is in standby, and this page is what they land on, whatever state the
 * host is in (lib/checkout/welcome.ts decides which answer):
 *
 *   - ready: 303 to apps/app's own /welcome, at the URL apps/app composed
 *     from its public origin, which signs this browser in with its one-time
 *     link (the nonce cookie, Path=/welcome on the parent domain, reaches both
 *     hosts, lib/checkout/app-client.ts);
 *   - waiting: a plain page. Payment received, the account is being set up,
 *     the sign-in link will be emailed to the address used at checkout (shown
 *     masked, to the paying browser only). It looks again every 15 seconds
 *     for 10 minutes, then says plainly that the link will come by email,
 *     which it will: apps/app sends the welcome email once it has made the
 *     account, whenever that is;
 *   - unknown: Stripe does not say this Session is this purchase's and paid.
 *     404, and nothing about any purchase.
 *
 * A route handler rather than a page, for one reason: a page's redirect() is
 * a 307, and the hand-off is a 303 (see other, by GET), which only a handler
 * can answer. The page it returns is small, self-contained HTML with no
 * script; the site's stylesheet is not needed to say four sentences.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the waiting page looks again, and for how long. */
const WELCOME_REFRESH_SECONDS = 15;
const WELCOME_WAIT_SECONDS = 10 * 60;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ref = url.searchParams.get("h");
  const sessionId = url.searchParams.get("cs");
  // When this browser first arrived, carried in the refresh URL; only ever
  // decides how long the page keeps looking, so it is not signed.
  const now = Math.floor(Date.now() / 1000);
  const firstSeen = Number(url.searchParams.get("t"));
  const since = Number.isInteger(firstSeen) && firstSeen > now - 86_400 && firstSeen <= now ? firstSeen : now;

  let outcome: WelcomeOutcome;
  try {
    outcome = await welcomeOutcome({
      ref,
      sessionId,
      nonce: (await cookies()).get(WELCOME_NONCE_COOKIE)?.value ?? null,
    });
  } catch (error) {
    console.error("[healdesk] welcome: could not decide what to show", {
      error: error instanceof Error ? error.name : "unknown error",
    });
    outcome = { kind: "waiting", email: null, confirmed: false };
  }

  if (outcome.kind === "ready") {
    return new Response(null, {
      status: 303,
      headers: { Location: outcome.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }

  if (outcome.kind === "unknown") {
    return page(404, {
      title: "We couldn't find this payment",
      lines: [
        "If you've just paid, your sign-in link will be emailed to the address you used at checkout.",
        `Questions? Email ${site.email} and a person will answer.`,
      ],
    });
  }

  const stillLooking = now - since < WELCOME_WAIT_SECONDS;
  const to = outcome.email ?? "the address you used at checkout";
  const refreshUrl = `/welcome?h=${encodeURIComponent(ref ?? "")}&cs=${encodeURIComponent(sessionId ?? "")}&t=${since}`;
  if (!outcome.confirmed) {
    return page(200, {
      title: "Thank you. We're confirming your payment.",
      lines: [
        `If it went through, your account is being set up and your sign-in link will be emailed to ${to}.`,
        stillLooking ? "This page checks again by itself." : `Questions? Email ${site.email} and a person will answer.`,
      ],
      refresh: stillLooking ? refreshUrl : null,
    });
  }
  return page(200, {
    title: "Payment received. Your account is being set up.",
    lines: stillLooking
      ? [
          `We'll email your sign-in link to ${to}.`,
          "This page checks again by itself every few seconds, and takes you on when your account is ready. You can also close it: the email will reach you.",
        ]
      : [
          `Setting up your account is taking longer than usual. Your sign-in link will be emailed to ${to} as soon as it is ready.`,
          `Questions? Email ${site.email} and a person will answer.`,
        ],
    refresh: stillLooking ? refreshUrl : null,
  });
}

function page(status: number, content: { title: string; lines: string[]; refresh?: string | null }): Response {
  const refresh = content.refresh
    ? `<meta http-equiv="refresh" content="${WELCOME_REFRESH_SECONDS};url=${escapeHtml(content.refresh)}">`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
${refresh}
<title>Welcome to healdesk</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #fdfdfd; color: #172a3a; font: 17px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 32rem; margin: 0 auto; padding: 18vh 24px 48px; }
  .mark { font-weight: 800; font-size: 20px; letter-spacing: -0.01em; margin: 0 0 40px; }
  .heal { color: #da191a; } .desk { color: #e05800; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 16px; }
  p { margin: 0 0 12px; }
</style>
</head>
<body>
<main>
<p class="mark"><span class="heal">heal</span><span class="desk">desk</span></p>
<h1>${escapeHtml(content.title)}</h1>
${content.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The URL carries the purchase's ref: nothing caches this, nothing refers it on.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
