"use client";

import { useState } from "react";

import {
  actorWords,
  APPROVAL_KIND_WORDS,
  approveConfirm,
  APPROVE_REASON_WORDS,
  decisionWords,
  emptyWords,
  EVENT_WORDS,
  expiryWords,
  FACTS_NOT_READ,
  factLines,
  IRREVERSIBLE_CONFIRM,
  isClinicless,
  NO_CLINIC_EVENT,
  NO_LONGER_NEEDED,
  outcomeWords,
  rejectConfirm,
  REJECT_REASON_WORDS,
  waitingWords,
  whenWords,
  type Decided,
} from "@/components/admin/approval-words";
import { ActionButton, CodeField, Failure, isCompleteCode, Section, Tag, UNAUDITED } from "@/components/admin/ui";
import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { ApprovalHistoryEvent, ApprovalItem, ApproveReason, OpsResult, RejectReason } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * Queues › Approvals (ops automation Phase 6, lane P6b; the operations are
 * lane P6a's, apps/app lib/ops/approval-ops.ts): the items waiting for the
 * owner's yes, one card each, and a History tab of the add-only record.
 * Home's approval rows and the `approval_waiting` alert open this section
 * (`#approvals`), and the alert's steps quote the names here, so the words
 * are fixed: "Approve", "Reject", "History", and the field "Code from your
 * authenticator" (components/admin/ui.tsx CodeField).
 *
 * A card says what approving does in apps/app's one sentence (the packet's
 * `effect`), the packet's facts in words, whether the billing worker that
 * would carry a re-armed request out is switched on, how long the item has
 * waited and the moment after which it can no longer be approved. Every kind
 * today is irreversible, so a sentence saying so stands before the code
 * field, and both decisions ask for the code: each goes through the page's
 * server action to lib/admin/approval-decide.ts (the session, then the fresh
 * code, then the signed request), never to the raw ops client. Approve is
 * not offered for an item whose facts apps/app could not read: deciding
 * money on nothing is what the packet exists to stop. Reject runs nothing
 * now and stops the same failure being proposed again, so it asks once
 * before it goes, naming where the failure can still be retried by hand: the
 * clinic's Billing tab, or for a Stripe event that resolved to no clinic,
 * nowhere but Approve here, which the card says too.
 *
 * The outcome says what happened in the operation's own words: a re-armed
 * request is due again, carried out by the billing worker at its next run,
 * not carried out now. A decided item leaves the waiting list, so its
 * outcome is kept by the section, not the card, and stays on screen after
 * the page re-reads the list. An empty list says so; when the approvals
 * job's switch is known to be off (the page reads the jobs), it says that
 * nothing is being proposed either.
 */

export type DecideApproval = (
  approvalId: string,
  action: "approve" | "reject",
  reasonCode: ApproveReason | RejectReason,
  code: string,
) => Promise<OpsResult<ApprovalDecisionEntry>>;

export type ApprovalsProps = {
  approvals: OpsResult<{ items: ApprovalItem[]; partial: string[] }>;
  history: OpsResult<ApprovalHistoryEvent[]>;
  /** The approvals job's switch (listJobs, `approvals-propose`); null when the jobs could not be read or it is not listed. */
  proposerOn: boolean | null;
  /** The server's clock, ISO, so "waiting 2 days" is the same on both renders. */
  now: string;
  onDecide: DecideApproval;
};

const TEXT: Record<Tone, string> = {
  ok: "text-done",
  warn: "text-ink",
  bad: "text-red-deep font-semibold",
  info: "text-ink",
  muted: "text-muted",
};

const APPROVE_REASONS = Object.keys(APPROVE_REASON_WORDS) as ApproveReason[];
const REJECT_REASONS = Object.keys(REJECT_REASON_WORDS) as RejectReason[];

function ClinicName({ clinic }: { clinic: ApprovalItem["clinic"] }) {
  if (clinic === null) return <span className="font-semibold">No clinic</span>;
  return (
    <a href={clinicTabPath(clinic.id, "billing")} className="font-semibold underline underline-offset-2">
      {clinic.name ?? "A clinic with no printable name"}
    </a>
  );
}

function ApprovalCard({
  item,
  now,
  onDecide,
  onLeft,
}: {
  item: ApprovalItem;
  now: string;
  onDecide: DecideApproval;
  onLeft: (id: string, said: Decided) => void;
}) {
  const [code, setCode] = useState("");
  const [approveReason, setApproveReason] = useState<ApproveReason>(APPROVE_REASONS[0]!);
  const [rejectReason, setRejectReason] = useState<RejectReason>(REJECT_REASONS[0]!);
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const packet = item.packet;

  /**
   * One decision: the item stays with the refusal said on the card, or it
   * has left and the section says what happened (an audit row not written
   * said with it, as every act here says).
   */
  async function decide(action: "approve" | "reject"): Promise<OpsResult<{ status: "done" | "refused"; message?: string }>> {
    const result = await onDecide(item.id, action, action === "approve" ? approveReason : rejectReason, code);
    if (!result.ok) return result;
    const said = decisionWords(result.data, item);
    if (!said.left) return { ok: true, data: { status: "refused", message: said.text } };
    const unaudited = said.auditRecorded === false;
    onLeft(item.id, { ...said, tone: unaudited ? "warn" : said.tone, text: unaudited ? `${said.text} ${UNAUDITED}` : said.text });
    setGone(true);
    return { ok: true, data: { status: "done" } };
  }

  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <ClinicName clinic={item.clinic} />
        {item.pastDue ? <Tag tone="warn">Past due</Tag> : null}
      </div>
      <p className="text-muted mt-0.5 text-sm">{APPROVAL_KIND_WORDS[item.kind]}</p>
      {packet ? (
        <p className="mt-3 text-[15.6px]">{packet.effect}</p>
      ) : (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {FACTS_NOT_READ}
        </p>
      )}
      {packet && !packet.stillNeeded ? (
        <p role="status" className="text-red-deep mt-2 text-sm font-semibold">
          {NO_LONGER_NEEDED}
        </p>
      ) : null}
      {isClinicless(item) ? <p className="mt-2 text-sm font-semibold">{NO_CLINIC_EVENT}</p> : null}
      {packet ? (
        <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
          {factLines(item).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="text-muted mt-3 text-sm">
        {waitingWords(item, now)}. {expiryWords(item)}
      </p>

      <form className="mt-4 grid gap-3" onSubmit={(event) => event.preventDefault()}>
        {item.irreversible ? <p className="text-sm font-semibold">{IRREVERSIBLE_CONFIRM[item.kind]}</p> : null}
        <CodeField value={code} onChange={setCode} />
        <div className="flex flex-wrap items-end gap-3">
          {packet ? (
            <>
              <label className="grid gap-1 text-sm">
                <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">Why approve</span>
                <select
                  name="approveReason"
                  value={approveReason}
                  onChange={(event) => setApproveReason(event.target.value as ApproveReason)}
                  className="border-line rounded-sm border bg-white px-3 py-2.5"
                >
                  {APPROVE_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {APPROVE_REASON_WORDS[reason]}
                    </option>
                  ))}
                </select>
              </label>
              <ActionButton
                label="Approve"
                variant="primary"
                confirm={approveConfirm(item.kind)}
                disabled={!isCompleteCode(code)}
                run={() => decide("approve")}
              />
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">Why reject</span>
            <select
              name="rejectReason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value as RejectReason)}
              className="border-line rounded-sm border bg-white px-3 py-2.5"
            >
              {REJECT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {REJECT_REASON_WORDS[reason]}
                </option>
              ))}
            </select>
          </label>
          <ActionButton label="Reject" confirm={rejectConfirm(item)} disabled={!isCompleteCode(code)} run={() => decide("reject")} />
        </div>
      </form>
    </li>
  );
}

/** The record, newest first: when, whose, what kind, what happened and why, who by. Never a draft. */
export function History({ history }: { history: OpsResult<ApprovalHistoryEvent[]> }) {
  if (!history.ok) return <Failure failure={history} what="the approval history" />;
  if (history.data.length === 0) return <p className="text-muted text-sm">Nothing has happened yet.</p>;
  return (
    <ul className="divide-line divide-y text-sm">
      {history.data.map((event) => {
        const outcome = outcomeWords(event.outcomeCode);
        return (
          <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
            <span className="text-muted">{whenWords(event.at)}</span>
            <ClinicName clinic={event.clinic} />
            <span>{APPROVAL_KIND_WORDS[event.kind]}</span>
            <span className="font-semibold">
              {EVENT_WORDS[event.event]}
              {outcome ? ` (${outcome})` : ""}
            </span>
            <span className="text-muted">by {actorWords(event.actorLabel)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function ApprovalsSection({ approvals, history, proposerOn, now, onDecide }: ApprovalsProps) {
  const [tab, setTab] = useState<"waiting" | "history">("waiting");
  const [decided, setDecided] = useState<{ id: string; said: Decided }[]>([]);
  const items = approvals.ok ? approvals.data.items : [];
  const waiting = items.filter((item) => !decided.some((d) => d.id === item.id));

  const tabClass = (on: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors ${on ? "border-ink bg-ink text-white" : "border-line-strong hover:border-ink"}`;

  return (
    <Section id="approvals" title="Approvals">
      <div role="tablist" aria-label="Approvals" className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={tab === "waiting"} onClick={() => setTab("waiting")} className={tabClass(tab === "waiting")}>
          Waiting{approvals.ok ? ` (${waiting.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")} className={tabClass(tab === "history")}>
          History
        </button>
      </div>

      {tab === "waiting" ? (
        <div role="tabpanel" className="mt-4">
          {decided.length > 0 ? (
            <ul className="mb-4 grid gap-1">
              {decided.map(({ id, said }) => (
                <li key={id} role="status" className={`text-sm ${TEXT[said.tone]}`}>
                  {said.text}
                </li>
              ))}
            </ul>
          ) : null}
          {!approvals.ok ? <Failure failure={approvals} what="the approvals" /> : null}
          {approvals.ok && waiting.length === 0 ? <p className="text-sm">{emptyWords(proposerOn)}</p> : null}
          {waiting.length > 0 ? (
            <ul className="grid gap-3">
              {waiting.map((item) => (
                <ApprovalCard
                  key={item.id}
                  item={item}
                  now={now}
                  onDecide={onDecide}
                  onLeft={(id, said) => setDecided((list) => [...list, { id, said }])}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <div role="tabpanel" className="mt-4">
          <History history={history} />
        </div>
      )}
    </Section>
  );
}
