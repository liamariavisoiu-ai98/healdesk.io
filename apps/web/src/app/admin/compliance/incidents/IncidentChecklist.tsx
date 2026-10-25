"use client";

import { useState, useTransition } from "react";

import { whenWords } from "@/components/admin/approval-words";
import { CHECKLIST_STEP_WORDS, PROPOSE_REPORT_WORDS, STEP_NEEDS, TICK_CONFIRM, TICK_WORDS } from "@/components/admin/incident-words";
import { ActionButton } from "@/components/admin/ui";
import type { ChecklistStep, IncidentChecklistResult, IncidentChecklistStep, IncidentProposalOutcome, OpsResult, TickIncidentStepOutcome } from "@/lib/admin/ops-client";

/**
 * One incident's checklist on its card (ops automation lane P6j; the
 * operations are lane P6i's, apps/app lib/ops/incident-assistant-ops.ts):
 * the procedure's nine steps in plain words, each ticked or not, with who
 * ticked it and when, read when the owner opens it (incidentChecklist, a
 * read). "Tick" records that a step was done, by the operator account, once
 * and for good (tickIncidentStep: add-only); it never does the step. Two
 * steps are facts the incident row holds, so apps/app refuses their tick
 * until it does, in its own sentence.
 *
 * "Propose the report" puts the incident's next report (the report, then
 * each update), pre-filled from fixed lists, in Approvals, due at the
 * agreement's deadline (proposeIncidentReport). It sends nothing: the item
 * waits for the owner's yes under Approvals on this page and under Queues.
 * Send report, beside it, still sends directly.
 */

export type ReadChecklist = (clinicId: string, incidentId: string) => Promise<OpsResult<IncidentChecklistResult>>;
export type TickStep = (clinicId: string, incidentId: string, step: ChecklistStep) => Promise<OpsResult<TickIncidentStepOutcome>>;
export type ProposeReport = (clinicId: string, incidentId: string) => Promise<OpsResult<IncidentProposalOutcome>>;

export type ChecklistActions = { checklist: ReadChecklist; tick: TickStep; proposeReport: ProposeReport };

/** What the report's proposal answered, in one line. */
export function reportProposedWords(outcome: Extract<IncidentProposalOutcome, { status: "proposed" | "already_waiting" }>): string {
  return outcome.status === "already_waiting"
    ? "This incident's report is already waiting for your yes under Approvals."
    : "Proposed: the report is waiting for your yes under Approvals, on this page and under Queues. Nothing has been sent.";
}

/** A ticked step's line: when, by whom, and what a batch or the affected list left on it. */
export function tickedWords(step: IncidentChecklistStep): string {
  if (step.tickedAt === null) return "not ticked";
  const by = step.fromBatch ? "by an approved batch" : step.tickedBy ? `by ${step.tickedBy}` : "";
  const count = step.step === "affected_list_recorded" && step.affectedCount !== null ? `; ${step.affectedCount} ${step.affectedCount === 1 ? "person" : "people"} recorded then` : "";
  return `Ticked ${whenWords(step.tickedAt)}${by ? ` ${by}` : ""}${count}`;
}

export function IncidentChecklist({
  clinicId,
  incidentId,
  reportable,
  actions,
}: {
  clinicId: string;
  incidentId: string;
  /** Whether the incident awaits a report or an update: a reportable class, open, not recorded not reportable. */
  reportable: boolean;
  actions: ChecklistActions;
}) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<IncidentChecklistStep[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function load(): void {
    start(async () => {
      setProblem(null);
      const result = await actions.checklist(clinicId, incidentId);
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      if (result.data.status === "refused") {
        setProblem(result.data.message);
        return;
      }
      setSteps(result.data.steps);
    });
  }

  return (
    <div className="border-line mt-4 border-t pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
            if (!open && steps === null) load();
          }}
          className="border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 py-1.5 text-sm font-bold transition-colors"
        >
          {open ? "Hide the checklist" : "Checklist"}
        </button>
        {reportable ? (
          <ActionButton
            label="Propose the report"
            run={() => actions.proposeReport(clinicId, incidentId)}
            done={(data) => (data.status === "refused" ? null : reportProposedWords(data))}
          />
        ) : null}
        {reportable ? <span className="text-muted">{PROPOSE_REPORT_WORDS}</span> : null}
      </div>
      {open ? (
        <div className="mt-3">
          <p className="text-muted">{TICK_WORDS}</p>
          {pending && steps === null ? <p className="text-muted mt-2">Reading the checklist…</p> : null}
          {problem ? (
            <p role="status" className="text-red-deep mt-2 font-semibold">
              Could not read the checklist: {problem}
            </p>
          ) : null}
          {steps ? (
            <ol className="mt-2 grid gap-2">
              {steps.map((step, i) => (
                <li key={step.step} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-muted w-5 text-right">{i + 1}.</span>
                  <span className={step.tickedAt ? "font-semibold" : ""}>{CHECKLIST_STEP_WORDS[step.step]}</span>
                  {step.tickedAt ? (
                    <span className="text-done">{tickedWords(step)}</span>
                  ) : (
                    <>
                      {STEP_NEEDS[step.step] ? <span className="text-muted">({STEP_NEEDS[step.step]})</span> : null}
                      <ActionButton
                        label="Tick"
                        confirm={TICK_CONFIRM}
                        run={async () => {
                          const result = await actions.tick(clinicId, incidentId, step.step);
                          if (result.ok && result.data.status !== "refused") load();
                          return result;
                        }}
                        done={(data) => (data.status === "refused" ? null : data.status === "already" ? "Already ticked." : "Ticked.")}
                      />
                    </>
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
