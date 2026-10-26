import { scrypt, timingSafeEqual } from "node:crypto";

/**
 * The approval passcode's verifier, shared by both apps (lane P7i; owner,
 * 26 October 2026). apps/web checks it in the console's approval inbox
 * (apps/web lib/admin/approval-passcode.ts, lane P7h); apps/app checks it in
 * the Slack modal that approves a support reply (apps/app
 * lib/support/slack-passcode.ts). One code, not a copy: the hash's format and
 * bounds, the slow derivation, the constant-time compare, the five-tries
 * lockout and the one-derivation-in-flight rule are all here.
 *
 * Pure Node: no database, no email, no environment read, no Vercel or AWS
 * code. Each app reads the hash from its own environment
 * (HEALDESK_APPROVAL_PASSCODE_HASH: a Vercel variable for apps/web, a
 * Parameter Store parameter for apps/app, the same value pasted in both) and
 * keeps its own lockout, made by `createPasscodeLockout`: the counters live
 * in that process's memory, as the sign-in throttle's do, so a cold start or
 * a redeploy resets them and the two apps count apart.
 *
 * The passcode itself is never stored, logged or returned by anything here.
 */

/** Wrong tries before approvals lock. */
export const PASSCODE_ATTEMPT_LIMIT = 5;
/** How long approvals stay locked, and the window the wrong tries are counted in. */
export const PASSCODE_LOCK_MS = 15 * 60 * 1000;

/** Six digits, and nothing else (spaces are taken out before the check). */
export const PASSCODE_SHAPE = /^[0-9]{6}$/;

export type ScryptHash = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

function base64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, "base64");
}

/** `scrypt$N$r$p$<base64 salt>$<base64 key>`, bounded (N a power of two, 128*N*r at most 64 MiB), or null. */
export function parsePasscodeHash(raw: string | undefined | null): ScryptHash | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  const parts = raw.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [string, string, string, string, string, string];
  if (!/^[0-9]{1,10}$/.test(rawN) || !/^[0-9]{1,4}$/.test(rawR) || !/^[0-9]{1,4}$/.test(rawP)) return null;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (128 * N * r > 64 * 1024 * 1024) return null;
  const salt = base64(rawSalt);
  const key = base64(rawKey);
  if (!salt || !key || salt.length < 8 || salt.length > 64 || key.length < 16 || key.length > 128) return null;
  return { N, r, p, salt, key };
}

function derive(passcode: string, h: ScryptHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: 128 * h.N * h.r + 128 * h.r * h.p + 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Whether `offered` is the passcode `rawHash` was made from. False for an unset or malformed hash. Never throws. */
export async function passcodeMatches(offered: string, rawHash: string | undefined | null): Promise<boolean> {
  const stored = parsePasscodeHash(rawHash);
  if (!stored) return false;
  try {
    const derived = await derive(offered, stored);
    return derived.length === stored.key.length && timingSafeEqual(derived, stored.key);
  } catch {
    return false;
  }
}

type Window = { count: number; resetAt: number };

/** Which counter reached the limit on the try that locked. */
export type LockReason = "account" | "global";

export type PasscodeLockout = {
  /** How many milliseconds approvals stay locked for this account (its own count or everyone's); 0 when open. */
  lockedFor(account: string, now: number): number;
  /**
   * Claim the one derivation this process runs at a time; false when one is
   * in flight. Call in the same synchronous turn as `lockedFor`, so a burst
   * cannot all read an unspent budget; `release` in a finally.
   */
  claim(): boolean;
  release(): void;
  /** Count a wrong try, for this account and across all of them; calls `onLock` on the try that locks. */
  recordFailure(account: string, now: number): void;
  /** A fresh process: no wrong tries counted. For tests. */
  reset(): void;
};

/** Accounts remembered per process; the oldest is forgotten first. */
const MAX_ACCOUNTS = 16;

/**
 * One process's lockout: FIVE wrong tries inside FIFTEEN minutes lock
 * approvals, per account and across all of them, counted before any
 * derivation; a successful try does not reset a count. `onLock` hears the
 * try that locks, once per lock, and must never throw or delay.
 */
export function createPasscodeLockout(onLock: (account: string, reason: LockReason, now: number) => void = () => {}): PasscodeLockout {
  const perAccount = new Map<string, Window>();
  let global: Window = { count: 0, resetAt: 0 };
  let inFlight = 0;

  function locked(window: Window | undefined, now: number): number {
    if (!window || window.resetAt <= now) return 0;
    return window.count >= PASSCODE_ATTEMPT_LIMIT ? window.resetAt - now : 0;
  }

  function spend(window: Window | undefined, now: number): Window {
    const fresh = !window || window.resetAt <= now ? { count: 0, resetAt: now + PASSCODE_LOCK_MS } : window;
    fresh.count += 1;
    return fresh;
  }

  return {
    lockedFor(account, now) {
      return Math.max(locked(perAccount.get(account), now), locked(global, now));
    },
    claim() {
      if (inFlight > 0) return false;
      inFlight += 1;
      return true;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
    },
    recordFailure(account, now) {
      // Read before the delete that moves the account to the newest place in the map.
      const mine = spend(perAccount.get(account), now);
      perAccount.delete(account);
      perAccount.set(account, mine);
      while (perAccount.size > MAX_ACCOUNTS) {
        const oldest = perAccount.keys().next().value;
        if (oldest === undefined) break;
        perAccount.delete(oldest);
      }
      global = spend(global, now);
      // The try that locks: once per lock, whichever counter reached the limit first.
      try {
        if (mine.count === PASSCODE_ATTEMPT_LIMIT) onLock(account, "account", now);
        else if (global.count === PASSCODE_ATTEMPT_LIMIT) onLock(account, "global", now);
      } catch {
        // A report that failed never changes the refusal.
      }
    },
    reset() {
      perAccount.clear();
      global = { count: 0, resetAt: 0 };
      inFlight = 0;
    },
  };
}
