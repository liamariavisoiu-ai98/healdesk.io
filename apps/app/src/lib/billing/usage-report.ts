import { JOB_USAGE_METER_REPORT, runJob, type JobOutcome } from "@/lib/scheduler/jobs";

/**
 * STUB written by work package F0 so the tick compiles and the job row has a
 * runner; the owning package replaces the body. Reports unreported overage on monthly plans to Stripe's meters (package B).
 * Until then the job records "Not built yet." when switched on, and
 * "disabled" otherwise, exactly like every other job behind its switch.
 */
export async function runUsageMeterReportJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_USAGE_METER_REPORT, async () => "Not built yet.", now);
}
