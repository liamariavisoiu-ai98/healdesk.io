import { completeConnect, connectReturnUrl, CONNECT_DONE_PATH } from "@/lib/billing/connect";
import { describeError, log } from "@/lib/log";
import { publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connect/stripe?code=…&state=… (or ?error=access_denied&state=…):
 * Stripe's OAuth return for Connect (BD28, R23).
 *
 * The state is the only thing that says which clinic, and it is a
 * single-use row: lib/billing/connect.ts consumes it before anything else,
 * the code exchange included, holds a portal state to the browser that
 * started it, and never lets a different account replace the clinic's.
 *
 * Every outcome is a redirect, never JSON, because a person's browser is
 * what arrives here: to the portal's Settings or setup wizard with
 * `connect=ok|declined|failed`, or to the neutral done page for an
 * operator's link and for any state we do not recognise. Never `/admin`,
 * which is our console and must never be shown to a clinic. The address is
 * built from the clinic's own slug, never from the request.
 *
 * The redirect carries `Referrer-Policy: no-referrer`: this URL holds the
 * code and the state, spent as both are, and the page it sends the browser
 * to has no business seeing them.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let target: string;
  try {
    const result = await completeConnect({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
    });
    target = connectReturnUrl(result);
  } catch (error) {
    log.error("stripe connect callback failed", { error: describeError(error) });
    target = neutralFailure();
  }
  return new Response(null, {
    status: 303,
    headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function neutralFailure(): string {
  const path = `${CONNECT_DONE_PATH}?result=failed`;
  try {
    return publicUrl(path);
  } catch {
    return path;
  }
}
