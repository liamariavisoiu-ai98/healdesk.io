"use client";

import { useState, useTransition } from "react";

import { Failure, Section } from "@/components/admin/ui";
import type { CareOutcome, ClinicHealth, OpsResult } from "@/lib/admin/ops-client";

/**
 * The human touches with a clinic in its first weeks: which calls, emails
 * and notes an operator made, so the second call knows about the first.
 * Until the admin redesign (23 October 2026) this was the First-weeks list
 * on /admin/ops, which recorded a touch through `window.prompt`; E1 §2 moves
 * it to the Care tab as a proper small form. The flags that said "phone them
 * today" are rows on Home.
 *
 * The list comes from the first-weeks health read (listClinicHealth), which
 * covers a clinic only in its first sixty days live, so an older clinic, or
 * one not live yet, shows no list. The Record form is offered for EVERY
 * clinic (lane N3: ten alerts tell the operator to note what they did here):
 * apps/app takes a note for any clinic until its account is closed, and
 * says so when it refuses one (lib/ops/health.ts touchRefusal). Counts and
 * dates; the summary is the operator's own words about the clinic, never a
 * patient, and apps/app refuses patient details in it.
 */

export type RecordTouch = (input: { kind: "call" | "email" | "note"; summary: string; outcome?: string }) => Promise<OpsResult<CareOutcome>>;

export function TouchLog({ health, onTouch }: { health: OpsResult<ClinicHealth | null>; onTouch: RecordTouch }) {
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const row = health.ok ? health.data : null;
  const touches = row?.touches ?? [];

  return (
    <Section title={row ? `Touch log — ${touches.length}` : "Touch log"}>
      {!health.ok ? (
        // A read that failed is said as such, never as a log with nothing in it.
        <Failure failure={health} what="the touch log" />
      ) : !row ? (
        <p className="text-muted text-sm">
          Earlier notes are listed here only in a clinic&rsquo;s first sixty days live. You can still record one below:
          every clinic takes a note until its account is closed.
        </p>
      ) : touches.length === 0 ? (
        <p className="text-muted text-sm">No call, email or note recorded yet.</p>
      ) : (
        <ul className="text-muted grid gap-1 text-sm">
          {touches.slice(0, open ? undefined : 5).map((t, i) => (
            <li key={i}>
              {t.touchedAt} · {t.kind} by {t.byLabel}: {t.summary}
              {t.outcome ? ` → ${t.outcome}` : ""}
            </li>
          ))}
          {touches.length > 5 && !open ? (
            <li>
              <button type="button" onClick={() => setOpen(true)} className="underline">
                show all {touches.length}
              </button>
            </li>
          ) : null}
        </ul>
      )}

      <form
        className="border-line mt-4 grid gap-3 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const kind = String(data.get("kind") ?? "");
          const summary = String(data.get("summary") ?? "").trim();
          const outcome = String(data.get("outcome") ?? "").trim();
          if ((kind !== "call" && kind !== "email" && kind !== "note") || summary === "") return;
          setSaid(null);
          start(async () => {
            const result = await onTouch({ kind, summary, ...(outcome ? { outcome } : {}) });
            if (!result.ok) return setSaid({ ok: false, text: result.message });
            if (result.data.status === "refused") return setSaid({ ok: false, text: result.data.message });
            form.reset();
            setSaid({ ok: true, text: "Recorded." });
          });
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1">
            <span className="text-muted text-xs font-bold tracking-[0.06em] uppercase">Kind</span>
            <select name="kind" defaultValue="call" className="border-line rounded-sm border bg-white px-3 py-2 text-sm">
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="note">Note</option>
            </select>
          </label>
          <label className="grid min-w-[240px] flex-1 gap-1">
            <span className="text-muted text-xs font-bold tracking-[0.06em] uppercase">What was said (no patient details)</span>
            <input name="summary" required maxLength={500} autoComplete="off" className="border-line rounded-sm border bg-white px-3 py-2 text-sm" />
          </label>
          <label className="grid min-w-[200px] gap-1">
            <span className="text-muted text-xs font-bold tracking-[0.06em] uppercase">Outcome (optional)</span>
            <input name="outcome" maxLength={200} autoComplete="off" placeholder="will forward tonight" className="border-line rounded-sm border bg-white px-3 py-2 text-sm" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className="border-line-strong hover:border-ink rounded-full border px-4 py-2 text-sm font-bold disabled:opacity-50">
            {pending ? "Recording…" : "Record"}
          </button>
          {said ? (
            <p role="status" className={`text-sm ${said.ok ? "text-done" : "text-red-deep font-semibold"}`}>
              {said.text}
            </p>
          ) : null}
        </div>
      </form>
    </Section>
  );
}
