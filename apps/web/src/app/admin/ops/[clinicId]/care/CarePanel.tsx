"use client";

import { useState, useTransition } from "react";

import { INCIDENT_CLASSES, type IncidentClass } from "@/lib/admin/incident-classes";
import type { CareOutcome, CareView, OpenIncidentOutcome, OpsResult } from "@/lib/admin/ops-client";
import {
  ERASURE_STEP_OUTCOMES,
  HANDOVER_URL,
  PATIENT_ENTRY_SCRIPTS,
  type ErasureStepOutcome,
} from "@/lib/admin/patient-rights";

type Actions = {
  addRecipient: (email: string, label?: string) => Promise<OpsResult<CareOutcome>>;
  removeRecipient: (email: string) => Promise<OpsResult<CareOutcome>>;
  openIncident: (input: {
    class: IncidentClass;
    summary: string;
    conversationId?: string;
    discoveredAt?: string;
  }) => Promise<OpsResult<OpenIncidentOutcome>>;
  markNotified: (incidentId: string, how: string) => Promise<OpsResult<CareOutcome>>;
  resolve: (incidentId: string, resolution: string) => Promise<OpsResult<CareOutcome>>;
  startOffboarding: (reason: string) => Promise<OpsResult<CareOutcome>>;
  markExportDelivered: (how: string) => Promise<OpsResult<CareOutcome>>;
  markVoiceVendorDataDeleted: (how: string) => Promise<OpsResult<CareOutcome>>;
  markErasureVendorDeleted: (erasureId: string, step: "retell", how: ErasureStepOutcome) => Promise<OpsResult<CareOutcome>>;
};

// The clocks apps/app computes (lib/incidents/incidents.ts): BAA 1.3.0 gives
// every clinic 24 hours from discovery for the first three classes, whichever
// version it signed.
const CLASS_LABELS: Record<IncidentClass, string> = {
  security_incident: "Security incident (24 hours to tell the clinic)",
  improper_use_or_disclosure: "Use or disclosure the BAA does not permit (24 hours)",
  breach: "Breach of unsecured PHI (24 hours)",
  service_complaint: "Service complaint (2 business days to a first reply)",
};

function describe(result: OpsResult<CareOutcome> | OpsResult<OpenIncidentOutcome>): string | null {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message;
  return null;
}

export function CarePanel({ view, actions }: { view: OpsResult<CareView>; actions: Actions }) {
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-[900px] px-5 py-10">
        <p className="text-red-deep font-semibold">{view.message}</p>
        <a href="/admin/ops" className="mt-4 inline-block underline">Back to ops</a>
      </main>
    );
  }
  const v = view.data;
  const open = v.incidents.filter((i) => !i.resolvedAt);

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10 sm:px-8">
      <a href="/admin/ops" className="text-muted text-sm underline">← Ops</a>
      <h1 className="font-display mt-3 text-[32px] font-medium tracking-[-0.02em]">{v.clinic.name}</h1>
      <p className="text-muted mt-1 text-sm">
        {v.clinic.dataClassification}
        {v.clinic.wentLiveOn ? ` · live since ${v.clinic.wentLiveOn}` : " · not live"}
        {v.clinic.isCoveredEntity === false ? " · not a covered entity (state breach law applies)" : ""}
        {" · "}
        <a href={`/admin/ops/${v.clinic.id}/onboarding`} className="underline">onboarding</a>
      </p>

      <Section title={`Who gets the reports — ${v.recipients.length}`}>
        <p className="text-muted text-sm">
          The weekly recap, the booking-request notices, the two live alerts and the renewal notice go to every address
          here. Counts and links only; never a caller. The monthly report is phase two and is not sent in v1. The buyer is
          added at provisioning.
        </p>
        <ul className="mt-3 grid gap-2">
          {v.recipients.map((r) => (
            <RecipientRow key={r.email} recipient={r} onRemove={actions.removeRecipient} />
          ))}
        </ul>
        <AddRecipientForm onAdd={actions.addRecipient} />
      </Section>

      <Section title={`What was sent — last ${v.deliveries.length}`}>
        {v.deliveries.length === 0 ? (
          <p className="text-muted text-sm">Nothing yet. The first weekly recap arrives seven days after go-live.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th className="py-1 pr-3">When (UTC)</th>
                  <th className="py-1 pr-3">Kind</th>
                  <th className="py-1 pr-3">Period</th>
                  <th className="py-1 pr-3">To</th>
                  <th className="py-1 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {v.deliveries.map((d, i) => (
                  <tr key={i} className="border-line border-t">
                    <td className="py-1 pr-3 whitespace-nowrap">{d.attemptedAt}</td>
                    <td className="py-1 pr-3">{d.kind}</td>
                    <td className="py-1 pr-3">{d.periodKey}</td>
                    <td className="py-1 pr-3">{d.recipient}</td>
                    <td className={`py-1 pr-3 ${d.status === "sent" ? "text-done" : d.status === "failed" ? "text-red-deep" : "text-muted"}`}>
                      {d.status}
                      {d.reason && d.status !== "sent" ? <span className="text-muted block text-xs">{d.reason}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={`Incidents — ${open.length} open`}>
        <p className="text-muted text-sm">
          Opening one starts the clock the agreement promises. Write the summary in ids and counts — a phone number,
          an email address or a name is refused. The conversation id is the pointer to the evidence. Procedure:
          docs/incident-response.md.
        </p>
        <ul className="mt-3 grid gap-3">
          {v.incidents.map((i) => (
            <IncidentRow key={i.id} incident={i} actions={actions} />
          ))}
        </ul>
        <OpenIncidentForm onOpen={actions.openIncident} />
      </Section>

      <Section title={`Deletion requests — ${v.deletionRequests.length}`}>
        <DeletionRequests view={v} actions={actions} />
      </Section>

      <Section title="Amendments">
        <Amendments view={v} />
      </Section>

      <Section title="Offboarding">
        <Offboarding view={v} actions={actions} />
      </Section>
    </main>
  );
}

/**
 * One person deleted on the practice's request (docs/handover.md, "Deletion
 * requests"). The person's number and address are never typed here: the
 * deletion runs in apps/app's own shell, so nothing of the person crosses
 * apps/web. What this page shows is the record of each request, who asked
 * (one of three), the dates, the counts and each subcontractor step, and
 * what it sends is the request's id and a closed outcome for a step.
 */
function DeletionRequests({ view, actions }: { view: CareView; actions: Actions }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return (
    <div className="text-sm">
      <p className="text-muted">
        When the practice asks us to delete a person, delete them within ten business days of the request reaching us,
        then do each subcontractor step in the vendor&rsquo;s own console and record it below. The deletion runs in
        apps/app, never on this page: <code>{PATIENT_ENTRY_SCRIPTS.erase}</code>, on the AWS host by contact id, through
        run-task.sh only, with this clinic&rsquo;s id ({view.clinic.id}) in <code>HEALDESK_ERASURE_CLINIC_ID</code>{" "}
        (<a className="underline" href={`${HANDOVER_URL}#deletion-requests`}>handover, &ldquo;Deletion requests&rdquo;</a>).
      </p>
      {view.deletionRequests.length ? (
        <ul className="mt-3 grid gap-3">
          {view.deletionRequests.map((r) => (
            <li key={r.id} className="border-line rounded-xl border px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">Asked by {r.requestedBy}</span>
                <span className="text-muted text-xs">
                  received {r.receivedAt} · deleted {r.erasedAt} · {r.rows} rows
                </span>
              </div>
              <ul className="mt-2 grid gap-1 text-xs">
                {r.steps.map((step) =>
                  step.stampedAt ? (
                    <li key={step.id} className="text-done">
                      {step.label}: recorded {step.stampedAt} by {step.stampedBy}
                      {step.how ? ` (${step.how})` : ""}.
                    </li>
                  ) : (
                    <li key={step.id} className={r.dueBy < now ? "text-red-deep font-bold" : "text-red-deep"}>
                      Outstanding: {step.label}, by {r.dueBy}
                      {r.dueBy < now ? " — OVERDUE" : ""}.{" "}
                      {(Object.entries(ERASURE_STEP_OUTCOMES) as [ErasureStepOutcome, string][]).map(([how, label]) => (
                        <button
                          key={how}
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            if (!window.confirm(`Record "${label}" for this step?`)) return;
                            start(async () => setProblem(describe(await actions.markErasureVendorDeleted(r.id, step.id, how))));
                          }}
                          className="border-line-strong ml-1 rounded-full border px-2 py-0.5 font-bold"
                        >
                          {label}
                        </button>
                      ))}
                    </li>
                  ),
                )}
              </ul>
              <p className="text-muted mt-1 text-xs">
                {r.restoreRecordUntil
                  ? `The record keeps keyed references, to delete the person again after a restore, until ${r.restoreRecordUntil}.`
                  : "The record's restore references have expired; it holds no reference to the person."}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? <p className="text-red-deep mt-3 text-xs">{problem}</p> : null}
    </div>
  );
}

/**
 * The practice's amendments and corrections (docs/handover.md,
 * "Amendments"): counts only. The words and the corrected details are never
 * typed here; the operator enters them in apps/app's own shell, so nothing
 * of a patient crosses apps/web.
 */
function Amendments({ view }: { view: CareView }) {
  return (
    <div className="text-sm">
      <p>
        {view.patientRights.amendments} amendment{view.patientRights.amendments === 1 ? "" : "s"} appended ·{" "}
        {view.patientRights.corrections} contact correction{view.patientRights.corrections === 1 ? "" : "s"}
      </p>
      <p className="text-muted mt-2">
        When the practice directs an amendment, record it within ten business days in apps/app, never on this page:{" "}
        <code>{PATIENT_ENTRY_SCRIPTS.amendRecord}</code> for a booking request, a conversation or an appointment, and{" "}
        <code>{PATIENT_ENTRY_SCRIPTS.amendContact}</code> to correct or clear a contact&rsquo;s name, number or address.
        On the AWS host only clearing a field runs, by contact id, through run-task.sh; an amendment&rsquo;s words and
        corrected details wait for the portal (<a className="underline" href={`${HANDOVER_URL}#amendments`}>handover, &ldquo;Amendments&rdquo;</a>).
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line mt-8 rounded-2xl border bg-white p-5">
      <h2 className="text-[13.2px] font-bold tracking-[0.06em] uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function RecipientRow({
  recipient,
  onRemove,
}: {
  recipient: CareView["recipients"][number];
  onRemove: Actions["removeRecipient"];
}) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <li className="border-line flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{recipient.email}</span>
        {recipient.label ? <span className="text-muted ml-2">{recipient.label}</span> : null}
        <span className="text-muted block text-xs">added {recipient.addedOn} by {recipient.addedBy}</span>
        {problem ? <span className="text-red-deep block text-xs">{problem}</span> : null}
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            setProblem(describe(await onRemove(recipient.email)));
          })
        }
        className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
      >
        Remove
      </button>
    </li>
  );
}

function AddRecipientForm({ onAdd }: { onAdd: Actions["addRecipient"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const f = new FormData(form);
        const email = String(f.get("email") ?? "").trim();
        const label = String(f.get("label") ?? "").trim();
        start(async () => {
          setProblem(null);
          const result = await onAdd(email, label || undefined);
          const message = describe(result);
          setProblem(message);
          if (!message) form.reset();
        });
      }}
      className="mt-4 flex flex-wrap items-end gap-3"
    >
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Email</span>
        <input name="email" type="email" required className="border-line mt-1 rounded-lg border px-3 py-2" />
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Label (optional)</span>
        <input name="label" maxLength={120} placeholder="Front desk" className="border-line mt-1 rounded-lg border px-3 py-2" />
      </label>
      <button type="submit" disabled={pending} className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white">
        Add recipient
      </button>
      {problem ? <p className="text-red-deep w-full text-xs">{problem}</p> : null}
    </form>
  );
}

function IncidentRow({ incident, actions }: { incident: CareView["incidents"][number]; actions: Actions }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const resolved = Boolean(incident.resolvedAt);
  const overdue = !incident.notifiedAt && !resolved && incident.notifyBy < new Date().toISOString().slice(0, 16).replace("T", " ");
  return (
    <li className={`border-line rounded-xl border px-4 py-3 text-sm ${resolved ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{CLASS_LABELS[incident.class].split(" (")[0]}</span>
        <span className="text-muted text-xs">discovered {incident.discoveredAt} · opened by {incident.openedBy}</span>
        {resolved ? <span className="text-done ml-auto text-xs font-bold">resolved {incident.resolvedAt}</span> : null}
      </div>
      <p className="mt-1">{incident.summary}</p>
      {incident.conversationId ? <p className="text-muted mt-1 text-xs">conversation {incident.conversationId}</p> : null}
      <p className={`mt-2 text-xs ${overdue ? "text-red-deep font-bold" : "text-muted"}`}>
        {incident.notifiedAt
          ? `Clinic told ${incident.notifiedAt}: ${incident.notifiedHow ?? ""}`
          : `Tell the clinic by ${incident.notifyBy}${overdue ? " — OVERDUE" : ""}`}
        {incident.ftcNotifyBy ? ` · the clinic tells the people affected by ${incident.ftcNotifyBy} (state breach law)` : ""}
      </p>
      {incident.resolution ? <p className="text-muted mt-1 text-xs">{incident.resolution}</p> : null}
      {problem ? <p className="text-red-deep mt-1 text-xs">{problem}</p> : null}
      {!resolved ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!incident.notifiedAt ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const how = window.prompt("How was the clinic told? (who, by what channel — no patient details)");
                if (!how) return;
                start(async () => setProblem(describe(await actions.markNotified(incident.id, how))));
              }}
              className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
            >
              Record clinic notified
            </button>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const resolution = window.prompt("What was done? (in ids and counts)");
              if (!resolution) return;
              start(async () => setProblem(describe(await actions.resolve(incident.id, resolution))));
            }}
            className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
          >
            Resolve
          </button>
        </div>
      ) : null}
    </li>
  );
}

function OpenIncidentForm({ onOpen }: { onOpen: Actions["openIncident"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const f = new FormData(form);
        const conversationId = String(f.get("conversationId") ?? "").trim();
        const discovered = String(f.get("discoveredAt") ?? "").trim();
        start(async () => {
          setProblem(null);
          const result = await onOpen({
            class: String(f.get("class")) as IncidentClass,
            summary: String(f.get("summary") ?? "").trim(),
            ...(conversationId ? { conversationId } : {}),
            ...(discovered ? { discoveredAt: new Date(discovered).toISOString() } : {}),
          });
          const message = describe(result);
          setProblem(message ?? (result.ok && result.data.status === "opened" ? `Opened. Tell the clinic by ${result.data.notifyBy}.` : null));
          if (!message) form.reset();
        });
      }}
      className="mt-5 grid gap-3"
    >
      <p className="text-xs font-bold uppercase">Open an incident</p>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Class</span>
        <select name="class" className="border-line mt-1 w-full rounded-lg border px-3 py-2">
          {INCIDENT_CLASSES.map((c) => (
            <option key={c} value={c}>{CLASS_LABELS[c]}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Summary — ids and counts, no patient</span>
        <textarea name="summary" required maxLength={2000} rows={3} className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Conversation id (optional)</span>
          <input name="conversationId" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Discovered (optional; default now)</span>
          <input name="discoveredAt" type="datetime-local" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
      </div>
      <div>
        <button type="submit" disabled={pending} className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white">
          Open incident and start the clock
        </button>
      </div>
      {problem ? <p className={`text-xs ${problem.startsWith("Opened.") ? "text-done" : "text-red-deep"}`}>{problem}</p> : null}
    </form>
  );
}

function Offboarding({ view, actions }: { view: CareView; actions: Actions }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const c = view.clinic;
  const plan = c.destruction;
  const vendor = c.voiceVendorDeletion;
  const recordVendorDeletion = () => {
    const how = window.prompt("How were the clinic's calls and agent deleted at Retell? (one line, no patient details)");
    if (!how) return;
    start(async () => setProblem(describe(await actions.markVoiceVendorDataDeleted(how))));
  };
  const vendorStep = vendor ? (
    vendor.recordedAt ? (
      <li>
        Calls and agent deleted at Retell: recorded {vendor.recordedAt} by {vendor.recordedBy}
        {vendor.how ? ` (${vendor.how})` : ""}.
      </li>
    ) : (
      <li className="text-red-deep">
        Outstanding: delete the clinic&rsquo;s calls and agent in Retell&rsquo;s console by {vendor.deadline}, when its data is
        destroyed here, then record it.
      </li>
    )
  ) : null;
  const vendorButton =
    vendor && !vendor.recordedAt ? (
      <button
        type="button"
        disabled={pending}
        onClick={recordVendorDeletion}
        className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
      >
        Record Retell deletion
      </button>
    ) : null;

  if (c.destroyedOn) {
    return (
      <div className="text-sm">
        <p>Patient data destroyed on {c.destroyedOn}. The clinic row, the audit log, the signed agreement and the billing history remain.</p>
        {vendorStep ? <ol className="mt-2 grid gap-2">{vendorStep}</ol> : null}
        {problem ? <p className="text-red-deep mt-2 text-xs">{problem}</p> : null}
        {vendorButton ? <div className="mt-4 flex flex-wrap gap-2">{vendorButton}</div> : null}
      </div>
    );
  }
  return (
    <div className="text-sm">
      {c.offboardingStartedOn && plan ? (
        <ol className="grid gap-2">
          <li>
            Service ended {c.offboardingStartedOn}: Stripe&rsquo;s end of the subscription, which starts this automatically, or the
            day an operator started it.
          </li>
          <li>
            {plan.rule === "thirty_days"
              ? `Rule: thirty days (${ruleSource(plan)}). The data is destroyed at ${plan.destroyDueAt}, a day before the thirty days are up, whether or not the export was delivered.`
              : `Rule: the export, then ninety days (${ruleSource(plan)}). Destroyed at ${plan.exportDueAt}, a day before the thirty days are up, if the export is recorded by then; otherwise at the first hourly run after it is recorded; and at ${plan.latestDestroyAt}, a day before the ninety days are up, if it never is.`}
          </li>
          <li>
            Switch the agent off at the voice vendor and send the clinic the forwarding-removal codes (onboarding page, &ldquo;To undo&rdquo;).
          </li>
          <li>
            Produce the return bundle on the app host:
            <code className="ml-1 rounded bg-black/5 px-1.5 py-0.5 text-xs">npm run patient-export -w @healdesk/app -- --clinic {c.id} --all --requested-by &quot;offboarding&quot;</code>
            {" "}and hand it over by the channel in docs/incident-response.md. Then record the handover here: producing it records nothing.
          </li>
          <li>
            {c.exportDeliveredOn
              ? `Export delivered ${c.exportDeliveredOn}. Destruction is due at ${plan.destroyDueAt}.`
              : plan.rule === "thirty_days"
                ? `Not yet delivered. Deliver it and record the handover before ${plan.destroyDueAt}: every leaving practice is owed its export whether or not it asks (Terms §7), and the data goes then either way. Ops is alerted at day 21.`
                : `Not yet delivered: owed by ${plan.exportDueAt}, so the data goes within the thirty days. Destruction waits for it until ${plan.latestDestroyAt}.`}
          </li>
          {vendorStep}
        </ol>
      ) : (
        <p className="text-muted">
          Not offboarding. When a subscription ends this starts by itself; start it by hand for a clinic leaving outside Stripe.
        </p>
      )}
      {problem ? <p className="text-red-deep mt-2 text-xs">{problem}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {!c.offboardingStartedOn ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const reason = window.prompt("Why is the clinic leaving? (one line, no patient details)");
              if (!reason) return;
              if (!window.confirm("Start this clinic's destruction clock now? Its agreement decides when the data goes.")) return;
              start(async () => setProblem(describe(await actions.startOffboarding(reason))));
            }}
            className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
          >
            Start offboarding
          </button>
        ) : null}
        {c.offboardingStartedOn && !c.exportDeliveredOn ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const how = window.prompt("How was the export handed over? (channel and to whom by role)");
              if (!how) return;
              start(async () => setProblem(describe(await actions.markExportDelivered(how))));
            }}
            className="rounded-full bg-black px-4 py-2 text-xs font-bold text-white"
          >
            Record export delivered
          </button>
        ) : null}
        {vendorButton}
      </div>
    </div>
  );
}

/** Where the rule came from, in the console's words. */
function ruleSource(plan: NonNullable<CareView["clinic"]["destruction"]>): string {
  switch (plan.basis) {
    case "agreement":
      return `agreement ${plan.agreementVersion ?? ""}`.trim();
    case "no_agreement":
      return "no agreement on file, so the strictest rule";
    case "unknown_version":
      return `agreement ${plan.agreementVersion ?? ""} has no rule mapped, so the strictest`.trim();
  }
}
