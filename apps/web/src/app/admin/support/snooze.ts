/**
 * When a snoozed case comes back (ops automation lane P7d; the operation is
 * apps/app lib/ops/support-case-ops.ts opSnoozeSupportCase, which takes an
 * instant in the next 30 days). The console offers three choices, each a
 * morning in New York, where the reply-by day is counted (lib/reply-by.ts):
 *
 *   tomorrow     09:00 New York, the next day;
 *   three_days   09:00 New York, three days on;
 *   day          09:00 New York on a day the operator picks, from tomorrow to
 *                29 days on, so 09:00 on the last day still falls inside
 *                apps/app's 30-day window whatever the hour now.
 *
 * Pure, with the clock passed in, so the tests pin fixed dates across the
 * November change from daylight saving time.
 */

export const SNOOZE_ZONE = "America/New_York";
export const SNOOZE_HOUR = 9;
export const SNOOZE_MAX_DAYS_AHEAD = 29;

export type SnoozeChoice = { kind: "tomorrow" } | { kind: "three_days" } | { kind: "day"; day: string };

export const SNOOZE_CHOICE_WORDS: Record<SnoozeChoice["kind"], string> = {
  tomorrow: "Tomorrow, 09:00 New York",
  three_days: "In three days, 09:00 New York",
  day: "A day I pick, 09:00 New York",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parts(instant: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: SNOOZE_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(formatted.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Minutes New York is ahead of UTC at this instant (negative: it is behind). */
function offsetMinutes(instant: Date): number {
  const p = parts(instant);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((local - instant.getTime()) / 60_000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today's date in New York, as YYYY-MM-DD. */
export function newYorkDay(now: Date): string {
  const p = parts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** A YYYY-MM-DD moved by whole days, on the calendar (no zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + n, 12));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** 09:00 New York on a day, as an instant: the zone's offset read at that very time, so the autumn and spring changes land right. */
export function nineNewYork(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(y, m - 1, d, SNOOZE_HOUR, 0);
  let utc = asIfUtc - offsetMinutes(new Date(asIfUtc)) * 60_000;
  // A second pass for an instant that fell on the far side of a change.
  utc = asIfUtc - offsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

export type SnoozeUntil = { ok: true; until: string; day: string } | { ok: false; message: string };

/** The instant a choice names, or why it cannot be snoozed to. */
export function snoozeUntil(choice: SnoozeChoice, now: Date): SnoozeUntil {
  const today = newYorkDay(now);
  let day: string;
  switch (choice.kind) {
    case "tomorrow":
      day = addDays(today, 1);
      break;
    case "three_days":
      day = addDays(today, 3);
      break;
    case "day": {
      if (!DAY.test(choice.day) || addDays(choice.day, 0) !== choice.day) return { ok: false, message: "Pick a day." };
      if (choice.day <= today) return { ok: false, message: "Pick a day after today (New York)." };
      if (choice.day > addDays(today, SNOOZE_MAX_DAYS_AHEAD)) {
        return { ok: false, message: `Pick a day up to ${SNOOZE_MAX_DAYS_AHEAD} days ahead.` };
      }
      day = choice.day;
      break;
    }
  }
  return { ok: true, until: nineNewYork(day).toISOString(), day };
}

/** The day field's bounds, for the date input. */
export function dayBounds(now: Date): { min: string; max: string } {
  const today = newYorkDay(now);
  return { min: addDays(today, 1), max: addDays(today, SNOOZE_MAX_DAYS_AHEAD) };
}

/** A choice read back from a form or an action's argument, or null when it is not one. */
export function readSnoozeChoice(value: unknown): SnoozeChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, day } = value as Record<string, unknown>;
  if (kind === "tomorrow" || kind === "three_days") return { kind };
  if (kind === "day" && typeof day === "string" && DAY.test(day)) return { kind, day };
  return null;
}
