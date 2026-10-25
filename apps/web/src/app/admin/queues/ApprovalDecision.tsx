"use client";

import { useState } from "react";

import {
  approveConfirm,
  APPROVE_REASON_WORDS,
  approveReasonsFor,
  decisionWords,
  familyOf,
  IRREVERSIBLE_CONFIRM,
  rejectConfirm,
  REJECT_REASON_WORDS,
  type AnyApprovalKind,
  type Decided,
} from "@/components/admin/approval-words";
import { ActionButton, CodeField, isCompleteCode, UNAUDITED } from "@/components/admin/ui";
import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import { clinicTabPath, type IssueTab } from "@/lib/admin/issue-link";
import type { ApprovalEditFields, ApprovalItem, ApproveReason, IncidentReportChoices, OpsResult, RejectReason } from "@/lib/admin/ops-client";

/**
 * The one decision form every approval card ends in (ops automation Phase 6,
 * lanes P6b and P6j): the irreversible sentence, the field "Code from your
 * authenticator" (components/admin/ui.tsx CodeField), "Approve" with its
 * reason and "Reject" with its reason, both refusing to run without six
 * digits and both going through the page's server action to
 * lib/admin/approval-decide.ts (the session, then the fresh code, then the
 * signed request), never to the raw ops client. Approve is not offered for
 * an item whose facts apps/app could not read, and a card may hold it back
 * with a sentence of its own (a report with nothing picked for what
 * happened). What Approve carries besides the decision is the card's: an
 * email item's closed fields, or a report's choices from the catalog's
 * lists; never typed text (owner decision D12).
 *
 * A decided item leaves the waiting list, so its outcome is handed to the
 * section (`onLeft`), which keeps it on screen after the page re-reads the
 * list; a refusal stays on the card.
 */

/** What an approval may carry besides the decision: an email's closed fields, or a report's choices. */
export type ApprovalEdit = { fields: ApprovalEditFields } | { incident: IncidentReportChoices };

export type DecideApproval = (
  approvalId: string,
  action: "approve" | "reject",
  reasonCode: ApproveReason | RejectReason,
  code: string,
  edit?: ApprovalEdit,
) => Promise<OpsResult<ApprovalDecisionEntry>>;

export type DecisionSubject = {
  id: string;
  kind: AnyApprovalKind;
  clinic: ApprovalItem["clinic"];
  irreversible: boolean;
  /** Whether apps/app read the item's facts: without them Approve is not offered. */
  hasPacket: boolean;
};

const REJECT_REASONS = Object.keys(REJECT_REASON_WORDS) as RejectReason[];

const LABEL = "text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase";
const SELECT = "border-line rounded-sm border bg-white px-3 py-2.5";

/** The tab where the kind's subject is acted on: billing for money, setup for the setup window, care for agreements and incidents. */
export function clinicTabFor(kind: AnyApprovalKind): IssueTab {
  if (familyOf(kind) === "billing") return "billing";
  if (kind.startsWith("setup_")) return "setup";
  return "care";
}

export function ClinicName({ clinic, tab }: { clinic: ApprovalItem["clinic"]; tab: IssueTab }) {
  if (clinic === null) return <span className="font-semibold">No clinic</span>;
  return (
    <a href={clinicTabPath(clinic.id, tab)} className="font-semibold underline underline-offset-2">
      {clinic.name ?? "A clinic with no printable name"}
    </a>
  );
}

export function DecisionForm({
  subject,
  onDecide,
  onLeft,
  edit,
  approveHeldBy = null,
}: {
  subject: DecisionSubject;
  onDecide: DecideApproval;
  onLeft: (id: string, said: Decided) => void;
  /** What Approve carries besides the decision, as the card holds it now. */
  edit?: ApprovalEdit;
  /** A sentence that holds Approve back until the card's choices allow it; null when nothing does. */
  approveHeldBy?: string | null;
}) {
  // The reasons that fit the kind, the first the default (approveReasonsFor): an email or an incident step is approved because the owner checked it.
  const approveReasons = approveReasonsFor(subject.kind);
  const [code, setCode] = useState("");
  const [approveReason, setApproveReason] = useState<ApproveReason>(approveReasons[0]!);
  const [rejectReason, setRejectReason] = useState<RejectReason>(REJECT_REASONS[0]!);

  /**
   * One decision: the item stays with the refusal said on the card, or it
   * has left and the section says what happened (an audit row not written
   * said with it, as every act here says).
   */
  async function decide(action: "approve" | "reject"): Promise<OpsResult<{ status: "done" | "refused"; message?: string }>> {
    const result = await onDecide(subject.id, action, action === "approve" ? approveReason : rejectReason, code, action === "approve" ? edit : undefined);
    if (!result.ok) return result;
    const said = decisionWords(result.data, subject);
    if (!said.left) return { ok: true, data: { status: "refused", message: said.text } };
    const unaudited = said.auditRecorded === false;
    onLeft(subject.id, { ...said, tone: unaudited ? "warn" : said.tone, text: unaudited ? `${said.text} ${UNAUDITED}` : said.text });
    return { ok: true, data: { status: "done" } };
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={(event) => event.preventDefault()}>
      {subject.irreversible ? <p className="text-sm font-semibold">{IRREVERSIBLE_CONFIRM[subject.kind]}</p> : null}
      <CodeField value={code} onChange={setCode} />
      {subject.hasPacket ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className={LABEL}>Why approve</span>
            <select name="approveReason" value={approveReason} onChange={(event) => setApproveReason(event.target.value as ApproveReason)} className={SELECT}>
              {approveReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {APPROVE_REASON_WORDS[reason]}
                </option>
              ))}
            </select>
          </label>
          <ActionButton
            label="Approve"
            variant="primary"
            confirm={approveConfirm(subject.kind)}
            disabled={!isCompleteCode(code) || approveHeldBy !== null}
            run={() => decide("approve")}
          />
          {approveHeldBy ? (
            <p role="status" className="text-red-deep text-sm font-semibold">
              {approveHeldBy}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          <span className={LABEL}>Why reject</span>
          <select name="rejectReason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value as RejectReason)} className={SELECT}>
            {REJECT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {REJECT_REASON_WORDS[reason]}
              </option>
            ))}
          </select>
        </label>
        <ActionButton label="Reject" confirm={rejectConfirm(subject)} disabled={!isCompleteCode(code)} run={() => decide("reject")} />
      </div>
    </form>
  );
}
