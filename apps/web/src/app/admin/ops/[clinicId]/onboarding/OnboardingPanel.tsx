"use client";

import { useState, useTransition } from "react";

import type {
  AgentService,
  BookingModeOutcome,
  DepositPolicy,
  DirectBookingGate,
  ForwardingTestOutcome,
  GoLiveOutcome,
  IssueLinkOutcome,
  MetaPlatform,
  OnboardingView,
  OpsResult,
  PhiBasis,
  RetryCalendarWriteOutcome,
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
    publishedPhoneE164?: string | null;
  }) => Promise<OpsResult<SimpleOutcome>>;
  saveAgent: (input: {
    greeting: string;
    services: AgentService[];
    escalationPhone: string | null;
    escalationHours: string | null;
    notes: string | null;
    depositPolicy: DepositPolicy | null;
  }) => Promise<OpsResult<SimpleOutcome>>;
  approveAgent: (approvedBy: string) => Promise<OpsResult<SimpleOutcome>>;
  goLive: () => Promise<OpsResult<GoLiveOutcome>>;
  startForwardingTest: () => Promise<OpsResult<ForwardingTestOutcome>>;
  attachMeta: (input: { platform: MetaPlatform; externalId: string; accessToken: string; label?: string }) => Promise<OpsResult<SimpleOutcome>>;
  setMeta: (enabled: boolean) => Promise<OpsResult<SimpleOutcome>>;
  // Booking hand-off and direct booking (design of 23 September 2026).
  saveRequirements: (fields: string[]) => Promise<OpsResult<SimpleOutcome>>;
  resendSetupLink: (to: string | null) => Promise<OpsResult<IssueLinkOutcome>>;
  setBookingMode: (mode: "desk_confirms" | "direct") => Promise<OpsResult<BookingModeOutcome>>;
  confirmTimezone: (timezone: string) => Promise<OpsResult<SimpleOutcome>>;
  setPhiBasis: (input: { connectionId: string; basis: PhiBasis | null; note?: string }) => Promise<OpsResult<SimpleOutcome>>;
  retryCalendarWrite: (appointmentId: string) => Promise<OpsResult<RetryCalendarWriteOutcome>>;
};

/** The six gates behind the direct-booking switch (§E.1), in the console's words. */
const GATE_LABELS: Record<DirectBookingGate, string> = {
  env: "HEALDESK_DIRECT_BOOKING_ENABLED is \"true\" in this environment",
  addendum: "The direct-booking addendum is approved by counsel",
  election: "The practice accepted the addendum on its setup link (unwithdrawn)",
  calendar: "Writable calendar with a PHI basis recorded on the connection (none can exist until the Google Calendar adapter is built)",
  production: "The clinic is live (production)",
  agent: "The agent script is approved",
};

const CARRIERS = [
  ["verizon", "Verizon"],
  ["att", "AT&T"],
  ["tmobile", "T-Mobile"],
  ["spectrum", "Spectrum"],
  ["comcast", "Comcast Xfinity"],
  ["other", "Other / not sure"],
] as const;

function describe(result: OpsResult<SimpleOutcome> | OpsResult<GoLiveOutcome> | OpsResult<ForwardingTestOutcome>): string | null {
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
        <ForwardingTest view={v} onStart={actions.startForwardingTest} />
      </Section>

      <Section title={`Agent script${v.agent ? ` — version ${v.agent.version}${v.agent.approvedAt ? ", approved" : ", not approved"}` : ""}`}>
        <AgentForm view={v} onSave={actions.saveAgent} onApprove={actions.approveAgent} />
      </Section>

      <Section title="Deposits — Stripe Connect">
        {v.stripeConnect.accountId ? (
          <p className="text-sm">
            Connected to the clinic&rsquo;s own Stripe ({v.stripeConnect.accountId}){v.stripeConnect.connectedAt ? ` on ${v.stripeConnect.connectedAt.slice(0, 10)}` : ""}.
            Deposits can be collected there once a text channel exists to send the link on.
          </p>
        ) : v.stripeConnect.authorizeUrl ? (
          <p className="text-sm">
            Send the clinic this link, or open it with them on the call; they sign in to their own Stripe and approve healdesk:{" "}
            <a href={v.stripeConnect.authorizeUrl} className="underline break-all" target="_blank" rel="noreferrer">connect the clinic&rsquo;s Stripe</a>.
            The link is valid for an hour.
          </p>
        ) : (
          <p className="text-muted text-sm">Stripe Connect is not enabled on the platform yet. Until it is, deposits are collected by the front desk.</p>
        )}
      </Section>

      <Section title={`Meta front door — ${v.meta.enabled ? "on" : "off"}`}>
        <MetaFrontDoor view={v} onAttach={actions.attachMeta} onSwitch={actions.setMeta} />
      </Section>

      <Section title="Booking request fields">
        <RequirementsCard view={v} onSave={actions.saveRequirements} onResend={actions.resendSetupLink} />
      </Section>

      <Section title={`Booking mode — ${v.bookingMode === "direct" ? "the assistant books directly" : "the desk confirms"}`}>
        <BookingModeCard view={v} onSwitch={actions.setBookingMode} />
      </Section>

      <Section title="Time zone">
        <TimezoneCard view={v} onConfirmTimezone={actions.confirmTimezone} />
      </Section>

      <Section title="Calendar">
        <CalendarCard view={v} onBasis={actions.setPhiBasis} onRetry={actions.retryCalendarWrite} />
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
            publishedPhoneE164: String(f.get("publishedPhoneE164") ?? "").trim() || null,
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
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">The clinic&rsquo;s own published number (E.164)</span>
        <input name="publishedPhoneE164" defaultValue={view.clinic.publishedPhoneE164 ?? ""} placeholder="+14155550199" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        <span className="text-muted block text-xs">The forwarding test checks that a forwarded call does not arrive carrying this number.</span>
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
  const [deposit, setDeposit] = useState<DepositPolicy | null>(agent?.depositPolicy ?? null);

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
              depositPolicy: deposit,
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
        <div className="border-line rounded-xl border p-3 text-sm">
          <label className="flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={Boolean(deposit?.required)}
              onChange={(e) =>
                setDeposit(e.target.checked ? { required: true, amountUsd: deposit?.amountUsd ?? null, collection: deposit?.collection ?? "front_desk" } : null)
              }
            />
            The clinic takes a booking deposit
          </label>
          {deposit?.required ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label>
                <span className="text-muted block text-xs font-bold uppercase">Amount (whole dollars; blank = &ldquo;a deposit&rdquo;)</span>
                <input
                  value={deposit.amountUsd ?? ""}
                  inputMode="numeric"
                  onChange={(e) => setDeposit({ ...deposit, amountUsd: e.target.value ? Number(e.target.value) : null })}
                  className="border-line mt-1 w-full rounded-lg border px-3 py-2"
                />
              </label>
              <label>
                <span className="text-muted block text-xs font-bold uppercase">Collected by</span>
                <select
                  value={deposit.collection}
                  onChange={(e) => setDeposit({ ...deposit, collection: e.target.value as DepositPolicy["collection"] })}
                  className="border-line mt-1 w-full rounded-lg border px-3 py-2"
                >
                  <option value="front_desk">The front desk calls to collect it</option>
                  <option value="stripe_connect" disabled={!view.stripeConnect.accountId}>
                    Stripe Connect{view.stripeConnect.accountId ? "" : " (connect the clinic&rsquo;s Stripe first)"}
                  </option>
                </select>
              </label>
              <p className="text-muted sm:col-span-2 text-xs">
                The agent says a deposit is due and that the desk will call to collect it; the booking is flagged for the desk
                and the booked alert says so. A payment link needs a text channel, which waits on 10DLC.
              </p>
            </div>
          ) : null}
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

function ForwardingTest({ view, onStart }: { view: OnboardingView; onStart: Actions["startForwardingTest"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const ft = view.forwardingTest;
  const passed = view.steps.find((s) => s.id === "test_call_passed")?.completedAt;
  return (
    <div className="border-line mt-5 rounded-xl border p-4 text-sm">
      <p className="font-semibold">Prove the forwarding</p>
      <p className="text-muted mt-1 text-xs">
        Start a five-minute window, then ring the clinic&rsquo;s published number from any other phone and let it ring out (or
        have the desk pick up and hang up, to test the busy condition). The first call to arrive is the test: it must show the
        caller&rsquo;s number, not the clinic&rsquo;s.
      </p>
      {ft.windowUntil ? <p className="mt-2">Window open until {ft.windowUntil.slice(11, 16)} UTC. Ring the clinic now.</p> : null}
      {ft.observed ? (
        <p className={`mt-2 ${ft.observed.callerIdPreserved ? "text-done" : "text-red-deep"}`}>
          {ft.observed.callerIdPreserved
            ? `A call arrived at ${ft.observed.arrivedAt.slice(11, 16)} UTC with the caller ID intact (forward condition: ${ft.observed.condition.replace("_", " ")}).`
            : `A call arrived at ${ft.observed.arrivedAt.slice(11, 16)} UTC but the caller ID was lost — it carried the clinic's own number. Ask the carrier to preserve caller ID on forwarded calls, then test again.`}
        </p>
      ) : null}
      {passed ? <p className="text-done mt-1 text-xs">Step stamped {passed.slice(0, 16).replace("T", " ")}.</p> : null}
      {message ? <p className="mt-2 text-xs">{message}</p> : null}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await onStart();
            setMessage(describe(result) ?? "Window open. Ring the clinic within five minutes.");
          })
        }
        className="border-line-strong mt-3 rounded-full border px-3 py-1 text-xs font-bold"
      >
        {ft.windowUntil ? "Restart the window" : "Start a test window"}
      </button>
    </div>
  );
}

function MetaFrontDoor({ view, onAttach, onSwitch }: { view: OnboardingView; onAttach: Actions["attachMeta"]; onSwitch: Actions["setMeta"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const m = view.meta;
  return (
    <div className="text-sm">
      <p className="text-muted">
        Messenger, Instagram DMs and WhatsApp are a front door, not a hallway: the assistant answers public questions (hours,
        address, services, price ranges) and hands off to the phone. It never acknowledges a condition, names a time or a
        provider, or discusses payment, and a guard replaces any reply that tries. Replies go out only inside Meta&rsquo;s
        24-hour window; once it closes nothing is sent, on any platform, and there is no template path. Meta signs no BAA — the
        clinic accepts that residual risk explicitly before this is switched on, and a dermatology or fertility practice may
        reasonably decline.
      </p>
      <ul className="mt-3 grid gap-2">
        {m.channels.map((c) => (
          <li key={`${c.platform}-${c.externalId}`} className="border-line rounded-xl border px-3 py-2">
            <span className="font-semibold">{c.platform}</span> · id {c.externalId}{c.label ? ` · ${c.label}` : ""} · {c.status}
          </li>
        ))}
        {m.channels.length === 0 ? <li className="text-muted">No channel attached yet.</li> : null}
      </ul>
      <p className="text-muted mt-3">
        Booking requests handed to the desk, last 30 days (phone and Meta): <strong>{m.bookingRequests.waiting}</strong>{" "}
        waiting · {m.bookingRequests.confirmed} confirmed · {m.bookingRequests.accepted} accepted (the desk calls) ·{" "}
        {m.bookingRequests.declined} declined. Until the Google Calendar adapter exists every booking is a request: the agent
        takes a name, a number and a preferred window, emails the desk a single-use link, and the desk confirms a slot, calls
        them or declines there. healdesk itself contacts no one about a request. The requests themselves are not shown here.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const f = new FormData(form);
          start(async () => {
            setProblem(null);
            const result = await onAttach({
              platform: String(f.get("platform")) as MetaPlatform,
              externalId: String(f.get("externalId") ?? "").trim(),
              accessToken: String(f.get("accessToken") ?? "").trim(),
              label: String(f.get("label") ?? "").trim() || undefined,
            });
            const message = describe(result);
            setProblem(message ?? "Attached. The token is sealed; it is not shown again.");
            if (!message) form.reset();
          });
        }}
        className="mt-4 grid gap-3 sm:grid-cols-2"
      >
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Platform</span>
          <select name="platform" className="border-line mt-1 w-full rounded-lg border px-3 py-2">
            <option value="messenger">Messenger (Facebook page)</option>
            <option value="instagram">Instagram DMs</option>
            <option value="whatsapp">WhatsApp (Cloud API)</option>
          </select>
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Page id / IG account id / WhatsApp phone number id</span>
          <input name="externalId" required inputMode="numeric" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <label className="sm:col-span-2">
          <span className="text-muted block text-xs font-bold uppercase">Access token (sealed at rest; never shown again)</span>
          <input name="accessToken" type="password" required autoComplete="off" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Label (optional)</span>
          <input name="label" maxLength={120} placeholder="Main page" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={pending} className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold">Attach channel</button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (!m.enabled && !window.confirm("Has the clinic accepted, in writing, that Meta channels carry a named residual risk and are answered by a narrow assistant that hands off?")) return;
            start(async () => setProblem(describe(await onSwitch(!m.enabled)) ?? (m.enabled ? "Switched off." : "Switched on.")));
          }}
          className={`rounded-full px-4 py-2 text-xs font-bold ${m.enabled ? "border-line-strong border" : "bg-black text-white"}`}
        >
          {m.enabled ? "Switch the front door off" : "Switch the front door on"}
        </button>
        <span className="text-muted text-xs">Webhook: <code>/api/webhooks/meta</code> on the product host, subscribed in the Meta app to messages for each product.</span>
      </div>
      {problem ? <p className="mt-2 text-xs">{problem}</p> : null}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* Booking hand-off, direct booking, time zone and calendar                    */
/* -------------------------------------------------------------------------- */

function whenLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function RequirementsCard({ view, onSave, onResend }: { view: OnboardingView; onSave: Actions["saveRequirements"]; onResend: Actions["resendSetupLink"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const r = view.requirements;
  const chosen = new Set(r.fields);
  const status =
    r.source === "practice"
      ? `Confirmed by the practice on ${whenLabel(r.confirmedAt)}.`
      : r.source === "operator"
        ? `Confirmed by the operator on ${whenLabel(r.confirmedAt)}.`
        : r.source === "defaults"
          ? `Defaults in effect since ${whenLabel(r.confirmedAt)}: nobody opened the setup link before it expired.`
          : r.setupLinkOutstanding
            ? "Not yet confirmed. A setup link is outstanding; the specialty defaults apply when it expires."
            : "Not yet confirmed, and no setup link is outstanding. Resend one, or confirm the set on the call below.";
  return (
    <div className="text-sm">
      <p className="text-muted">
        What the assistant asks for when someone wants to book, and nothing more. The first four are locked: they are what a
        booking request is. Saving here records the set as confirmed by you on the call (source: operator).
      </p>
      <p className="mt-2 font-semibold">{status}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          const fields = f.getAll("fields").map(String);
          start(async () => {
            setProblem(null);
            setProblem(describe(await onSave(fields)) ?? "Saved. The step is stamped.");
          });
        }}
        className="mt-3"
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {r.catalogue.map((field) => (
            <li key={field.id}>
              <label className="flex items-start gap-2">
                <input type="checkbox" name="fields" value={field.id} defaultChecked={field.locked || chosen.has(field.id)} disabled={field.locked || pending} className="mt-1" />
                <span>
                  {field.label}
                  {field.locked ? <span className="text-muted ml-1 text-xs">(always)</span> : null}
                  {field.phoneOnly ? <span className="text-muted ml-1 text-xs">(phone only)</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className="bg-ink rounded-full px-4 py-2 text-sm font-bold text-white">Confirm on the call</button>
          {problem ? <span className="text-sm">{problem}</span> : null}
        </div>
      </form>
      <p className="text-muted mt-3 text-xs">Never asked, and cannot be added: {r.neverAsked.join(" · ")}.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const to = String(new FormData(event.currentTarget).get("to") ?? "").trim() || null;
          start(async () => {
            setLink(null);
            const result = await onResend(to);
            if (!result.ok) return setProblem(result.message);
            if (result.data.status === "refused") return setProblem(result.data.message);
            setLink(result.data.url);
            setProblem(
              result.data.delivery.attempted
                ? result.data.delivery.status === "sent"
                  ? `Sent. Expires ${result.data.expiresAt}.`
                  : `Not sent (${result.data.delivery.status}): ${"reason" in result.data.delivery ? result.data.delivery.reason : ""}. Send the link yourself.`
                : `Issued, not mailed. Expires ${result.data.expiresAt}.`,
            );
          });
        }}
        className="border-line mt-4 flex flex-wrap items-end gap-3 border-t pt-4"
      >
        <label className="min-w-[220px] flex-1">
          <span className="text-muted block text-xs font-bold uppercase">Resend the setup link to (optional)</span>
          <input name="to" type="email" placeholder="frontdesk@practice.example" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
        </label>
        <button type="submit" disabled={pending} className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold">Resend setup link</button>
        {link ? <code className="w-full break-all rounded bg-black/5 px-2 py-1 text-xs">{link}</code> : null}
      </form>
    </div>
  );
}

function BookingModeCard({ view, onSwitch }: { view: OnboardingView; onSwitch: Actions["setBookingMode"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const d = view.directBooking;
  const direct = view.bookingMode === "direct";
  return (
    <div className="text-sm">
      <p className="text-muted">
        Desk confirms: every request goes to the front desk's single-use link. Direct: on phone calls only, the assistant books
        a caller straight into the connected calendar at a time it read as free. The database is the authority either way: a
        switch here with an un-edited prompt never books, and an edited prompt with the switch off is refused by the tool.
        In v1 this becomes the clinic's own &ldquo;Auto-confirm bookings&rdquo; switch, writing to Google Calendar, once that
        adapter is built (launch plan steps 1.5 and 1.7); until then no clinic can pass the calendar gate below.
      </p>
      <p className="mt-2">
        Election: {view.directBookingElectedAt ? `accepted ${whenLabel(view.directBookingElectedAt)}` : "none"}
        {view.directBookingWithdrawnAt ? `, withdrawn ${whenLabel(view.directBookingWithdrawnAt)}` : ""}. Addendum {d.addendumVersion}
        {d.addendumApproved ? ", approved by counsel." : " is not yet approved by counsel; the setup link does not offer it."}
      </p>
      <ul className="mt-3 grid gap-1">
        {d.gates.map((g) => (
          <li key={g.id} className={g.ok ? "text-done" : "text-muted"}>
            <span aria-hidden>{g.ok ? "✓" : "○"}</span> {GATE_LABELS[g.id]}
          </li>
        ))}
      </ul>
      {d.missing.length && !direct ? (
        <ul className="text-muted mt-2 list-disc pl-5 text-xs">
          {d.missing.filter((m) => !/booking mode is desk_confirms/.test(m)).map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const next = direct ? "desk_confirms" : "direct";
            if (next === "desk_confirms" && !window.confirm("Switch back to desk confirms? This records the election as withdrawn; a new setup link is needed to elect again.")) return;
            start(async () => {
              setMessage(null);
              setMissing([]);
              const result = await onSwitch(next);
              if (!result.ok) return setMessage(result.message);
              if (result.data.status === "refused") {
                setMessage(result.data.message);
                setMissing(result.data.missing);
                return;
              }
              setMessage(result.data.mode === "direct" ? "Direct booking is on." : "Back to desk confirms; the election is recorded as withdrawn.");
            });
          }}
          className={`rounded-full px-4 py-2 text-xs font-bold ${direct ? "border-line-strong border" : "bg-black text-white"}`}
        >
          {direct ? "Switch back to desk confirms" : "Switch to direct booking"}
        </button>
        {message ? <span className="text-xs">{message}</span> : null}
      </div>
      {missing.length ? (
        <ul className="text-red-deep mt-2 list-disc pl-5 text-xs">
          {missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TimezoneCard({ view, onConfirmTimezone }: { view: OnboardingView; onConfirmTimezone: Actions["confirmTimezone"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="text-sm">
      <p className="text-muted">
        The clinic&rsquo;s own time zone, confirmed with the clinic rather than left at the provisioning default. Opening hours,
        after-hours calls and the times the desk sees are all read in it. healdesk places no calls, so nothing is dialled in it.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const tz = String(new FormData(event.currentTarget).get("timezone") ?? "").trim();
          start(async () => setMessage(describe(await onConfirmTimezone(tz)) ?? `Time zone confirmed: ${tz}.`));
        }}
        className="mt-3 flex flex-wrap items-end gap-3"
      >
        <label className="min-w-[220px]">
          <span className="text-muted block text-xs font-bold uppercase">Time zone (IANA)</span>
          <input name="timezone" defaultValue={view.timezone} placeholder="America/New_York" className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
          <span className="text-muted block text-xs">
            {view.timezoneConfirmedAt ? `Confirmed ${whenLabel(view.timezoneConfirmedAt)}.` : "Not yet confirmed with the clinic — the provisioning default."}
          </span>
        </label>
        <button type="submit" disabled={pending} className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold">Confirm time zone</button>
      </form>
      {message ? <p className="mt-2 text-xs">{message}</p> : null}
    </div>
  );
}

function CalendarCard({ view, onBasis, onRetry }: { view: OnboardingView; onBasis: Actions["setPhiBasis"]; onRetry: Actions["retryCalendarWrite"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const c = view.calendarConnection;
  const attention = view.calendarWrites.filter((w) => w.status === "failed" || w.status === "unknown");
  return (
    <div className="text-sm">
      <p className="text-muted">
        v1 writes bookings to the clinic&rsquo;s Google Calendar and nothing else: no Cal.com, Mindbody or Boulevard. That
        adapter is not built yet (launch plan steps 1.5 and 1.7), so no connection here is writable today and a confirmed
        request is recorded in healdesk only. A connection is written to only once the lawful basis for holding a first name,
        a service and a time is recorded on it: the vendor&rsquo;s own BAA with us, or the practice&rsquo;s own account
        under the practice&rsquo;s agreement. None means read-only.
      </p>
      {c ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            const raw = String(f.get("basis") ?? "");
            const basis = raw === "vendor_baa" || raw === "practice_account" ? raw : null;
            const note = String(f.get("note") ?? "").trim() || undefined;
            start(async () => setMessage(describe(await onBasis({ connectionId: c.connectionId, basis, note })) ?? "Recorded."));
          }}
          className="mt-3 grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end"
        >
          <label>
            <span className="text-muted block text-xs font-bold uppercase">{c.platform} — basis</span>
            <select name="basis" defaultValue={c.phiBasis ?? ""} className="border-line mt-1 w-full rounded-lg border px-3 py-2">
              <option value="">None (read-only)</option>
              <option value="vendor_baa">Vendor BAA with healdesk</option>
              <option value="practice_account">Practice's own account</option>
            </select>
          </label>
          <label>
            <span className="text-muted block text-xs font-bold uppercase">Note (who signed what, when; no patient details)</span>
            <input name="note" maxLength={500} className="border-line mt-1 w-full rounded-lg border px-3 py-2" />
          </label>
          <button type="submit" disabled={pending} className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold">Record basis</button>
          <p className="text-muted text-xs sm:col-span-3">{c.writable ? "Writable." : "Not writable until a basis is recorded."}</p>
        </form>
      ) : (
        <p className="text-muted mt-2">No writable calendar connection on this clinic.</p>
      )}
      <p className="mt-4 font-semibold">Calendar writes needing attention: {attention.length}</p>
      <ul className="mt-2 grid gap-2">
        {view.calendarWrites.map((w) => (
          <li key={w.appointmentId} className="border-line flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2 text-xs">
            <span className={w.status === "written" ? "text-done" : w.status === "failed" ? "text-red-deep" : "text-muted"}>{w.status}</span>
            <span>{w.slotAt.slice(0, 16).replace("T", " ")} UTC</span>
            <span className="text-muted">{w.requestChannel}</span>
            {w.error ? <span className="text-muted">{w.error}</span> : null}
            {w.status === "failed" || w.status === "unknown" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await onRetry(w.appointmentId);
                    if (!result.ok) return setMessage(result.message);
                    setMessage(result.data.status === "retried" ? `Retry: ${result.data.outcome}.` : result.data.message);
                  })
                }
                className="border-line-strong ml-auto rounded-full border px-3 py-1 font-bold"
              >
                Retry
              </button>
            ) : null}
          </li>
        ))}
        {view.calendarWrites.length === 0 ? <li className="text-muted text-xs">No calendar write attempted yet.</li> : null}
      </ul>
      {message ? <p className="mt-2 text-xs">{message}</p> : null}
    </div>
  );
}
