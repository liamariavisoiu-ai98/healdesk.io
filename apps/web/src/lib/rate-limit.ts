/**
 * Fixed-window rate limiter.
 *
 * In-memory by default, which is correct for a single instance and *not*
 * correct across serverless instances, each cold start gets its own map, so
 * the effective limit is (limit × instances). That's acceptable for a demo
 * whose real ceiling is the email gate plus the per-request token cap, but if
 * the chat is ever ungated, move this to Upstash Redis (env vars are already
 * stubbed in .env.example) before it becomes the only thing standing between a
 * scraper and the API bill.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** Evict expired entries so the map doesn't grow without bound. */
function sweep(now: number): void {
  if (windows.size < 5_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
};

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  existing.count += 1;
  const retryAfter = Math.ceil((existing.resetAt - now) / 1000);

  if (existing.count > limit) {
    return { ok: false, remaining: 0, retryAfter };
  }

  return { ok: true, remaining: limit - existing.count, retryAfter };
}

/**
 * Is this key already over its limit, WITHOUT spending from the budget?
 *
 * Exists for the callback endpoint's per-number budget, where the check and the
 * charge have to happen at different moments. The number's allowance protects a
 * stranger's phone from ringing repeatedly, so it should only be spent by a
 * call that actually got placed, but it still has to be checked before we
 * reach the provider, or a caller over their limit would be dialled anyway.
 *
 * Peek here, `rateLimit` on success. Two requests racing between the peek and
 * the charge can both pass, which costs one extra call in the worst case; a
 * lock would be the wrong trade for a fixed-window counter that is already
 * per-instance (see the note at the top of this file).
 */
export function isOverLimit(key: string, limit: number): boolean {
  const window = windows.get(key);
  if (!window || window.resetAt <= Date.now()) return false;
  return window.count >= limit;
}

/**
 * Best-effort client IP. Behind Vercel/most proxies `x-forwarded-for` is set and
 * its first entry is the client. Falls back to a shared bucket, which fails
 * closed-ish: unidentifiable clients share one limit rather than getting none.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "unknown";
}
