/**
 * Whether a GitHub token still works, and when it expires.
 *
 * GitHub answers every request made with a fine-grained or expiring token
 * with a `GitHub-Authentication-Token-Expiration` header, so one call tells
 * both. `GET /rate_limit` is the call: it needs no permission, reads nothing
 * from the repository and does not count against the token's rate limit.
 * The body is discarded unread.
 *
 * Server-side only: the token is in the request.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/admin/github-token is server-side only: it sends GitHub tokens.");
}

const TIMEOUT_MS = 6_000;

export type TokenCheck =
  | { ok: true; expiresAt: Date | null }
  /** GitHub said 401: expired, revoked or mistyped. */
  | { ok: false; reason: "rejected" }
  /** No usable answer; says nothing about the token. */
  | { ok: false; reason: "unreachable" };

/**
 * GitHub writes the date as "2026-11-30 10:00:00 UTC" (and has written
 * "+0000" in place of UTC). Anything else is null rather than a guess.
 */
export function parseTokenExpiry(raw: string | null): Date | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!match) return null;
  const zone = !match[3] || match[3] === "UTC" || match[3] === "Z" ? "Z" : match[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const at = new Date(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function checkGithubToken(token: string, fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.github.com/rate_limit", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "healdesk-admin",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  void response.body?.cancel().catch(() => undefined);
  if (response.status === 401) return { ok: false, reason: "rejected" };
  if (!response.ok) return { ok: false, reason: "unreachable" };
  return { ok: true, expiresAt: parseTokenExpiry(response.headers.get("github-authentication-token-expiration")) };
}
