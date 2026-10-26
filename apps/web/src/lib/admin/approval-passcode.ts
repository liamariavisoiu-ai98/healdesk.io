import {
  createPasscodeLockout,
  PASSCODE_ATTEMPT_LIMIT,
  PASSCODE_LOCK_MS,
  PASSCODE_SHAPE,
  parsePasscodeHash,
  passcodeMatches,
  type LockReason,
} from "@healdesk/catalog/approval-passcode";

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
 * parser is a copy of that one's rules, not an import, so the many tests
 * that stand in for operator.ts's session do not also stand in for this
 * check). Since lane P7i the parser, the derivation, the compare and the
 * lockout live in @healdesk/catalog/approval-passcode, shared with apps/app,
 * which checks the same passcode in the Slack modal that approves a support
 * reply (the same value pasted into its Parameter Store). The owner makes
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

export { PASSCODE_ATTEMPT_LIMIT, PASSCODE_LOCK_MS, parsePasscodeHash };

export type ApprovalFactor = "passcode" | "authenticator";

export type ApprovalCodeCheck = { ok: true; factor: ApprovalFactor } | { ok: false; message: string };

// This process's count of wrong tries (apps/app keeps its own, for the Slack modal).
const lockout = createPasscodeLockout(reportLock);

/**
 * A lock is five wrong tries inside fifteen minutes from a signed-in
 * session: somebody guessing, or the owner mistyping. Said twice, as the
 * sign-in route says an attempt (app/api/admin/session/route.ts): one log
 * line, and the owner's own email through apps/web's sender, the same path
 * and address as the sign-in alert (lib/admin/sign-in-alert.ts). Neither
 * carries a code. Never throws, never delays the refusal.
 */
function reportLock(account: string, reason: LockReason, now: number): void {
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

const NOTHING = "Nothing was changed.";

/**
 * Check the code an operator typed for an approval: the passcode, or else a
 * fresh authenticator code. `account` is the signed-in operator (from
 * requireOperator), never a value from the request. Never throws.
 */
export async function checkApprovalCode(code: unknown, account: string, now: number = Date.now()): Promise<ApprovalCodeCheck> {
  const offered = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!PASSCODE_SHAPE.test(offered)) {
    return { ok: false, message: `Enter the 6-digit approval passcode or the code from your authenticator. ${NOTHING}` };
  }
  const wait = lockout.lockedFor(account, now);
  if (wait > 0) {
    return {
      ok: false,
      message: `Too many wrong codes: approvals are locked for ${Math.ceil(wait / 60_000)} more minutes. ${NOTHING}`,
    };
  }
  // One derivation at a time per instance, claimed with the check above, in one synchronous turn.
  if (!lockout.claim()) return { ok: false, message: `Another code is being checked. Try again in a moment. ${NOTHING}` };
  let passcode = false;
  try {
    passcode = await passcodeMatches(offered, pastedSetting(APPROVAL_PASSCODE_VARIABLE));
  } finally {
    lockout.release();
  }
  if (passcode) return { ok: true, factor: "passcode" };
  const totp = checkFreshOperatorCode(offered, now);
  if (totp.ok) return { ok: true, factor: "authenticator" };
  if (totp.message.includes("already used")) return { ok: false, message: totp.message };
  lockout.recordFailure(account, now);
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
  lockout.reset();
}
