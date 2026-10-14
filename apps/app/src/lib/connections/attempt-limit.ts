import { createHash } from "node:crypto";

/**
 * How fast one anonymous visitor may drive the connect surface.
 *
 * `/connect/[token]` is the only page in this product reachable without a
 * session, and both of its paths cost real, durable work. An open runs a tenant
 * transaction and writes an `audit_log` row; a submission runs envelope
 * encryption and writes another. Before this module the open path had no bound
 * at all, and the submission path had one keyed only on the token.
 *
 * ## The failure this prevents is not theft
 *
 * A token is 32 bytes of CSPRNG output. It is not reachable by guessing and
 * nothing here changes that — this is a bound on our own work, never an
 * authentication check, and it is not what stands between an attacker and a
 * clinic.
 *
 * The reachable failure is cheaper and it is permanent. Anyone who has ever
 * held a link — a forwarded email, a departing office manager, a shared
 * front-desk browser's history — holds a URL that still resolves to a clinic
 * after it is spent, and `resolveConnectionLink()` records every rejected open
 * on purpose, because a link still circulating after redemption is precisely
 * what we want to see. Unbounded, that same property is a hose: 25 anonymous
 * GETs of one spent link wrote 25 audit rows, measured, and `healdesk_app` has
 * no DELETE on `audit_log` (drizzle/0003) by design, so nothing in the
 * application can clean up afterwards. The compliance record is the one store
 * where "an anonymous stranger can append to this indefinitely" is least
 * acceptable.
 *
 * ## Why both keys, and why neither alone
 *
 *   - **Per token.** The key that actually bounds the replay above, because
 *     that flood needs a token which resolves to a clinic and there is exactly
 *     one of those per link. It is also the key an attacker cannot forge.
 *   - **Per address.** The only key that bounds a caller spraying tokens it
 *     does not hold. On its own it is the weaker half — the address is the
 *     one our load balancer saw (lib/client-ip.ts), which a client cannot
 *     forge but can change by sending from somewhere else — so it bounds
 *     ordinary load and honest runaway clients rather than a determined one.
 *     Keyed on its own token, a sprayer opens a fresh window with every guess
 *     and is limited by nothing; that is the gap it closes.
 *
 * Both counters are always taken, never short-circuited: tripping one must not
 * buy a free pass on the other.
 *
 * ## Why a missing address fails open
 *
 * Deliberately skipped rather than bucketed under a placeholder. A deployment
 * whose proxy forwards no client address would otherwise collapse every visitor
 * on earth into one shared window and fuse the only page a customer ever sees.
 * The per-token bound still applies, and it is the one carrying the property.
 *
 * ## Scope
 *
 * In-memory, so the effective ceiling is (limit × instances). Move it to Redis
 * alongside apps/web/src/lib/rate-limit.ts before this runs on more than one
 * instance. Same shape as that limiter deliberately, so the move is a swap.
 */

/** The two things an anonymous visitor can do, priced separately. */
export type ConnectAttempt = "open" | "submit";

const WINDOW_MS = 10 * 60_000;

const LIMITS: Record<
  ConnectAttempt,
  { perToken: number; perAddress: number }
> = {
  /**
   * An open is idempotent and genuinely repeats: a mail-safety scanner fetches
   * the URL before the recipient sees it, the recipient opens it, refreshes,
   * closes the tab and comes back after ringing the vendor. Loose enough that
   * no honest visitor meets it; tight enough that a replay cannot be a flood.
   */
  open: { perToken: 30, perAddress: 120 },
  /**
   * A submission is one person pasting one credential. Five is already a
   * generous allowance for typos, and each attempt costs an envelope seal.
   * Unchanged from the limit this module absorbed from the route action.
   */
  submit: { perToken: 5, perAddress: 20 },
};

/**
 * A hard ceiling on live windows, because expiry alone is not one.
 *
 * Every distinct token seen creates an entry, and inside a ten-minute window
 * nothing is expired, so sweeping expired entries bounds nothing: a flood of
 * distinct tokens grows this map at the speed of the flood. That is a memory
 * leak reachable by anyone who can reach a public route, in the process that
 * holds clinics' credentials.
 *
 * At the ceiling the oldest windows are evicted, which resets those counters —
 * so a flood can, in principle, buy itself fresh attempts. That trade is the
 * right way round. The eviction costs an attacker nothing they did not already
 * have (a token they cannot guess is still 256 bits away), while the leak costs
 * us the process.
 */
const MAX_TRACKED_WINDOWS = 10_000;

/** Evicted per pass once the ceiling is hit, so eviction is not per-request. */
const EVICTION_BATCH = MAX_TRACKED_WINDOWS / 10;

const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * Count one attempt, and say whether it is still inside the allowance.
 *
 * `token` is whatever arrived in the URL or the form — this makes no judgement
 * about its shape, deliberately, so that a malformed token costs the same and
 * discloses the same as a well-formed one. `address` is the client address the
 * route managed to determine, or null.
 */
export function withinConnectAttemptLimit(
  kind: ConnectAttempt,
  token: string,
  address: string | null,
): boolean {
  const now = Date.now();
  reclaim(now);

  const limits = LIMITS[kind];

  // Keyed on SHA-256 of the token, never the token. This map outlives the
  // request, and a live credential-granting secret sitting in a long-lived,
  // process-wide structure is what ends up in a heap dump, or in the
  // diagnostic endpoint someone adds later that prints map keys. Same reason
  // connection_links stores a digest. The address is not hashed: it is not a
  // secret, audit_log already stores it in the clear, and pretending otherwise
  // would only obscure what this map holds.
  const tokenOk = take(
    `${kind}:t:${createHash("sha256").update(token).digest("hex")}`,
    limits.perToken,
    now,
  );

  const addressOk =
    address === null
      ? true
      : take(`${kind}:a:${address}`, limits.perAddress, now);

  return tokenOk && addressOk;
}

/**
 * How often one inbox may be sent a sign-in link from /sign-in, and how often
 * one client may ask at all (plan Part D1). The same two keys, in the same
 * map, for the same reasons as the connect surface above.
 *
 * Each request can put a real email in a clinic's inbox, so the per-inbox
 * bound is what stops a stranger using the page to flood one: five in ten
 * minutes is ample for a person who mistyped or lost a link. The per-client
 * bound stops one caller walking a list of addresses. The address typed is
 * hashed like a token, so no inbox sits in this map in the clear, and it is
 * counted whether or not it belongs to an account, so tripping the limit says
 * nothing about which addresses do.
 */
const SIGN_IN_LIMITS = { perInbox: 5, perAddress: 20 } as const;

export function withinSignInRequestLimit(email: string, address: string | null): boolean {
  const now = Date.now();
  reclaim(now);

  const inboxOk = take(
    `sign_in:e:${createHash("sha256").update(email).digest("hex")}`,
    SIGN_IN_LIMITS.perInbox,
    now,
  );
  const addressOk =
    address === null ? true : take(`sign_in:a:${address}`, SIGN_IN_LIMITS.perAddress, now);

  return inboxOk && addressOk;
}

/**
 * How often one inbox may be named on /sign-in/help, and how often one client
 * may ask at all (plan Part D5). Tighter than /sign-in: each request costs
 * Stripe reads, and one that sends nothing tells ops (through notifyOps,
 * which keeps one email an hour per clinic), so the per-inbox bound is three
 * in ten minutes and the per-client bound ten. The same map and the same
 * hashing as the sign-in limit, and counted whether or not the address has
 * an account, so meeting it says nothing about which addresses do.
 */
const SIGN_IN_HELP_LIMITS = { perInbox: 3, perAddress: 10 } as const;

export function withinSignInHelpLimit(email: string, address: string | null): boolean {
  const now = Date.now();
  reclaim(now);

  const inboxOk = take(
    `sign_in_help:e:${createHash("sha256").update(email).digest("hex")}`,
    SIGN_IN_HELP_LIMITS.perInbox,
    now,
  );
  const addressOk =
    address === null
      ? true
      : take(`sign_in_help:a:${address}`, SIGN_IN_HELP_LIMITS.perAddress, now);

  return inboxOk && addressOk;
}

function take(key: string, limit: number, now: number): boolean {
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  existing.count += 1;
  return existing.count <= limit;
}

function reclaim(now: number): void {
  if (windows.size < 1_000) return;

  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }

  if (windows.size < MAX_TRACKED_WINDOWS) return;

  // Nothing expired and still at the ceiling: this is not organic traffic.
  // Drop the windows closest to expiring — the ones with the least left to say.
  const oldestFirst = [...windows.entries()].sort(
    (a, b) => a[1].resetAt - b[1].resetAt,
  );
  for (const [key] of oldestFirst.slice(0, EVICTION_BATCH)) {
    windows.delete(key);
  }
}
