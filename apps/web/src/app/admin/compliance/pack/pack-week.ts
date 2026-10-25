/**
 * The compliance pack's week on this side (ops automation lane P6j), as
 * apps/app defines it (lib/compliance-pack/week.ts): Monday 00:00 to the next
 * Monday 00:00 on New York's wall clock, due at 07:00 New York on that next
 * Monday. apps/web cannot import apps/app, so the same rule is written here
 * for the list page to know which week is now due and which recent weeks
 * have no pack; apps/app still decides for itself when asked to make one.
 * Pure.
 */

export const PACK_TIME_ZONE = "America/New_York";
export const PACK_HOUR = 7;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that is a real calendar day and a Monday (week.ts isWeekStart). */
export function isWeekStart(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.toISOString().slice(0, 10) === value && at.getUTCDay() === 1;
}

export function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The Monday of the week a local date falls in. */
export function mondayOf(localDate: string): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  return addDays(localDate, 1 - weekday);
}

/** The New York wall-clock date and hour of an instant. */
export function newYorkClock(at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/** The newest week whose pack is due at `now` (week.ts dueWeekStart): last week, from 07:00 New York this Monday. */
export function dueWeekStart(now: Date): string {
  const clock = newYorkClock(now);
  const thisMonday = mondayOf(clock.date);
  const lastMonday = addDays(thisMonday, -7);
  const beforeDue = clock.date === thisMonday && clock.hour < PACK_HOUR;
  return beforeDue ? addDays(lastMonday, -7) : lastMonday;
}

/** The `count` weeks ending at the one now due, newest first. */
export function recentWeeks(now: Date, count: number): string[] {
  const due = dueWeekStart(now);
  return Array.from({ length: count }, (_, i) => addDays(due, -7 * i));
}
