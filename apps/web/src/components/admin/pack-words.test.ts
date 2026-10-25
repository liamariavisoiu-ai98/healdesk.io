import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { PACK_ACCESS_EVENTS, PACK_FAILURE_EVENTS, PACK_INCIDENT_CLASSES, PACK_LIFECYCLE_JOBS, PACK_SECTIONS, PACK_SUBJECTS, PACK_VENDOR_STATES } from "@/lib/admin/ops-client";

import {
  ACCESS_EVENT_WORDS,
  AGREEMENT_WORDS,
  APPROVAL_INBOX_WORDS,
  couldNotReadWords,
  FAILURE_EVENT_WORDS,
  FRESH_CODE_WORDS,
  generatedByWords,
  HEADLINE_WORDS,
  INCIDENT_WORDS,
  lateWords,
  LIFECYCLE_JOB_WORDS,
  minutesWords,
  PACK_CLASS_WORDS,
  partialWords,
  RIGHTS_WORDS,
  SECTION_WORDS,
  SUBJECT_WORDS,
  TRANSCRIPT_WORDS,
  VENDOR_STATE_WORDS,
  weekWords,
  WHEN_WORDS,
} from "./pack-words";

/**
 * The words the printable pack page puts on apps/app's pack. The closed
 * lists are read from apps/app's source and from ops-client's mirror of
 * them; every number's field has its label, what it measures and when; the
 * sections' names match the pack; and a section that could not be read is
 * never a zero.
 */

const APP = join(__dirname, "..", "..", "..", "..", "app", "src");
const source = (path: string) => readFileSync(join(APP, path), "utf8");

function constList(file: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]!);
}

/** The fields of a `Section<{ ... }>` type in build.ts that hold a plain number. */
function numberFields(typeName: string): string[] {
  const block = new RegExp(`export type ${typeName} = Section<\\{([\\s\\S]*?)\\}>;`).exec(source("lib/compliance-pack/build.ts"))?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-zA-Z]+): number;$/gm)].map((m) => m[1]!);
}

describe("the closed lists have words", () => {
  test("the subjects, the vendor states, the access events, the jobs, the failure events, the classes (build.ts, subjects.ts)", () => {
    expect(Object.keys(SUBJECT_WORDS).sort()).toEqual([...PACK_SUBJECTS].sort());
    expect([...PACK_SUBJECTS].sort()).toEqual([...constList("lib/compliance/subjects.ts", "PLATFORM_VENDORS"), ...constList("lib/compliance/subjects.ts", "GATE_B_FLAGS")].sort());
    expect(Object.keys(VENDOR_STATE_WORDS).sort()).toEqual([...PACK_VENDOR_STATES].sort());
    const states = /export type VendorState = ([^;]+);/.exec(source("lib/compliance-pack/build.ts"))?.[1] ?? "";
    expect([...states.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...PACK_VENDOR_STATES].sort());
    expect(Object.keys(ACCESS_EVENT_WORDS)).toEqual([...PACK_ACCESS_EVENTS]);
    expect([...PACK_ACCESS_EVENTS]).toEqual(constList("lib/compliance-pack/build.ts", "ACCESS_EVENTS"));
    expect(Object.keys(LIFECYCLE_JOB_WORDS)).toEqual([...PACK_LIFECYCLE_JOBS]);
    expect([...PACK_LIFECYCLE_JOBS]).toEqual(constList("lib/compliance-pack/build.ts", "LIFECYCLE_JOBS"));
    expect(Object.keys(FAILURE_EVENT_WORDS)).toEqual([...PACK_FAILURE_EVENTS]);
    expect([...PACK_FAILURE_EVENTS]).toEqual(constList("lib/compliance-pack/build.ts", "LIFECYCLE_FAILURE_EVENTS"));
    expect(Object.keys(PACK_CLASS_WORDS).sort()).toEqual([...PACK_INCIDENT_CLASSES].sort());
    expect(Object.keys(SECTION_WORDS).sort()).toEqual([...PACK_SECTIONS].sort());
  });

  test("every number in every section has its label, what it measures and when (build.ts section types)", () => {
    expect(Object.keys(INCIDENT_WORDS).sort()).toEqual(numberFields("IncidentsSection").sort());
    expect(Object.keys(RIGHTS_WORDS).sort()).toEqual(numberFields("RightsSection").sort());
    expect(Object.keys(APPROVAL_INBOX_WORDS).sort()).toEqual(numberFields("ApprovalsSection").sort());
    // The nested ones, read against their own lines.
    const build = source("lib/compliance-pack/build.ts");
    for (const field of Object.keys(AGREEMENT_WORDS.resigns)) expect(build, field).toMatch(new RegExp(`^ {4}${field}: number;$`, "m"));
    for (const field of Object.keys(AGREEMENT_WORDS.reviews)) expect(build, field).toContain(`${field}: number`);
    for (const field of Object.keys(TRANSCRIPT_WORDS)) expect(build, field).toContain(`${field}: number`);
    for (const field of Object.keys(FRESH_CODE_WORDS)) expect(build, field).toContain(`${field}: number`);
    expect(build).toContain("medianMinutesToDecide: number | null");
    // The headline's five, as headlineOf builds them.
    expect(Object.keys(HEADLINE_WORDS).sort()).toEqual(["incidentsOpen", "resignsOpen", "rightsOverdue", "transcriptCopiesPast30Days", "vendorsNeedingAttention"]);
    const tables = [INCIDENT_WORDS, RIGHTS_WORDS, APPROVAL_INBOX_WORDS, AGREEMENT_WORDS.resigns, AGREEMENT_WORDS.reviews, TRANSCRIPT_WORDS, FRESH_CODE_WORDS, HEADLINE_WORDS];
    for (const table of tables) {
      for (const [field, words] of Object.entries(table)) {
        expect(words.label, field).toMatch(/^[A-Z]/);
        expect(words.measures.length, field).toBeGreaterThan(10);
        expect(Object.keys(WHEN_WORDS), field).toContain(words.when);
        // The field's own suffix says when it is measured; the words must agree with it.
        if (field.endsWith("ThisWeek")) expect(words.when, field).toBe("this week");
        if (field.endsWith("AtWeekEnd")) expect(words.when, field).toBe("at week end");
        if (field.endsWith("Now")) expect(words.when, field).toBe("now");
      }
    }
  });

  test("who stored a pack (job.ts PACK_SERVICE, pack-ops.ts CONSOLE_SERVICE)", () => {
    expect(source("lib/compliance-pack/job.ts")).toContain('export const PACK_SERVICE = "compliance-pack"');
    expect(source("lib/ops/pack-ops.ts")).toContain('export const CONSOLE_SERVICE = "ops-console"');
    expect(generatedByWords("compliance-pack")).toBe("the weekly compliance-pack job");
    expect(generatedByWords("ops-console")).toBe("the console, by hand");
    expect(generatedByWords("something-else")).toBe("something-else");
  });

  test("the banners and the sentences: never a zero for what was not read", () => {
    expect(couldNotReadWords()).toBe("This section could not be read when the pack was made. Its numbers are missing, not zero.");
    expect(couldNotReadWords(2)).toContain("(2 clinics could not be read)");
    expect(partialWords(["rights"])).toBe(
      "Incomplete: the Patient rights section could not be read for two days after the week was due, so the pack was stored with it missing. Its numbers are missing, not zero.",
    );
    expect(partialWords(["rights", "access"])).toContain("2 sections (Patient rights, Access and security events)");
    expect(lateWords(3)).toContain("Made 3 days late");
    expect(lateWords(1)).toContain("Made 1 day late");
    expect(source("lib/compliance-pack/job.ts")).toContain("PARTIAL_AFTER_MS = 48 * 3_600_000");
    expect(source("lib/compliance-pack/week.ts")).toContain("PACK_HOUR = 7");
    expect(weekWords({ start: "2026-10-26", lastDay: "2026-11-01", timeZone: "America/New_York", from: "2026-10-26T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" })).toBe(
      "Monday 26 Oct to Sunday 1 Nov 2026, New York",
    );
    expect(minutesWords(1)).toBe("1 minute");
    expect(minutesWords(45)).toBe("45 minutes");
    expect(minutesWords(150)).toBe("2.5 hours");
    expect(minutesWords(60)).toBe("1 hour");
  });
});
