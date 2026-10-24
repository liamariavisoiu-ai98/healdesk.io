import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { ApprovalItem } from "@/lib/admin/ops-client";

import {
  actorWords,
  APPROVAL_KIND_WORDS,
  APPROVE_REASON_WORDS,
  BILLING_STATUS_WORDS,
  decisionWords,
  dollars,
  engineWords,
  EVENT_WORDS,
  eventTypeWords,
  expiryWords,
  factLines,
  IRREVERSIBLE_CONFIRM,
  onDay,
  OUTCOME_WORDS,
  outcomeWords,
  REJECT_REASON_WORDS,
  REQUEST_KIND_WORDS,
  STOP_REASON_WORDS,
  waitingWords,
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

/** Every `outcomeCode: "<code>"` literal a file records. */
function outcomeCodesIn(file: string): string[] {
  return [...new Set([...source(file).matchAll(/outcomeCode: "([a-z_]+)"/g)].map((m) => m[1]!))];
}

describe("the closed lists have words", () => {
  test("every approval kind, request kind and event name (db/schema.ts)", () => {
    expect(Object.keys(APPROVAL_KIND_WORDS).sort()).toEqual(constList("db/schema.ts", "APPROVAL_KINDS").sort());
    expect(Object.keys(REQUEST_KIND_WORDS).sort()).toEqual(constList("db/schema.ts", "BILLING_REQUEST_KINDS").sort());
    expect(Object.keys(EVENT_WORDS).sort()).toEqual(constList("db/schema.ts", "APPROVAL_EVENTS").sort());
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
  });

  test("why a request stopped (lib/approvals/packets.ts)", () => {
    const union = /reasonCode: ((?:"[a-z_]+" \| )+)null;/.exec(source("lib/approvals/packets.ts"))?.[1] ?? "";
    const codes = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(1);
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual(codes.sort());
  });

  test("every outcome code the executors, the store and the proposer record", () => {
    const codes = [
      ...outcomeCodesIn("lib/approvals/executors.ts"),
      ...outcomeCodesIn("lib/approvals/store.ts"),
      ...outcomeCodesIn("lib/approvals/proposers.ts"),
    ];
    expect(codes).toContain("rearmed");
    expect(codes).toContain("window_passed");
    for (const code of codes) expect(OUTCOME_WORDS[code], code).toBeDefined();
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

  test("the words are plain: no underscores, no raw codes", () => {
    for (const table of [APPROVAL_KIND_WORDS, REQUEST_KIND_WORDS, STOP_REASON_WORDS, BILLING_STATUS_WORDS, APPROVE_REASON_WORDS, REJECT_REASON_WORDS, EVENT_WORDS]) {
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

describe("the facts and the timing", () => {
  test("a billing request: the change, the tries, why it stopped, the last error, billing now, and the worker's switch", () => {
    expect(factLines(request)).toEqual([
      ["Change", "an immediate cancellation"],
      ["Tries", "10 of 10"],
      ["Stopped because", "every try was used"],
      ["Last error", "Stripe had an error on its side"],
      ["Billing now", "active"],
      ["Billing worker", "off: nothing happens until it is switched on at System › Jobs"],
    ]);
    const closure: ApprovalItem = {
      ...request,
      packet: {
        ...request.packet!,
        facts: { ...request.packet!.facts, kind: "billing_request_retry", requestKind: "close_setup", channel: "web", reasonCode: null, lastErrorCode: null, billingStatus: null, supersededBy: "cancel_now", workerOn: true, closureOn: false },
      },
    };
    expect(factLines(closure)).toEqual([
      ["Change", "closing an unfinished setup, from the website chat channel"],
      ["Tries", "10 of 10"],
      ["Billing now", "not read"],
      ["Superseded", "a later cancellation makes this change moot"],
      ["Billing worker", "on"],
      ["Setup closure switch", "off: nothing happens until it is switched on at System › Jobs"],
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

  test("how long it has waited, whether it is past due, and when it leaves the list", () => {
    expect(waitingWords(request, NOW)).toBe("Waiting 2 days, past due");
    expect(waitingWords({ ...request, pastDue: false }, "2026-11-01T10:30:00.000Z")).toBe("Waiting 30 minutes");
    expect(waitingWords(request, "2026-11-01T09:00:00.000Z")).toBe("Waiting under a minute, past due");
    expect(expiryWords(request)).toBe("Leaves the list without running on 8 Nov 2026 if nobody decides.");
    expect(expiryWords({ expiresAt: null })).toBe("Waits until decided.");
    expect(onDay("2026-10-31T23:30:00.000Z")).toBe("31 Oct 2026");
  });

  test("the confirm sentence before the code field names what each kind's operation does", () => {
    expect(IRREVERSIBLE_CONFIRM.billing_request_retry).toBe("This cannot be undone once the billing worker has carried it out.");
    expect(IRREVERSIBLE_CONFIRM.overage_invoice_retry).toContain("Stripe has issued the invoice");
    expect(IRREVERSIBLE_CONFIRM.billing_event_replay).toContain("the event has been applied");
  });
});

describe("the decision's outcome line", () => {
  test("a re-armed request says the operation's own sentence: due again, carried out by the billing worker at its next run", () => {
    const message =
      "Re-armed: the change is due again, with ten fresh tries. The billing worker carries it out at its next run if it still applies. The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";
    expect(decisionWords({ status: "executed", outcomeCode: "rearmed", message, auditRecorded: true })).toEqual({
      left: true,
      tone: "ok",
      text: `Approved. ${message}`,
      auditRecorded: true,
    });
    expect(decisionWords({ status: "executed", outcomeCode: "rearmed", message: null, auditRecorded: true }).text).toBe(
      "Approved. Made due again: the billing worker carries it out at its next run if it still applies.",
    );
  });

  test("an invoice, a skip, a replay, and an outcome nobody listed", () => {
    expect(decisionWords({ status: "executed", outcomeCode: "invoiced", message: null, auditRecorded: true }).text).toBe("Approved. Invoiced in Stripe.");
    expect(decisionWords({ status: "executed", outcomeCode: "skipped", message: null, auditRecorded: true }).text).toBe(
      "Approved. Nothing was invoiced: the month was already settled, or had nothing to bill.",
    );
    expect(decisionWords({ status: "executed", outcomeCode: "replayed", message: null, auditRecorded: false })).toMatchObject({
      left: true,
      text: "Approved. The Stripe event was applied again.",
      auditRecorded: false,
    });
    expect(decisionWords({ status: "executed", outcomeCode: "new_thing", message: null, auditRecorded: true }).text).toBe("Approved. Went through: new thing.");
  });

  test("one that did not go through says the operation's words, and still left the list", () => {
    const failed = decisionWords({
      status: "failed",
      outcomeCode: "no_longer_needed",
      message: "This has already been dealt with since it was proposed, so nothing was run.",
      auditRecorded: true,
    });
    expect(failed).toEqual({
      left: true,
      tone: "bad",
      text: "Approved, but it did not go through: This has already been dealt with since it was proposed, so nothing was run.",
      auditRecorded: true,
    });
    expect(decisionWords({ status: "failed", outcomeCode: "threw", message: null, auditRecorded: true }).text).toBe(
      "Approved, but it did not go through: the operation failed partway.",
    );
  });

  test("a rejection runs nothing and leaves the list; a refusal and a refused code change nothing and keep it", () => {
    expect(decisionWords({ status: "rejected", outcomeCode: "not_needed", auditRecorded: true })).toEqual({
      left: true,
      tone: "ok",
      text: "Rejected: nothing was run, and the item has left the list. This failure is not proposed again.",
      auditRecorded: true,
    });
    expect(decisionWords({ status: "refused", message: "This has already been decided, so nothing more was done. Reload to see where it stands." })).toEqual({
      left: false,
      tone: "bad",
      text: "This has already been decided, so nothing more was done. Reload to see where it stands.",
      auditRecorded: null,
    });
    expect(decisionWords({ status: "code_refused", message: "That code is not right." })).toMatchObject({ left: false, tone: "bad", text: "That code is not right." });
  });
});
