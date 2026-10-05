/**
 * Every clinic-facing URL, built in one place (design D16).
 *
 * A link we email to a clinic, or hand to the browser that just paid, has to
 * point at apps/app's PUBLIC origin: `BETTER_AUTH_URL`. It must never be built
 * from `HEALDESK_APP_URL`, which is the internal address apps/web uses to reach
 * this app and must never appear in a browser (CLAUDE.md, "Two environment
 * variables decide origins").
 *
 * The failure this prevents is the quiet one. `env.betterAuthUrl()` falls back
 * to `http://localhost:3001` so that Better Auth can boot in development, and
 * five separate copies of `${env.betterAuthUrl()}/…` meant a production
 * deployment that forgot the variable mailed every clinic a link to its own
 * machine and logged nothing. Here, in production, an unset or malformed
 * origin THROWS `PublicUrlError`, which is better than a delivered dead link.
 *
 * A throw is only safe where nothing else rides on it, so every caller must
 * decide what it costs. Inside a transaction that has written a patient's
 * records (notifyDesk), catch it and report a failed send: the record must
 * survive the missing email. Before minting a single-use credential, ask
 * `publicOriginProblem()` first, so no live link is committed that nobody
 * can be sent.
 *
 * Read at call time, never at module scope, so `next build` (which runs with
 * NODE_ENV=production) does not need the variable.
 */

const DEV_FALLBACK = "http://localhost:3001";

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

/** The public origin, without a trailing slash. Exported for the few callers that need the bare origin. */
export function publicOrigin(): string {
  const raw = process.env.BETTER_AUTH_URL?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new PublicUrlError(
        "BETTER_AUTH_URL is not set. Every clinic-facing link is built from it; refusing to build one from a development fallback in production.",
      );
    }
    return DEV_FALLBACK;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PublicUrlError("BETTER_AUTH_URL is not a URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PublicUrlError("BETTER_AUTH_URL must be an http(s) origin.");
  }
  // Keep a path prefix if one was configured (a reverse proxy mounting the app
  // under /app), but never a trailing slash, query or fragment.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * `path` must be an absolute path on this app: it starts with exactly one
 * slash. A protocol-relative `//evil.example` or a full URL is refused, so a
 * caller cannot be talked into minting a link that leaves our origin.
 */
export function publicUrl(path: string): string {
  // A backslash, tab or newline is refused too: WHATWG URL parsing turns
  // `/\\host` and `/<TAB>/host` into `//host`.
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) {
    throw new PublicUrlError(
      "publicUrl() takes an absolute path on this app, starting with a single slash.",
    );
  }
  return `${publicOrigin()}${path}`;
}

/**
 * Null when clinic-facing links can be built; otherwise the reason, worded
 * for an operator. For callers that must check before they mint a token.
 */
export function publicOriginProblem(): string | null {
  try {
    publicOrigin();
    return null;
  } catch (error) {
    if (error instanceof PublicUrlError) return error.message;
    throw error;
  }
}
