import { consumeConnectionLinkWithin, resolveConnectionLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import { attachMetaChannel, MetaAssetTakenError } from "@/lib/meta/channels";
import { prepareMetaLogin } from "@/lib/meta/connect";
import {
  LinkAlreadySpentError,
  META_CALLBACK_PATH,
  META_CONNECT_ACTOR,
  metaApp,
  publicUrl,
  requestContextFrom,
  seeOther,
} from "@/lib/meta/connect-http";
import { portalReturnUrl } from "@/lib/meta/portal-return";
import { replacesConnectedAsset, retireDroppedFacebookRows } from "@/lib/meta/reconnect";
import { portalOrNull } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { stepUpPath } from "@/lib/portal/step-up";
import { decodeLoginCookie, LOGIN_COOKIE, loginCookieHeader, readCookie, stateMatches } from "@/lib/meta/login-state";
import { withTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/meta/callback — where Facebook Login for Business returns the clinic.
 *
 * In order, and each step fails closed:
 *
 *   1. The `state` must equal the nonce in the cookie this browser was given
 *      by /api/meta/login. Otherwise this is not a login we started, and the
 *      page says only that the link is no longer valid.
 *   2. The clinic's link must still resolve for `meta`.
 *   3. Every Graph call — the code exchange, the Page list, the webhook
 *      subscription — runs with no transaction open (lib/meta/connect.ts).
 *   4. The channels are stored and the link burned in ONE tenant
 *      transaction. If another request burned it first, the store rolls back
 *      with it, so a link never buys two connections.
 *
 * The cookie is cleared on every outcome. A problem the clinic can fix — they
 * cancelled, chose two Pages, chose none — goes back to the connect page with
 * the link still good, so they can try again.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const clear = loginCookieHeader(null);
  const invalid = () => seeOther(publicUrl("/channels/invalid"), clear);

  const cookie = decodeLoginCookie(readCookie(request.headers.get("cookie"), LOGIN_COOKIE));
  if (!cookie || !stateMatches(url.searchParams.get("state"), cookie.nonce)) return invalid();

  // A login the portal's button started returns to the portal screen it was
  // pressed on (cookie.from, set only by /api/meta/login's portal branch);
  // a mailed link's returns to its own page. The slug comes from the link,
  // never the browser.
  let slug: string | null = null;
  const back = (problem: string) =>
    seeOther(
      cookie.from && slug
        ? portalReturnUrl(slug, cookie.from, problem)
        : publicUrl(`/channels/meta/${encodeURIComponent(cookie.token)}?problem=${problem}`),
      clear,
    );

  // Resolved before the cancelled answer, so a portal login that Facebook
  // sent back without a code returns to the portal, not to the mailed page.
  const context = requestContextFrom(request);
  const link = await resolveConnectionLink(cookie.token, context, "meta");
  if (!link) return invalid();
  slug = link.clinicSlug;

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return back("cancelled");

  const app = metaApp();
  if (!app) return back("not_configured");

  const outcome = await prepareMetaLogin(fetch, app, { code, redirectUri: publicUrl(META_CALLBACK_PATH) });
  if (!outcome.ok) {
    if (outcome.problem === "meta_error") {
      // Meta's message names the failing call, never the token.
      log.warn("Meta login could not be completed", { clinicId: link.clinicId, reason: outcome.detail });
    }
    return back(outcome.problem);
  }

  // A login the portal started (or any link a signed-in person minted), that would swap the clinic's connected Page or
  // Instagram account for another, needs a live passkey step-up on the session
  // that comes back (the Google Calendar rule for a different account); a
  // first connect and a reconnect of the same Page need none. Without one the
  // clinic is sent to step up and presses the button again. The write is then
  // recorded under the device's name instead of the service's.
  let actor: typeof META_CONNECT_ACTOR | { type: "user"; userId: string; label: string } = META_CONNECT_ACTOR;
  // Decided on the link, not the cookie: a portal-minted link names the person
  // who issued it, an operator's does not, and a cookie edited to drop `from`,
  // or the link opened on its mailed page, must not skip the step-up.
  const portalIssued = cookie.from !== undefined || link.issuedBy !== null;
  const surface = cookie.from ?? "setup";
  if (portalIssued) {
    const portal = await portalOrNull(link.clinicSlug);
    const stepped = portal ? await portalActor(portal) : null;
    if (portal && stepped) actor = { type: "user", userId: portal.userId, label: stepped.label };
    const swaps = await withTenant({ clinicId: link.clinicId, actor: META_CONNECT_ACTOR, request: context }, (tx) =>
      replacesConnectedAsset(tx.db, tx.clinicId, outcome.channels),
    );
    if (swaps && !stepped?.steppedUp) {
      const next = surface === "settings" ? `/c/${link.clinicSlug}/settings` : `/c/${link.clinicSlug}/setup?s=channels`;
      return seeOther(publicUrl(stepUpPath(link.clinicSlug, next)), clear);
    }
  }

  try {
    await withTenant({ clinicId: link.clinicId, actor, request: context }, async (tx) => {
      for (const channel of outcome.channels) {
        await attachMetaChannel(tx, { ...channel, via: "facebook_login" });
      }
      // A Facebook login this one no longer returns (the Page has no linked
      // Instagram any more) whose token Meta already dropped would stay
      // marked, with a Reconnect nothing can clear. It is dead, so retire it.
      await retireDroppedFacebookRows(tx, outcome.channels.map((c) => c.platform));
      const burned = await consumeConnectionLinkWithin(tx, cookie.token, context.ipAddress ?? null, "meta");
      if (!burned) throw new LinkAlreadySpentError();
    });
  } catch (error) {
    if (error instanceof LinkAlreadySpentError) return invalid();
    // Another practice holds this Page or Instagram account: nothing saved.
    if (error instanceof MetaAssetTakenError) {
      return back(error.platform === "instagram" ? "instagram_taken" : "page_taken");
    }
    log.error("Storing a clinic's Meta channels failed", { clinicId: link.clinicId, error: describeError(error) });
    return back("meta_error");
  }

  if (portalIssued) return seeOther(portalReturnUrl(link.clinicSlug, surface, "connected"), clear);

  const done = new URLSearchParams({ channel: "meta", page: outcome.page.name });
  if (outcome.instagram) done.set("instagram", outcome.instagram.username ?? "");
  return seeOther(publicUrl(`/channels/done?${done.toString()}`), clear);
}
