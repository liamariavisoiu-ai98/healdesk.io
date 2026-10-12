"use client";

import { useState, useTransition } from "react";

import type { CareOutcome, ClinicHealth, HealthFlag, OpsResult } from "@/lib/admin/ops-client";

/**
 * The first-weeks list: which clinic to phone today, and why.
 *
 * Counts and dates only. The flags are the two human moments the product
 * cannot substitute for — the day-7 "nothing arrived" call and the
 * first-win call — plus a quiet week and a clinic near its allowance.
 * Every touch is recorded here so the second call knows about the first.
 */
const FLAG_COPY: Record<HealthFlag, { label: string; tone: "warn" | "ok" | "muted" }> = {
  no_calls_after_day_7: { label: "Past day 7, no calls — the phone was never forwarded. Phone them.", tone: "warn" },
  first_win: { label: "First recovered booking, nobody has called them since. Call and say so.", tone: "ok" },
  quiet_week: { label: "Nothing this week after earlier calls — check the forwarding still holds.", tone: "warn" },
  near_allowance: { label: "Near the plan's voice allowance — the tier conversation is a fact, not a guess.", tone: "muted" },
};

export function FirstWeeks({
  health,
  onTouch,
}: {
  health: OpsResult<ClinicHealth[]>;
  onTouch: (clinicId: string, input: { kind: "call" | "email" | "note"; summary: string; outcome?: string }) => Promise<OpsResult<CareOutcome>>;
}) {
  if (!health.ok) {
    return (
      <section className="mt-12">
        <h2 className="text-[13.2px] font-bold tracking-[0.06em] uppercase">First weeks</h2>
        <p className="text-red-deep mt-2 text-sm">{health.message}</p>
      </section>
    );
  }
  const rows = health.data;
  const needsCall = rows.filter((r) => r.flags.length > 0);
  return (
    <section className="mt-12">
      <h2 className="text-[13.2px] font-bold tracking-[0.06em] uppercase">First weeks{rows.length ? ` (${rows.length} live under 60 days)` : ""}</h2>
      {rows.length === 0 ? (
        <p className="text-muted mt-2 text-sm">No clinic has gone live in the last sixty days.</p>
      ) : (
        <>
          {needsCall.length > 0 ? (
            <p className="mt-2 text-sm font-semibold">{needsCall.length} {needsCall.length === 1 ? "clinic needs" : "clinics need"} a human call today.</p>
          ) : (
            <p className="text-muted mt-2 text-sm">Nobody needs a call today.</p>
          )}
          <ul className="mt-4 grid gap-3">
            {rows.map((r) => (
              <HealthRow key={r.clinicId} row={r} onTouch={onTouch} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function HealthRow({ row, onTouch }: { row: ClinicHealth; onTouch: Parameters<typeof FirstWeeks>[0]["onTouch"] }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <li className="border-line rounded-sm border bg-white px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">{row.name}</span>
        <span className="text-muted text-xs">day {row.daysLive} · live since {row.wentLiveOn}{row.plan ? ` · ${row.plan}` : ""}</span>
        <a href={`/admin/ops/${row.clinicId}/care`} className="text-xs underline">care</a>
        <a href={`/admin/ops/${row.clinicId}/onboarding`} className="text-xs underline">onboarding</a>
      </div>
      <p className="text-muted mt-1 text-xs">
        {row.conversations.total} calls handled ({row.conversations.last7} this week) · {row.recovered.total} the desk would have missed ·{" "}
        {row.bookings} booked{row.firstRecoveredBookingOn ? ` · first recovered booking ${row.firstRecoveredBookingOn}` : ""} ·{" "}
        {row.recipients} report recipient{row.recipients === 1 ? "" : "s"} · forwarding {row.forwardingTested ? "tested" : "NOT tested"} ·{" "}
        {row.connected ? "read-back connected (phase two)" : "no read-back (phase two)"}
        {row.usage && row.usage.voiceMinutesIncluded > 0 ? ` · ${Math.round(row.usage.voiceMinutesUsed)}/${row.usage.voiceMinutesIncluded} voice min` : ""}
      </p>
      {row.flags.map((f) => (
        <p key={f} className={`mt-1 text-xs font-semibold ${FLAG_COPY[f].tone === "warn" ? "text-red-deep" : FLAG_COPY[f].tone === "ok" ? "text-done" : "text-muted"}`}>
          {FLAG_COPY[f].label}
        </p>
      ))}
      {row.touches.length > 0 ? (
        <ul className="text-muted mt-2 grid gap-1 text-xs">
          {row.touches.slice(0, open ? undefined : 2).map((t, i) => (
            <li key={i}>
              {t.touchedAt} · {t.kind} by {t.byLabel}: {t.summary}{t.outcome ? ` → ${t.outcome}` : ""}
            </li>
          ))}
          {row.touches.length > 2 && !open ? (
            <li><button type="button" onClick={() => setOpen(true)} className="underline">show all {row.touches.length}</button></li>
          ) : null}
        </ul>
      ) : (
        <p className="text-muted mt-2 text-xs">No human touch recorded yet.</p>
      )}
      {problem ? <p className="text-red-deep mt-1 text-xs">{problem}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {(["call", "email", "note"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={pending}
            onClick={() => {
              const summary = window.prompt(`Record a ${kind}: what was said? (no patient details)`);
              if (!summary) return;
              const outcome = window.prompt("Outcome (optional): e.g. 'will forward tonight', 'agreed to case study'") ?? "";
              start(async () => {
                const result = await onTouch(row.clinicId, { kind, summary, ...(outcome ? { outcome } : {}) });
                setProblem(!result.ok ? result.message : result.data.status === "refused" ? result.data.message : null);
              });
            }}
            className="border-line-strong rounded-full border px-3 py-1 text-xs font-bold"
          >
            Record {kind}
          </button>
        ))}
      </div>
    </li>
  );
}
