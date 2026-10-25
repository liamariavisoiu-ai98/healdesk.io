"use client";

import {
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_PATIENT_STEPS,
  INCIDENT_RECOMMENDATIONS,
  INCIDENT_REPORT_EVENTS,
  type IncidentInformationType,
  type IncidentMitigation,
  type IncidentPatientStep,
  type IncidentRecommendation,
  type IncidentReportEvent,
} from "@healdesk/catalog";
import { useState } from "react";

import { APPROVAL_KIND_WORDS, expiryWords, FACTS_NOT_READ, NO_LONGER_NEEDED, onDay, waitingWords, whenWords, type Decided } from "@/components/admin/approval-words";
import {
  BATCH_CLASS_WORDS,
  batchClinicState,
  batchCountWords,
  PICK_EVENT_WORDS,
  REACH_WORDS,
  reportFactLines,
  reportReady,
  scopeWords,
  shownWords,
} from "@/components/admin/incident-words";
import { Tag } from "@/components/admin/ui";
import { clinicTabPath } from "@/lib/admin/issue-link";
import type { IncidentApprovalItem, IncidentBatchFacts, IncidentReportChoices, IncidentReportFacts } from "@/lib/admin/ops-client";

import { ClinicName, DecisionForm, type DecideApproval } from "./ApprovalDecision";

/**
 * The incident assistant's two items as cards (ops automation lane P6j; the
 * kinds are lane P6i's, apps/app lib/approvals/incident-kinds.ts), drawn
 * under Queues › Approvals and under Compliance › Incidents › Incident
 * assistant, both from fetchIncidentApprovals:
 *
 *   - a batch lists the clinics that would get an incident, each with its
 *     conversations in the window, its agreement version and both clocks,
 *     before Approve; the packet lists at most 20 and counts them all, and
 *     the card says so;
 *   - a report shows both clocks, the agreement's deadline and our own
 *     target labelled as never shown to the clinic, and the report's choices
 *     pre-filled from fixed lists (lib/incidents/assistant/report-draft.ts).
 *     The owner edits by choosing from the catalog's lists (packages/catalog
 *     operator-notices.ts): what happened, the day it happened, the
 *     information involved with a count each, what we did, what the people
 *     affected can do, what we recommend, and for a breach the law
 *     enforcement delay. Approve carries the choices as they stand; apps/app
 *     holds them to the sender's own rules before anything is recorded. A
 *     report with nothing picked for what happened cannot go, so Approve
 *     waits until one is.
 */

const EVENTS = Object.entries(INCIDENT_REPORT_EVENTS) as [IncidentReportEvent, { label: string }][];
const INFO_TYPES = Object.entries(INCIDENT_INFORMATION_TYPES) as [IncidentInformationType, { many: string }][];
const MITIGATIONS = Object.entries(INCIDENT_MITIGATIONS) as [IncidentMitigation, string][];
const STEPS = Object.entries(INCIDENT_PATIENT_STEPS) as [IncidentPatientStep, string][];
const RECOMMENDATIONS = Object.entries(INCIDENT_RECOMMENDATIONS) as [IncidentRecommendation, string][];

const LABEL = "text-muted block text-[13.2px] font-bold tracking-[0.06em] uppercase";
const FIELD = "border-line mt-1 rounded-sm border bg-white px-3 py-2";

function Facts({ lines }: { lines: [string, string][] }) {
  return (
    <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
      {lines.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BatchFacts({ facts }: { facts: IncidentBatchFacts }) {
  const shown = shownWords(facts);
  return (
    <>
      <Facts
        lines={[
          ["Scope", scopeWords(facts)],
          ["Reach", REACH_WORDS[facts.reach]],
          ["Class", BATCH_CLASS_WORDS[facts.incidentClass]],
          ["Discovered", whenWords(facts.discoveredAt)],
          ["Clinics", batchCountWords(facts)],
        ]}
      />
      {shown ? <p className="text-muted mt-2 text-sm">{shown}</p> : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">
              <th className="py-1 pr-3">Clinic</th>
              <th className="py-1 pr-3">Conversations in the window</th>
              <th className="py-1 pr-3">Agreement</th>
              <th className="py-1 pr-3">Agreement deadline</th>
              <th className="py-1 pr-3">Our own target (never shown to the clinic)</th>
              <th className="py-1">State</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {facts.clinics.map((clinic) => (
              <tr key={clinic.clinicId}>
                <td className="py-1.5 pr-3">
                  {clinic.inService ? (
                    <a href={clinicTabPath(clinic.clinicId, "care")} className="font-semibold underline underline-offset-2">
                      {clinic.clinicName ?? "A clinic with no printable name"}
                    </a>
                  ) : (
                    <span className="font-semibold">{clinic.clinicName ?? "A clinic no longer in service"}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">{clinic.conversations}</td>
                <td className="py-1.5 pr-3">{clinic.agreementVersion ?? "none on file"}</td>
                <td className="py-1.5 pr-3">{clinic.clocks.agreementDeadline ? onDay(clinic.clocks.agreementDeadline) : "none"}</td>
                <td className="py-1.5 pr-3">{whenWords(clinic.clocks.internalTarget)}</td>
                <td className="py-1.5">{batchClinicState(clinic)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The report's choices, every one from a closed list, as the owner may change them. */
function ReportChoices({
  facts,
  choices,
  onChange,
}: {
  facts: IncidentReportFacts;
  choices: IncidentReportChoices;
  onChange: (choices: IncidentReportChoices) => void;
}) {
  const discoveredOn = facts.discoveredAt.slice(0, 10);
  const breach = facts.incidentClass === "breach";
  const advice = RECOMMENDATIONS.filter(([code]) => breach || code !== "notify_people");
  const toggle = <T extends string>(list: T[], code: T, on: boolean): T[] => (on ? [...new Set([...list, code])] : list.filter((c) => c !== code));
  return (
    <div className="border-line mt-3 grid gap-4 rounded-sm border p-4 text-sm">
      <p className="text-muted text-[13.2px] font-bold tracking-[0.06em] uppercase">The report&rsquo;s choices: fixed lists only, nothing typed</p>
      <label>
        <span className={LABEL}>What happened</span>
        <select name="event" value={choices.event ?? ""} onChange={(event) => onChange({ ...choices, event: event.target.value === "" ? null : (event.target.value as IncidentReportEvent) })} className={`${FIELD} w-full`}>
          <option value="">Not picked yet</option>
          {EVENTS.map(([code, words]) => (
            <option key={code} value={code}>
              {words.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={LABEL}>The day it happened (empty while not known; discovered {discoveredOn})</span>
        <input name="occurredOn" type="date" max={discoveredOn} value={choices.occurredOn ?? ""} onChange={(event) => onChange({ ...choices, occurredOn: event.target.value || null })} className={FIELD} />
      </label>
      <fieldset>
        <legend className={LABEL}>The information involved: a count for each type (empty if none, or not yet known)</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {INFO_TYPES.map(([type, words]) => {
            const row = choices.info.find((r) => r.type === type);
            return (
              <label key={type} className="flex items-center gap-2">
                <input
                  name={`count:${type}`}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={row?.count ?? ""}
                  onChange={(event) => {
                    const n = Number(event.target.value);
                    const rest = choices.info.filter((r) => r.type !== type);
                    onChange({ ...choices, info: event.target.value === "" || !Number.isInteger(n) || n < 1 ? rest : [...rest, { type, count: n }] });
                  }}
                  className="border-line w-24 rounded-sm border bg-white px-2 py-1"
                />
                <span>{words.many}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className={LABEL}>What we&rsquo;ve done</legend>
        <div className="mt-2 grid gap-1">
          {MITIGATIONS.map(([code, sentence]) => (
            <label key={code} className="flex items-start gap-2">
              <input name={`done:${code}`} type="checkbox" className="mt-1" checked={choices.mitigations.includes(code)} onChange={(event) => onChange({ ...choices, mitigations: toggle(choices.mitigations, code, event.target.checked) })} />
              <span>{sentence}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className={LABEL}>What the people affected can do (a breach&rsquo;s report must give these, in writing)</legend>
        <div className="mt-2 grid gap-1">
          {STEPS.map(([code, sentence]) => (
            <label key={code} className="flex items-start gap-2">
              <input name={`step:${code}`} type="checkbox" className="mt-1" checked={choices.steps.includes(code)} onChange={(event) => onChange({ ...choices, steps: toggle(choices.steps, code, event.target.checked) })} />
              <span>{sentence}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className={LABEL}>What we recommend the practice do</legend>
        <div className="mt-2 grid gap-1">
          {advice.map(([code, sentence]) => (
            <label key={code} className="flex items-start gap-2">
              <input name={`advise:${code}`} type="checkbox" className="mt-1" checked={choices.recommendations.includes(code)} onChange={(event) => onChange({ ...choices, recommendations: toggle(choices.recommendations, code, event.target.checked) })} />
              <span>{sentence}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {breach ? (
        <fieldset>
          <legend className={LABEL}>Notice delayed (45 CFR 164.412)</legend>
          <label className="mt-2 flex items-start gap-2">
            <input name="delayed" type="checkbox" className="mt-1" checked={choices.delayedByLawEnforcement} onChange={(event) => onChange({ ...choices, delayedByLawEnforcement: event.target.checked, delayEndedOn: event.target.checked ? choices.delayEndedOn : null })} />
            <span>A law enforcement official required this notice to be delayed. The report says so.</span>
          </label>
          {choices.delayedByLawEnforcement ? (
            <label className="mt-2 block">
              <span className={LABEL}>The day the delay ended (empty if not to be given)</span>
              <input name="delayEndedOn" type="date" min={discoveredOn} value={choices.delayEndedOn ?? ""} onChange={(event) => onChange({ ...choices, delayEndedOn: event.target.value || null })} className={FIELD} />
            </label>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

export function IncidentCard({
  item,
  now,
  onDecide,
  onLeft,
}: {
  item: IncidentApprovalItem;
  now: string;
  onDecide: DecideApproval;
  onLeft: (id: string, said: Decided) => void;
}) {
  const packet = item.packet;
  const [choices, setChoices] = useState<IncidentReportChoices | null>(packet?.facts.kind === "incident_report_send" ? packet.facts.fields : null);
  const report = packet?.facts.kind === "incident_report_send" ? packet.facts : null;
  const batch = packet?.facts.kind === "incident_open_batch" ? packet.facts : null;
  const held = report && choices && !reportReady(report, choices.event) ? PICK_EVENT_WORDS : null;

  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <ClinicName clinic={item.clinic} tab="care" />
        <span className="flex flex-wrap gap-2">
          <Tag tone="bad">Legal clock</Tag>
          {item.pastDue ? <Tag tone="warn">Past due</Tag> : null}
        </span>
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
      {batch ? <BatchFacts facts={batch} /> : null}
      {report ? <Facts lines={reportFactLines(report)} /> : null}
      {report && choices ? <ReportChoices facts={report} choices={choices} onChange={setChoices} /> : null}
      <p className="text-muted mt-3 text-sm">
        {waitingWords(item, now)}. {expiryWords(item)}
      </p>
      <DecisionForm
        subject={{ id: item.id, kind: item.kind, clinic: item.clinic, irreversible: item.irreversible, hasPacket: packet !== null }}
        onDecide={onDecide}
        onLeft={onLeft}
        edit={report && choices ? { incident: choices } : undefined}
        approveHeldBy={held}
      />
    </li>
  );
}
