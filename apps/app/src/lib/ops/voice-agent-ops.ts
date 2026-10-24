import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import {
  clearVoiceDriftFlag,
  provisionVoiceAgent,
  verifyVoiceAgent,
  voiceAgentRow,
  voiceAgentStatusView,
  type ProvisionDeps,
  type VoiceAgentReport,
  type VoiceAgentStatusView,
} from "@/lib/voice/provision";

import { audit, clinicById, ok, opsProblem, stringArg, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The ops operations for each clinic's Retell agent and AYA number, set up by
 * code (lib/voice/provision.ts), kept beside the ops API's dispatch rather
 * than in it.
 *
 *   - `voiceAgentStatus`, a read: every clinic's voice set-up as a
 *     hand-written projection of ids, status and times (the clinic's id and
 *     slug, the engine, Retell's agent id, whether a number is held, the
 *     attempts and our own last reason). With `clinicId` and `verify: true`,
 *     also that clinic's read-back report (verifyVoiceAgent): GET requests to
 *     Retell only, never a call placed. Never a caller, a number, a
 *     transcript or a secret.
 *   - `retryVoiceAgent`: one more provisioning run for a clinic whose last
 *     one failed, under every guard a scheduled run has (the owner's switch,
 *     the paid invoice, the daily cap). A security event naming the operator.
 *   - `clearVoiceDriftFlag` (design E3 §2.4): a flagged clinic's flag
 *     cleared and the drift check run once (lib/voice/provision.ts). A step-up
 *     act: the operator's fresh authenticator code is checked on apps/web
 *     before the signed request is sent (apps/web lib/admin/fresh-code.ts, as
 *     for the address change and the device acts), so the code never crosses
 *     and this side never sees it. Never re-creates an agent or a number. A
 *     security event naming the operator, whatever the outcome.
 */

let depsForTests: ProvisionDeps | undefined;

/** Test seam: the fetch, key, clock and environment provisioning uses. Undefined restores them. */
export function __setVoiceAgentDepsForTests(deps: ProvisionDeps | undefined): void {
  depsForTests = deps;
}

export type VoiceAgentStatusRow = VoiceAgentStatusView & { clinicSlug: string };

export async function opVoiceAgentStatus(args: Record<string, unknown>): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (clinicId !== undefined && !UUID_SHAPED.test(clinicId)) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  try {
    const clinics = await listClinics();
    const rows: VoiceAgentStatusRow[] = [];
    for (const clinic of clinics) {
      if (clinicId && clinic.id !== clinicId) continue;
      const row = await voiceAgentRow(clinic.id);
      if (row) rows.push({ ...voiceAgentStatusView(row), clinicSlug: clinic.slug });
    }
    let report: VoiceAgentReport | null = null;
    if (clinicId && args.verify === true) report = await verifyVoiceAgent(clinicId, depsForTests);
    return ok({ agents: rows, report });
  } catch (error) {
    log.error("voice agents not listed", { error: describeError(error) });
    return opsProblem("The voice agents could not be read.", 500, "failed");
  }
}

export async function opRetryVoiceAgent(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId)) return opsProblem("A clinic id is required.", 400, "invalid_args");
  if (!(await clinicById(clinicId))) return ok({ outcome: "not_found" });
  try {
    const result = await provisionVoiceAgent(clinicId, depsForTests);
    await audit(operator, "voice_agent_retry", { clinicId, outcome: result.outcome });
    return ok(result);
  } catch (error) {
    log.error("voice agent retry failed", { clinicId, error: describeError(error) });
    return opsProblem("The voice agent could not be provisioned.", 500, "failed");
  }
}

export async function opClearVoiceDriftFlag(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId)) return opsProblem("A clinic id is required.", 400, "invalid_args");
  if (!(await clinicById(clinicId))) return ok({ outcome: "not_found" });
  try {
    const result = await clearVoiceDriftFlag(clinicId, depsForTests);
    await audit(operator, "voice_drift_flag_cleared", {
      clinicId,
      outcome: result.outcome,
      ...(result.outcome === "cleared" ? { check: result.check } : {}),
      ...("problems" in result && result.problems.length > 0 ? { problems: result.problems } : {}),
    });
    return ok(result);
  } catch (error) {
    log.error("voice drift flag not cleared", { clinicId, error: describeError(error) });
    return opsProblem("The voice drift flag could not be cleared.", 500, "failed");
  }
}
