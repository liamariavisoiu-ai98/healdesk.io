import type { OpsResult } from "@/lib/admin/ops-client";

import type { HostMode, HostRun } from "./github";

/**
 * What /admin/host says about the AWS host: Active, Standby or Switching, from
 * host.yml's runs, with what the host's own address answers beside it.
 *
 * The runs are the record of what was asked and whether it finished; the
 * address is the check that it is so. They are kept apart on the page rather
 * than merged into one guess, because each can be wrong alone: a host turned
 * on by hand before host.yml existed has no run, and a host can stop
 * answering (an outage, a deploy) while its last switch says active.
 */

export type Liveness =
  /** /api/health?probe=liveness answered 200 with {"ok":true}. */
  | "answers"
  /**
   * Something answered at the address, but not the probe. On AWS this is the
   * load balancer: HEALDESK_APP_URL is the internal host, which serves only
   * the signed routes and answers 404 to everything else (infra/aws/alb.tf),
   * so the host is up as far as this app can see without signing a call.
   */
  | "edge"
  /** No answer within the timeout, or no address at all: standby removes the DNS records. */
  | "unreachable"
  /** HEALDESK_APP_URL is not set on this deployment. */
  | "unconfigured";

export const LIVENESS_TIMEOUT_MS = 3_000;

/** One GET of the liveness probe at HEALDESK_APP_URL, three seconds at most. */
export async function probeLiveness(fetchImpl: typeof fetch = fetch): Promise<Liveness> {
  const target = process.env.HEALDESK_APP_URL;
  if (!target) return "unconfigured";
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/health?probe=liveness", target), {
      cache: "no-store",
      signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
    });
  } catch {
    return "unreachable";
  }
  if (response.status === 200) {
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (body?.ok === true) return "answers";
  } else {
    void response.body?.cancel().catch(() => undefined);
  }
  return "edge";
}

export type HostStateName = "active" | "standby" | "switching" | "unsettled" | "unknown";

export type HostState = {
  state: HostStateName;
  /** The mode the newest switch asked for, when there is one. */
  mode: HostMode | null;
  /** The run the state is read from. */
  run: HostRun | null;
  /** One sentence about how the two sources agree. */
  note: string;
};

const RUNNING: ReadonlySet<HostRun["status"]> = new Set(["queued", "in_progress", "other"]);

/**
 * The state, from the runs (newest first) and the probe.
 *
 *   switching  a host.yml run has not finished;
 *   active / standby  the newest finished run with a mode succeeded;
 *   unsettled  it failed or was cancelled: half-way, possibly, and the page
 *              says which way it was going;
 *   unknown    no run names a mode: read from the probe alone.
 */
export function hostState(runs: readonly HostRun[], liveness: Liveness): HostState {
  const switches = runs.filter((run) => run.mode !== null);
  const going = switches.find((run) => RUNNING.has(run.status));
  if (going) {
    return {
      state: "switching",
      mode: going.mode,
      run: going,
      note: going.mode === "standby" ? "Going into standby: the database is snapshotted and removed, then the rest." : "Turning on: apply, set up the database, deploy, then subscribe SES's events.",
    };
  }

  const last = switches[0];
  if (!last) {
    return {
      state: "unknown",
      mode: null,
      run: null,
      note:
        liveness === "answers" || liveness === "edge"
          ? "No switch has been made from here, and the host answers at its address."
          : "No switch has been made from here, and nothing answers at the host's address.",
    };
  }

  if (last.conclusion !== "success") {
    return {
      state: "unsettled",
      mode: last.mode,
      run: last,
      note: `The last switch, to ${last.mode}, ended ${last.conclusion ?? "without a result"}: the host may be half-way. Run it again (each step is safe to repeat), or read the run first.`,
    };
  }

  const reachable = liveness === "answers" || liveness === "edge";
  if (last.mode === "active") {
    return {
      state: "active",
      mode: "active",
      run: last,
      note: reachable ? "The host is on and answers." : "The last switch turned the host on, but nothing answers at its address now: read its alarms.",
    };
  }
  return {
    state: "standby",
    mode: "standby",
    run: last,
    note: reachable ? "The last switch put the host in standby, yet something answers at its address: read the last run." : "The host is in standby: nothing runs, and nothing answers at its address.",
  };
}

/**
 * Whether an ops call failed because the host is not there, which in standby
 * is the expected answer and gets the standby notice rather than an error.
 * Unreachable or timed out only: a refusal or a 5xx came from a host that is
 * up.
 */
export function isHostUnreachable(result: OpsResult<unknown>): boolean {
  return !result.ok && (result.code === "unreachable" || result.code === "timeout");
}
