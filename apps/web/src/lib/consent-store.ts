/**
 * Cookie-notice consent, kept in the visitor's browser.
 *
 * Three states: `null` (never answered — the banner shows), `"granted"`,
 * `"denied"`. Analytics initialises only on "granted" (see
 * components/analytics/PostHogProvider.tsx); everything else about the site
 * works identically in all three states, which is what makes "decline" an
 * honest button rather than a dark pattern.
 *
 * localStorage can be absent or throw (private windows, blocked storage,
 * thumbnail renderers). Every read and write is wrapped, and an unreadable
 * store reads as `null` — the banner shows again, which is the safe direction.
 *
 * The version is part of the key: a material change to what analytics
 * collects gets a new version, which re-asks everyone rather than inheriting
 * a consent given to a different notice.
 */

export type ConsentState = "granted" | "denied" | null;

export const CONSENT_VERSION = "2026-09-13.1";
const KEY = `hd_consent:${CONSENT_VERSION}`;
const EVENT = "hd-consent-change";

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

/**
 * Forget the answer so the notice asks again. Used by the "change my cookie
 * choice" control on /privacy; analytics is opted out on the next load
 * because a `null` state never initialises it.
 */
export function clearConsent(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
  try {
    window.dispatchEvent(new CustomEvent<ConsentState>(EVENT, { detail: null }));
  } catch {
    // See setConsent.
  }
}
