/**
 * The first name a visitor gives on their personalised demo page, before a
 * call starts (owner, 24 October 2026: "what's your name?" and then AYA
 * greets them by it).
 *
 * ## Client and server, one rule
 *
 * The page checks it as the visitor types; the routes check it again, with
 * `demoFirstName` in @healdesk/catalog (lib/demo/engine.ts), because a browser
 * can send anything. That function cannot be imported here: its module pulls
 * in `node:crypto` for the sealing, and this file is bundled for the browser.
 * So the rule is written twice, with one test (first-name.test.ts) holding
 * the two to the same answers. It is the rule for a name as a person says it:
 * one word of letters, apostrophes and hyphens, at most 40 characters.
 *
 * ## Remembered for the visit only
 *
 * The name is held in sessionStorage so "Call again" and a switch between the
 * three ways to call do not ask twice. It is business contact data a clinic
 * owner typed about themselves, never sent anywhere except the call they
 * start, and never written to localStorage: closing the tab forgets it.
 * Storage can be missing or throw (a private window, blocked site data), so
 * every access is guarded and the page works without it.
 */

export const FIRST_NAME_MAX = 40;

const NAME = /^[\p{L}][\p{L}'’-]*$/u;

/** The name as typed, cleaned, or null unless it is one word of letters, apostrophes and hyphens within the limit. */
export function cleanFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > FIRST_NAME_MAX) return null;
  return NAME.test(name) ? name : null;
}

const STORAGE_KEY = "healdesk-demo-first-name";

// The name for this visit. Held here as well as in sessionStorage, so a
// browser that refuses storage still remembers it until the page closes, and
// so React can subscribe to it (useSyncExternalStore) instead of reading
// storage in an effect. `undefined` means storage has not been read yet.
let current: string | null | undefined;
const listeners = new Set<() => void>();

function readStorage(): string | null {
  try {
    return cleanFirstName(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** The name remembered in this visit, or null. Browser only. */
export function getFirstName(): string | null {
  if (current === undefined) current = readStorage();
  return current;
}

/** Remember the name for this visit; null forgets it. A storage that refuses is not an error. */
export function rememberFirstName(name: string | null): void {
  current = name;
  try {
    if (name) window.sessionStorage.setItem(STORAGE_KEY, name);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private window or blocked storage: the name lasts as long as the page does.
  }
  for (const listener of listeners) listener();
}

export function subscribeFirstName(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
