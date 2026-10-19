"use client";

import {
  INCIDENT_INFORMATION_TYPES,
  INCIDENT_MITIGATIONS,
  INCIDENT_REPORT_EVENTS,
  type IncidentInformationType,
  type IncidentMitigation,
  type IncidentReportEvent,
} from "@healdesk/catalog";
import { useState, useTransition } from "react";

import type { IncidentClass } from "@/lib/admin/incident-classes";
import type {
  CareOutcome,
  IncidentRegisterRow,
  IncidentReportFields,
  IncidentReportOutcome,
  OpsResult,
} from "@/lib/admin/ops-client";

type Actions = {
  sendReport: (
    clinicId: string,
    incidentId: string,
    fields: IncidentReportFields,
  ) => Promise<OpsResult<IncidentReportOutcome>>;
  notReportable: (
    clinicId: string,
    incidentId: string,
    reason: string,
  ) => Promise<OpsResult<CareOutcome>>;
};

/**
 * The incidents across practices. Each one shows the agreement's deadline
 * and, beside it, healdesk's internal target, labelled as such: the target
 * is never a promise (owner, 12 October 2026), so nothing on this page says
 * a practice is owed news within it.
 */
const CLASS_WORDS: Record<IncidentClass, string> = {
  security_incident: "Security incident",
  improper_use_or_disclosure: "Use or disclosure the agreement does not permit",
  breach: "Breach of unsecured PHI",
  service_complaint: "Service complaint",
};

const EVENTS = Object.entries(INCIDENT_REPORT_EVENTS) as [IncidentReportEvent, { label: string }][];
const INFO_TYPES = Object.entries(INCIDENT_INFORMATION_TYPES) as [
  IncidentInformationType,
  { many: string },
][];
const MITIGATIONS = Object.entries(INCIDENT_MITIGATIONS) as [IncidentMitigation, string][];

/**
 * The list of who an incident affected, as the console says it: a count,
 * never who, and how it is recorded (from the app's own shell, by contact
 * id; never here, since the list is patient information and this console
 * is on the side without a business associate agreement).
 */
export function affectedLine(count: number | null): string {
  if (count === null) return "Not known here until apps/app is deployed.";
  const how =
    "Record it by contact id with bash infra/aws/scripts/run-task.sh incident-affected (npm run ops:incident-affected on a development machine); the practice reads it on the incident's page in its portal, behind its passkey, once a report has gone. The report itself never names anyone.";
  return count === 0
    ? `No one recorded yet. ${how}`
    : `${count} ${count === 1 ? "person" : "people"} recorded. ${how}`;
}

function describe(result: OpsResult<{ status: string; message?: string }>): string | null {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message ?? "Refused.";
  return null;
}

export function IncidentsBoard({
  register,
  now,
  actions,
}: {
  register: OpsResult<IncidentRegisterRow[]>;
  now: string;
  actions: Actions;
}) {
  if (!register.ok) {
    return (
      <main className="mx-auto max-w-[1000px] px-5 py-10">
        <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">Incidents</h1>
        <p className="text-red-deep mt-4 font-semibold">{register.message}</p>
      </main>
    );
  }
  const open = register.data.filter((i) => !i.resolvedAt);
  const undecided = open.filter(
    (i) => i.class !== "service_complaint" && i.reportsSent === 0 && !i.notReportableAt,
  );
  return (
    <main className="mx-auto max-w-[1000px] px-5 py-10 sm:px-8">
      <h1 className="font-display text-[28px] font-semibold tracking-[-0.02em]">Incidents</h1>
      <p className="text-muted mt-3 max-w-[72ch] text-[15.6px]">
        Every practice&rsquo;s open incidents, and those resolved in the last 90 days. Each shows
        two deadlines: the one the practice&rsquo;s agreement promises, and our internal target,
        which is stricter and never a promise to anyone. Decide each one: send the report, built
        from fixed fields only, or record why it isn&rsquo;t reportable. Nothing reaches a practice
        unless you send it here. The list of people affected is never emailed: it goes separately,
        by secure transfer. Open, notify and resolve incidents on each practice&rsquo;s care page.
      </p>
      <p className="text-muted mt-2 max-w-[72ch] text-sm">
        The agreements&rsquo; promise, word for word: notice &ldquo;without unreasonable delay and
        in no case later than 60 calendar days&rdquo; after discovery, under BAA 1.2.2 on and the
        DPA. BAA 1.2.1 and before promised five calendar days for a breach and five business days
        for the rest, and a practice with no agreement on file gets that, the strictest rule.
      </p>
      <p className="mt-4 text-sm font-semibold">
        {open.length} open · {undecided.length} waiting for a decision
      </p>
      {register.data.length === 0 ? (
        <p className="text-muted mt-6 text-sm">No incidents.</p>
      ) : (
        <ul className="mt-6 grid gap-4">
          {register.data.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} now={now} actions={actions} />
          ))}
        </ul>
      )}
    </main>
  );
}

function IncidentCard({
  incident,
  now,
  actions,
}: {
  incident: IncidentRegisterRow;
  now: string;
  actions: Actions;
}) {
  const [mode, setMode] = useState<"none" | "report" | "not_reportable">("none");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const resolved = Boolean(incident.resolvedAt);
  const waiting = !resolved && !incident.notifiedAt && !incident.notReportableAt;
  const pastTarget = waiting && incident.targetNotifyByIso < now;
  const pastAgreement =
    waiting && incident.agreementNotifyByIso !== null && incident.agreementNotifyByIso < now;
  const decidable =
    !resolved && incident.class !== "service_complaint" && !incident.notReportableAt;

  return (
    <li
      className={`border-line rounded-md border bg-white p-5 text-sm ${resolved ? "opacity-70" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <a href={`/admin/ops/${incident.clinicId}/care`} className="font-semibold underline">
          {incident.clinicName}
        </a>
        <span className="font-semibold">· {CLASS_WORDS[incident.class]}</span>
        <span className="text-muted text-xs">
          discovered {incident.discoveredAt} · opened by {incident.openedBy}
        </span>
        {resolved ? (
          <span className="text-done ml-auto text-xs font-bold">
            resolved {incident.resolvedAt}
          </span>
        ) : null}
      </div>
      <p className="mt-2">{incident.summary}</p>
      {incident.conversationId ? (
        <p className="text-muted mt-1 text-xs">conversation {incident.conversationId}</p>
      ) : null}

      <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted font-bold uppercase">The agreement&rsquo;s deadline</dt>
        <dd className={pastAgreement ? "text-red-deep font-bold" : ""}>
          {incident.agreementNotifyBy
            ? `${incident.agreementNotifyBy}${incident.agreementVersion ? ` (agreement ${incident.agreementVersion})` : " (no agreement on file: the strictest rule)"}${pastAgreement ? " — PAST THE AGREEMENT'S DEADLINE" : ""}`
            : "None: a service complaint is no agreement's to report."}
        </dd>
        <dt className="text-muted font-bold uppercase">Our internal target</dt>
        <dd className={pastTarget ? "text-red-deep font-bold" : ""}>
          {incident.targetNotifyBy}
          {pastTarget ? " — past our target" : ""} · internal only, never a promise
        </dd>
        {incident.ftcNotifyBy ? (
          <>
            <dt className="text-muted font-bold uppercase">
              The practice tells the people affected
            </dt>
            <dd>by {incident.ftcNotifyBy} (state breach law)</dd>
          </>
        ) : null}
        <dt className="text-muted font-bold uppercase">Decision</dt>
        <dd>
          {incident.notReportableAt
            ? `Not reportable (${incident.notReportableAt}, ${incident.decidedBy ?? "ops"}): ${incident.notReportableReason ?? ""}`
            : incident.reportsSent > 0
              ? `Report sent ${incident.reportedAt}${incident.reportsSent > 1 ? `, with ${incident.reportsSent - 1} update(s)` : ""}`
              : incident.class === "service_complaint"
                ? "Answer it in the reply thread: nothing is reported."
                : resolved
                  ? "None recorded."
                  : "Waiting"}
          {incident.notifiedAt ? ` · practice told ${incident.notifiedAt}` : ""}
        </dd>
        {incident.class !== "service_complaint" ? (
          <>
            <dt className="text-muted font-bold uppercase">Who it affected</dt>
            <dd>{affectedLine(incident.affectedCount)}</dd>
          </>
        ) : null}
      </dl>

      {decidable ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode(mode === "report" ? "none" : "report")}
            className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
          >
            {incident.reportsSent > 0 ? "Send an update" : "Send report"}
          </button>
          {incident.reportsSent === 0 ? (
            <button
              type="button"
              onClick={() => setMode(mode === "not_reportable" ? "none" : "not_reportable")}
              className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold"
            >
              Not reportable
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === "report" ? (
        <ReportForm
          incident={incident}
          onSent={(message) => {
            setMode("none");
            setDone(message);
          }}
          onProblem={setProblem}
          send={actions.sendReport}
        />
      ) : null}
      {mode === "not_reportable" ? (
        <NotReportableForm
          incident={incident}
          onDone={() => {
            setMode("none");
            setDone("Recorded as not reportable.");
          }}
          onProblem={setProblem}
          record={actions.notReportable}
        />
      ) : null}
      {problem ? <p className="text-red-deep mt-3 text-xs">{problem}</p> : null}
      {done ? <p className="text-done mt-3 text-xs">{done}</p> : null}
    </li>
  );
}

function ReportForm({
  incident,
  send,
  onSent,
  onProblem,
}: {
  incident: IncidentRegisterRow;
  send: Actions["sendReport"];
  onSent: (message: string) => void;
  onProblem: (message: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const discoveredOn = incident.discoveredAt.slice(0, 10);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const occurredOn = String(f.get("occurredOn") ?? "").trim();
        const info = INFO_TYPES.flatMap(([type]) => {
          const raw = String(f.get(`count:${type}`) ?? "").trim();
          return raw === "" ? [] : [{ type, count: Number(raw) }];
        });
        const fields: IncidentReportFields = {
          event: String(f.get("event")) as IncidentReportEvent,
          ...(occurredOn ? { occurredOn } : {}),
          info,
          mitigations: MITIGATIONS.filter(([code]) => f.get(`done:${code}`) === "on").map(
            ([code]) => code,
          ),
        };
        const kind = incident.reportsSent > 0 ? "this update" : "this report";
        if (
          !window.confirm(
            `Email ${kind} to ${incident.clinicName}'s address now? It can't be unsent.`,
          )
        )
          return;
        start(async () => {
          onProblem(null);
          const result = await send(incident.clinicId, incident.id, fields);
          const message = describe(result);
          if (message) onProblem(message);
          else if (result.ok && result.data.status === "sent") {
            onSent(
              `${result.data.report === 1 ? "Report" : `Update ${result.data.report - 1}`} queued: it goes to the practice's address now.${result.data.auditRecorded ? "" : " It is NOT in the audit log: record it by hand."}`,
            );
          }
        });
      }}
      className="border-line mt-4 grid gap-4 rounded-sm border p-4"
    >
      <p className="text-xs font-bold uppercase">
        {incident.reportsSent > 0 ? "An update to the report" : "The report"}: fixed fields only
      </p>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">What happened</span>
        <select
          name="event"
          required
          className="border-line mt-1 w-full rounded-sm border px-3 py-2"
        >
          {EVENTS.map(([code, words]) => (
            <option key={code} value={code}>
              {words.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">
          When it happened (empty while not known; discovered {discoveredOn})
        </span>
        <input
          name="occurredOn"
          type="date"
          max={discoveredOn}
          className="border-line mt-1 rounded-sm border px-3 py-2"
        />
      </label>
      <fieldset className="text-sm">
        <legend className="text-muted text-xs font-bold uppercase">
          The information involved: a count for each type (empty if none, or not yet known)
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {INFO_TYPES.map(([type, words]) => (
            <label key={type} className="flex items-center gap-2">
              <input
                name={`count:${type}`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                className="border-line w-24 rounded-sm border px-2 py-1"
              />
              <span>{words.many}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="text-sm">
        <legend className="text-muted text-xs font-bold uppercase">What we&rsquo;ve done</legend>
        <div className="mt-2 grid gap-1">
          {MITIGATIONS.map(([code, sentence]) => (
            <label key={code} className="flex items-start gap-2">
              <input name={`done:${code}`} type="checkbox" className="mt-1" />
              <span>{sentence}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-muted text-xs">
        The email names no one. For a breach it says the identification of each person affected
        comes separately, by secure transfer. Its contact is a reply to the email, which reaches
        hello@.
      </p>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
        >
          {incident.reportsSent > 0 ? "Send the update" : "Send the report"}
        </button>
      </div>
    </form>
  );
}

function NotReportableForm({
  incident,
  record,
  onDone,
  onProblem,
}: {
  incident: IncidentRegisterRow;
  record: Actions["notReportable"];
  onDone: () => void;
  onProblem: (message: string | null) => void;
}) {
  const [pending, start] = useTransition();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
        start(async () => {
          onProblem(null);
          const result = await record(incident.clinicId, incident.id, reason);
          const message = describe(result);
          if (message) onProblem(message);
          else onDone();
        });
      }}
      className="border-line mt-4 grid gap-3 rounded-sm border p-4"
    >
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">
          Why it isn&rsquo;t reportable (in ids and counts; a number, an address or a name is
          refused)
        </span>
        <textarea
          name="reason"
          required
          maxLength={2000}
          rows={3}
          placeholder="A routine unsuccessful attempt that compromised nothing: the agreement reports those once, in its own text."
          className="border-line mt-1 w-full rounded-sm border px-3 py-2"
        />
      </label>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold"
        >
          Record as not reportable
        </button>
      </div>
    </form>
  );
}
