"use client";

import { useState } from "react";

import type { Decided } from "@/components/admin/approval-words";
import { Failure, Section } from "@/components/admin/ui";
import type { DecideApproval } from "@/app/admin/queues/ApprovalDecision";
import { IncidentCard } from "@/app/admin/queues/IncidentApprovalCard";
import type { IncidentApprovalItem, OpsResult } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

import { IncidentScope, type ProposeBatch, type ReadScope } from "./IncidentScope";

/**
 * Compliance › Incidents › "Incident assistant" (ops automation lane P6j;
 * the operations are lane P6i's, apps/app lib/ops/incident-assistant-ops.ts
 * and lib/approvals/incident-kinds.ts): the assistant gathers and drafts,
 * the owner decides. The `incident_step_waiting` alert opens this page
 * (`#incident-assistant`) and its steps quote "Approve", "Reject" and the
 * field "Code from your authenticator", so the waiting items are drawn here
 * with the same cards as Queues › Approvals (one list in apps/app, two
 * places that show it: Home's row opens Queues, the alert opens this page).
 * Below them, the scope form and "Propose opening these incidents"
 * (./IncidentScope.tsx); each incident's checklist and "Propose the report"
 * are on its card above (./IncidentChecklist.tsx).
 *
 * Nothing here opens an incident, sends a report, records one not
 * reportable or resolves one: a proposal waits for the owner's yes with a
 * fresh code, and Not reportable stays the card's own button.
 */

export const WAITING_EMPTY = "No incident step is waiting for your yes.";

/** The two jobs that propose an incident's first report by themselves (apps/app lib/approvals/incident-sweep.ts), as the Jobs page names them. */
export const INCIDENT_PROPOSER_JOBS = ["incident-deadlines", "approvals-propose"] as const;

/** Empty with both of those switches read off (listJobs): no first report is proposed by itself; the owner's own proposals still arrive. */
export const WAITING_EMPTY_JOBS_OFF =
  "No incident step is waiting for your yes. The incident-deadlines and approvals-propose jobs are both off at System > Jobs, so no incident's first report is proposed by itself; what you propose on this page still arrives.";

/** The empty line, by whether both proposer jobs are known to be off (null: the jobs could not be read, so nothing extra is said). */
export function waitingEmptyWords(proposersOff: boolean | null): string {
  return proposersOff === true ? WAITING_EMPTY_JOBS_OFF : WAITING_EMPTY;
}

const TEXT: Record<Tone, string> = {
  ok: "text-done",
  warn: "text-ink",
  bad: "text-red-deep font-semibold",
  info: "text-ink",
  muted: "text-muted",
};

export function IncidentAssistant({
  items,
  proposersOff,
  now,
  onDecide,
  onReadScope,
  onProposeBatch,
}: {
  items: OpsResult<{ items: IncidentApprovalItem[]; partial: string[] }>;
  /** Whether both proposer jobs are switched off (read from listJobs); null when the jobs could not be read. */
  proposersOff: boolean | null;
  now: string;
  onDecide: DecideApproval;
  onReadScope: ReadScope;
  onProposeBatch: ProposeBatch;
}) {
  const [decided, setDecided] = useState<{ id: string; said: Decided }[]>([]);
  const waiting = items.ok ? items.data.items.filter((item) => !decided.some((d) => d.id === item.id)) : [];
  return (
    <Section id="incident-assistant" title="Incident assistant">
      <p className="text-muted max-w-[72ch] text-sm">
        Finds which clinics a vendor&rsquo;s or a channel&rsquo;s incident reached, drafts each report from fixed lists, and keeps each
        incident&rsquo;s checklist. It proposes; you decide here with the approval passcode or the code from your authenticator.
      </p>
      <h3 className="text-muted mt-4 text-xs font-bold tracking-[0.06em] uppercase">Waiting for your yes{items.ok ? ` (${waiting.length})` : ""}</h3>
      {decided.length > 0 ? (
        <ul className="mt-2 grid gap-1">
          {decided.map(({ id, said }) => (
            <li key={id} role="status" className={`text-sm ${TEXT[said.tone]}`}>
              {said.text}
            </li>
          ))}
        </ul>
      ) : null}
      {!items.ok ? <Failure failure={items} what="the incident assistant's items" /> : null}
      {items.ok && waiting.length === 0 ? <p className="mt-2 text-sm">{waitingEmptyWords(proposersOff)}</p> : null}
      {waiting.length > 0 ? (
        <ul className="mt-2 grid gap-3">
          {waiting.map((item) => (
            <IncidentCard key={item.id} item={item} now={now} onDecide={onDecide} onLeft={(id, said) => setDecided((list) => [...list, { id, said }])} />
          ))}
        </ul>
      ) : null}
      <IncidentScope now={now} onRead={onReadScope} onPropose={onProposeBatch} />
    </Section>
  );
}
