import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ChangeFileError, isChangeName, parseChangeFile } from "../scripts/db-change-file";
import { READONLY_TABLES, READONLY_WITHHELD, WRITABLE_TABLES, WRITER_ALSO_READS } from "../scripts/readonly-tables";

/**
 * The write path's fence (scripts/db-change-file.ts) and its table list. The
 * database is the real bound; these keep a careless file from reaching it.
 */

const ROOT = path.resolve(__dirname, "..");

describe("the tables a change may write", () => {
  test("every one is also readable, and none is withheld", () => {
    const readable = new Set<string>(READONLY_TABLES);
    for (const table of WRITABLE_TABLES) expect(readable.has(table)).toBe(true);
    expect(WRITABLE_TABLES.length).toBeGreaterThan(0);
  });

  test("what the writer reads beyond the read-only list is withheld from the read-only role, and is no patient or credential table", () => {
    for (const table of WRITER_ALSO_READS) {
      expect((READONLY_TABLES as readonly string[]).includes(table)).toBe(false);
      expect(READONLY_WITHHELD[table]).toBe("unreviewed");
    }
  });
});

describe("a change file", () => {
  test("takes one INSERT or UPDATE on a writable table", () => {
    expect(parseChangeFile("update clinic_closures set label = 'Bank holiday' where closed_on = '2026-12-25';")).toMatchObject({ verb: "update", table: "clinic_closures" });
    expect(parseChangeFile("-- a comment\ninsert into clinic_providers (clinic_id, display_name, calendar_id) values ('a', 'Dr Chen', 'primary')")).toMatchObject({ verb: "insert", table: "clinic_providers" });
    expect(parseChangeFile("UPDATE clinic_provider_services SET service_key = 'x' WHERE true")).toMatchObject({ table: "clinic_provider_services" });
  });

  test("since the grammar (24 Oct 2026): no public. prefix, no quoted names, an update has a WHERE", () => {
    expect(() => parseChangeFile("insert into public.clinic_providers (clinic_id) values ('a')")).toThrow(ChangeFileError);
    expect(() => parseChangeFile('UPDATE "clinic_provider_services" SET service_key = \'x\' WHERE true')).toThrow(ChangeFileError);
    expect(() => parseChangeFile("update clinic_closures set label = 'x'")).toThrow(/has a WHERE/);
  });

  test("a Unicode-escaped name or string is refused: it can spell a function the word list cannot see", () => {
    const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    for (const sql of [
      `insert into clinic_closures (clinic_id, closed_on, label) select '${id}','2027-04-04','Closed' where U&"!0073et_config" UESCAPE '!'('app.change_emitted','on',true) is not null`,
      `update clinic_closures set label = U&'!0041' UESCAPE '!'`,
      `update clinic_closures set label = u&"d!0061te" uescape '!'`,
      // A dollar-quote of any tag, and the *_to_xml family that runs a query from text.
      `insert into clinic_closures (clinic_id, closed_on, label) values ('${id}', '2027-05-05', $a$'$a$ || set_config('app.clinic_id', '${id}', true) || $a$'$a$)`,
      `insert into clinic_closures (clinic_id, closed_on, label) select '${id}', '2027-05-06', 'x' where query_to_xml('select set_config(''app.clinic_id'',''${id}'',true)', true, false, '') is not null`,
      `update clinic_closures set label = 'x' where cursor_to_xml(null, 1, true, false, '') is null`,
      `update clinic_closures set label = 'x' where table_to_xmlschema('clinics', true, false, '') is null`,
    ]) {
      expect(() => parseChangeFile(sql), sql).toThrow();
    }
    expect(() => parseChangeFile(`update clinic_closures set label = 'U& is fine in a value' where false`)).not.toThrow();
    expect(() => parseChangeFile(`update clinic_closures set label = 'Closed, costs $0' where false`)).not.toThrow();
  });

  test("a word inside a quoted value is data, not a statement; a semicolon in one is refused", () => {
    expect(() => parseChangeFile("update clinic_closures set label = 'Drop-in day, create a plan' where closed_on = '2026-12-24'")).not.toThrow();
    expect(() => parseChangeFile("update clinic_closures set label = 'Drop-in day; create a plan' where closed_on = '2026-12-24'")).toThrow(/no semicolon inside a value/);
  });

  test.each([
    ["a table it may not write", "update clinics set name = 'x'"],
    ["a table that is only read", "update clinic_settings set updated_at = now()"],
    ["a delete", "delete from clinic_closures"],
    ["a truncate", "truncate clinic_closures"],
    ["a second statement", "update clinic_closures set label = 'a'; update clinic_closures set label = 'b'"],
    ["returning rows", "update clinic_closures set label = 'a' returning *"],
    ["set_config", "update clinic_closures set label = (select set_config('app.clinic_id', 'x', false))"],
    ["current_setting", "update clinic_closures set label = current_setting('app.clinic_id')"],
    ["a pg_ function", "update clinic_closures set label = pg_read_file('/etc/passwd')"],
    ["dollar quoting", "update clinic_closures set label = $$a$$"],
    ["a block comment", "update clinic_closures set label = 'a' /* x */"],
    ["DDL", "alter table clinic_closures add column x int"],
    ["a select", "select * from clinic_closures"],
    ["an empty file", "-- nothing\n"],
  ])("refuses %s", (_what, sql) => {
    expect(() => parseChangeFile(sql)).toThrow(ChangeFileError);
  });

  test("a name is plain", () => {
    expect(isChangeName("noop-smoke-test")).toBe(true);
    for (const bad of ["", "Bad", "a b", "../x", "a;b", "-x", "x".repeat(65)]) expect(isChangeName(bad)).toBe(false);
  });

  test("every file in scripts/db-changes passes the fence and has a plain name", () => {
    const dir = path.join(ROOT, "scripts/db-changes");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(isChangeName(file.replace(/\.sql$/, ""))).toBe(true);
      const text = readFileSync(path.join(dir, file), "utf8");
      const parsed = parseChangeFile(text);
      // The runner sends the statement as the file holds it, header and final ";" aside.
      expect(text).toContain(parsed.statement);
    }
  });
});
