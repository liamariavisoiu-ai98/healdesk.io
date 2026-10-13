/**
 * The homepage visitor's own demo, remembered in their browser (owner,
 * 13 October 2026).
 *
 * "See it in your own branding" builds a demo and promises its link by
 * email. When that email does not come, the link was the visitor's only way
 * back: the owner asked for one, never received it, and had no way to find
 * the demo again. So the homepage keeps the link in this browser's local
 * storage under `OWN_DEMO_KEY`, and offers it on the next visit for as long
 * as the demo is live. It is never sent to us, holds the link and the site's
 * host and nothing typed into the email field, and the Privacy page lists it
 * beside the cookie-notice answer.
 *
 * Local storage can be missing or throw (a private window, blocked site
 * data), so every read and write here is wrapped, and the page works the
 * same without it: the link is still in the window and in the email.
 */

export const OWN_DEMO_KEY = "hd_own_demo";

/** The demo's week (DEMO_LIFETIME_MS in lib/demo/sessions.ts; remembered.test.ts holds them together). */
export const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

/** Fired on this page after a write: the browser's own `storage` event only reaches other tabs. */
const CHANGED = "hd-own-demo";

export type RememberedDemo = { url: string; host: string; until: number };

/** Only a link to one of our demo pages is kept or offered, whatever the storage holds. */
const DEMO_PATH = /^https?:\/\/[^/\s]+\/demo\/[a-z0-9-]{1,80}$/;

export function parseRemembered(raw: string | null, now: number = Date.now()): RememberedDemo | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedDemo> | null;
    if (!value || typeof value.url !== "string" || !DEMO_PATH.test(value.url)) return null;
    if (typeof value.host !== "string" || !value.host || value.host.length > 253) return null;
    if (typeof value.until !== "number" || value.until <= now) return null;
    return { url: value.url, host: value.host, until: value.until };
  } catch {
    return null;
  }
}

export function rememberDemo(url: string, host: string, now: number = Date.now()): void {
  if (!DEMO_PATH.test(url)) return;
  try {
    window.localStorage.setItem(OWN_DEMO_KEY, JSON.stringify({ url, host, until: now + REMEMBER_MS }));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // No storage: the window and the email still carry the link.
  }
}

/** For useSyncExternalStore: the raw stored value, or null. */
export function readRememberedRaw(): string | null {
  try {
    return window.localStorage.getItem(OWN_DEMO_KEY);
  } catch {
    return null;
  }
}

export function subscribeRemembered(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}
