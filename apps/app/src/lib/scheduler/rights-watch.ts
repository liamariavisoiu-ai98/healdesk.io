import { describeError, log } from "@/lib/log";
import { notifyOpsOnce, type OpsEvent } from "@/lib/ops/notify";
import { clockState, utcDay } from "@/lib/rights/clocks";
import { collectRights, type RightsRow } from "@/lib/rights/tracker";
import { runJob, type JobOutcome } from "@/lib/scheduler/jobs";

/**
 * The patient-rights tracker's daily watch (ops automation lane P6c; design
 * E6 item 16; owner decision D19), behind the `rights-watch` switch, seeded
 * OFF by drizzle/0120. It tells ops, once per request and state, through
 * notifyOpsOnce; it sends nothing to a clinic or a patient and runs nothing.
 *
 *   - rights_request_blocked: the request has no route on the host (no
 *     contact id, D19). Raised once per request; its clock keeps running,
 *     so it is still told when it falls due;
 *   - rights_request_due_soon: two business days or fewer left;
 *   - rights_request_overdue: past its due day.
 *
 * Not the requests a patient made that are already recorded on the host
 * (patient_requests, and an intake naming one): the hourly L32 sweep
 * (lib/patient-rights/patient-requests.ts) already raises
 * patient_request_due_soon and patient_request_past_due for each, with
 * steps about the practice's mark, and two alerts for one request would be
 * noise. Those events cannot carry the others: their steps are a telephone
 * call asking the practice to mark the request received, while an erasure,
 * an amendment or an export is work healdesk itself owes.
 *
 * Demo clinics are left out, as the list leaves them out unless asked.
 */

export const JOB_RIGHTS_WATCH = "rights-watch";

const ACTOR = { type: "service", serviceName: "rights-watch" } as const;

export type RightsWatchResult = {
  open: number;
  blocked: number;
  dueSoon: number;
  overdue: number;
  /** Requests the L32 sweep already watches. */
  leftToL32: number;
  unreadClinics: number;
};

/** Whether the L32 sweep watches this row already. */
function watchedByL32(row: RightsRow): boolean {
  return row.kind === "patient_request" && (row.source === "patient_request" || row.recordId !== null);
}

/** The alerts a row is owed today, in the order they are raised. Pure. */
export function rightsAlertsFor(row: RightsRow, today: string): OpsEvent[] {
  if (row.state === "done" || watchedByL32(row)) return [];
  const out: OpsEvent[] = [];
  if (row.state === "blocked") out.push("rights_request_blocked");
  const clock = clockState(today, row.dueOn);
  if (clock === "due_soon") out.push("rights_request_due_soon");
  if (clock === "overdue") out.push("rights_request_overdue");
  return out;
}

export async function watchRights(now: Date = new Date()): Promise<RightsWatchResult> {
  // No operator: the watch raises alerts, and an alert carries no command.
  const { rows, unreadClinics } = await collectRights({ actor: ACTOR, operator: "", filter: "open", now });
  const today = utcDay(now);
  const result: RightsWatchResult = { open: rows.length, blocked: 0, dueSoon: 0, overdue: 0, leftToL32: 0, unreadClinics };
  for (const row of rows) {
    if (watchedByL32(row)) {
      result.leftToL32 += 1;
      continue;
    }
    for (const event of rightsAlertsFor(row, today)) {
      try {
        await notifyOpsOnce(event, { clinicId: row.clinicId, requestId: row.id });
      } catch (error) {
        // notifyOpsOnce never throws; this is belt and braces for a test double.
        log.error("rights watch: alert not raised", { clinicId: row.clinicId, error: describeError(error) });
      }
      if (event === "rights_request_blocked") result.blocked += 1;
      else if (event === "rights_request_due_soon") result.dueSoon += 1;
      else result.overdue += 1;
    }
  }
  return result;
}

/** The daily job, behind the `rights-watch` switch. */
export async function runRightsWatchJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_RIGHTS_WATCH,
    async () => {
      const r = await watchRights(now);
      const note =
        `${r.open} open, ${r.blocked} blocked, ${r.dueSoon} due within two business days, ${r.overdue} past their day, ` +
        `${r.leftToL32} watched by the patient-request sweep, ${r.unreadClinics} clinics unread.`;
      if (r.unreadClinics > 0 && r.open === 0) throw new Error(note);
      return note;
    },
    now,
  );
}
