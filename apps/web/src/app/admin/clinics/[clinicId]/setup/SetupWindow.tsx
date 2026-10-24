"use client";

import { useState } from "react";

import { ActionButton, Chip, Section } from "@/components/admin/ui";
import type { ExtendDeadlineOutcome, LifecycleRow, LifecycleWriteOutcome, OpsResult } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The Setup tab's "Setup window" card (ops automation wave 2, lane A3), for
 * a clinic the lifecycle watch covers: its stage in words, the days and
 * steps left, the last progress, the decision so far, the snooze, and the
 * recommendation the watch computed, shown as it came (never recomputed
 * here). The lifecycle alerts link here (`#setup-window`) and quote the four
 * controls: "Extend the setup window" (1 to 30 days, the recommended number
 * as the default; apps/app refuses once the deadline has moved, so a replay
 * cannot add the days twice), "Offered a call", "Let it close" (asks once,
 * with the sentence the alert quotes) and "Snooze alerts" (3, 7 or 14 days;
 * never the clinic's own reminders, D6).
 *
 * Only a watched clinic has a row; the page draws nothing for the others.
 */

export const LET_CLOSE_CONFIRM = "The clinic's setup window will close on its last day; ops alerts about it stop.";

const STAGE_WORDS: Record<LifecycleRow["stage"], string> = {
  not_started: "not started",
  in_setup: "in setup",
  waiting_on_us: "waiting on us",
  partly_live: "partly live",
  live: "live",
  closed: "closed",
};

const DECISION_WORDS: Record<LifecycleRow["decision"], string> = {
  none: "none yet",
  extension_offered: "a call was offered",
  let_close: "let it close",
  extended: "extended",
};

const ACTION_WORDS: Record<LifecycleRow["recommendation"]["action"], string> = {
  extend: "extend",
  offer_call: "offer a call",
  let_close: "let it close",
  wait: "wait",
  phone_the_clinic: "phone the clinic",
};

export const SNOOZE_DAYS = [3, 7, 14] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

function day(iso: string): string {
  return iso.slice(0, 10);
}

function daysTone(remaining: number | null): Tone {
  if (remaining === null) return "muted";
  if (remaining <= 3) return "bad";
  if (remaining <= 8) return "warn";
  return "info";
}

/** `LifecycleWriteOutcome` as the one button pattern reads it: a status word. */
function asStatus(result: OpsResult<LifecycleWriteOutcome>): OpsResult<{ status: string; message?: string }> {
  if (!result.ok) return result;
  return result.data.outcome === "saved"
    ? { ok: true, data: { status: "saved" } }
    : { ok: true, data: { status: "refused", message: "This clinic is not watched, so nothing was recorded." } };
}

export function SetupWindow({
  row,
  onExtend,
  onDecide,
  onSnooze,
}: {
  row: LifecycleRow;
  onExtend: (days: number) => Promise<OpsResult<ExtendDeadlineOutcome>>;
  onDecide: (decision: "extension_offered" | "let_close") => Promise<OpsResult<LifecycleWriteOutcome>>;
  onSnooze: (days: SnoozeDays) => Promise<OpsResult<LifecycleWriteOutcome>>;
}) {
  const advice = row.recommendation;
  const [days, setDays] = useState(String(advice.days ?? 7));
  const [snooze, setSnooze] = useState<SnoozeDays>(7);
  const canExtend = row.deadlineAt !== null && row.stage !== "live" && row.stage !== "closed";

  return (
    <Section id="setup-window" title="Setup window">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Chip tone={row.stage === "live" ? "ok" : row.stage === "closed" ? "muted" : "info"}>{STAGE_WORDS[row.stage]}</Chip>
        <span className="text-muted">since {day(row.stageSince)}</span>
        {row.remainingDays !== null ? (
          <Chip tone={daysTone(row.remainingDays)}>
            {row.remainingDays} {row.remainingDays === 1 ? "day" : "days"} left
          </Chip>
        ) : null}
        {row.deadlineAt ? <span className="text-muted">window ends {day(row.deadlineAt)}</span> : null}
      </p>
      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted">Steps left</dt>
        <dd>
          {row.stepsLeft}
          {row.channelsWaiting > 0 ? ` · ${row.channelsWaiting} ${row.channelsWaiting === 1 ? "channel" : "channels"} waiting on the clinic` : ""}
        </dd>
        <dt className="text-muted">Last progress</dt>
        <dd>{row.lastProgressAt ? day(row.lastProgressAt) : "none recorded"}</dd>
        <dt className="text-muted">Decision so far</dt>
        <dd>
          {DECISION_WORDS[row.decision]}
          {row.decidedAt ? ` (${day(row.decidedAt)}${row.decidedBy ? `, ${row.decidedBy}` : ""})` : ""}
        </dd>
        <dt className="text-muted">Ops alerts</dt>
        <dd>{row.snoozedUntil ? `snoozed until ${day(row.snoozedUntil)}${row.snoozedBy ? ` by ${row.snoozedBy}` : ""}` : "on"}</dd>
        {row.undeliveredCount > 0 ? (
          <>
            <dt className="text-muted">Reminders</dt>
            <dd>
              {row.undeliveredCount} undelivered: see{" "}
              <a href={`/admin/clinics/${row.clinicId}/deliveries#reminders`} className="underline">
                Deliveries › Reminders
              </a>
            </dd>
          </>
        ) : null}
      </dl>

      <p className="border-line mt-3 border-t pt-3 text-sm">
        <span className="font-semibold">Recommended: {ACTION_WORDS[advice.action]}{advice.action === "extend" && advice.days !== null ? ` ${advice.days} days` : ""}.</span>{" "}
        <span className="text-muted">{advice.reason}</span>
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">Days (1–30)</span>
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              aria-label="Days to extend by"
              className="border-line mt-1 w-24 rounded-sm border px-3 py-2"
            />
          </label>
          <ActionButton
            label="Extend the setup window"
            variant="primary"
            disabled={!canExtend}
            run={() => onExtend(Number(days))}
            done={(data) => (data.status === "extended" ? `Extended to ${data.setupDeadlineAt}.` : null)}
          />
        </form>
        <ActionButton label="Offered a call" run={async () => asStatus(await onDecide("extension_offered"))} done={() => "Recorded: a call was offered."} />
        <ActionButton
          label="Let it close"
          variant="destructive"
          confirm={LET_CLOSE_CONFIRM}
          run={async () => asStatus(await onDecide("let_close"))}
          done={() => "Recorded: the window closes on its last day."}
        />
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="text-muted block text-xs font-bold uppercase">For</span>
            <select
              value={snooze}
              onChange={(event) => setSnooze(Number(event.target.value) as SnoozeDays)}
              aria-label="Snooze for"
              className="border-line mt-1 rounded-sm border bg-white px-3 py-2"
            >
              {SNOOZE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <ActionButton label="Snooze alerts" run={async () => asStatus(await onSnooze(snooze))} done={() => `Snoozed for ${snooze} days.`} />
        </div>
      </div>
    </Section>
  );
}
