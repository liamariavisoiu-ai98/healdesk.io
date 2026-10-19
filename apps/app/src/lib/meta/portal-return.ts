import { publicUrl } from "./connect-http";

/**
 * Where the portal's Meta buttons send the clinic back to, and what they say
 * when they arrive. The two places a button lives are set-up's channels step
 * and Settings → Channels; Facebook's callback and the WhatsApp page both
 * return to whichever one the clinic pressed it on, with `?meta=<outcome>`.
 *
 * `from` is read off a form field or the login cookie, so it is an enum and
 * anything else is "setup"; the slug is the one the signed-in session was
 * granted, never taken from the browser here.
 */

export type PortalSurface = "setup" | "settings";

export function surfaceOf(value: unknown): PortalSurface {
  return value === "settings" ? "settings" : "setup";
}

/** An absolute URL on the public origin (BETTER_AUTH_URL), as every redirect to or from Meta must be. */
export function portalReturnUrl(slug: string, from: PortalSurface, outcome: string): string {
  const base = `/c/${encodeURIComponent(slug)}`;
  const q = `meta=${encodeURIComponent(outcome)}`;
  return publicUrl(from === "settings" ? `${base}/settings?${q}#channels` : `${base}/setup?s=channels&${q}`);
}

/** What each `?meta=` value means to the person reading it. `ok` ones are confirmations. */
export const PORTAL_META_OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Connected. AYA can reply there now." },
  whatsapp_connected: { ok: true, text: "WhatsApp is connected. AYA can reply there now." },
  not_configured: {
    ok: false,
    text: "Connecting Facebook and Instagram isn't switched on here. Email hello@healdesk.io and we'll connect them with you.",
  },
  throttled: { ok: false, text: "That was tried several times in a short space of time. Wait a few minutes and try again." },
  cancelled: { ok: false, text: "Facebook's sign-in was closed before it finished, so nothing was changed. You can try again." },
  no_page: {
    ok: false,
    text: "No Facebook Page was chosen. When Facebook asks which Pages to share, choose your clinic's Page. If none is listed, the account you signed in with isn't an admin of the Page.",
  },
  several_pages: {
    ok: false,
    text: "More than one Page was chosen. Each location answers on one Page, so sign in again and choose only this location's Page.",
  },
  meta_error: { ok: false, text: "Facebook didn't finish connecting. Nothing was changed. Try again in a minute." },
  page_taken: {
    ok: false,
    text: "That Facebook Page is already connected to another practice on healdesk, so it can't be connected here too. Nothing was changed. Email hello@healdesk.io and we'll sort it out.",
  },
  instagram_taken: {
    ok: false,
    text: "That Instagram account is already connected to another practice on healdesk, so it can't be connected here too. Nothing was changed. Email hello@healdesk.io and we'll sort it out.",
  },
};
