"use client";

import { useState } from "react";

import {
  closedWords,
  closesWords,
  commandNoteWords,
  daysLeftWords,
  kindWords,
  markDoneConfirm,
  onDay,
  RETELL_NOT_RECORDED,
  retellWords,
  RUNS_NOTHING,
  STATE_WORDS,
} from "@/components/admin/rights-words";
import { ActionButton, Chip, Failure } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { CloseRightsIntakeOutcome, OpsResult, RightsListView, RightsRowView } from "@/lib/admin/ops-client";

/**
 * The Patient rights page's table (ops automation lane P6b; the tracker is
 * lane P6c's, apps/app lib/rights/tracker.ts): every open request across
 * clinics, the earliest due first, with its clock and what to do. The page
 * runs nothing: each row's prepared command is the run-task.sh line the
 * owner copies and runs himself in AWS CloudShell, and "Copy command" puts
 * it on the clipboard and does nothing else. A blocked row has no command
 * and shows apps/app's own note in its place; no command is ever drawn for
 * it. A patient's own request shows its command with apps/app's note that
 * the practice's side is chased separately. "Mark done" closes an intake
 * (closeRightsIntake), once; it is not drawn for an erasure whose deletion
 * still owes its Retell step, because apps/app refuses that close and the
 * refusal reaches this app only as the ops client's generic sentence, so the
 * row says why itself, from its own facts. An intake linked to the patient
 * request it became follows the practice, and Mark done says the row stays
 * open until the practice marks the request received. A row with no intake
 * of its own closes by itself (a deletion once its Retell step is recorded,
 * a patient's request once the practice marks it received), and the row
 * says so.
 *
 * On screen: the clinic's name (linked to its Care tab, where a deletion's
 * steps are recorded), the request's kind, its days and its state. Never a
 * person, a contact id or anything typed: the rows carry none.
 */

export type CloseAction = (clinicId: string, intakeId: string) => Promise<OpsResult<CloseRightsIntakeOutcome>>;

export const EMPTY_WORDS = "No open requests.";

export const COPY_FAILED = "Could not copy: select the command and copy it yourself.";

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => setCopied("yes"))
            .catch(() => setCopied("failed"));
        }}
        className="border-line-strong hover:border-ink inline-flex min-h-9 w-max items-center rounded-full border px-4 py-1.5 text-sm font-bold transition-colors"
      >
        {copied === "yes" ? "Copied" : "Copy command"}
      </button>
      {copied === "failed" ? (
        <p role="status" className="text-red-deep text-sm font-semibold">
          {COPY_FAILED}
        </p>
      ) : null}
      <code className="text-muted font-mono text-xs break-all select-all">{command}</code>
    </div>
  );
}

function Done({ row, onClose, closed, onClosed }: { row: RightsRowView; onClose: CloseAction; closed: string | null; onClosed: (text: string) => void }) {
  if (closed) return <span className="text-done text-sm">{closed}</span>;
  if (row.intakeId === null || row.state === "done") {
    const words = closesWords(row);
    return words ? <span className="text-muted text-sm">{words}</span> : null;
  }
  if (row.retellStep === "outstanding") return <span className="text-sm">{RETELL_NOT_RECORDED}</span>;
  const intakeId = row.intakeId;
  return (
    <ActionButton
      label="Mark done"
      confirm={markDoneConfirm(row)}
      run={async () => {
        const result = await onClose(row.clinicId, intakeId);
        if (!result.ok) return result;
        const text = closedWords(result.data, row);
        onClosed(text);
        return { ok: true as const, data: { status: "done", message: text, auditRecorded: result.data.auditRecorded } };
      }}
      done={() => null}
    />
  );
}

const TH = "text-muted px-2 py-2 text-left text-xs font-bold tracking-[0.06em] uppercase";
const TD = "px-2 py-2 align-top";

export function RightsTable({ rights, onClose }: { rights: OpsResult<RightsListView>; onClose: CloseAction }) {
  const [closed, setClosed] = useState<{ id: string; text: string }[]>([]);
  const rows = rights.ok ? rights.data.rows : [];
  const gone = closed.filter((c) => !rows.some((r) => r.id === c.id));
  return (
    <section className="mt-6">
      <p className="text-sm font-semibold">{RUNS_NOTHING}</p>
      {gone.map((c) => (
        <p key={c.id} role="status" className="text-done mt-2 text-sm">
          {c.text}
        </p>
      ))}
      {!rights.ok ? <Failure failure={rights} what="the patient-rights requests" /> : null}
      {rights.ok && rights.data.unreadClinics > 0 ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {rights.data.unreadClinics} clinic(s) could not be read, so their requests are missing below.
        </p>
      ) : null}
      {rights.ok && rows.length === 0 ? <p className="mt-3 text-sm">{EMPTY_WORDS}</p> : null}
      {rows.length > 0 ? (
        <div className="border-line mt-3 overflow-x-auto rounded-md border bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-line border-b">
                <th className={TH}>Clinic</th>
                <th className={TH}>Request</th>
                <th className={TH}>Received</th>
                <th className={TH}>Due</th>
                <th className={TH}>Days left</th>
                <th className={TH}>State</th>
                <th className={TH}>Retell step</th>
                <th className={TH}>Command</th>
                <th className={TH}>Done</th>
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {rows.map((row) => {
                const state = STATE_WORDS[row.state];
                const retell = retellWords(row);
                const note = commandNoteWords(row);
                return (
                  <tr key={row.id}>
                    <td className={TD}>
                      <a href={clinicTabPath(row.clinicId, "care")} className="font-semibold underline underline-offset-2">
                        {row.clinicName}
                      </a>
                    </td>
                    <td className={TD}>{kindWords(row)}</td>
                    <td className={`${TD} whitespace-nowrap`}>{onDay(row.receivedOn)}</td>
                    <td className={TD}>
                      <span className="whitespace-nowrap">{onDay(row.dueOn)}</span>
                      {row.dueDerived ? <span className="text-muted"> (worked out from the day it was asked)</span> : null}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>{daysLeftWords(row)}</td>
                    <td className={TD}>
                      <Chip tone={state.tone}>{state.label}</Chip>
                    </td>
                    <td className={TD}>{retell ?? ""}</td>
                    <td className={`${TD} max-w-[28rem]`}>
                      {row.command !== null ? <CopyCommand command={row.command} /> : null}
                      {note ? <p className={`text-muted${row.command !== null ? " mt-1" : ""}`}>{note}</p> : null}
                    </td>
                    <td className={TD}>
                      <Done
                        row={row}
                        onClose={onClose}
                        closed={closed.find((c) => c.id === row.id)?.text ?? null}
                        onClosed={(text) => setClosed((list) => [...list, { id: row.id, text }])}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {rights.ok && rights.data.truncated ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          Only the first {rows.length} of {rights.data.count} open requests are shown.
        </p>
      ) : null}
    </section>
  );
}
