import type Stripe from "stripe";

import { JOB_CARD_EXPIRING, runJob, type JobOutcome } from "@/lib/scheduler/jobs";

/**
 * The daily card-expiry check (BD16, R16), at 07 UTC: for each started
 * billing clinic with a subscription, read the card renewals will use (the
 * customer's default payment method, else the subscription's) and queue
 * `card_expiring` when it expires before a renewal due within 30 days.
 * Stripe is called outside any transaction.
 *
 * STUB written by S0 so the tick compiles and the job row has a runner;
 * Package C-actions replaces the body. Until then the job records "Not built
 * yet." when switched on, and "disabled" otherwise, exactly like every other
 * job behind its switch.
 */
export async function runCardExpiringJob(
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_CARD_EXPIRING, async () => "Not built yet.", now);
}
