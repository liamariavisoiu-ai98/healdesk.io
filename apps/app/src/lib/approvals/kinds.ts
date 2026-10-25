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

import { parseContactPayload, type ContactPayloads } from "./contact-payloads";
import {
  parseIncidentBatchPayload,
  parseIncidentReportPayload,
  type IncidentBatchPayload,
  type IncidentReportPayload,
} from "./incident-payloads";

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
  readonly operation:
    | "retryBillingRequest"
    | "retryOverageInvoice"
    | "replayBillingEvent"
    // The clinic-contact kinds (lane P6f, ./contact-executors.ts).
    | "sendResignChase"
    | "sendAgreementQuestion"
    | "extendSetupDeadline"
    | "sendSetupNotice"
    | "queueSetupReminder"
    // The incident assistant (lane P6i): the existing openIncident, per clinic, and Send report.
    | "openIncident"
    | "sendIncidentReport";
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
   * The job that retries this kind's subjects by itself, when it is switched
   * on, or null when nothing does. D17: nothing may be both waiting for the
   * owner's yes and retried by itself, so the proposer proposes such a
   * subject only while that job is OFF, and moves a waiting one out of the
   * list (`retried_automatically`) once it is switched on. For billing
   * requests the job is per request kind (RETRIED_BY_REQUEST_KIND).
   */
  readonly retriedBy: string | null;
  /**
   * The owner may change the item's fixed fields before approving, by
   * choosing from closed lists only, never by typing (lane P6i: the L29
   * report). Checked again before the decision is recorded
   * (./incident-kinds.ts FIELD_EDITORS).
   */
  readonly fieldsEditable?: boolean;
};

export const KIND_SPECS: Readonly<Record<ApprovalKind, KindSpec>> = {
  billing_request_retry: {
    operation: "retryBillingRequest",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // Per request kind: RETRIED_BY_REQUEST_KIND.
    retriedBy: null,
  },
  overage_invoice_retry: {
    operation: "retryOverageInvoice",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // The 05 UTC run invoices every failed month again by itself while its
    // switch is on (lib/billing/annual-overage.ts invoiceAnnualOverage takes
    // pending and failed rows); while it is off nothing retries one.
    retriedBy: "annual-overage-invoice",
  },
  billing_event_replay: {
    operation: "replayBillingEvent",
    urgency: "money",
    dueHours: 24,
    expiryDays: 7,
    irreversible: true,
    hasDraft: false,
    // Every parked event except one a purchase still waiting to be
    // provisioned names: provisioning replays those (replayParkedBillingEvents;
    // lib/approvals/stripe-ids.ts). No job replays a parked event.
    retriedBy: null,
  },
  // The clinic-contact kinds (ops automation lane P6f; design E6 §3 items 13
  // and 14, E2 "Manual buttons"). Each emails the clinic's one address, so
  // each needs a fresh authenticator code (E6 §2: "any email to a clinic"),
  // and each email draft leaves the list after 14 days unsent. None has a
  // legal clock: a BAA version re-sign never pauses AYA and has no date the
  // practice must meet (lib/agreements/resign-pause.ts), and the agreement
  // question's review has an internal day only. Nothing retries any of them.
  //
  // Their windows, past-due alerts (clinic_email_waiting) and the
  // interrupted sweep all run from approvals-propose, which ships OFF. While
  // it is off an item past its window still shows on Home and in Approvals
  // as waiting until the job next runs; a decision on it is refused all the
  // same (approval-ops.ts checks expires_at itself), so nothing is ever
  // sent late, and no past-due alert goes. Only the incident kinds have an
  // independent sweep (./incident-sweep.ts, from incident-deadlines, ON).
  baa_resign_chase: {
    operation: "sendResignChase",
    urgency: "routine",
    dueHours: 48,
    expiryDays: 14,
    irreversible: true,
    hasDraft: true,
    retriedBy: null,
  },
  agreement_question: {
    operation: "sendAgreementQuestion",
    urgency: "routine",
    dueHours: 48,
    expiryDays: 14,
    irreversible: true,
    hasDraft: true,
    retriedBy: null,
  },
  setup_extended: {
    operation: "extendSetupDeadline",
    urgency: "routine",
    dueHours: 48,
    expiryDays: 14,
    irreversible: true,
    hasDraft: true,
    retriedBy: null,
  },
  setup_waiting_on_us: {
    operation: "sendSetupNotice",
    urgency: "routine",
    dueHours: 48,
    expiryDays: 14,
    irreversible: true,
    hasDraft: true,
    retriedBy: null,
  },
  setup_help_offer: {
    operation: "sendSetupNotice",
    urgency: "routine",
    dueHours: 48,
    expiryDays: 14,
    irreversible: true,
    hasDraft: true,
    retriedBy: null,
  },
  // "Send reminder now": the next of the six spec reminders, sooner. Its
  // wording is the reminder's own (the six keep their wording, D4), so it
  // has no draft to edit. Three days: a reminder pulled forward is about
  // now, and the schedule sends it anyway on its own day.
  setup_reminder_now: {
    operation: "queueSetupReminder",
    urgency: "routine",
    dueHours: 24,
    expiryDays: 3,
    irreversible: true,
    hasDraft: false,
    retriedBy: null,
  },
  // The incident assistant (lane P6i; design E6 §3 item 17; owner decision
  // D18). Both are legal clocks: re-alerted every 4 hours while they wait,
  // never expired, never approved by time. A batch is due at the internal
  // 24-hour target; a report at its incident's agreement deadline, set when
  // it is proposed (./incident-kinds.ts).
  incident_open_batch: {
    operation: "openIncident",
    urgency: "legal_clock",
    dueHours: 24,
    expiryDays: null,
    irreversible: true,
    hasDraft: false,
    retriedBy: null,
  },
  incident_report_send: {
    operation: "sendIncidentReport",
    urgency: "legal_clock",
    dueHours: 24,
    expiryDays: null,
    irreversible: true,
    hasDraft: false,
    retriedBy: null,
    fieldsEditable: true,
  },
};

/** The kinds that email a clinic (lane P6f): proposed by an operator's button, or the BAA chase by the job. */
export const CONTACT_KINDS = [
  "baa_resign_chase",
  "agreement_question",
  "setup_extended",
  "setup_waiting_on_us",
  "setup_help_offer",
  "setup_reminder_now",
] as const satisfies readonly ApprovalKind[];
export type ContactKind = (typeof CONTACT_KINDS)[number];

export function isContactKind(kind: string): kind is ContactKind {
  return (CONTACT_KINDS as readonly string[]).includes(kind);
}

/** The service an operator's proposal is recorded under (ops_approvals.proposed_by): the console. */
export const CONSOLE_PROPOSER = "ops-console";

/**
 * Which job re-arms a dead-lettered billing request by itself, by kind. The
 * hourly reconcile (`billing-reconcile`) re-arms a plan start or step-up dead
 * letter once it has rested DEAD_LETTER_REST_MS, whenever the worker could
 * carry it out (lib/billing/reconcile.ts decideReconcile, whose conditions
 * mirror the worker's re-check), but only while its switch is on: the job
 * ships off. Nothing re-arms a cancellation or a setup closure.
 */
export const RETRIED_BY_REQUEST_KIND: Readonly<Record<BillingRequestKind, string | null>> = {
  plan_start: "billing-reconcile",
  step_up: "billing-reconcile",
  cancel_now: null,
  close_setup: null,
};

/**
 * Which screen each kind belongs to, so a list read for one screen never
 * builds another's packets (lane P6i): the Approvals section reads
 * `billing`, the Incidents page `incident`, the clinic-contact drafts
 * `contact` (lane P6f's kinds, drawn in the Approvals section beside the
 * billing kinds).
 */
export const APPROVAL_FAMILIES = ["billing", "incident", "contact"] as const;
export type ApprovalFamily = (typeof APPROVAL_FAMILIES)[number];
export const KIND_FAMILY: Readonly<Record<ApprovalKind, ApprovalFamily>> = {
  billing_request_retry: "billing",
  overage_invoice_retry: "billing",
  billing_event_replay: "billing",
  baa_resign_chase: "contact",
  agreement_question: "contact",
  setup_extended: "contact",
  setup_waiting_on_us: "contact",
  setup_help_offer: "contact",
  setup_reminder_now: "contact",
  incident_open_batch: "incident",
  incident_report_send: "incident",
};

export function kindsOfFamily(family: ApprovalFamily): ApprovalKind[] {
  return APPROVAL_KINDS.filter((kind) => KIND_FAMILY[kind] === family);
}

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
  incident_open_batch: IncidentBatchPayload;
  incident_report_send: IncidentReportPayload;
} & ContactPayloads;

/**
 * A payload as the kind defines it, or null. Every key is named and checked;
 * anything extra makes it null, so a payload can never carry what its kind
 * did not declare.
 */
export function parsePayload<K extends ApprovalKind>(kind: K, raw: unknown): Payloads[K] | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (isContactKind(kind)) return parseContactPayload(kind, raw) as Payloads[K] | null;
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
    case "incident_open_batch":
      return parseIncidentBatchPayload(p) as Payloads[K] | null;
    case "incident_report_send":
      return parseIncidentReportPayload(p) as Payloads[K] | null;
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
