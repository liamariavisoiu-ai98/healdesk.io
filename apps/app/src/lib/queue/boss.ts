import PgBoss from "pg-boss";

import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";

/**
 * The job queue.
 *
 * pg-boss, in the database we already have. No Redis, no SQS, no fourth vendor
 * to hold a BAA with — and jobs commit in the same Postgres as the data they
 * describe, so "we wrote the appointment but lost the job to reconcile it"
 * can't happen.
 *
 * ## ⚠️ The rule that matters: job payloads are NOT tenant-scoped
 *
 * pg-boss owns its own `pgboss` schema, and those tables have no clinic_id and
 * no RLS. Anything put in a payload sits outside every protection in this
 * codebase. So payloads carry **ids and resource names only** — a clinic id, a
 * connection id, a period key. Never a name, a phone number, a treatment, or an
 * amount. The worker re-reads what it needs through withTenant(), which is
 * slower by one query and correct by construction.
 *
 * `assertNoPhiInPayload()` enforces the shape rather than trusting the comment.
 *
 * ## Schema installation
 *
 * pg-boss creates its schema on first start, which needs CREATE on the
 * database — a privilege the runtime role deliberately does not have. So
 * installation is a separate step run as the migrator (`npm run queue:install`)
 * and the runtime connects with `migrate: false`. If pg-boss could migrate
 * itself at runtime it would need a role that could also drop our tables.
 */

const SCHEMA = "pgboss";

export const QUEUE_SYNC_CONNECTION = "sync-connection";
export const QUEUE_RECONCILE_CLINIC = "reconcile-clinic";
export const QUEUE_PROCESS_WEBHOOK = "process-webhook";
/** The clock. pg-boss's cron sends one empty job here every hour; the worker's tick handler drains it. */
export const QUEUE_TICK = "tick-hourly";
/**
 * The email outbox's minute clock (lib/email/outbox.ts): every due notice and
 * every retry. pg-boss's cron sends one empty job here every minute. A queue of
 * its own rather than the hourly tick, because a retry promised for one minute
 * later cannot wait for the top of the hour.
 */
export const QUEUE_NOTICES = "notices";
/**
 * The billing minute clock: every minute, the billing-request worker (plan
 * starts, step-ups, cancellations, setup closures; lib/billing/requests.ts)
 * and the usage meter report (lib/billing/usage-report.ts), each behind its
 * own job row's switch. A queue of its own because neither can wait for the
 * hour: a plan start recorded at a clinic's first answer should be charged
 * that minute, and overage reported after Stripe finalises an invoice is
 * never billed. The hourly tick runs both as a backstop.
 */
export const QUEUE_BILLING_MINUTE = "billing-minute";

/**
 * scripts/install-queue.ts creates exactly these, and pg-boss v10 refuses to
 * work a queue that was never created — `npm run queue:install` must be
 * re-run per environment when this list grows (it grew `billing-minute` with
 * the Stripe build of 6 October 2026). The 23 September 2026
 * `callback-dialer` queue was removed with the call-back (v1 places no
 * calls); where it was installed, it is simply never worked.
 */
export const QUEUES = [
  QUEUE_SYNC_CONNECTION,
  QUEUE_RECONCILE_CLINIC,
  QUEUE_PROCESS_WEBHOOK,
  QUEUE_TICK,
  QUEUE_NOTICES,
  QUEUE_BILLING_MINUTE,
] as const;

export type QueueName = (typeof QUEUES)[number];

export type SyncConnectionPayload = {
  clinicId: string;
  connectionId: string;
};

export type ReconcileClinicPayload = {
  clinicId: string;
  /** "2026-07" — a month key, not a date range. */
  periodKey?: string;
};

export type ProcessWebhookPayload = {
  clinicId: string;
  webhookEventId: string;
};

let instance: PgBoss | undefined;

/**
 * Options shared by the worker and by anything that only enqueues.
 *
 * `migrate: false` everywhere: see the note above. `supervise` is on only in
 * the worker — maintenance running from a web process means N copies of it.
 */
function options(overrides: Partial<PgBoss.ConstructorOptions> = {}) {
  return {
    connectionString: env.databaseUrl(),
    schema: SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    // Keep a small pool: this is a second pool in the same process as the
    // Drizzle one, and Postgres connection slots are a shared budget.
    max: 4,
    ...overrides,
  } satisfies PgBoss.ConstructorOptions;
}

export async function getBoss(
  overrides: Partial<PgBoss.ConstructorOptions> = {},
): Promise<PgBoss> {
  if (instance) return instance;

  const boss = new PgBoss(options(overrides));

  // Log rather than throw: an unhandled 'error' event on an EventEmitter takes
  // the process down, and a transient database blip should not kill a worker
  // that pg-boss will reconnect on its own.
  boss.on("error", (error) => {
    log.error("queue error", { error: describeError(error) });
  });

  await boss.start();
  instance = boss;
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (!instance) return;
  await instance.stop({ graceful: true });
  instance = undefined;
}

/** The two pg-boss calls a clock needs; a fake in tests. */
export type ClockBoss = {
  schedule(
    name: string,
    cron: string,
    data?: object,
    options?: PgBoss.ScheduleOptions,
  ): Promise<void>;
  work(
    name: string,
    options: PgBoss.WorkOptions,
    handler: PgBoss.WorkHandler<object>,
  ): Promise<string>;
};

/**
 * Register a cron clock and its handler, and survive a queue that was never
 * installed: returns false, and logs loudly, instead of throwing.
 *
 * pg-boss's `schedule()` throws "Queue … not found" for a queue that
 * `npm run queue:install` never created, and a throw out of the worker's
 * start-up takes the whole process down with it, the hourly tick included.
 * A clock added after an environment was installed (`billing-minute`) must
 * therefore fail on its own: the tick still runs its work hourly as the
 * backstop, and the log names the fix. Each fire is one empty job; pg-boss
 * hands the handler an array, which a clock ignores.
 */
export async function startGuardedClock(
  boss: ClockBoss,
  queue: QueueName,
  cron: string,
  handler: () => Promise<void>,
): Promise<boolean> {
  try {
    await boss.schedule(queue, cron, {}, { tz: "UTC" });
    await boss.work(queue, { batchSize: 1 }, async () => {
      await handler();
    });
    return true;
  } catch (error) {
    log.error(
      "queue clock not running: run `npm run queue:install` as the migrator",
      {
        job: queue,
        error: describeError(error),
      },
    );
    return false;
  }
}

/**
 * Enqueue, with the PHI check applied first.
 *
 * `singletonKey` defaults to the payload's natural identity so that ten
 * webhooks arriving at once for one clinic produce one sync, not ten racing
 * each other through the same rate budget.
 */
export async function enqueue(
  name: QueueName,
  payload: Record<string, unknown>,
  sendOptions: PgBoss.SendOptions = {},
): Promise<string | null> {
  assertNoPhiInPayload(payload);
  const boss = await getBoss();
  return boss.send(name, payload, sendOptions);
}

const ALLOWED_KEYS = new Set([
  "clinicId",
  "connectionId",
  "webhookEventId",
  "periodKey",
  "resource",
  "reason",
]);

export class PayloadContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadContentError";
  }
}

/**
 * An allowlist, not a blocklist.
 *
 * Scanning for phone-number-shaped strings would pass `{ patientName: "..." }`
 * happily. Listing what may appear means a future contributor adding a field
 * has to come here and think about whether the queue is the right place for it.
 */
export function assertNoPhiInPayload(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new PayloadContentError(
        `Job payloads carry ids only — "${key}" is not on the allowlist. ` +
          `The pgboss schema has no RLS, so re-read what you need inside withTenant().`,
      );
    }
    if (value !== undefined && typeof value !== "string") {
      throw new PayloadContentError(
        `Job payload "${key}" must be a string id, not ${typeof value}.`,
      );
    }
  }
}
