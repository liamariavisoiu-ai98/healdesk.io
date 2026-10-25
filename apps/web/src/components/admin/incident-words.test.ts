import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { IncidentBatchFacts, IncidentReportFacts } from "@/lib/admin/ops-client";

import {
  AGREEMENT_DEADLINE_LABEL,
  BATCH_CLASS_WORDS,
  batchClinicState,
  batchCountWords,
  CHECKLIST_STEP_WORDS,
  deadlineWords,
  INTERNAL_TARGET_LABEL,
  REACH_WORDS,
  reportFactLines,
  reportReady,
  reportWords,
  RULE_WORDS,
  SCOPE_CHANNEL_WORDS,
  scopeWords,
  shownWords,
  STEP_NEEDS,
  TICK_WORDS,
  VENDOR_WORDS,
} from "./incident-words";

/**
 * The words the console puts on the incident assistant's codes. Each closed
 * list is read out of apps/app's source (apps/web imports nothing from
 * apps/app), so a code added there with no words here fails first; and the
 * internal target is never printed without its label.
 */

const APP = join(__dirname, "..", "..", "..", "..", "app", "src");
const source = (path: string) => readFileSync(join(APP, path), "utf8");

function constList(file: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("the closed lists have words", () => {
  test("every vendor, channel, reach, class and checklist step (lib/incidents/assistant/vocab.ts)", () => {
    const vocab = "lib/incidents/assistant/vocab.ts";
    expect(Object.keys(VENDOR_WORDS).sort()).toEqual(constList(vocab, "SCOPE_VENDORS").sort());
    expect(Object.keys(SCOPE_CHANNEL_WORDS).sort()).toEqual(constList(vocab, "SCOPE_CHANNELS").sort());
    expect(Object.keys(REACH_WORDS).sort()).toEqual(constList(vocab, "SCOPE_REACHES").sort());
    expect(Object.keys(BATCH_CLASS_WORDS).sort()).toEqual(constList(vocab, "BATCH_CLASSES").sort());
    // In the procedure's order, as the checklist is drawn.
    expect(Object.keys(CHECKLIST_STEP_WORDS)).toEqual(constList(vocab, "CHECKLIST_STEPS"));
    for (const step of Object.keys(STEP_NEEDS)) expect(Object.keys(CHECKLIST_STEP_WORDS)).toContain(step);
  });

  test("the vendors' words are the alerts' own (lib/ops/alert-wording/words.ts VENDOR_WORDS), Meta added", () => {
    const block = /export const VENDOR_WORDS[^{]*\{([\s\S]*?)\};/.exec(source("lib/ops/alert-wording/words.ts"))?.[1] ?? "";
    const theirs = Object.fromEntries([...block.matchAll(/([a-z_]+): "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    for (const [code, words] of Object.entries(theirs)) expect(VENDOR_WORDS[code as keyof typeof VENDOR_WORDS], code).toBe(words);
  });

  test("the two reporting rules (lib/incidents/reporting-rules.ts) and the tick refusals' two steps (lib/incidents/assistant/checklist.ts)", () => {
    const rules = /export type ReportingRule = ([^;]+);/.exec(source("lib/incidents/reporting-rules.ts"))?.[1] ?? "";
    expect(Object.keys(RULE_WORDS).sort()).toEqual([...rules.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort());
    const checklist = source("lib/incidents/assistant/checklist.ts");
    expect(checklist).toContain('input.step === "notify_email"');
    expect(checklist).toContain('input.step === "resolve"');
    expect(Object.keys(STEP_NEEDS).sort()).toEqual(["notify_email", "resolve"]);
  });

  test("the words are plain", () => {
    for (const table of [VENDOR_WORDS, SCOPE_CHANNEL_WORDS, REACH_WORDS, BATCH_CLASS_WORDS, CHECKLIST_STEP_WORDS, RULE_WORDS]) {
      for (const [code, words] of Object.entries(table)) {
        expect(words, code).not.toMatch(/_/);
        expect(words, code).toMatch(/^[A-Za-z0-9]/);
      }
    }
    expect(TICK_WORDS).toContain("does not do the step");
  });
});

const clocks = {
  internalTarget: "2026-11-04T08:00:00.000Z",
  agreementDeadline: "2027-01-02T08:00:00.000Z",
  agreementRule: "sixty_calendar_days" as const,
  ownerNoticeBy: null,
};

const batch: IncidentBatchFacts = {
  kind: "incident_open_batch",
  source: "vendor",
  value: "database_host",
  reach: "all_holding",
  from: "2026-10-30T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  incidentClass: "breach",
  discoveredAt: "2026-11-03T08:00:00.000Z",
  clinicsTotal: 25,
  toOpen: 22,
  alreadyOpen: 2,
  outOfService: 1,
  clinics: Array.from({ length: 20 }, (_, i) => ({
    clinicId: `3fa85f64-5717-4562-b3fc-2c963f66af${String(i).padStart(2, "0")}`,
    clinicName: `Clinic ${i}`,
    conversations: i,
    agreementVersion: "1.5.1",
    clocks,
    opened: i === 0,
    inService: i !== 1,
  })),
};

describe("the lines", () => {
  test("a scope, its reach and its counts; the first 20 of more", () => {
    expect(scopeWords(batch)).toBe("the database host's incident, window 30 Oct 2026, 00:00 UTC to 31 Oct 2026, 00:00 UTC");
    expect(scopeWords({ ...batch, source: "channel", value: "web" })).toBe("an incident on our website chat channel, window 30 Oct 2026, 00:00 UTC to 31 Oct 2026, 00:00 UTC");
    expect(REACH_WORDS[batch.reach]).toBe("every clinic holding data");
    expect(batchCountWords(batch)).toBe("25 clinics listed: 22 to open, 2 already open, 1 out of service");
    expect(batchCountWords({ clinicsTotal: 1, toOpen: 1, alreadyOpen: 0, outOfService: 0 })).toBe("1 clinic listed: 1 to open");
    expect(shownWords(batch)).toBe("The first 20 of 25, soonest agreement deadline first; the counts cover all 25.");
    expect(shownWords({ clinicsTotal: 2, clinics: batch.clinics.slice(0, 2) })).toBeNull();
    // A word or two: the packet's effect sentence already says what is done with an open or out-of-service clinic, once.
    expect(batchClinicState(batch.clinics[0]!)).toBe("already open");
    expect(batchClinicState(batch.clinics[1]!)).toBe("out of service");
    expect(batchClinicState(batch.clinics[2]!)).toBe("to open");
  });

  test("the agreement's deadline with its basis, and the rule in words where one is given", () => {
    expect(deadlineWords(clocks.agreementDeadline, "1.5.1", "sixty_calendar_days")).toBe("2 Jan 2027 (agreement 1.5.1: no later than 60 calendar days after discovery)");
    expect(deadlineWords("2026-11-08T08:00:00.000Z", null, "five_days")).toBe(
      "8 Nov 2026 (no agreement on file, so the strictest rule: five calendar days for a breach, five business days otherwise (BAA 1.2.1 and before))",
    );
    expect(deadlineWords("2026-11-08T08:00:00.000Z", "1.5.1")).toBe("8 Nov 2026 (agreement 1.5.1)");
    expect(deadlineWords(null, "1.5.1")).toBe("none");
    expect(INTERNAL_TARGET_LABEL).toBe("Our own target (never shown to the clinic)");
    // The five-day rule is 1.2.1 and before (reporting-rules.ts); no agreement, or a version the map does not know, gets it as the strictest.
    expect(RULE_WORDS.five_days).not.toContain("no agreement");
  });

  test("a report's facts: which report, both clocks, the people recorded as a count, the steps ticked; and whether it may go", () => {
    const report: IncidentReportFacts = {
      kind: "incident_report_send",
      incidentId: "1c6ffee6-7777-4c80-9041-7f8f9eabbcc1",
      incidentClass: "breach",
      report: 2,
      discoveredAt: "2026-11-01T08:00:00.000Z",
      internalTarget: "2026-11-02T08:00:00.000Z",
      agreementDeadline: null,
      agreementVersion: null,
      ownerNoticeBy: "2026-12-01T08:00:00.000Z",
      affectedRecorded: 0,
      ticked: [],
      fields: { event: null, occurredOn: null, info: [], mitigations: [], steps: [], recommendations: [], delayedByLawEnforcement: false, delayEndedOn: null },
    };
    expect(reportWords(1)).toBe("the report");
    expect(reportWords(3)).toBe("update 2");
    expect(reportFactLines(report)).toEqual([
      ["Report", "update 1, for breach of unsecured phi"],
      ["Discovered", "1 Nov 2026, 08:00 UTC"],
      [AGREEMENT_DEADLINE_LABEL, "none"],
      [INTERNAL_TARGET_LABEL, "2 Nov 2026, 08:00 UTC"],
      ["The practice tells the people affected by", "1 Dec 2026"],
      ["People recorded as affected", "0"],
      ["Checklist steps ticked", "none yet"],
    ]);
    expect(reportFactLines({ ...report, agreementDeadline: "2026-11-06T08:00:00.000Z" })[2]).toEqual([AGREEMENT_DEADLINE_LABEL, "6 Nov 2026 (no agreement on file, so the strictest rule)"]);
    expect(reportReady(report)).toBe(false);
    expect(reportReady(report, "other")).toBe(true);
  });

  test("the words the card no longer repeats are apps/app's to leave out: its report effect names neither the deadline nor the missing choice", () => {
    const kinds = readFileSync(join(APP, "lib", "approvals", "incident-kinds.ts"), "utf8");
    const effect = kinds.slice(kinds.indexOf("export function reportEffect"), kinds.indexOf("export type IncidentPacket"));
    expect(effect).not.toContain("Pick what happened");
    expect(effect).not.toContain("agreement deadline");
    expect(effect).toContain("Phone the practice as well");
  });
});
