import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BAA_1_6_0_RELEASED,
  BAA_1_7_0_RELEASED,
  BAA_RELEASE_OVERLAP,
  BAA_TEMPLATES,
  baaTemplatesFor,
  baaVersionAcceptableWhen,
  CURRENT_BAA_VERSION,
  CURRENT_DPA_VERSION,
  DPA_1_1_0_RELEASED,
  DPA_TEMPLATES,
  dpaTemplatesFor,
  MIN_ACCEPTABLE_BAA_VERSION,
} from "@healdesk/catalog";
import { signableTemplate } from "@healdesk/catalog/agreement-signing";
import { describe, expect, test } from "vitest";

import { DESTRUCTION_RULES } from "@/lib/offboarding/offboarding";

/**
 * BAA 1.7.0's and DPA 1.1.0's release (owner, 30 October 2026: "release BAA
 * 1.7.0 and DPA 1.1.0"), behind one switch each (BAA_1_7_0_RELEASED in
 * packages/catalog/src/baa.ts, DPA_1_1_0_RELEASED in src/dpa.ts) and one
 * migration (drizzle/*_baa_release_1_7_0.sql). No database: the parity tests
 * in database-audit.test.ts, go-live.test.ts and destruction-clock.test.ts
 * hold the applied functions to the catalogue; this holds the migration's
 * text to what the released catalogue says, so a flip without the migration,
 * or a migration that disagrees with it, fails here.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const RELEASE_FILE = /^\d{4}_baa_release_1_7_0\.sql$/;

/** The versions a function's first ARRAY[...] names in a migration's text. */
function listIn(sql: string, fn: string): string[] {
  const body = new RegExp(`FUNCTION ${fn}\\(version text\\)[\\s\\S]*?ARRAY\\[([^\\]]*)\\]`).exec(sql);
  expect(body, `no ${fn} definition found`).not.toBeNull();
  return [...body![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
}

function acceptableReleased(): string[] {
  return baaTemplatesFor(true, true)
    .map((t) => t.version)
    .filter((v) => baaVersionAcceptableWhen(true, v, true))
    .sort();
}

describe("the switches", () => {
  test("both are on: the owner released 1.7.0 and dpa/1.1.0 on 30 October 2026", () => {
    expect(BAA_1_6_0_RELEASED).toBe(true);
    expect(BAA_1_7_0_RELEASED).toBe(true);
    expect(DPA_1_1_0_RELEASED).toBe(true);
    expect(CURRENT_BAA_VERSION).toBe("1.7.0");
    expect(MIN_ACCEPTABLE_BAA_VERSION).toBe("1.7.0");
    expect(CURRENT_DPA_VERSION).toBe("dpa/1.1.0");
    expect(BAA_TEMPLATES).toEqual(baaTemplatesFor(true, true));
    expect(DPA_TEMPLATES).toEqual(dpaTemplatesFor(true));
  });

  test("on, 1.7.0 is offered and the floor; 1.6.0 follows it, released and refused at go-live", () => {
    const [first, second] = baaTemplatesFor(true, true);
    expect([first!.version, first!.approvedByCounsel]).toEqual(["1.7.0", true]);
    expect([second!.version, second!.approvedByCounsel]).toEqual(["1.6.0", true]);
    expect(acceptableReleased()).toEqual(["1.7.0"]);
  });

  test("1.7.0's words are the draft's: the release moved only its place and its flag", () => {
    const draft = baaTemplatesFor(true, false).find((t) => t.version === "1.7.0")!;
    const released = baaTemplatesFor(true, true)[0]!;
    expect(draft.approvedByCounsel).toBe(false);
    expect(released.clauses).toBe(draft.clauses);
    expect(released.preamble).toBe(draft.preamble);
    const dpaDraft = dpaTemplatesFor(false).find((t) => t.version === "dpa/1.1.0")!;
    const dpaReleased = dpaTemplatesFor(true)[0]!;
    expect(dpaDraft.approvedByCounsel).toBe(false);
    expect(dpaReleased.clauses).toBe(dpaDraft.clauses);
  });

  test("1.7.0 cannot be released before 1.6.0", () => {
    expect(() => baaTemplatesFor(false, true)).toThrow(/1\.6\.0/);
  });

  test("the release keeps no overlap, so a tab left open on 1.6.0 is asked to reload", () => {
    expect(BAA_RELEASE_OVERLAP).toEqual({});
    const current = baaTemplatesFor(true, true)[0]!;
    expect(signableTemplate("1.7.0", { current }).version).toBe("1.7.0");
    expect(() => signableTemplate("1.6.0", { current })).toThrow(/reload/);
  });
});

describe("the release migration", () => {
  const files = readdirSync(DRIZZLE).filter((f) => RELEASE_FILE.test(f));

  test("exactly one, journaled", () => {
    expect(
      files,
      "BAA_1_7_0_RELEASED is true but no *_baa_release_1_7_0.sql is in drizzle/.",
    ).toHaveLength(1);
    const journal = JSON.parse(readFileSync(`${DRIZZLE}meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const journaled = journal.entries.filter((e) => RELEASE_FILE.test(`${e.tag}.sql`));
    expect(journaled.map((e) => `${e.tag}.sql`)).toEqual(files);
  });

  test("it accepts what the released catalogue accepts, and nothing else", () => {
    const sql = readFileSync(`${DRIZZLE}${files[0]}`, "utf8");
    expect(listIn(sql, "app_baa_version_acceptable")).toEqual(acceptableReleased());
    expect(listIn(sql, "app_dpa_version_released")).toEqual(
      DPA_TEMPLATES.filter((t) => t.approvedByCounsel)
        .map((t) => t.version)
        .sort(),
    );
  });

  test("its destruction allow-list is DESTRUCTION_RULES' export versions", () => {
    const sql = readFileSync(`${DRIZZLE}${files[0]}`, "utf8");
    const expected = [
      ...Object.entries(DESTRUCTION_RULES.baa)
        .filter(([, rule]) => rule === "export_or_ninety")
        .map(([v]) => v),
      ...Object.entries(DESTRUCTION_RULES.dpa)
        .filter(([, rule]) => rule === "export_or_ninety")
        .map(([v]) => `dpa/${v}`),
    ].sort();
    expect(listIn(sql, "app_destruction_rule")).toEqual(expected);
  });
});
