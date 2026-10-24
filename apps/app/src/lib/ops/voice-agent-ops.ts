import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import {
  clearVoiceDriftFlag,
  applyCallSettingsToDemoAgent,
  provisionVoiceAgent,
  verifyVoiceAgent,
  voiceAgentRow,
  voiceAgentStatusView,
  type DemoAgentOutcome,
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
 *   - `syncDemoVoiceAgent`: the demo clinic's hand-made Retell agent, named
 *     by its id, rewritten with AYA's call settings, language and keywords
 *     (applyCallSettingsToDemoAgent), its voice left alone. Refused for any
 *     other clinic. Returns what Retell kept as booleans, never the
 *     agent's socket address, which carries the line's secret.
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
      // Case-insensitive: a uuid in capitals is the same clinic.
      if (clinicId && clinic.id.toLowerCase() !== clinicId.toLowerCase()) continue;
      const row = await voiceAgentRow(clinic.id);
      if (row) rows.push({ ...voiceAgentStatusView(row), clinicSlug: clinic.slug });
    }
    let report: VoiceAgentReport | null = null;
    if (clinicId && args.verify === true) report = await verifyVoiceAgent(clinicId.toLowerCase(), depsForTests);
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
  // The security event is written whatever happens next (not found, a throw
  // included): the operator asked, with a fresh code, and that is recorded.
  let event: Record<string, unknown> = { clinicId, outcome: "error" };
  try {
    if (!(await clinicById(clinicId))) {
      event = { clinicId, outcome: "not_found" };
      return ok({ outcome: "not_found" });
    }
    const result = await clearVoiceDriftFlag(clinicId, depsForTests);
    event = {
      clinicId,
      outcome: result.outcome,
      ...(result.outcome === "cleared" ? { check: result.check } : {}),
      ...("problems" in result && result.problems.length > 0 ? { problems: result.problems } : {}),
    };
    return ok(result);
  } catch (error) {
    log.error("voice drift flag not cleared", { clinicId, error: describeError(error) });
    return opsProblem("The voice drift flag could not be cleared.", 500, "failed");
  } finally {
    await audit(operator, "voice_drift_flag_cleared", event);
  }
}

const RETELL_AGENT_ID = /^agent_[A-Za-z0-9]{6,64}$/;

/** What the console prints for each outcome: a sentence, never Retell's own body. */
const DEMO_AGENT_MESSAGES: Readonly<Record<DemoAgentOutcome["outcome"], string>> = {
  applied: "The demo agent now has AYA's call settings, language and keywords. Its voice is unchanged.",
  not_demo: "Only the demo clinic's agent is set from here; a real clinic's agent is set up and synced by provisioning.",
  no_key: "HEALDESK_RETELL_API_KEY is not set on the AWS host, so nothing was sent to Retell.",
  not_found: "Retell has no agent with that id under healdesk's key: the agent may be in another Retell workspace.",
  failed: "Retell did not take the settings. Nothing else changed; try again, or set them on Retell's dashboard.",
};

export async function opSyncDemoVoiceAgent(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId)) return opsProblem("A clinic id is required.", 400, "invalid_args");
  const agentId = stringArg(args, "agentId", 80)?.trim();
  if (!agentId || !RETELL_AGENT_ID.test(agentId)) {
    return opsProblem("A Retell agent id looks like agent_ followed by letters and digits.", 400, "invalid_args");
  }
  if (!(await clinicById(clinicId))) return ok({ outcome: "not_found" });
  try {
    const result = await applyCallSettingsToDemoAgent(clinicId, agentId, depsForTests);
    await audit(operator, "voice_demo_agent_synced", { clinicId, outcome: result.outcome });
    return ok({ ...result, message: DEMO_AGENT_MESSAGES[result.outcome] });
  } catch (error) {
    log.error("demo voice agent sync failed", { clinicId, error: describeError(error) });
    return opsProblem("The demo agent could not be updated.", 500, "failed");
  }
}
