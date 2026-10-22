import { Client } from "pg";

import { READONLY_JOURNAL, READONLY_ROLE, READONLY_TABLES } from "./readonly-tables";

/**
 * Give healdesk_readonly SELECT on the tables in readonly-tables.ts and on
 * nothing else. Run as the MIGRATOR role, after the migrations, by the migrate
 * task on every run (infra/aws/ecs.tf), because only a table's owner can grant
 * on it and a table created by a later migration must stay invisible until it
 * is listed.
 *
 * Rebuilt from the list every time: every table privilege the role holds in
 * `public` is revoked, then the listed ones are granted. Re-running is safe.
 *
 * If the role does not exist yet (the db-bootstrap task has not run since this
 * shipped), it says so and exits 0 rather than failing a deploy: the next
 * migrate run after the bootstrap does the grants.
 *
 *   npm run db:readonly-grants -w @healdesk/app
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;

function quote(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a plain table name: ${name}`);
  return `"${name}"`;
}

async function main(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) must be set, as the migrator role.");
    process.exit(2);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [READONLY_ROLE]);
    if (found.rowCount === 0) {
      console.log(`readonly-grants: ${READONLY_ROLE} does not exist yet; run db-bootstrap, then migrate again.`);
      return;
    }

    const role = quote(READONLY_ROLE);
    const { schema, table } = READONLY_JOURNAL;
    await client.query("BEGIN");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quote(schema)} FROM ${role}`);
    await client.query(`GRANT SELECT ON ${READONLY_TABLES.map((t) => `public.${quote(t)}`).join(", ")} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${role}`);
    await client.query(`GRANT SELECT ON ${quote(schema)}.${quote(table)} TO ${role}`);
    await client.query("COMMIT");
    console.log(`readonly-grants: ${READONLY_ROLE} may read ${READONLY_TABLES.length} tables and ${schema}.${table}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("readonly-grants failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
