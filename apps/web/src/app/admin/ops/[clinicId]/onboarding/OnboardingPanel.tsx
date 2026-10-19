"use client";

import { COVERAGE_MODE_OPTIONS } from "@healdesk/catalog";
import { useState, useTransition } from "react";

import type {
  AgentService,
  AutoConfirmOutcome,
  BookingView,
  CalendarConnectionStatus,
  CalendarLinkOutcome,
  CalendarTermsKind,
  CareOutcome,
  ChannelId,
  ChannelLiveInput,
  DepositPolicy,
  DisconnectCalendarOutcome,
  ForwardingTestOutcome,
  GoLiveOutcome,
  MetaPlatform,
  OnboardingView,
  OpsResult,
  RetryCalendarWriteOutcome,
  SimpleOutcome,
} from "@/lib/admin/ops-client";

type Actions = {
  completeStep: (step: string, note?: string) => Promise<OpsResult<SimpleOutcome>>;
  reopenStep: (step: string, note?: string) => Promise<OpsResult<SimpleOutcome>>;
  savePhone: (settings: {
    phoneSystemType?: "landline" | "voip" | "unknown";
    carrier?: string | null;
    assistantNumberE164?: string | null;
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
  goLive: () => Promise<OpsResult<GoLiveOutcome>>;
  startForwardingTest: () => Promise<OpsResult<ForwardingTestOutcome>>;
  attachMeta: (input: { platform: MetaPlatform; externalId: string; accessToken: string; label?: string }) => Promise<OpsResult<SimpleOutcome>>;
  setMeta: (enabled: boolean) => Promise<OpsResult<SimpleOutcome>>;
  setMetaPlatform: (platform: MetaPlatform, enabled: boolean) => Promise<OpsResult<SimpleOutcome>>;
  // Booking hand-off (design of 23 September 2026).
  saveRequirements: (fields: string[]) => Promise<OpsResult<SimpleOutcome>>;
  confirmTimezone: (timezone: string) => Promise<OpsResult<SimpleOutcome>>;
  retryCalendarWrite: (appointmentId: string) => Promise<OpsResult<RetryCalendarWriteOutcome>>;
  // The booking mode and the Google Calendar (plan §10).
  setAutoConfirm: (on: boolean) => Promise<OpsResult<AutoConfirmOutcome>>;
  sendCalendarLink: () => Promise<OpsResult<CalendarLinkOutcome>>;
  disconnectCalendar: () => Promise<OpsResult<DisconnectCalendarOutcome>>;
  // Channel events: website chat's line confirmed on the clinic's site. No
  // action passes a channel's audit or approves the script: the practice
  // questions do, and a run they flag is decided in /admin/reviews. The
  // console can only ask them again.
  rerunPractice: () => Promise<OpsResult<CareOutcome>>;
  confirmWidget: () => Promise<OpsResult<CareOutcome>>;
};

const UNAUDITED = "Done, but the audit entry could not be written. Tell whoever keeps the security log.";

/** getOnboarding's `booking` in a shape this console cannot read: said on its two cards, never guessed. */
const UNREADABLE_BOOKING =
  "apps/app sent a booking state this console could not read, so no booking mode or calendar is shown rather than a guess. The error log names the field.";

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
        {" · "}<a href={`/admin/ops/${v.clinic.id}/billing`} className="underline">billing</a>
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
          <div className="border-line mt-5 rounded-sm border p-4 text-sm">
            <p className="font-semibold">What the clinic dials</p>
            <ol className="mt-2 grid gap-2">
              {v.forwarding.steps.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.dial ? <code className="ml-2 rounded-sm bg-black/5 px-1.5 py-0.5">{s.dial}</code> : null}
                </li>
              ))}
            </ol>
            <p className="mt-3 font-semibold">To undo</p>
            <ul className="mt-1 grid gap-1">
              {v.forwarding.undo.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.dial ? <code className="ml-2 rounded-sm bg-black/5 px-1.5 py-0.5">{s.dial}</code> : null}
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
          <p className="text-muted mt-3 text-sm">Enter the assistant&rsquo;s number to see the forwarding codes.</p>
        )}
        <ForwardingTest view={v} onStart={actions.startForwardingTest} />
      </Section>

      <Section title={`Agent script${v.agent ? ` — version ${v.agent.version}${v.agent.approvedAt ? ", approved" : ", not approved"}` : ""}`}>
        <AgentForm view={v} onSave={actions.saveAgent} />
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
        <MetaFrontDoor view={v} onAttach={actions.attachMeta} onSwitch={actions.setMeta} onPlatform={actions.setMetaPlatform} />
      </Section>

      <Section title="Booking request fields">
        <RequirementsCard view={v} onSave={actions.saveRequirements} />
      </Section>

      <Section
        title={`Booking mode — ${
          v.booking === null
            ? "unknown"
            : v.booking === "unreadable"
              ? "could not be read"
              : v.booking.mode === "live"
                ? "settings allow live booking"
                : "requests for staff to confirm"
        }`}
      >
        <BookingCard booking={v.booking} onAutoConfirm={actions.setAutoConfirm} />
      </Section>

      <Section title="Time zone">
        <TimezoneCard view={v} onConfirmTimezone={actions.confirmTimezone} />
      </Section>

      <Section title="Calendar">
        <CalendarCard view={v} onSendLink={actions.sendCalendarLink} onDisconnect={actions.disconnectCalendar} onRetry={actions.retryCalendarWrite} />
      </Section>

      <Section title="Go live">
        <GoLiveControl view={v} onGoLive={actions.goLive} />
      </Section>

      <Section title="Channels">
        <ChannelsCard view={v} onRerun={actions.rerunPractice} onConfirmWidget={actions.confirmWidget} />
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-line mt-8 rounded-md border bg-white p-5">
      <h2 className="text-[13.2px] font-bold tracking-[0.06em] uppercase">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function StepRow({ step, actions }: { step: OnboardingView["steps"][number]; actions: Actions }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <li className="border-line flex flex-wrap items-start gap-3 rounded-sm border px-4 py-3">
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

/**
 * The clinic's coverage mode, read-only (plan Part K: the onboarding page has
 * no two-mode routing). The two-mode select this replaced could not say
 * "after hours only", and an operator who changed it rewrote the clinic's
 * own choice.
 */
function coverageWords(mode: OnboardingView["clinic"]["coverageMode"]): string {
  const option = COVERAGE_MODE_OPTIONS.find((o) => o.id === mode);
  return option ? `${option.label}: ${option.line}` : "Not reported by apps/app.";
}

function PhoneForm({ view, onSave }: { view: OnboardingView; onSave: Actions["savePhone"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        const number = String(f.get("assistantNumberE164") ?? "").trim();
        start(async () => {
          setProblem(null);
          const result = await onSave({
            phoneSystemType: String(f.get("phoneSystemType")) as "landline" | "voip" | "unknown",
            carrier: String(f.get("carrier") || "") || null,
            assistantNumberE164: number || null,
            publishedPhoneE164: String(f.get("publishedPhoneE164") ?? "").trim() || null,
          });
          setProblem(describe(result) ?? "Saved.");
        });
      }}
      className="grid gap-3 sm:grid-cols-2"
    >
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Line type</span>
        <select name="phoneSystemType" defaultValue={view.clinic.phoneSystemType} className="border-line mt-1 w-full rounded-sm border px-3 py-2">
          <option value="landline">Landline / toll-free</option>
          <option value="voip">Cloud phone system (VoIP)</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Carrier</span>
        <select name="carrier" defaultValue={view.clinic.carrier ?? ""} className="border-line mt-1 w-full rounded-sm border px-3 py-2">
          <option value="">—</option>
          {CARRIERS.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </label>
      <div className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Which calls reach AYA</span>
        <p className="mt-1 py-2">{coverageWords(view.clinic.coverageMode)}</p>
        <span className="text-muted block text-xs">
          The clinic chooses this in its setup or Settings, from the three modes. It is not set here.
        </span>
      </div>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">Assistant number (E.164)</span>
        <input name="assistantNumberE164" defaultValue={view.clinic.assistantNumberE164 ?? ""} placeholder="+14155550100" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
      </label>
      <label className="text-sm">
        <span className="text-muted block text-xs font-bold uppercase">The clinic&rsquo;s own published number (E.164)</span>
        <input name="publishedPhoneE164" defaultValue={view.clinic.publishedPhoneE164 ?? ""} placeholder="+14155550199" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
        <span className="text-muted block text-xs">The forwarding test checks that a forwarded call does not arrive carrying this number.</span>
      </label>
      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" disabled={pending} className="bg-ink rounded-full px-4 py-2 text-sm font-bold text-white">Save phone settings</button>
        {problem ? <span className="text-sm">{problem}</span> : null}
      </div>
    </form>
  );
}

/**
 * What the clinic set on a service beyond the four fields above, read-only
 * here: the console carries it back untouched, and a price edited out of its
 * kind (a top added to a per-unit price) is re-read by apps/app.
 */
function serviceDetail(s: AgentService): string | null {
  const parts: string[] = [];
  if (s.priceKind === "per_unit" && s.unit) parts.push(`priced per ${s.unit}`);
  else if (s.priceKind === "from") parts.push("a starting price");
  if (typeof s.depositUsd === "number" && s.depositUsd > 0) {
    parts.push(`deposit $${Number.isInteger(s.depositUsd) ? s.depositUsd : s.depositUsd.toFixed(2)}`);
  } else if (s.depositUsd === 0) {
    // The clinic's "no deposit" (BD27's 0), which a default set below does not override.
    parts.push("no deposit, so the default below does not apply");
  }
  return parts.length ? `Set by the clinic: ${parts.join(" · ")}` : null;
}

function AgentForm({ view, onSave }: { view: OnboardingView; onSave: Actions["saveAgent"] }) {
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
            setProblem(describe(result) ?? "Saved as a new version. Approval is cleared until the practice questions pass it again.");
          });
        }}
        className="mt-3 grid gap-3"
      >
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Greeting</span>
          <textarea name="greeting" defaultValue={agent?.greeting ?? ""} rows={3} className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
        </label>
        <div>
          <span className="text-muted block text-xs font-bold uppercase">Services and price ranges (dollars and cents; blank = offer a consult instead of a price)</span>
          <div className="mt-1 grid gap-2">
            {services.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_90px_80px_auto] items-center gap-2 text-sm">
                <input value={s.name} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Service" className="border-line rounded-sm border px-2 py-1.5" />
                <input value={s.priceFromUsd ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, priceFromUsd: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="from $" inputMode="decimal" className="border-line rounded-sm border px-2 py-1.5" />
                <input value={s.priceToUsd ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, priceToUsd: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="to $" inputMode="decimal" className="border-line rounded-sm border px-2 py-1.5" />
                <input value={s.durationMinutes ?? ""} onChange={(e) => setServices(services.map((x, j) => (j === i ? { ...x, durationMinutes: e.target.value ? Number(e.target.value) : null } : x)))} placeholder="min" inputMode="numeric" className="border-line rounded-sm border px-2 py-1.5" />
                <button type="button" onClick={() => setServices(services.filter((_, j) => j !== i))} className="text-muted text-xs underline">remove</button>
                {serviceDetail(s) ? <span className="text-muted col-span-full text-xs">{serviceDetail(s)}</span> : null}
              </div>
            ))}
            <button type="button" onClick={() => setServices([...services, { name: "", priceFromUsd: null, priceToUsd: null, durationMinutes: null }])} className="text-xs underline justify-self-start">+ add a service</button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">Escalation number (E.164)</span>
            <input name="escalationPhone" defaultValue={agent?.escalationPhone ?? ""} placeholder="+14155550100" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">When a human answers that line</span>
            <input name="escalationHours" defaultValue={agent?.escalationHours ?? ""} placeholder="Weekdays 9–5" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
          </label>
        </div>
        <div className="border-line rounded-sm border p-3 text-sm">
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
                  className="border-line mt-1 w-full rounded-sm border px-3 py-2"
                />
              </label>
              <label>
                <span className="text-muted block text-xs font-bold uppercase">Collected by</span>
                <select
                  value={deposit.collection}
                  onChange={(e) => setDeposit({ ...deposit, collection: e.target.value as DepositPolicy["collection"] })}
                  className="border-line mt-1 w-full rounded-sm border px-3 py-2"
                >
                  <option value="front_desk">The front desk calls to collect it</option>
                  <option value="stripe_connect" disabled={!view.stripeConnect.accountId}>
                    Stripe Connect{view.stripeConnect.accountId ? "" : " (connect the clinic&rsquo;s Stripe first)"}
                  </option>
                </select>
              </label>
              <p className="text-muted sm:col-span-2 text-xs">
                The agent says a deposit is due and that the desk will call to collect it; the booking is flagged for the desk
                and the booked alert says so. AYA never texts anyone: a payment link goes only inside a chat, through the
                clinic&rsquo;s own gateway, and a call always leaves the deposit to the desk.
              </p>
            </div>
          ) : null}
        </div>
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">Anything else the agent may say (parking, new-patient policy)</span>
          <textarea name="notes" defaultValue={agent?.notes ?? ""} rows={2} className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className="bg-ink rounded-full px-4 py-2 text-sm font-bold text-white">Save script</button>
          {problem ? <span className="text-sm">{problem}</span> : null}
        </div>
      </form>

      <Approval agent={agent} />
    </div>
  );
}

/**
 * Who approved this version, said and never offered. A version is approved
 * only by a pass of the practice questions that read it, by themselves or by
 * a decision on a run they flagged in /admin/reviews: "Record approval",
 * which approved it by hand, was retired with its operation on 19 October 2026.
 */
function Approval({ agent }: { agent: OnboardingView["agent"] }) {
  if (!agent) return null;
  return (
    <p className="border-line text-muted mt-5 border-t pt-4 text-sm">
      {agent.approvedAt
        ? `Approved by ${agent.approvedByLabel ?? "—"}.`
        : "Not approved yet. The practice questions approve this version when they pass it; a run they flag waits for you in Reviews (/admin/reviews)."}
    </p>
  );
}

function GoLiveControl({ view, onGoLive }: { view: OnboardingView; onGoLive: Actions["goLive"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const notBuilt = view.goLive.notBuilt;
  const named =
    notBuilt.length > 0 ? (
      <div className="mt-3">
        <p className="text-muted text-sm">
          Gate B asks these of the code and they aren&rsquo;t built yet, so no clinic goes live
          until they are:
        </p>
        <ul className="text-muted list-disc pl-5 text-sm">
          {notBuilt.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    ) : null;
  if (view.clinic.dataClassification === "production") {
    return (
      <div>
        <p className="text-sm">Live. Patient data is accepted under the bound agreement.</p>
        {named}
      </div>
    );
  }
  return (
    <div>
      <p className="text-sm">
        Go-live is automatic: the clinic goes to production by itself, and its first ready channel live,
        once nothing below is left. Nobody presses a button for it.
      </p>
      {view.goLive.ok ? (
        <p className="mt-2 text-sm">Nothing is left: it goes live at its next check, within the hour.</p>
      ) : (
        <ul className="mt-2 list-disc pl-5 text-sm">
          {view.goLive.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      {named}
      <button
        type="button"
        disabled={pending || !view.goLive.ok}
        onClick={() =>
          start(async () => {
            const result = await onGoLive();
            if (!result.ok) return setMessage(result.message);
            setMessage(
              result.data.status === "live"
                ? `Live. Agreement signed ${result.data.baaSignedOn}.`
                : `${result.data.message} ${result.data.missing.join(" ")}`,
            );
          })
        }
        className="bg-ink mt-3 rounded-full px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
      >
        Check go-live now
      </button>
      {message ? <p className="mt-2 text-sm">{message}</p> : null}
    </div>
  );
}

const CHANNEL_NAMES: Record<ChannelId, string> = {
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "Phone",
};

/** What a channel still needs, in the console's words; the code beside it is apps/app's. */
function needWords(channel: ChannelId, input: ChannelLiveInput): string {
  switch (input) {
    case "leaving":
      return "The clinic has left: nothing goes live.";
    case "audit":
      return "Its practice questions haven't passed. They run by themselves after each change the clinic makes; a run they flag waits for you in Reviews (/admin/reviews), and your decision there is the only way an operator passes one.";
    case "runtime":
      return channel === "voice"
        ? "No assistant number: enter it under Phone line once the Retell agent and number exist."
        : "The Meta front door is off.";
    case "setup":
      return "The clinic hasn't finished setup.";
    case "hours":
      return "The clinic's opening hours aren't confirmed: phone can't go live without them.";
    case "direct_line":
      return "No direct line on file: every call AYA can't answer goes there.";
    case "vet_referral":
      return "No emergency referral clinic on file: AYA can't answer anyone for a vet practice without one.";
    case "prices_checked":
      return "The clinic hasn't checked the prices we filled in: AYA isn't built until it does.";
    case "covered_status":
      return "Whether the practice is a HIPAA covered entity is still open: we ask again before AYA answers anyone.";
    case "clinic_step":
      return channel === "voice"
        ? "No forwarding-test call observed with the caller's number intact: run the forwarding test above. A stamped step is not enough."
        : channel === "web"
          ? "Nobody has confirmed the chat is on the clinic's website. Open the site, check the chat bubble is there (until you confirm, it tells visitors to call the practice), then confirm below."
          : "No Instagram, Messenger or WhatsApp account is connected.";
    case "platform":
      return "Its attestations aren't all in place: see what is missing on /admin/compliance.";
    case "go_live":
      return "The clinic isn't live yet: go-live is automatic, and above says what it waits on.";
  }
}

function ChannelsCard({
  view,
  onRerun,
  onConfirmWidget,
}: {
  view: OnboardingView;
  onRerun: Actions["rerunPractice"];
  onConfirmWidget: Actions["confirmWidget"];
}) {
  if (view.channels === null) {
    return <p className="text-muted text-sm">apps/app sent no channel states: it predates channel events.</p>;
  }
  if (view.channels.length === 0) return <p className="text-muted text-sm">No channels bought.</p>;
  const waitingOnAudit = view.channels.some((c) => !c.liveAt && c.missing.includes("audit"));
  return (
    <div>
      <ul className="grid gap-3">
        {view.channels.map((c) => (
          <ChannelRow key={c.channel} channel={c} onConfirmWidget={onConfirmWidget} />
        ))}
      </ul>
      {waitingOnAudit ? <RerunPractice onRerun={onRerun} /> : null}
    </div>
  );
}

/**
 * Ask the practice questions again, beside the channels whose audit waits on
 * them: after a fix on our side, or when a run could not finish. It asks;
 * it never passes anything. The run waits its two minutes and runs one at a
 * time, as any other, and a run it flags goes to Reviews.
 */
function RerunPractice({ onRerun }: { onRerun: Actions["rerunPractice"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="border-line mt-4 flex flex-wrap items-center gap-3 border-t pt-4 text-sm">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await onRerun();
            if (!result.ok) return setMessage(result.message);
            setMessage(
              result.data.status === "updated"
                ? "Asked: the practice questions run again for every channel in about two minutes. If they flag something, it waits in Reviews."
                : result.data.message,
            );
          })
        }
        className="border-line rounded-full border px-4 py-2 text-sm font-bold disabled:opacity-40"
      >
        Ask the practice questions again
      </button>
      <span className="text-muted text-xs">For every channel at once. It asks them; it passes nothing.</span>
      {message ? <p className="w-full">{message}</p> : null}
    </div>
  );
}

function ChannelRow({
  channel: c,
  onConfirmWidget,
}: {
  channel: NonNullable<OnboardingView["channels"]>[number];
  onConfirmWidget: Actions["confirmWidget"];
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const state = c.liveAt
    ? `live since ${c.liveAt.slice(0, 10)}${c.firstAnswerAt ? `, first answer ${c.firstAnswerAt.slice(0, 10)}` : ", no patient answered yet"}`
    : c.readyAt
      ? `ready since ${c.readyAt.slice(0, 10)}${c.waitingOn ? `, waiting on ${c.waitingOn.replace(/_/g, " ")}` : ", waiting on us"}`
      : "not ready on our side";
  const run = (action: () => Promise<OpsResult<CareOutcome>>) =>
    start(async () => {
      const result = await action();
      if (!result.ok) return setMessage(result.message);
      setMessage(
        result.data.status === "updated"
          ? "Recorded. The channel moves on as far as its other inputs allow."
          : result.data.message,
      );
    });
  return (
    <li className="border-line rounded-sm border p-4 text-sm">
      <p>
        <span className="font-semibold">{CHANNEL_NAMES[c.channel]}</span> · {state}
        {c.auditPassed ? " · audit passed" : ""}
      </p>
      {c.missing.length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {c.missing.map((m) => (
            <li key={m}>
              {needWords(c.channel, m)} <code className="text-muted text-xs">{m}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {c.channel === "web" && !c.liveAt && c.missing.includes("clinic_step") ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(onConfirmWidget)}
            className="border-line rounded-full border px-4 py-2 text-sm font-bold disabled:opacity-40"
          >
            The line is on their website
          </button>
        ) : null}
      </div>
      {message ? <p className="mt-2">{message}</p> : null}
    </li>
  );
}

function ForwardingTest({ view, onStart }: { view: OnboardingView; onStart: Actions["startForwardingTest"] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const ft = view.forwardingTest;
  const passed = view.steps.find((s) => s.id === "test_call_passed")?.completedAt;
  return (
    <div className="border-line mt-5 rounded-sm border p-4 text-sm">
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

const PLATFORM_NAMES: Record<MetaPlatform, string> = { instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp" };

function MetaFrontDoor({
  view,
  onAttach,
  onSwitch,
  onPlatform,
}: {
  view: OnboardingView;
  onAttach: Actions["attachMeta"];
  onSwitch: Actions["setMeta"];
  onPlatform: Actions["setMetaPlatform"];
}) {
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
          <li key={`${c.platform}-${c.externalId}`} className="border-line rounded-sm border px-3 py-2">
            <span className="font-semibold">{c.platform}</span> · id {c.externalId}{c.label ? ` · ${c.label}` : ""} · {c.status}
          </li>
        ))}
        {m.channels.length === 0 ? <li className="text-muted">No channel attached yet.</li> : null}
      </ul>
      <p className="text-muted mt-3">
        Booking requests handed to the desk, last 30 days (phone and Meta): <strong>{m.bookingRequests.waiting}</strong>{" "}
        waiting · {m.bookingRequests.confirmed} confirmed · {m.bookingRequests.accepted} accepted (the desk calls) ·{" "}
        {m.bookingRequests.declined} declined. Meta conversations always take requests. Calls take requests too: a call can
        book only at healdesk&rsquo;s demo clinic, and only while the booking mode below allows live booking. For a request
        the agent takes a name, a number and a preferred window, emails the desk a single-use link, and the desk confirms a
        slot, calls them or declines there. healdesk itself contacts no one about a request. The requests themselves are not
        shown here.
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
          <select name="platform" className="border-line mt-1 w-full rounded-sm border px-3 py-2">
            <option value="messenger">Messenger (Facebook page)</option>
            <option value="instagram">Instagram DMs</option>
            <option value="whatsapp">WhatsApp (Cloud API)</option>
          </select>
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Page id / IG account id / WhatsApp phone number id</span>
          <input name="externalId" required inputMode="numeric" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
        </label>
        <label className="sm:col-span-2">
          <span className="text-muted block text-xs font-bold uppercase">Access token (sealed at rest; never shown again)</span>
          <input name="accessToken" type="password" required autoComplete="off" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Label (optional)</span>
          <input name="label" maxLength={120} placeholder="Main page" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
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
      {m.platforms ? (
        <div className="mt-4">
          <p className="text-muted">
            The clinic&rsquo;s own switches, in its Settings, beneath the front door: a message is answered only when the
            front door and its platform are both on. Switching one here is recorded as &ldquo;healdesk support&rdquo; on the
            clinic&rsquo;s side.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["instagram", "messenger", "whatsapp"] as const).map((platform) => {
              const on = m.platforms![platform];
              return (
                <button
                  key={platform}
                  type="button"
                  disabled={pending}
                  aria-pressed={on}
                  onClick={() =>
                    start(async () =>
                      setProblem(
                        describe(await onPlatform(platform, !on)) ??
                          `${PLATFORM_NAMES[platform]} switched ${on ? "off" : "on"}.`,
                      ),
                    )
                  }
                  className={`rounded-full px-4 py-2 text-xs font-bold ${on ? "bg-black text-white" : "border-line-strong border"}`}
                >
                  {PLATFORM_NAMES[platform]}: {on ? "on" : "off"}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {problem ? <p className="mt-2 text-xs">{problem}</p> : null}
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* Booking hand-off, booking mode, time zone and calendar                      */
/* -------------------------------------------------------------------------- */

function whenLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function RequirementsCard({ view, onSave }: { view: OnboardingView; onSave: Actions["saveRequirements"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const r = view.requirements;
  const chosen = new Set(r.fields);
  const status =
    r.source === "practice"
      ? `Confirmed by the practice on ${whenLabel(r.confirmedAt)}.`
      : r.source === "operator"
        ? `Confirmed by the operator on ${whenLabel(r.confirmedAt)}.`
        : r.source === "defaults"
          ? `The specialty's defaults, in effect since ${whenLabel(r.confirmedAt)}.`
          : r.setupLinkOutstanding
            ? "Not yet confirmed. A setup link from before the setup wizard is outstanding; the specialty defaults apply when it expires."
            : "Not yet confirmed. Confirm the set on the call below.";
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
    </div>
  );
}

/** The calendar terms' kinds (lib/booking/terms.ts), in the console's words. */
const TERMS_LABELS: Record<CalendarTermsKind, string> = {
  none: "None: no agreement is in effect.",
  needs_election: "None yet: the location needs a calendar election.",
  covered: "Covered: a Google Workspace account under Google's BAA. healdesk adds bookings to the calendar.",
  uncovered:
    "Practice-directed: an account without Google's BAA. healdesk adds bookings to the calendar at the practice's direction.",
  not_used: "Not used: the booking system doesn't read Google Calendar, so healdesk connects no calendar.",
};

/** Why no terms are in effect. A reason apps/app adds later shows as its code. */
const TERMS_REASONS: Record<string, string> = {
  no_agreement: "The organisation has no agreement in effect.",
  legacy_agreement:
    "The agreement in effect predates the calendar clauses, so the practice elects its terms on a calendar link.",
  location: "The agreement has the calendar clauses, but this location has no election under it.",
  draft_terms: "The newest election is on an unreleased document, which counts only on the demo clinic.",
};

const ELECTION_SOURCES = { agreement: "the signed agreement", calendar_link: "a calendar link", portal: "the portal" } as const;

/**
 * What the location's settings allow, and only that: the mode is the
 * location's, not any channel's, and no channel books for a real clinic yet.
 * channelsNow says what each one does.
 */
function modeHeadline(b: BookingView): string {
  if (b.mode === "live") return "Settings allow live booking into the location's Google Calendar.";
  return b.canOfferTimes
    ? "Settings allow real free times from the location's Google Calendar, each booking a request for staff to confirm."
    : "Settings allow requests only: a preferred time for staff to confirm, with no times offered.";
}

/**
 * What each channel does with those settings today. Calls reach the booking
 * tools only through the pre-Retell voice harness, which reads the mode for
 * healdesk's demo clinic alone; every other clinic's calls take requests
 * until the Retell runtime exists (launch plan 2.1). Meta never books. Worded
 * as what can happen, never as what has, so it holds whether or not the
 * demo clinic's booking tools are wired yet.
 */
function channelsNow(b: BookingView): string[] {
  const calls = b.demo
    ? "Calls: the voice harness reads these settings for healdesk's demo clinic alone. It can book only while they allow live booking, and takes a request otherwise."
    : "Calls: requests, with no times offered, until the Retell runtime exists. The voice harness can book only for healdesk's demo clinic.";
  return [calls, "Meta: always requests."];
}

/**
 * The booking mode as apps/app derives it, and why (plan §10). Nothing here
 * sets the mode: it follows from the location's calendar terms, its Google
 * Calendar, its hours and zone, going live, Auto-confirm and the owner's
 * kill switch, all read fresh upstream. Auto-confirm is the clinic's own
 * switch and the only control on this card. It is offered under every terms
 * kind, as the portal offers it, because the mode weighs it under every kind:
 * where the terms let healdesk write nothing yet, the card says it takes
 * effect once they do.
 */
function BookingCard({
  booking: b,
  onAutoConfirm,
}: {
  booking: BookingView | "unreadable" | null;
  onAutoConfirm: Actions["setAutoConfirm"];
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  if (b === "unreadable") return <p className="text-red-deep text-sm">{UNREADABLE_BOOKING}</p>;
  if (!b) {
    return (
      <p className="text-red-deep text-sm">
        apps/app sent no booking mode: it is older than this console. Deploy it before reading or changing anything here.
      </p>
    );
  }
  const writes = b.terms.kind === "covered" || b.terms.kind === "uncovered";
  const t = b.terms;
  return (
    <div className="text-sm">
      <p className="font-semibold">{modeHeadline(b)}</p>
      <p className="text-muted mt-3 text-xs font-bold uppercase">What each channel does now</p>
      <ul className="mt-1 grid gap-1">
        {channelsNow(b).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {b.reasons.length ? (
        <>
          <p className="text-muted mt-3 text-xs font-bold uppercase">Why it takes requests</p>
          <ul className="mt-1 grid gap-1">
            {b.reasons.map((r) => (
              <li key={r.code}>
                <span aria-hidden>○</span> {r.sentence} <code className="text-muted text-xs">{r.code}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <dl className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-[150px_1fr]">
        <dt className="text-muted text-xs font-bold uppercase">Auto-confirm</dt>
        <dd>
          {b.autoConfirm ? "On." : "Off: every booking the assistant takes is a request."}
          {b.autoConfirmChangedAt ? ` Switched ${b.autoConfirmChangedAt}.` : ""}
          {writes ? "" : " It takes effect once the calendar terms let healdesk write."}
        </dd>
        <dt className="text-muted text-xs font-bold uppercase">Kill switch</dt>
        <dd>
          {b.killSwitchOn ? "On" : "Off: the assistant books nothing itself, for any clinic"}. HEALDESK_DIRECT_BOOKING_ENABLED is the
          owner&rsquo;s, set only in the environment.
        </dd>
        <dt className="text-muted text-xs font-bold uppercase">Calendar terms</dt>
        <dd>
          {TERMS_LABELS[t.kind]}
          {t.clauseId ? (
            <span className="text-muted block text-xs">
              Clause {t.clauseId}
              {t.documentVersion ? ` of ${t.documentVersion}` : ""}
              {t.documentReleased === null ? "" : t.documentReleased ? " (released)" : " (draft)"}
              {t.source ? `, from ${ELECTION_SOURCES[t.source]}` : ""}
              {t.electedAt ? ` on ${t.electedAt}` : ""}.
            </span>
          ) : null}
          {t.reason ? <span className="text-muted block text-xs">{TERMS_REASONS[t.reason] ?? t.reason}</span> : null}
        </dd>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const on = !b.autoConfirm;
            if (on && !window.confirm("Switch Auto-confirm on, on the clinic's instruction? Once every other reason above is cleared, the location's settings allow live booking into its calendar.")) return;
            start(async () => {
              setMessage(null);
              const result = await onAutoConfirm(on);
              if (!result.ok) return setMessage(result.message);
              if (result.data.status === "refused") return setMessage(result.data.message);
              const said = result.data.changed
                ? `Auto-confirm is ${result.data.autoConfirm ? "on" : "off"}. The settings ${result.data.mode === "live" ? "allow live booking" : "leave the location on requests"}.`
                : `Auto-confirm was already ${result.data.autoConfirm ? "on" : "off"}. Nothing changed.`;
              setMessage(result.data.auditRecorded ? said : `${said} ${UNAUDITED}`);
            });
          }}
          className={`rounded-full px-4 py-2 text-xs font-bold ${b.autoConfirm ? "border-line-strong border" : "bg-black text-white"}`}
        >
          {b.autoConfirm ? "Switch Auto-confirm off" : "Switch Auto-confirm on"}
        </button>
        {message ? <span className="text-xs">{message}</span> : null}
      </div>
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
          <input name="timezone" defaultValue={view.timezone} placeholder="America/New_York" className="border-line mt-1 w-full rounded-sm border px-3 py-2" />
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

const CONNECTION_STATUS: Record<CalendarConnectionStatus, string> = {
  pending: "Pending: the practice did not finish connecting.",
  active: "Active.",
  degraded: "Degraded: healdesk can't reach it reliably, so the location takes requests until a check succeeds.",
  error: "Broken: the practice must reconnect.",
  revoked: "Revoked: access was removed, and the token erased. The practice must connect again.",
};

/**
 * The location's Google Calendar, the one calendar v1 writes to, and the
 * assistant's write ledger. What may reach the calendar is the location's
 * calendar terms, never a basis an operator records, so this card offers
 * none. The account's address and the calendar's own zone stay in apps/app.
 */
function CalendarCard({
  view,
  onSendLink,
  onDisconnect,
  onRetry,
}: {
  view: OnboardingView;
  onSendLink: Actions["sendCalendarLink"];
  onDisconnect: Actions["disconnectCalendar"];
  onRetry: Actions["retryCalendarWrite"];
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [demoLink, setDemoLink] = useState<string | null>(null);
  const unreadable = view.booking === "unreadable";
  const b = view.booking === "unreadable" ? null : view.booking;
  const g = b?.calendar ?? null;
  const attention = view.calendarWrites.filter((w) => w.status === "failed" || w.status === "unknown");
  return (
    <div className="text-sm">
      <p className="text-muted">
        v1 writes bookings to the location&rsquo;s Google Calendar and nothing else: no Cal.com, Mindbody or Boulevard. The
        practice connects it from its calendar link or the portal, with the kind of Google account its calendar terms name.
      </p>
      {g ? (
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[150px_1fr]">
          <dt className="text-muted text-xs font-bold uppercase">Status</dt>
          <dd>
            {CONNECTION_STATUS[g.status]}
            {g.brokenAt ? ` Broken since ${g.brokenAt}.` : ""}
            {g.lastError ? <span className="text-muted block text-xs">Last error: {g.lastError}</span> : null}
          </dd>
          <dt className="text-muted text-xs font-bold uppercase">Account</dt>
          <dd>
            {g.accountKind === "workspace"
              ? `Google Workspace${g.hostedDomain ? `, ${g.hostedDomain}` : ""}.`
              : g.accountKind === "personal"
                ? "A personal Google account."
                : "Not known."}
          </dd>
          <dt className="text-muted text-xs font-bold uppercase">Checked</dt>
          <dd>
            Connected {g.connectedAt ?? "—"}; last verified {g.lastVerifiedAt ?? "never"}.
          </dd>
          <dt className="text-muted text-xs font-bold uppercase">Data-use notice</dt>
          <dd>{g.disclosureCurrent ? "Accepted under the current notice." : "Accepted under an outdated notice: the practice must reconnect."}</dd>
          <dt className="text-muted text-xs font-bold uppercase">Time zone</dt>
          <dd>
            {g.timeZoneMatches === null
              ? "The calendar's zone was not recorded."
              : g.timeZoneMatches
                ? "The calendar's zone is the clinic's."
                : "The calendar's zone is not the clinic's."}
          </dd>
        </dl>
      ) : (
        <p className={unreadable ? "text-red-deep mt-2" : "mt-2"}>
          {unreadable ? UNREADABLE_BOOKING : b ? "No Google Calendar connected." : "Not known: apps/app sent no booking state."}
        </p>
      )}
      {b ? (
        <p className="text-muted mt-3">
          Assistant writes not yet settled: {b.pendingAssistantWrites}. Calendar link:{" "}
          {b.calendarLinkOutstanding ? "one is out, unused and unexpired." : "none outstanding."}
        </p>
      ) : null}
      {b ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setMessage(null);
                setDemoLink(null);
                const result = await onSendLink();
                if (!result.ok) return setMessage(result.message);
                if (result.data.status === "refused") return setMessage(result.data.message);
                const d = result.data.delivery;
                setDemoLink(result.data.url);
                const said = `Mailed to the practice's own address (${d.sent} of ${d.recipients} sent${d.failed ? `, ${d.failed} failed` : ""}). Expires ${result.data.expiresAt}.`;
                setMessage(result.data.auditRecorded ? said : `${said} ${UNAUDITED}`);
              })
            }
            className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold"
          >
            Send calendar link
          </button>
          {g && g.status !== "revoked" ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!window.confirm("Disconnect this location's Google Calendar? healdesk erases its token and revokes its access at Google unless another location uses that account, and the location takes requests until the practice connects again.")) return;
                start(async () => {
                  setMessage(null);
                  const result = await onDisconnect();
                  if (!result.ok) return setMessage(result.message);
                  if (result.data.status === "refused") return setMessage(result.data.message);
                  if (result.data.status === "not_connected") return setMessage("No Google Calendar was connected.");
                  const said = result.data.revokedAtGoogle
                    ? "Disconnected: the token is erased and access revoked at Google."
                    : "Disconnected: the token is erased, but access was not revoked at Google (another location uses that account, or Google did not answer). The audit entry says which.";
                  setMessage(result.data.auditRecorded ? said : `${said} ${UNAUDITED}`);
                });
              }}
              className="border-line-strong rounded-full border px-4 py-2 text-xs font-bold"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
      {demoLink ? <code className="mt-2 block break-all rounded-sm bg-black/5 px-2 py-1 text-xs">{demoLink}</code> : null}
      <p className="mt-4 font-semibold">Calendar writes needing attention: {attention.length}</p>
      <ul className="mt-2 grid gap-2">
        {view.calendarWrites.map((w) => (
          <li key={w.appointmentId} className="border-line flex flex-wrap items-center gap-3 rounded-sm border px-3 py-2 text-xs">
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
