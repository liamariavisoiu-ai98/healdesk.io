import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { READONLY_TABLES, READONLY_WITHHELD } from "../scripts/readonly-tables";

/**
 * The db-query role reads only what scripts/readonly-tables.ts lists, and every
 * table in the schema is on one of its two lists. A new table fails this test
 * until someone decides which, so it is never readable by default.
 */

const ROOT = path.resolve(__dirname, "..");

function schemaTables(): string[] {
  const names = new Set<string>();
  for (const file of ["src/db/schema.ts", "src/db/auth-schema.ts"]) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/pgTable\(\s*"([a-z_0-9]+)"/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

describe("the read-only role's tables", () => {
  test("every table in the schema is allowed or withheld, never both, never neither", () => {
    const allowed = new Set<string>(READONLY_TABLES);
    const withheld = new Set(Object.keys(READONLY_WITHHELD));
    const tables = schemaTables();

    expect(tables.length).toBeGreaterThan(50);
    expect(tables.filter((t) => !allowed.has(t) && !withheld.has(t))).toEqual([]);
    expect(tables.filter((t) => allowed.has(t) && withheld.has(t))).toEqual([]);
    expect([...allowed, ...withheld].filter((t) => !tables.includes(t))).toEqual([]);
  });

  test("nothing about a patient or a credential is allowed", () => {
    const allowed = new Set<string>(READONLY_TABLES);
    for (const [table, reason] of Object.entries(READONLY_WITHHELD)) {
      if (reason !== "unreviewed") expect(allowed.has(table)).toBe(false);
    }
  });

  test("the query files are single read statements with plain names", () => {
    const dir = path.join(ROOT, "scripts/db-queries");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.replace(/\.sql$/, "")).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      const text = readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n")
        .trim()
        .replace(/;\s*$/, "");
      expect(text).toMatch(/^(select|with)\b/i);
      expect(text.includes(";")).toBe(false);
    }
  });
});
