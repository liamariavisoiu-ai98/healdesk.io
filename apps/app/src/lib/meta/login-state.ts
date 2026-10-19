import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Carrying a clinic's link across Facebook's login dialog without showing it to Facebook.
 *
 * The link token is the clinic's whole authentication (app/connect/[token]).
 * Putting it in the OAuth `state` would hand it to Meta and write it into
 * every redirect URL in between. Instead `/api/meta/login` puts the token and
 * a fresh random nonce in one HttpOnly cookie, sends only the nonce to Meta as
 * `state`, and `/api/meta/callback` accepts the code only when the `state`
 * that comes back equals the nonce in the cookie. That is the standard
 * defence against a forged callback: an attacker can make a browser arrive at
 * the callback with their own code, but cannot make it carry a cookie this
 * origin set for a login that browser started.
 *
 * The cookie is scoped to `/api/meta`, lives fifteen minutes, and is cleared
 * by the callback whatever the outcome. `SameSite=Lax` is what lets it ride
 * along on Meta's top-level redirect back, and no further.
 */

export const LOGIN_COOKIE = "hd_meta_login";
const MAX_AGE_SECONDS = 15 * 60;

/** `from` is set only when the portal's button started the login; it says which portal screen to return to. */
export type LoginCookie = { token: string; nonce: string; from?: "setup" | "settings" };

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function encodeLoginCookie(value: LoginCookie): string {
  return Buffer.from(JSON.stringify({ t: value.token, n: value.nonce, ...(value.from ? { r: value.from } : {}) }), "utf8").toString("base64url");
}

export function decodeLoginCookie(raw: string | undefined | null): LoginCookie | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; n?: unknown; r?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.n !== "string" || !parsed.t || !parsed.n) return null;
    return { token: parsed.t, nonce: parsed.n, ...(parsed.r === "setup" || parsed.r === "settings" ? { from: parsed.r } : {}) };
  } catch {
    return null;
  }
}

/** Constant-time: the comparison must not tell a guesser how much of the nonce they have right. */
export function stateMatches(state: string | null | undefined, nonce: string): boolean {
  if (!state) return false;
  const a = Buffer.from(state, "utf8");
  const b = Buffer.from(nonce, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One cookie string, so the setting and the clearing cannot drift apart on path or flags. */
export function loginCookieHeader(value: string | null): string {
  const attrs = ["Path=/api/meta", "HttpOnly", "Secure", "SameSite=Lax"];
  return value === null
    ? [`${LOGIN_COOKIE}=`, "Max-Age=0", ...attrs].join("; ")
    : [`${LOGIN_COOKIE}=${value}`, `Max-Age=${MAX_AGE_SECONDS}`, ...attrs].join("; ");
}

/** Read one cookie from a Cookie header without pulling in a parser for it. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
