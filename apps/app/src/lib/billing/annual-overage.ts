import { JOB_ANNUAL_OVERAGE_INVOICE, runJob, type JobOutcome } from "@/lib/scheduler/jobs";

/**
 * STUB written by work package F0 so the tick compiles and the job row has a
 * runner; the owning package replaces the body. Invoices annual plans' overage once per closed allowance month (package B).
 * Until then the job records "Not built yet." when switched on, and
 * "disabled" otherwise, exactly like every other job behind its switch.
 */
export async function runAnnualOverageJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_ANNUAL_OVERAGE_INVOICE, async () => "Not built yet.", now);
}
