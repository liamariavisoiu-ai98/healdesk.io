import { overdueIncidents } from "@/lib/incidents/incidents";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

import { JOB_INCIDENT_DEADLINES, runJob, type JobOutcome } from "./jobs";

/**
 * A missed incident deadline raises an alert (BAA 1.3.0 release gate 5, the
 * C19 audit's note on it).
 *
 * Every BAA commits healdesk to tell the practice of a breach, a security
 * incident or an improper use or disclosure within 24 hours of discovery,
 * and opening an incident stamps that deadline as `notify_by`
 * (lib/incidents/incidents.ts). Nothing read it back: an incident nobody
 * recorded as notified sat past its deadline in the console, and only someone
 * looking would see it.
 *
 * Hourly from the tick, behind its switch, which the migration seeds on
 * because the job only alerts: every open incident whose `notify_by` has
 * passed with no notice recorded raises one ops alert, ever, naming the
 * clinic and the incident by id and nothing else
 * (`incident_notice_overdue`). The incident's own summary never leaves the
 * database. One clinic's failure is logged and the run goes on to the next.
 */

const ACTOR = { type: "service", serviceName: "incident-deadlines" } as const;

export type IncidentDeadlineSummary = { overdue: number; failures: number };

export async function alertOverdueIncidents(
  now: Date = new Date(),
): Promise<IncidentDeadlineSummary> {
  const summary: IncidentDeadlineSummary = { overdue: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    let overdue: { id: string }[];
    try {
      overdue = await withTenant({ clinicId: clinic.id, actor: ACTOR }, (tx) =>
        overdueIncidents(tx, now),
      );
    } catch (error) {
      summary.failures += 1;
      log.error("overdue incidents could not be read", {
        clinicId: clinic.id,
        error: describeError(error),
      });
      continue;
    }
    for (const incident of overdue) {
      summary.overdue += 1;
      await notifyOpsOnce("incident_notice_overdue", {
        clinicId: clinic.id,
        incidentId: incident.id,
      });
    }
  }
  return summary;
}

export async function runIncidentDeadlinesJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_INCIDENT_DEADLINES,
    async () => {
      const result = await alertOverdueIncidents(now);
      return `${result.overdue} overdue incident(s) alerted, ${result.failures} clinic(s) unread.`;
    },
    now,
  );
}
