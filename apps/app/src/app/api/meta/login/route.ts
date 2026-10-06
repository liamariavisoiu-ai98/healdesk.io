import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveConnectionLink } from "@/lib/connections/links";
import { env } from "@/lib/env";
import { META_CALLBACK_PATH, metaApp, publicUrl, requestContextFrom, seeOther } from "@/lib/meta/connect-http";
import { loginDialogUrl } from "@/lib/meta/graph";
import { encodeLoginCookie, loginCookieHeader, newNonce } from "@/lib/meta/login-state";

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
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
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
