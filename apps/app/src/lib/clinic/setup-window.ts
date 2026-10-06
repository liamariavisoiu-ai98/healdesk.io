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
