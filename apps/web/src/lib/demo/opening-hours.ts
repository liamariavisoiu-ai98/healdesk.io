/**
 * How many hours a week a clinic answers now, from the opening hours its
 * website lists: the baseline for the demo's "reachable now vs with AYA".
 *
 * The extraction copies hours as the site writes them ("Mon–Fri", "9am–6pm",
 * "Sat: 10:00 AM - 4:00 PM", "Closed"), so this parses the common shapes and
 * gives up on anything else. Giving up is deliberate: one row it cannot read
 * would make the total wrong, so the whole answer falls back to a stated
 * assumption (9 to 5, Monday to Friday) and the page says it is an
 * assumption. A number that looks measured but is not would be the claim
 * this page must never make.
 */

import { parseDays, parseSpan, parseSpans } from "@healdesk/catalog";

export const HOURS_IN_A_WEEK = 168;

/** Nine to five, Monday to Friday: what the page assumes, and says it assumes, when the site lists nothing usable. */
export const ASSUMED_WEEKLY_HOURS = 40;

/** `listed` is true when the hours came from the clinic's own listing (Google or its website), false for the assumption. */
export type WeeklyHours = { hours: number; listed: boolean };

// The parsers are shared with the demo call (@healdesk/catalog opening-hours.ts).
export { parseDays, parseSpan, parseSpans };

/** Monday first. Each day's open spans in minutes; [] is closed. */
export type WeekSchedule = { days: [number, number][][]; listed: boolean };

const ASSUMED_DAY: [number, number][] = [[9 * 60, 17 * 60]];

/**
 * The week as spans per day, for the demo's calendar: the clinic's listed
 * hours, or the stated 9-to-5 weekday assumption when they are missing or
 * any row cannot be read, under the same rule as the weekly total.
 */
export function weekSchedule(rows: { days: string; hours: string }[]): WeekSchedule {
  const assumed: WeekSchedule = { days: [0, 1, 2, 3, 4, 5, 6].map((d) => (d < 5 ? ASSUMED_DAY : [])), listed: false };
  if (rows.length === 0) return assumed;
  const days: [number, number][][] = [[], [], [], [], [], [], []];
  let any = false;
  for (const row of rows) {
    const set = parseDays(row.days);
    const spans = parseSpans(row.hours);
    if (!set || spans === null) return assumed;
    for (const day of set) days[day] = spans;
    any = any || spans.length > 0;
  }
  return any ? { days, listed: true } : assumed;
}

/**
 * The clinic's open hours a week, from its listed hours, or the stated
 * assumption when there are none or any row cannot be read. A day listed in
 * two rows counts once, from the later row, as a site's own correction would.
 */
export function weeklyOpenHours(rows: { days: string; hours: string }[]): WeeklyHours {
  if (rows.length === 0) return { hours: ASSUMED_WEEKLY_HOURS, listed: false };
  const perDay = new Map<number, number>();
  for (const row of rows) {
    const days = parseDays(row.days);
    const span = parseSpan(row.hours);
    if (!days || span === null) return { hours: ASSUMED_WEEKLY_HOURS, listed: false };
    for (const day of days) perDay.set(day, span);
  }
  const hours = Math.round([...perDay.values()].reduce((a, b) => a + b, 0) * 10) / 10;
  return hours > 0 && hours <= HOURS_IN_A_WEEK ? { hours, listed: true } : { hours: ASSUMED_WEEKLY_HOURS, listed: false };
}
