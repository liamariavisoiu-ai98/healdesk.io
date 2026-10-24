import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { RightsRowView } from "@/lib/admin/ops-client";

import {
  ASKED_FOR_WORDS,
  closedWords,
  closesWords,
  daysLeftWords,
  kindWords,
  MARK_DONE_CONFIRM,
  noCommandWords,
  onDay,
  recordedWords,
  RETELL_NOT_RECORDED,
  retellWords,
  RIGHTS_KIND_WORDS,
  RUNS_NOTHING,
  STATE_WORDS,
  VERIFICATION_WORDS,
} from "./rights-words";

/**
 * The words the Patient rights page puts on apps/app's codes. Each closed
 * list is read out of apps/app's source rather than imported (apps/web must
 * not import from apps/app): a code added there with no words here would
 * reach the operator as a code, and this fails first.
 */

const APP = join(__dirname, "..", "..", "..", "..", "app", "src");
const source = (path: string) => readFileSync(join(APP, path), "utf8");

function constList(file: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INTAKE = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const RECORD = "9a8b7c6d-1111-4222-8333-444455556666";

const toRun: RightsRowView = {
  id: INTAKE,
  source: "intake",
  intakeId: INTAKE,
  recordId: null,
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  kind: "patient_request",
  askedFor: "access",
  verifiedVia: "unverified",
  receivedOn: "2026-10-21",
  dueOn: "2026-10-28",
  dueDerived: false,
  daysLeft: 4,
  state: "on_time",
  command: `bash infra/aws/scripts/run-task.sh patient-request ${CLINIC} access ops@healdesk.test 2026-10-21`,
  commandNote: null,
  retellStep: null,
  backupExpiresOn: null,
  closedOn: null,
};

describe("the closed lists have words", () => {
  test("every kind, verification and asked-for value (db/schema.ts)", () => {
    expect(Object.keys(RIGHTS_KIND_WORDS).sort()).toEqual(constList("db/schema.ts", "RIGHTS_KINDS").sort());
    expect(Object.keys(VERIFICATION_WORDS).sort()).toEqual(constList("db/schema.ts", "RIGHTS_VERIFICATIONS").sort());
    expect(Object.keys(ASKED_FOR_WORDS).sort()).toEqual(constList("db/schema.ts", "PATIENT_REQUEST_KINDS").sort());
  });

  test("every state a row can carry (lib/rights/tracker.ts)", () => {
    const union = /export type RightsState = ([^;]+);/.exec(source("lib/rights/tracker.ts"))?.[1] ?? "";
    const states = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(states.length).toBeGreaterThan(3);
    expect(Object.keys(STATE_WORDS).sort()).toEqual(states.sort());
    for (const { label } of Object.values(STATE_WORDS)) expect(label).not.toMatch(/_/);
  });

  test("the Retell refusal starts with apps/app's own sentence (lib/rights/tracker.ts RETELL_OUTSTANDING)", () => {
    const theirs = /export const RETELL_OUTSTANDING = "([^"]+)"/.exec(source("lib/rights/tracker.ts"))?.[1];
    expect(theirs).toBeDefined();
    expect(RETELL_NOT_RECORDED.startsWith(theirs!)).toBe(true);
    expect(RETELL_NOT_RECORDED).toContain("Care tab");
  });

  test("the fixed lines", () => {
    expect(RUNS_NOTHING).toBe("This page runs nothing. You run each command yourself.");
    expect(MARK_DONE_CONFIRM).toContain("cannot be reopened");
    for (const table of [RIGHTS_KIND_WORDS, ASKED_FOR_WORDS, VERIFICATION_WORDS]) {
      for (const [code, words] of Object.entries(table)) expect(words, code).not.toMatch(/_/);
    }
  });
});

describe("a row's words", () => {
  test("the kind, with what a patient asked for", () => {
    expect(kindWords(toRun)).toBe("A patient's own request, to pass on: to see their information");
    expect(kindWords({ kind: "erasure", askedFor: null })).toBe("Erasure");
    expect(kindWords({ kind: "patient_request", askedFor: null })).toBe("A patient's own request, to pass on");
  });

  test("business days left, never 0 while overdue", () => {
    expect(daysLeftWords({ daysLeft: 4, state: "on_time" })).toBe("4 business days left");
    expect(daysLeftWords({ daysLeft: 1, state: "due_soon" })).toBe("1 business day left");
    expect(daysLeftWords({ daysLeft: 0, state: "due_soon" })).toBe("due today");
    expect(daysLeftWords({ daysLeft: -1, state: "overdue" })).toBe("1 business day past");
    expect(daysLeftWords({ daysLeft: -3, state: "blocked" })).toBe("3 business days past");
    expect(daysLeftWords({ daysLeft: 0, state: "overdue" })).toBe("past its day");
    expect(daysLeftWords({ daysLeft: null, state: "done" })).toBe("");
  });

  test("the Retell step, for an erasure alone", () => {
    expect(retellWords({ kind: "erasure", retellStep: "stamped" })).toBe("recorded");
    expect(retellWords({ kind: "erasure", retellStep: "outstanding" })).toBe("outstanding: record it on the clinic's Care tab");
    expect(retellWords({ kind: "erasure", retellStep: null })).toBe("not run yet");
    expect(retellWords({ kind: "export", retellStep: null })).toBeNull();
  });

  test("what stands where a command would", () => {
    expect(noCommandWords(toRun)).toBeNull();
    const blocked = { ...toRun, kind: "erasure" as const, command: null, commandNote: "No portal route yet turns this request into a contact id" as const, state: "blocked" as const };
    expect(noCommandWords(blocked)).toBe("No portal route yet turns this request into a contact id");
    expect(noCommandWords({ ...toRun, command: null, state: "done" })).toBeNull();
    expect(noCommandWords({ ...toRun, kind: "erasure", command: null, recordId: RECORD })).toBe("Nothing to run: the deletion has run on the host.");
    expect(noCommandWords({ ...toRun, command: null, recordId: RECORD })).toBe("Nothing to run: it is on the host, passed to the practice.");
    expect(noCommandWords({ ...toRun, kind: "export", command: null })).toBe("No command for this request.");
  });

  test("how a row with no intake closes", () => {
    expect(closesWords(toRun)).toBeNull();
    expect(closesWords({ intakeId: null, state: "on_time", source: "erasure_request", kind: "erasure", recordId: RECORD })).toBe("Done once its Retell step is recorded");
    expect(closesWords({ intakeId: null, state: "due_soon", source: "patient_request", kind: "patient_request", recordId: RECORD })).toBe(
      "Done once the practice marks it received",
    );
    expect(closesWords({ intakeId: null, state: "done", source: "record_amendment", kind: "amendment", recordId: RECORD })).toBeNull();
  });

  test("the outcomes of Mark done and Record a request, and a day", () => {
    expect(closedWords({ outcome: "closed", status: "done" })).toBe("Marked done.");
    expect(closedWords({ outcome: "already_closed", status: "done" })).toBe("It was already marked done.");
    expect(closedWords({ outcome: "already_closed", status: "not_applicable" })).toBe("It was already closed as not applicable.");
    expect(recordedWords({ outcome: "recorded", dueOn: "2026-10-28" })).toBe("Recorded. It is due on 28 Oct 2026.");
    expect(recordedWords({ outcome: "already_recorded", dueOn: "2026-10-28" })).toBe(
      "Already recorded from this form, so nothing was added. It is due on 28 Oct 2026.",
    );
    expect(onDay("2026-01-05")).toBe("5 Jan 2026");
  });
});
