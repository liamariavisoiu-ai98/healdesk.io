import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import {
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
