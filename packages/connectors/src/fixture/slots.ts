import type { CanonicalSlot, TimeWindow } from "../types";

/**
 * Weekday office hours in a named zone, without a date library.
 *
 * The fixture has to hand back slots "in the given zone" so the app's slot
 * picker is exercised against wall-clock times that survive a DST change —
 * a slot generated as UTC-plus-a-constant looks right in June and is an hour
 * out in November. Intl gives us the zone's wall clock for an instant; the
 * inverse (wall clock to instant) is the two-pass guess below.
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

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for a zone Intl does not know, which is what we want:
    // a fixture that silently treats "Europe/Nowhere" as UTC teaches nothing.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's wall clock for an instant. */
export function partsIn(instant: Date, timeZone: string): Parts {
  const parts: Partial<Parts> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    switch (part.type) {
      case "year":
        parts.year = Number(part.value);
        break;
      case "month":
        parts.month = Number(part.value);
        break;
      case "day":
        parts.day = Number(part.value);
        break;
      case "hour":
        parts.hour = Number(part.value);
        break;
      case "minute":
        parts.minute = Number(part.value);
        break;
      case "second":
        parts.second = Number(part.value);
        break;
      case "weekday":
        parts.weekday = WEEKDAYS.indexOf(part.value);
        break;
      default:
        break;
    }
  }
  return parts as Parts;
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/** The instant at which the zone's wall clock reads the given date and time. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(wall), timeZone);
  let instant = wall - first;
  // Around a DST change the offset at the guess differs from the offset at
  // the answer; one correction settles it.
  const second = offsetMs(new Date(instant), timeZone);
  if (second !== first) instant = wall - second;
  return new Date(instant);
}

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
