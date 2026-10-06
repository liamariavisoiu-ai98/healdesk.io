import { Client } from "pg";
import PgBoss from "pg-boss";

import { QUEUES } from "../src/lib/queue/boss";

/**
 * Install pg-boss's schema and queues. Run once per environment, as the
 * MIGRATOR role.
 *
 * Why this is a separate script rather than `migrate: true` at runtime:
 * pg-boss creates a schema, tables, types and functions, which needs CREATE on
 * the database. The runtime role deliberately does not have that — it is the
 * same privilege that would let application code drop `contacts`. Letting the
 * queue self-migrate would mean handing the web process exactly the privileges
 * the two-role split exists to withhold.
 *
 * So: the migrator creates it, then grants the runtime role the ordinary CRUD
 * it needs and nothing more. Re-running is safe.
 *
 *   npm run queue:install -w @healdesk/app
 */

const SCHEMA = "pgboss";

/**
 * pg-boss's own queue for cron. Every schedule (the hourly tick, the email
 * outbox's minute clock) fires by the timekeeper inserting a job here, which
 * the worker then turns into the scheduled job. The timekeeper creates it on
 * start, but in v10 creating a queue creates a partition table, which needs
 * CREATE on the schema, and the worker connects as the runtime role, which
 * deliberately has none. Its attempt fails silently, the inserts into the
 * missing queue insert nothing, and no schedule fires: a worker started on a
 * database installed by an earlier version of this script ran neither the
 * hourly tick nor the minute clock (seen on 6 October 2026, with the email
 * platform). So the installer creates it, as the migrator. The name is
 * pg-boss's (QUEUES.SEND_IT in pg-boss/src/timekeeper.js), which it does not
 * export.
 */
const CRON_QUEUE = "__pgboss__send-it";

async function main(): Promise<void> {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "MIGRATION_DATABASE_URL (or DATABASE_URL) must be set. Use the migrator role — the runtime role cannot CREATE.",
    );
  }

  const runtimeRole = process.env.HEALDESK_RUNTIME_ROLE ?? "healdesk_app";

  console.info(`[healdesk] installing pg-boss into schema "${SCHEMA}"`);

  const boss = new PgBoss({
    connectionString,
    schema: SCHEMA,
    migrate: true,
    supervise: false,
    schedule: false,
  });

  await boss.start();

  // Every queue in QUEUES, `notices` included (the email outbox's minute
  // clock), and pg-boss's cron queue. Both arrived with the email platform, so
  // re-run this in every environment installed before it: pg-boss v10 will not
  // work a queue that was never created, and without the cron queue no
  // schedule fires.
  for (const queue of [...QUEUES, CRON_QUEUE]) {
    // Idempotent. `stately` would collapse retries oddly for sync work, so the
    // default standard policy is right: every send is its own job, and
    // singletonKey at enqueue time is what prevents pile-ups.
    await boss.createQueue(queue);
    console.info(`[healdesk]   queue ready: ${queue}`);
  }

  await boss.stop({ graceful: true });

  // ---- Grants. The runtime role gets CRUD, never DDL. ----------------------
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`grant usage on schema ${SCHEMA} to ${runtimeRole}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema ${SCHEMA} to ${runtimeRole}`,
    );
    await client.query(
      `grant usage, select on all sequences in schema ${SCHEMA} to ${runtimeRole}`,
    );
    await client.query(
      `grant execute on all functions in schema ${SCHEMA} to ${runtimeRole}`,
    );
    // pg-boss adds tables on version upgrades; without this the next upgrade
    // silently leaves the runtime role unable to read the new ones, and the
    // worker starts failing with a permission error nobody expects.
    await client.query(
      `alter default privileges in schema ${SCHEMA}
         grant select, insert, update, delete on tables to ${runtimeRole}`,
    );

    console.info(`[healdesk] granted queue access to ${runtimeRole}`);
  } finally {
    await client.end();
  }

  console.info("[healdesk] pg-boss installed. Start the worker with: npm run worker");
}

main().catch((error) => {
  console.error("[healdesk] queue install failed:", error);
  process.exit(1);
});
