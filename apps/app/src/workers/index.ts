import { reconcilePeriod } from "@/lib/sync/reconcile-store";
import { monthContaining, previousMonth } from "@/lib/attribution/period";
import { sweepUnlinkedDeposits } from "@/lib/billing/deposit-sweep";
import { runBillingRequestsJob } from "@/lib/billing/requests";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { runTranscriptEmailsJob } from "@/lib/conversations/transcript-outbox";
import { sweepRedialContexts } from "@/lib/voice/redial";
import { runBillingNoticesJob } from "@/lib/email/outbox";
import {
  getBoss,
  QUEUE_BILLING_MINUTE,
  QUEUE_CALENDAR_WATCH,
  QUEUE_NOTICES,
  QUEUE_PRACTICE_QUESTIONS,
  QUEUE_PROCESS_WEBHOOK,
  QUEUE_SITE_READS,
  QUEUE_RECONCILE_CLINIC,
  QUEUE_SYNC_CONNECTION,
  QUEUE_TICK,
  QUEUE_VOICE_CALL_BACKSTOP,
  QUEUE_VOICE_PROVISION,
  startGuardedClock,
  stopBoss,
  type ProcessWebhookPayload,
  type ReconcileClinicPayload,
  type SyncConnectionPayload,
} from "@/lib/queue/boss";
import {
  CALENDAR_WATCH_CRON,
  CALENDAR_WATCH_RETRY_LIMIT,
  runCalendarWatchJob,
} from "@/lib/scheduler/calendar-watch";
import { runPracticeQuestionsJob } from "@/lib/engine/practice/job";
import { runOpsSlackSweep } from "@/lib/ops/slack";
import { runOpsWatchJob } from "@/lib/ops/watch";
import { runSiteReadsJob } from "@/lib/website/job";
import { handleCallBackstopJob, type CallBackstopPayload } from "@/lib/voice/backstop";
import { handleVoiceProvisionJob, type VoiceProvisionPayload } from "@/lib/voice/provision-job";
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
  // step-ups, cancellations and setup closures on Stripe), the usage meter
  // report and the transcript outbox (a conversation's emailed transcript,
  // retried until it is delivered, and each undelivered sealed copy deleted
  // at its 30 days, or 72 hours after a send nothing answered),
  // each behind its own job row's switch and each recording its own run. Neither takes runJob's 60-minute lock: every request and every
  // usage row is leased on its own, so a run that overlaps the next does no
  // harm and a crash costs a minute, not an hour. Guarded, unlike the clocks
  // above: an environment where `queue:install` has not been re-run since
  // this queue arrived logs that it is missing and the worker carries on, and
  // the hourly tick still runs every one of them as its backstop.
  await startGuardedClock(boss, QUEUE_BILLING_MINUTE, "* * * * *", async () => {
    const failures: string[] = [];
    for (const [job, run] of [
      ["billing-requests", () => runBillingRequestsJob()],
      ["usage-meter-report", () => runUsageMeterReportJob()],
      ["transcript-emails", () => runTranscriptEmailsJob()],
      // The ops watch's purchase checks (WP5): a paid order with no account
      // ten minutes on, and B3's follow-up past its day (lib/ops/watch.ts).
      ["ops-watch", () => runOpsWatchJob()],
      // Each ops alert's Slack copy, posted and retried (lib/ops/slack.ts).
      // Unswitched: off until SLACK_OPS_WEBHOOK_URL is set.
      ["ops-slack", () => runOpsSlackSweep()],
      // The redial records of calls that ended early (lib/voice/redial.ts):
      // each deleted at its two hours, whatever any switch says. Unswitched.
      [
        "redial-sweep",
        async () => ({ status: "ok" as const, note: `${await sweepRedialContexts()} deleted` }),
      ],
      // A chat deposit whose link was never made, handed to the front desk
      // once its grace has passed (lib/billing/deposit-sweep.ts). Unswitched.
      [
        "deposit-links",
        async () => {
          const r = await sweepUnlinkedDeposits();
          return r.failures
            ? { status: "failed" as const, note: `${r.failures} clinics failed` }
            : { status: "ok" as const, note: `${r.flagged} flagged` };
        },
      ],
    ] as const) {
      try {
        const outcome = await run();
        if (outcome.status === "failed") failures.push(`${job}: ${outcome.note}`);
      } catch (error) {
        failures.push(`${job}: ${describeError(error)}`);
      }
    }
    // Thrown only after all have run, so one failing never skips another,
    // and pg-boss records the run; the next minute's starts afresh either way.
    if (failures.length > 0) throw new Error(failures.join("; "));
  });

  // The calendar watch (owner decision 5): every five minutes, one forced
  // token refresh and one free/busy probe per Google Calendar connection,
  // behind the calendar-watch job row's switch, which ships off
  // (lib/scheduler/calendar-watch.ts). Not on the hourly tick: a location
  // whose Google access was removed must take requests within one cycle.
  // Guarded like billing-minute: where `queue:install` has not been re-run
  // since this queue arrived, the log names the fix and the rest of the
  // worker starts; after the install, restart the worker, since clocks are
  // registered only here. A failed run throws so pg-boss records it, but is
  // never retried at once: a re-run forces every refresh again and counts
  // another miss for each connection Google was slow for, so one blip could
  // degrade a connection inside one cycle. The next fire is the retry.
  // runJob's ten-minute lock keeps two runs from overlapping.
  await startGuardedClock(
    boss,
    QUEUE_CALENDAR_WATCH,
    CALENDAR_WATCH_CRON,
    async () => {
      const outcome = await runCalendarWatchJob();
      if (outcome.status === "failed") throw new Error(`calendar-watch: ${outcome.note}`);
    },
    { retryLimit: CALENDAR_WATCH_RETRY_LIMIT },
  );

  // The practice questions (lib/engine/practice/job.ts): every minute, each
  // clinic's due run, one at a time per clinic, behind the practice-questions
  // job row's switch, which ships off because every run asks the model.
  // Guarded like the clocks above. Never retried at once: a run is leased on
  // its own row, and the next minute's fire takes up whatever is still due.
  await startGuardedClock(
    boss,
    QUEUE_PRACTICE_QUESTIONS,
    "* * * * *",
    async () => {
      const outcome = await runPracticeQuestionsJob();
      if (outcome.status === "failed") throw new Error(`practice-questions: ${outcome.note}`);
    },
    { retryLimit: 0 },
  );

  // The website re-reads (lib/website/job.ts): every minute, each clinic's
  // due read sent to apps/web's signed /api/clinic-site, one at a time per
  // clinic, behind the site-reads job row's switch; nothing is read until
  // HEALDESK_WEB_URL is set. Guarded like the clocks above. Never retried at
  // once: a read is leased on its own row, and a failure worth another try
  // is queued again with its own back-off.
  await startGuardedClock(
    boss,
    QUEUE_SITE_READS,
    "* * * * *",
    async () => {
      const outcome = await runSiteReadsJob();
      if (outcome.status === "failed") throw new Error(`site-reads: ${outcome.note}`);
    },
    { retryLimit: 0 },
  );

  // The voice call backstop (lib/voice/backstop.ts): a call Retell says has
  // ended and the live socket never recorded. Each job is ten minutes behind
  // its webhook and idempotent on the call id; a throw is retried by
  // pg-boss with the backoff set at enqueue. pg-boss works a queue that was
  // never installed without a word (its fetch swallows the error), so the
  // queue is looked up first, and a missing one is logged with its fix; the
  // webhook's send into it fails too, and Retell is told to retry.
  if (await boss.getQueue(QUEUE_VOICE_CALL_BACKSTOP)) {
    await boss.work<CallBackstopPayload>(QUEUE_VOICE_CALL_BACKSTOP, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await handleCallBackstopJob(job.data);
    });
  } else {
    log.error("queue not worked: run `npm run queue:install` as the migrator, then restart the worker", {
      job: QUEUE_VOICE_CALL_BACKSTOP,
    });
  }

  // Each clinic's Retell agent and AYA number (lib/voice/provision-job.ts),
  // queued by the hourly sweep only while HEALDESK_VOICE_PROVISION_ENABLED is
  // on. A run Retell did not answer throws, and pg-boss retries it with the
  // backoff set at enqueue; every run is idempotent. Looked up first, like
  // the backstop, so a queue never installed is logged with its fix.
  if (await boss.getQueue(QUEUE_VOICE_PROVISION)) {
    await boss.work<VoiceProvisionPayload>(QUEUE_VOICE_PROVISION, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await handleVoiceProvisionJob(job.data);
    });
  } else {
    log.error("queue not worked: run `npm run queue:install` as the migrator, then restart the worker", {
      job: QUEUE_VOICE_PROVISION,
    });
  }

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
 * This line is the worker's own answer. The read-only ops operation
 * getCredentialKeyStatus asks the web tier the same question on demand,
 * which is a separate answer, since the two processes can run under
 * different task roles: /admin/map asks it on every load and shows it on the
 * key-safe bridge.
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
