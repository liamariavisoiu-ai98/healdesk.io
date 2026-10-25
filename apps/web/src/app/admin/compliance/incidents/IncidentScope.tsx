"use client";

import { useState, useTransition } from "react";

import { onDay, whenWords } from "@/components/admin/approval-words";
import {
  AGREEMENT_DEADLINE_LABEL,
  BATCH_CLASS_WORDS,
  INTERNAL_TARGET_LABEL,
  REACH_WORDS,
  RULE_WORDS,
  SCOPE_CHANNEL_WORDS,
  VENDOR_WORDS,
} from "@/components/admin/incident-words";
import { ActionButton, Tag } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { IncidentProposalOutcome, IncidentScopeQuery, IncidentScopeView, OpsResult } from "@/lib/admin/ops-client";

import { holdsAll, scopeQueryFrom, type ScopeForm } from "./scope-input";

/**
 * The Incident assistant's scope (ops automation lane P6j; the operation is
 * lane P6i's, apps/app lib/ops/incident-assistant-ops.ts incidentScope):
 * which clinics a vendor's incident, or one of our channels', reached in a
 * window, each with its conversations per channel (counted, never read),
 * its agreement version and, once the class and the discovery time are
 * given, both clocks. For the database host and AWS the default is every
 * clinic holding data, the window's counts shown as information; the owner
 * narrows it to the window only when the vendor's notice says the exposure
 * was in transit. healdesk's demo clinic is left out unless asked for.
 *
 * "Propose opening these incidents" puts one item in Approvals for the
 * scope as apps/app reads it again at that moment (proposeIncidentBatch).
 * It opens nothing: the item waits for the owner's yes, with a fresh code,
 * under Approvals on this page and under Queues.
 */

export type ReadScope = (query: IncidentScopeQuery) => Promise<OpsResult<IncidentScopeView>>;
export type ProposeBatch = (query: IncidentScopeQuery) => Promise<OpsResult<IncidentProposalOutcome>>;

export const PROPOSE_NEEDS = "Give the class and the discovery time to propose: each incident is opened with them.";
export const WINDOW_WORDS = "Days are UTC: the window runs from the first day's start to the end of the last, or to now.";
export const SCOPE_INCOMPLETE = (n: number) => `${n} ${n === 1 ? "clinic" : "clinics"} could not be read, so this list may be missing some. Nothing can be proposed until every clinic is read.`;
export const PROPOSE_WORDS = "Propose opening these incidents puts one item in Approvals, read again at that moment. Nothing is opened until you approve it in Approvals.";

/** Where a proposed item waits: the section above on this page, and the Queues page. */
export const WAITS_UNDER = "waiting for your yes under Incident assistant on this page, and under Queues > Approvals";

/** What the proposal answered, in one line. */
export function proposedWords(outcome: Extract<IncidentProposalOutcome, { status: "proposed" | "already_waiting" }>): string {
  if (outcome.status === "already_waiting") return `This scope is already ${WAITS_UNDER}.`;
  return `Proposed: one item${outcome.clinics !== null ? ` for ${outcome.clinics} ${outcome.clinics === 1 ? "clinic" : "clinics"}` : ""} is ${WAITS_UNDER}.`;
}

const LABEL = "text-muted block text-[13.2px] font-bold tracking-[0.06em] uppercase";
const FIELD = "border-line mt-1 rounded-sm border bg-white px-3 py-2";

const EMPTY_FORM: ScopeForm = {
  source: "vendor",
  vendor: "retell",
  channel: "voice",
  fromDay: "",
  toDay: "",
  incidentClass: "",
  discoveredAt: "",
  includeDemo: false,
  reach: "window_only",
};

export function IncidentScope({ now, onRead, onPropose }: { now: string; onRead: ReadScope; onPropose: ProposeBatch }) {
  const [form, setForm] = useState<ScopeForm>(EMPTY_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ query: IncidentScopeQuery; view: IncidentScopeView } | null>(null);
  const [pending, start] = useTransition();
  const all = holdsAll(form);

  function set<K extends keyof ScopeForm>(key: K, value: ScopeForm[K]): void {
    setForm((f) => {
      const next = { ...f, [key]: value };
      // The reach applies to the two holding vendors alone; their default is every clinic holding data.
      next.reach = holdsAll(next) ? (f.reach === "window_only" && holdsAll(f) ? "window_only" : "all_holding") : "window_only";
      return next;
    });
  }

  function read(): void {
    const checked = scopeQueryFrom(form, now);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    start(async () => {
      const answer = await onRead(checked.query);
      if (!answer.ok) {
        setProblem(answer.message);
        setResult(null);
        return;
      }
      setResult({ query: checked.query, view: answer.data });
    });
  }

  const canPropose = result !== null && result.query.class !== undefined && result.query.discoveredAt !== undefined && result.view.unread === 0 && result.view.clinics.length > 0;

  return (
    <div className="mt-4">
      <h3 className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">Find a scope</h3>
      <form
        className="mt-2 grid gap-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          read();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className={LABEL}>Read by</span>
            <select name="source" value={form.source} onChange={(event) => set("source", event.target.value as ScopeForm["source"])} className={FIELD}>
              <option value="vendor">A vendor&rsquo;s incident</option>
              <option value="channel">An incident on one of our channels</option>
            </select>
          </label>
          {form.source === "vendor" ? (
            <label>
              <span className={LABEL}>Vendor</span>
              <select name="vendor" value={form.vendor} onChange={(event) => set("vendor", event.target.value)} className={FIELD}>
                {Object.entries(VENDOR_WORDS).map(([code, words]) => (
                  <option key={code} value={code}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              <span className={LABEL}>Channel</span>
              <select name="channel" value={form.channel} onChange={(event) => set("channel", event.target.value)} className={FIELD}>
                {Object.entries(SCOPE_CHANNEL_WORDS).map(([code, words]) => (
                  <option key={code} value={code}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className={LABEL}>First day</span>
            <input name="fromDay" type="date" value={form.fromDay} onChange={(event) => set("fromDay", event.target.value)} className={FIELD} />
          </label>
          <label>
            <span className={LABEL}>Last day</span>
            <input name="toDay" type="date" value={form.toDay} onChange={(event) => set("toDay", event.target.value)} className={FIELD} />
          </label>
        </div>
        <p className="text-muted">{WINDOW_WORDS}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className={LABEL}>Class (to see the clocks and to propose)</span>
            <select name="incidentClass" value={form.incidentClass} onChange={(event) => set("incidentClass", event.target.value)} className={FIELD}>
              <option value="">Not given yet</option>
              {Object.entries(BATCH_CLASS_WORDS).map(([code, words]) => (
                <option key={code} value={code}>
                  {words}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={LABEL}>Discovered at (your clock)</span>
            <input
              name="discoveredAt"
              type="datetime-local"
              value={form.discoveredAt ? toLocalInput(form.discoveredAt) : ""}
              onChange={(event) => set("discoveredAt", event.target.value ? new Date(event.target.value).toISOString() : "")}
              className={FIELD}
            />
          </label>
          {all ? (
            <label>
              <span className={LABEL}>Reach</span>
              <select name="reach" value={form.reach} onChange={(event) => set("reach", event.target.value)} className={FIELD}>
                {Object.entries(REACH_WORDS).map(([code, words]) => (
                  <option key={code} value={code}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex items-center gap-2 pb-2.5">
            <input name="includeDemo" type="checkbox" checked={form.includeDemo} onChange={(event) => set("includeDemo", event.target.checked)} />
            <span>Include healdesk&rsquo;s demo clinic</span>
          </label>
          <button type="button" onClick={read} disabled={pending} className="bg-ink inline-flex min-h-9 items-center rounded-full px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50">
            {pending ? "Working…" : "Read the scope"}
          </button>
        </div>
        {problem ? (
          <p role="status" className="text-red-deep font-semibold">
            {problem}
          </p>
        ) : null}
      </form>

      {result ? <ScopeResult view={result.view} query={result.query} canPropose={canPropose} onPropose={onPropose} /> : null}
    </div>
  );
}

/** An ISO instant as a datetime-local value in this browser's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ScopeResult({ view, query, canPropose, onPropose }: { view: IncidentScopeView; query: IncidentScopeQuery; canPropose: boolean; onPropose: ProposeBatch }) {
  const holding = view.reach === "all_holding";
  const clocks = view.clinics.some((c) => c.clocks !== null);
  return (
    <div className="mt-4 text-sm">
      <p>
        <span className="font-semibold">
          {view.clinics.length} {view.clinics.length === 1 ? "clinic" : "clinics"} in scope
        </span>
        , {REACH_WORDS[view.reach]}, {whenWords(view.from)} to {whenWords(view.to)}.{" "}
        {view.clinicsWithNone > 0 ? `${view.clinicsWithNone} ${view.clinicsWithNone === 1 ? "clinic was" : "clinics were"} read and ${holding ? "hold nothing" : "had nothing in the window"}.` : ""}
      </p>
      {view.unread > 0 ? (
        <p role="status" className="text-red-deep mt-1 font-semibold">
          {SCOPE_INCOMPLETE(view.unread)}
        </p>
      ) : null}
      {view.clinics.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
                <th className="py-1 pr-3">Clinic</th>
                {view.channels.map((channel) => (
                  <th key={channel} className="py-1 pr-3">
                    {SCOPE_CHANNEL_WORDS[channel]}
                  </th>
                ))}
                {holding ? <th className="py-1 pr-3">Holds data</th> : null}
                <th className="py-1 pr-3">Agreement</th>
                <th className="py-1 pr-3">Covered entity</th>
                {clocks ? <th className="py-1 pr-3">{AGREEMENT_DEADLINE_LABEL}</th> : null}
                {clocks ? <th className="py-1 pr-3">{INTERNAL_TARGET_LABEL}</th> : null}
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {view.clinics.map((clinic) => (
                <tr key={clinic.clinicId}>
                  <td className="py-1.5 pr-3">
                    <a href={clinicTabPath(clinic.clinicId, "care")} className="font-semibold underline underline-offset-2">
                      {clinic.clinicName}
                    </a>
                    {clinic.demo ? (
                      <>
                        {" "}
                        <Tag>Demo</Tag>
                      </>
                    ) : null}
                    {clinic.offboarding ? (
                      <>
                        {" "}
                        <Tag tone="warn">Leaving</Tag>
                      </>
                    ) : null}
                  </td>
                  {view.channels.map((channel) => (
                    <td key={channel} className="py-1.5 pr-3">
                      {clinic.conversations[channel]}
                    </td>
                  ))}
                  {holding ? <td className="py-1.5 pr-3">{clinic.holdsData === null ? "not read" : clinic.holdsData ? "yes" : "no"}</td> : null}
                  <td className="py-1.5 pr-3">{clinic.agreementVersion ?? "none on file"}</td>
                  <td className="py-1.5 pr-3">{clinic.coveredEntity === null ? "not known" : clinic.coveredEntity ? "yes" : "no"}</td>
                  {clocks ? (
                    <td className="py-1.5 pr-3">
                      {clinic.clocks?.agreementDeadline ? `${onDay(clinic.clocks.agreementDeadline)} (${RULE_WORDS[clinic.clocks.agreementRule]})` : "none"}
                    </td>
                  ) : null}
                  {clocks ? <td className="py-1.5 pr-3">{clinic.clocks ? whenWords(clinic.clocks.internalTarget) : ""}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="mt-4 grid gap-2">
        <p className="text-muted">{PROPOSE_WORDS}</p>
        {query.class === undefined || query.discoveredAt === undefined ? <p className="font-semibold">{PROPOSE_NEEDS}</p> : null}
        <ActionButton
          label="Propose opening these incidents"
          variant="primary"
          confirm="Propose this scope for your yes? Nothing is opened now."
          disabled={!canPropose}
          run={() => onPropose(query)}
          done={(data) => (data.status === "refused" ? null : proposedWords(data))}
        />
      </div>
    </div>
  );
}
