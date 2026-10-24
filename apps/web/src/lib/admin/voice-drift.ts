import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import {
  clearVoiceDriftFlag as sendClearVoiceDriftFlag, // raw: only here (ops-client-monitors.test.ts)
  retryVoiceAgent as sendRetryVoiceAgent, // raw: only here
  type ClearVoiceDriftFlagOutcome,
  type OpsResult,
  type RetryVoiceAgentOutcome,
} from "./ops-client";

/**
 * The two voice acts on a clinic's Setup tab that change what Retell holds:
 * clearing its drift flag, and one more provisioning run (which can buy a
 * phone number). Clearing a clinic's voice drift flag from its Setup tab (ops automation
 * Phase 5, lane P5a; design E3 §2.4), entered as the device acts are
 * (lib/admin/device-recovery.ts): an operator session first, so a stranger's
 * POST never gets to try codes against the secret; then a fresh code from
 * the operator's authenticator, checked here on Vercel against the secret
 * sign-in uses (lib/admin/fresh-code.ts); and only then the signed request
 * to apps/app, which clears the flag, runs the drift check once and records
 * a security event naming the operator. A wrong code changes nothing
 * anywhere, and the code never crosses.
 */

const UNAUTHENTICATED = {
  ok: false as const,
  code: "unauthenticated" as const,
  message: "Your session has ended. Sign in again to continue.",
};

export type ClearVoiceDriftFlagEntry = ClearVoiceDriftFlagOutcome | { outcome: "code_refused"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function clearVoiceDriftFlagWithCode(
  clinicId: string,
  code: unknown,
): Promise<OpsResult<ClearVoiceDriftFlagEntry>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!UUID.test(clinicId)) return { ok: true, data: { outcome: "not_found" } };
  const fresh = checkFreshOperatorCode(code);
  if (!fresh.ok) return { ok: true, data: { outcome: "code_refused", message: fresh.message } };
  return sendClearVoiceDriftFlag(clinicId);
}

export type RetryVoiceAgentEntry = RetryVoiceAgentOutcome | { outcome: "code_refused"; message: string };

/**
 * One more provisioning run for the clinic's Retell agent and number, entered
 * the same way: a session, then the operator's fresh code, then the signed
 * request. It can buy a number, so it never goes without the code.
 */
export async function retryVoiceAgentWithCode(
  clinicId: string,
  code: unknown,
): Promise<OpsResult<RetryVoiceAgentEntry>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!UUID.test(clinicId)) return { ok: true, data: { outcome: "not_found" } };
  const fresh = checkFreshOperatorCode(code);
  if (!fresh.ok) return { ok: true, data: { outcome: "code_refused", message: fresh.message } };
  return sendRetryVoiceAgent(clinicId);
}
