"use client";

import { ActionButton, Failure, Section } from "@/components/admin/ui";
import { CALENDAR_WRITE_REASON_WORDS, MAX_WRITE_TRIES, nextTryWords, slotWords, writeProblemWords } from "@/components/admin/queue-words";
import type { OpsResult, RetryCalendarWriteOutcome, StuckCalendarWrites, StuckCalendarWriteView } from "@/lib/admin/ops-client";

/**
 * The Setup tab's "Calendar writes" section (ops automation Phase 5, lane
 * P5b; design E3 §2.3): this clinic's desk bookings whose Google Calendar
 * write has not settled, from the cross-clinic read (listStuckCalendarWrites)
 * filtered to the clinic. Each in words: the state, the reason, the tries so
 * far of five, when the sweep tries next or that it will not, and the slot as
 * whole days ahead (never a time, never the person or the service). The
 * System page's "Calendar writes stuck" rows and the calendar alerts link
 * here (`#calendar-writes`).
 *
 * "Retry" is the same operation the Calendar card's own Retry runs
 * (retryCalendarWrite): apps/app refuses it for a booking staff have
 * cancelled or marked, and this says what it answered. The reason words
 * carry the one warning an operator needs before pressing it: an event id
 * already taken means our event is in the calendar at another time, and
 * the clinic's staff move it by hand.
 *
 * The read is capped at 100 across every clinic, so a truncated read may
 * be missing this clinic's rows, and a clinic apps/app could not read is
 * counted, never drawn as none; both are said here rather than left as a
 * quiet list.
 */

const OUTCOME_WORDS: Record<Extract<RetryCalendarWriteOutcome, { status: "retried" }>["outcome"], string> = {
  written: "Written to the calendar.",
  failed: "Failed again: the reason on the row is refreshed.",
  unknown: "No answer settled it: the sweep reads it back on its next turn.",
  "not-connected": "No Google Calendar is connected, so nothing was written.",
};

export function writeLine(write: StuckCalendarWriteView, nowIso: string): string {
  const problem = writeProblemWords(write);
  return `${problem.charAt(0).toUpperCase()}${problem.slice(1)}: ${CALENDAR_WRITE_REASON_WORDS[write.reason]}. Tries ${write.attempts} of ${MAX_WRITE_TRIES}; ${nextTryWords(write, nowIso)}. Slot ${slotWords(write.slotInDays)}.`;
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
  return (
    <Section id="calendar-writes" title="Calendar writes">
      {!writes.ok ? <Failure failure={writes} what="the stuck calendar writes" /> : null}
      {writes.ok && mine.length === 0 ? <p className="text-sm">No stuck writes.</p> : null}
      {mine.length > 0 ? (
        <ul className="divide-line divide-y text-sm">
          {mine.map((w) => (
            <li key={w.appointmentId} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="grid gap-0.5">
                <span>{writeLine(w, now)}</span>
                <code className="text-muted font-mono text-xs select-all">{w.appointmentId}</code>
              </div>
              <ActionButton label="Retry" run={() => onRetry(w.appointmentId)} done={(d) => (d.status === "retried" ? OUTCOME_WORDS[d.outcome] : null)} />
            </li>
          ))}
        </ul>
      ) : null}
      {writes.ok && writes.data.truncated ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          Only the {writes.data.writes.length} newest stuck writes across every clinic were read, of {writes.data.count}: this clinic may have more than shown.
        </p>
      ) : null}
      {writes.ok && writes.data.unreadClinics > 0 ? (
        <p role="status" className="text-red-deep mt-3 text-sm font-semibold">
          {writes.data.unreadClinics} clinic(s) could not be read; this one may be among them.
        </p>
      ) : null}
    </Section>
  );
}
