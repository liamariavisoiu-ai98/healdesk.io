import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { issueConnectionLink, resolveConnectionLink } from "@/lib/connections/links";
import { env } from "@/lib/env";
import { fromOwnPage, META_CALLBACK_PATH, metaApp, publicUrl, requestContextFrom, seeOther } from "@/lib/meta/connect-http";
import { loginDialogUrl } from "@/lib/meta/graph";
import { encodeLoginCookie, loginCookieHeader, newNonce } from "@/lib/meta/login-state";
import { portalReturnUrl, surfaceOf } from "@/lib/meta/portal-return";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/meta/login — the "Log in with Facebook" button on /channels/meta/[token].
 *
 * A form post, not a link, so the clinic's token travels in a body rather than
 * a query string. The link is resolved here (which audits the open) but not
 * spent: nothing has been bought yet, and a clinic that cancels Meta's dialog
 * must be able to try again. It is spent by the callback, in the same
 * transaction that stores the channels.
 *
 * The token goes into an HttpOnly cookie and only a random nonce goes to Meta
 * as `state` (lib/meta/login-state.ts).
 *
 * The same button sits in the portal, at setup step 4 (plan Part E), where
 * the form carries the clinic's slug instead of a token: the clinic's own
 * signed-in session is the authority there (requirePortal, which answers a
 * stranger with sign-in or not found), and a one-day `meta` link is minted
 * for it here, under the person's own name, so everything from Facebook's
 * dialog on, the callback included, runs exactly as it does for a mailed
 * link. Nothing new reaches Meta, and the session cookie, being SameSite=Lax,
 * never rides along on another site's form post.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const clinic = form?.get("clinic");
  if (typeof clinic === "string" && clinic !== "") return fromPortal(request, clinic, surfaceOf(form?.get("from")));
  const raw = form?.get("token");
  const token = typeof raw === "string" ? raw : "";
  const back = (problem: string) => seeOther(publicUrl(`/channels/meta/${encodeURIComponent(token)}?problem=${problem}`));

  const context = requestContextFrom(request);
  if (!withinConnectAttemptLimit("submit", token, context.ipAddress ?? null)) return back("throttled");

  const link = await resolveConnectionLink(token, context, "meta");
  if (!link) return seeOther(publicUrl("/channels/invalid"));

  const app = metaApp();
  const configId = env.metaLoginConfigId();
  if (!app || !configId) return back("not_configured");

  const nonce = newNonce();
  const dialog = loginDialogUrl({
    appId: app.appId,
    configId,
    redirectUri: publicUrl(META_CALLBACK_PATH),
    state: nonce,
  });
  return seeOther(dialog, loginCookieHeader(encodeLoginCookie({ token, nonce })));
}

/** A clinic slug, as provisioning makes them. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** How long a link minted for the portal's button lasts: one sitting at Facebook's dialog, with room to retry. */
const PORTAL_LINK_DAYS = 1;

/**
 * The portal's button (set-up step 4, and Settings → Channels, which also
 * serves Reconnect; `from` says which): the clinic's signed-in session, then a
 * fresh single-use `meta` link for it, then Facebook. A problem before
 * Facebook comes back to the channels screen, which says what it was.
 */
async function fromPortal(request: Request, slug: string, from: "setup" | "settings"): Promise<Response> {
  if (!SLUG.test(slug) || !fromOwnPage(request.headers)) {
    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // Outside any try: both answer by throwing Next's redirect or not-found.
  const portal = await requirePortal(slug);
  const back = (problem: string) => seeOther(portalReturnUrl(portal.clinicSlug, from, problem));

  const context = requestContextFrom(request);
  if (!withinConnectAttemptLimit("submit", `portal-meta:${portal.clinicId}`, context.ipAddress ?? null)) {
    return back("throttled");
  }
  const app = metaApp();
  const configId = env.metaLoginConfigId();
  if (!app || !configId) return back("not_configured");

  const actor = await portalActor(portal);
  const { token } = await issueConnectionLink(
    portal.clinicId,
    { purpose: "meta", expiresInDays: PORTAL_LINK_DAYS },
    { actor: { type: "user", userId: portal.userId, label: actor.label }, request: context },
  );
  const nonce = newNonce();
  const dialog = loginDialogUrl({
    appId: app.appId,
    configId,
    redirectUri: publicUrl(META_CALLBACK_PATH),
    state: nonce,
  });
  return seeOther(dialog, loginCookieHeader(encodeLoginCookie({ token, nonce, from })));
}
