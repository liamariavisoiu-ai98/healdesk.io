import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { isChangeName, parseChangeFile } from "./db-change-file";

/**
 * The work of db-apply.ts, callable from a test. See that file for what a run
 * is and why it is shaped this way.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ROWS = 500;

export type ChangeRun = {
  change: string;
  table: string;
  verb: "insert" | "update";
  mode: "dry-run" | "apply";
  clinic: string;
  rowCount: number;
  committed: boolean;
  verdict: string;
};

export type ChangeInput = {
  change: string;
  clinic: string;
  mode: "dry-run" | "apply";
  /** apply only: the row count the dry run showed. */
  expectRows: number | null;
  connectionString: string;
  /** The directory holding <change>.sql. */
  dir: string;
};

/** A request that is wrong before the database is touched. */
export class ChangeRefused extends Error {}

export async function runChange(input: ChangeInput): Promise<ChangeRun> {
  const { change, mode, expectRows } = input;
  const clinic = input.clinic.trim().toLowerCase();
  if (!isChangeName(change)) throw new ChangeRefused("a change's name is lower-case letters, digits and hyphens");
  if (!UUID.test(clinic)) throw new ChangeRefused("the clinic is a uuid, and is required");
  if (mode === "apply" && (expectRows === null || !Number.isInteger(expectRows) || expectRows < 0 || expectRows > MAX_ROWS)) {
    throw new ChangeRefused(`apply needs the row count the dry run showed (0 to ${MAX_ROWS})`);
  }
  if (mode === "dry-run" && expectRows !== null) throw new ChangeRefused("a dry run takes no expected row count");

  let text: string;
  try {
    text = readFileSync(path.join(input.dir, `${change}.sql`), "utf8");
  } catch {
    throw new ChangeRefused(`no change named ${change} in this image (scripts/db-changes/${change}.sql)`);
  }
  let parsed;
  try {
    parsed = parseChangeFile(text);
  } catch (error) {
    throw new ChangeRefused(error instanceof Error ? error.message : String(error));
  }
  return runParsed({ ...input, clinic }, parsed);
}

/**
 * Run a statement the fence has passed. Exported so a test can hand it a
 * statement the fence would refuse, to prove the checks below stand on their
 * own: after the statement, the transaction must still be the named clinic's
 * (app.clinic_id unchanged), and every change row the database's safety net
 * wrote in it (app_clinics_changed_in_transaction, drizzle/0114) must name
 * that clinic and no other. Otherwise the whole run is rolled back and
 * refused, dry run or apply.
 */
export async function runParsed(
  input: Omit<ChangeInput, "dir" | "change"> & { change: string },
  parsed: { statement: string; verb: "insert" | "update"; table: string },
): Promise<ChangeRun> {
  const { change, mode, expectRows } = input;
  const clinic = input.clinic.trim().toLowerCase();
  const client = new Client({
    connectionString: input.connectionString,
    application_name: `db-apply:${change}`.slice(0, 63),
    options: "-c statement_timeout=30000 -c lock_timeout=5000",
  });
  await client.connect();
  let committed = false;
  let rowCount = 0;
  let verdict = "dry-run: rolled back";
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic]);
    // Names in the statement resolve in the catalog first, then public, never
    // in a schema the session could put ahead of them. The trigger functions
    // pin their own search_path, and the checks below name public functions.
    await client.query("SET LOCAL search_path = pg_catalog, public");
    const result = await client.query(parsed.statement);
    rowCount = result.rowCount ?? 0;
    const where = await client.query<{ clinic: string | null }>(
      "SELECT current_setting('app.clinic_id', true) AS clinic",
    );
    const touched = await client.query<{ id: string }>("SELECT app_clinics_changed_in_transaction() AS id");
    const elsewhere = touched.rows.some((r) => r.id !== clinic);
    if ((where.rows[0]?.clinic ?? "").toLowerCase() !== clinic || elsewhere) {
      await client.query("ROLLBACK");
      verdict = "refused: the statement reached outside the clinic the run names; rolled back";
    } else if (rowCount > MAX_ROWS) {
      await client.query("ROLLBACK");
      verdict = `refused: ${rowCount} rows is more than ${MAX_ROWS}`;
    } else if (mode === "apply" && rowCount === expectRows) {
      await client.query("COMMIT");
      committed = true;
      verdict = "applied: committed";
    } else if (mode === "apply") {
      await client.query("ROLLBACK");
      verdict = `refused: the statement changed ${rowCount} rows, not the ${expectRows} expected; rolled back`;
    } else {
      await client.query("ROLLBACK");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  return { change, table: parsed.table, verb: parsed.verb, mode, clinic, rowCount, committed, verdict };
}
