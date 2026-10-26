import { scrypt, timingSafeEqual } from "node:crypto";

import { sendSafely } from "@/lib/email";

import { checkFreshOperatorCode } from "./fresh-code";
import { pastedSetting } from "./pasted";

/**
 * The one approval passcode (lane P7h; owner, 26 October 2026: "one
 * established 6-digit passcode", and "They need to be gated by the same
 * single 6-digit passcode"). Every decision in the approval inbox
 * (lib/admin/approval-decide.ts) and every covered-entity answer
 * (lib/admin/agreement-answer.ts) takes either this passcode or a fresh code
 * from the operator's authenticator. Nothing else does: sign-in, the address
 * change, device recovery, the voice drift fix and the platform attestation
 * still take the authenticator code alone (lib/admin/fresh-code.ts).
 *
 * ## What is stored, and where
 *
 * `HEALDESK_APPROVAL_PASSCODE_HASH`, a Vercel variable: a scrypt hash in the
 * admin password's format, `scrypt$N$r$p$<salt>$<key>`, its parameters read
 * from the string and bounded as operator.ts bounds the password's (the
 * parser below is a copy of that one's rules, not an import, so the many
 * tests that stand in for operator.ts's session do not also stand in for
 * this check). The owner makes
 * it on his own machine with `node apps/web/scripts/hash-approval-passcode.mjs`,
 * which reads the passcode from a hidden prompt and prints the hash. The
 * passcode itself is never stored, logged, sent to apps/app or returned:
 * apps/app is told only which factor was checked (`codeKind`), and records
 * it on the act's security event.
 *
 * ## What this gives up, and what stands in front of it
 *
 * A six-digit secret that never changes is weaker than the authenticator's
 * code, which is spent in ninety seconds: a passcode seen once (over a
 * shoulder, in a screen share) works until it is rotated, and there are only
 * a million of them. What stands in front of a guess:
 *
 *   - the operator session first (password and authenticator at sign-in):
 *     no passcode is tried without one;
 *   - FIVE wrong tries, of either factor, lock approvals for FIFTEEN minutes,
 *     per operator account and across all of them, counted here before any
 *     derivation, the same in-process kind of throttle the sign-in route
 *     keeps (app/api/admin/session/route.ts): no database, no store. So the
 *     real ceiling is five per warm instance per window, and a cold start or
 *     a redeploy resets it; a successful code does not reset a count; and a
 *     lock is logged (`approval_code_locked`) and emailed to the owner;
 *   - one derivation in flight per instance, claimed in the same synchronous
 *     turn as the budget check, so a burst cannot all read an unspent budget;
 *   - scrypt (slow) and a constant-time compare;
 *   - apps/app's own audit row on every decision, naming the factor.
 */

export const APPROVAL_PASSCODE_VARIABLE = "HEALDESK_APPROVAL_PASSCODE_HASH";

/** Wrong tries, of either factor, before approvals lock. */
export const PASSCODE_ATTEMPT_LIMIT = 5;
/** How long approvals stay locked, and the window the wrong tries are counted in. */
export const PASSCODE_LOCK_MS = 15 * 60 * 1000;

const CODE_SHAPE = /^[0-9]{6}$/;

type ScryptHash = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

function base64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  return Buffer.from(value, "base64");
}

/** `scrypt$N$r$p$<base64 salt>$<base64 key>`, bounded (N a power of two, 128*N*r at most 64 MiB), or null. */
export function parsePasscodeHash(raw: string | undefined): ScryptHash | null {
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

export type ApprovalFactor = "passcode" | "authenticator";

export type ApprovalCodeCheck = { ok: true; factor: ApprovalFactor } | { ok: false; message: string };

type Window = { count: number; resetAt: number };

const perAccount = new Map<string, Window>();
let global: Window = { count: 0, resetAt: 0 };
let inFlight = 0;
const MAX_ACCOUNTS = 16;

function locked(window: Window | undefined, now: number): number {
  if (!window || window.resetAt <= now) return 0;
  return window.count >= PASSCODE_ATTEMPT_LIMIT ? window.resetAt - now : 0;
}

function spend(window: Window | undefined, now: number): Window {
  const fresh = !window || window.resetAt <= now ? { count: 0, resetAt: now + PASSCODE_LOCK_MS } : window;
  fresh.count += 1;
  return fresh;
}

function recordFailure(account: string, now: number): void {
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
  if (mine.count === PASSCODE_ATTEMPT_LIMIT) reportLock(account, "account", now);
  else if (global.count === PASSCODE_ATTEMPT_LIMIT) reportLock(account, "global", now);
}

/**
 * A lock is five wrong tries inside fifteen minutes from a signed-in
 * session: somebody guessing, or the owner mistyping. Said twice, as the
 * sign-in route says an attempt (app/api/admin/session/route.ts): one log
 * line, and the owner's own email through apps/web's sender, the same path
 * and address as the sign-in alert (lib/admin/sign-in-alert.ts). Neither
 * carries a code. Never throws, never delays the refusal.
 */
function reportLock(account: string, reason: "account" | "global", now: number): void {
  const at = new Date(now).toISOString();
  console.warn(`[healdesk] approval code ${JSON.stringify({ event: "approval_code_locked", account, reason, at })}`);
  const to = pastedSetting("HEALDESK_ADMIN_EMAIL")?.trim().toLowerCase();
  if (!to) return;
  void sendSafely({
    to,
    subject: `healdesk admin: approvals locked at ${at.replace("T", " ").slice(0, 16)} UTC`,
    text: [
      `Five wrong approval codes (passcode or authenticator) were typed in the console within fifteen minutes${reason === "global" ? ", across accounts" : ""}.`,
      `Approvals are locked on that server for fifteen minutes. Nothing was approved or changed.`,
      ``,
      `Account: ${account}`,
      `Time:    ${at.replace("T", " ").slice(0, 16)} UTC`,
      ``,
      `If that was you, wait fifteen minutes.`,
      ``,
      `If it was not, someone has a console session. Rotate HEALDESK_ADMIN_SECRET in Vercel`,
      `(it ends every session; the redeploy also clears this lock), make a new approval`,
      `passcode with apps/web/scripts/hash-approval-passcode.mjs, and change the admin password.`,
    ].join("\n"),
    tag: "admin-approvals-locked",
  })
    .then((result) => {
      if (result.status !== "sent") console.warn(`[healdesk] approval code ${JSON.stringify({ event: "approval_lock_alert_not_sent", status: result.status })}`);
    })
    .catch(() => {});
}

/** Whether the passcode is set (and well formed) on this deployment: the console says so beside the box. */
export function approvalPasscodeConfigured(): boolean {
  return parsePasscodeHash(pastedSetting(APPROVAL_PASSCODE_VARIABLE)) !== null;
}

async function passcodeMatches(offered: string): Promise<boolean> {
  const stored = parsePasscodeHash(pastedSetting(APPROVAL_PASSCODE_VARIABLE));
  if (!stored) return false;
  try {
    const derived = await derive(offered, stored);
    return derived.length === stored.key.length && timingSafeEqual(derived, stored.key);
  } catch {
    return false;
  }
}

const NOTHING = "Nothing was changed.";

/**
 * Check the code an operator typed for an approval: the passcode, or else a
 * fresh authenticator code. `account` is the signed-in operator (from
 * requireOperator), never a value from the request. Never throws.
 */
export async function checkApprovalCode(code: unknown, account: string, now: number = Date.now()): Promise<ApprovalCodeCheck> {
  const offered = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!CODE_SHAPE.test(offered)) {
    return { ok: false, message: `Enter the 6-digit approval passcode or the code from your authenticator. ${NOTHING}` };
  }
  const wait = Math.max(locked(perAccount.get(account), now), locked(global, now));
  if (wait > 0) {
    return {
      ok: false,
      message: `Too many wrong codes: approvals are locked for ${Math.ceil(wait / 60_000)} more minutes. ${NOTHING}`,
    };
  }
  // One derivation at a time per instance, claimed with the check above, in one synchronous turn.
  if (inFlight > 0) return { ok: false, message: `Another code is being checked. Try again in a moment. ${NOTHING}` };
  inFlight += 1;
  let passcode = false;
  try {
    passcode = await passcodeMatches(offered);
  } finally {
    inFlight -= 1;
  }
  if (passcode) return { ok: true, factor: "passcode" };
  const totp = checkFreshOperatorCode(offered, now);
  if (totp.ok) return { ok: true, factor: "authenticator" };
  if (totp.message.includes("already used")) return { ok: false, message: totp.message };
  recordFailure(account, now);
  const configured = approvalPasscodeConfigured();
  return {
    ok: false,
    message: configured
      ? `That is not the approval passcode or a current authenticator code. ${NOTHING}`
      : `The approval passcode is not set on this deployment, so only a current authenticator code works, and that was not one. ${NOTHING}`,
  };
}

/** A fresh instance: no wrong tries counted. */
export function __resetApprovalPasscodeForTests(): void {
  perAccount.clear();
  global = { count: 0, resetAt: 0 };
  inFlight = 0;
}
