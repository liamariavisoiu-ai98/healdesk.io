import { and, eq } from "drizzle-orm";

import { billingEvents, billingRequests, overageInvoices, type OpsApproval } from "@/db/schema";
import { unsafeDb } from "@/db";
import { describeError, log } from "@/lib/log";
import { opReplayBillingEvent, opRetryBillingRequest, opRetryOverageInvoice } from "@/lib/ops/billing";
import { actorFor, type Operator, type OpsOutcome } from "@/lib/ops/api";
import { withTenant } from "@/lib/tenant";

import { CONTACT_EXECUTORS } from "./contact-executors";
import type { Draft } from "./drafts";
import { KIND_SPECS, parsePayload, subjectId, type ApprovalKind } from "./kinds";
import { billingSwitches, stillParkedAsProposed } from "./packets";

/**
 * What approving each kind runs: the existing ops operation, the one the
 * console's own button calls (lib/ops/billing.ts), with its guards, its
 * refusals and its audit rows unchanged (design E6: one execution path, so
 * the inbox can never do more than the button). Each executor adds one guard
 * of its own before the operation: the subject must still be in the failure
 * the item was proposed for (the same request at the same epoch still dead,
 * the same month's invoice still failed). An item whose subject has moved on
 * runs nothing and fails with `no_longer_needed`.
 *
 * The outcome is a code for the record (snake_case, ops_approval_events
 * .outcome_code) and the operation's own sentence for the operator, which is
 * our prose, never a clinic's or a patient's.
 */

export type ExecutionResult = {
  ok: boolean;
  outcomeCode: string;
  /** The operation's sentence when it refused or failed; null when it went through. */
  message: string | null;
  /** Whether the operation's own audit row was written, when it says. */
  auditRecorded: boolean | null;
  /**
   * For an email kind (lane P6f): the SHA-256 of what was sent, for
   * ops_approval_events.draft_hash_sent beside the hash approved.
   */
  draftHashSent?: string | null;
};

/** What a decision hands its executor: the draft the owner approved (the edit when there was one), for an email kind. */
export type ExecutionContext = {
  draft: Draft | null;
  /** The decision's own clock (approval-ops.ts), for an executor whose rule reads the time. */
  now?: Date;
};

export type Executor = (approval: OpsApproval, operator: Operator, context: ExecutionContext) => Promise<ExecutionResult>;

function malformed(): ExecutionResult {
  return { ok: false, outcomeCode: "malformed_item", message: "This item's details could not be read, so nothing was run.", auditRecorded: null };
}

const NO_LONGER_NEEDED: ExecutionResult = {
  ok: false,
  outcomeCode: "no_longer_needed",
  message: "This has already been dealt with since it was proposed, so nothing was run.",
  auditRecorded: null,
};

/** The data of an operation's answer, or the refusal it made. */
function answerOf(outcome: OpsOutcome): { data: Record<string, unknown> } | { problem: string } {
  if (outcome.status !== 200 || !("data" in outcome.body)) {
    const error = "error" in outcome.body ? outcome.body.error : "The operation did not answer.";
    return { problem: error };
  }
  const data = outcome.body.data;
  return { data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {} };
}

function refused(data: Record<string, unknown>, code = "refused"): ExecutionResult {
  return {
    ok: false,
    outcomeCode: code,
    message: typeof data.message === "string" ? data.message : "The operation refused and did not say why.",
    auditRecorded: typeof data.auditRecorded === "boolean" ? data.auditRecorded : null,
  };
}

const retryBillingRequest: Executor = async (approval, operator) => {
  const payload = parsePayload("billing_request_retry", approval.payload);
  if (!payload) return malformed();
  const still = await withTenant(
    { clinicId: payload.billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const [row] = await tx.db
        .select({ outcome: billingRequests.outcome, epoch: billingRequests.epoch })
        .from(billingRequests)
        .where(and(eq(billingRequests.id, payload.requestId), eq(billingRequests.clinicId, payload.billingClinicId)))
        .limit(1);
      return row?.outcome === "dead_letter" && row.epoch === payload.epoch;
    },
  );
  if (!still) return NO_LONGER_NEEDED;
  const answer = answerOf(
    await opRetryBillingRequest({ clinicId: payload.billingClinicId, requestId: payload.requestId }, operator),
  );
  if ("problem" in answer) return { ok: false, outcomeCode: "operation_refused", message: answer.problem, auditRecorded: null };
  if (answer.data.status !== "retried") return refused(answer.data);
  // Re-armed, not carried out: the worker makes the change at its next run.
  const switches = await billingSwitches();
  const message =
    "Re-armed: the change is due again, with fresh tries. The billing worker carries it out at its next run if it still applies." +
    (switches.worker ? "" : " The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.") +
    (payload.requestKind === "close_setup" && !switches.closure
      ? " Setup closure is switched off, so the closure waits until it is switched on at System > Jobs."
      : "");
  return { ok: true, outcomeCode: "rearmed", message, auditRecorded: answer.data.auditRecorded === true };
};

const retryOverageInvoice: Executor = async (approval, operator) => {
  const payload = parsePayload("overage_invoice_retry", approval.payload);
  if (!payload) return malformed();
  const still = await withTenant(
    { clinicId: payload.billingClinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const [row] = await tx.db
        .select({ status: overageInvoices.status })
        .from(overageInvoices)
        .where(and(eq(overageInvoices.id, payload.overageId), eq(overageInvoices.clinicId, payload.billingClinicId)))
        .limit(1);
      return row?.status === "failed";
    },
  );
  if (!still) return NO_LONGER_NEEDED;
  const answer = answerOf(
    await opRetryOverageInvoice({ clinicId: payload.billingClinicId, windowStart: payload.windowStart }, operator),
  );
  if ("problem" in answer) return { ok: false, outcomeCode: "operation_refused", message: answer.problem, auditRecorded: null };
  const status = answer.data.status;
  const audited = typeof answer.data.auditRecorded === "boolean" ? answer.data.auditRecorded : null;
  if (status === "invoiced") return { ok: true, outcomeCode: "invoiced", message: null, auditRecorded: audited };
  if (status === "skipped") return { ok: true, outcomeCode: "skipped", message: null, auditRecorded: audited };
  if (status === "failed") return refused(answer.data, "stripe_failed");
  return refused(answer.data);
};

const replayBillingEvent: Executor = async (approval, operator) => {
  const payload = parsePayload("billing_event_replay", approval.payload);
  if (!payload) return malformed();
  // Still parked in the episode it was proposed for: a later parking is a
  // different item. opReplayBillingEvent also refuses one no longer parked.
  const [row] = await unsafeDb
    .select({ outcome: billingEvents.outcome, processedAt: billingEvents.processedAt, receivedAt: billingEvents.receivedAt })
    .from(billingEvents)
    .where(eq(billingEvents.stripeEventId, subjectId(approval.subjectRef)))
    .limit(1);
  if (!row || !stillParkedAsProposed(row, payload.parkedAt)) return NO_LONGER_NEEDED;
  const answer = answerOf(await opReplayBillingEvent({ eventId: subjectId(approval.subjectRef) }, operator));
  if ("problem" in answer) return { ok: false, outcomeCode: "operation_refused", message: answer.problem, auditRecorded: null };
  if (answer.data.status !== "replayed") return refused(answer.data);
  return { ok: true, outcomeCode: "replayed", message: null, auditRecorded: answer.data.auditRecorded === true };
};

/** One executor per kind, closed: a new kind does not compile until it has one. */
export const EXECUTORS: Readonly<Record<ApprovalKind, Executor>> = {
  billing_request_retry: retryBillingRequest,
  overage_invoice_retry: retryOverageInvoice,
  billing_event_replay: replayBillingEvent,
  // The clinic-contact kinds (lane P6f): the outbox, the direct sender's
  // ledger, extendSetupDeadline and queueSetupReminder (./contact-executors.ts).
  ...CONTACT_EXECUTORS,
};

/** Run an item's executor; one that throws is a failure with a code, never an unrecorded item. */
export async function execute(
  approval: OpsApproval,
  operator: Operator,
  context: ExecutionContext,
  executors: Readonly<Record<string, Executor>> = EXECUTORS,
): Promise<ExecutionResult> {
  const executor = executors[approval.kind];
  if (!executor || !KIND_SPECS[approval.kind as ApprovalKind]) return malformed();
  try {
    return await executor(approval, operator, context);
  } catch (error) {
    log.error("approval executor threw", { kind: approval.kind, error: describeError(error) });
    return { ok: false, outcomeCode: "threw", message: "The operation failed partway. Nothing more was run; the item records it.", auditRecorded: null };
  }
}
