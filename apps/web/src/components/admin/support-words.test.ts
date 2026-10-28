import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { SupportAccountFactsView, SupportDraftView } from "@/lib/admin/ops-client";
import { TRANSCRIPT_STATUSES } from "@/lib/admin/transcript-status";

import {
  accountLines,
  ageWords,
  alertLines,
  CASE_SECTIONS,
  CATEGORY_WORDS,
  CHANNEL_STATUS_WORDS,
  CHECK_NAMES,
  checkName,
  checkWords,
  CLOSE_CHOICES,
  CLOSED_REASON_WORDS,
  CONFIDENCE_WORDS,
  CONNECTION_LABELS,
  CONNECTION_WORDS,
  DRAFT_FAILURE_WORDS,
  draftAuthorWords,
  draftHeadWords,
  DRAFTS_PER_CASE,
  failedRules,
  hiddenWords,
  inboundWords,
  MAX_REPLY_CHARS,
  METER_LABELS,
  NEEDS_YOU_STATES,
  normaliseReply,
  proposeRefusalWords,
  REGENERATE_NOTE,
  regenerateWords,
  REPLY_SUBJECTS,
  replyByWords,
  replySubject,
  rulesClause,
  saveWords,
  sectionOf,
  sendOutcomeWords,
  SIGN_OFF_NOTE,
  SOURCE_WORDS,
  STAGE_LABELS,
  STAGE_STATE_WORDS,
  STATE_NOTES,
  STATE_WORDS,
  SYMPTOM_WORDS,
  symptomWords,
  TEXT_RULE,
  TOOL_WORDS,
  topicWords,
  TRANSCRIPT_STATUS_WORDS,
  transcriptWords,
  URGENCY_TONE,
  URGENCY_WORDS,
  WAITING_ON_WORDS,
  waitingItemWords,
} from "./support-words";

/**
 * The words the Support console puts on apps/app's codes (lane P7d). Each
 * closed list is read out of apps/app's source rather than imported
 * (apps/web must not import from apps/app): a code added there with no words
 * here would reach the operator as a code, and this fails first. Where the
 * words mirror apps/app's own (the facts panel's, written for hello@ in
 * lib/support/account-state.ts; the chat's topics and symptoms), they are
 * held equal word for word.
 */

const APP = join(__dirname, "..", "..", "..", "..", "app", "src");
const source = (path: string) => readFileSync(join(APP, path), "utf8");

/** The quoted words of `export const NAME = [ ... ] as const`. */
function constList(file: string, name: string): string[] {
  const match = new RegExp(`export const ${name}(?::[^=]+)? = \\[([\\s\\S]*?)\\] as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** The quoted word of `export const NAME = "word" as const`. */
function constValue(file: string, name: string): string {
  const match = new RegExp(`export const ${name} = "([a-z_]+)" as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return match[1]!;
}

/** The keys of `const NAME ... = { a: "...", b: "..." }` with their words. */
function wordTable(file: string, name: string): Record<string, string> {
  const block = new RegExp(`const ${name}[^{]*\\{([\\s\\S]*?)\\};`).exec(source(file))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/^\s+([a-z_]+):\s*"([^"]+)",?$/gm)].map((m) => [m[1], m[2]]));
}

/** The members of a string union type: `"a" | "b"`. */
function unionOf(file: string, pattern: RegExp): string[] {
  const match = pattern.exec(source(file));
  if (!match) throw new Error(`${pattern} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("the case's closed lists have words", () => {
  test("every state, with its note, and the states Needs you lists (lib/support/case-vocab.ts)", () => {
    const states = constList("lib/support/case-vocab.ts", "SUPPORT_CASE_STATES");
    expect(states.length).toBe(7);
    expect(Object.keys(STATE_WORDS).sort()).toEqual([...states].sort());
    expect(Object.keys(STATE_NOTES).sort()).toEqual([...states].sort());
    const needsUs = /export const NEEDS_US_STATES[^=]*= \[([^\]]*)\]/.exec(source("lib/support/case-vocab.ts"))?.[1] ?? "";
    expect([...NEEDS_YOU_STATES].sort()).toEqual([...needsUs.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort());
    // The drafter claims only a case that names a clinic (draft/store.ts), so the note on `new` may say so.
    expect(source("lib/support/draft/store.ts")).toContain("isNotNull(supportCases.subjectClinicId)");
    expect(STATE_NOTES.new).toContain("a case with no clinic is never drafted");
  });

  test("every source, urgency and closed reason; Close offers the five an operator picks", () => {
    expect(Object.keys(SOURCE_WORDS).sort()).toEqual(constList("lib/support/case-vocab.ts", "SUPPORT_CASE_SOURCES").sort());
    const urgencies = constList("lib/support/case-vocab.ts", "SUPPORT_CASE_URGENCIES");
    expect(Object.keys(URGENCY_WORDS).sort()).toEqual([...urgencies].sort());
    expect(Object.keys(URGENCY_TONE).sort()).toEqual([...urgencies].sort());
    expect(URGENCY_TONE.now).toBe("bad");
    const reasons = constList("lib/support/case-vocab.ts", "SUPPORT_CLOSED_REASONS");
    expect(Object.keys(CLOSED_REASON_WORDS).sort()).toEqual([...reasons].sort());
    expect(CLOSE_CHOICES).toEqual(["replied_by_hand", "no_reply_needed", "duplicate", "not_a_clinic", "spam"]);
    for (const choice of CLOSE_CHOICES) expect(reasons).toContain(choice);
    // The one reason Close does not offer is the watch's own (lane P7e): nothing in the console writes it.
    expect(reasons.filter((r) => !(CLOSE_CHOICES as readonly string[]).includes(r))).toEqual(["no_further_reply"]);
  });

  test("every topic and symptom, word for word the chat's own (lib/support/escalation-fields.ts)", () => {
    const text = source("lib/support/escalation-fields.ts");
    const block = /export const ESCALATION_TOPICS = \{([\s\S]*?)\n\} as const;/.exec(text)?.[1];
    expect(block).toBeDefined();
    const topics: Record<string, { label: string; symptoms: Record<string, string> }> = {};
    for (const m of block!.matchAll(/\n {2}([a-z_]+): \{\n {4}label: "([^"]+)",\n {4}symptoms: \{([\s\S]*?)\},\n {2}\}/g)) {
      topics[m[1]!] = {
        label: m[2]!,
        symptoms: Object.fromEntries([...m[3]!.matchAll(/([a-z_]+): "([^"]+)"/g)].map((s) => [s[1], s[2]])),
      };
    }
    expect(Object.keys(topics)).toHaveLength(8);
    expect(Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, v.label]))).toEqual(CATEGORY_WORDS);
    expect(Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, v.symptoms]))).toEqual(SYMPTOM_WORDS);
    expect(symptomWords("forwarding", "calls_ring_out")).toBe("Calls ring out unanswered");
    expect(symptomWords("forwarding", "something_new")).toBe("something new");
    expect(topicWords("forwarding", "calls_ring_out")).toBe("Call forwarding: Calls ring out unanswered");
    expect(topicWords("other", "other")).toBe("Something else");
  });

  test("the sections and which state falls in each", () => {
    expect(CASE_SECTIONS.map((s) => s.title)).toEqual(["Needs you", "Waiting on the clinic", "Snoozed", "Closed (30 days)"]);
    expect(CASE_SECTIONS[0].empty).toBe("Nothing needs you here.");
    for (const state of NEEDS_YOU_STATES) expect(sectionOf(state)).toBe("needs-you");
    expect(sectionOf("waiting_clinic")).toBe("waiting-on-the-clinic");
    expect(sectionOf("snoozed")).toBe("snoozed");
    expect(sectionOf("closed")).toBe("closed");
  });

  test("a row's words: hidden counts, the reply day, the age, what came in", () => {
    expect(hiddenWords({ numbers: 0, emails: 0, treatments: 0, clinical: 0 })).toBeNull();
    expect(hiddenWords({ numbers: 2, emails: 1, treatments: 1, clinical: 3 })).toBe("patient details hidden: 2 numbers, 1 email, 1 treatment, 3 clinical matches");
    expect(replyByWords({ replyByOn: "2026-10-28", pastDue: false })).toBe("reply by 28 Oct 2026");
    expect(replyByWords({ replyByOn: "2026-10-28", pastDue: true })).toBe("past its reply day (28 Oct 2026)");
    expect(ageWords(3)).toBe("opened 3 hours ago");
    expect(ageWords(96)).toBe("opened 4 days ago");
    expect(inboundWords({ source: "chat", inboundCount: 2 })).toBe("2 escalations from the portal chat");
    expect(inboundWords({ source: "email", inboundCount: 1 })).toBe("1 email");
  });
});

describe("the draft's closed lists have words", () => {
  test("every check id (lib/support/draft/checks.ts CHECK_IDS) and the send path's own (lib/support/send-checks.ts)", () => {
    const ids = constList("lib/support/draft/checks.ts", "CHECK_IDS");
    expect(ids).toHaveLength(8);
    // The ninth, run only on a draft written from an email (lane P7h).
    ids.push(constValue("lib/support/draft/checks.ts", "EMAIL_CHECK_ID"));
    // The tenth, a claim of a Settings change only when it was made (lane D).
    ids.push(constValue("lib/support/draft/checks.ts", "ACTION_CHECK_ID"));
    const floor = [...source("lib/support/send-checks.ts").matchAll(/id: "([a-z_]+)"/g)].map((m) => m[1]!);
    expect(floor).toContain("send_shape");
    expect(floor).toContain("reply_checks");
    expect(Object.keys(CHECK_NAMES).sort()).toEqual([...new Set([...ids, ...floor])].sort());
    expect(checkName("other_clinics")).toBe("Other practices");
    expect(checkName("brand_new")).toBe("brand new");
    // The rules that failed, each once, as apps/app's failedRules lists them.
    expect(failedRules([{ id: "names", ok: false, rule: "No person" }, { id: "shape", ok: true, rule: "Short" }, { id: "send_tone", ok: false, rule: "No person" }])).toEqual(["No person"]);
  });

  test("every reason the drafter wrote no draft (lib/support/draft/store.ts DRAFT_FAILURES), and the five-draft cap", () => {
    expect(Object.keys(DRAFT_FAILURE_WORDS).sort()).toEqual(constList("lib/support/draft/store.ts", "DRAFT_FAILURES").sort());
    expect(source("lib/support/draft/store.ts")).toContain(`export const DRAFTS_PER_CASE = ${DRAFTS_PER_CASE};`);
    expect(REGENERATE_NOTE).toContain(`at most ${DRAFTS_PER_CASE} drafts a case`);
    // A saved edit costs none of them (lib/support/send.ts saveReplyDraft).
    expect(source("lib/support/send.ts")).toContain("so it costs none of the drafter's five");
    // Each failure as run.ts sets it: no client, a thrown call, a refusal, no proposal, no context, the cap.
    const run = source("lib/support/draft/run.ts");
    for (const failure of ["model_unavailable", "model_failed", "model_refused", "no_proposal", "account_unreadable", "draft_limit"]) {
      expect(run, failure).toContain(`"${failure}"`);
    }
  });

  test("every read tool a fact may come from, and every confidence (lib/support/draft/tools.ts)", () => {
    // The readers, then propose_action's answer (lane D: FACT_TOOL_NAMES).
    expect(Object.keys(TOOL_WORDS).sort()).toEqual(
      [...constList("lib/support/draft/tools.ts", "READ_TOOL_NAMES"), constValue("lib/support/draft/tools.ts", "PROPOSE_ACTION")].sort(),
    );
    expect(Object.keys(CONFIDENCE_WORDS).sort()).toEqual(constList("lib/support/draft/tools.ts", "CONFIDENCE_LEVELS").sort());
  });

  test("who wrote a draft: the drafter always stores a confidence, a saved edit never does", () => {
    // The strict schema requires it, so every drafter draft carries one (tools.ts), and run.ts stores it.
    const tools = source("lib/support/draft/tools.ts");
    const required = /required: \[([\s\S]*?)\]/.exec(tools.slice(tools.indexOf("confidence: {")))?.[1] ?? "";
    expect(required).toContain('"confidence"');
    expect(source("lib/support/draft/run.ts")).toContain("confidence: proposal.confidence");
    // A saved edit's facts_json is `by` and `attempt`, and the change its draft proposed if any (send.ts saveReplyDraft): never a confidence.
    expect(source("lib/support/send.ts")).toContain("factsJson: { by: OPERATOR_MARK, attempt: version, ...(action ? { action } : {}) }");
    expect(draftAuthorWords({ confidence: "high" })).toBe("written by the assistant, confidence high");
    expect(draftAuthorWords({ confidence: null })).toBe("saved from this editor");
    const draft: SupportDraftView = {
      messageId: "9a8b7c6d-1111-4222-8333-444455556666",
      version: 2,
      text: "Hi, the calendar is reconnected.",
      checks: [],
      factsUsed: [],
      questionsForOps: [],
      confidence: null,
      createdAt: "2026-11-03T10:01:00.000Z",
      failure: null,
    };
    expect(draftHeadWords(draft)).toBe("Draft 2, saved from this editor, 3 Nov 2026, 10:01 UTC.");
    expect(draftHeadWords({ ...draft, version: null, text: null, confidence: null, failure: "model_unavailable" })).toBe(
      "No draft: the model is not available on this host (3 Nov 2026, 10:01 UTC).",
    );
    expect(draftHeadWords(null)).toBe("No draft yet.");
  });

  test("the subject per topic is apps/app's, word for word (lib/support/send-vocab.ts), and the email signs itself", () => {
    expect(REPLY_SUBJECTS).toEqual(wordTable("lib/support/send-vocab.ts", "SUPPORT_REPLY_SUBJECTS"));
    expect(source("lib/support/send-vocab.ts")).toContain("return `Re: ${base} (ref ${printedRef})`;");
    expect(replySubject("forwarding", "HD-7F3KQ")).toBe("Re: Your call forwarding (ref HD-7F3KQ)");
    expect(source("lib/email/templates/support_reply.ts")).toContain('{ type: "paragraph", text: SUPPORT_SIGN_OFF }');
    expect(source("lib/support/draft/checks.ts")).toContain("function withoutSignOff(text: string): string");
    expect(SIGN_OFF_NOTE).toContain("The Healdesk Team");
  });

  test("the text rule is apps/app's (lib/support/send.ts MAX_DRAFT_CHARS), and a typed reply is kept the same way", () => {
    expect(source("lib/support/send.ts")).toContain(`export const MAX_DRAFT_CHARS = ${MAX_REPLY_CHARS};`);
    expect(TEXT_RULE).toBe("The text is the reply itself: 1 to 1,500 characters.");
    expect(normaliseReply("Hi, \r\n\r\n\r\n\r\nthanks.  \n")).toBe("Hi,\n\nthanks.");
    expect(normaliseReply("   ")).toBeNull();
    expect(normaliseReply("x".repeat(1501))).toBeNull();
    expect(normaliseReply("x".repeat(1500))).toHaveLength(1500);
  });

  test("the operations' answers in one line each", () => {
    // apps/app's eight rules end in a full stop (checks.ts CHECK_RULES), the floor's do not (send-checks.ts): each loses its own in the list.
    expect(source("lib/support/draft/checks.ts")).toContain('screen: "The reply carries no stranger\'s phone number or email address and no treatment name.",');
    expect(source("lib/support/send-checks.ts")).toContain('rule: "At most one link, and only into the portal",');
    expect(rulesClause(["The reply names no person.", "At most one link, and only into the portal"])).toBe("The reply names no person; At most one link, and only into the portal");
    const checks = [{ id: "names", ok: false, rule: "The reply names no person." }];
    expect(saveWords({ ref: "HD-7F3KQ", draftVersion: 3, state: "needs_edit", approvalId: null, ok: false, checks, failed: ["The reply names no person."], auditRecorded: true })).toBe(
      "Saved as draft 3. It fails: The reply names no person. Edit it and save again.",
    );
    expect(saveWords({ ref: "HD-7F3KQ", draftVersion: 3, state: "drafted", approvalId: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a", ok: true, checks: [], failed: [], auditRecorded: true })).toBe(
      "Saved as draft 3. Every check passed, and it is proposed for your Send.",
    );
    expect(saveWords({ ref: "HD-7F3KQ", draftVersion: 3, state: "drafted", approvalId: null, ok: true, checks: [], failed: [], auditRecorded: true })).toBe("Saved as draft 3. Every check passed.");
    expect(checkWords({ ref: "HD-7F3KQ", ok: true, checks: [], failed: [] })).toBe("Every check passes.");
    expect(checkWords({ ref: "HD-7F3KQ", ok: false, checks, failed: ["The reply names no person."] })).toBe("Fails: The reply names no person.");
    expect(regenerateWords({ outcome: "done", ref: "HD-7F3KQ", state: "new", auditRecorded: true })).toContain("the support-draft job writes the draft when it next runs");
    // The job's name is apps/app's (lib/scheduler/jobs.ts); it is seeded off, so no line says the draft comes at once.
    expect(source("lib/scheduler/jobs.ts")).toContain('export const JOB_SUPPORT_DRAFT = "support-draft";');
    expect(REGENERATE_NOTE).not.toMatch(/at once|now\b/);
    expect(regenerateWords({ outcome: "unchanged", ref: "HD-7F3KQ", state: "new", auditRecorded: true })).toBe("A new draft was already asked for.");
    expect(proposeRefusalWords({ outcome: "checks_failed", ref: "HD-7F3KQ", approvalId: null, draftVersion: 2, failed: ["The reply names no person."], auditRecorded: true })).toBe(
      "Nothing was sent: the saved draft fails: The reply names no person. Edit it, press Save draft, then Send.",
    );
  });

  test("Send's outcome, true to the executor (lib/approvals/support-reply.ts) and the send (lib/support/send.ts recordSent)", () => {
    // A sent reply moves the case to waiting on the clinic where case-vocab.ts allows the move (since the Phase 7 review, from snoozed too), so the line claims the send alone.
    expect(source("lib/support/send.ts")).toContain('canMove(c.state, "waiting_clinic")');
    expect(source("lib/support/case-vocab.ts")).toContain('snoozed: ["new", "drafted", "needs_edit", "waiting_clinic", "closed", "snoozed"],');
    expect(sendOutcomeWords({ status: "executed", outcomeCode: "sent", message: null, auditRecorded: true })).toEqual({
      ok: true,
      text: "Sent to the practice's one sign-in address.",
      auditRecorded: true,
    });
    const retrying = "Approved, but the first try did not go, so the clinic has not received it yet.";
    expect(sendOutcomeWords({ status: "executed", outcomeCode: "send_retrying", message: retrying, auditRecorded: true })).toMatchObject({ ok: true, text: retrying });
    const failed = "Nothing was sent: the reply fails The reply names no person. Edit it and propose it again.";
    expect(sendOutcomeWords({ status: "failed", outcomeCode: "checks_failed", message: failed, auditRecorded: true })).toEqual({ ok: false, text: failed, auditRecorded: true });
    expect(sendOutcomeWords({ status: "failed", outcomeCode: "clinic_left", message: null, auditRecorded: true }).text).toBe("Not sent: the practice has no sign-in address any more.");
    expect(sendOutcomeWords({ status: "code_refused", message: "That code is not right." })).toEqual({ ok: false, text: "That code is not right.", auditRecorded: null });
    expect(sendOutcomeWords({ status: "refused", message: "No such approval." })).toMatchObject({ ok: false, text: "No such approval." });
    expect(sendOutcomeWords({ status: "not_proposed", message: "Nothing was sent: x" })).toMatchObject({ ok: false, text: "Nothing was sent: x" });
    // Every refusal the executor can give has words in the approval words (fail("<code>") in support-reply.ts).
    const codes = [...source("lib/approvals/support-reply.ts").matchAll(/fail\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes).toContain("checks_failed");
    expect(codes).toContain("subject_changed");
    expect(codes).toContain("clinic_left");
    expect(codes).toContain("not_a_reply");
    for (const code of codes) {
      expect(sendOutcomeWords({ status: "failed", outcomeCode: code, message: null, auditRecorded: true }).text, code).not.toMatch(/_/);
    }
    expect(waitingItemWords({ proposedAt: "2026-11-03T10:01:00.000Z", packet: null })).toBe("Reply waiting for your Send since 3 Nov 2026, 10:01 UTC");
  });
});

describe("the facts panel mirrors apps/app's words for hello@ (lib/support/account-state.ts)", () => {
  test("stages, their states, channel statuses, connections and meters, word for word", () => {
    expect(STAGE_LABELS).toEqual(wordTable("lib/support/account-state.ts", "STAGE_LABELS"));
    expect(STAGE_STATE_WORDS).toEqual(wordTable("lib/support/account-state.ts", "STAGE_WORDS"));
    expect(CHANNEL_STATUS_WORDS).toEqual(wordTable("lib/support/account-state.ts", "CHANNEL_STATUS_WORDS"));
    expect(CONNECTION_LABELS).toEqual(wordTable("lib/support/account-state.ts", "CONNECTION_LABELS"));
    expect(CONNECTION_WORDS).toEqual(wordTable("lib/support/account-state.ts", "CONNECTION_WORDS"));
    expect(METER_LABELS).toEqual(wordTable("lib/support/account-state.ts", "METER_LABELS"));
    // The closed lists behind them.
    expect(Object.keys(STAGE_LABELS).sort()).toEqual(unionOf("lib/setup/tracker.ts", /export type StageId =([\s\S]*?);/).sort());
    expect(Object.keys(STAGE_STATE_WORDS).sort()).toEqual(unionOf("lib/setup/tracker.ts", /export type StageState = ([^;]+);/).sort());
    expect(Object.keys(CHANNEL_STATUS_WORDS).sort()).toEqual(unionOf("lib/channels/state.ts", /export type ChannelStatus = ([^;]+);/).sort());
    expect(Object.keys(CONNECTION_LABELS).sort()).toEqual(unionOf("lib/support/account-state.ts", /resource: ([^;]+);/).sort());
    expect(Object.keys(CONNECTION_WORDS).sort()).toEqual(unionOf("lib/support/account-state.ts", /\n {2}status: ("not_connected"[^;]+);/).sort());
  });

  test("what a channel waits on: the schema's list plus the two setup steps (db/schema.ts, lib/setup/channels.ts)", () => {
    const waitingOn = constList("db/schema.ts", "CHANNEL_WAITING_ON");
    expect(waitingOn.length).toBeGreaterThan(4);
    expect(Object.keys(WAITING_ON_WORDS).sort()).toEqual([...waitingOn, "finish_setup", "preparing"].sort());
    expect(source("lib/setup/channels.ts")).toContain('"finish_setup" | ChannelWaitingOn | "preparing" | "none"');
    // Each step's words are actionLine's, read about the practice ("its") rather than to it ("your").
    const lines = source("lib/setup/channels.ts");
    expect(lines).toContain('return "Set call forwarding on your main line";');
    expect(WAITING_ON_WORDS.forwarding).toBe("set call forwarding on its main line");
    expect(lines).toContain('return "Add a payment method to your WhatsApp account in Meta";');
    expect(WAITING_ON_WORDS.whatsapp_payment_method).toBe("add a payment method to its WhatsApp account in Meta");
  });

  test("every transcript email status (lib/admin/transcript-status.ts), and the counts in words", () => {
    expect(Object.keys(TRANSCRIPT_STATUS_WORDS).sort()).toEqual([...TRANSCRIPT_STATUSES].sort());
    expect(transcriptWords({ delivered: 2, bounced: 1, open: 0 })).toBe("2 delivered, 1 bounced");
    expect(transcriptWords({ delivered: 0 })).toBe("none");
  });

  test("the account's lines, in hello@'s order, with flags where hello@ reads numbers", () => {
    const account: SupportAccountFactsView = {
      clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      isClosed: false,
      isSetupFinished: false,
      setupStepsLeftCount: 2,
      setupDeadlineAt: "2026-11-20T04:59:59.000Z",
      stageRows: [
        { code: "agreement", status: "done" },
        { code: "calendar", status: "not_done" },
      ],
      channelRows: [
        { channel: "voice", status: "waiting", waitingOn: "forwarding", isEnabled: true, liveAt: null },
        { channel: "web", status: "live", waitingOn: null, isEnabled: false, liveAt: "2026-10-20T09:00:00.000Z" },
      ],
      isPaused: true,
      pausedUntilAt: null,
      mode: "overflow_after_hours",
      carrier: "verizon",
      phoneSystem: "voip",
      isUrgentHelpSet: false,
      isTransferOn: true,
      isDailySummaryOn: true,
      isDepositsOn: false,
      connectionRows: [
        { resource: "google_calendar", status: "error" },
        { resource: "payment_account", status: "not_connected" },
      ],
      planId: "voice-webchat-100-200",
      interval: "month",
      status: "active",
      isPlanStarted: false,
      planStartedAt: null,
      isAutoRenewOn: true,
      closesOn: null,
      overageMode: "allow",
      isUsageAlertsOn: null,
      hasOpenInvoice: true,
      graceEndsAt: "2026-11-05",
      usageRows: [{ meter: "voice_minutes", used: 40, included: 100 }],
      isAddressUndeliverable: true,
      isPublishedPhoneSet: true,
      isDirectLineSet: false,
    };
    const lines = accountLines(account);
    expect(lines).toEqual([
      ["Setup", "not finished: 2 of 4 steps still to do"],
      ["Setup must be finished by", "20 Nov 2026"],
      ["Build: Agreement signed", "done"],
      ["Build: Calendar", "not yet"],
      ["Channel: Phone", "ready on healdesk's side, waiting on the practice; waiting on the practice to set call forwarding on its main line"],
      ["Channel: Website chat", "live (switched off in Settings), live since 20 Oct 2026"],
      ["AYA paused", "until someone turns her back on"],
      ["Which calls reach AYA", "Overflow and after hours"],
      ["Phone carrier", "Verizon"],
      ["Phone system", "cloud phone system"],
      ["Direct line", "not set"],
      ["Main phone number", "set"],
      ["Urgent-help number", "not set"],
      ["Transfer live calls", "on"],
      ["Daily summary email", "on"],
      ["Take deposits", "off"],
      ["Google Calendar", "broken: bookings arrive as requests until it is reconnected"],
      ["Payment account (Stripe)", "not connected"],
      ["Package", "AYA Voice + Web Chat, 100 minutes and 200 conversations"],
      ["Billing", "monthly"],
      ["Subscription status", "active"],
      ["Plan started", "not yet: it starts the day AYA first answers a patient or client"],
      ["Auto-renew", "on"],
      ["When the monthly allowance runs out", "keep going and bill the extra in blocks of 100"],
      ["Unpaid invoice", "yes, see the Billing tab"],
      ["Payment grace period ends", "5 Nov 2026"],
      ["Used this period: Voice minutes", "40 of 100"],
      ["The practice's email address", "undeliverable: mail to it bounced or was refused"],
    ]);
    // No number crosses: the flags stand for them.
    for (const [, value] of lines) expect(value).not.toMatch(/\+?\d{7,}/);
    // A stage, status or meter nobody listed is printed as its own words, never dropped.
    const odd = accountLines({ ...account, stageRows: [{ code: "brand_new", status: "half" }], usageRows: [{ meter: "faxes", used: 1, included: 2 }], status: "weird_state" });
    expect(odd).toContainEqual(["Build: brand new", "half"]);
    expect(odd).toContainEqual(["Used this period: faxes", "1 of 2"]);
    expect(odd).toContainEqual(["Subscription status", "weird state"]);
  });

  test("the alerts of the window as names and times", () => {
    expect(alertLines([{ event: "calendar_broken", raisedAt: "2026-11-01T09:00:00.000Z", lastRaisedAt: "2026-11-02T10:01:00.000Z", repeats: 3 }])).toEqual([
      "calendar broken, last 2 Nov 2026, 10:01 UTC (3 times)",
    ]);
    expect(alertLines([{ event: "go_live_held", raisedAt: "2026-11-01T09:00:00.000Z", lastRaisedAt: "2026-11-01T09:00:00.000Z", repeats: 1 }])).toEqual(["go live held, last 1 Nov 2026, 09:00 UTC"]);
  });

  test("the words are plain: no underscores, no raw codes", () => {
    for (const table of [STATE_WORDS, SOURCE_WORDS, URGENCY_WORDS, CLOSED_REASON_WORDS, CATEGORY_WORDS, CHECK_NAMES, DRAFT_FAILURE_WORDS, TOOL_WORDS, CONFIDENCE_WORDS, TRANSCRIPT_STATUS_WORDS, WAITING_ON_WORDS, CONNECTION_WORDS, STAGE_LABELS, STAGE_STATE_WORDS, CHANNEL_STATUS_WORDS]) {
      for (const [code, words] of Object.entries(table)) {
        expect(words, code).not.toMatch(/_/);
        expect(words, code).toMatch(/^[A-Za-z]/);
      }
    }
    for (const symptoms of Object.values(SYMPTOM_WORDS)) for (const words of Object.values(symptoms)) expect(words).not.toMatch(/_/);
  });
});
