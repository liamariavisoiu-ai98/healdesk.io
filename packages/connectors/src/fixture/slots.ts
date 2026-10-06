import { partsIn, zonedToUtc } from "../time";
import type { CanonicalSlot, TimeWindow } from "../types";

/**
 * Weekday office hours in a named zone, without a date library.
 *
 * The fixture has to hand back slots "in the given zone" so the app's slot
 * picker is exercised against wall-clock times that survive a DST change —
 * a slot generated as UTC-plus-a-constant looks right in June and is an hour
 * out in November. The wall-clock arithmetic lives in ../time.ts, which the
 * v1 availability code shares.
 */

export type SlotSchedule = {
  timeZone: string;
  /** Length of each slot. */
  slotMinutes: number;
  /** Gap between slot starts. Defaults to the slot length. */
  stepMinutes?: number;
  /** Local hour the day opens, inclusive. */
  opensAt?: number;
  /** Local hour the last slot must end by. */
  closesAt?: number;
};

/** Monday to Friday slots inside the half-open window, sorted. */
export function weekdaySlots(window: TimeWindow, schedule: SlotSchedule): CanonicalSlot[] {
  const { timeZone, slotMinutes } = schedule;
  const step = schedule.stepMinutes ?? slotMinutes;
  const opens = (schedule.opensAt ?? 9) * 60;
  const closes = (schedule.closesAt ?? 16) * 60;

  const first = partsIn(window.from, timeZone);
  let { year, month, day } = first;
  const slots: CanonicalSlot[] = [];

  // Bounded so a reversed window cannot spin forever.
  for (let guard = 0; guard < 400; guard += 1) {
    if (zonedToUtc(year, month, day, 0, 0, timeZone) >= window.to) break;

    // Noon, not midnight: midnight may not exist on a DST-change day.
    const weekday = partsIn(zonedToUtc(year, month, day, 12, 0, timeZone), timeZone).weekday;
    if (weekday >= 1 && weekday <= 5) {
      for (let minutes = opens; minutes + slotMinutes <= closes; minutes += step) {
        const startsAt = zonedToUtc(
          year,
          month,
          day,
          Math.floor(minutes / 60),
          minutes % 60,
          timeZone,
        );
        if (startsAt < window.from || startsAt >= window.to) continue;
        slots.push({ startsAt, endsAt: new Date(startsAt.getTime() + slotMinutes * 60_000) });
      }
    }

    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  return slots;
}
