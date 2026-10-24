"use client";

import { ActionButton, Failure, Section } from "@/components/admin/ui";
import {
  CALENDAR_WRITE_REASON_WORDS,
  MAX_WRITE_TRIES,
  nextTryWords,
  slotWords,
  SWEEP_OFF_WORDS,
  triesWords,
  writeProblemWords,
} from "@/components/admin/queue-words";
import type { OpsResult, RetryCalendarWriteOutcome, StuckCalendarWrites, StuckCalendarWriteView } from "@/lib/admin/ops-client";

/**
 * The Setup tab's "Calendar writes" section (ops automation Phase 5, lane
 * P5b; design E3 §2.3): this clinic's desk bookings whose Google Calendar
 * write has not settled, from listStuckCalendarWrites read for this clinic
 * alone. Each in words: the state, the reason, the tries so
 * far (of the sweep's five while within them; an operator's retries go past
 * them), when the sweep tries next for a write it still owns, and the slot as
 * whole days ahead (never a time, never the person or the service). The
 * System page's "Calendar writes stuck" rows and the calendar alerts link
 * here (`#calendar-writes`).
 *
 * "Retry" is the same operation the Calendar card's own Retry runs
 * (retryCalendarWrite): apps/app refuses it for a booking staff have
 * cancelled or marked, and this says what it answered. A retry that ends
 * `failed` is drawn as a failure, not as done; one that ends `unknown` says
 * whether the sweep will read it back (it will not once the five are spent).
 * The reason words carry the one warning an operator needs before pressing
 * it: an event id already taken means our event is in the calendar at
 * another time, and the clinic's staff move it by hand.
 *
 * The read is capped at 100 across every clinic, so a truncated read may be
 * missing this clinic's rows, and a clinic apps/app could not read is counted,
 * never drawn as none; neither case is allowed to read "No stuck writes."
 */

type Said = { status: string; message?: string };

/** The retry's answer as the one button pattern reads it, with the words true to the tries the row will then have. */
export function retryWords(result: OpsResult<RetryCalendarWriteOutcome>, attemptsBefore: number): OpsResult<Said> {
  if (!result.ok) return result;
  const r = result.data;
  if (r.status === "refused") return { ok: true, data: { status: "refused", message: r.message } };
  switch (r.outcome) {
    case "written":
      return { ok: true, data: { status: "written", message: "Written to the calendar." } };
    case "failed":
      return { ok: true, data: { status: "refused", message: "Failed again. Reload to read the new reason on the row." } };
    case "not-connected":
      return { ok: true, data: { status: "refused", message: "No Google Calendar is connected, so nothing was written." } };
    case "unknown":
      return attemptsBefore + 1 >= MAX_WRITE_TRIES
        ? {
            ok: true,
            data: {
              status: "refused",
              message: `No answer settled it, and after ${attemptsBefore + 1} tries the sweep will not try again by itself. Check the clinic's calendar, or press Retry once the cause is fixed.`,
            },
          }
        : { ok: true, data: { status: "unknown", message: "No answer settled it: the sweep reads it back on its next turn." } };
  }
}

/**
 * One write in one line: state (and next try while the sweep owns it and is
 * switched on), reason, tries, slot. With the sweep off the line names no
 * next try; SWEEP_OFF_WORDS says why, once, above the list.
 */
export function writeLine(write: StuckCalendarWriteView, nowIso: string, sweepOn = true): string {
  const state = writeProblemWords(write, sweepOn);
  const waiting = write.retryable && sweepOn;
  const head = `${state.charAt(0).toUpperCase()}${state.slice(1)}${waiting ? `, ${nextTryWords(write, nowIso)}` : ""}`;
  return `${head}: ${CALENDAR_WRITE_REASON_WORDS[write.reason]}. ${triesWords(write.attempts)}. Slot ${slotWords(write.slotInDays)}.`;
}

/** The one line for a clinic with no row in the list, true to how much of the list was read. */
export function emptyWords(writes: StuckCalendarWrites): string {
  if (writes.truncated) return `None of the first ${writes.writes.length} are this clinic's; the list was cut off at that, of ${writes.count} found, so this clinic may still have some.`;
  if (writes.unreadClinics > 0) return `None read are this clinic's, but ${writes.unreadClinics} clinic(s) could not be read; this one may be among them.`;
  return "No stuck writes.";
}

export function CalendarWrites({
  clinicId,
  writes,
  now,
  onRetry,
}: {
  clinicId: string;
  writes: OpsResult<StuckCalendarWrites>;
  /** The server's clock, ISO, so "in about 30 minutes" is the same on both renders. */
  now: string;
  onRetry: (appointmentId: string) => Promise<OpsResult<RetryCalendarWriteOutcome>>;
}) {
  const id = clinicId.toLowerCase();
  const mine = writes.ok ? writes.data.writes.filter((w) => w.clinicId === id) : [];
  const cutOff = writes.ok && (writes.data.truncated || writes.data.unreadClinics > 0);
  return (
    <Section id="calendar-writes" title="Calendar writes">
      {!writes.ok ? <Failure failure={writes} what="the stuck calendar writes" /> : null}
      {writes.ok && mine.length === 0 ? (
        <p role={cutOff ? "status" : undefined} className={cutOff ? "text-red-deep text-sm font-semibold" : "text-sm"}>
          {emptyWords(writes.data)}
        </p>
      ) : null}
      {writes.ok && mine.length > 0 && !writes.data.sweepOn ? (
        <p role="status" className="mb-2 text-sm font-semibold">
          {SWEEP_OFF_WORDS}
        </p>
      ) : null}
      {mine.length > 0 ? (
        <ul className="divide-line divide-y text-sm">
          {mine.map((w) => (
            <li key={w.appointmentId} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="grid gap-0.5">
                <span>{writeLine(w, now, writes.ok ? writes.data.sweepOn : true)}</span>
                <code className="text-muted font-mono text-xs select-all">{w.appointmentId}</code>
              </div>
              <ActionButton label="Retry" run={async () => retryWords(await onRetry(w.appointmentId), w.attempts)} done={(d) => d.message ?? null} />
            </li>
          ))}
        </ul>
      ) : null}
      {writes.ok && mine.length > 0 && writes.data.truncated ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          Only the first {writes.data.writes.length} stuck writes across every clinic were read, of {writes.data.count}: this clinic may have more than shown.
        </p>
      ) : null}
      {writes.ok && mine.length > 0 && writes.data.unreadClinics > 0 ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {writes.data.unreadClinics} clinic(s) could not be read; this one may be among them.
        </p>
      ) : null}
    </Section>
  );
}
