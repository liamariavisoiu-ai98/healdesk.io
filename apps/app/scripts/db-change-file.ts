import { WRITABLE_TABLES } from "./readonly-tables";

/**
 * What a change file for db-apply may be: one INSERT or UPDATE statement on a
 * table in WRITABLE_TABLES, nothing that returns rows, nothing that reaches
 * outside the clinic the run names. The database is the real bound (the role's
 * grants, row-level security keyed on the clinic, the triggers); this is the
 * fence in front of it, checked by the runner and by a test over every file in
 * scripts/db-changes/, so a careless file fails in review rather than in
 * production.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isChangeName(name: string): boolean {
  return NAME.test(name);
}

/** The file's text without `--` comments, trailing semicolon and surrounding space. */
function bare(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "");
}

export type ChangeFile = { statement: string; verb: "insert" | "update"; table: string };

export function parseChangeFile(text: string): ChangeFile {
  const statement = bare(text);
  if (statement === "") throw new Error("a change file holds one statement");
  if (statement.replace(/'(?:[^']|'')*'/g, "''").includes(";")) throw new Error("a change file is exactly one statement");
  if (statement.includes("/*") || statement.includes("$$") || statement.includes("\\")) {
    throw new Error("no block comments, dollar quoting or backslashes");
  }
  const head = /^\s*(insert\s+into|update)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(statement);
  if (!head) throw new Error("a change file starts with INSERT INTO or UPDATE");
  const verb = head[1]!.toLowerCase().startsWith("insert") ? "insert" : "update";
  const table = head[2]!.toLowerCase();
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`${table} is not a table a change may write (scripts/readonly-tables.ts, WRITABLE_TABLES)`);
  }
  // Words inside a quoted value ('Drop-in day') are data, not statements.
  const code = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (/\breturning\b/i.test(code)) throw new Error("no RETURNING: a run reports row counts, never rows");
  // The database refuses most of these for this role; stopping them here keeps
  // a statement from reaching outside the clinic whose id the run sets.
  if (/\b(set_config|current_setting|pg_[a-z_]+|dblink|lo_[a-z]+|copy|truncate|delete|drop|alter|grant|revoke|create)\b/i.test(code)) {
    throw new Error("a change file does not call set_config, current_setting, pg_* functions or DDL");
  }
  return { statement, verb, table };
}
