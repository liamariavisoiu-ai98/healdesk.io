import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import {
  APPROVE_REASONS,
  decideApproval as sendDecideApproval, // raw: only here (approval-decide.test.ts)
  REJECT_REASONS,
  type ApprovalDecision,
  type ApprovalEditFields,
  type ApproveReason,
  type OpsResult,
  type RejectReason,
} from "./ops-client";

/**
 * A decision on the approval inbox (ops automation Phase 6, lane P6a;
 * owner decision D21), entered as the voice and device acts are
 * (lib/admin/voice-drift.ts): an operator session first, so a stranger's
 * POST never gets to try codes against the secret; then a fresh code from
 * the operator's authenticator, checked here on Vercel against the secret
 * sign-in uses (lib/admin/fresh-code.ts); and only then the signed request
 * to apps/app, which carries the mark that the code was checked, runs the
 * item's existing operation once on approve, and records who decided. A
 * wrong or missing code sends nothing anywhere, and the code never crosses.
 *
 * Every kind today moves money or a billing state that cannot be taken back,
 * so a reject asks for the code too: one rule, and a decision is never made
 * by a session alone. This is the only file that may name the raw client.
 */

const UNAUTHENTICATED = {
  ok: false as const,
  code: "unauthenticated" as const,
  message: "Your session has ended. Sign in again to continue.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApprovalDecisionEntry = ApprovalDecision | { status: "code_refused"; message: string };

export async function decideApprovalWithCode(
  approvalId: string,
  action: "approve" | "reject",
  reasonCode: ApproveReason | RejectReason,
  code: unknown,
  // A clinic-contact item's edit is its closed fields only (owner decision D12; lane P6f).
  editedDraft?: { subject: string; body: string } | { fields: ApprovalEditFields },
): Promise<OpsResult<ApprovalDecisionEntry>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!UUID.test(approvalId)) return { ok: true, data: { status: "refused", message: "No such approval." } };
  if (action !== "approve" && action !== "reject") {
    return { ok: true, data: { status: "refused", message: "Choose Approve or Reject." } };
  }
  const reasons: readonly string[] = action === "approve" ? APPROVE_REASONS : REJECT_REASONS;
  if (!reasons.includes(reasonCode)) {
    return { ok: true, data: { status: "refused", message: "Pick one of the reasons listed." } };
  }
  const fresh = checkFreshOperatorCode(code);
  if (!fresh.ok) return { ok: true, data: { status: "code_refused", message: fresh.message } };
  return sendDecideApproval(approvalId, action, reasonCode, editedDraft);
}
