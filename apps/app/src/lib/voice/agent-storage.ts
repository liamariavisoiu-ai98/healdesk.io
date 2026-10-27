import { describeError, log } from "@/lib/log";
import { notifyOpsOnce, type OpsFields } from "@/lib/ops/notify";

import { retellApiKey } from "./retell-api";
import { getRetellAgent, retellStorageProblem, type RetellStorageProblem } from "./retell-agent";

/**
 * The agent's storage, checked on every call, whoever made the agent.
 *
 * The no-audio promise (LAUNCH_PROMISES `no-audio`) rests on two settings of
 * the clinic's Retell agent: `data_storage_retention_days` 1, Retell's own
 * deletion a day after a call of anything ours did not delete, and
 * `data_storage_setting` `everything`, which keeps the transcript the crash
 * backstop reads (./retell-agent.ts). The code that writes an agent sets
 * both, and the nightly read-back checks them (./provision.ts readBack,
 * problem `storage`), but only for an agent provisioning made: a voice_agents
 * row with its id. Provisioning is off, and today's agents are made by hand
 * in Retell's console, so nothing read their storage back.
 *
 * Each call carries its agent's id and version (Retell's get-call:
 * `agent_id`, `agent_version`), and every call's webhook queues the backstop
 * job for the clinic its path names (./backstop.ts), whose agent that
 * therefore is. So the job, before it deletes the call at Retell, reads that
 * agent at that version (GET /get-agent/<id>?version=<n>, read-only: nothing
 * here writes to Retell) and, when either setting is not ours, raises
 * `voice_agent_storage` once per clinic, problem and UTC day
 * (notifyOpsOnce, so the many calls of a day are one alert). The alert
 * carries the clinic's id, the problem (`status`: retention or setting) and
 * the day; never the agent's id, a number or anything of the call.
 *
 * It never throws and never holds up the delete: a check that cannot be
 * made (no key, no agent id on the call, Retell not answering) is logged
 * and the call is deleted all the same.
 */

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type AgentStorageOutcome =
  /** The agent holds a one-day retention and `everything`. */
  | { status: "ok" }
  /** It does not: the alert was raised (or was already raised today). */
  | { status: "alerted"; problem: RetellStorageProblem }
  /** Nothing could be checked; our own words for why. */
  | { status: "unchecked"; reason: string };

export type AgentStorageDeps = {
  apiKey?: string | null;
  fetch?: typeof fetch;
  now?: Date;
  /** Defaults to notifyOpsOnce. */
  notify?: (event: "voice_agent_storage", fields: OpsFields) => Promise<void>;
};

/** The fields of Retell's call object this reads. */
export type CallAgentRef = { agent_id?: unknown; agent_version?: unknown };

/** Check the agent a call ran on. Never throws. */
export async function checkCallAgentStorage(
  clinicId: string,
  call: CallAgentRef,
  deps: AgentStorageDeps = {},
): Promise<AgentStorageOutcome> {
  try {
    const agentId = call.agent_id;
    if (typeof agentId !== "string" || !AGENT_ID.test(agentId))
      return unchecked(clinicId, "the call names no agent");
    const key = deps.apiKey === undefined ? retellApiKey() : deps.apiKey;
    if (!key) return unchecked(clinicId, "HEALDESK_RETELL_API_KEY is not set");
    const version =
      typeof call.agent_version === "number" &&
      Number.isInteger(call.agent_version) &&
      call.agent_version >= 0
        ? call.agent_version
        : undefined;
    const agent = await getRetellAgent(
      agentId,
      { key, fetch: deps.fetch, timeoutMs: 10_000 },
      version,
    );
    if (!agent) return unchecked(clinicId, "Retell has no such agent");
    const problem = retellStorageProblem(agent);
    if (problem === null) return { status: "ok" };
    const day = (deps.now ?? new Date()).toISOString().slice(0, 10);
    await (deps.notify ?? notifyOpsOnce)("voice_agent_storage", {
      clinicId,
      status: problem,
      windowStart: day,
    });
    log.warn("retell agent storage is not ours", { clinicId, status: problem });
    return { status: "alerted", problem };
  } catch (error) {
    return unchecked(clinicId, describeError(error));
  }
}

function unchecked(clinicId: string, reason: string): AgentStorageOutcome {
  log.warn("retell agent storage not checked", { clinicId, code: reason.slice(0, 120) });
  return { status: "unchecked", reason };
}
