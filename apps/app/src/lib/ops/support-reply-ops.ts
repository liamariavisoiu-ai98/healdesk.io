import { and, eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportCases } from "@/db/schema";
import { CONSOLE_PROPOSER } from "@/lib/approvals/kinds";
import { proposeSupportReplyFor, type ProposeReplyOutcome } from "@/lib/approvals/support-reply";
import { describeError, log } from "@/lib/log";
import { canMove, printRef, type SupportCaseState } from "@/lib/support/case-vocab";
import { checkReplyText, MAX_DRAFT_CHARS, normaliseDraftText, readCaseForReply, saveReplyDraft } from "@/lib/support/send";
import { failedRules, type ReplyCheck } from "@/lib/support/send-checks";

import { actorFor, audit, ok, opsProblem, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The support reply's ops operations (ops automation Phase 7, lane P7c;
 * design E5 §2.4), beside the dispatch rather than in it. None calls a
 * model, and none sends: a reply goes only when the owner approves its item
 * in the approval inbox, with a fresh authenticator code (decideApproval,
 * through apps/web's lib/admin/approval-decide.ts alone).
 *
 *   - `previewSupportReply {caseId, text}` (read): the reply checks on an
 *     edited text, as Send will run them; the rules' ids, names and results,
 *     never the words back.
 *   - `saveSupportDraft {caseId, text}` (MUTATING): the operator's own text,
 *     saved as the reply's next draft version with its checks; the case moves
 *     to `drafted` when every check passes (and the draft is proposed for the
 *     owner's yes) or `needs_edit` when one fails (and nothing is proposed).
 *   - `proposeSupportReply {caseId}` (MUTATING): the case's current draft
 *     into the approval inbox, if every check passes on it now; refused with
 *     the rules' names when one fails.
 *
 * Each write records a security event naming the operator, with ids, the
 * ref, versions, states and rule ids only.
 */

const UNKNOWN = (args: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(args).filter((key) => !allowed.includes(key));

function caseIdOf(args: Record<string, unknown>): string | null {
  const raw = typeof args.caseId === "string" ? args.caseId.trim().toLowerCase() : "";
  return UUID_SHAPED.test(raw) ? raw : null;
}

const TEXT_RULE = `The text is the reply itself: 1 to ${MAX_DRAFT_CHARS.toLocaleString("en-US")} characters.`;

/** What the console reads of a check run: each result, the rules that failed and whether all passed. */
function checksView(results: readonly ReplyCheck[]): { ok: boolean; checks: ReplyCheck[]; failed: string[] } {
  const checks = results.map((c) => ({ id: c.id, ok: c.ok, rule: c.rule }));
  return { ok: checks.every((c) => c.ok), checks, failed: failedRules({ ok: false, results: checks }) };
}

export async function opPreviewSupportReply(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  if (UNKNOWN(args, ["caseId", "text"]).length > 0) {
    return opsProblem("previewSupportReply takes only caseId and text.", 400, "invalid_args");
  }
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  const text = normaliseDraftText(args.text);
  if (!text) return opsProblem(TEXT_RULE, 400, "invalid_args");
  try {
    const read = await readCaseForReply(caseId, actorFor(operator));
    if (!read) return opsProblem("No such support case.", 404, "invalid_args");
    const result = await checkReplyText(text, read, "send");
    return ok({ ref: printRef(read.supportCase.ref), ...checksView(result.results) });
  } catch (error) {
    log.error("support reply not checked", { error: describeError(error) });
    return opsProblem("The reply could not be checked.", 500, "failed");
  }
}

/** The proposal's outcome as the console reads it, or the refusal in words. */
function proposalAnswer(ref: string, outcome: ProposeReplyOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "proposed":
      return { outcome: "proposed", ref, approvalId: outcome.approvalId, draftVersion: outcome.draftVersion, failed: [] };
    case "already_waiting":
      return { outcome: "already_waiting", ref, approvalId: outcome.approvalId, draftVersion: outcome.draftVersion, failed: [] };
    case "checks_failed":
      return { outcome: "checks_failed", ref, approvalId: null, draftVersion: outcome.draftVersion, failed: outcome.rules };
    case "refused":
      return { outcome: outcome.code, ref, approvalId: null, draftVersion: null, failed: [] };
  }
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  no_case: "No such support case.",
  closed: "This case is closed. A clinic that writes again opens a new case.",
  no_clinic: "This case names no clinic yet, so no reply can go: match it to its clinic first.",
  no_draft: "This case has no draft to propose. Save a draft first.",
  not_a_reply: "This case has nothing from the clinic to reply to, so no reply can go.",
  wrong_state: "Only a drafted case, or one whose draft needs an edit, can be proposed.",
};

export async function opProposeSupportReply(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  if (UNKNOWN(args, ["caseId"]).length > 0) return opsProblem("proposeSupportReply takes only caseId.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  try {
    const read = await readCaseForReply(caseId, actorFor(operator));
    if (!read) return opsProblem("No such support case.", 404, "invalid_args");
    const ref = printRef(read.supportCase.ref);
    const outcome = await proposeSupportReplyFor({
      caseId,
      now,
      proposedBy: CONSOLE_PROPOSER,
      actor: { label: operator.email, ip: operator.request.ipAddress ?? null, userAgent: operator.request.userAgent ?? null },
      tenantActor: actorFor(operator),
    });
    if (outcome.status === "refused") return opsProblem(REFUSAL_WORDS[outcome.code]!, 409, "invalid_args");
    const answer = proposalAnswer(ref, outcome);
    const auditRecorded = await audit(operator, "support_reply_proposed", {
      ref,
      clinicId: read.supportCase.subjectClinicId,
      outcome: answer.outcome,
      draftVersion: answer.draftVersion,
      ...(outcome.status === "checks_failed" ? { failedCount: outcome.rules.length } : {}),
    });
    return ok({ ...answer, auditRecorded });
  } catch (error) {
    log.error("support reply not proposed", { error: describeError(error) });
    return opsProblem("The reply could not be proposed.", 500, "failed");
  }
}

export async function opSaveSupportDraft(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  if (UNKNOWN(args, ["caseId", "text"]).length > 0) {
    return opsProblem("saveSupportDraft takes only caseId and text.", 400, "invalid_args");
  }
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  const text = normaliseDraftText(args.text);
  if (!text) return opsProblem(TEXT_RULE, 400, "invalid_args");
  try {
    const read = await readCaseForReply(caseId, actorFor(operator));
    if (!read) return opsProblem("No such support case.", 404, "invalid_args");
    const c = read.supportCase;
    const ref = printRef(c.ref);
    if (c.state === "closed") return opsProblem(REFUSAL_WORDS.closed!, 409, "invalid_args");
    if (!c.subjectClinicId) return opsProblem(REFUSAL_WORDS.no_clinic!, 409, "invalid_args");
    const checks = await checkReplyText(text, read, "draft");
    const to: SupportCaseState = checks.ok ? "drafted" : "needs_edit";
    if (c.state !== to && !canMove(c.state, to)) {
      return opsProblem(`${ref} cannot take a new draft while it is ${c.state.replace(/_/g, " ")}.`, 409, "invalid_args");
    }
    const saved = await saveReplyDraft({ caseId, text, checks, now });
    const moved = await unsafeDb
      .update(supportCases)
      .set({ state: to, updatedAt: now, ...(c.state === "snoozed" ? { snoozedUntil: null } : {}) })
      .where(and(eq(supportCases.id, caseId), eq(supportCases.state, c.state)))
      .returning({ id: supportCases.id });
    // A passing draft goes to the owner at once; a failing one waits for an edit. Either way an older version's item leaves the list.
    const proposal = moved.length > 0
      ? await proposeSupportReplyFor({
          caseId,
          now,
          proposedBy: CONSOLE_PROPOSER,
          actor: { label: operator.email, ip: operator.request.ipAddress ?? null, userAgent: operator.request.userAgent ?? null },
          tenantActor: actorFor(operator),
        })
      : null;
    const view = checksView(checks.results);
    const approvalId =
      proposal && (proposal.status === "proposed" || proposal.status === "already_waiting") ? proposal.approvalId : null;
    const auditRecorded = await audit(operator, "support_draft_saved", {
      ref,
      clinicId: c.subjectClinicId,
      draftVersion: saved.draftVersion,
      from: c.state,
      to: moved.length > 0 ? to : c.state,
      passed: view.ok,
      proposed: approvalId !== null,
    });
    return ok({
      ref,
      draftVersion: saved.draftVersion,
      state: moved.length > 0 ? to : c.state,
      approvalId,
      ...view,
      auditRecorded,
    });
  } catch (error) {
    log.error("support draft not saved", { error: describeError(error) });
    return opsProblem("The draft could not be saved.", 500, "failed");
  }
}
