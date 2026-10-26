import { describeError, log } from "@/lib/log";

import { findIncidentSubjects, INCIDENT_KINDS, incidentItemResolution } from "./incident-kinds";
import { remind } from "./proposers";
import { moveStatus, propose, SERVICE_ACTOR, sweepInterrupted, waitingItems } from "./store";

/**
 * The incident assistant's hourly sweep (lane P6i; owner decision D18), the
 * independent safety net for a legal clock. It runs from the hourly
 * incident-deadlines job, which the migrations seed ON because it only tells
 * ops, and from approvals-propose (seeded OFF) as well, so the owner's list
 * and the alerts never depend on the billing proposer's switch. Running it
 * twice in an hour does nothing twice: a proposal is unique per subject, and
 * a reminder is keyed on the items and their reminder counts.
 *
 *   1. Propose the first report of each open reportable incident that has
 *      none yet, has never had one proposed and whose practice has no notice
 *      recorded (./incident-kinds.ts findIncidentSubjects); also a fresh one,
 *      once per interruption, for a report whose newest item was marked
 *      failed / `interrupted` (step 3 does that marking, so the fresh item
 *      comes at the next pass, within the hour).
 *   2. Take off the list, unrun, a report item the Incidents page has
 *      overtaken (`no_longer_needed`) or whose clinic has gone or is the demo
 *      clinic (`clinic_out_of_service`).
 *   3. Record as failed (`interrupted`) an incident item left `approved` by a
 *      process that died more than 15 minutes ago, so its report can be
 *      proposed again, even while approvals-propose is switched off (that
 *      job sweeps every kind; this one only its own, so the billing and
 *      clinic-contact kinds still wait on approvals-propose).
 *   4. Alert ops, by email and Slack (incident_step_waiting): for an item on
 *      its first sweep after it arrived, and again at the first sweep at
 *      least 4 hours after its last alert, so at most every 4 hours and at
 *      most an hour late, while it waits.
 *
 * It sends, opens, marks and closes nothing. It never throws: a failure is
 * logged and counted, so the job that calls it carries on with its own work.
 */

const ACTOR = { type: "service", serviceName: "incident-assistant" } as const;

export type IncidentSweepSummary = {
  proposed: number;
  resolved: number;
  outOfService: number;
  reminded: number;
  /** Incident items left `approved` by a dead process, now failed / interrupted. */
  interrupted: number;
  unread: number;
};

export async function runIncidentSweep(now: Date = new Date()): Promise<IncidentSweepSummary> {
  const summary: IncidentSweepSummary = { proposed: 0, resolved: 0, outOfService: 0, reminded: 0, interrupted: 0, unread: 0 };
  try {
    const found = await findIncidentSubjects(now, { actor: ACTOR });
    summary.unread += found.unread;
    for (const proposal of found.proposals) {
      if (await propose(proposal, now)) summary.proposed += 1;
    }
    for (const item of await waitingItems()) {
      if (!INCIDENT_KINDS.has(item.kind)) continue;
      const code = incidentItemResolution(item, found);
      if (!code) continue;
      if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: code })) {
        if (code === "clinic_out_of_service") summary.outOfService += 1;
        else summary.resolved += 1;
      }
    }
    summary.interrupted = await sweepInterrupted(now, (kind) => INCIDENT_KINDS.has(kind));
    summary.reminded = await remind(now, (kind) => INCIDENT_KINDS.has(kind));
  } catch (error) {
    summary.unread += 1;
    log.error("incident sweep failed", { error: describeError(error) });
  }
  return summary;
}
