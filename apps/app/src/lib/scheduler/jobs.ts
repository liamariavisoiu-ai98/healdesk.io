import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { scheduledJobs } from "@/db/schema";

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
