import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

/**
 * Run one reviewed query from scripts/db-queries/ as healdesk_readonly and
 * print the rows as one JSON line.
 *
 *   HEALDESK_DB_QUERY=migration-state node --import tsx scripts/db-query.ts
 *
 * The query is a file in the repo, so it is reviewed in git and fixed by the
 * commit the image was built from; the task is told only its name, because
 * CloudTrail records a run's overrides. Nothing typed ever becomes SQL.
 *
 * What bounds it is the database, not this script: the role can SELECT only
 * the tables in readonly-tables.ts, has no BYPASSRLS, and the session is read
 * only with a 30 second limit. This script adds a second fence (one statement,
 * a read-only transaction, at most 200 rows) in case a file is ever careless.
 *
 * A query on a table under row-level security sees no rows unless it is given
 * a clinic: HEALDESK_DB_QUERY_CLINIC (a uuid) sets app.clinic_id for the
 * transaction, as withTenant does. Without one, only tables with no policy
 * return anything.
 *
 * The output goes to the task's own log group in CloudWatch, /healdesk/
 * production/db-query, and nowhere else. That group is for business and
 * configuration data only; never write a query that selects a column holding
 * a person's words, name, number or address.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 200;

function fail(message: string, code = 2): never {
  console.error(`db-query: ${message}`);
  process.exit(code);
}

/** The file's text with comments dropped, which must be exactly one statement. */
function singleStatement(text: string): string {
  const withoutComments = text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .trim();
  const statement = withoutComments.replace(/;\s*$/, "");
  if (statement === "" || statement.includes(";")) fail("a query file is exactly one statement");
  if (!/^(select|with)\b/i.test(statement)) fail("a query file starts with SELECT or WITH");
  return statement;
}

async function main(): Promise<void> {
  const name = (process.argv[2] ?? process.env.HEALDESK_DB_QUERY ?? "").trim();
  if (!NAME.test(name)) fail("HEALDESK_DB_QUERY is a query's file name without .sql: lower-case letters, digits, hyphens");
  const clinic = (process.env.HEALDESK_DB_QUERY_CLINIC ?? "").trim().toLowerCase();
  if (clinic !== "" && !UUID.test(clinic)) fail("HEALDESK_DB_QUERY_CLINIC is a clinic's uuid");
  const connectionString = process.env.READONLY_DATABASE_URL;
  if (!connectionString) fail("READONLY_DATABASE_URL is not set");

  const file = path.resolve(process.cwd(), "scripts/db-queries", `${name}.sql`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    fail(`no query named ${name} in this image (scripts/db-queries/${name}.sql)`);
  }
  const statement = singleStatement(text);

  const client = new Client({
    connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=30000",
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    if (clinic !== "") await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic]);
    const result = await client.query(statement);
    await client.query("ROLLBACK");
    const rows = result.rows.slice(0, MAX_ROWS);
    console.log(
      JSON.stringify({
        query: name,
        clinic: clinic === "" ? null : clinic,
        rowCount: result.rowCount,
        truncated: result.rows.length > MAX_ROWS,
        rows,
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("db-query failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
