import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BAA_1_6_0_RELEASED,
  BAA_RELEASE_OVERLAP,
  BAA_TEMPLATES,
  baaTemplatesFor,
  baaVersionAcceptableWhen,
  CURRENT_BAA_VERSION,
  isBaaVersionAcceptable,
  MIN_ACCEPTABLE_BAA_VERSION,
  minAcceptableBaaVersionFor,
} from "@healdesk/catalog";
import { signableTemplate } from "@healdesk/catalog/agreement-signing";
import { describe, expect, test } from "vitest";

/**
 * BAA 1.6.0's release, prepared behind one switch (BAA_1_6_0_RELEASED in
 * packages/catalog/src/baa.ts) and one migration kept beside the owner's
 * checklist until the release (docs/design/launch-readiness-2026-10-27/
 * baa-release-1-6-0.sql). No database: the parity test in
 * database-audit.test.ts holds the applied function to the catalogue; this
 * holds the prepared one to what the catalogue will say once released, so
 * the release cannot be a flip with a migration that disagrees with it, or a
 * flip with no migration at all.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const STAGED = fileURLToPath(
  new URL(
    "../../../docs/design/launch-readiness-2026-10-27/baa-release-1-6-0.sql",
    import.meta.url,
  ),
);
const RELEASE_FILE = /^\d{4}_baa_release_1_6_0\.sql$/;

/** The versions app_baa_version_acceptable's allow-list names in a migration's text. */
function acceptableList(sql: string): string[] {
  const body = /FUNCTION app_baa_version_acceptable\(version text\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(
    sql,
  );
  expect(body, "no app_baa_version_acceptable definition found").not.toBeNull();
  return [...body![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
}

function acceptableUnder(released: boolean): string[] {
  return baaTemplatesFor(released)
    .map((t) => t.version)
    .filter((v) => baaVersionAcceptableWhen(released, v))
    .sort();
}

describe("the switch", () => {
  test("today's catalogue is what the switch says", () => {
    expect(BAA_TEMPLATES).toEqual(baaTemplatesFor(BAA_1_6_0_RELEASED));
    expect(MIN_ACCEPTABLE_BAA_VERSION).toBe(minAcceptableBaaVersionFor(BAA_1_6_0_RELEASED));
    for (const t of BAA_TEMPLATES) {
      expect(isBaaVersionAcceptable(t.version), t.version).toBe(
        baaVersionAcceptableWhen(BAA_1_6_0_RELEASED, t.version),
      );
    }
    expect(CURRENT_BAA_VERSION).toBe(BAA_1_6_0_RELEASED ? "1.6.0" : "1.5.1");
  });

  test("off, 1.5.1 is offered and the floor, and 1.6.0 is a draft after it", () => {
    const [first, second] = baaTemplatesFor(false);
    expect([first!.version, first!.approvedByCounsel]).toEqual(["1.5.1", true]);
    expect([second!.version, second!.approvedByCounsel]).toEqual(["1.6.0", false]);
    expect(minAcceptableBaaVersionFor(false)).toBe("1.5.1");
    expect(acceptableUnder(false)).toEqual(["1.5.1"]);
  });

  test("on, 1.6.0 is offered and the floor, 1.5.1 follows it, released and refused at go-live", () => {
    const [first, second] = baaTemplatesFor(true);
    expect([first!.version, first!.approvedByCounsel]).toEqual(["1.6.0", true]);
    expect([second!.version, second!.approvedByCounsel]).toEqual(["1.5.1", true]);
    expect(minAcceptableBaaVersionFor(true)).toBe("1.6.0");
    expect(acceptableUnder(true)).toEqual(["1.6.0"]);
  });

  test("only the order of 1.5.1 and 1.6.0 and 1.6.0's flag move; every older template is the same object", () => {
    const off = baaTemplatesFor(false);
    const on = baaTemplatesFor(true);
    expect(off.slice(2)).toHaveLength(on.length - 2);
    off.slice(2).forEach((t, i) => expect(on[i + 2]).toBe(t));
    expect(on[1]).toBe(off[0]);
    // 1.6.0's words are the same either way, so a signature taken under one
    // state re-renders to the same hash under the other.
    const { approvedByCounsel: _a, ...draft } = off[1]!;
    const { approvedByCounsel: _b, ...released } = on[0]!;
    expect(released).toEqual(draft);
    expect(released.clauses).toBe(draft.clauses);
  });

  test("the release keeps no overlap, so a tab left open on 1.5.1 is asked to reload", () => {
    expect(BAA_RELEASE_OVERLAP).toEqual({});
    const current = baaTemplatesFor(true)[0]!;
    expect(signableTemplate("1.6.0", { current }).version).toBe("1.6.0");
    expect(() => signableTemplate("1.5.1", { current })).toThrow(/reload/);
  });
});

describe("the release migration", () => {
  test("the prepared migration accepts what the released catalogue accepts, and nothing else", () => {
    expect(acceptableList(readFileSync(STAGED, "utf8"))).toEqual(acceptableUnder(true));
  });

  test("it is in drizzle/ exactly when the switch is on", () => {
    const files = readdirSync(DRIZZLE).filter((f) => RELEASE_FILE.test(f));
    const journal = JSON.parse(readFileSync(`${DRIZZLE}meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const journaled = journal.entries.filter((e) => RELEASE_FILE.test(`${e.tag}.sql`));
    if (!BAA_1_6_0_RELEASED) {
      expect(
        files,
        "The 1.6.0 release migration is in drizzle/ while BAA_1_6_0_RELEASED is false: applied, it would refuse every 1.5.1 signer at go-live.",
      ).toEqual([]);
      expect(journaled).toEqual([]);
      return;
    }
    expect(
      files,
      "BAA_1_6_0_RELEASED is true but no *_baa_release_1_6_0.sql is in drizzle/: generate it (drizzle-kit generate --custom --name baa_release_1_6_0) and paste the prepared migration into it.",
    ).toHaveLength(1);
    expect(journaled.map((e) => `${e.tag}.sql`)).toEqual(files);
    expect(acceptableList(readFileSync(`${DRIZZLE}${files[0]}`, "utf8"))).toEqual(
      acceptableUnder(true),
    );
  });
});
