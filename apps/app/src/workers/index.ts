import { reconcilePeriod } from "@/lib/sync/reconcile-store";
import { monthContaining, previousMonth } from "@/lib/attribution/period";
import { runBillingRequestsJob } from "@/lib/billing/requests";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { runBillingNoticesJob } from "@/lib/email/outbox";
import {
  getBoss,
  QUEUE_BILLING_MINUTE,
  QUEUE_NOTICES,
  QUEUE_PROCESS_WEBHOOK,
  QUEUE_RECONCILE_CLINIC,
  QUEUE_SYNC_CONNECTION,
  QUEUE_TICK,
  startGuardedClock,
  stopBoss,
  type ProcessWebhookPayload,
  type ReconcileClinicPayload,
  type SyncConnectionPayload,
} from "@/lib/queue/boss";
import { runTick } from "@/lib/scheduler/tick";
import { syncConnection } from "@/lib/sync/run";
import { processWebhookEvent } from "@/lib/sync/webhooks";
import { withTenant } from "@/lib/tenant";
import { clinics } from "@/db/schema";
import { eq } from "drizzle-orm";
import { selfCheckCredentialKey } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";

/**
 * The background worker.
 *
 * A separate process from the Next server, deliberately. Sync runs are long,
 * rate-limited and bursty; sharing a process with request handling means a
 * month-end backfill competes with someone clicking around the console. It also
 * keeps `apps/app` portable — this is a plain Node entry point, so it runs as
 * an ECS task, a Fly machine or `node dist/workers/index.js` on a box, with
 * nothing Vercel-shaped in the way.
 *
 * Start it with `npm run worker -w @healdesk/app`.
 *
 * ⚠️ Like every other background job here, this does nothing until there are
 * tenants and someone turns it on. It processes what it is sent; nothing sends
 * it anything until the schedules in scripts/install-queue.ts are enabled.
 */

async function main(): Promise<void> {
  await checkCredentialKey();

  // `schedule: true` turns on pg-boss's own cron, which is what sends the
  // hourly tick. One process owns the clock; the scheduler tables live in the
  // pgboss schema and survive a restart, so re-registering the schedule below
  // is an upsert, not a second schedule.
  const boss = await getBoss({ supervise: true, schedule: true });

  // pg-boss v10 hands the handler an ARRAY of jobs, even with batchSize 1.
  // Treating it as a single job silently drops every job after the first.

  await boss.work<SyncConnectionPayload>(
    QUEUE_SYNC_CONNECTION,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const summary = await syncConnection({
          clinicId: job.data.clinicId,
          connectionId: job.data.connectionId,
        });

        const failed = summary.resources.filter((r) => r.status === "failed");
        log.info("sync run finished", {
          provider: summary.provider,
          clinicId: summary.clinicId,
          status: summary.resources
            .map((r) => `${r.resource}=${r.status}(${r.itemsWritten})`)
            .join(" "),
        });

        // Throw so pg-boss retries with its own backoff, rather than
        // reimplementing retry here badly. The sync run row already records
        // what happened, so the failure is visible either way.
        if (failed.length > 0) {
          throw new Error(
            `Sync failed for ${failed.map((r) => r.resource).join(", ")}: ${failed[0]!.error}`,
          );
        }
      }
    },
  );

  await boss.work<ReconcileClinicPayload>(
    QUEUE_RECONCILE_CLINIC,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await reconcileOne(job.data);
        log.info("reconcile finished", {
          clinicId: job.data.clinicId,
          matched: result.matched,
          exceptions: result.exceptions,
        });
      }
    },
  );

  await boss.work<ProcessWebhookPayload>(
    QUEUE_PROCESS_WEBHOOK,
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        const result = await processWebhookEvent(job.data);
        log.info("webhook event processed", {
          clinicId: job.data.clinicId,
          written: result.written,
          deferred: Boolean(result.deferred),
        });
      }
    },
  );

  // The clock. Every hour on the hour; the handler decides what that hour
  // means (lib/scheduler/tick.ts). Registered every start so a fresh
  // database gets its schedule without a separate install step.
  await boss.schedule(QUEUE_TICK, "0 * * * *", {}, { tz: "UTC" });
  await boss.work(QUEUE_TICK, { batchSize: 1 }, async () => {
    const outcomes = await runTick();
    log.info("tick", {
      status: outcomes.map((o) => `${o.job}=${o.status}`).join(" "),
    });
  });

  // The email outbox's clock: every minute, every due notice and every retry,
  // behind the billing-notices job row's switch (lib/email/outbox.ts). Each
  // notice is leased by its own conditional UPDATE, so a run that overlaps the
  // next, or a second worker, never sends one twice. A failed run throws so
  // pg-boss records it; the next minute's run starts fresh either way.
  await boss.schedule(QUEUE_NOTICES, "* * * * *", {}, { tz: "UTC" });
  await boss.work(QUEUE_NOTICES, { batchSize: 1 }, async () => {
    const outcome = await runBillingNoticesJob();
    if (outcome.status === "failed") throw new Error(`notices: ${outcome.note}`);
  });

  // The billing minute clock: the billing-request worker (plan starts,
  // step-ups, cancellations and setup closures on Stripe) and then the usage
  // meter report, each behind its own job row's switch and each recording its
  // own run. Neither takes runJob's 60-minute lock: every request and every
  // usage row is leased on its own, so a run that overlaps the next does no
  // harm and a crash costs a minute, not an hour. Guarded, unlike the clocks
  // above: an environment where `queue:install` has not been re-run since
  // this queue arrived logs that it is missing and the worker carries on, and
  // the hourly tick still runs both jobs as their backstop.
  await startGuardedClock(boss, QUEUE_BILLING_MINUTE, "* * * * *", async () => {
    const failures: string[] = [];
    for (const [job, run] of [
      ["billing-requests", () => runBillingRequestsJob()],
      ["usage-meter-report", () => runUsageMeterReportJob()],
    ] as const) {
      try {
        const outcome = await run();
        if (outcome.status === "failed") failures.push(`${job}: ${outcome.note}`);
      } catch (error) {
        failures.push(`${job}: ${describeError(error)}`);
      }
    }
    // Thrown only after both have run, so one failing never skips the other,
    // and pg-boss records the run; the next minute's starts afresh either way.
    if (failures.length > 0) throw new Error(failures.join("; "));
  });

  // No outbound clock. The call-back dialer of 23 September 2026 was removed
  // (v1 is inbound only): nothing in this process asks a vendor to dial.

  log.info("worker ready");

  // SIGTERM is what ECS and Fly send. Without a graceful stop, an in-flight
  // sync is killed mid-page and its run row stays "running" until the stale
  // lock expires an hour later.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log.info("draining on signal", { signal });
      void stopBoss().then(() => process.exit(0));
    });
  }
}

/**
 * Seal and open a throwaway value once, at start, and say what happened.
 *
 * Otherwise the first sign that this process cannot reach its key — no task
 * role, a key policy naming the wrong principal, a key id that is not the key —
 * is the first real credential it needs, and it fails in front of whoever was
 * waiting on it. Logged and never fatal: a worker that refused to start over
 * its key would also stop every job that never touches one.
 *
 * This line is the check an operator can read today. The read-only ops
 * operation getCredentialKeyStatus asks the web tier the same question on
 * demand, which is a separate answer, since the two processes can run under
 * different task roles; but nothing in apps/web calls it yet, so it answers
 * only a signed /api/ops request and no console card shows it.
 */
async function checkCredentialKey(): Promise<void> {
  const started = Date.now();
  const result = await selfCheckCredentialKey();
  const fields = { provider: env.kmsProvider(), ms: Date.now() - started };

  if (result.ok) {
    log.info("credential key self-check passed", fields);
  } else {
    log.error("credential key self-check FAILED: no clinic credential can be sealed or opened", {
      ...fields,
      code: result.error,
    });
  }
}

async function reconcileOne(
  payload: ReconcileClinicPayload,
): Promise<{ matched: number; exceptions: number }> {
  return withTenant(
    {
      clinicId: payload.clinicId,
      actor: { type: "service", serviceName: "reconcile-worker" },
    },
    async (tx) => {
      const [clinic] = await tx.db
        .select({ timezone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, payload.clinicId))
        .limit(1);

      if (!clinic) throw new Error("Unknown clinic.");

      const now = new Date();
      // Default to the month that just ended in the clinic's own timezone,
      // which on the 1st is not the same month everywhere.
      const period = payload.periodKey
        ? monthContaining(monthStart(payload.periodKey), clinic.timezone)
        : previousMonth(now, clinic.timezone);

      const result = await reconcilePeriod(tx.db, payload.clinicId, period, {
        now,
      });

      return {
        matched: result.matches.length,
        exceptions: result.exceptions.length,
      };
    },
  );
}

/** "2026-07" → an instant inside that month, UTC. */
function monthStart(periodKey: string): Date {
  const [year, month] = periodKey.split("-").map(Number);
  if (!year || !month) throw new Error(`Bad period key: ${periodKey}`);
  // Mid-month, so a timezone shift in either direction still lands in it.
  return new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
}

main().catch((error) => {
  log.error("worker failed to start", { error: describeError(error) });
  process.exit(1);
});
