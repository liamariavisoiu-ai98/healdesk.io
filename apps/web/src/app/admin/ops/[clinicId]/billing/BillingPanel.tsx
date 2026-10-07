"use client";

import { useState, useTransition } from "react";

import type {
  AutoRenewOutcome,
  BillingChannel,
  BillingRequestKind,
  BillingSwitchOutcome,
  ClinicBillingView,
  DepositSettingsInput,
  DepositUncollectable,
  DisconnectOutcome,
  ExtendDeadlineOutcome,
  LiftSuspensionOutcome,
  LocationSetupOutcome,
  OpsResult,
  OverageRetryOutcome,
  RefundKind,
  RefundOutcome,
  RefundPreviewOutcome,
  ReplayEventOutcome,
  RetryRequestOutcome,
  SetupClosureOutcome,
  StripeConnectLinkOutcome,
} from "@/lib/admin/ops-client";

type Actions = {
  setOverageMode: (mode: "allow" | "hard_cap") => Promise<OpsResult<BillingSwitchOutcome>>;
  setUsageAlerts: (on: boolean) => Promise<OpsResult<BillingSwitchOutcome>>;
  setClinicSettings: (input: {
    directLineE164?: string | null;
    aiPaused?: boolean;
    aiPausedUntil?: string | null;
  }) => Promise<OpsResult<BillingSwitchOutcome>>;
  setDepositSettings: (input: DepositSettingsInput) => Promise<OpsResult<BillingSwitchOutcome>>;
  issueConnectLink: () => Promise<OpsResult<StripeConnectLinkOutcome>>;
  disconnectConnect: () => Promise<OpsResult<DisconnectOutcome>>;
  setAutoRenew: (on: boolean) => Promise<OpsResult<AutoRenewOutcome>>;
  previewRefund: (kind: RefundKind) => Promise<OpsResult<RefundPreviewOutcome>>;
  commitRefund: (input: {
    kind: RefundKind;
    confirmAmountCents: number;
    reason: string;
  }) => Promise<OpsResult<RefundOutcome>>;
  liftSuspension: (reason: string) => Promise<OpsResult<LiftSuspensionOutcome>>;
  extendSetupDeadline: (input: {
    days: number;
    fromDeadline: string;
  }) => Promise<OpsResult<ExtendDeadlineOutcome>>;
  closeUnfinishedSetup: () => Promise<OpsResult<SetupClosureOutcome>>;
  retryBillingRequest: (requestId: string) => Promise<OpsResult<RetryRequestOutcome>>;
  retryLocationSetup: () => Promise<OpsResult<LocationSetupOutcome>>;
  retryOverageInvoice: (windowStart: string) => Promise<OpsResult<OverageRetryOutcome>>;
  replayBillingEvent: (eventId: string) => Promise<OpsResult<ReplayEventOutcome>>;
  replayConnectEvent: (eventId: string) => Promise<OpsResult<ReplayEventOutcome>>;
};

type View = ClinicBillingView;
type Entitlements = NonNullable<View["entitlements"]>;

const CHANNEL_LABELS: Record<BillingChannel, string> = {
  web: "Website chat",
  meta: "Meta (Instagram, Messenger, WhatsApp)",
  voice: "Phone",
};

const REQUEST_LABELS: Record<BillingRequestKind, string> = {
  plan_start: "Plan start",
  step_up: "Step-up",
  close_setup: "Setup closure",
  cancel_now: "Cancel now",
};

const UNCOLLECTABLE_LABELS: Record<DepositUncollectable, string> = {
  book_and_flag: "Book it and flag the deposit for staff",
  hold_and_alert: "Hold the slot and alert staff",
  decline_and_alert: "Don't book; alert staff",
};

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function money(cents: number): string {
  return MONEY.format(cents / 100);
}

/**
 * Dollars as an operator types them ("897", "897.00", "$1,234.50"), in cents,
 * or null when it is not an amount. The refund is committed only when this
 * equals the previewed amount: typing it is the confirmation.
 */
function typedCents(value: string): number | null {
  const compact = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(compact)) return null;
  return Math.round(Number(compact) * 100);
}

type Note = { tone: "ok" | "warn" | "bad"; text: string } | null;

const UNAUDITED =
  "Done, but the audit entry could not be written. Tell whoever keeps the security log.";

/**
 * One control's call: a pending flag and the sentence to show after it. A
 * failed call says the ops client's own sentence, a refusal says upstream's,
 * and an act whose audit row was not written says so, as the jobs list does:
 * an unrecorded act that looks recorded is what an audit trail exists to stop.
 */
function useCall() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  function call<T extends { status: string }>(
    send: () => Promise<OpsResult<T>>,
    done?: (data: T) => string | null,
  ) {
    start(async () => {
      setNote(null);
      const result = await send();
      if (!result.ok) {
        setNote({ tone: "bad", text: result.message });
        return;
      }
      const data = result.data;
      if (data.status === "refused" && "message" in data) {
        setNote({ tone: "bad", text: String(data.message) });
        return;
      }
      const text = done?.(data) ?? null;
      if ("auditRecorded" in data && data.auditRecorded === false) {
        setNote({ tone: "warn", text: text ? `${text} ${UNAUDITED}` : UNAUDITED });
        return;
      }
      setNote(text ? { tone: "ok", text } : null);
    });
  }
  return { pending, note, call };
}

function Said({ note }: { note: Note }) {
  if (!note) return null;
  const tone = note.tone === "ok" ? "text-done" : "text-red-deep";
  return (
    <p
      role="status"
      className={`mt-2 text-xs ${tone} ${note.tone === "bad" ? "font-semibold" : ""}`}
    >
      {note.text}
    </p>
  );
}

const BUTTON =
  "border-line-strong rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-50";
const PRIMARY = "rounded-full bg-black px-4 py-2 text-xs font-bold text-white disabled:opacity-50";
const INPUT = "border-line mt-1 rounded-lg border px-3 py-2";

export function BillingPanel({ view, actions }: { view: OpsResult<View>; actions: Actions }) {
  if (!view.ok) {
    return (
      <main className="mx-auto max-w-[900px] px-5 py-10">
        <p className="text-red-deep font-semibold">{view.message}</p>
        {view.code === "unauthenticated" ? (
          <a href="/admin/sign-in" className="mt-4 inline-block underline">
            Sign in
          </a>
        ) : (
          <a href="/admin/ops" className="mt-4 inline-block underline">
            Back to ops
          </a>
        )}
      </main>
    );
  }
  const v = view.data;
  const e = v.entitlements;
  const billingName = v.group.find((g) => g.isBillingClinic)?.name ?? "its billing clinic";

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10 sm:px-8">
      <a href="/admin/ops" className="text-muted text-sm underline">
        ← Ops
      </a>
      <h1 className="font-display mt-3 text-[32px] font-medium tracking-[-0.02em]">
        {v.clinic.name}
      </h1>
      <p className="text-muted mt-1 text-sm">
        {v.clinic.dataClassification}
        {v.clinic.isLocation ? ` · a location, billed on ${billingName}` : ""}
        {" · "}
        <a href={`/admin/ops/${v.clinic.id}/onboarding`} className="underline">
          onboarding
        </a>
        {" · "}
        <a href={`/admin/ops/${v.clinic.id}/care`} className="underline">
          care
        </a>
        {v.clinic.isLocation ? (
          <>
            {" · "}
            <a href={`/admin/ops/${v.clinic.billingClinicId}/billing`} className="underline">
              billing clinic
            </a>
          </>
        ) : null}
      </p>

      <Attention view={v} />

      {e ? (
        <>
          <Section title={`Plan — ${e.status.replace("_", " ")}`}>
            <PlanFacts e={e} />
            <AutoRenew e={e} onSet={actions.setAutoRenew} />
            {e.status === "suspended" ? <LiftSuspension onLift={actions.liftSuspension} /> : null}
            {!e.isPlanStarted &&
            e.setupDeadlineIso &&
            e.status !== "canceled" &&
            e.status !== "purged" ? (
              <ExtendDeadline
                deadline={e.setupDeadlineAt ?? ""}
                deadlineIso={e.setupDeadlineIso}
                onExtend={actions.extendSetupDeadline}
              />
            ) : null}
          </Section>

          <Section title="Usage and the allowance">
            <Usage view={v} />
            <UsageSwitches e={e} actions={actions} />
          </Section>
        </>
      ) : (
        <Section title="Plan">
          <p className="text-muted text-sm">
            No billing account: a synthetic or demo clinic, or one provisioned without Stripe.
          </p>
        </Section>
      )}

      <Section
        title={`Channels — in service: ${v.channelsInService.map((c) => CHANNEL_LABELS[c]).join(", ") || "none yet"}`}
      >
        <Channels view={v} />
      </Section>

      <Section
        title={`Pause AI and the direct line${v.clinic.isLocation ? " (this location)" : ""}`}
      >
        <PauseAndLine view={v} onSave={actions.setClinicSettings} />
      </Section>

      <Section
        title={`Deposits and Stripe Connect${v.clinic.isLocation ? " (this location)" : ""}`}
      >
        <Connect
          view={v}
          onIssue={actions.issueConnectLink}
          onDisconnect={actions.disconnectConnect}
        />
        <Deposits view={v} onSave={actions.setDepositSettings} />
      </Section>

      {e ? (
        <Section title="Refund under Terms § 5">
          <Refund
            e={e}
            view={v}
            onPreview={actions.previewRefund}
            onCommit={actions.commitRefund}
          />
        </Section>
      ) : null}

      <Section title={`Billing requests — ${v.requests.length}`}>
        <Requests view={v} onRetry={actions.retryBillingRequest} />
      </Section>

      {e && !e.isPlanStarted && e.status !== "canceled" && e.status !== "purged" ? (
        <Section title="Close an unfinished setup">
          <CloseSetup onClose={actions.closeUnfinishedSetup} />
        </Section>
      ) : null}

      {v.flags.pendingLocation ? (
        <Section title="A location waiting to be set up">
          <PendingLocation view={v} onRetry={actions.retryLocationSetup} />
        </Section>
      ) : null}

      <Section title={`Annual overage invoices — ${v.overageInvoices.length}`}>
        <Overage view={v} onRetry={actions.retryOverageInvoice} />
      </Section>

      <Section title={`Parked Stripe events — ${v.attentionEvents.length}`}>
        <ParkedEvents
          view={v}
          onReplayBilling={actions.replayBillingEvent}
          onReplayConnect={actions.replayConnectEvent}
        />
      </Section>

      <Section title={`Billing emails — last ${v.notices.length}`}>
        <Notices view={v} />
      </Section>

      <Section title={`Status history — last ${v.transitions.length}`}>
        <Transitions view={v} />
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/** What needs a person, before anything else on the page. */
function Attention({ view }: { view: View }) {
  const items: string[] = [];
  const f = view.flags;
  if (f.refundDue) {
    items.push(
      `A first-period refund is due: the clinic turned auto-renew off inside the window (until ${f.refundEligibleUntil}). The email told them the team would be in touch.`,
    );
  }
  if (f.stuckRequests > 0) {
    items.push(
      `${f.stuckRequests} billing request(s) pending for more than a day. See Billing requests.`,
    );
  }
  if (f.pendingLocation) {
    items.push(
      f.pendingLocation.chargedOn
        ? `Location ${f.pendingLocation.locationNumber} was charged on ${f.pendingLocation.chargedOn} but its clinic does not exist yet.`
        : `Location ${f.pendingLocation.locationNumber} is pending and not charged on record.`,
    );
  }
  if (f.pendingPlanChange) {
    items.push(
      `A change to ${f.pendingPlanChange.plan.name} (${f.pendingPlanChange.interval === "year" ? "annual" : "monthly"}) lost Stripe's answer and is not finished. The hourly reconcile finishes it from Stripe, or drops it if nothing was charged; the clinic can also ask for the same plan again.`,
    );
  }
  const parked = view.attentionEvents.filter((event) => event.outcome === "dead_letter").length;
  if (parked > 0) items.push(`${parked} Stripe event(s) dead-lettered. See Parked Stripe events.`);
  if (view.entitlements?.isMutationInFlight) {
    items.push(
      "A change to the subscription is in flight: billing actions answer busy until it ends.",
    );
  }
  if (items.length === 0) return null;
  return (
    <div role="status" className="border-red/30 bg-red/[0.06] mt-6 rounded-2xl border p-5 text-sm">
      <p className="font-bold">Needs attention</p>
      <ul className="mt-2 list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function PlanFacts({ e }: { e: Entitlements }) {
  const billed = e.isLegacy
    ? `${e.billedPlan.name} (legacy row: billed in full from the first invoice)`
    : e.isPlanStarted
      ? e.billedPlan.name
      : "Nothing yet: the $0 placeholder until the first answer";
  return (
    <dl className="grid gap-1 text-sm">
      <Row label="Bought">{e.boughtPlan?.name ?? "—"}</Row>
      <Row label="Billed (channels in service)">{billed}</Row>
      <Row label="Interval">{e.interval === "year" ? "Annual" : "Monthly"}</Row>
      <Row label="Locations">{e.locations}</Row>
      <Row label="Plan started (first plan invoice paid)">{e.planStartedAt ?? "—"}</Row>
      <Row label="Start applied in Stripe">{e.planStartAppliedAt ?? "—"}</Row>
      <Row label="Paid through">{e.paidThroughOn ?? "—"}</Row>
      {e.graceEndsAt ? <Row label="Grace ends">{e.graceEndsAt}</Row> : null}
      {e.closesOn ? <Row label="Closes on">{e.closesOn}</Row> : null}
      {!e.isPlanStarted && e.setupDeadlineAt ? (
        <Row label="Setup window ends">{e.setupDeadlineAt}</Row>
      ) : null}
      {e.firstPeriodRefundedAt ? (
        <Row label="Refunded under § 5">{e.firstPeriodRefundedAt}</Row>
      ) : null}
      <Row label="Open invoice">
        {e.openInvoice ? (
          <>
            {e.openInvoice.amountCents !== null ? `${money(e.openInvoice.amountCents)} ` : ""}
            {e.openInvoice.url ? (
              <a href={e.openInvoice.url} className="underline" target="_blank" rel="noreferrer">
                Stripe&rsquo;s page
              </a>
            ) : (
              "no link on record"
            )}
          </>
        ) : (
          "none"
        )}
      </Row>
      {!e.hasSubscription ? <Row label="Stripe">No subscription on record</Row> : null}
    </dl>
  );
}

function AutoRenew({ e, onSet }: { e: Entitlements; onSet: Actions["setAutoRenew"] }) {
  const { pending, note, call } = useCall();
  const on = e.cancelAt === null && !["canceling", "canceled", "purged"].includes(e.status);
  if (e.status === "canceled" || e.status === "purged") return null;
  return (
    <div className="border-line mt-4 border-t pt-4 text-sm">
      <p>
        Auto-renew is <strong>{on ? "on" : "off"}</strong>.{" "}
        {on
          ? "Turning it off on the clinic's behalf ends the plan at the end of the paid period."
          : "Turning it back on keeps the plan renewing."}
      </p>
      <button
        type="button"
        disabled={pending}
        className={`${BUTTON} mt-2`}
        onClick={() => {
          if (
            on &&
            !window.confirm(
              "Turn auto-renew off for this clinic? The plan ends at the end of the paid period.",
            )
          ) {
            return;
          }
          call(
            () => onSet(!on),
            (data) => {
              if (data.status !== "ok") return null;
              const where = data.closesOn
                ? `Auto-renew is off: the account closes on ${data.closesOn}.`
                : "Auto-renew is on.";
              return data.changed ? where : `${where} It already was; nothing changed.`;
            },
          );
        }}
      >
        {pending ? "Working…" : on ? "Turn auto-renew off" : "Turn auto-renew on"}
      </button>
      <Said note={note} />
    </div>
  );
}

function LiftSuspension({ onLift }: { onLift: Actions["liftSuspension"] }) {
  const { pending, note, call } = useCall();
  return (
    <div className="border-line mt-4 border-t pt-4 text-sm">
      <p>
        Suspended. When an invoice is open, paying it brings the account back by itself; lifting by
        hand is for a resolved dispute or a suspension we imposed.
      </p>
      <button
        type="button"
        disabled={pending}
        className={`${BUTTON} mt-2`}
        onClick={() => {
          const reason = window.prompt("Why is the suspension being lifted? (no patient details)");
          if (!reason) return;
          call(
            () => onLift(reason),
            () => "Lifted: the account is active again.",
          );
        }}
      >
        Lift the suspension
      </button>
      <Said note={note} />
    </div>
  );
}

function ExtendDeadline({
  deadline,
  deadlineIso,
  onExtend,
}: {
  deadline: string;
  deadlineIso: string;
  onExtend: Actions["extendSetupDeadline"];
}) {
  const { pending, note, call } = useCall();
  const [days, setDays] = useState("7");
  return (
    <div className="border-line mt-4 border-t pt-4 text-sm">
      <p>
        The setup window ends {deadline}. With nothing live by then, the account is closed and the
        setup fee is kept.
      </p>
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          call(
            () => onExtend({ days: Number(days), fromDeadline: deadlineIso }),
            (data) => (data.status === "extended" ? `Extended to ${data.setupDeadlineAt}.` : null),
          );
        }}
      >
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">
            Extend by (days, 1–30)
          </span>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className={`${INPUT} w-24`}
          />
        </label>
        <button type="submit" disabled={pending} className={BUTTON}>
          Extend the setup window
        </button>
      </form>
      <Said note={note} />
    </div>
  );
}

function Usage({ view }: { view: View }) {
  if (view.usage.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th className="py-1 pr-3">Meter</th>
            <th className="py-1 pr-3">Used</th>
            <th className="py-1 pr-3">Included</th>
            <th className="py-1 pr-3">Over</th>
            <th className="py-1 pr-3">Overage</th>
            <th className="py-1 pr-3">Window</th>
          </tr>
        </thead>
        <tbody>
          {view.usage.map((u) => (
            <tr key={u.meter} className="border-line border-t">
              <td className="py-1 pr-3">
                {u.meter === "voice_minutes" ? "Voice minutes" : "Chat conversations"}
              </td>
              <td className="py-1 pr-3">
                {u.used}
                {u.percent !== null ? <span className="text-muted"> ({u.percent}%)</span> : null}
              </td>
              <td className="py-1 pr-3">{u.included}</td>
              <td className="py-1 pr-3">{u.overUnits}</td>
              <td className="py-1 pr-3">{money(u.overageCents)}</td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {u.windowStartOn ? `${u.windowStartOn} → ${u.windowEndOn ?? "?"}` : "no window yet"}
                {u.windowStartOn && !u.isWindowOpen ? (
                  <span className="text-muted"> (ended)</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted mt-2 text-xs">
        Overage rates are provisional until measured. Under &ldquo;stop and fall back&rdquo; nothing
        is billed past the allowance.
      </p>
    </div>
  );
}

function UsageSwitches({ e, actions }: { e: Entitlements; actions: Actions }) {
  const mode = useCall();
  const alerts = useCall();
  const changed = (data: BillingSwitchOutcome) =>
    data.status === "updated" ? (data.changed ? "Saved." : "Already set; nothing changed.") : null;
  return (
    <div className="border-line mt-4 grid gap-4 border-t pt-4 text-sm sm:grid-cols-2">
      <div>
        <p className="text-muted text-xs font-bold uppercase">At the allowance</p>
        <select
          value={e.overageMode}
          disabled={mode.pending}
          onChange={(event) => {
            const next = event.target.value === "hard_cap" ? "hard_cap" : "allow";
            mode.call(() => actions.setOverageMode(next), changed);
          }}
          className={`${INPUT} w-full`}
        >
          <option value="allow">Keep answering and bill the extra</option>
          <option value="hard_cap">Stop and fall back</option>
        </select>
        <Said note={mode.note} />
      </div>
      <div>
        <p className="text-muted text-xs font-bold uppercase">80% and 100% emails</p>
        <button
          type="button"
          disabled={alerts.pending}
          className={`${BUTTON} mt-2`}
          onClick={() => alerts.call(() => actions.setUsageAlerts(!e.usageAlertsEnabled), changed)}
        >
          {e.usageAlertsEnabled ? "On — turn off" : "Off — turn on"}
        </button>
        <Said note={alerts.note} />
      </div>
    </div>
  );
}

function Channels({ view }: { view: View }) {
  return (
    <div className="grid gap-3 text-sm">
      {view.group.map((member) => (
        <div key={member.clinicId}>
          <p className="font-semibold">
            {member.name ?? member.clinicId}
            {member.isBillingClinic ? (
              <span className="text-muted font-normal"> (billing clinic)</span>
            ) : null}
          </p>
          {member.channels.length === 0 ? (
            <p className="text-muted text-xs">No channels yet.</p>
          ) : (
            <ul className="mt-1 grid gap-1">
              {member.channels.map((c) => (
                <li key={c.channel} className="text-xs">
                  {CHANNEL_LABELS[c.channel]}: {c.status.replace("_", " ")}
                  {c.firstAnswerOn ? ` · first answer ${c.firstAnswerOn}` : ""}
                  {c.waitingOn ? ` · waiting on ${c.waitingOn.replace(/_/g, " ")}` : ""}
                  {!c.enabled ? " · switched off" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function PauseAndLine({ view, onSave }: { view: View; onSave: Actions["setClinicSettings"] }) {
  const pause = useCall();
  const line = useCall();
  const s = view.settings;
  const [until, setUntil] = useState("");
  const [direct, setDirect] = useState(s.directLineE164 ?? "");
  const saved = (data: BillingSwitchOutcome) =>
    data.status === "updated" ? (data.changed ? "Saved." : "Already set; nothing changed.") : null;
  return (
    <div className="grid gap-5 text-sm">
      <div>
        <p>
          {s.isPaused
            ? `Paused since ${s.pausedAt ?? "?"}${s.pausedUntil ? ` until ${s.pausedUntil}` : " until switched back on"}${s.pausedByLabel ? ` (by ${s.pausedByLabel})` : ""}. Calls forward to the direct line.`
            : "The assistant is answering."}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {s.isPaused ? (
            <button
              type="button"
              disabled={pause.pending}
              className={BUTTON}
              onClick={() => pause.call(() => onSave({ aiPaused: false }), saved)}
            >
              Resume
            </button>
          ) : null}
          <button
            type="button"
            disabled={pause.pending}
            className={BUTTON}
            onClick={() => {
              if (!window.confirm("Pause the assistant until someone switches it back on?")) return;
              pause.call(() => onSave({ aiPaused: true, aiPausedUntil: null }), saved);
            }}
          >
            {s.isPaused ? "Make it open-ended" : "Pause"}
          </button>
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">Or pause until</span>
            <input
              type="datetime-local"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="button"
            disabled={pause.pending || !until}
            className={BUTTON}
            onClick={() =>
              pause.call(
                () => onSave({ aiPaused: true, aiPausedUntil: new Date(until).toISOString() }),
                saved,
              )
            }
          >
            Pause until then
          </button>
        </div>
        <Said note={pause.note} />
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          line.call(
            () => onSave({ directLineE164: direct.trim() === "" ? null : direct.trim() }),
            saved,
          );
        }}
      >
        <label className="text-sm">
          <span className="text-muted block text-xs font-bold uppercase">
            Direct line (a clinic line that does not forward back to us)
          </span>
          <input
            value={direct}
            onChange={(event) => setDirect(event.target.value)}
            placeholder="+1 415 555 0100"
            className={INPUT}
          />
        </label>
        <button type="submit" disabled={line.pending} className={BUTTON}>
          {direct.trim() === "" ? "Clear the direct line" : "Save the direct line"}
        </button>
        {s.directLineSetOn ? (
          <span className="text-muted text-xs">set {s.directLineSetOn}</span>
        ) : null}
      </form>
      <Said note={line.note} />
    </div>
  );
}

function Connect({
  view,
  onIssue,
  onDisconnect,
}: {
  view: View;
  onIssue: Actions["issueConnectLink"];
  onDisconnect: Actions["disconnectConnect"];
}) {
  const { pending, note, call } = useCall();
  // Shown once, then gone: the link is a bearer credential and is never stored.
  const [issued, setIssued] = useState<{ url: string; expiresAt: string } | null>(null);
  const c = view.connect;
  if (c.isConnected) {
    return (
      <div className="text-sm">
        <p>
          Connected to the clinic&rsquo;s own Stripe
          {c.accountLabel ? <strong> ({c.accountLabel})</strong> : " (name not shown)"}
          {c.connectedOn ? ` since ${c.connectedOn}` : ""}. Deposits are paid straight into it.
        </p>
        <button
          type="button"
          disabled={pending}
          className={`${BUTTON} mt-2`}
          onClick={() => {
            if (
              !window.confirm(
                "Disconnect this Stripe account? Deposits switch off, open payment links are expired or handed to the front desk, and our access is revoked unless another clinic shares the account.",
              )
            ) {
              return;
            }
            call(onDisconnect, (data) =>
              data.status === "disconnected"
                ? `Disconnected${data.shared ? " (the account is shared, so access stays for the other clinic)" : ""}. Links: ${data.cancelledLinks} expired, ${data.paidLinks} found paid, ${data.uncheckedLinks} could not be checked and went to the front desk.`
                : null,
            );
          }}
        >
          Disconnect Stripe
        </button>
        <Said note={note} />
      </div>
    );
  }
  return (
    <div className="text-sm">
      <p>
        Not connected{c.disconnectedOn ? ` (disconnected ${c.disconnectedOn})` : ""}. Send the
        clinic a one-time link, or open it with them on a call: they sign in to their own Stripe and
        approve healdesk. The link works for 15 minutes and is shown once.
      </p>
      {issued ? (
        <div className="border-line mt-3 rounded-xl border p-3">
          <a href={issued.url} target="_blank" rel="noreferrer" className="break-all underline">
            {issued.url}
          </a>
          <p className="text-muted mt-1 text-xs">
            Works until {issued.expiresAt}. It cannot be shown again.
          </p>
        </div>
      ) : null}
      <button
        type="button"
        disabled={pending}
        className={`${BUTTON} mt-2`}
        onClick={() =>
          call(onIssue, (data) => {
            if (data.status === "issued") setIssued({ url: data.url, expiresAt: data.expiresAt });
            return null;
          })
        }
      >
        Issue a Connect link
      </button>
      <Said note={note} />
    </div>
  );
}

function Deposits({ view, onSave }: { view: View; onSave: Actions["setDepositSettings"] }) {
  const { pending, note, call } = useCall();
  const d = view.deposits;
  const [form, setForm] = useState({
    depositsEnabled: d.depositsEnabled,
    bookVoiceWithoutDeposit: d.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: d.bookChatWithoutDeposit,
    depositUncollectable: d.depositUncollectable,
    depositHoldMinutes: String(d.depositHoldMinutes),
  });
  return (
    <form
      className="border-line mt-4 grid gap-3 border-t pt-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        call(
          () =>
            onSave({
              depositsEnabled: form.depositsEnabled,
              bookVoiceWithoutDeposit: form.bookVoiceWithoutDeposit,
              bookChatWithoutDeposit: form.bookChatWithoutDeposit,
              depositUncollectable: form.depositUncollectable,
              depositHoldMinutes: Number(form.depositHoldMinutes),
            }),
          (data) =>
            data.status === "updated" ? (data.changed ? "Saved." : "Nothing changed.") : null,
        );
      }}
    >
      <p className="text-muted text-xs">
        Default deposit: {d.defaultAmountUsd !== null ? MONEY.format(d.defaultAmountUsd) : "none"}
        {d.hasDepositAmount ? "" : " · no service asks for one"}
        {d.canEnable
          ? ""
          : " · deposits can be switched on once Stripe is connected and an amount is set"}
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.depositsEnabled}
          onChange={(event) => setForm({ ...form, depositsEnabled: event.target.checked })}
        />
        Take deposits
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.bookVoiceWithoutDeposit}
          onChange={(event) => setForm({ ...form, bookVoiceWithoutDeposit: event.target.checked })}
        />
        On the phone, book without the deposit and flag it for staff
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.bookChatWithoutDeposit}
          onChange={(event) => setForm({ ...form, bookChatWithoutDeposit: event.target.checked })}
        />
        In chat, book without the deposit and flag it for staff
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-muted block text-xs font-bold uppercase">
            When a deposit cannot be collected
          </span>
          <select
            value={form.depositUncollectable}
            onChange={(event) =>
              setForm({ ...form, depositUncollectable: event.target.value as DepositUncollectable })
            }
            className={`${INPUT} w-full`}
          >
            {(Object.keys(UNCOLLECTABLE_LABELS) as DepositUncollectable[]).map((option) => (
              <option key={option} value={option}>
                {UNCOLLECTABLE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-muted block text-xs font-bold uppercase">
            Hold the slot (minutes, 30–1440)
          </span>
          <input
            type="number"
            min={30}
            max={1440}
            value={form.depositHoldMinutes}
            onChange={(event) => setForm({ ...form, depositHoldMinutes: event.target.value })}
            className={`${INPUT} w-full`}
          />
        </label>
      </div>
      <div>
        <button type="submit" disabled={pending} className={BUTTON}>
          Save deposit settings
        </button>
      </div>
      <Said note={note} />
    </form>
  );
}

function Refund({
  e,
  view,
  onPreview,
  onCommit,
}: {
  e: Entitlements;
  view: View;
  onPreview: Actions["previewRefund"];
  onCommit: Actions["commitRefund"];
}) {
  const preview = useCall();
  const commit = useCall();
  const [kind, setKind] = useState<RefundKind>("first_period_cancel");
  const [shown, setShown] = useState<Extract<RefundPreviewOutcome, { status: "ok" }> | null>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  if (e.firstPeriodRefundedAt) {
    return (
      <p className="text-sm">
        A refund under § 5 was issued {e.firstPeriodRefundedAt}. The two refunds do not stack, and
        the setup fee is never refunded.
      </p>
    );
  }
  const matches = shown !== null && typedCents(typed) === shown.amountCents;
  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted text-xs">
        The first-period refund pays back the first period in full and cancels the plan at once; the
        guarantee pays one month&rsquo;s fee and keeps the plan.
        {view.flags.refundWindowOpen
          ? ` The 14-day window is open until ${view.flags.refundEligibleUntil}.`
          : " The 14-day window is not open."}{" "}
        The setup fee is never refunded.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="text-muted block text-xs font-bold uppercase">Refund</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === "guarantee" ? "guarantee" : "first_period_cancel");
              setShown(null);
              setTyped("");
            }}
            className={INPUT}
          >
            <option value="first_period_cancel">First period, plan cancelled</option>
            <option value="guarantee">Guarantee: one month&rsquo;s fee</option>
          </select>
        </label>
        <button
          type="button"
          disabled={preview.pending}
          className={BUTTON}
          onClick={() =>
            preview.call(
              () => onPreview(kind),
              (data) => {
                if (data.status === "ok") setShown(data);
                return null;
              },
            )
          }
        >
          Preview the amount
        </button>
      </div>
      <Said note={preview.note} />
      {shown ? (
        <form
          className="border-line grid gap-3 rounded-xl border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!matches) return;
            commit.call(
              () => onCommit({ kind: shown.kind, confirmAmountCents: shown.amountCents, reason }),
              (data) =>
                data.status === "refunded"
                  ? `Refunded ${money(data.amountCents)} at ${data.refundedAt}.${data.isCancelRequested ? " The subscription is being cancelled now." : ""}`
                  : null,
            );
          }}
        >
          <p>
            <strong>{money(shown.amountCents)}</strong> back to the card
            {shown.cancelsPlan ? ", and the plan is cancelled at once" : ", and the plan is kept"}.
            Plan started {shown.planStartedOn ?? "?"}; this refund&rsquo;s window ends{" "}
            {shown.windowEndsOn ?? "?"}.
          </p>
          <label>
            <span className="text-muted block text-xs font-bold uppercase">
              Type the amount to confirm ({money(shown.amountCents)})
            </span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              inputMode="decimal"
              className={INPUT}
            />
          </label>
          <label>
            <span className="text-muted block text-xs font-bold uppercase">
              Reason, for the billing history (no patient details)
            </span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={2}
              className={`${INPUT} w-full`}
            />
          </label>
          <div>
            <button
              type="submit"
              disabled={commit.pending || !matches || reason.trim() === ""}
              className={PRIMARY}
            >
              Refund {money(shown.amountCents)}
            </button>
          </div>
          <Said note={commit.note} />
        </form>
      ) : null}
    </div>
  );
}

function Requests({ view, onRetry }: { view: View; onRetry: Actions["retryBillingRequest"] }) {
  if (view.requests.length === 0) {
    return <p className="text-muted text-sm">None yet. The first answer records the plan start.</p>;
  }
  return (
    <ul className="grid gap-2">
      {view.requests.map((request) => (
        <RequestRow key={request.id} request={request} onRetry={onRetry} />
      ))}
    </ul>
  );
}

function RequestRow({
  request,
  onRetry,
}: {
  request: View["requests"][number];
  onRetry: Actions["retryBillingRequest"];
}) {
  const { pending, note, call } = useCall();
  const state = request.outcome
    ? `${request.outcome.replace("_", " ")}${request.outcomeReason ? ` (${request.outcomeReason.replace(/_/g, " ")})` : ""} ${request.doneAt ?? ""}`
    : request.isInFlight
      ? "in flight"
      : request.isHeldBySwitch
        ? "waiting for the setup-closure switch"
        : `pending, next attempt ${request.nextAttemptAt}`;
  return (
    <li
      className={`border-line rounded-xl border px-4 py-2 text-sm ${request.isStuck ? "border-red/40" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">
          {REQUEST_LABELS[request.kind]}
          {request.channel ? ` — ${CHANNEL_LABELS[request.channel]}` : ""}
        </span>
        <span className="text-muted text-xs">
          recorded {request.requestedAt} ({request.reason.replace("_", " ")}) · {request.attempts}{" "}
          attempt(s)
        </span>
        {request.isStuck ? <span className="text-red-deep text-xs font-bold">STUCK</span> : null}
      </div>
      <p className="text-muted text-xs">{state}</p>
      {request.lastError ? (
        <p className="text-muted text-xs">last error: {request.lastError}</p>
      ) : null}
      {!request.isInFlight ? (
        <button
          type="button"
          disabled={pending}
          className={`${BUTTON} mt-2`}
          onClick={() => {
            if (
              request.outcome === "done" &&
              !window.confirm(
                "This request went through. Run it again? The worker re-reads Stripe and changes nothing already applied.",
              )
            ) {
              return;
            }
            call(
              () => onRetry(request.id),
              () => "Queued: the worker picks it up within a minute while billing-requests is on.",
            );
          }}
        >
          Retry
        </button>
      ) : null}
      <Said note={note} />
    </li>
  );
}

function CloseSetup({ onClose }: { onClose: Actions["closeUnfinishedSetup"] }) {
  const { pending, note, call } = useCall();
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="grid gap-2 text-sm">
      <p>
        Records a setup closure: the subscription is cancelled at once with no final invoice, and
        the setup fee is kept. The worker carries it out only while the setup-closure switch is on,
        and skips it if anything has gone live by then.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I understand this closes the clinic&rsquo;s account.
      </label>
      <div>
        <button
          type="button"
          disabled={pending || !confirmed}
          className={BUTTON}
          onClick={() =>
            call(onClose, (data) =>
              data.status === "recorded"
                ? `${data.isNew ? "Closure recorded" : "A closure was already recorded (see Billing requests; retry it there if it was skipped)"}.${data.isSwitchOn ? "" : " The setup-closure switch is off, so it waits."}`
                : null,
            )
          }
        >
          Close the unfinished setup
        </button>
      </div>
      <Said note={note} />
    </div>
  );
}

function PendingLocation({
  view,
  onRetry,
}: {
  view: View;
  onRetry: Actions["retryLocationSetup"];
}) {
  const { pending, note, call } = useCall();
  const p = view.flags.pendingLocation;
  if (!p) return null;
  return (
    <div className="text-sm">
      <p>
        Location {p.locationNumber}:{" "}
        {p.chargedOn
          ? `charged ${p.chargedOn}; its clinic was not created.`
          : "not charged on record."}{" "}
        Retrying finishes it, or clears a request that never charged. It never charges.
      </p>
      <button
        type="button"
        disabled={pending}
        className={`${BUTTON} mt-2`}
        onClick={() =>
          call(onRetry, (data) =>
            data.status === "added"
              ? `Added: ${data.slug}.`
              : data.status === "cleared"
                ? "Cleared: nothing was charged, so the clinic can add the location again."
                : null,
          )
        }
      >
        Retry the location setup
      </button>
      <Said note={note} />
    </div>
  );
}

function Overage({ view, onRetry }: { view: View; onRetry: Actions["retryOverageInvoice"] }) {
  if (view.overageInvoices.length === 0) {
    return <p className="text-muted text-sm">None. Annual plans are invoiced per closed month.</p>;
  }
  return (
    <ul className="grid gap-2">
      {view.overageInvoices.map((o) => (
        <OverageRow key={o.windowStartIso} row={o} onRetry={onRetry} />
      ))}
    </ul>
  );
}

function OverageRow({
  row,
  onRetry,
}: {
  row: View["overageInvoices"][number];
  onRetry: Actions["retryOverageInvoice"];
}) {
  const { pending, note, call } = useCall();
  return (
    <li className="border-line rounded-xl border px-4 py-2 text-sm">
      <span className="font-semibold">
        {row.windowStartOn} → {row.windowEndOn}
      </span>
      <span className="text-muted ml-2 text-xs">
        {row.voiceUnits} voice minutes, {row.chatUnits} chats · {money(row.amountCents)} ·{" "}
        {row.status}
        {row.invoicedOn ? ` ${row.invoicedOn}` : ""}
        {row.code ? ` · ${row.code}` : ""}
      </span>
      {row.status === "failed" || row.status === "pending" ? (
        <div>
          <button
            type="button"
            disabled={pending}
            className={`${BUTTON} mt-2`}
            onClick={() =>
              call(
                () => onRetry(row.windowStartIso),
                (data) =>
                  data.status === "invoiced"
                    ? `Invoiced ${money(data.amountCents)}.`
                    : data.status === "skipped"
                      ? `Skipped (${data.reason.replace(/_/g, " ")}).`
                      : null,
              )
            }
          >
            Retry the invoice
          </button>
        </div>
      ) : null}
      <Said note={note} />
    </li>
  );
}

function ParkedEvents({
  view,
  onReplayBilling,
  onReplayConnect,
}: {
  view: View;
  onReplayBilling: Actions["replayBillingEvent"];
  onReplayConnect: Actions["replayConnectEvent"];
}) {
  if (view.attentionEvents.length === 0) {
    return <p className="text-muted text-sm">Nothing parked for this clinic.</p>;
  }
  return (
    <ul className="grid gap-2">
      {view.attentionEvents.map((event) => (
        <EventRow
          key={`${event.source}:${event.stripeEventId}`}
          event={event}
          onReplay={event.source === "billing" ? onReplayBilling : onReplayConnect}
        />
      ))}
    </ul>
  );
}

function EventRow({
  event,
  onReplay,
}: {
  event: View["attentionEvents"][number];
  onReplay: (eventId: string) => Promise<OpsResult<ReplayEventOutcome>>;
}) {
  const { pending, note, call } = useCall();
  return (
    <li className="border-line rounded-xl border px-4 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold">{event.type}</span>
        <span className="text-muted text-xs">
          {event.source === "connect" ? "Connect · " : ""}
          {event.stripeEventId} · {event.outcome.replace("_", " ")} after {event.failures}{" "}
          failure(s) · {event.code} · received {event.receivedAt}
        </span>
      </div>
      <button
        type="button"
        disabled={pending}
        className={`${BUTTON} mt-2`}
        onClick={() =>
          call(
            () => onReplay(event.stripeEventId),
            (data) =>
              data.status === "replayed" ? `Replayed: ${data.outcome.replace("_", " ")}.` : null,
          )
        }
      >
        Replay
      </button>
      <Said note={note} />
    </li>
  );
}

function Notices({ view }: { view: View }) {
  if (view.notices.length === 0) return <p className="text-muted text-sm">None yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th className="py-1 pr-3">Queued (UTC)</th>
            <th className="py-1 pr-3">Kind</th>
            <th className="py-1 pr-3">Sent</th>
            <th className="py-1 pr-3">Attempts</th>
          </tr>
        </thead>
        <tbody>
          {view.notices.map((n, i) => (
            <tr key={i} className="border-line border-t">
              <td className="py-1 pr-3 whitespace-nowrap">{n.createdAt}</td>
              <td className="py-1 pr-3">{n.kind}</td>
              <td className={`py-1 pr-3 ${n.sentAt ? "text-done" : "text-muted"}`}>
                {n.sentAt
                  ? `${n.sentAt}${n.recipientsCount !== null ? ` (${n.recipientsCount})` : ""}`
                  : `due ${n.sendAfter}`}
                {n.lastError ? (
                  <span className="text-muted block text-xs">{n.lastError}</span>
                ) : null}
              </td>
              <td className="py-1 pr-3">{n.attempts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Transitions({ view }: { view: View }) {
  if (view.transitions.length === 0) return <p className="text-muted text-sm">None.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            <th className="py-1 pr-3">When (UTC)</th>
            <th className="py-1 pr-3">Change</th>
            <th className="py-1 pr-3">By</th>
            <th className="py-1 pr-3">Reason</th>
          </tr>
        </thead>
        <tbody>
          {view.transitions.map((t, i) => (
            <tr key={i} className="border-line border-t">
              <td className="py-1 pr-3 whitespace-nowrap">{t.at}</td>
              <td className="py-1 pr-3">
                {t.fromStatus === t.toStatus ? "note" : `${t.fromStatus ?? "—"} → ${t.toStatus}`}
              </td>
              <td className="py-1 pr-3">{t.actor}</td>
              <td className="py-1 pr-3">{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
