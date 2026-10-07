import { SETUP_WINDOW_DAYS } from "@healdesk/catalog";

import { clinicLocalDate } from "./closures";

/**
 * The end of a clinic's setup window (the owner's decision of 6 October 2026):
 * the last instant of the 30th day after purchase, on the clinic's own
 * calendar. While no channel is answering patients the clinic is reminded
 * every five days; at this instant an account with nothing live is closed,
 * and the setup fee is kept.
 *
 * A clinic's day, not a run of 24-hour periods: "you have until the end of
 * 5 November" has to mean the clinic's 5 November, including the year a
 * daylight-saving change falls inside the window.
 */
export function setupDeadline(purchasedAt: Date, timeZone: string, days: number = SETUP_WINDOW_DAYS): Date {
  const lastDay = addDays(clinicLocalDate(purchasedAt, timeZone), days);
  return new Date(startOfLocalDay(addDays(lastDay, 1), timeZone).getTime() - 1);
}

/**
 * The window's last day on the clinic's calendar (YYYY-MM-DD): the last local
 * day that has wholly ended by `deadline`. For a deadline at the end of a day
 * in `timeZone`, as setupDeadline() and moveSetupDeadline() write it, that is
 * the deadline's own date. Every email that names the day the account closes
 * reads it here, so none can name a day the account does not live to the end
 * of.
 */
export function setupLastDay(deadline: Date, timeZone: string): string {
  return addDays(clinicLocalDate(new Date(deadline.getTime() + 1), timeZone), -1);
}

/**
 * The day the window counts from: `SETUP_WINDOW_DAYS` before its last day.
 * The reminders count their days from here, so the sixth always falls on the
 * last day, whatever zone the deadline was set in and however ops has moved
 * it.
 */
export function setupWindowStart(deadline: Date, timeZone: string): string {
  return addDays(setupLastDay(deadline, timeZone), -SETUP_WINDOW_DAYS);
}

/**
 * The deadline once the clinic's time zone is corrected: the end of the same
 * last day, in the corrected zone. The day stays the one every email already
 * named (the welcome email says it at once); only the instant moves, by the
 * difference between the zones, so "by the end of that day" means the
 * clinic's own end of it.
 */
export function moveSetupDeadline(deadline: Date, fromZone: string, toZone: string): Date {
  return endOfLocalDay(setupLastDay(deadline, fromZone), toZone);
}

/** The last instant of a clinic-local calendar day. */
function endOfLocalDay(localDate: string, timeZone: string): Date {
  return new Date(startOfLocalDay(addDays(localDate, 1), timeZone).getTime() - 1);
}

/** The instant a clinic-local calendar day (YYYY-MM-DD) begins. */
export function startOfLocalDay(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  // Midnight on the wall clock, less the zone's offset at that moment. Twice,
  // because the offset at a first guess can be the other side of a change.
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** YYYY-MM-DD plus whole days, on the calendar rather than the clock. */
function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}
