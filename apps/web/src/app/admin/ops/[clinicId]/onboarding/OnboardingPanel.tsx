"use client";

import { useState, useTransition } from "react";

import type {
  AgentService,
  GoLiveOutcome,
  OnboardingView,
  OpsResult,
  SimpleOutcome,
} from "@/lib/admin/ops-client";

type Actions = {
  completeStep: (step: string, note?: string) => Promise<OpsResult<SimpleOutcome>>;
  reopenStep: (step: string, note?: string) => Promise<OpsResult<SimpleOutcome>>;
  savePhone: (settings: {
    phoneSystemType?: "landline" | "voip" | "unknown";
    callRouting?: "conditional" | "always";
    carrier?: string | null;
    synthflowNumberE164?: string | null;
  }) => Promise<OpsResult<SimpleOutcome>>;
  saveAgent: (input: {
    greeting: string;
    services: AgentService[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
  }) => Promise<OpsResult<SimpleOutcome>>;
  approveAgent: (approvedBy: string) => Promise<OpsResult<SimpleOutcome>>;
  goLive: () => Promise<OpsResult<GoLiveOutcome>>;
};

const CARRIERS = [
  ["verizon", "Verizon"],
  ["att", "AT&T"],
  ["tmobile", "T-Mobile"],
  ["spectrum", "Spectrum"],
  ["comcast", "Comcast Xfinity"],
  ["other", "Other / not sure"],
] as const;

function describe(result: OpsResult<SimpleOutcome> | OpsResult<GoLiveOutcome>): string | null {
  if (!result.ok) return result.message;
  if (result.data.status === "refused") return result.data.message;
  return null;
}

export function OnboardingPanel({ view, actions }: { view: OpsResult<OnboardingView>; actions: Actions }) {
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-[900px] px-5 py-10">
        <p className="text-red-deep font-semibold">{view.message}</p>
        <a href="/admin/ops" className="mt-4 inline-block underline">Back to ops</a>
      </main>
    );
  }
  const v = view.data;
  const done = v.steps.filter((s) => s.completedAt).length;

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10 sm:px-8">
      <a href="/admin/ops" className="text-muted text-sm underline">← Ops</a>
      <h1 className="font-display mt-3 text-[32px] font-medium tracking-[-0.02em]">{v.clinic.name}</h1>
      <p className="text-muted mt-1 text-sm">
        {v.clinic.specialty} · {v.clinic.timezone} · {v.clinic.dataClassification}
        {v.clinic.wentLiveAt ? ` · live since ${v.clinic.wentLiveAt.slice(0, 10)}` : ""}
      </p>

      <Section title={`Checklist — ${done} of ${v.steps.length}`}>
        <ol className="grid gap-2">
          {v.steps.map((step) => (
            <StepRow key={step.id} step={step} actions={actions} />
          ))}
        </ol>
      </Section>

      <Section title="Phone line">
        <PhoneForm view={v} onSave={actions.savePhone} />
        {v.forwarding ? (
          <div className="border-line mt-5 rounded-xl border p-4 text-sm">
            <p className="font-semibold">What the clinic dials</p>
            <ol className="mt-2 grid gap-2">
              {v.forwarding.steps.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.dial ? <code className="ml-2 rounded bg-black/5 px-1.5 py-0.5">{s.dial}</code> : null}
                </li>
              ))}
            </ol>
            <p className="mt-3 font-semibold">To undo</p>
            <ul className="mt-1 grid gap-1">
              {v.forwarding.undo.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.dial ? <code className="ml-2 rounded bg-black/5 px-1.5 py-0.5">{s.dial}</code> : null}
                </li>
              ))}
            </ul>
            <ul className="text-muted mt-3 list-disc pl-5 text-xs">
              {v.forwarding.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted mt-3 text-sm">Enter the Synthflow number to see the forwarding codes.</p>
        )}
      </Section>

      <Section title={`Agent script${v.agent ? ` — version ${v.agent.version}${v.agent.approvedAt ? ", approved" : ", not approved"}` : ""}`}>
        <AgentForm view={v} onSave={actions.saveAgent} onApprove={actions.approveAgent} />
      </Section>

      <Section title="Go live">
        <GoLiveControl view={v} onGoLive={actions.goLive} />
      </Section>
    </main>
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

function StepRow({ step, actions }: { step: OnboardingView["steps"][number]; actions: Actions }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <li className="border-line flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3">
      <span className={step.completedAt ? "text-done" : "text-muted"} aria-hidden>
        {step.completedAt ? "✓" : "○"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">
          {step.title}
          {!step.required ? <span className="text-muted ml-2 text-xs font-normal">(optional)</span> : null}
        </span>
        <span className="text-muted block text-xs">{step.why}</span>
        {step.completedAt ? (
          <span className="text-muted block text-xs">done {step.completedAt.slice(0, 16).replace("T", " ")}</span>
        ) : null}
        {problem ? <span className="text-red-deep block text-xs">{problem}</span> : null}
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setProblem(null);
            const result = step.completedAt
              ? await actions.reopenStep(step.id, "reopened by operator")
              : await actions.completeStep(step.id, "confirmed on the onboarding call");
            setProblem(describe(result));
          })
        }
        className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
      >
        {step.completedAt ? "Reopen" : "Mark done"}
      </button>
    </li>
  );
}

function PhoneForm({ view, onSave }: { view: OnboardingView; onSave: Actions["savePhone"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const number = String(f.get("synthflowNumberE164") ?? "").trim();
        start(async () => {
          setProblem(null);
          const result = await onSave({
            phoneSystemType: String(f.get("phoneSystemType")) as "landline" | "voip" | "unknown",
            callRouting: String(f.get("callRouting")) as "conditional" | "always",
            carrier: String(f.get("carrier") || "") || null,
            synthflowNumberE164: number || null,
          });
          setProblem(describe(result) ?? "Saved.");
        });
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Line type</span>
        <select name="phoneSystemType" defaultValue={view.clinic.phoneSystemType} className="border-line mt-1 w-full rounded-lg border px-3 py-2">
          <option value="landline">Landline / toll-free</option>
          <option value="voip">Cloud phone system (VoIP)</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Carrier</span>
        <select name="carrier" defaultValue={view.clinic.carrier ?? ""} className="border-line mt-1 w-full rounded-lg border px-3 py-2">
          <option value="">—</option>
          {CARRIERS.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Call routing</span>
        <select name="callRouting" defaultValue={view.clinic.callRouting} className="border-line mt-1 w-full rounded-lg border px-3 py-2">
          <option value="conditional">Practice answers first; AYA takes what they miss</option>
          <option value="always">AYA answers everything</option>
        </select>
        {!view.clinic.callRoutingConfirmedAt ? (
          <span className="text-muted block text-xs">Not yet confirmed with the clinic — saving confirms it.</span>
        ) : null}
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Synthflow number (E.164)</span>
        <input name="synthflowNumberE164" defaultValue={view.clinic.synthflowNumberE164 ?? ""} placeholder="+14155550100" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
      </label>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={pending} className="bg-ink rounded-full px-4 py-2 text-sm font-bold text-white">Save phone settings</button>
        {problem ? <span className="text-sm">{problem}</span> : null}
      </div>
    </form>
  );
}

function AgentForm({ view, onSave, onApprove }: { view: OnboardingView; onSave: Actions["saveAgent"]; onApprove: Actions["approveAgent"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const agent = view.agent;
  const [services, setServices] = useState<AgentService[]>(agent?.services ?? []);

  return (
    <div>
      <p className="text-muted text-sm">
        Spoken after the fixed AI disclosure, which cannot be edited here. No safety, dosing, candidacy or
        recovery language — the guard refuses it and names the phrase.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          start(async () => {
            setProblem(null);
            const result = await onSave({
              greeting: String(f.get("greeting") ?? ""),
              services,
              escalationPhone: String(f.get("escalationPhone") ?? "").trim() || null,
              escalationHours: String(f.get("escalationHours") ?? "").trim() || null,
              notes: String(f.get("notes") ?? "").trim() || null,
            });
            setProblem(describe(result) ?? "Saved as a new version. Approval is cleared until the clinic approves it again.");
          });
        }}
        className="mt-3 grid gap-3"
      >
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Greeting</span>
          <textarea name="greeting" defaultValue={agent?.greeting ?? ""} rows={3} className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <div>
          <span className="text-muted block text-xs font-bold uppercase">Services and price ranges (whole dollars; blank = offer a consult instead of a price)</span>
          <div className="mt-1 grid gap-2">
            {services.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_90px_80px_auto] items-center gap-2 text-sm">
                <input value={s.name} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Service" className="border-line rounded-lg border px-2 py-1.5" />
                <input value={s.priceFromUsd ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, priceFromUsd: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="from $" inputMode="numeric" className="border-line rounded-lg border px-2 py-1.5" />
                <input value={s.priceToUsd ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, priceToUsd: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="to $" inputMode="numeric" className="border-line rounded-lg border px-2 py-1.5" />
                <input value={s.durationMinutes ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, durationMinutes: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="min" inputMode="numeric" className="border-line rounded-lg border px-2 py-1.5" />
                <button type="button" onClick={() => setServices(services.filter((_, j) => j !== i))} className="text-muted text-xs underline">remove</button>
              </div>
            ))}
            <button type="button" onClick={() => setServices([...services, { name: "", priceFromUsd: null, priceToUsd: null, durationMinutes: null }])} className="text-xs underline justify-self-start">+ add a service</button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">Escalation number (E.164)</span>
            <input name="escalationPhone" defaultValue={agent?.escalationPhone ?? ""} placeholder="+14155550100" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">When a human answers that line</span>
            <input name="escalationHours" defaultValue={agent?.escalationHours ?? ""} placeholder="Weekdays 9–5" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
        </div>
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Anything else the agent may say (parking, new-patient policy)</span>
          <textarea name="notes" defaultValue={agent?.notes ?? ""} rows={2} className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className="bg-ink rounded-full px-4 py-2 text-sm font-bold text-white">Save script</button>
          {problem ? <span className="text-sm">{problem}</span> : null}
        </div>
      </form>

      <ApproveForm agent={agent} onApprove={onApprove} />
    </div>
  );
}

function ApproveForm({ agent, onApprove }: { agent: OnboardingView["agent"]; onApprove: Actions["approveAgent"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  if (!agent) return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const who = String(new FormData(event.currentTarget).get("approvedBy") ?? "").trim();
        start(async () => {
          setProblem(null);
          setProblem(describe(await onApprove(who)) ?? "Approved.");
        });
      }}
      className="border-line mt-5 flex flex-wrap items-end gap-3 border-t pt-4"
    >
      <label className="min-w-[220px] flex-1 text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Who at the clinic approved this version, and how</span>
        <input name="approvedBy" placeholder="Dr Chen, read back on the call 14 Sep" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
      </label>
      <button type="submit" disabled={pending || Boolean(agent.approvedAt)} className="border-line-strong rounded-full border px-4 py-2 text-sm font-bold">
        {agent.approvedAt ? `Approved by ${agent.approvedByLabel ?? "—"}` : "Record approval"}
      </button>
      {problem ? <span className="text-sm">{problem}</span> : null}
    </form>
  );
}

function GoLiveControl({ view, onGoLive }: { view: OnboardingView; onGoLive: Actions["goLive"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  if (view.clinic.dataClassification === "production") {
    return <p className="text-sm">Live. Patient data is accepted under the bound agreement.</p>;
  }
  return (
    <div>
      {view.goLive.ok ? (
        <p className="text-sm">Everything is confirmed. Going live flips the clinic to production and stamps the agreement date.</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {view.goLive.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={pending || !view.goLive.ok}
        onClick={() =>
          start(async () => {
            const result = await onGoLive();
            if (!result.ok) return setMessage(result.message);
            setMessage(
              result.data.status === "live"
                ? `Live. BAA signed ${result.data.baaSignedOn}.`
                : `${result.data.message} ${result.data.missing.join(" ")}`,
            );
          })
        }
        className="bg-ink mt-3 rounded-full px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
      >
        Go live
      </button>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
    </div>
  );
}
