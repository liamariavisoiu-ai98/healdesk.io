import { JOB_BILLING_RECONCILE, runJob, type JobOutcome } from "@/lib/scheduler/jobs";

/**
 * The hourly billing reconcile (BD1, BD4, R6, R12): the self-healing half of
 * the billing-request ledger. For every billing clinic with a bought package
 * it records whatever request is due but missing (a plan start once a channel
 * is in service, a step-up for an in-service channel the billed package
 * lacks, a waiting channel's step-up after 30 days with its reminder a week
 * before, a setup closure at the deadline), re-arms a request that was
 * skipped or dead-lettered once it can go through, alerts ops on one stuck
 * for a day, and disconnects Stripe Connect a day after a group is canceled.
 * It only records; the billing-requests worker calls Stripe.
 *
 * STUB written by S0 so the tick compiles and the job row has a runner;
 * Package C-actions replaces the body. Until then the job records "Not built
 * yet." when switched on, and "disabled" otherwise, exactly like every other
 * job behind its switch.
 */
export async function runBillingReconcileJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_BILLING_RECONCILE, async () => "Not built yet.", now);
}
