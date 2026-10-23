/**
 * The visitor's analytics choice, kept in the visitor's browser.
 *
 * Three states: `null` (never chose), `"granted"`, `"denied"`. Analytics is
 * opt-out (owner, 23 October 2026): it runs for `null` and `"granted"` and
 * stops for `"denied"`, set by the opt-out button on /privacy
 * (components/analytics/CookieChoice.tsx). It also stops, whatever is stored,
 * for a browser that sends Global Privacy Control, which California and
 * other states' laws treat as an opt-out, and PostHog itself honours Do Not
 * Track (components/analytics/PostHogProvider.tsx). Everything else about
 * the site works identically in every state.
 *
 * The cookie note (components/analytics/CookieNotice.tsx) asks nothing, so it
 * stores no choice; it only remembers that it was shown, under its own key.
 *
 * localStorage can be absent or throw (private windows, blocked storage,
 * thumbnail renderers). Every read and write is wrapped, and an unreadable
 * store reads as `null`: analytics on, the note shown again.
 *
 * The version is part of the key. It stays at the notice that first asked,
 * so a visitor who declined before opt-out stays declined and one who
 * accepted stays accepted; raise it only to re-ask everyone.
 */

export type ConsentState = "granted" | "denied" | null;

export const CONSENT_VERSION = "2026-09-13.1";
const KEY = `hd_consent:${CONSENT_VERSION}`;
const EVENT = "hd-consent-change";

/** Whether analytics may run for this choice: not when denied, and not when the browser sends Global Privacy Control. */
export function analyticsAllowed(state: ConsentState): boolean {
  if (state === "denied") return false;
  try {
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return false;
  } catch {
    // No navigator, nothing to honour.
  }
  return true;
}

export function getConsent(): ConsentState {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

export function setConsent(state: Exclude<ConsentState, null>): void {
  try {
    window.localStorage.setItem(KEY, state);
  } catch {
    // Nothing to do: the banner will show again next visit.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentState>(EVENT, { detail: state }));
  } catch {
    // Older environments without CustomEvent constructors; harmless.
  }
}

/** Subscribe to changes made in this tab. Returns an unsubscribe function. */
export function onConsentChange(fn: (state: ConsentState) => void): () => void {
  const handler = (event: Event) => fn((event as CustomEvent<ConsentState>).detail);
  window.addEventListener(EVENT, handler);
  // Changes made in another tab arrive as storage events.
  const storage = (event: StorageEvent) => {
    if (event.key === KEY) fn(getConsent());
  };
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", storage);
  };
}

const NOTE_KEY = "hd_cookie_note_seen";

/** Whether the cookie note has been shown and put away on this browser, so it is not shown again. */
export function cookieNoteSeen(): boolean {
  try {
    return window.localStorage.getItem(NOTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCookieNoteSeen(): void {
  try {
    window.localStorage.setItem(NOTE_KEY, "1");
  } catch {
    // Not stored: the note shows once more next visit.
  }
}
