import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { isChangeName, parseChangeFile } from "../scripts/db-change-file";
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
    expect(parseChangeFile("-- a comment\ninsert into public.clinic_providers (clinic_id, display_name) values ('a', 'Dr Chen')")).toMatchObject({ verb: "insert", table: "clinic_providers" });
    expect(parseChangeFile('UPDATE "clinic_provider_services" SET service_key = \'x\'')).toMatchObject({ table: "clinic_provider_services" });
  });

  test("a word inside a quoted value is data, not a statement", () => {
    expect(() => parseChangeFile("update clinic_closures set label = 'Drop-in day; create a plan' where closed_on = '2026-12-24'")).not.toThrow();
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
    expect(() => parseChangeFile(sql)).toThrow();
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
      expect(() => parseChangeFile(readFileSync(path.join(dir, file), "utf8"))).not.toThrow();
    }
  });
});
