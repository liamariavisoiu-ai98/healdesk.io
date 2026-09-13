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

export const QUEUES = [
  QUEUE_SYNC_CONNECTION,
  QUEUE_RECONCILE_CLINIC,
  QUEUE_PROCESS_WEBHOOK,
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
