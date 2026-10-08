import {
  clearStateCookieHeader,
  completeGoogleSignIn,
  readStateCookie,
} from "@/lib/connections/google-oauth";
import { describeError, log } from "@/lib/log";
import { publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/google/callback?code=…&state=… (or ?error=…&state=…):
 * Google's return from the calendar sign-in (plan §4.5).
 *
 * lib/connections/google-oauth.ts does the work: it consumes the state
 * before anything else, holds it to the browser that started it (the
 * `hd_gcal` cookie), and keeps nothing until every check has passed.
 *
 * Every outcome is a redirect, never JSON, because a person's browser is
 * what arrives here: to the calendar link's page with `?outcome=`, to the
 * portal page the sign-in started from with `?calendar=`, or to the neutral
 * done page. Every response clears the cookie, and carries
 * `Referrer-Policy: no-referrer`, because this URL holds the code and the
 * state, spent as both are.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let path: string;
  try {
    const result = await completeGoogleSignIn({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      cookie: readStateCookie(request.headers.get("cookie")),
      request: {
        ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
    });
    path = result.redirectPath;
  } catch (error) {
    log.error("calendar sign-in callback failed", { error: describeError(error) });
    path = "/calendar/done?outcome=failed";
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: publicUrl(path),
      "Set-Cookie": clearStateCookieHeader(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
