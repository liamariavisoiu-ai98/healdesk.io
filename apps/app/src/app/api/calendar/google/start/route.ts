import { clientIp } from "@/lib/client-ip";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import {
  beginGoogleSignIn,
  beginPortalSignIn,
  connectOutcomeOf,
  GoogleConnectError,
  stateCookieHeader,
} from "@/lib/connections/google-oauth";
import { resolveConnectionLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import { currentUserId, requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { publicOrigin, publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A clinic slug as the portal's return paths take one (PORTAL_RETURN in google-oauth.ts). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * POST /api/calendar/google/start — "Sign in with Google" (plan §4.3),
 * form-encoded, from one of two places. Both tick the data-use notice on
 * the page that posts here: `disclosure=accepted` and `disclosureVersion`.
 *
 *   - A calendar link's page: `token`. The token is the whole of the
 *     authentication, as on every link page: it is re-resolved here, never
 *     trusted from the page that rendered the form, and it is counted
 *     against the token and the address before anything is read.
 *   - The portal (C18): `clinic`, the slug, and `from`, `setup` or
 *     `settings`, the page the sign-in starts from and Google's answer comes
 *     back to. The clinic's sign-in is the authentication, through
 *     requirePortal(slug): a session without a grant on this clinic gets its
 *     404, and nobody else can start a connect for the clinic. The state row
 *     names the user, and the callback goes on only in that user's session
 *     (lib/connections/google-oauth.ts). Starting asks for no passkey
 *     step-up: a first connect and a reconnect of the same account need
 *     none. Replacing the connected account with another does (Settings →
 *     Calendar, "step-up to change", in the portal plan the owner approved
 *     on 6 October), and only the callback knows which account came back,
 *     so it asks there: without a live step-up on the session that returns,
 *     another account ends `different_account`.
 *
 * The request must come from one of our own pages (fromOwnPage).
 * Nobody is sent to Google unless the grant could be kept: an unconfigured
 * client, a deployment that cannot seal (credentialSealingProblem) or no
 * public origin answers 503 on a link, and `?calendar=unavailable` in the
 * portal, before any state exists. Otherwise the answer is a 303 to
 * Google's consent screen, with the browser-binding cookie set on the
 * callback's path, or a 303 back to the page it came from saying why not:
 * `?outcome=` on the link page, `?calendar=` in the portal.
 */
export async function POST(request: Request): Promise<Response> {
  if (!fromOwnPage(request.headers)) {
    return new Response("Forbidden.", { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const ipAddress = clientIp(request.headers);
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const context = { ipAddress, userAgent };

  if (form.has("clinic")) return startFromPortal(form, context);

  const token = String(form.get("token") ?? "");
  if (!withinConnectAttemptLimit("submit", token, ipAddress ?? null)) {
    return new Response("Too many attempts. Wait a few minutes and try again.", { status: 429 });
  }

  const link = await resolveConnectionLink(token, context, "calendar");
  if (!link) return seeOther(pagePath(token, null));

  try {
    const { authUrl, cookieValue } = await beginGoogleSignIn({
      clinicId: link.clinicId,
      via: { kind: "calendar_link", linkId: link.linkId, token },
      disclosureVersion: ticked(form),
      actor: { type: "service", serviceName: "calendar-link" },
      request: context,
    });
    return toGoogle(authUrl, cookieValue);
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

/**
 * The portal's form: Settings → Calendar or setup step 3, posting the
 * clinic's slug and the page it is on. What the server action's
 * startGoogleConnect does, behind the same checks (beginPortalSignIn), with
 * the cookie set on this response.
 */
async function startFromPortal(
  form: FormData,
  context: { ipAddress?: string; userAgent?: string },
): Promise<Response> {
  const slug = String(form.get("clinic") ?? "");
  const from = form.get("from");
  // A form naming both a clinic and a link is neither door's.
  if (form.has("token") || !SLUG.test(slug) || (from !== "setup" && from !== "settings")) {
    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const page = `/c/${slug}/${from}`;

  // requirePortal answers a missing session with Next's redirect, which a
  // route handler sends as a 307, and a 307 would have the browser POST this
  // form to the sign-in page. So that one case is answered here, as a 303,
  // the same for every slug: it says nothing about whether the clinic
  // exists. Signed in without a grant on this clinic, requirePortal's 404
  // stands; it is thrown as Next's own signal, so neither call is made
  // inside a try/catch.
  if (!(await currentUserId())) return seeOther(`/sign-in?next=${encodeURIComponent(page)}`);
  const portal = await requirePortal(slug);
  const back = `/c/${portal.clinicSlug}/${from}`;
  const { label } = await portalActor(portal);

  try {
    const { authUrl, cookieValue } = await beginPortalSignIn({
      clinicId: portal.clinicId,
      returnTo: back,
      disclosureVersion: ticked(form),
      user: { userId: portal.userId, label },
      request: context,
    });
    return toGoogle(authUrl, cookieValue);
  } catch (error) {
    if (error instanceof GoogleConnectError) {
      log.info("calendar sign-in refused at the start", {
        clinicId: portal.clinicId,
        code: error.code,
      });
      return seeOther(`${back}?calendar=${connectOutcomeOf(error.code)}`);
    }
    log.error("calendar sign-in could not start", {
      clinicId: portal.clinicId,
      error: describeError(error),
    });
    return seeOther(`${back}?calendar=failed`);
  }
}

/** The notice's version, when its box was ticked; the server checks it is the current one. */
function ticked(form: FormData): string | null {
  return form.get("disclosure") === "accepted" ? String(form.get("disclosureVersion") ?? "") : null;
}

/**
 * Whether the form was posted from one of this app's own pages. Every page
 * here is served with `Referrer-Policy: no-referrer` (next.config.ts), and
 * under that policy the Fetch standard has a browser send `Origin: null` on
 * a form's POST, so our own forms cannot be told by their Origin alone. A
 * real Origin must be the public origin. A null or absent one passes only
 * with `Sec-Fetch-Site: same-origin`, which the browser sets from where the
 * request really came from and no page script can set (a forbidden header);
 * a cross-site or same-site post, or a null Origin with no fetch metadata at
 * all, is refused. The portal's form also needs the session cookie, which
 * SameSite=Lax keeps off a cross-site POST.
 */
function fromOwnPage(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (origin !== null && origin !== "null") {
    try {
      return new URL(origin).origin === new URL(publicOrigin()).origin;
    } catch {
      return false;
    }
  }
  return headers.get("sec-fetch-site") === "same-origin";
}

/** The link page for this token, or the neutral done page for anything that is not one. */
function pagePath(token: string, outcome: string | null): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return "/calendar/done?outcome=expired";
  return outcome ? `/calendar/${token}?outcome=${outcome}` : `/calendar/${token}`;
}

/** Off to Google's consent screen, with the cookie that binds the round trip to this browser. */
function toGoogle(authUrl: string, cookieValue: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: authUrl,
      "Set-Cookie": stateCookieHeader(cookieValue),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
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
