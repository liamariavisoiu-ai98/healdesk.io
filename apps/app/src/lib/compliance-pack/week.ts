import { startOfLocalDay } from "@/lib/clinic/setup-window";
import { addLocalDays, localClock, mondayOf } from "@/lib/scheduler/summary-clock";

/**
 * The compliance pack's week (ops automation lane P6h; design E6 item 18):
 * Monday 00:00 to the next Monday 00:00 on New York's wall clock, and the
 * pack is due at 07:00 New York on that next Monday. Intl, never a fixed
 * offset: a week that holds a clock change is 167 or 169 hours long, and
 * 07:00 New York is 11:00 UTC in summer and 12:00 UTC in winter. The hourly
 * tick runs at every UTC hour, so the job asks this file, not the tick's
 * hour, whether a week has come due. Pure.
 */

export const PACK_TIME_ZONE = "America/New_York";

/** The local hour on Monday from which last week's pack is due. */
export const PACK_HOUR = 7;

const HOUR_MS = 3_600_000;

/** A YYYY-MM-DD that is a real calendar day and a Monday. */
export function isWeekStart(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.toISOString().slice(0, 10) === value && at.getUTCDay() === 1;
}

export type PackWeek = {
  /** The Monday the week starts on (New York). */
  start: string;
  /** The Sunday it ends on (New York). */
  lastDay: string;
  /** The first instant of the week. */
  from: Date;
  /** The first instant after it: the next Monday's midnight in New York. */
  to: Date;
  /** When the job stores the pack: 07:00 New York on the next Monday. */
  dueAt: Date;
};

export function packWeek(start: string): PackWeek {
  if (!isWeekStart(start)) throw new RangeError("A pack's week starts on a Monday, as YYYY-MM-DD.");
  const next = addLocalDays(start, 7);
  const to = startOfLocalDay(next, PACK_TIME_ZONE);
  // No clock change in New York falls between Monday 00:00 and 07:00 (they
  // happen at 02:00 on a Sunday), so the hour is seven hours after midnight.
  return {
    start,
    lastDay: addLocalDays(start, 6),
    from: startOfLocalDay(start, PACK_TIME_ZONE),
    to,
    dueAt: new Date(to.getTime() + PACK_HOUR * HOUR_MS),
  };
}

/** The newest week whose pack is due at `now`. */
export function dueWeekStart(now: Date): string {
  const thisMonday = mondayOf(localClock(now, PACK_TIME_ZONE).date);
  const lastMonday = addLocalDays(thisMonday, -7);
  return now.getTime() >= packWeek(lastMonday).dueAt.getTime() ? lastMonday : addLocalDays(lastMonday, -7);
}

/** Whether a week has ended by `now`: a pack can be made for it. */
export function weekHasEnded(start: string, now: Date): boolean {
  return now.getTime() >= packWeek(start).to.getTime();
}
