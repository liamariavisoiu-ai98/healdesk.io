import { createPasscodeLockout, PASSCODE_ATTEMPT_LIMIT, PASSCODE_SHAPE, parsePasscodeHash, passcodeMatches } from "@healdesk/catalog/approval-passcode";

import { log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";

/**
 * The approval passcode, checked in the Slack modal that approves a support
 * reply (lane P7i; owner, 26 October 2026: approve "there with the
 * passcode"). The same verifier and the same lockout rules as the console's
 * (apps/web lib/admin/approval-passcode.ts): both import
 * @healdesk/catalog/approval-passcode. The hash is the same value, pasted
 * here as the Parameter Store parameter HEALDESK_APPROVAL_PASSCODE_HASH;
 * unset, nothing approves from Slack (there is no authenticator fallback
 * here, since the authenticator's secret lives on Vercel alone).
 *
 * The lockout is this process's: five wrong passcodes inside fifteen
 * minutes, per Slack user and across all of them, lock approvals from
 * Slack on this task for fifteen minutes. A lock is logged with the Slack
 * user id only. The passcode is never logged, stored or echoed.
 */

export const APPROVAL_PASSCODE_VARIABLE = "HEALDESK_APPROVAL_PASSCODE_HASH";

const lockout = createPasscodeLockout((account, reason, now) => {
  log.warn("approval passcode locked in Slack", { event: "approval_code_locked", slackUser: account.replace(/^slack:/, ""), reason, windowStart: new Date(now).toISOString() });
  // The owner hears it as the console's lock tells him (apps/web reportLock emails him): an ops
  // alert, emailed and posted. The count only, never the member id or the passcode. Never throws.
  void notifyOps("slack_approvals_locked", { count: PASSCODE_ATTEMPT_LIMIT });
});

function storedHash(): string | null {
  const raw = process.env[APPROVAL_PASSCODE_VARIABLE]?.trim();
  return raw && raw !== "__unset__" ? raw : null;
}

/** Whether a passcode is set (and well formed) on this host. */
export function slackPasscodeConfigured(): boolean {
  return parsePasscodeHash(storedHash()) !== null;
}

export type SlackPasscodeCheck = { ok: true } | { ok: false; message: string };

/**
 * Check a passcode typed in the Slack modal by `slackUserId` (from Slack's
 * signed payload, never a typed value). The messages are the modal's
 * validation errors: no detail beyond "locked, try later". Never throws.
 */
export async function checkSlackPasscode(code: unknown, slackUserId: string, now: number = Date.now()): Promise<SlackPasscodeCheck> {
  if (!slackPasscodeConfigured()) {
    return { ok: false, message: "The approval passcode is not set on the host, so nothing can be approved from Slack. Use the console." };
  }
  const offered = typeof code === "string" ? code.replace(/\s/g, "") : "";
  if (!PASSCODE_SHAPE.test(offered)) return { ok: false, message: "Enter the 6-digit approval passcode." };
  const account = `slack:${slackUserId}`;
  if (lockout.lockedFor(account, now) > 0) return { ok: false, message: "Too many wrong passcodes: approvals are locked. Try later." };
  if (!lockout.claim()) return { ok: false, message: "Another passcode is being checked. Try again in a moment." };
  let matches = false;
  try {
    matches = await passcodeMatches(offered, storedHash());
  } finally {
    lockout.release();
  }
  if (matches) return { ok: true };
  lockout.recordFailure(account, now);
  return { ok: false, message: "That is not the approval passcode. Nothing was changed." };
}

/** A fresh process: no wrong tries counted. */
export function __resetSlackPasscodeForTests(): void {
  lockout.reset();
}
