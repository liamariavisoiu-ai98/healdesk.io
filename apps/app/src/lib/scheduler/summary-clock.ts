import type { DayKey, OpeningHours } from "@/lib/clinic/opening-hours";
import { startOfLocalDay } from "@/lib/clinic/setup-window";

/**
 * The clinic's own clock, for the daily summary and the weekly recap: which
 * day it is there, whether the day's opening has come, and last week as the
 * clinic's calendar has it. Intl, never a fixed offset, for the reason
 * lib/clinic/opening-hours.ts gives (a zone's offset moves twice a year).
 * Pure.
 */

const DAY_MS = 86_400_000;

/** The clinic's calendar date (YYYY-MM-DD), weekday and minute of the day at an instant. */
export function localClock(
  at: Date,
  timeZone: string,
): { date: string; day: DayKey; minutes: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Intl renders midnight as "24" in some environments under hour12:false.
  const hour = Number(part("hour")) % 24;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    day: part("weekday").toLowerCase().slice(0, 3) as DayKey,
    minutes: hour * 60 + Number(part("minute")),
    hour,
  };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** The latest local hour a morning email may still go: the outbox's daytime ends at 20:00. */
export const SUMMARY_LAST_HOUR = 20;

/**
 * Whether the clinic's working day has opened by `now`: the day has opening
 * hours, its first opening time has come, and it is not yet evening. The
 * summary goes then, at the first hourly run on or after the opening time;
 * a worker that was down all morning still sends it before 20:00, and never
 * at night. A day with no hours is not a working day. A closure is the
 * caller's to check (closedOn), because it needs the database.
 */
export function workingDayOpened(hours: OpeningHours, now: Date, timeZone: string): boolean {
  const clock = localClock(now, timeZone);
  const ranges = hours[clock.day] ?? [];
  if (ranges.length === 0) return false;
  const first = Math.min(...ranges.map((range) => minutesOf(range[0])));
  return clock.minutes >= first && clock.hour < SUMMARY_LAST_HOUR;
}

/**
 * The instant a local day's first opening time falls at: its local midnight
 * plus the opening's minutes (on a day the clocks change before opening, an
 * hour out, which only moves which day's summary is a clinic's first).
 * Midnight for a day with no hours.
 */
export function openedAt(hours: OpeningHours, localDate: string, timeZone: string): Date {
  const midnight = startOfLocalDay(localDate, timeZone);
  const day = localClock(new Date(midnight.getTime() + 12 * 3_600_000), timeZone).day;
  const ranges = hours[day] ?? [];
  const first = ranges.length > 0 ? Math.min(...ranges.map((range) => minutesOf(range[0]))) : 0;
  return new Date(midnight.getTime() + first * 60_000);
}

/** YYYY-MM-DD plus whole days, on the calendar rather than the clock. */
export function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Monday (ISO weeks start on Monday) of the week a local date falls in. */
export function mondayOf(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  return addLocalDays(localDate, 1 - weekday);
}

/** The ISO week a local date falls in, "2026-W38": a week's dedupe key. */
export function isoWeekOf(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The clinic's last full week, Monday to Sunday, before the week `localDate`
 * falls in: its first and last dates, and the instants it runs between,
 * [from, to), each the start of a local day.
 */
export function lastWeek(
  localDate: string,
  timeZone: string,
): { startOn: string; endOn: string; from: Date; to: Date } {
  const thisMonday = mondayOf(localDate);
  const startOn = addLocalDays(thisMonday, -7);
  return {
    startOn,
    endOn: addLocalDays(thisMonday, -1),
    from: startOfLocalDay(startOn, timeZone),
    to: startOfLocalDay(thisMonday, timeZone),
  };
}
