import path from "node:path";

import { ChangeRefused, MAX_ROWS, runChange } from "./db-apply-lib";

/**
 * Run one reviewed change file from scripts/db-changes/ against one clinic, as
 * healdesk_writer, and print how many rows it changed. Never the rows.
 *
 *   HEALDESK_DB_CHANGE=noop-smoke-test HEALDESK_DB_CHANGE_CLINIC=<uuid> \
 *     [HEALDESK_DB_CHANGE_MODE=dry-run|apply] [HEALDESK_DB_CHANGE_EXPECT_ROWS=n] \
 *     node --import tsx scripts/db-apply.ts
 *
 * Two modes. dry-run (the default) runs the statement in a transaction and
 * ALWAYS rolls it back, so it shows what would change and changes nothing.
 * apply needs the row count the dry-run showed (EXPECT_ROWS); it commits only
 * if the statement changes exactly that many rows, and rolls back otherwise,
 * so a table that moved between the dry-run and the apply cannot be changed by
 * a statement that now does something else.
 *
 * The clinic is required: row-level security keys every policy on the clinic
 * id set for the transaction, so a run reads and writes that clinic's rows and
 * no one else's, and the clinic is named in the output. At most 500 rows a run.
 *
 * What bounds a run is the database (the role's grants, the policies, the
 * triggers); the file is fenced further by db-change-file.ts. The output goes
 * to the task's own log group, db-apply, and only counts are in it.
 */

function fail(message: string, code = 2): never {
  console.error(`db-apply: ${message}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const mode = (process.env.HEALDESK_DB_CHANGE_MODE ?? "dry-run").trim();
  if (mode !== "dry-run" && mode !== "apply") fail("HEALDESK_DB_CHANGE_MODE is dry-run or apply");
  const raw = (process.env.HEALDESK_DB_CHANGE_EXPECT_ROWS ?? "").trim();
  if (mode === "apply" && !/^\d{1,3}$/.test(raw)) fail(`apply needs HEALDESK_DB_CHANGE_EXPECT_ROWS, the row count the dry run showed (0 to ${MAX_ROWS})`);
  const connectionString = process.env.WRITER_DATABASE_URL;
  if (!connectionString) fail("WRITER_DATABASE_URL is not set");

  let run;
  try {
    run = await runChange({
      change: (process.env.HEALDESK_DB_CHANGE ?? "").trim(),
      clinic: process.env.HEALDESK_DB_CHANGE_CLINIC ?? "",
      mode,
      expectRows: mode === "apply" ? Number(raw) : null,
      connectionString,
      dir: path.resolve(process.cwd(), "scripts/db-changes"),
    });
  } catch (error) {
    if (error instanceof ChangeRefused) return fail(error.message);
    throw error;
  }
  console.log(JSON.stringify(run));
  if (mode === "apply" && !run.committed) process.exit(1);
}

main().catch((error: unknown) => {
  // A database error can quote the statement; the log keeps its first 200 characters.
  const message = error instanceof Error ? error.message : String(error);
  console.error("db-apply failed:", message.length > 200 ? `${message.slice(0, 197)}...` : message);
  process.exit(1);
});
