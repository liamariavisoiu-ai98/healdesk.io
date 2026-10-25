import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ApprovalItem } from "@/lib/admin/ops-client";

import {
  actorWords,
  APPROVAL_FAMILIES,
  APPROVAL_KIND_WORDS,
  APPROVALS_JOB,
  approveConfirm,
  APPROVE_REASON_WORDS,
  approveReasonsFor,
  BILLING_STATUS_WORDS,
  BILLING_TAB_RETRY,
  CHASE_BLOCK_WORDS,
  decisionWords,
  dollars,
  EMPTY_JOB_OFF,
  EMPTY_WORDS,
  emptyWords,
  engineWords,
  EVENT_WORDS,
  eventTypeWords,
  expiryWords,
  factLines,
  familyOf,
  IRREVERSIBLE_CONFIRM,
  isClinicless,
  NO_CLINIC_EVENT,
  NOTE_WORDS,
  onDay,
  OUTCOME_WORDS,
  outcomeWords,
  PHRASE_WORDS,
  RECOMMENDATION_WORDS,
  REJECT_HEAD,
  REJECT_REASON_WORDS,
  rejectConfirm,
  REMINDER_BLOCK_WORDS,
  REQUEST_KIND_WORDS,
  RESIGN_REASON_WORDS,
  REVIEW_STATUS_WORDS,
  STAGE_WORDS,
  STOP_REASON_WORDS,
  waitingWords,
  whenWords,
} from "./approval-words";

/**
 * The words the Approvals section puts on apps/app's codes. Each closed list
 * is read out of apps/app's source rather than imported (apps/web must not
 * import from apps/app): a code added there with no words here would reach
 * the operator as a code, and this fails first.
 */

const APP = join(__dirname, "..", "..", "..", "..", "app", "src");
const source = (path: string) => readFileSync(join(APP, path), "utf8");

/** The quoted words of `export const NAME = [ ... ] as const`. */
function constList(file: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source(file));
  if (!match) throw new Error(`apps/app's ${name} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** The quoted words of a union type `"a" | "b" | null` on the line that declares `name`. */
function unionOf(file: string, pattern: RegExp): string[] {
  const match = pattern.exec(source(file));
  if (!match) throw new Error(`${pattern} was not found in ${file}`);
  return [...match[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** Every `outcomeCode: "<code>"` literal a file records. */
function outcomeCodesIn(file: string): string[] {
  return [...new Set([...source(file).matchAll(/outcomeCode: "([a-z_]+)"/g)].map((m) => m[1]!))];
}

/** The keys of `export const NAME ... = { a: "...", b: "..." }` with their words. */
function wordTable(file: string, name: string): Record<string, string> {
  const block = new RegExp(`export const ${name}[^{]*\\{([\\s\\S]*?)\\};`).exec(source(file))?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/^\s+([a-z_]+):\s*"([^"]+)",?$/gm)].map((m) => [m[1], m[2]]));
}

describe("the closed lists have words", () => {
  test("every approval kind, request kind and event name (db/schema.ts)", () => {
    expect(Object.keys(APPROVAL_KIND_WORDS).sort()).toEqual(constList("db/schema.ts", "APPROVAL_KINDS").sort());
    expect(Object.keys(REQUEST_KIND_WORDS).sort()).toEqual(constList("db/schema.ts", "BILLING_REQUEST_KINDS").sort());
    expect(Object.keys(EVENT_WORDS).sort()).toEqual(constList("db/schema.ts", "APPROVAL_EVENTS").sort());
  });

  test("every kind is in one of the three groups, which are apps/app's families (lib/approvals/kinds.ts KIND_FAMILY)", () => {
    const block = /export const KIND_FAMILY[^{]*\{([\s\S]*?)\};/.exec(source("lib/approvals/kinds.ts"))?.[1] ?? "";
    const theirs = Object.fromEntries([...block.matchAll(/([a-z_]+): "([a-z]+)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(theirs).sort()).toEqual(Object.keys(APPROVAL_KIND_WORDS).sort());
    for (const kind of Object.keys(APPROVAL_KIND_WORDS) as (keyof typeof APPROVAL_KIND_WORDS)[]) expect(familyOf(kind), kind).toBe(theirs[kind]);
    expect([...APPROVAL_FAMILIES].sort()).toEqual([...new Set(Object.values(theirs))].sort());
    // The legal clocks lead.
    expect(APPROVAL_FAMILIES[0]).toBe("incident");
  });

  test("the request kind words are the alerts' own (lib/ops/alert-wording/words.ts)", () => {
    const block = /export const REQUEST_KIND_WORDS[^{]*\{([\s\S]*?)\};/.exec(source("lib/ops/alert-wording/words.ts"))?.[1] ?? "";
    const theirs = Object.fromEntries([...block.matchAll(/([a-z_]+): "([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(theirs).toEqual(REQUEST_KIND_WORDS);
  });

  test("every approve and reject reason (lib/approvals/kinds.ts), in the selects and in the history", () => {
    const approve = constList("lib/approvals/kinds.ts", "APPROVE_REASONS");
    const reject = constList("lib/approvals/kinds.ts", "REJECT_REASONS");
    expect(approve.length).toBeGreaterThan(1);
    expect(reject.length).toBeGreaterThan(1);
    expect(Object.keys(APPROVE_REASON_WORDS).sort()).toEqual(approve.sort());
    expect(Object.keys(REJECT_REASON_WORDS).sort()).toEqual(reject.sort());
    for (const code of [...approve, ...reject]) expect(OUTCOME_WORDS[code], code).toBeDefined();
    // The reasons offered per kind, the first the default: every reason for a billing retry; for an email or an incident step, that the owner checked it.
    expect([...approveReasonsFor("billing_request_retry")].sort()).toEqual([...approve].sort());
    expect(approveReasonsFor("overage_invoice_retry")[0]).toBe("cause_fixed");
    for (const kind of ["baa_resign_chase", "agreement_question", "setup_extended", "setup_waiting_on_us", "setup_help_offer", "setup_reminder_now", "incident_open_batch", "incident_report_send"] as const) {
      expect([...approveReasonsFor(kind)], kind).toEqual(["owner_checked"]);
    }
  });

  test("why a request stopped (lib/approvals/packets.ts)", () => {
    const union = /reasonCode: ((?:"[a-z_]+" \| )+)null;/.exec(source("lib/approvals/packets.ts"))?.[1] ?? "";
    const codes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(1);
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual(codes.sort());
  });

  test("every outcome code the executors, the store and the proposers record, the clinic-contact and incident ones included", () => {
    const codes = [
      ...outcomeCodesIn("lib/approvals/executors.ts"),
      ...outcomeCodesIn("lib/approvals/store.ts"),
      ...outcomeCodesIn("lib/approvals/proposers.ts"),
      ...outcomeCodesIn("lib/approvals/contact-executors.ts"),
      ...outcomeCodesIn("lib/approvals/contact-proposers.ts"),
      ...outcomeCodesIn("lib/approvals/incident-kinds.ts"),
      // contact-executors.ts records its failures through fail("<code>", ...).
      ...[...source("lib/approvals/contact-executors.ts").matchAll(/fail\("([a-z_]+)"/g)].map((m) => m[1]!),
    ];
    expect(codes).toContain("rearmed");
    expect(codes).toContain("window_passed");
    expect(codes).toContain("send_failed");
    expect(codes).toContain("superseded_by_next_round");
    // incident-kinds.ts picks between the two in one expression.
    expect(source("lib/approvals/incident-kinds.ts")).toContain('"opened" : "partly_opened"');
    for (const code of [...codes, "opened", "partly_opened"]) expect(OUTCOME_WORDS[code], code).toBeDefined();
    for (const words of Object.values(OUTCOME_WORDS)) expect(words).not.toMatch(/_/);
    expect(outcomeWords(null)).toBeNull();
    expect(outcomeWords("rearmed")).toBe("made due again for the billing worker");
    expect(outcomeWords("some_new_code")).toBe("some new code");
  });

  test("every Stripe error family the billing engine records (lib/billing/requests.ts), and its other closed heads", () => {
    const block = /const STRIPE_ERROR_FAMILIES[^{]*\{([\s\S]*?)\};/.exec(source("lib/billing/requests.ts"))?.[1] ?? "";
    const families = [...block.matchAll(/: "([a-z_]+)"/g)].map((m) => m[1]!);
    expect(families.length).toBeGreaterThan(5);
    for (const family of [...families, "error"]) {
      const words = engineWords(`stripe:${family}`);
      expect(words, family).toMatch(/^(Stripe|the connection to Stripe)/);
      expect(words, family).not.toContain("recorded");
    }
    const failureOf = source("lib/billing/requests.ts");
    for (const head of ["stripe_not_configured", "price_not_found", "internal"]) {
      expect(failureOf, head).toContain(head);
      expect(engineWords(head), head).not.toContain("recorded");
    }
    // An overage invoice's code is Stripe's own type and code, lower-cased.
    expect(engineWords("card_error:card_declined")).toBe("Stripe refused the card (card declined)");
    expect(engineWords("stripeapierror:500")).toBe("Stripe had an error on its side (500)");
    expect(engineWords("unknown")).toBe("the cause was not recorded");
    // A head nobody listed is still said, as the engine's own words.
    expect(engineWords("something_new:x")).toBe('the engine recorded "something new" (x)');
  });

  test("the approvals job and the incident assistant are named as apps/app names them (kinds.ts PROPOSER, incident-kinds.ts ASSISTANT)", () => {
    const theirs = /export const PROPOSER = "([a-z-]+)";/.exec(source("lib/approvals/kinds.ts"))?.[1];
    expect(theirs).toBeDefined();
    expect(APPROVALS_JOB).toBe(theirs);
    const assistant = /export const ASSISTANT = "([a-z-]+)";/.exec(source("lib/approvals/incident-kinds.ts"))?.[1];
    expect(assistant).toBeDefined();
    expect(actorWords(assistant!)).toBe("the incident assistant");
    // The on-screen name is the job's, which the Jobs page prints as its name; the line says what that job alone proposes.
    expect(EMPTY_JOB_OFF).toBe(
      "Nothing is waiting for your yes, but the approvals job is off at System > Jobs, so no billing retry or re-sign chase is being proposed; incident reports and your own proposals still arrive.",
    );
    // The chases are that job's (contact-proposers.ts); an incident's first report is also the incident-deadlines job's (incident-sweep.ts).
    expect(source("lib/approvals/contact-proposers.ts")).toContain("The one clinic-contact kind the approvals job proposes by itself");
    expect(source("lib/approvals/incident-kinds.ts")).toContain("incident-deadlines job");
    expect(emptyWords(false)).toBe(EMPTY_JOB_OFF);
    expect(emptyWords(true)).toBe(EMPTY_WORDS);
    expect(emptyWords(null)).toBe(EMPTY_WORDS);
  });

  test("the email phrases and closing sentences (lib/email/templates/contact-words.ts), the sentences word for word", () => {
    expect(Object.keys(PHRASE_WORDS).sort()).toEqual(constList("lib/email/templates/contact-words.ts", "PHRASES").sort());
    expect(Object.keys(NOTE_WORDS).sort()).toEqual(constList("lib/email/templates/contact-words.ts", "NOTES").sort());
    expect(wordTable("lib/email/templates/contact-words.ts", "NOTE_WORDS")).toEqual(NOTE_WORDS);
  });

  test("why a chase or a reminder would send nothing (open-resigns.ts chaseBlocked, contact-reminders.ts ReminderBlock, contact-packets.ts already_queued)", () => {
    const chase = unionOf("lib/agreements/open-resigns.ts", /\): ((?:"[a-z_]+" \| )+)null \{/);
    expect(chase.length).toBeGreaterThan(2);
    expect(Object.keys(CHASE_BLOCK_WORDS).sort()).toEqual(chase.sort());
    const reminder = unionOf("lib/approvals/contact-reminders.ts", /export type ReminderBlock = ((?:"[a-z_]+"(?: \| )?)+);/);
    expect(reminder.length).toBeGreaterThan(4);
    expect(source("lib/approvals/contact-packets.ts")).toContain('ReminderBlock | "already_queued"');
    expect(Object.keys(REMINDER_BLOCK_WORDS).sort()).toEqual([...reminder, "already_queued"].sort());
    // Too early: day 8 and the day-7 reminder sent, both (open-resigns.ts chaseBlocked).
    expect(source("lib/agreements/open-resigns.ts")).toContain("facts.daysOpen < CHASE_FROM_DAY || !facts.daySevenSent");
    expect(CHASE_BLOCK_WORDS.too_early).toContain("once the day-7 reminder has gone");
    // A re-sign's next round: 1 from day 8, 2 from day 15 (chaseRound), so a rejected round's chase comes back at day 15, 22, ...
    expect(source("lib/agreements/open-resigns.ts")).toContain("Math.max(1, Math.floor((daysOpen - 1) / CHASE_EVERY_DAYS))");
    expect(rejectConfirm({ kind: "baa_resign_chase", clinic: null })).toContain("when its next seven-day round begins (day 15, 22, ...)");
    // Already sent: the outbox kinds say "already queued" (contact-executors.ts queueNotice).
    expect(source("lib/approvals/contact-executors.ts")).toContain('fail("already_sent", "This email was already queued, so it was not queued again.")');
    expect(OUTCOME_WORDS.already_sent).toBe("it had already been queued, so it was not queued again");
  });

  test("the lifecycle stages, the watch's recommendations, a review's statuses and a re-sign's reasons", () => {
    expect(Object.keys(RESIGN_REASON_WORDS).sort()).toEqual(constList("db/schema.ts", "AGREEMENT_RESIGN_REASONS").sort());
    // A version re-sign pauses nothing; the two DPA answers do (resign-ops.ts holdsPause).
    expect(source("lib/ops/resign-ops.ts")).toContain('holdsPause: r.reason !== "baa_version"');
    expect(Object.keys(STAGE_WORDS).sort()).toEqual(constList("db/schema.ts", "LIFECYCLE_STAGES").sort());
    expect(Object.keys(RECOMMENDATION_WORDS).sort()).toEqual(constList("lib/lifecycle/recommend.ts", "RECOMMENDATIONS").sort());
    const review = unionOf("lib/approvals/contact-packets.ts", /reviewStatus: ((?:"[a-z_]+" \| )+)null;/);
    expect(Object.keys(REVIEW_STATUS_WORDS).sort()).toEqual(review.sort());
  });

  test("the words are plain: no underscores, no raw codes", () => {
    for (const table of [
      APPROVAL_KIND_WORDS,
      REQUEST_KIND_WORDS,
      STOP_REASON_WORDS,
      BILLING_STATUS_WORDS,
      APPROVE_REASON_WORDS,
      REJECT_REASON_WORDS,
      EVENT_WORDS,
      PHRASE_WORDS,
      CHASE_BLOCK_WORDS,
      REMINDER_BLOCK_WORDS,
      STAGE_WORDS,
      REVIEW_STATUS_WORDS,
      RECOMMENDATION_WORDS,
      RESIGN_REASON_WORDS,
    ]) {
      for (const [code, words] of Object.entries(table)) {
        expect(words, code).not.toMatch(/_/);
        expect(words, code).toMatch(/^[A-Za-z]/);
      }
    }
    expect(actorWords("approvals-propose")).toBe("the approvals job");
    expect(actorWords("ops@healdesk.test")).toBe("ops@healdesk.test");
    expect(eventTypeWords("invoice.payment_failed")).toBe("invoice payment failed");
  });
});

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NOW = "2026-11-03T12:00:00.000Z";

const request: ApprovalItem = {
  id: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e:0",
  urgency: "money",
  status: "waiting",
  proposedAt: "2026-11-01T10:00:00.000Z",
  dueAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-08T10:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: true,
  irreversible: true,
  operation: "retryBillingRequest",
  hasDraft: false,
  packet: {
    operation: "retryBillingRequest",
    irreversible: true,
    stillNeeded: true,
    effect: "Makes this cancellation due again.",
    facts: {
      kind: "billing_request_retry",
      requestKind: "cancel_now",
      channel: null,
      reasonCode: "attempts_exhausted",
      lastErrorCode: "stripe:api_error",
      attempts: 10,
      maxAttempts: 10,
      billingStatus: "active",
      supersededBy: null,
      workerOn: false,
      closureOn: null,
    },
  },
};

/** A contact item with the given facts; the packet's extra is not read by factLines. */
function contact(facts: NonNullable<ApprovalItem["packet"]>["facts"]): ApprovalItem {
  return { ...request, kind: facts.kind as ApprovalItem["kind"], packet: { ...request.packet!, facts } };
}

describe("the facts and the timing", () => {
  test("a billing request: the change, the tries, why it stopped, the last error, billing now, and the worker's switch", () => {
    expect(factLines(request)).toEqual([
      ["Change", "an immediate cancellation"],
      ["Tries", "10 of 10"],
      ["Stopped because", "every try was used"],
      ["Last error", "Stripe had an error on its side"],
      ["Billing now", "active"],
      // One word: the packet's own effect sentence says what an off switch means, once.
      ["Billing worker", "off"],
    ]);
    const closure: ApprovalItem = {
      ...request,
      packet: {
        ...request.packet!,
        facts: {
          kind: "billing_request_retry",
          requestKind: "close_setup",
          channel: "web",
          reasonCode: null,
          lastErrorCode: null,
          attempts: 10,
          maxAttempts: 10,
          billingStatus: null,
          supersededBy: "cancel_now",
          workerOn: true,
          closureOn: false,
        },
      },
    };
    expect(factLines(closure)).toEqual([
      ["Change", "closing an unfinished setup, from the website chat channel"],
      ["Tries", "10 of 10"],
      ["Billing now", "not read"],
      ["Superseded", "a later cancellation makes this change moot"],
      ["Billing worker", "on"],
      ["Setup closure switch", "off"],
    ]);
    expect(factLines({ ...request, packet: null })).toEqual([]);
  });

  test("an overage invoice and a parked event: money and the month, the event and its failures, and that each runs at once", () => {
    const overage: ApprovalItem = {
      ...request,
      kind: "overage_invoice_retry",
      operation: "retryOverageInvoice",
      packet: {
        operation: "retryOverageInvoice",
        irreversible: true,
        stillNeeded: true,
        effect: "Invoices the extra usage.",
        facts: { kind: "overage_invoice_retry", windowStart: "2026-09-07T00:00:00.000Z", amountCents: 1250, lastErrorCode: "card_error:card_declined" },
      },
    };
    expect(factLines(overage)).toEqual([
      ["Amount", "$12.50"],
      ["Month from", "7 Sept 2026"],
      ["Last error", "Stripe refused the card (card declined)"],
      ["Runs", "at once, in the same request, when approved"],
    ]);
    const event: ApprovalItem = {
      ...request,
      kind: "billing_event_replay",
      operation: "replayBillingEvent",
      packet: {
        operation: "replayBillingEvent",
        irreversible: true,
        stillNeeded: true,
        effect: "Applies a paid invoice.",
        facts: { kind: "billing_event_replay", eventType: "invoice.paid", failures: 3, maxFailures: 3 },
      },
    };
    expect(factLines(event)).toEqual([
      ["Stripe event", "invoice paid"],
      ["Failed", "3 of 3 times"],
      ["Runs", "at once, in the same request, when approved"],
    ]);
    expect(dollars(8000)).toBe("$80");
    expect(dollars(120000)).toBe("$1,200");
    expect(dollars(90)).toBe("$0.90");
  });

  test("a chase: the versions, how long open, the emails and link, the last chase, whether AYA answers, the number to phone below the floor, and why it would send nothing", () => {
    const facts = {
      kind: "baa_resign_chase" as const,
      resignId: "aa0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
      fromVersion: "1.5.0",
      toVersion: "1.5.1",
      startedAt: "2026-10-20T09:00:00.000Z",
      daysOpen: 14,
      lastL22SentAt: "2026-10-27T09:00:00.000Z",
      linkExpiresAt: "2026-11-10T09:00:00.000Z",
      lastChaseAt: null,
      belowFloor: true,
      fromVersionAcceptable: false,
      isAnswering: true,
      blocked: null,
      callFirst: true,
      publishedPhoneE164: "+15555550100",
    };
    expect(factLines(contact(facts))).toEqual([
      ["Agreement", "from version 1.5.0 to version 1.5.1"],
      ["Re-sign open", "14 days, since 20 Oct 2026"],
      ["Last signing email", "27 Oct 2026"],
      ["Latest link works until", "10 Nov 2026, 09:00 UTC"],
      ["Last chase", "none yet"],
      ["AYA answering", "yes"],
      ["Phone the practice on", "+15555550100"],
    ]);
    expect(factLines(contact({ ...facts, fromVersion: null, startedAt: null, daysOpen: 1, lastL22SentAt: null, linkExpiresAt: null, belowFloor: false, callFirst: false, publishedPhoneE164: null, blocked: "too_early" }))).toEqual([
      ["Agreement", "from the version in force to version 1.5.1"],
      ["Re-sign open", "1 day"],
      ["Last signing email", "none recorded"],
      ["Latest link works until", "no link sent yet"],
      ["Last chase", "none yet"],
      ["AYA answering", "yes"],
      ["Would send nothing now", "the re-sign's own reminders (days 0, 3 and 7) are not spent yet; a chase can go from day 8, once the day-7 reminder has gone"],
    ]);
  });

  test("the agreement question: the review and our own day, the agreement in force, the two answers, earlier reviews, and an open re-sign", () => {
    const facts = {
      kind: "agreement_question" as const,
      reviewId: "bb0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
      reviewStatus: "open" as const,
      reviewDueOn: "2026-11-07",
      agreementKind: "dpa" as const,
      agreementVersion: "dpa/1.0.0",
      signedAt: "2026-10-01T09:00:00.000Z",
      coveredAnswer: "no" as const,
      siteAcceptsInsurance: "unknown" as const,
      earlierDecisions: 1,
      openResign: false,
      locationsToPause: 2,
      isAnswering: false,
    };
    expect(factLines(contact(facts))).toEqual([
      ["Review", "open; our own day to decide it: 7 Nov 2026"],
      ["Agreement in force", "DPA dpa/1.0.0, signed 1 Oct 2026"],
      ["Covered by HIPAA, as answered at checkout", "no"],
      ["Website says it takes insurance", "not read"],
      ["Earlier reviews decided", "1"],
    ]);
    expect(factLines(contact({ ...facts, reviewStatus: "passed", reviewDueOn: null, agreementKind: null, agreementVersion: null, signedAt: null, coveredAnswer: "unknown", siteAcceptsInsurance: "yes", openResign: true }))).toEqual([
      ["Review", "decided: the DPA stands"],
      ["Agreement in force", "none on file"],
      ["Covered by HIPAA, as answered at checkout", "not known"],
      ["Website says it takes insurance", "yes"],
      ["Earlier reviews decided", "1"],
      ["A re-sign is already open", "yes: approving sends nothing"],
    ]);
  });

  test("a setup notice: the stage, the window and its new end, the steps, the once-only guards, and the watch's sentence as it came", () => {
    const facts = {
      kind: "setup_help_offer" as const,
      stage: "partly_live" as const,
      stageSince: "2026-10-20T09:00:00.000Z",
      remainingDays: null,
      lastDay: null,
      newLastDay: null,
      stepsLeft: 1,
      alreadySent: true,
      stageMoved: true,
      recommendation: { action: "offer_call" as const, days: null, reason: "A channel is live and 1 step on another has waited 14 days: offer a five-minute call." },
    };
    expect(factLines(contact(facts))).toEqual([
      ["Stage", "partly live since 20 Oct 2026"],
      ["Window ends", "no setup deadline"],
      ["Steps left", "1"],
      ["Already sent for this stage", "yes: approving sends nothing"],
      ["Stage moved since proposed", "yes: approving sends nothing"],
      ["The setup watch recommends", "A channel is live and 1 step on another has waited 14 days: offer a five-minute call."],
    ]);
    expect(factLines(contact({ ...facts, kind: "setup_extended", stage: null, stageSince: null, remainingDays: 3, lastDay: "2026-11-06", newLastDay: "2026-11-20", stepsLeft: null, alreadySent: false, stageMoved: false, recommendation: null }))).toEqual([
      ["Stage", "not on the setup watch"],
      ["Window ends", "6 Nov 2026 (3 days left)"],
      ["If approved, ends", "20 Nov 2026"],
    ]);
  });

  test("a reminder sent sooner: which of the six and its own day, how many went, why it would send nothing", () => {
    const facts = { kind: "setup_reminder_now" as const, reminderNumber: 3, ofTotal: 6, normallyDueOn: "2026-11-10", sentSoFar: 2, blocked: "already_queued" as const, recommendation: null };
    expect(factLines(contact(facts))).toEqual([
      ["Reminder", "3 of 6, normally due 10 Nov 2026"],
      ["Sent so far", "2"],
      ["Would send nothing now", "it is no longer the next reminder to send"],
    ]);
    expect(factLines(contact({ ...facts, sentSoFar: null, blocked: null }))).toEqual([
      ["Reminder", "3 of 6, normally due 10 Nov 2026"],
      ["Sent so far", "not read"],
    ]);
  });

  test("how long it has waited, whether it is past due, and the moment after which it can no longer be approved", () => {
    expect(waitingWords(request, NOW)).toBe("Waiting 2 days, past due");
    expect(waitingWords({ ...request, pastDue: false }, "2026-11-01T10:30:00.000Z")).toBe("Waiting 30 minutes");
    expect(waitingWords(request, "2026-11-01T09:00:00.000Z")).toBe("Waiting under a minute, past due");
    expect(expiryWords(request)).toBe("Can no longer be approved after 8 Nov 2026, 10:00 UTC; the approvals job then takes it off the list.");
    expect(expiryWords({ expiresAt: null })).toBe("Waits until decided.");
    expect(onDay("2026-10-31T23:30:00.000Z")).toBe("31 Oct 2026");
    expect(onDay("2026-10-31")).toBe("31 Oct 2026");
    expect(whenWords("2026-11-02T10:01:00.000Z")).toBe("2 Nov 2026, 10:01 UTC");
  });

  test("the confirm sentence before the code field names what each kind's operation does", () => {
    expect(IRREVERSIBLE_CONFIRM.billing_request_retry).toBe("This cannot be undone once the billing worker has carried it out.");
    expect(IRREVERSIBLE_CONFIRM.overage_invoice_retry).toContain("Stripe has issued the invoice");
    expect(IRREVERSIBLE_CONFIRM.billing_event_replay).toContain("the event has been applied");
    expect(IRREVERSIBLE_CONFIRM.setup_extended).toContain("the deadline has moved and the email has gone");
    expect(IRREVERSIBLE_CONFIRM.incident_open_batch).toContain("the incidents have been opened");
    expect(IRREVERSIBLE_CONFIRM.incident_report_send).toContain("the report has been emailed");
  });

  test("the second press on Approve: once now, and for a billing change the worker's part", () => {
    expect(approveConfirm("billing_request_retry")).toBe(
      "Approve this item? Its operation runs once now. A billing change is then carried out by the billing worker, with fresh tries.",
    );
    // Every other kind's operation does the whole thing in the same request: no worker follows.
    expect(approveConfirm("overage_invoice_retry")).toBe("Approve this item? Its operation runs once now.");
    expect(approveConfirm("billing_event_replay")).toBe("Approve this item? Its operation runs once now.");
    expect(approveConfirm("setup_extended")).toBe("Approve this item? Its operation runs once now.");
    expect(approveConfirm("incident_report_send")).toBe("Approve this item? Its operation runs once now.");
  });

  test("the second press on Reject: nothing now, not proposed again, a later job still retries it, and where to retry by hand", () => {
    expect(REJECT_HEAD).toBe(
      "Nothing is run now, and this failure is not proposed again. If the job that retries it is switched on later, that job still retries it.",
    );
    expect(rejectConfirm(request)).toBe(`${REJECT_HEAD} The clinic's Billing tab is where to retry it by hand.`);
    // A Stripe event that resolved to no clinic is on no clinic's Billing tab.
    const orphan = { kind: "billing_event_replay" as const, clinic: null };
    expect(isClinicless(orphan)).toBe(true);
    expect(isClinicless({ kind: "billing_event_replay", clinic: { id: CLINIC, name: null } })).toBe(false);
    expect(isClinicless({ kind: "billing_request_retry", clinic: null })).toBe(false);
    expect(rejectConfirm(orphan)).toBe(`${REJECT_HEAD} ${NO_CLINIC_EVENT}`);
    expect(NO_CLINIC_EVENT).toBe("This event is on no clinic's Billing tab; Approve here is the only button that replays it.");
    expect(rejectConfirm({ kind: "billing_request_retry", clinic: null })).toBe(REJECT_HEAD);
  });

  test("the second press on Reject for an email or an incident item: nothing is sent or opened, and whether it comes back", () => {
    const clinic = { id: CLINIC, name: "Radiance Med Spa" };
    for (const kind of ["baa_resign_chase", "agreement_question", "setup_extended", "setup_waiting_on_us", "setup_help_offer", "setup_reminder_now"] as const) {
      const words = rejectConfirm({ kind, clinic });
      expect(words, kind).toMatch(/^Nothing is sent/);
      expect(words, kind).not.toContain("billing");
    }
    expect(rejectConfirm({ kind: "setup_reminder_now", clinic })).toContain("the reminder still goes on its own day");
    expect(rejectConfirm({ kind: "incident_open_batch", clinic: null })).toMatch(/^Nothing is opened/);
    expect(rejectConfirm({ kind: "incident_report_send", clinic })).toContain("Send report");
  });
});

describe("the decision's outcome line", () => {
  test("a re-armed request says the operation's own sentence: due again, carried out by the billing worker at its next run", () => {
    const message =
      "Re-armed: the change is due again, with fresh tries. The billing worker carries it out at its next run if it still applies. The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";
    expect(decisionWords({ status: "executed", outcomeCode: "rearmed", message, auditRecorded: true }, request)).toEqual({
      left: true,
      tone: "ok",
      text: `Approved. ${message}`,
      auditRecorded: true,
    });
    expect(decisionWords({ status: "executed", outcomeCode: "rearmed", message: null, auditRecorded: true }, request).text).toBe(
      "Approved. Made due again: the billing worker carries it out at its next run if it still applies.",
    );
  });

  test("an invoice, a skip, a replay, an email sent or queued, incidents opened, and an outcome nobody listed", () => {
    expect(decisionWords({ status: "executed", outcomeCode: "invoiced", message: null, auditRecorded: true }, request).text).toBe("Approved. Invoiced in Stripe.");
    expect(decisionWords({ status: "executed", outcomeCode: "skipped", message: null, auditRecorded: true }, request).text).toBe(
      "Approved. Nothing was invoiced: the month was already settled, or had nothing to bill.",
    );
    expect(decisionWords({ status: "executed", outcomeCode: "replayed", message: null, auditRecorded: false }, request)).toMatchObject({
      left: true,
      text: "Approved. The Stripe event was applied again.",
      auditRecorded: false,
    });
    const chase = { kind: "baa_resign_chase" as const, clinic: request.clinic };
    expect(decisionWords({ status: "executed", outcomeCode: "sent", message: null, auditRecorded: true }, chase).text).toBe("Approved. The email was sent.");
    expect(decisionWords({ status: "executed", outcomeCode: "queued", message: null, auditRecorded: true }, chase).text).toBe(
      "Approved. The email is queued in the outbox; the billing-notices job sends it.",
    );
    const opened = "Opened 2 incidents; each one's report is now waiting in this list for your yes.";
    expect(decisionWords({ status: "executed", outcomeCode: "opened", message: opened, auditRecorded: true }, { kind: "incident_open_batch", clinic: null }).text).toBe(`Approved. ${opened}`);
    expect(decisionWords({ status: "executed", outcomeCode: "new_thing", message: null, auditRecorded: true }, request).text).toBe("Approved. Went through: new thing.");
  });

  test("one that did not go through says the operation's words, and still left the list", () => {
    const failed = decisionWords(
      {
        status: "failed",
        outcomeCode: "no_longer_needed",
        message: "This has already been dealt with since it was proposed, so nothing was run.",
        auditRecorded: true,
      },
      request,
    );
    expect(failed).toEqual({
      left: true,
      tone: "bad",
      text: "Approved, but it did not go through: This has already been dealt with since it was proposed, so nothing was run.",
      auditRecorded: true,
    });
    expect(decisionWords({ status: "failed", outcomeCode: "threw", message: null, auditRecorded: true }, request).text).toBe(
      "Approved, but it did not go through: the operation failed partway.",
    );
    expect(decisionWords({ status: "failed", outcomeCode: "partly_opened", message: null, auditRecorded: true }, { kind: "incident_open_batch", clinic: null }).text).toBe(
      "Approved, but it did not go through: some of the incidents were opened, not all.",
    );
  });

  test("a rejection runs nothing now and leaves the list, naming where to retry by hand or what comes back; a refusal and a refused code change nothing and keep it", () => {
    expect(decisionWords({ status: "rejected", outcomeCode: "not_needed", auditRecorded: true }, request)).toEqual({
      left: true,
      tone: "ok",
      text: `Rejected. ${REJECT_HEAD} ${BILLING_TAB_RETRY}`,
      auditRecorded: true,
    });
    // A Stripe event no clinic's Billing tab lists: once rejected, no button replays it, and the line says only the fact.
    expect(decisionWords({ status: "rejected", outcomeCode: "not_needed", auditRecorded: true }, { kind: "billing_event_replay", clinic: null }).text).toBe(
      `Rejected. ${REJECT_HEAD} This event is on no clinic's Billing tab.`,
    );
    expect(decisionWords({ status: "rejected", outcomeCode: "other", auditRecorded: true }, { kind: "billing_request_retry", clinic: null }).text).toBe(
      `Rejected. ${REJECT_HEAD}`,
    );
    const email = { kind: "setup_help_offer" as const, clinic: request.clinic };
    expect(decisionWords({ status: "rejected", outcomeCode: "not_needed", auditRecorded: true }, email).text).toBe(`Rejected. ${rejectConfirm(email)}`);
    expect(decisionWords({ status: "refused", message: "This has already been decided, so nothing more was done. Reload to see where it stands." }, request)).toEqual({
      left: false,
      tone: "bad",
      text: "This has already been decided, so nothing more was done. Reload to see where it stands.",
      auditRecorded: null,
    });
    expect(decisionWords({ status: "code_refused", message: "That code is not right." }, request)).toMatchObject({ left: false, tone: "bad", text: "That code is not right." });
  });
});
