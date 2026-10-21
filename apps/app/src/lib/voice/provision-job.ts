import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { enqueue, QUEUE_VOICE_PROVISION } from "@/lib/queue/boss";

import { retellApiKey } from "./retell-api";
import {
  checkVoiceAgentDrift,
  deprovisionVoiceAgent,
  provisionVoiceAgent,
  syncVoiceAgent,
  voiceAgentRow,
  voiceProvisionEnabled,
  type ProvisionDeps,
} from "./provision";

/**
 * The jobs around lib/voice/provision.ts.
 *
 * `voice-provision` (pg-boss): one job per clinic at a time (singletonKey),
 * each a provisionVoiceAgent run. A run Retell did not answer throws, and
 * pg-boss retries it with a doubling delay; any other outcome completes the
 * job, its state on the clinic's voice_agents row. Every run is idempotent,
 * so a retry, a duplicate or the hourly sweep's next send does no harm.
 *
 * The hourly sweep (runVoiceAgentsSweep, from the tick): queues provisioning
 * for each clinic owed it while the owner's switch is on; writes changed
 * configuration to Retell by hash; at 03 UTC reads every ready clinic back
 * for drift; and releases the number and agent of each clinic whose service
 * and pass-through have ended. Without HEALDESK_RETELL_API_KEY it does
 * nothing at all.
 */

export const VOICE_PROVISION_RETRY_LIMIT = 6;
export const VOICE_PROVISION_RETRY_DELAY_SECONDS = 60;
/** The UTC hour the drift check runs. */
export const DRIFT_HOUR_UTC = 3;

export type VoiceProvisionPayload = { clinicId: string };

export async function handleVoiceProvisionJob(payload: VoiceProvisionPayload, deps: ProvisionDeps = {}): Promise<void> {
  const result = await provisionVoiceAgent(payload.clinicId, deps);
  if (result.outcome === "retry") throw new Error(`voice provisioning will retry: ${result.reason}`);
}

/** Queue one clinic's provisioning; a duplicate of one already waiting is declined by pg-boss. */
export async function scheduleVoiceProvision(clinicId: string, send: typeof enqueue = enqueue): Promise<void> {
  await send(QUEUE_VOICE_PROVISION, { clinicId }, {
    singletonKey: clinicId,
    retryLimit: VOICE_PROVISION_RETRY_LIMIT,
    retryDelay: VOICE_PROVISION_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  });
}

export type VoiceSweepSummary = {
  status: "ok" | "failed" | "skipped";
  note: string;
  queued: number;
  synced: number;
  repaired: number;
  flagged: number;
  released: number;
  failures: number;
};

export async function runVoiceAgentsSweep(
  options: {
    now?: Date;
    deps?: ProvisionDeps;
    schedule?: (clinicId: string) => Promise<void>;
    list?: () => Promise<{ id: string; offboardingStartedAt: Date | null; destroyedAt: Date | null }[]>;
  } = {},
): Promise<VoiceSweepSummary> {
  const now = options.now ?? new Date();
  const deps: ProvisionDeps = { now: () => now, ...options.deps };
  const env = deps.env ?? process.env;
  const summary: VoiceSweepSummary = { status: "ok", note: "", queued: 0, synced: 0, repaired: 0, flagged: 0, released: 0, failures: 0 };
  const key = deps.key === undefined ? retellApiKey() : deps.key;
  if (!key) return { ...summary, status: "skipped", note: "HEALDESK_RETELL_API_KEY unset" };
  const schedule = options.schedule ?? ((clinicId: string) => scheduleVoiceProvision(clinicId));
  const switchedOn = voiceProvisionEnabled(env);
  const nightly = now.getUTCHours() === DRIFT_HOUR_UTC;

  for (const clinic of await (options.list ?? listClinics)()) {
    try {
      const row = await voiceAgentRow(clinic.id);
      if (clinic.offboardingStartedAt) {
        if (row && row.status !== "released") {
          const r = await deprovisionVoiceAgent(clinic.id, deps);
          if (r.outcome === "released") summary.released += 1;
          if (r.outcome === "failed") summary.failures += 1;
        }
        continue;
      }
      if (clinic.destroyedAt) continue;
      if (row?.status === "ready") {
        const s = await syncVoiceAgent(clinic.id, deps);
        if (s.outcome === "synced") summary.synced += 1;
        if (s.outcome === "failed") summary.failures += 1;
        if (nightly) {
          const d = await checkVoiceAgentDrift(clinic.id, deps);
          if (d.outcome === "repaired") summary.repaired += 1;
          if (d.outcome === "flagged") summary.flagged += 1;
          if (d.outcome === "failed") summary.failures += 1;
        }
        continue;
      }
      // Owed and not failed: a failed run waits for a person (retryVoiceAgent).
      if (switchedOn && (!row || row.status === "pending" || row.status === "provisioning")) {
        await schedule(clinic.id);
        summary.queued += 1;
      }
    } catch (error) {
      summary.failures += 1;
      log.error("voice agent sweep failed for a clinic", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  summary.status = summary.failures ? "failed" : "ok";
  summary.note = `${summary.queued} queued, ${summary.synced} synced, ${summary.repaired} repaired, ${summary.flagged} flagged, ${summary.released} released${summary.failures ? `, ${summary.failures} failed` : ""}`;
  return summary;
}
