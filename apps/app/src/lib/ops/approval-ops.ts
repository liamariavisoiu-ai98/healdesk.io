import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { OpsApproval } from "@/db/schema";
import { decideDraft } from "@/lib/approvals/drafts";
import { execute, type Executor } from "@/lib/approvals/executors";
import { FIELD_EDITORS, type FieldDecision } from "@/lib/approvals/incident-kinds";
import {
  APPROVAL_FAMILIES,
  kindsOfFamily,
  type ApprovalFamily,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  APPROVE_REASONS,
  isApprovalKind,
  isApprovalStatus,
  KIND_SPECS,
  REJECT_REASONS,
  UUID,
  type ApprovalKind,
  type ApprovalStatus,
  type KindSpec,
} from "@/lib/approvals/kinds";
import { packetFor, type Packet } from "@/lib/approvals/packets";
import { getApproval, history, lastEventAt, listByStatus, moveStatus, recordEvent, SERVICE_ACTOR, type EventActor } from "@/lib/approvals/store";
import { printableClinicName } from "@/lib/email/lint";
import { describeError, log } from "@/lib/log";

import { codeFactor } from "./code-factor";

// api.ts imports this module for its dispatch, and this module borrows
// api.ts's helpers: safe, because nothing here touches them while the
// modules load (the same note as lib/ops/billing.ts).
import { actorFor, audit, booleanArg, numberArg, ok, opsProblem, stringArg, type Operator, type OpsOutcome } from "./api";

/**
 * The approval inbox's three operations (ops automation Phase 6, lane P6a;
 * design E6 §2; owner decisions D17, D18, D21). The screens are lane P6b's.
 *
 *   - `listApprovals {status?, limit?}` (read): the items in one status,
 *     waiting by default, earliest due first, each waiting one with its
 *     packet read live (lib/approvals/packets.ts). Writes nothing.
 *   - `decideApproval {id, action, reasonCode, codeChecked, editedDraft?}`
 *     (write): reject runs nothing; approve runs the kind's existing
 *     operation in this same request (lib/approvals/executors.ts) and
 *     records its outcome. A second decision on the same item is refused
 *     (compare-and-set on `waiting`), an expired item cannot be approved,
 *     and an irreversible kind needs apps/web's fresh-code mark,
 *     `codeChecked: true`, which only apps/web's wrapper sends
 *     (lib/admin/approval-decide.ts, after the operator's approval
 *     passcode or authenticator code, named in `codeKind` and recorded as
 *     the event's `factor`; a test there fails if anything else names the
 *     raw client).
 *     Each decision writes its events and one security event.
 *   - `listApprovalHistory {limit?, kind?}` (read): the add-only record,
 *     newest first, without drafts.
 *
 * Who decided is the operator account (D21: one shared sign-in), with the
 * IP address and user agent the request carried.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitOf(args: Record<string, unknown>): number | null {
  const n = numberArg(args, "limit");
  if (n === undefined) return DEFAULT_LIMIT;
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : null;
}

/** Clinic id → its printable name, read once per call through the scheduler's definer. */
async function clinicNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = new Set(ids.filter((id): id is string => id !== null));
  const names = new Map<string, string>();
  if (wanted.size === 0) return names;
  const result = await unsafeDb.execute<{ id: string; name: string | null }>(sql`select id, name from app_clinics_overview()`);
  for (const row of result.rows) {
    if (!wanted.has(row.id)) continue;
    const name = printableClinicName(row.name);
    if (name) names.set(row.id, name);
  }
  return names;
}

export type ApprovalItem = {
  id: string;
  kind: ApprovalKind;
  clinic: { id: string; name: string | null } | null;
  subjectRef: string;
  urgency: OpsApproval["urgency"];
  status: ApprovalStatus;
  proposedAt: string;
  dueAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  outcomeCode: string | null;
  pastDue: boolean;
  irreversible: boolean;
  operation: KindSpec["operation"];
  hasDraft: boolean;
  /** Read live for a waiting item; null for any other, or when its subject could not be read. */
  packet: Packet | null;
};

export async function opListApprovals(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const rawStatus = args.status;
  if (rawStatus !== undefined && !isApprovalStatus(rawStatus)) {
    return opsProblem(`status is one of ${APPROVAL_STATUSES.join(", ")}.`, 400, "invalid_args");
  }
  const status: ApprovalStatus = rawStatus ?? "waiting";
  const limit = limitOf(args);
  if (limit === null) return opsProblem(`limit is a whole number from 1 to ${MAX_LIMIT}.`, 400, "invalid_args");
  // One screen's items only (lane P6i): a family, or one kind. Absent: every kind, as before.
  // A screen that draws two families (the Approvals section: billing and
  // the clinic-contact emails, lane P6f) names both, as a list.
  let kinds: ApprovalKind[] | undefined;
  if (args.family !== undefined) {
    const families = Array.isArray(args.family) ? args.family : [args.family];
    if (
      families.length === 0 ||
      new Set(families).size !== families.length ||
      !families.every((f) => (APPROVAL_FAMILIES as readonly unknown[]).includes(f))
    ) {
      return opsProblem(`family is one of ${APPROVAL_FAMILIES.join(", ")}, or a list of them.`, 400, "invalid_args");
    }
    kinds = (families as ApprovalFamily[]).flatMap((f) => kindsOfFamily(f));
  }
  if (args.kind !== undefined) {
    if (!isApprovalKind(args.kind)) return opsProblem(`kind is one of ${APPROVAL_KINDS.join(", ")}.`, 400, "invalid_args");
    kinds = (kinds ?? [args.kind]).filter((k) => k === args.kind);
  }
  try {
    const rows = await listByStatus([status], limit, kinds);
    const names = await clinicNames(rows.map((r) => r.subjectClinicId));
    const partial: string[] = [];
    const items: ApprovalItem[] = [];
    for (const row of rows) {
      const kind = row.kind as ApprovalKind;
      const spec = KIND_SPECS[kind];
      let packet: Packet | null = null;
      if (row.status === "waiting") {
        try {
          packet = await packetFor(row, { actor: actorFor(operator), request: operator.request });
        } catch (error) {
          log.warn("approval packet not read", { kind, error: describeError(error) });
          partial.push(row.id);
        }
      }
      items.push({
        id: row.id,
        kind,
        clinic: row.subjectClinicId ? { id: row.subjectClinicId, name: names.get(row.subjectClinicId) ?? null } : null,
        subjectRef: row.subjectRef,
        urgency: row.urgency,
        status: row.status,
        proposedAt: row.proposedAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        outcomeCode: row.outcomeCode,
        pastDue: row.status === "waiting" && row.dueAt.getTime() <= now.getTime(),
        irreversible: spec.irreversible,
        operation: spec.operation,
        hasDraft: spec.hasDraft,
        packet,
      });
    }
    return ok({ items, partial });
  } catch (error) {
    log.error("approvals not listed", { error: describeError(error) });
    return opsProblem("The approvals could not be read.", 500, "failed");
  }
}

export type DecisionOutcome =
  | { status: "rejected"; outcomeCode: string; auditRecorded: boolean }
  | { status: "executed" | "failed"; outcomeCode: string; message: string | null; auditRecorded: boolean }
  | { status: "error"; message: string };

function refusal(message: string): OpsOutcome {
  return ok({ status: "error", message } satisfies DecisionOutcome);
}

function operatorActor(operator: Operator): EventActor {
  return { label: operator.email, ip: operator.request.ipAddress ?? null, userAgent: operator.request.userAgent ?? null };
}

const ALREADY = "This has already been decided, so nothing more was done. Reload to see where it stands.";

/**
 * The decision. `executors` is for the tests (a test-only kind, a refusing
 * executor); the dispatch passes the real registry.
 */
export async function opDecideApproval(
  args: Record<string, unknown>,
  operator: Operator,
  options: { now?: Date; executors?: Readonly<Record<string, Executor>>; specs?: Readonly<Record<string, KindSpec>> } = {},
): Promise<OpsOutcome> {
  const now = options.now ?? new Date();
  const specs = options.specs ?? KIND_SPECS;
  if (typeof operator?.email !== "string" || !operator.email.includes("@")) {
    return opsProblem("No operator to record the decision against.", 401, "unauthorized");
  }
  const id = stringArg(args, "id");
  if (!id || !UUID.test(id)) return opsProblem("id is an approval's id.", 400, "invalid_args");
  const action = args.action;
  if (action !== "approve" && action !== "reject") return opsProblem("action is approve or reject.", 400, "invalid_args");
  const reasonCode = stringArg(args, "reasonCode", 64);
  const reasons: readonly string[] = action === "approve" ? APPROVE_REASONS : REJECT_REASONS;
  if (!reasonCode || !reasons.includes(reasonCode)) {
    return opsProblem(`reasonCode is one of ${reasons.join(", ")}.`, 400, "invalid_args");
  }

  const item = await getApproval(id);
  if (!item) return refusal("No such approval.");
  const spec = specs[item.kind];
  if (!spec) return refusal("This item's kind is not one the console knows, so nothing was run.");
  // The fresh code is checked on apps/web, which holds the secret; its
  // wrapper is the only caller that sets the mark (D21).
  if (spec.irreversible && booleanArg(args, "codeChecked") !== true) {
    return refusal("This needs the approval passcode or the code from your authenticator. Nothing was changed.");
  }
  if (item.status !== "waiting") return refusal(ALREADY);
  if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) {
    await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "window_passed" });
    return refusal("This item's window has passed, so it can no longer be approved. Nothing was run.");
  }
  const actor = operatorActor(operator);
  const freshCode = booleanArg(args, "codeChecked") === true;
  // Which factor apps/web checked: the approval passcode or the authenticator (lane P7h).
  const factor = freshCode ? codeFactor(args) : null;

  if (action === "reject") {
    if (!(await moveStatus(item.id, "waiting", "rejected", "rejected", actor, now, { outcomeCode: reasonCode }))) {
      return refusal(ALREADY);
    }
    const auditRecorded = await audit(operator, "approval_rejected", {
      approvalId: item.id,
      kind: item.kind,
      reasonCode,
      freshCode,
      factor,
      ...(item.subjectClinicId ? { clinicId: item.subjectClinicId } : {}),
    });
    return ok({ status: "rejected", outcomeCode: reasonCode, auditRecorded } satisfies DecisionOutcome);
  }

  const draft = decideDraft(spec.hasDraft, item, args.editedDraft);
  if (!draft.ok) {
    return refusal(
      draft.code === "no_draft_kind"
        ? "This item has no email to edit. Nothing was changed."
        : draft.code === "draft_unreadable"
          ? "The email could not be read. Nothing was changed."
          : `The edited email cannot go as written (${draft.problems.join("; ")}). Nothing was changed.`,
    );
  }
  // A kind whose fixed fields the owner may choose (lane P6i: the incident
  // report): his choices, read from the lists and held to the operation's
  // own rules now, so a choice it would refuse changes nothing.
  const editor = spec.fieldsEditable ? FIELD_EDITORS[item.kind as ApprovalKind] : undefined;
  if (!editor && args.editedFields !== undefined && args.editedFields !== null) {
    return refusal("This item has no choices to edit. Nothing was changed.");
  }
  let fields: FieldDecision | null = null;
  if (editor) {
    fields = await editor(item, args.editedFields, now, { actor: actorFor(operator), request: operator.request });
    if (!fields.ok) return refusal(fields.message);
  }
  const hashApproved = draft.hashApproved ?? (fields?.ok ? fields.hashApproved : null);
  const edited = draft.edited || (fields?.ok === true && fields.edited);
  // The edit is recorded only once the decision has won the item: a losing
  // decision leaves no trace of an edit that was never approved.
  const approvedAt = new Date(now.getTime() + 1);
  const before = edited
    ? [{ event: "edited" as const, at: now, extra: { draftHashApproved: hashApproved } }]
    : [];
  if (
    !(await moveStatus(
      item.id,
      "waiting",
      "approved",
      "approved",
      actor,
      approvedAt,
      { outcomeCode: reasonCode, draftHashApproved: hashApproved },
      before,
    ))
  ) {
    return refusal(ALREADY);
  }
  const result = await execute(
    item,
    operator,
    { draft: draft.draft, fields: fields?.ok ? fields.fields : null, now },
    options.executors,
  );
  const settled = result.ok ? "executed" : "failed";
  const settledAt = new Date(now.getTime() + 2);
  // An email kind's executor returns the hash of what it sent (lane P6f): kept beside the hash approved.
  const draftHashSent = result.draftHashSent ?? null;
  const moved = await moveStatus(item.id, "approved", settled, settled, actor, settledAt, {
    outcomeCode: result.outcomeCode,
    draftHashSent,
  });
  // Lost to the 15-minute sweep (lib/approvals/store.ts sweepInterrupted):
  // the item already reads failed / interrupted, but the operation ran, so
  // its real outcome is appended after the sweep's event. The record then
  // never says only "interrupted" for an operation that did run.
  let appended = false;
  if (!moved) {
    try {
      const last = await lastEventAt(item.id);
      const at = new Date(Math.max(settledAt.getTime(), (last?.getTime() ?? 0) + 1));
      await recordEvent(unsafeDb, item.id, settled, actor, { outcomeCode: result.outcomeCode, draftHashSent, at });
      appended = true;
    } catch (error) {
      log.error("approval outcome not recorded", { kind: item.kind, error: describeError(error) });
    }
  }
  const auditRecorded = await audit(operator, "approval_approved", {
    approvalId: item.id,
    kind: item.kind,
    reasonCode,
    outcome: settled,
    outcomeCode: result.outcomeCode,
    moved,
    freshCode,
    factor,
    ...(item.subjectClinicId ? { clinicId: item.subjectClinicId } : {}),
  });
  const late = moved
    ? ""
    : " This took longer than 15 minutes, so the item was first recorded as interrupted; what the operation actually did is now recorded beside it.";
  return ok({
    status: settled,
    outcomeCode: result.outcomeCode,
    message: result.message || late ? `${result.message ?? ""}${late}`.trim() : null,
    auditRecorded: auditRecorded && (moved || appended),
  } satisfies DecisionOutcome);
}

export async function opListApprovalHistory(args: Record<string, unknown>): Promise<OpsOutcome> {
  const limit = limitOf(args);
  if (limit === null) return opsProblem(`limit is a whole number from 1 to ${MAX_LIMIT}.`, 400, "invalid_args");
  const kind = args.kind;
  if (kind !== undefined && !isApprovalKind(kind)) {
    return opsProblem(`kind is one of ${APPROVAL_KINDS.join(", ")}.`, 400, "invalid_args");
  }
  try {
    const rows = await history(limit, kind);
    const names = await clinicNames(rows.map((r) => r.subjectClinicId));
    return ok({
      events: rows.map((r) => ({
        id: r.id,
        approvalId: r.approvalId,
        kind: r.kind,
        clinic: r.subjectClinicId ? { id: r.subjectClinicId, name: names.get(r.subjectClinicId) ?? null } : null,
        event: r.event,
        actorLabel: r.actorLabel,
        ip: r.ip,
        userAgent: r.userAgent,
        draftHashApproved: r.draftHashApproved,
        draftHashSent: r.draftHashSent,
        outcomeCode: r.outcomeCode,
        at: r.at.toISOString(),
      })),
    });
  } catch (error) {
    log.error("approval history not read", { error: describeError(error) });
    return opsProblem("The approval history could not be read.", 500, "failed");
  }
}
