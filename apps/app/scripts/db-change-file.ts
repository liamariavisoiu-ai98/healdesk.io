import { ChangeFileError, parseStatement, type Statement } from "./db-change-grammar";
import { WRITABLE_TABLES } from "./readonly-tables";

/**
 * What a change file for db-apply may be: optional header lines starting
 * `--`, then one statement in the grammar of db-change-grammar.ts
 * (docs/design/db-apply-grammar-2026-10-24.md), then an optional `;`. The
 * grammar is an allowlist: one INSERT ... VALUES, one INSERT ... SELECT over
 * one writable table, or one UPDATE ... WHERE, with literal values only. The
 * list of refused words this fence used to be runs after it as a second
 * layer. The database is the real bound (the role's grants, row-level
 * security keyed on the clinic, the triggers, runParsed's checks); this is the
 * fence in front of it, checked by the runner and by a test over every file in
 * scripts/db-changes/, so a careless file fails in review rather than in
 * production.
 */

export { ChangeFileError };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isChangeName(name: string): boolean {
  return NAME.test(name);
}

/** Trim only the plain whitespace a file may hold: space, tab and newline. */
function trimPlain(text: string): string {
  return text.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

/**
 * The statement: the file without its header (the leading lines that start
 * `--`, and blank lines), a final `;` and surrounding plain whitespace. A
 * `--` anywhere after the header is inside the statement, and the grammar
 * refuses it. Nothing else is changed: the runner sends these exact
 * characters, so a carriage return (which the database would read inside a
 * value) is refused rather than rewritten.
 */
function statementOf(text: string): string {
  const cr = text.indexOf("\r");
  if (cr >= 0) {
    throw new ChangeFileError(`a change file uses LF line endings: carriage return (U+000D) at character ${cr + 1}`);
  }
  const lines = text.split("\n");
  let first = 0;
  while (first < lines.length && (trimPlain(lines[first]!) === "" || /^[ \t]*--/.test(lines[first]!))) first++;
  return trimPlain(trimPlain(lines.slice(first).join("\n")).replace(/;[ \t\n]*$/, ""));
}

export type ChangeFile = { statement: string; verb: "insert" | "update"; table: string; ast: Statement };

/**
 * The two layers, on one object so a test can see parseChangeFile call both
 * (a refactor that drops the second layer fails tests/db-change-file.test.ts).
 */
export const layers = {
  grammar: parseStatement,
  denylist,
};

/** The file's statement, exactly as the runner will send it, or a ChangeFileError saying why not. */
export function parseChangeFile(text: string): ChangeFile {
  const statement = statementOf(text);
  if (statement === "") throw new ChangeFileError("a change file holds one statement");
  const ast = layers.grammar(statement);
  const old = layers.denylist(statement);
  if (old.verb !== ast.verb || old.table !== ast.table) {
    throw new ChangeFileError("the two layers read the statement differently");
  }
  return { statement, verb: ast.verb, table: ast.table, ast };
}

/**
 * The list of refused words this fence was before the grammar (22 Oct 2026),
 * kept as a second layer: it refuses nothing the grammar accepts, and would
 * still stand if a later edit widened the grammar by mistake.
 */
export function denylist(statement: string): { verb: "insert" | "update"; table: string } {
  if (statement.replace(/'(?:[^']|'')*'/g, "''").includes(";")) throw new ChangeFileError("a change file is exactly one statement");
  if (statement.includes("/*") || statement.includes("$$") || statement.includes("\\")) {
    throw new ChangeFileError("no block comments, dollar quoting or backslashes");
  }
  const head = /^\s*(insert\s+into|update)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(statement);
  if (!head) throw new ChangeFileError("a change file starts with INSERT INTO or UPDATE");
  const verb = head[1]!.toLowerCase().startsWith("insert") ? "insert" : "update";
  const table = head[2]!.toLowerCase();
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new ChangeFileError(`${table} is not a table a change may write (scripts/readonly-tables.ts, WRITABLE_TABLES)`);
  }
  // Words inside a quoted value ('Drop-in day') are data, not statements.
  const code = statement.replace(/'(?:[^']|'')*'/g, "''");
  if (/\breturning\b/i.test(code)) throw new ChangeFileError("no RETURNING: a run reports row counts, never rows");
  // Any dollar sign outside a quoted value: a dollar-quote has a tag of any
  // name ($a$...$a$), and inside one a quote mark ends nothing.
  if (code.includes("$")) throw new ChangeFileError("no dollar quoting, whatever its tag");
  // Unicode-escaped names (U&"..." UESCAPE '!') spell a function a word list cannot see.
  if (/\bu&\s*["']/i.test(code) || /\buescape\b/i.test(code)) {
    throw new ChangeFileError("no Unicode-escaped identifiers or strings (U&, UESCAPE)");
  }
  // Functions that run a query of their own from text (the *_to_xml family).
  if (/(_to_xml|_to_xmlschema|_and_xmlschema)\b|\b(xmlparse|xpath|query_to_|cursor_to_|database_to_|schema_to_|table_to_)/i.test(code)) {
    throw new ChangeFileError("no *_to_xml functions: they run queries of their own");
  }
  if (/\b(set_config|current_setting|pg_[a-z_]+|dblink|lo_[a-z]+|copy|truncate|delete|drop|alter|grant|revoke|create)\b/i.test(code)) {
    throw new ChangeFileError("a change file does not call set_config, current_setting, pg_* functions or DDL");
  }
  return { verb, table };
}
