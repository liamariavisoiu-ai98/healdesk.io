import { isMarketingStoreConfigured, sheetsClient, type SheetsClient } from "@/lib/sheets/client";
import { COUNTERS, dataRange, ensureSheetSchema, recordToRow, rowRange, rowToRecord, type Counter } from "@/lib/sheets/schema";

/**
 * Fixed-window rate limiter: per-instance memory, plus a shared row for each
 * of the three site-wide daily spend caps.
 *
 * ## What is shared and what is not, and why
 *
 * Sixteen routes call this, from the chat demo to the admin sign-in
 * throttle. Every per-IP, per-number and per-document counter lives in this
 * process's memory, which on a serverless host means the real ceiling is the
 * configured limit times however many instances are warm. That was the
 * design before the counters moved to Postgres (commit 8546574), and it is
 * the design again: the marketing site's store is now a Google Sheet, and a
 * Sheet cannot do an atomic increment. Every write is a whole row, every
 * call costs 300–800 ms, and the quota is about sixty requests a minute.
 * Routing sixteen counters through that would turn the sign-in throttle into
 * a sign-in outage.
 *
 * The three counters that bound the BILL rather than a visitor are different:
 * `chat:global:day` (api/chat), `callback:global:day` (api/callback) and
 * `site-read:global:day` (api/clinic-site) cap model turns, dialled calls and
 * website reads per UTC day across the whole site, and a cap that resets on
 * every cold start is not a cap. Those three, and only those three
 * (`GLOBAL_CAP_KEYS`), are backed by the `counters` tab of the marketing
 * Sheet.
 *
 * ## How the shared path works, and what it gets wrong on purpose
 *
 * Each instance keeps a cached copy of the row and re-reads it at most every
 * `REFRESH_MS` (30 s). An increment bumps the cached count and writes the
 * whole row back, best-effort. Two instances holding the same window can
 * each write a count the other has not seen, so the last write wins and the
 * loser's increments since its last refresh are lost. On refresh the larger
 * of the Sheet's count and the local count is kept, so an instance never
 * undercounts its own requests, only the others' for up to thirty seconds.
 *
 * The accepted imprecision, therefore: each warm instance may admit a few
 * requests beyond the cap per window — bounded by what it served in the
 * refresh interval — and never more than that. For caps of 2,000 turns and
 * 40 calls a day, on a site with a handful of warm instances, that is the
 * right trade against a quota-limited store; exactness would need a store
 * with an atomic increment, which the owner has declined.
 *
 * ## Without the Sheet
 *
 * When the store is not configured, or a call to it fails, the same
 * per-instance memory serves the global caps too, and the limiter says so
 * once (a warning in production, a note in development). It never throws:
 * the site must not go down because a Sheet is missing.
 *
 * The call signature is unchanged and still async; every route awaits it,
 * and the RateLimitResult shape is the same as before.
 */

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
};

/**
 * The only keys that go through the Sheet. Anything else is per-instance
 * memory. `site-read:global:day` (api/clinic-site) caps the website reads at
 * checkout, each of which is a model call.
 */
export const GLOBAL_CAP_KEYS: ReadonlySet<string> = new Set([
  "chat:global:day",
  "callback:global:day",
  "site-read:global:day",
]);

export function isGlobalCapKey(key: string): boolean {
  return GLOBAL_CAP_KEYS.has(key);
}

/** How stale a cached global-cap row may be before it is re-read. */
export const REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------
// In-memory path (everything but the global caps; the fallback for those)
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
// Shared path: the counters tab
// ---------------------------------------------------------------------------

type Shared = {
  count: number;
  windowStart: number;
  windowMs: number;
  /** The sheet row holding this key, once known. */
  row: number | null;
  /** When the row was last read from the Sheet. */
  readAt: number;
};

const shared = new Map<string, Shared>();

let warnedNoStore = false;
let lastErrorLogAt = 0;

function useSharedStore(): boolean {
  if (isMarketingStoreConfigured()) return true;
  if (!warnedNoStore) {
    warnedNoStore = true;
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[healdesk] rate limiter: MARKETING_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON unset; the daily spend caps are per instance until the Sheet is configured",
      );
    } else {
      console.info("[healdesk] rate limiter using in-memory counters (no marketing Sheet configured)");
    }
  }
  return false;
}

/** At most one line a minute: a quota outage must not become a log outage. */
function logStoreError(where: string, error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  console.error(`[healdesk] rate limiter store ${where}; using in-memory for this request`, {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function counters(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

/** The row for `key`, or an empty window if there is none yet. First matching row wins. */
async function readShared(client: SheetsClient, key: string, windowMs: number, now: number): Promise<Shared> {
  const rows = await client.getValues(dataRange(COUNTERS));
  for (let i = 0; i < rows.length; i += 1) {
    const record = rowToRecord(COUNTERS, rows[i]!) as Partial<Counter>;
    if (record.key !== key) continue;
    return {
      count: record.count ?? 0,
      windowStart: record.windowStart?.getTime() ?? now,
      windowMs: record.windowMs ?? windowMs,
      row: i + 2,
      readAt: now,
    };
  }
  return { count: 0, windowStart: now, windowMs, row: null, readAt: now };
}

/**
 * Reconcile what this instance believes with what the Sheet says. The later
 * window wins outright; two starts within a refresh interval of each other are
 * the same window seen from two instances, and the larger count is kept.
 */
function merge(local: Shared | undefined, remote: Shared): Shared {
  if (!local) return remote;
  const tolerance = 2 * REFRESH_MS;
  if (remote.windowStart > local.windowStart + tolerance) return remote;
  if (local.windowStart > remote.windowStart + tolerance) return { ...local, row: remote.row ?? local.row, readAt: remote.readAt };
  return {
    count: Math.max(local.count, remote.count),
    windowStart: Math.min(local.windowStart, remote.windowStart),
    windowMs: remote.windowMs,
    row: remote.row ?? local.row,
    readAt: remote.readAt,
  };
}

async function writeShared(client: SheetsClient, key: string, state: Shared): Promise<void> {
  const row = recordToRow(COUNTERS, {
    key,
    count: state.count,
    windowStart: new Date(state.windowStart),
    windowMs: state.windowMs,
  } satisfies Counter);
  if (state.row !== null) {
    await client.updateRange(rowRange(COUNTERS, state.row), [row]);
    return;
  }
  const { firstRow } = await client.appendRows(COUNTERS.title, [row]);
  state.row = firstRow;
}

async function currentShared(client: SheetsClient, key: string, windowMs: number, now: number): Promise<Shared> {
  let state = shared.get(key);
  if (!state || now - state.readAt > REFRESH_MS) {
    state = merge(state, await readShared(client, key, windowMs, now));
    shared.set(key, state);
  }
  return state;
}

function resultFrom(state: Shared, limit: number, now: number): RateLimitResult {
  const retryAfter = Math.max(0, Math.ceil((state.windowStart + state.windowMs - now) / 1000));
  if (state.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - state.count, retryAfter };
}

async function rateLimitShared(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const client = await counters();
  const now = Date.now();
  const state = await currentShared(client, key, windowMs, now);
  if (state.windowStart + state.windowMs <= now) {
    state.count = 1;
    state.windowStart = now;
    state.windowMs = windowMs;
  } else {
    state.count += 1;
  }
  // Mirror into memory so a later Sheet failure degrades from the last known
  // count rather than from zero.
  windows.set(key, { count: state.count, resetAt: state.windowStart + state.windowMs });
  try {
    await writeShared(client, key, state);
  } catch (error) {
    logStoreError("write failed", error);
  }
  return resultFrom(state, limit, now);
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!isGlobalCapKey(key) || !useSharedStore()) return rateLimitInMemory(key, limit, windowMs);
  try {
    return await rateLimitShared(key, limit, windowMs);
  } catch (error) {
    logStoreError("unreachable", error);
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
  if (!isGlobalCapKey(key) || !useSharedStore()) return isOverLimitInMemory(key, limit);
  try {
    const client = await counters();
    const now = Date.now();
    const state = await currentShared(client, key, 0, now);
    if (state.windowStart + state.windowMs <= now) return false;
    return state.count >= limit;
  } catch (error) {
    logStoreError("unreachable on peek", error);
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

/** A fresh instance: no windows, no cached rows, the one-time notices unsaid. */
export function __resetRateLimiterForTests(): void {
  windows.clear();
  shared.clear();
  warnedNoStore = false;
  lastErrorLogAt = 0;
}
