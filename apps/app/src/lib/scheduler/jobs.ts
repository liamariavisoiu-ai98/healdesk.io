import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { env } from "@/lib/env";

/**
 * Background job control.
 *
 * Every job is **off by default** and must be switched on from the ops console.
 * That is deliberate: a monthly report job that starts the moment it deploys
 * would mail whatever half-configured clinics happen to exist, and "we'll
 * remember to turn it off" is not a control.
 *
 * The runner records what happened on every attempt, including the boring
 * outcomes — disabled, nothing to do, already running. A job that has been
 * quietly failing for three weeks should be visible as a stale timestamp rather
 * than as silence.
 */

export const JOB_MONTHLY_REPORT = "monthly-report";
/** See billing-sweep.ts. Seeded by drizzle/0030, switched off. */
export const JOB_BILLING_SWEEP = "billing-sweep";
export const JOB_RETENTION_PURGE = "retention-purge";
export const JOB_HEARTBEAT = "heartbeat";
export const JOB_CONNECTION_HEALTH = "connection-health";
export const JOB_ANNUAL_RENEWAL_REMINDER = "annual-renewal-reminder";
export const JOB_WEEKLY_RECAP = "weekly-recap";
export const JOB_NIGHTLY_SYNC = "nightly-sync";
export const JOB_OFFBOARDING_DESTROY = "offboarding-destroy";
/**
 * The Stripe launch's billing jobs (drizzle/0043), seeded off. Hourly:
 * reporting overage on monthly plans to Stripe's meters and queueing the 80%
 * and 100% allowance emails. Daily: invoicing annual plans' overage per closed
 * month (05 UTC) and the housekeeping purge (06 UTC). Wired in tick.ts.
 *
 * `billing-notices` is no longer hourly: the email platform's sender runs it
 * every minute from the `notices` queue (lib/email/outbox.ts), and its row is
 * the sender's on/off switch.
 */
export const JOB_USAGE_METER_REPORT = "usage-meter-report";
export const JOB_ANNUAL_OVERAGE_INVOICE = "annual-overage-invoice";
export const JOB_USAGE_ALERTS = "usage-alerts";
export const JOB_BILLING_NOTICES = "billing-notices";
export const JOB_BILLING_HOUSEKEEPING = "billing-housekeeping";
/**
 * The Stripe build's jobs (drizzle/0047), seeded off.
 *
 * `billing-requests` carries out the billing-request ledger on Stripe: every
 * minute from the `billing-minute` queue, and hourly from the tick as a
 * backstop, behind its switch but without runJob's lock (runSwitchedJob),
 * because each request is leased on its own row. `billing-reconcile` runs
 * hourly and records whatever request is due but missing. `card-expiring`
 * runs daily at 07 UTC. `setup-closure` is a switch, not a schedule: while it
 * is off the worker leaves `close_setup` requests pending, because closing an
 * account cannot be undone. Wired in tick.ts.
 */
export const JOB_BILLING_REQUESTS = "billing-requests";
export const JOB_SETUP_CLOSURE = "setup-closure";
export const JOB_BILLING_RECONCILE = "billing-reconcile";
export const JOB_CARD_EXPIRING = "card-expiring";
/**
 * Phase two: the attribution jobs. Their code is kept, but they never run in
 * v1 (env.phaseTwoAttribution()), and the console refuses to switch them on.
 * The 0040 `callback-dialer` job was removed by drizzle/0041.
 */
export const PHASE_TWO_JOBS: ReadonlySet<string> = new Set([JOB_MONTHLY_REPORT, JOB_NIGHTLY_SYNC]);

/** How long before a `runningSince` lock is assumed to be a crashed run. */
const STALE_LOCK_MS = 60 * 60 * 1000;

/**
 * Derived from the schema rather than hand-written, so adding a column can't
 * leave this type quietly out of date.
 */
export type JobRecord = typeof scheduledJobs.$inferSelect;

export type JobOutcome =
  | { status: "disabled" }
  | { status: "already-running"; since: Date }
  | { status: "ok"; note: string }
  | { status: "failed"; note: string };

export async function listJobs(): Promise<JobRecord[]> {
  return unsafeDb.select().from(scheduledJobs).orderBy(scheduledJobs.name);
}

export async function getJob(name: string): Promise<JobRecord | undefined> {
  const [job] = await unsafeDb
    .select()
    .from(scheduledJobs)
    .where(eq(scheduledJobs.name, name))
    .limit(1);
  return job;
}

/**
 * Turn a job on or off. Records who did it — this is an ops action on a system
 * that mails customers, so "who enabled this" needs an answer.
 */
export async function setJobEnabled(
  name: string,
  enabled: boolean,
  userId: string,
): Promise<void> {
  await unsafeDb
    .update(scheduledJobs)
    .set({ enabled, updatedBy: userId, updatedAt: new Date() })
    .where(eq(scheduledJobs.name, name));
}

/**
 * Run a job, if it is enabled and not already running.
 *
 * The lock is a `runningSince` timestamp rather than a boolean so a crashed run
 * can be distinguished from a live one and reclaimed after STALE_LOCK_MS.
 * A boolean flag left set by a crash blocks the job forever, and the first
 * symptom is a customer asking where their report went.
 */
export async function runJob(
  name: string,
  work: () => Promise<string>,
  now: Date = new Date(),
): Promise<JobOutcome> {
  const job = await getJob(name);
  if (!job) throw new Error(`Unknown job: ${name}`);

  // Phase two is fenced here, before the switch is even read: a job the
  // console somehow left on still does nothing in a v1 environment.
  if (PHASE_TWO_JOBS.has(name) && !env.phaseTwoAttribution()) {
    await record(name, "disabled", "Phase two: not run in v1 (HEALDESK_PHASE_TWO_ATTRIBUTION is not \"true\").", now);
    return { status: "disabled" };
  }

  if (!job.enabled) {
    await record(name, "disabled", "Job is switched off.", now);
    return { status: "disabled" };
  }

  if (
    job.runningSince &&
    now.getTime() - job.runningSince.getTime() < STALE_LOCK_MS
  ) {
    return { status: "already-running", since: job.runningSince };
  }

  // Claim the lock conditionally, so two runners starting together can't both
  // proceed. The WHERE re-checks what we just read.
  const claimed = await unsafeDb
    .update(scheduledJobs)
    .set({ runningSince: now })
    .where(
      sql`${scheduledJobs.name} = ${name}
          and ${scheduledJobs.enabled} = true
          and (${scheduledJobs.runningSince} is null
               or ${scheduledJobs.runningSince} < ${new Date(now.getTime() - STALE_LOCK_MS)})`,
    )
    .returning({ name: scheduledJobs.name });

  if (claimed.length === 0) {
    return { status: "already-running", since: job.runningSince ?? now };
  }

  try {
    const note = await work();
    await record(name, "ok", note, now);
    return { status: "ok", note };
  } catch (error) {
    // Never echo the error object — a driver error can carry query parameters,
    // and those can carry PHI.
    const note =
      error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
    await record(name, "failed", note, now);
    return { status: "failed", note };
  }
}

/**
 * Run a job that leases its own rows, behind its switch but without the lock.
 *
 * For the once-a-minute notices sender (lib/email/outbox.ts). runJob's lock is
 * 60 minutes so that a crashed monthly run is not mistaken for a live one, and
 * on a job that runs every minute that same lock would turn one crash into an
 * hour of no email. The sender does not need it: each notice is claimed by a
 * conditional UPDATE that leases it for two minutes, so two runs that overlap
 * never send one row twice. The switch is still read every time, and every
 * outcome is still recorded on the job row, exactly as runJob does.
 */
export async function runSwitchedJob(
  name: string,
  work: () => Promise<string>,
  now: Date = new Date(),
): Promise<JobOutcome> {
  const job = await getJob(name);
  if (!job) throw new Error(`Unknown job: ${name}`);

  if (!job.enabled) {
    await record(name, "disabled", "Job is switched off.", now);
    return { status: "disabled" };
  }

  try {
    const note = await work();
    await record(name, "ok", note, now);
    return { status: "ok", note };
  } catch (error) {
    // The message only, never the object, for the reason runJob gives.
    const note = error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
    await record(name, "failed", note, now);
    return { status: "failed", note };
  }
}

async function record(
  name: string,
  status: string,
  note: string,
  at: Date,
): Promise<void> {
  await unsafeDb
    .update(scheduledJobs)
    .set({
      lastRunAt: at,
      lastRunStatus: status,
      lastRunNote: note,
      runningSince: null,
    })
    .where(eq(scheduledJobs.name, name));
}

/**
 * The worker's liveness signal. Written on every tick regardless of what
 * else ran, so "the process is up" and "the process is doing work" are the
 * same timestamp, and a dead worker is a stale one on the console.
 */
export async function heartbeat(at: Date = new Date()): Promise<void> {
  await unsafeDb
    .update(scheduledJobs)
    .set({ lastRunAt: at, lastRunStatus: "ok", lastRunNote: "tick", runningSince: null })
    .where(eq(scheduledJobs.name, JOB_HEARTBEAT));
}

/** Age of the last heartbeat in seconds, or null if none was ever written. */
export async function heartbeatAgeSeconds(now: Date = new Date()): Promise<number | null> {
  const job = await getJob(JOB_HEARTBEAT);
  if (!job?.lastRunAt) return null;
  return Math.round((now.getTime() - job.lastRunAt.getTime()) / 1000);
}
