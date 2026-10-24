"use client";

import { useState, useTransition } from "react";

import { Chip, Empty, Failure, Tag } from "@/components/admin/ui";
import type { OpsJob, OpsResult, ToggleJobOutcome } from "@/lib/admin/ops-client";

/**
 * The scheduled jobs as one table (E1 §2, System › Jobs): a switch and the
 * last result per row, nothing else. Until the admin redesign (23 October
 * 2026) these were 32 cards on /admin/ops under a six-line paragraph; ops
 * touches two a month.
 *
 * Every job ships off and is turned on from here when the first live clinic
 * exists; a phase-two job (attribution) can be switched off, never on: the
 * ops API refuses, and the button does not offer what will be refused.
 *
 * A failed toggle says the ops client's sentence, a refusal says upstream's,
 * and a switch whose audit row was not written says so: an unrecorded act
 * that looks recorded is the failure an audit trail exists to prevent.
 */

/**
 * The action half of each button's label. The alert wording names these
 * buttons ("ask the owner before pressing Turn on") and a test in apps/app
 * looks for each quoted name as a string in this file, so they stay whole
 * strings here and the state is put in front of them.
 */
const ACTION = { on: "Turn on", off: "Turn off", phaseTwo: "Phase two" } as const;

export type ToggleJob = (name: string, enabled: boolean) => Promise<OpsResult<ToggleJobOutcome>>;

function JobRow({ job, onToggle }: { job: OpsJob; onToggle: ToggleJob }) {
  const [note, setNote] = useState<{ tone: "bad" | "warn"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const result = job.lastRunStatus === null ? null : job.lastRunStatus === "ok" ? "ok" : job.lastRunStatus === "failed" ? "bad" : "info";
  return (
    <tr className="border-line border-t align-top">
      <th scope="row" className="px-3 py-2 text-left font-semibold whitespace-nowrap">
        {job.name}
        {job.phaseTwo ? (
          <span className="ml-2">
            <Tag tone="muted">phase two</Tag>
          </span>
        ) : null}
      </th>
      <td className="px-3 py-2">
        <button
          type="button"
          disabled={pending || (job.phaseTwo && !job.enabled)}
          onClick={() => {
            setNote(null);
            start(async () => {
              const outcome = await onToggle(job.name, !job.enabled);
              if (!outcome.ok) return setNote({ tone: "bad", text: outcome.message });
              if (outcome.data.status === "refused") return setNote({ tone: "bad", text: outcome.data.message });
              if (!outcome.data.auditRecorded) {
                setNote({ tone: "warn", text: "Done, but the audit entry could not be written. Tell whoever keeps the security log." });
              }
            });
          }}
          className={`min-h-9 shrink-0 rounded-full border px-4 py-1.5 text-sm font-bold whitespace-nowrap transition-colors disabled:opacity-50 ${job.enabled ? "border-line-strong hover:border-ink" : "bg-ink border-ink text-white"}`}
        >
          {pending ? "Working…" : job.enabled ? `On · ${ACTION.off}` : job.phaseTwo ? `Off · ${ACTION.phaseTwo}` : `Off · ${ACTION.on}`}
        </button>
        {job.runningSince ? (
          <span className="ml-2">
            <Chip tone="info" title={`since ${job.runningSince}`}>
              running
            </Chip>
          </span>
        ) : null}
        {note ? (
          <p role="status" className={`mt-1 text-xs font-semibold ${note.tone === "bad" ? "text-red-deep" : "text-ink"}`}>
            {note.text}
          </p>
        ) : null}
      </td>
      <td className="text-muted px-3 py-2 text-sm">{job.cadence}</td>
      <td className="px-3 py-2 text-sm whitespace-nowrap">{job.lastRunAt ?? "never"}</td>
      <td className="px-3 py-2 text-sm">
        {result ? <Chip tone={result === "ok" ? "ok" : result === "bad" ? "bad" : "info"}>{job.lastRunStatus}</Chip> : <span className="text-muted">—</span>}
        {job.lastRunNote ? (
          <span className="text-muted line-clamp-2 block max-w-[28rem] text-xs break-words" title={job.lastRunNote}>
            {job.lastRunNote}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

export function JobsTable({ jobs, onToggle }: { jobs: OpsResult<OpsJob[]>; onToggle: ToggleJob }) {
  if (!jobs.ok) return <Failure failure={jobs} what="the scheduled jobs" />;
  if (jobs.data.length === 0) return <Empty>No scheduled jobs are registered on this host.</Empty>;
  return (
    <div className="border-line mt-4 overflow-x-auto rounded-md border bg-white">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="text-muted text-xs tracking-[0.06em] uppercase">
          <tr>
            <th scope="col" className="px-3 py-3 font-bold">Job</th>
            <th scope="col" className="px-3 py-3 font-bold">Switch (press to change)</th>
            <th scope="col" className="px-3 py-3 font-bold">Cadence</th>
            <th scope="col" className="px-3 py-3 font-bold">Last run</th>
            <th scope="col" className="px-3 py-3 font-bold">Result</th>
          </tr>
        </thead>
        <tbody>
          {jobs.data.map((job) => (
            <JobRow key={job.name} job={job} onToggle={onToggle} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
