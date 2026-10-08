import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import {
  beginGoogleSignIn,
  GoogleConnectError,
  stateCookieHeader,
} from "@/lib/connections/google-oauth";
import { resolveConnectionLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import { publicOrigin, publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/calendar/google/start — the calendar link page's "Sign in with
 * Google" (plan §4.3), form-encoded: `token`, `disclosure=accepted` (the
 * tick) and `disclosureVersion`.
 *
 * The token is the whole of the authentication, as on every link page: it
 * is re-resolved here, never trusted from the page that rendered the form.
 * The request must come from our own origin (the form's Origin header), and
 * it is counted against the token and the address before anything is read.
 *
 * Nobody is sent to Google unless the grant could be kept: an unconfigured
 * client, a deployment that cannot seal (credentialSealingProblem) or no
 * public origin answers 503 here, before any state exists. Otherwise the
 * answer is a 303 to Google's consent screen, with the browser-binding
 * cookie set on the callback's path, or a 303 back to the link page with
 * `?outcome=` saying why not.
 */
export async function POST(request: Request): Promise<Response> {
  if (!fromOwnOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden.", { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const token = String(form.get("token") ?? "");
  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const context = { ipAddress, userAgent };

  if (!withinConnectAttemptLimit("submit", token, ipAddress ?? null)) {
    return new Response("Too many attempts. Wait a few minutes and try again.", { status: 429 });
  }

  const link = await resolveConnectionLink(token, context, "calendar");
  if (!link) return seeOther(pagePath(token, null));

  try {
    const { authUrl, cookieValue } = await beginGoogleSignIn({
      clinicId: link.clinicId,
      via: { kind: "calendar_link", linkId: link.linkId, token },
      disclosureVersion:
        form.get("disclosure") === "accepted" ? String(form.get("disclosureVersion") ?? "") : null,
      actor: { type: "service", serviceName: "calendar-link" },
      request: context,
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: authUrl,
        "Set-Cookie": stateCookieHeader(cookieValue),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    if (error instanceof GoogleConnectError) {
      if (error.code === "unavailable") {
        return new Response("Calendar connection isn't available yet.", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
      return seeOther(pagePath(token, error.code === "disclosure" ? "disclosure" : "terms"));
    }
    log.error("calendar sign-in could not start", {
      clinicId: link.clinicId,
      error: describeError(error),
    });
    return seeOther(pagePath(token, "failed"));
  }
}

function fromOwnOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicOrigin()).origin;
  } catch {
    return false;
  }
}

/** The link page for this token, or the neutral done page for anything that is not one. */
function pagePath(token: string, outcome: string | null): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "/calendar/done?outcome=expired";
  return outcome ? `/calendar/${token}?outcome=${outcome}` : `/calendar/${token}`;
}

function seeOther(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: publicUrl(path),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
