"use client";

import { useState } from "react";

import {
  actorWords,
  APPROVAL_FAMILIES,
  APPROVAL_KIND_WORDS,
  emptyWords,
  EVENT_WORDS,
  expiryWords,
  FACTS_NOT_READ,
  factLines,
  familyOf,
  FAMILY_WORDS,
  isClinicless,
  NO_CLINIC_EVENT,
  NO_LONGER_NEEDED,
  outcomeWords,
  waitingWords,
  whenWords,
  type ApprovalFamily,
  type Decided,
} from "@/components/admin/approval-words";
import { Failure, Section, Tag } from "@/components/admin/ui";
import type {
  ApprovalEditFields,
  ApprovalHistoryEvent,
  ApprovalItem,
  IncidentApprovalHistoryEvent,
  IncidentApprovalItem,
  OpsResult,
} from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

import { ClinicName, clinicTabFor, DecisionForm, type ApprovalEdit, type DecideApproval } from "./ApprovalDecision";
import { ContactDraft, sameFields, type PreviewDraft } from "./ContactDraft";
import { IncidentCard } from "./IncidentApprovalCard";

/**
 * Queues › Approvals (ops automation Phase 6, lanes P6b and P6j; the
 * operations are lane P6a's, apps/app lib/ops/approval-ops.ts): every item
 * waiting for the owner's yes, one card each, in three groups (the incident
 * assistant's legal clocks first, then the emails to clinics, then billing),
 * and a History tab of the add-only record across all of them. Home's
 * approval rows and the `approval_waiting`, `clinic_email_waiting` and
 * `incident_step_waiting` alerts open this section (`#approvals`), and the
 * alerts' steps quote the names here, so the words are fixed: "Approve",
 * "Reject", "History", and the field "Code from your authenticator"
 * (components/admin/ui.tsx CodeField).
 *
 * A card says what approving does in apps/app's one sentence (the packet's
 * `effect`), the packet's facts in words, how long the item has waited and
 * the moment after which it can no longer be approved. Every kind today is
 * irreversible, so a sentence saying so stands before the code field, and
 * both decisions ask for the code (./ApprovalDecision.tsx). An email item
 * shows its draft as the clinic will read it and lets the owner change its
 * closed fields alone, previewing the result (./ContactDraft.tsx); an
 * incident item lists the clinics or the report's choices
 * (./IncidentApprovalCard.tsx). Approve is not offered for an item whose
 * facts apps/app could not read: deciding money, an email or a legal clock
 * on nothing is what the packet exists to stop.
 *
 * The two reads (the billing and clinic-contact families, and the incident
 * family) each cost their own group when they fail, never the section. A
 * decided item leaves the waiting list, so its outcome is kept by the
 * section, not the card, and stays on screen after the page re-reads the
 * list. An empty list says so; when the approvals job's switch is known to
 * be off (the page reads the jobs), it says that nothing is being proposed
 * either.
 */

export type { ApprovalEdit, DecideApproval } from "./ApprovalDecision";
export type { PreviewDraft } from "./ContactDraft";

type Items<T> = OpsResult<{ items: T[]; partial: string[] }>;
type HistoryEvent = ApprovalHistoryEvent | IncidentApprovalHistoryEvent;

export type ApprovalsProps = {
  approvals: Items<ApprovalItem>;
  /** The incident assistant's items (fetchIncidentApprovals), read apart so a failure costs its group alone. */
  incidentApprovals: Items<IncidentApprovalItem>;
  history: OpsResult<ApprovalHistoryEvent[]>;
  incidentHistory: OpsResult<IncidentApprovalHistoryEvent[]>;
  /** The approvals job's switch (listJobs, `approvals-propose`); null when the jobs could not be read or it is not listed. */
  proposerOn: boolean | null;
  /** The server's clock, ISO, so "waiting 2 days" is the same on both renders. */
  now: string;
  onDecide: DecideApproval;
  onPreview: PreviewDraft;
};

const TEXT: Record<Tone, string> = {
  ok: "text-done",
  warn: "text-ink",
  bad: "text-red-deep font-semibold",
  info: "text-ink",
  muted: "text-muted",
};

function ApprovalCard({
  item,
  now,
  onDecide,
  onPreview,
  onLeft,
}: {
  item: ApprovalItem;
  now: string;
  onDecide: DecideApproval;
  onPreview: PreviewDraft;
  onLeft: (id: string, said: Decided) => void;
}) {
  const packet = item.packet;
  const contact = packet?.contact ?? null;
  const [fields, setFields] = useState<ApprovalEditFields>(contact?.fields ?? {});
  // Approve carries the fields only once the owner changed one: an unchanged email needs no edit recorded.
  const edit: ApprovalEdit | undefined = contact && contact.fields && !sameFields(contact.fields, fields) ? { fields } : undefined;

  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <ClinicName clinic={item.clinic} tab={clinicTabFor(item.kind)} />
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
      {contact ? <ContactDraft approvalId={item.id} contact={contact} fields={fields} onFieldsChange={setFields} onPreview={onPreview} /> : null}
      <p className="text-muted mt-3 text-sm">
        {waitingWords(item, now)}. {expiryWords(item)}
      </p>
      <DecisionForm
        subject={{ id: item.id, kind: item.kind, clinic: item.clinic, irreversible: item.irreversible, hasPacket: packet !== null }}
        onDecide={onDecide}
        onLeft={onLeft}
        edit={edit}
      />
    </li>
  );
}

/** The record, newest first across every kind: when, whose, what kind, what happened and why, who by. Never a draft. */
export function History({ history, incidentHistory }: { history: OpsResult<ApprovalHistoryEvent[]>; incidentHistory?: OpsResult<IncidentApprovalHistoryEvent[]> }) {
  const rows: HistoryEvent[] = [...(history.ok ? history.data : []), ...(incidentHistory?.ok ? incidentHistory.data : [])].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const failed = !history.ok || (incidentHistory !== undefined && !incidentHistory.ok);
  return (
    <>
      {!history.ok ? <Failure failure={history} what="the approval history" /> : null}
      {incidentHistory && !incidentHistory.ok ? <Failure failure={incidentHistory} what="the incident assistant's history" /> : null}
      {!failed && rows.length === 0 ? <p className="text-muted text-sm">Nothing has happened yet.</p> : null}
      {rows.length > 0 ? (
        <ul className="divide-line divide-y text-sm">
          {rows.map((event) => {
            const outcome = outcomeWords(event.outcomeCode);
            return (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
                <span className="text-muted">{whenWords(event.at)}</span>
                <ClinicName clinic={event.clinic} tab={clinicTabFor(event.kind)} />
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
      ) : null}
    </>
  );
}

type Waiting = { family: Exclude<ApprovalFamily, "incident">; item: ApprovalItem } | { family: "incident"; item: IncidentApprovalItem };

export function ApprovalsSection({ approvals, incidentApprovals, history, incidentHistory, proposerOn, now, onDecide, onPreview }: ApprovalsProps) {
  const [tab, setTab] = useState<"waiting" | "history">("waiting");
  const [decided, setDecided] = useState<{ id: string; said: Decided }[]>([]);
  const gone = (id: string) => decided.some((d) => d.id === id);
  const waiting: Waiting[] = [
    ...(incidentApprovals.ok ? incidentApprovals.data.items.filter((item) => !gone(item.id)).map((item) => ({ family: "incident" as const, item })) : []),
    // ops-client's ApprovalItem never carries an incident kind (fetchApprovals asks for the other two families).
    ...(approvals.ok
      ? approvals.data.items.filter((item) => !gone(item.id)).map((item) => ({ family: familyOf(item.kind) === "contact" ? ("contact" as const) : ("billing" as const), item }))
      : []),
  ];
  const bothRead = approvals.ok && incidentApprovals.ok;
  const onLeft = (id: string, said: Decided) => setDecided((list) => [...list, { id, said }]);

  const tabClass = (on: boolean) =>
    `inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm font-semibold transition-colors ${on ? "border-ink bg-ink text-white" : "border-line-strong hover:border-ink"}`;

  return (
    <Section id="approvals" title="Approvals">
      <div role="tablist" aria-label="Approvals" className="flex flex-wrap gap-2">
        <button type="button" role="tab" aria-selected={tab === "waiting"} onClick={() => setTab("waiting")} className={tabClass(tab === "waiting")}>
          Waiting{bothRead ? ` (${waiting.length})` : ""}
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
          {!incidentApprovals.ok ? <Failure failure={incidentApprovals} what="the incident assistant's items" /> : null}
          {bothRead && waiting.length === 0 ? <p className="text-sm">{emptyWords(proposerOn)}</p> : null}
          {APPROVAL_FAMILIES.map((family) => {
            const group = waiting.filter((w) => w.family === family);
            if (group.length === 0) return null;
            return (
              <div key={family} className="mt-4 first:mt-0">
                <h3 className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">{FAMILY_WORDS[family]}</h3>
                <ul className="mt-2 grid gap-3">
                  {group.map((w) =>
                    w.family === "incident" ? (
                      <IncidentCard key={w.item.id} item={w.item} now={now} onDecide={onDecide} onLeft={onLeft} />
                    ) : (
                      <ApprovalCard key={w.item.id} item={w.item} now={now} onDecide={onDecide} onPreview={onPreview} onLeft={onLeft} />
                    ),
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <div role="tabpanel" className="mt-4">
          <History history={history} incidentHistory={incidentHistory} />
        </div>
      )}
    </Section>
  );
}
