import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CURRENT_DPA_VERSION,
  DPA_1_1_0_RELEASED,
  DPA_1_2_0_RELEASED,
  DPA_TEMPLATE_1_1_0_DRAFT,
  DPA_TEMPLATES,
  DPA_VERSION_PREFIX,
  dpaTemplatesFor,
  getDpaTemplate,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { reportingRuleFor, subcontractorNoticeRuleFor } from "@/lib/incidents/reporting-rules";
import { DESTRUCTION_RULES, destructionRuleFor } from "@/lib/offboarding/offboarding";

/**
 * DPA 1.1.0's release, prepared behind one switch (DPA_1_1_0_RELEASED in
 * packages/catalog/src/dpa.ts) and one migration kept beside the owner's
 * checklist until the release (docs/design/launch-readiness-2026-10-27/
 * dpa-release-1-1-0.sql), as BAA 1.6.0's was (baa-release-1-6-0.test.ts). No
 * database: the parity tests in go-live.test.ts and destruction-clock.test.ts
 * hold the applied functions to the catalogue; this holds the prepared ones
 * to what the catalogue will say once released, so the release cannot be a
 * flip with a migration that disagrees with it, or a flip with no migration.
 *
 * Released by the owner on 30 October 2026 (DPA_1_1_0_RELEASED true): the
 * release migration is drizzle/0140_dpa_release_1_1_0.sql, and every
 * version-to-rule map in apps/app gives 1.1.0 1.0.0's rules. Since 1 November
 * 2026 dpa/1.2.0 is current ahead of it (baa-release-1-7-0.test.ts), so this
 * file reads 1.1.0's release as it happened, with 1.2.0's switch off, and
 * leaves out of 0140's comparisons what 0143 added after it.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const STAGED = fileURLToPath(
  new URL(
    "../../../docs/design/launch-readiness-2026-10-27/dpa-release-1-1-0.sql",
    import.meta.url,
  ),
);
const RELEASE_FILE = /^\d{4}_dpa_release_1_1_0\.sql$/;

/** The versions one function's ARRAY[...] allow-list names in a migration's text. */
function allowList(sql: string, fn: string): string[] {
  const body = new RegExp(`FUNCTION ${fn}\\(version text\\)[\\s\\S]*?ARRAY\\[([^\\]]*)\\]`).exec(
    sql,
  );
  expect(body, `no ${fn} definition found`).not.toBeNull();
  return [...body![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
}

/** The DPA versions released once 1.1.0's switch is in the given state, 1.2.0's off. */
function releasedUnder(released: boolean): string[] {
  return dpaTemplatesFor(released, false)
    .filter((t) => t.approvedByCounsel)
    .map((t) => t.version)
    .sort();
}

/** What drizzle/0143 (baa_release_1_7_0_dpa_1_2_0) added to the export rule after 0140. */
const ADDED_BY_0143 = ["1.7.0", "dpa/1.2.0"];

/** The versions DESTRUCTION_RULES gave the export rule when 0140 ran, namespaced as stored. */
function exportRuleVersionsAt0140(): string[] {
  return exportRuleVersionsToday().filter((v) => !ADDED_BY_0143.includes(v));
}

/** The versions DESTRUCTION_RULES gives the export rule today, namespaced as stored. */
function exportRuleVersionsToday(): string[] {
  return Object.entries(DESTRUCTION_RULES)
    .flatMap(([kind, rules]) =>
      Object.entries(rules)
        .filter(([, rule]) => rule === "export_or_ninety")
        .map(([bare]) => (kind === "dpa" ? `${DPA_VERSION_PREFIX}${bare}` : bare)),
    )
    .sort();
}

describe("the switch", () => {
  test("today's catalogue is what the switches say", () => {
    expect(DPA_TEMPLATES).toEqual(dpaTemplatesFor(DPA_1_1_0_RELEASED, DPA_1_2_0_RELEASED));
    expect(CURRENT_DPA_VERSION).toBe(
      DPA_1_2_0_RELEASED ? "dpa/1.2.0" : DPA_1_1_0_RELEASED ? "dpa/1.1.0" : "dpa/1.0.0",
    );
  });

  test("off, 1.0.0 alone is registered, and apps/app's rules do not know 1.1.0", () => {
    expect(dpaTemplatesFor(false, false).map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.0.0", true],
    ]);
    expect(releasedUnder(false)).toEqual(["dpa/1.0.0"]);
    if (!DPA_1_1_0_RELEASED) {
      expect(getDpaTemplate("dpa/1.1.0")).toBeUndefined();
      // Unknown, so the strictest rule: nobody can hold it.
      expect(destructionRuleFor("dpa/1.1.0").basis).toBe("unknown_version");
      expect(reportingRuleFor("dpa/1.1.0").basis).toBe("unknown_version");
      expect(subcontractorNoticeRuleFor("dpa/1.1.0").basis).toBe("unknown_version");
    }
  });

  test("on, as released, 1.1.0 was current and 1.0.0 stayed released after it", () => {
    expect(dpaTemplatesFor(true, false).map((t) => [t.version, t.approvedByCounsel])).toEqual([
      ["dpa/1.1.0", true],
      ["dpa/1.0.0", true],
    ]);
    expect(releasedUnder(true)).toEqual(["dpa/1.0.0", "dpa/1.1.0"]);
    // 1.1.0's Term, Incidents and Subcontractors clauses are 1.0.0's own
    // objects, which is why the release gives it 1.0.0's rules in every map.
    const v100 = dpaTemplatesFor(true, false)[1]!;
    for (const id of ["term", "incidents", "subcontractors"]) {
      expect(
        DPA_TEMPLATE_1_1_0_DRAFT.clauses.find((c) => c.id === id),
        id,
      ).toBe(v100.clauses.find((c) => c.id === id));
    }
  });
});

describe("the release migration", () => {
  test("the prepared migration releases what the released catalogue releases, and nothing else", () => {
    const sql = readFileSync(STAGED, "utf8");
    expect(allowList(sql, "app_dpa_version_released")).toEqual(releasedUnder(true));
  });

  test("the prepared migration gives 1.1.0 the export rule and changes no other version's", () => {
    const sql = readFileSync(STAGED, "utf8");
    const expected = [...new Set([...exportRuleVersionsAt0140(), "dpa/1.1.0"])].sort();
    expect(allowList(sql, "app_destruction_rule")).toEqual(expected);
  });

  test("the switch is on: the owner released 1.1.0 on 30 October 2026", () => {
    expect(DPA_1_1_0_RELEASED).toBe(true);
    // Current since C13 landed: dpa/1.2.0, with 1.1.0 released behind it.
    expect(CURRENT_DPA_VERSION).toBe("dpa/1.2.0");
    // 1.1.0's rules in every map are 1.0.0's, read from the released registry.
    expect(getDpaTemplate("dpa/1.1.0")?.approvedByCounsel).toBe(true);
    expect(destructionRuleFor("dpa/1.1.0")).toEqual({
      rule: "export_or_ninety",
      basis: "agreement",
    });
    expect(destructionRuleFor("dpa/1.1.0")).toEqual(destructionRuleFor("dpa/1.0.0"));
    expect(reportingRuleFor("dpa/1.1.0").basis).toBe("agreement");
    expect(reportingRuleFor("dpa/1.1.0")).toEqual(reportingRuleFor("dpa/1.0.0"));
    expect(subcontractorNoticeRuleFor("dpa/1.1.0").basis).toBe("agreement");
    expect(subcontractorNoticeRuleFor("dpa/1.1.0")).toEqual(
      subcontractorNoticeRuleFor("dpa/1.0.0"),
    );
  });

  test("it is in drizzle/ exactly when the switch is on", () => {
    const files = readdirSync(DRIZZLE).filter((f) => RELEASE_FILE.test(f));
    const journal = JSON.parse(readFileSync(`${DRIZZLE}meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const journaled = journal.entries.filter((e) => RELEASE_FILE.test(`${e.tag}.sql`));
    if (!DPA_1_1_0_RELEASED) {
      expect(
        files,
        "The DPA 1.1.0 release migration is in drizzle/ while DPA_1_1_0_RELEASED is false: applied, go-live would accept a version nobody can sign.",
      ).toEqual([]);
      expect(journaled).toEqual([]);
      return;
    }
    expect(
      files,
      "DPA_1_1_0_RELEASED is true but no *_dpa_release_1_1_0.sql is in drizzle/: generate it (drizzle-kit generate --custom --name dpa_release_1_1_0) and paste the prepared migration into it.",
    ).toHaveLength(1);
    expect(journaled.map((e) => `${e.tag}.sql`)).toEqual(files);
    const sql = readFileSync(`${DRIZZLE}${files[0]}`, "utf8");
    expect(sql).not.toContain("<DAY>");
    expect(allowList(sql, "app_dpa_version_released")).toEqual(releasedUnder(true));
    expect(allowList(sql, "app_destruction_rule")).toEqual(exportRuleVersionsAt0140());
  });
});
