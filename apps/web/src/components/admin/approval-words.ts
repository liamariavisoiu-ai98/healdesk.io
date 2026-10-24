import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import type {
  ApprovalEventName,
  ApprovalItem,
  ApprovalKind,
  ApproveReason,
  BillingRequestKind,
  BillingStatus,
  RejectReason,
} from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

import { waited } from "./queue-words";

/**
 * The plain words the Queues page's "Approvals" section puts on apps/app's
 * approval inbox (ops automation Phase 6, lane P6b; the operations are lane
 * P6a's, apps/app lib/ops/approval-ops.ts). Every value here is a closed code
 * of apps/app's, read in its source by `approval-words.test.ts`, so a code
 * added there with no words here fails the build rather than reaching the
 * operator as a code: the kinds and the request kinds (db/schema.ts), the
 * approve and reject reasons (lib/approvals/kinds.ts), why a request stopped
 * (lib/approvals/packets.ts), the billing engine's Stripe error families
 * (lib/billing/requests.ts), the event names (db/schema.ts APPROVAL_EVENTS)
 * and the outcome codes the executors, the store and the proposer record.
 * Types only from ops-client, so a client component may import this
 * (lib/admin/client-imports.test.ts).
 */

export const APPROVAL_KIND_WORDS: Record<ApprovalKind, string> = {
  billing_request_retry: "Retry a billing change the billing worker gave up on",
  overage_invoice_retry: "Retry an extra-usage invoice that failed",
  billing_event_replay: "Replay a Stripe event that was parked",
};

/** The same words apps/app's alerts use for a request's kind (lib/ops/alert-wording/words.ts REQUEST_KIND_WORDS). */
export const REQUEST_KIND_WORDS: Record<BillingRequestKind, string> = {
  plan_start: "starting the plan",
  step_up: "a price step-up",
  close_setup: "closing an unfinished setup",
  cancel_now: "an immediate cancellation",
};

export const CHANNEL_WORDS: Record<"web" | "meta" | "voice", string> = {
  web: "website chat",
  meta: "Meta",
  voice: "phone",
};

/** Why the billing worker stopped (lib/approvals/packets.ts reasonCode; lib/billing/requests.ts outcomeReason). */
export const STOP_REASON_WORDS: Record<"attempts_exhausted" | "permanent_error", string> = {
  attempts_exhausted: "every try was used",
  permanent_error: "a failure that retrying cannot fix",
};

/** Our billing status for the clinic, as the entitlements row last heard it from Stripe. */
export const BILLING_STATUS_WORDS: Record<BillingStatus, string> = {
  demo: "demo",
  provisioning: "being set up",
  active: "active",
  past_due: "past due",
  suspended: "suspended",
  paused: "paused",
  canceling: "cancelling at the end of its period",
  canceled: "cancelled",
  purged: "purged",
};

/**
 * The billing engine's Stripe error families (lib/billing/requests.ts
 * STRIPE_ERROR_FAMILIES, recorded as `stripe:<family>`), and the same
 * families as Stripe's own raw types and class names, which the overage
 * invoicer records lower-cased (lib/billing/metered-items.ts stripeErrorCode:
 * `<type>:<code>`). One meaning each.
 */
const STRIPE_FAMILY_WORDS: Readonly<Record<string, string>> = {
  card_error: "Stripe refused the card",
  invalid_request: "Stripe refused the request as invalid",
  api_error: "Stripe had an error on its side",
  authentication: "Stripe refused our key",
  permission: "Stripe refused the permission",
  rate_limit: "Stripe asked us to slow down",
  connection: "the connection to Stripe dropped",
  idempotency: "Stripe saw the same request again with different details",
  error: "Stripe answered with an error",
};

const STRIPE_HEAD_WORDS: Readonly<Record<string, string>> = {
  stripecarderror: STRIPE_FAMILY_WORDS.card_error!,
  stripeinvalidrequesterror: STRIPE_FAMILY_WORDS.invalid_request!,
  stripeapierror: STRIPE_FAMILY_WORDS.api_error!,
  stripeauthenticationerror: STRIPE_FAMILY_WORDS.authentication!,
  stripepermissionerror: STRIPE_FAMILY_WORDS.permission!,
  striperatelimiterror: STRIPE_FAMILY_WORDS.rate_limit!,
  stripeconnectionerror: STRIPE_FAMILY_WORDS.connection!,
  stripeidempotencyerror: STRIPE_FAMILY_WORDS.idempotency!,
  invalid_request_error: STRIPE_FAMILY_WORDS.invalid_request!,
  authentication_error: STRIPE_FAMILY_WORDS.authentication!,
  rate_limit_error: STRIPE_FAMILY_WORDS.rate_limit!,
  idempotency_error: STRIPE_FAMILY_WORDS.idempotency!,
  // lib/billing/requests.ts failureOf: the other closed heads it records.
  stripe_not_configured: "no Stripe key is on the host",
  price_not_found: "a price is missing in Stripe",
  internal: "our own code failed",
  // lib/billing/metered-items.ts stripeErrorCode, when the error carried no type.
  unknown: "the cause was not recorded",
};

/**
 * An engine code in words: `stripe:<family>` (a billing request), or
 * `<family or class>[:<Stripe code or status>]` (an overage invoice), with
 * Stripe's own code after it in brackets, since that is the one word the
 * operator looks up. A head this table does not know is printed as its own
 * words, never dropped: the code is apps/app's, written for exactly this.
 */
export function engineWords(code: string): string {
  const [head = "", detail] = code.split(":");
  const family = head === "stripe" ? (detail ? STRIPE_FAMILY_WORDS[detail] : null) : null;
  if (head === "stripe") return family ?? STRIPE_FAMILY_WORDS.error!;
  const words = STRIPE_HEAD_WORDS[head] ?? STRIPE_FAMILY_WORDS[head] ?? `the engine recorded "${head.replace(/_/g, " ")}"`;
  return detail ? `${words} (${detail.replace(/_/g, " ")})` : words;
}

export const APPROVE_REASON_WORDS: Record<ApproveReason, string> = {
  cause_fixed: "The cause is fixed",
  passing_fault: "It was a passing fault",
  owner_checked: "I checked it and it is right",
};

export const REJECT_REASON_WORDS: Record<RejectReason, string> = {
  not_needed: "Not needed",
  wrong_amount: "The amount is wrong",
  handled_elsewhere: "Handled another way",
  ask_clinic_first: "Ask the clinic first",
  other: "Another reason",
};

/** What happened to an item, as the History tab reads each row (db/schema.ts APPROVAL_EVENTS). */
export const EVENT_WORDS: Record<ApprovalEventName, string> = {
  proposed: "proposed",
  edited: "email edited",
  approved: "approved",
  rejected: "rejected",
  executed: "went through",
  // The outcome says which failure: the operation's refusal, a process that died before the answer.
  failed: "failed",
  expired: "left the list without running",
  reminded: "reminder sent",
};

/**
 * The outcome codes a row can carry, in words: the owner's reasons (an
 * approved or rejected row), what the executor answered (lib/approvals/
 * executors.ts), and the store's and proposer's reasons for taking an item
 * off the list (lib/approvals/store.ts, proposers.ts).
 */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  cause_fixed: "the cause is fixed",
  passing_fault: "a passing fault",
  owner_checked: "checked by the owner",
  not_needed: "not needed",
  wrong_amount: "the amount is wrong",
  handled_elsewhere: "handled another way",
  ask_clinic_first: "ask the clinic first",
  other: "another reason",
  rearmed: "made due again for the billing worker",
  invoiced: "invoiced in Stripe",
  skipped: "nothing to invoice",
  replayed: "the Stripe event was applied again",
  no_longer_needed: "already dealt with since it was proposed",
  malformed_item: "its details could not be read",
  operation_refused: "the operation refused it",
  refused: "the operation refused it",
  stripe_failed: "Stripe did not invoice it",
  threw: "the operation failed partway",
  window_passed: "its window passed",
  clinic_out_of_service: "its clinic left service",
  interrupted: "the process died before the answer came",
};

/** An outcome code in words; one this table does not know is printed as its own words. */
export function outcomeWords(code: string | null): string | null {
  if (code === null) return null;
  return OUTCOME_WORDS[code] ?? code.replace(/_/g, " ");
}

/** The actor on a history row: the operator's account, or the proposer job (lib/approvals/kinds.ts PROPOSER). */
export function actorWords(label: string): string {
  return label === "approvals-propose" ? "the approvals job" : label;
}

/**
 * The sentence before the code field on an irreversible item, true to what
 * each kind's operation does (lib/approvals/executors.ts): a billing request
 * is re-armed for the billing worker, which carries it out; an overage retry
 * has Stripe issue the invoice in the same request; a replay applies the
 * event in the same request.
 */
export const IRREVERSIBLE_CONFIRM: Record<ApprovalKind, string> = {
  billing_request_retry: "This cannot be undone once the billing worker has carried it out.",
  overage_invoice_retry: "This cannot be undone once Stripe has issued the invoice.",
  billing_event_replay: "This cannot be undone once the event has been applied.",
};

/**
 * True to lib/approvals/store.ts propose(): nothing is proposed again for a
 * subject while a rejected item stands for it, and the alert's own words
 * name the Billing tab as where to retry it.
 */
export const REJECT_CONFIRM =
  "Nothing is run, and this failure is not proposed again. The clinic's Billing tab is where to retry it.";

/** The line when apps/app could not read an item's facts (listApprovals `partial`). */
export const FACTS_NOT_READ = "Its facts could not be read, so Approve is not offered. Reload, or reject it.";

/** The line when the subject has moved on since the item was proposed (packet `stillNeeded` false): approving runs nothing. */
export const NO_LONGER_NEEDED = "Already dealt with since it was proposed: approving runs nothing.";

export const EMPTY_WORDS = "Nothing is waiting for your yes.";

const SWITCH_OFF = "off: nothing happens until it is switched on at System › Jobs";

/** Cents as a reader reads money: "$80", "$1,200", "$0.90" (as apps/app's packets print it). */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** An instant as its UTC day: "31 Oct 2026". */
export function onDay(iso: string): string {
  return DAY.format(new Date(iso));
}

/** A Stripe event's type as words: "invoice.payment_failed" reads "invoice payment failed". */
export function eventTypeWords(type: string): string {
  return type.replace(/[._]/g, " ");
}

/**
 * The packet's facts as label and value pairs, per kind: what the owner
 * decides on, read live by apps/app from the rows the Billing tab reads. For
 * a billing request, whether the billing worker that would carry a re-armed
 * request out is switched on, and for a closure the setup-closure switch
 * too; the other two kinds run in the same request as the approval, with no
 * worker in between.
 */
export function factLines(item: ApprovalItem): [string, string][] {
  const packet = item.packet;
  if (!packet) return [];
  const facts = packet.facts;
  if (facts.kind === "billing_request_retry") {
    const lines: [string, string][] = [
      ["Change", `${REQUEST_KIND_WORDS[facts.requestKind]}${facts.channel ? `, from the ${CHANNEL_WORDS[facts.channel]} channel` : ""}`],
      ["Tries", `${facts.attempts} of ${facts.maxAttempts}`],
    ];
    if (facts.reasonCode) lines.push(["Stopped because", STOP_REASON_WORDS[facts.reasonCode]]);
    if (facts.lastErrorCode) lines.push(["Last error", engineWords(facts.lastErrorCode)]);
    lines.push(["Billing now", facts.billingStatus ? BILLING_STATUS_WORDS[facts.billingStatus] : "not read"]);
    if (facts.supersededBy) {
      lines.push(["Superseded", `a later ${facts.supersededBy === "cancel_now" ? "cancellation" : "closure"} makes this change moot`]);
    }
    lines.push(["Billing worker", facts.workerOn ? "on" : SWITCH_OFF]);
    if (facts.closureOn !== null) lines.push(["Setup closure switch", facts.closureOn ? "on" : SWITCH_OFF]);
    return lines;
  }
  if (facts.kind === "overage_invoice_retry") {
    const lines: [string, string][] = [
      ["Amount", dollars(facts.amountCents)],
      ["Month from", onDay(facts.windowStart)],
    ];
    if (facts.lastErrorCode) lines.push(["Last error", engineWords(facts.lastErrorCode)]);
    lines.push(["Runs", "at once, in the same request, when approved"]);
    return lines;
  }
  return [
    ["Stripe event", eventTypeWords(facts.eventType)],
    ["Failed", `${facts.failures} of ${facts.maxFailures} times`],
    ["Runs", "at once, in the same request, when approved"],
  ];
}

/** How long the item has waited since it was proposed, and whether it is past due: "Waiting 2 days, past due". */
export function waitingWords(item: Pick<ApprovalItem, "proposedAt" | "pastDue">, nowIso: string): string {
  const minutes = Math.max(0, (Date.parse(nowIso) - Date.parse(item.proposedAt)) / 60_000);
  return `Waiting ${waited(minutes)}${item.pastDue ? ", past due" : ""}`;
}

/** When the item leaves the list without running (KIND_SPECS expiryDays; store.ts expireDue), or that it waits until decided. */
export function expiryWords(item: Pick<ApprovalItem, "expiresAt">): string {
  if (item.expiresAt === null) return "Waits until decided.";
  return `Leaves the list without running on ${onDay(item.expiresAt)} if nobody decides.`;
}

export type Decided = {
  /** Whether the item has left the waiting list: a decision was recorded, whatever the operation then did. */
  left: boolean;
  tone: Tone;
  text: string;
  /** Null when no audit row was owed (a refusal). */
  auditRecorded: boolean | null;
};

/**
 * The decision's answer in one line, true to lib/approvals/executors.ts and
 * approval-ops.ts: a rejection runs nothing and takes the item off the list;
 * an approval that went through says what the operation did, in the
 * operation's own sentence where it gave one (a re-armed request is due
 * again, not carried out: the billing worker does that at its next run);
 * one that did not go through says why in the operation's words; a refusal
 * (already decided, window passed, the code) changes nothing.
 */
export function decisionWords(entry: ApprovalDecisionEntry): Decided {
  switch (entry.status) {
    case "refused":
    case "code_refused":
      return { left: false, tone: "bad", text: entry.message, auditRecorded: null };
    case "rejected":
      return {
        left: true,
        tone: "ok",
        text: "Rejected: nothing was run, and the item has left the list. This failure is not proposed again.",
        auditRecorded: entry.auditRecorded,
      };
    case "executed": {
      const said = (() => {
        switch (entry.outcomeCode) {
          case "rearmed":
            return entry.message ?? "Made due again: the billing worker carries it out at its next run if it still applies.";
          case "invoiced":
            return "Invoiced in Stripe.";
          case "skipped":
            return "Nothing was invoiced: the month was already settled, or had nothing to bill.";
          case "replayed":
            return "The Stripe event was applied again.";
          default:
            return entry.message ?? `Went through: ${outcomeWords(entry.outcomeCode)}.`;
        }
      })();
      return { left: true, tone: "ok", text: `Approved. ${said}`, auditRecorded: entry.auditRecorded };
    }
    case "failed":
      return {
        left: true,
        tone: "bad",
        text: `Approved, but it did not go through: ${entry.message ?? `${outcomeWords(entry.outcomeCode)}.`}`,
        auditRecorded: entry.auditRecorded,
      };
  }
}
