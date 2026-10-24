"use client";

import { ActionButton, Chip, Empty, Failure, Section } from "@/components/admin/ui";
import type {
  AcknowledgeClinicChangeOutcome,
  AuditPack,
  ClinicAuditsView,
  ClinicChangeView,
  OpsResult,
  RunClinicAuditOutcome,
} from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The Setup tab's "Availability changes" card (ops automation wave 2, lane
 * A3): what the clinic changed about when and with whom AYA books, by whom
 * and when, whether an operator has looked at it, and the latest result of
 * each audit pack, with the failing checks' hints in plain words. The alert
 * "the clinic changed its availability" links here (`#availability`), and
 * its wording quotes the two buttons: "Run audit now" and "Mark as seen".
 *
 * Words only: a change's summary is counts, dates and enums from apps/app
 * (never what was typed), the actor is coarse ("the clinic", "ops", "a change
 * file", "outside the portal"), and a check's hint is apps/app's fixed
 * sentence. An empty card says "No changes yet.", never a zero; a read that
 * failed says so and costs only its half.
 */

export const AUDIT_PACK_LIST: readonly AuditPack[] = ["availability", "roster", "golive", "transcripts"];

const PACK_WORDS: Record<AuditPack, string> = {
  availability: "Availability",
  roster: "Roster",
  golive: "Go-live",
  transcripts: "Transcripts",
};

const ACTOR_WORDS: Record<ClinicChangeView["actorKind"], string> = {
  clinic_device: "the clinic",
  clinic_signin: "the clinic",
  ops: "ops",
  change_file: "a change file",
  direct: "outside the portal",
};

const AUDIT_STATUS_WORDS: Record<NonNullable<ClinicChangeView["auditStatus"]>, { words: string; tone: Tone }> = {
  queued: { words: "audit queued", tone: "info" },
  running: { words: "audit running", tone: "info" },
  passed: { words: "audit passed", tone: "ok" },
  attention: { words: "audit needs attention", tone: "warn" },
  error: { words: "audit could not run", tone: "bad" },
};

const RESULT_WORDS: Record<"pass" | "warn" | "fail" | "error", { words: string; tone: Tone }> = {
  pass: { words: "pass", tone: "ok" },
  warn: { words: "warn", tone: "warn" },
  fail: { words: "fail", tone: "bad" },
  error: { words: "could not run", tone: "bad" },
};

/** "2026-10-23 09:12 UTC" from an ISO instant. */
export function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** What changed, in words, from the change's kind and its summary of counts and dates. */
export function changeWords(change: ClinicChangeView): string {
  const s = change.summary;
  const extra = s.holdsReleased ? `; ${s.holdsReleased} ${s.holdsReleased === 1 ? "hold" : "holds"} released` : "";
  switch (change.kind) {
    case "hours":
      return `Weekly hours changed${extra}`;
    case "closures": {
      const parts: string[] = [];
      if (s.closuresAdded?.length) parts.push(`added ${s.closuresAdded.join(", ")}`);
      if (s.closuresRemoved?.length) parts.push(`taken off ${s.closuresRemoved.join(", ")}`);
      if (parts.length === 0) {
        const n = s.rows ?? 0;
        parts.push(
          n === 0 ? "changed" : s.operation === "delete" ? `${n} taken off` : s.operation === "insert" ? `${n} added` : `${n} changed`,
        );
      }
      return `Closed days: ${parts.join("; ")}${s.closuresUpcoming !== undefined ? ` (${s.closuresUpcoming} upcoming)` : ""}${extra}`;
    }
    case "location_hours":
      return `A location's hours changed${extra}`;
    case "providers":
      return `Providers changed${s.providersActive !== undefined ? ` (${s.providersActive} active)` : ""}${extra}`;
    case "provider_services":
      return `Provider services changed${s.servicesMapped !== undefined ? ` (${s.servicesMapped} mapped)` : ""}${extra}`;
  }
}

function runSaid(data: RunClinicAuditOutcome): string | null {
  switch (data.status) {
    case "ran":
      if (data.result === "error") return "The audit could not finish. Try again in a minute.";
      return `Ran: ${RESULT_WORDS[data.result].words}${data.audits.length ? ` across ${data.audits.length} ${data.audits.length === 1 ? "pack" : "packs"}` : ""}.`;
    case "too_soon":
      return `Too soon: a run is allowed once a minute; try again after ${when(data.notBefore)}.`;
    case "busy":
      return "Busy: another run for this clinic is under way.";
    case "closed":
      return "Closed account: nothing to audit.";
    case "not_found":
      return "That clinic was not found.";
  }
}

function Packs({ summary }: { summary: ClinicAuditsView["clinics"][number] | null }) {
  if (!summary) return <p className="text-muted text-sm">No audit has run for this clinic.</p>;
  return (
    <>
      {summary.overall === "audits_off" ? (
        <p className="text-sm">
          <Chip tone="warn">audits are off</Chip> <span className="text-muted">Changes wait for an audit while audits are switched off.</span>
        </p>
      ) : summary.overall === "running" ? (
        <p className="text-sm">
          <Chip tone="info">running</Chip>
        </p>
      ) : null}
      <ul className="mt-2 grid gap-1.5 text-sm">
        {AUDIT_PACK_LIST.map((pack) => {
          const latest = summary.packs[pack];
          if (!latest) {
            return (
              <li key={pack} className="flex flex-wrap items-center gap-2">
                <span className="w-28 font-semibold">{PACK_WORDS[pack]}</span>
                <Chip tone="muted">never</Chip>
              </li>
            );
          }
          const result = RESULT_WORDS[latest.result];
          return (
            <li key={pack} className="flex flex-wrap items-start gap-2">
              <span className="w-28 font-semibold">{PACK_WORDS[pack]}</span>
              <Chip tone={result.tone}>{result.words}</Chip>
              <span className="text-muted">{when(latest.at)}</span>
              {latest.failing.length > 0 ? (
                <ul className="text-muted w-full list-disc pl-5">
                  {latest.failing.map((f) => (
                    <li key={f.id}>{f.hint ?? f.id}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The newest changes drawn; the rest are a count line, not a scroll. */
export const CHANGES_SHOWN = 10;

/** The empty state names the window the read covered: "No changes yet." only when it reached back a year or more. */
export function noChangesWords(sinceIso: string, nowIso: string): string {
  const since = Date.parse(sinceIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(since) || Number.isNaN(now)) return "No changes in the window read.";
  const days = Math.round((now - since) / 86_400_000);
  return days >= 365 ? "No changes yet." : `No changes in the last ${days} days.`;
}

function ChangeRow({ change, onAcknowledge }: { change: ClinicChangeView; onAcknowledge: (changeId: string) => Promise<OpsResult<AcknowledgeClinicChangeOutcome>> }) {
  // A change with no audit status is one made while audits are off, which the card says once above.
  const audit = change.auditStatus ? AUDIT_STATUS_WORDS[change.auditStatus] : null;
  return (
    <li className="border-line flex flex-wrap items-start gap-x-3 gap-y-1 border-t py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{changeWords(change)}</p>
        <p className="text-muted">
          {when(change.changedAt)} · by {ACTOR_WORDS[change.actorKind]}
          {change.acknowledgedAt ? ` · seen ${when(change.acknowledgedAt)}${change.acknowledgedBy ? ` by ${change.acknowledgedBy}` : ""}` : ""}
        </p>
      </div>
      {audit ? <Chip tone={audit.tone}>{audit.words}</Chip> : null}
      {change.acknowledgedAt ? null : (
        <ActionButton
          label="Mark as seen"
          run={() => onAcknowledge(change.id)}
          done={(data) => (data.status === "already" ? "Already seen." : data.status === "not_found" ? "That change was not found." : "Seen.")}
        />
      )}
    </li>
  );
}

export function AvailabilityChanges({
  clinicId,
  changes,
  audits,
  now,
  onRunAudit,
  onAcknowledge,
}: {
  clinicId: string;
  changes: OpsResult<{ since: string; changes: ClinicChangeView[] }>;
  audits: OpsResult<ClinicAuditsView>;
  /** The server's clock, ISO, for the empty state's window. */
  now: string;
  onRunAudit: () => Promise<OpsResult<RunClinicAuditOutcome>>;
  onAcknowledge: (changeId: string) => Promise<OpsResult<AcknowledgeClinicChangeOutcome>>;
}) {
  const summary = audits.ok ? (audits.data.clinics.find((c) => c.clinicId === clinicId.toLowerCase()) ?? null) : null;
  const running = summary?.overall === "running";
  const shown = changes.ok ? changes.data.changes.slice(0, CHANGES_SHOWN) : [];
  const older = changes.ok ? changes.data.changes.length - shown.length : 0;
  return (
    <Section id="availability" title="Availability changes">
      {audits.ok ? <Packs summary={summary} /> : <Failure failure={audits} what="the audits" />}
      <div className="mt-3">
        <ActionButton label="Run audit now" run={onRunAudit} done={runSaid} disabled={running} />
      </div>

      {!changes.ok ? (
        <Failure failure={changes} what="the changes" />
      ) : changes.data.changes.length === 0 ? (
        <Empty>{noChangesWords(changes.data.since, now)}</Empty>
      ) : (
        <>
          <ul className="mt-4">
            {shown.map((change) => (
              <ChangeRow key={change.id} change={change} onAcknowledge={onAcknowledge} />
            ))}
          </ul>
          {older > 0 ? (
            <p className="text-muted mt-2 text-xs">
              {older} older {older === 1 ? "change" : "changes"} since {changes.data.since.slice(0, 10)} not shown.
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}
