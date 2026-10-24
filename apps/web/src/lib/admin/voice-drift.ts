import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import { clearVoiceDriftFlag as sendClearVoiceDriftFlag, type ClearVoiceDriftFlagOutcome, type OpsResult } from "./ops-client";

/**
 * Clearing a clinic's voice drift flag from its Setup tab (ops automation
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

export async function clearVoiceDriftFlag(
  clinicId: string,
  code: unknown,
): Promise<OpsResult<ClearVoiceDriftFlagEntry>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!UUID.test(clinicId)) return { ok: true, data: { outcome: "not_found" } };
  const fresh = checkFreshOperatorCode(code);
  if (!fresh.ok) return { ok: true, data: { outcome: "code_refused", message: fresh.message } };
  return sendClearVoiceDriftFlag(clinicId);
}
