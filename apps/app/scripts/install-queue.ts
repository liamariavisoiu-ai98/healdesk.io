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

  for (const queue of QUEUES) {
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
