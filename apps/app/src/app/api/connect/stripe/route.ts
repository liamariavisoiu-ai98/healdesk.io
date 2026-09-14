import { completeConnect } from "@/lib/billing/connect";
import { describeError, log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/connect/stripe?code=…&state=… — Stripe's OAuth return for Connect.
 *
 * The clinic finished authorising the platform on Stripe's site and lands
 * here. The state is the only thing that says which clinic; it is signed,
 * so a stranger cannot hand us a code for their account against someone
 * else's clinic. On success the operator's onboarding page is where the
 * result shows, so that is where the browser goes.
 */
function consoleUrl(path: string): string {
  const base = (process.env.HEALDESK_WEB_URL ?? "https://healdesk.io").replace(/\/$/, "");
  return `${base}${path}`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Stripe reports a declined authorisation as error=access_denied.
  if (url.searchParams.get("error")) {
    return Response.redirect(consoleUrl("/admin/ops?connect=declined"), 303);
  }
  try {
    const result = await completeConnect({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    });
    switch (result.status) {
      case "connected":
        return Response.redirect(consoleUrl(`/admin/ops/${result.clinicId}/onboarding?connect=ok`), 303);
      case "invalid_state":
        return Response.json({ error: "This link has expired or was not issued by healdesk." }, { status: 400 });
      case "failed":
        log.error("stripe connect exchange failed", { reason: result.reason });
        return Response.redirect(consoleUrl("/admin/ops?connect=failed"), 303);
    }
  } catch (error) {
    log.error("stripe connect callback failed", { error: describeError(error) });
    return Response.json({ error: "Could not complete the connection." }, { status: 500 });
  }
}
