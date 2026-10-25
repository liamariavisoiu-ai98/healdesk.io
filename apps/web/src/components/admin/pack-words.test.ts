import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { PACK_ACCESS_EVENTS, PACK_FAILURE_EVENTS, PACK_INCIDENT_CLASSES, PACK_LIFECYCLE_JOBS, PACK_SECTIONS, PACK_SUBJECTS, PACK_VENDOR_STATES } from "@/lib/admin/ops-client";

import {
  ACCESS_EVENT_WORDS,
  AGREEMENT_WORDS,
  APPROVAL_INBOX_WORDS,
  AT_RISK_WORDS,
  couldNotReadWords,
  FAILURE_EVENT_WORDS,
  FRESH_CODE_WORDS,
  generatedByWords,
  HEADLINE_WORDS,
  INCIDENT_WORDS,
  lateWords,
  LIFECYCLE_JOB_WORDS,
  minutesWords,
  NUMBER_TABLES,
  PACK_CLASS_WORDS,
  PACK_JOB,
  PACK_JOB_OFF,
  partialWords,
  RIGHTS_WORDS,
  RUN_STATUS_WORDS,
  runStatusWords,
  SECTION_WORDS,
  SUBJECT_WORDS,
  TARGET_MISSED_HEADING,
  TARGET_MISSED_WORDS,
  TRANSCRIPT_WORDS,
  VENDOR_RECORDED_WORDS,
  VENDOR_STATE_WORDS,
  weekWords,
  WHEN_WORDS,
} from "./pack-words";

/**
 * The words the printable pack page puts on apps/app's pack. The closed
 * lists are read from apps/app's source and from ops-client's mirror of
 * them; every number the page prints has its label, what it measures and
 * when, the when agreeing with the field's own suffix where it has one; the
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

  test("the pack job and a run's statuses are named as apps/app names them (job.ts JOB_COMPLIANCE_PACK; scheduler/jobs.ts record)", () => {
    expect(source("lib/compliance-pack/job.ts")).toContain(`export const JOB_COMPLIANCE_PACK = "${PACK_JOB}"`);
    expect(PACK_JOB_OFF).toBe("The weekly pack job is off at System > Jobs, so no week is made automatically; use Make this week's pack.");
    // Every status the scheduler records (jobs.ts record(name, "<status>", ...)) has words; one it never records prints as its own words.
    const jobs = source("lib/scheduler/jobs.ts");
    const recorded = [...new Set([...jobs.matchAll(/record\(name, "([a-z-]+)"/g)].map((m) => m[1]!))];
    expect(recorded.length).toBeGreaterThan(1);
    for (const status of recorded) expect(RUN_STATUS_WORDS[status], status).toBeDefined();
    expect(runStatusWords("ok")).toBe("went through");
    expect(runStatusWords(null)).toBe("no run recorded");
    expect(runStatusWords("already-running")).toBe("already running");
  });

  test("every number the page prints has its label, what it measures and when, the when agreeing with the field's suffix where it has one (build.ts section types)", () => {
    expect(Object.keys(INCIDENT_WORDS).sort()).toEqual(numberFields("IncidentsSection").sort());
    expect(Object.keys(RIGHTS_WORDS).sort()).toEqual(numberFields("RightsSection").sort());
    expect(Object.keys(APPROVAL_INBOX_WORDS).sort()).toEqual(numberFields("ApprovalsSection").sort());
    // The nested ones, read against their own lines.
    const build = source("lib/compliance-pack/build.ts");
    for (const field of Object.keys(AGREEMENT_WORDS.resigns)) expect(build, field).toMatch(new RegExp(`^ {4}${field}: number;$`, "m"));
    for (const field of Object.keys(AGREEMENT_WORDS.reviews)) expect(build, field).toContain(`${field}: number`);
    for (const field of Object.keys(TRANSCRIPT_WORDS)) expect(build, field).toContain(`${field}: number`);
    for (const field of Object.keys(FRESH_CODE_WORDS)) expect(build, field).toContain(`${field}: number`);
    expect(build).toContain("recordedThisWeek: number");
    expect(build).toContain("medianMinutesToDecide: number | null");
    // The headline's five, as headlineOf builds them.
    expect(Object.keys(HEADLINE_WORDS).sort()).toEqual(["incidentsOpen", "resignsOpen", "rightsOverdue", "transcriptCopiesPast30Days", "vendorsNeedingAttention"]);
    // Every table, including the single entries (the attestations, the median), is in NUMBER_TABLES, and every entry has an explicit when.
    expect(Object.keys(NUMBER_TABLES).sort()).toEqual(["approvals", "freshCode", "headline", "incidents", "median", "resigns", "reviews", "rights", "transcripts", "vendors"]);
    expect(NUMBER_TABLES.vendors!.recordedThisWeek).toBe(VENDOR_RECORDED_WORDS);
    let counted = 0;
    for (const [table, words] of Object.entries(NUMBER_TABLES)) {
      for (const [field, entry] of Object.entries(words)) {
        counted += 1;
        expect(entry.label, `${table}.${field}`).toMatch(/^[A-Z]/);
        expect(entry.measures.length, `${table}.${field}`).toBeGreaterThan(10);
        expect(Object.keys(WHEN_WORDS), `${table}.${field}`).toContain(entry.when);
        // The field's own suffix says when it is measured; the words must agree with it.
        if (field.endsWith("ThisWeek")) expect(entry.when, field).toBe("this week");
        if (field.endsWith("AtWeekEnd")) expect(entry.when, field).toBe("at week end");
        if (field.endsWith("Now")) expect(entry.when, field).toBe("now");
      }
    }
    expect(counted).toBeGreaterThan(30);
    // Fields with no suffix carry their when all the same: the headline's (as headlineOf reads them), the median, the attestations.
    expect(HEADLINE_WORDS.incidentsOpen.when).toBe("at week end");
    expect(HEADLINE_WORDS.transcriptCopiesPast30Days.when).toBe("now");
    expect(NUMBER_TABLES.median!.medianMinutesToDecide!.when).toBe("this week");
    expect(VENDOR_RECORDED_WORDS.when).toBe("this week");
  });

  test("nothing is said twice: the attestations are counted once, and the headline's transcript line is not the section's line again", () => {
    expect(Object.keys(FRESH_CODE_WORDS)).toEqual(["approvalDecisions", "deviceRecoveriesIssued"]);
    expect(HEADLINE_WORDS.transcriptCopiesPast30Days.measures).not.toBe(TRANSCRIPT_WORDS.copiesPast30DaysNow.measures);
    expect(HEADLINE_WORDS.transcriptCopiesPast30Days.measures).toContain("data lifecycle section");
  });

  test("the incidents' two lists say what the builder counts: our target by class, and never one recorded not reportable", () => {
    // Our own target: 24 hours for a reportable class, two business days to a first reply for a service complaint (incidents.ts notifyDeadline).
    const incidents = source("lib/incidents/incidents.ts");
    expect(incidents).toContain("return addBusinessDays(discoveredAt, 2);");
    expect(TARGET_MISSED_HEADING).toBe("Our own target missed (24 hours; for a service complaint, two business days to a first reply)");
    // Both lists leave out an incident recorded not reportable (build.ts readIncidents).
    const build = source("lib/compliance-pack/build.ts");
    expect(build).toContain("if (!decidedNotReportable && (overdueAtEnd || missedInWeek))");
    expect(build).toContain("notifiedByEnd === null && !decidedNotReportable && deadline !== null");
    expect(TARGET_MISSED_WORDS).toContain("never one recorded not reportable");
    expect(AT_RISK_WORDS).toContain("never one recorded not reportable");
  });

  test("who stored a pack (job.ts PACK_SERVICE, pack-ops.ts CONSOLE_SERVICE)", () => {
    expect(source("lib/compliance-pack/job.ts")).toContain('export const PACK_SERVICE = "compliance-pack"');
    expect(source("lib/ops/pack-ops.ts")).toContain('export const CONSOLE_SERVICE = "ops-console"');
    expect(generatedByWords("compliance-pack")).toBe("the weekly compliance-pack job");
    expect(generatedByWords("ops-console")).toBe("the console, by hand");
    expect(generatedByWords("something-else")).toBe("something-else");
  });

  test("the banners and the sentences: never a zero for what was not read, and late by whole days from an hour after the due time", () => {
    expect(couldNotReadWords()).toBe("This section could not be read when the pack was made. Its numbers are missing, not zero.");
    expect(couldNotReadWords(2)).toContain("(2 clinics could not be read)");
    // Incomplete: stored by the job only after the due time plus 48 hours, or by hand after it (pack-ops.ts refuses inside the two days).
    expect(source("lib/compliance-pack/job.ts")).toContain("PARTIAL_AFTER_MS = 48 * 3_600_000");
    expect(source("lib/ops/pack-ops.ts")).toContain("after two days from its due time it is stored with the missing parts marked");
    expect(partialWords(["rights"])).toBe(
      "Incomplete: the Patient rights section could not be read when the pack was made, two or more days after the week was due, so it was stored missing. Its numbers are missing, not zero.",
    );
    expect(partialWords(["rights", "access"])).toContain("2 sections (Patient rights, Access and security events) could not be read");
    expect(partialWords(["rights"])).not.toContain("job did not run");
    // Late: builtLate from an hour after the due time, lateDays the whole days since (job.ts buildInfo), so zero days late is a real case.
    expect(source("lib/compliance-pack/job.ts")).toContain("lateDays: builtLate ? Math.floor(lateMs / 86_400_000) : 0");
    expect(source("lib/compliance-pack/week.ts")).toContain("PACK_HOUR = 7");
    expect(lateWords(0)).toBe(
      "Made after its due time (07:00 New York on the Monday after the week): less than a day late. Its numbers are as of the week's end, except those marked now.",
    );
    expect(lateWords(1)).toContain(": 1 day late.");
    expect(lateWords(3)).toContain(": 3 days late.");
    expect(lateWords(3)).not.toContain("did not run");
    expect(weekWords({ start: "2026-10-26", lastDay: "2026-11-01", timeZone: "America/New_York", from: "2026-10-26T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z" })).toBe(
      "Monday 26 Oct to Sunday 1 Nov 2026, New York",
    );
    expect(minutesWords(1)).toBe("1 minute");
    expect(minutesWords(45)).toBe("45 minutes");
    expect(minutesWords(150)).toBe("2.5 hours");
    expect(minutesWords(60)).toBe("1 hour");
  });
});
