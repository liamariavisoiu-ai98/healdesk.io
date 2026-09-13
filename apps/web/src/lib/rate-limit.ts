import { isMarketingDbConfigured, marketingPool } from "@/lib/db";

/**
 * Fixed-window rate limiter, shared across instances.
 *
 * ## Why it is no longer a Map
 *
 * The previous limiter kept its counters in module memory. On a serverless
 * host each instance has its own memory, so the effective limit was the
 * configured limit multiplied by however many instances were warm — and the
 * instances multiply exactly when traffic spikes, which is when the limit
 * matters. The counters now live in the marketing database (src/lib/db), one
 * row per key, updated by a single atomic upsert so two instances racing at
 * the boundary cannot both be told "you are the last one allowed".
 *
 * ## Fail closed in production, open in development
 *
 * With no MARKETING_DATABASE_URL in production the limiter throws at first
 * use. A limiter that silently degrades to per-instance memory on a
 * multi-instance host is not a limiter, and the routes it protects front a
 * paid model and a paid dialler. In development the in-memory path is used
 * so nobody needs Postgres to run the site locally, and it says so once.
 *
 * A database that is configured but momentarily unreachable is different from
 * one that was never configured: that request falls back to memory with a
 * loud error, because a Postgres blip should not take the whole site down.
 *
 * The call signature is unchanged except for being async; every route awaits
 * it, and the RateLimitResult shape is the same as before.
 */

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
};

// ---------------------------------------------------------------------------
// In-memory path (development, and the fallback for a transient outage)
// ---------------------------------------------------------------------------

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

function sweep(now: number): void {
  if (windows.size < 5_000) return;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export function rateLimitInMemory(
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
  if (existing.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - existing.count, retryAfter };
}

function isOverLimitInMemory(key: string, limit: number): boolean {
  const window = windows.get(key);
  if (!window || window.resetAt <= Date.now()) return false;
  return window.count >= limit;
}

// ---------------------------------------------------------------------------
// Shared path
// ---------------------------------------------------------------------------

let warnedInMemory = false;

function useSharedStore(): boolean {
  if (isMarketingDbConfigured()) return true;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MARKETING_DATABASE_URL is not set: the rate limiter refuses to run on per-instance memory in production. See src/lib/rate-limit.ts.",
    );
  }
  if (!warnedInMemory) {
    warnedInMemory = true;
    console.info("[healdesk] rate limiter using in-memory counters (no MARKETING_DATABASE_URL)");
  }
  return false;
}

/**
 * One statement, so the read-modify-write cannot interleave with another
 * instance's. The window either has expired (start over at 1) or has not
 * (increment); Postgres evaluates both CASEs against the row it locks.
 * `now()` comes from the database so every instance agrees on the clock.
 */
const UPSERT = `
  insert into rate_limits (key, count, window_start, window_ms)
  values ($1, 1, now(), $2)
  on conflict (key) do update set
    count = case
      when rate_limits.window_start + (rate_limits.window_ms * interval '1 millisecond') <= now() then 1
      else rate_limits.count + 1
    end,
    window_start = case
      when rate_limits.window_start + (rate_limits.window_ms * interval '1 millisecond') <= now() then now()
      else rate_limits.window_start
    end,
    window_ms = excluded.window_ms
  returning count, window_start, window_ms, now() as db_now
`;

type Row = { count: number; window_start: Date; window_ms: number; db_now: Date };

function resultFromRow(row: Row, limit: number): RateLimitResult {
  const resetAt = row.window_start.getTime() + row.window_ms;
  const retryAfter = Math.max(0, Math.ceil((resetAt - row.db_now.getTime()) / 1000));
  if (row.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - row.count, retryAfter };
}

let sweepCounter = 0;

/** Occasionally drop rows whose window closed over a day ago. Cheap, best-effort. */
async function maybeSweepShared(): Promise<void> {
  sweepCounter = (sweepCounter + 1) % 200;
  if (sweepCounter !== 0) return;
  try {
    await marketingPool().query(
      `delete from rate_limits where window_start + (window_ms * interval '1 millisecond') < now() - interval '1 day'`,
    );
  } catch {
    // Sweeping is housekeeping; a failure here changes nothing about limits.
  }
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!useSharedStore()) return rateLimitInMemory(key, limit, windowMs);
  try {
    const { rows } = await marketingPool().query<Row>(UPSERT, [key, windowMs]);
    const row = rows[0];
    if (!row) throw new Error("rate limit upsert returned no row");
    void maybeSweepShared();
    return resultFromRow(row, limit);
  } catch (error) {
    console.error("[healdesk] rate limiter store unreachable; using in-memory for this request", {
      error: error instanceof Error ? error.message : String(error),
    });
    return rateLimitInMemory(key, limit, windowMs);
  }
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
 * lock would be the wrong trade for a counter whose charge is deferred.
 */
export async function isOverLimit(key: string, limit: number): Promise<boolean> {
  if (!useSharedStore()) return isOverLimitInMemory(key, limit);
  try {
    const { rows } = await marketingPool().query<Omit<Row, "count"> & { count: number }>(
      `select count, window_start, window_ms, now() as db_now from rate_limits where key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return false;
    const resetAt = row.window_start.getTime() + row.window_ms;
    if (resetAt <= row.db_now.getTime()) return false;
    return row.count >= limit;
  } catch (error) {
    console.error("[healdesk] rate limiter store unreachable on peek; using in-memory", {
      error: error instanceof Error ? error.message : String(error),
    });
    return isOverLimitInMemory(key, limit);
  }
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
