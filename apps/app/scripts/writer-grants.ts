import { Client } from "pg";

import { READONLY_TABLES, WRITABLE_TABLES, WRITER_ALSO_READS, WRITER_ROLE } from "./readonly-tables";

/**
 * Give healdesk_writer SELECT on the read-only list and INSERT and UPDATE on
 * WRITABLE_TABLES, and nothing else. Run as the MIGRATOR role, after the
 * migrations and after readonly-grants.ts, by the migrate task on every run,
 * for the reasons readonly-grants.ts gives: only a table's owner can grant, and
 * a table created later must stay out of reach until it is listed.
 *
 * Rebuilt from the lists every time: every table privilege the role holds in
 * `public` is revoked, then the listed ones are granted. If the role does not
 * exist yet it says so and exits 0; the next migrate run after the bootstrap
 * does the grants.
 *
 *   npm run db:writer-grants -w @healdesk/app
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;

function quote(name: string): string {
  if (!IDENT.test(name)) throw new Error(`not a plain name: ${name}`);
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
    const found = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [WRITER_ROLE]);
    if (found.rowCount === 0) {
      console.log(`writer-grants: ${WRITER_ROLE} does not exist yet; run db-bootstrap, then migrate again.`);
      return;
    }

    const role = quote(WRITER_ROLE);
    const list = (tables: readonly string[]) => tables.map((t) => `public.${quote(t)}`).join(", ");
    await client.query("BEGIN");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT SELECT ON ${list([...READONLY_TABLES, ...WRITER_ALSO_READS])} TO ${role}`);
    await client.query(`GRANT INSERT, UPDATE ON ${list(WRITABLE_TABLES)} TO ${role}`);
    await client.query("COMMIT");
    console.log(`writer-grants: ${WRITER_ROLE} may read ${READONLY_TABLES.length + WRITER_ALSO_READS.length} tables and insert into or update ${WRITABLE_TABLES.length}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("writer-grants failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
