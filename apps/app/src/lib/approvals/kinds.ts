import { createHash } from "node:crypto";

import {
  APPROVAL_EVENTS,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  APPROVAL_URGENCIES,
  BILLING_REQUEST_KINDS,
  type ApprovalEventName,
  type ApprovalKind,
  type ApprovalStatus,
  type ApprovalUrgency,
  type BillingRequestKind,
} from "@/db/schema";

export {
  APPROVAL_EVENTS,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  APPROVAL_URGENCIES,
  type ApprovalEventName,
  type ApprovalKind,
  type ApprovalStatus,
  type ApprovalUrgency,
};

/**
 * The approval inbox's kinds (ops automation Phase 6, lane P6a; design E6
 * §2 and §3 item 15), each with the one existing ops operation approving it
 * runs, how it is chased, and how long it waits before it leaves the list.
 *
 * The rules every kind keeps (owner decisions D17, D18, D21):
 *   - approving runs the existing operation in the same apps/app request
 *     (./executors.ts), so the inbox can never do more than the console
 *     button does, with that button's guards and audit rows;
 *   - one item at a time; there is no bulk approve, and nothing is ever
 *     approved, sent or closed by timeout: a window only moves an item from
 *     `waiting` to `expired`, which removes it from the list and never runs it;
 *   - an irreversible kind is decided only through apps/web's wrapper, which
 *     checks a fresh authenticator code first (apps/web
 *     lib/admin/approval-decide.ts); the request carries its mark.
 *
 * The three billing kinds gate from the dead letter onward: the worker's ten
 * automatic attempts, the hourly reconcile's re-arm and Stripe's dunning
 * stay ungated (D17).
 */

export type KindSpec = {
  /** The existing ops operation approving runs, as the console names it. */
  readonly operation: "retryBillingRequest" | "retryOverageInvoice" | "replayBillingEvent";
  readonly urgency: ApprovalUrgency;
  /** Past this many hours after it was proposed, a waiting item is past due (one alert; a legal clock re-alerts every 4 hours). */
  readonly dueHours: number;
  /** Past this many days, a waiting item expires. Null: it waits until decided. */
  readonly expiryDays: number | null;
  /** Approving it cannot be taken back: a fresh authenticator code first (D21). */
  readonly irreversible: boolean;
  /** Whether the item carries an email draft that the owner may edit before approving. */
  readonly hasDraft: boolean;
  /**
   * Whether the proposer puts it in the inbox. False for a kind an automatic
   * process still retries (D17: nothing is both waiting for the owner's yes
   * and retried by itself): the kind and its executor stay registered, so an
   * item already recorded can still be read and decided.
   */
  readonly proposed: boolean;
};

export const KIND_SPECS: Readonly<Record<ApprovalKind, KindSpec>> = {
  billing_request_retry: {
    operation: "retryBillingRequest",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // Only cancel_now and close_setup dead letters (PROPOSED_REQUEST_KINDS):
    // the hourly reconcile re-arms a plan start or step-up dead letter once it
    // has rested a day (lib/billing/reconcile.ts decideReconcile), whenever
    // the worker would not just skip it, so neither is ever proposed.
    proposed: true,
  },
  overage_invoice_retry: {
    operation: "retryOverageInvoice",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // Not proposed: the 05 UTC run invoices every failed month again by
    // itself (lib/billing/annual-overage.ts invoiceAnnualOverage takes pending and
    // failed rows), so a failed overage invoice is never a dead letter.
    proposed: false,
  },
  billing_event_replay: {
    operation: "replayBillingEvent",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // Only a parked event that resolved to a clinic: one that names none may
    // still be replayed by provisioning (replayParkedBillingEvents).
    proposed: true,
  },
};

/**
 * The billing requests the proposer puts in the inbox: the two kinds nothing
 * re-arms. A plan start or step-up dead letter is re-armed by the hourly
 * reconcile after DEAD_LETTER_REST_MS whenever the worker could carry it out
 * (its conditions mirror the worker's re-check), so it is never proposed.
 */
export const PROPOSED_REQUEST_KINDS: readonly BillingRequestKind[] = ["cancel_now", "close_setup"];

/** An item still `approved` this long after its decision lost its process: the sweep records it failed. */
export const APPROVED_STUCK_MS = 15 * 60 * 1000;

/** A legal-clock item waiting is re-alerted at most this often (D18). */
export const LEGAL_CLOCK_REMINDER_MS = 4 * 60 * 60 * 1000;

/** The service that proposes the billing kinds: the job's own name. */
export const PROPOSER = "approvals-propose";

/** Why the owner rejected an item: a closed list, never typed words. */
export const REJECT_REASONS = ["not_needed", "wrong_amount", "handled_elsewhere", "ask_clinic_first", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Why the owner approved: a closed list, so the record says why without free text. */
export const APPROVE_REASONS = ["cause_fixed", "passing_fault", "owner_checked"] as const;
export type ApproveReason = (typeof APPROVE_REASONS)[number];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stripe's event ids, as lib/ops/billing.ts accepts them. */
export const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;
/** A Stripe event's type ("invoice.paid"): letters, dots and underscores. */
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,80}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
export const OUTCOME_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function isApprovalKind(value: unknown): value is ApprovalKind {
  return typeof value === "string" && (APPROVAL_KINDS as readonly string[]).includes(value);
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** What each kind's payload holds: ids and closed codes only, read back by name. */
export type Payloads = {
  billing_request_retry: { billingClinicId: string; requestId: string; requestKind: BillingRequestKind; epoch: number };
  overage_invoice_retry: { billingClinicId: string; overageId: string; windowStart: string };
  /** `parkedAt`: when the event was parked, the episode the item was proposed for. */
  billing_event_replay: { eventType: string; parkedAt: string };
};

/**
 * A payload as the kind defines it, or null. Every key is named and checked;
 * anything extra makes it null, so a payload can never carry what its kind
 * did not declare.
 */
export function parsePayload<K extends ApprovalKind>(kind: K, raw: unknown): Payloads[K] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(",");
  switch (kind) {
    case "billing_request_retry": {
      if (keys !== "billingClinicId,epoch,requestId,requestKind") return null;
      if (typeof p.billingClinicId !== "string" || !UUID.test(p.billingClinicId)) return null;
      if (typeof p.requestId !== "string" || !UUID.test(p.requestId)) return null;
      if (!(BILLING_REQUEST_KINDS as readonly unknown[]).includes(p.requestKind)) return null;
      if (typeof p.epoch !== "number" || !Number.isSafeInteger(p.epoch) || p.epoch < 0) return null;
      return p as Payloads[K];
    }
    case "overage_invoice_retry": {
      if (keys !== "billingClinicId,overageId,windowStart") return null;
      if (typeof p.billingClinicId !== "string" || !UUID.test(p.billingClinicId)) return null;
      if (typeof p.overageId !== "string" || !UUID.test(p.overageId)) return null;
      if (typeof p.windowStart !== "string" || !ISO_INSTANT.test(p.windowStart)) return null;
      return p as Payloads[K];
    }
    case "billing_event_replay": {
      if (keys !== "eventType,parkedAt") return null;
      if (typeof p.eventType !== "string" || !EVENT_TYPE.test(p.eventType)) return null;
      if (typeof p.parkedAt !== "string" || !ISO_INSTANT.test(p.parkedAt)) return null;
      return p as Payloads[K];
    }
  }
  return null;
}

/** The subject's id inside its reference ("<request id>:<epoch>" → the request id). */
export function subjectId(subjectRef: string): string {
  const colon = subjectRef.indexOf(":");
  return colon === -1 ? subjectRef : subjectRef.slice(0, colon);
}

/** The SHA-256 of a draft as stored or sent, in hex. */
export function draftHash(draft: string): string {
  return createHash("sha256").update(draft, "utf8").digest("hex");
}
