/**
 * Wall-clock arithmetic in a named zone, without a date library.
 *
 * Moved here from the fixture's slot generator because the v1 availability
 * code needs the same two operations against a clinic's real opening hours:
 * the zone's wall clock for an instant, and the instant at which the zone's
 * wall clock reads a given date and time. A slot computed as UTC-plus-a-
 * constant looks right in June and is an hour out in November. Intl gives us
 * the zone's wall clock for an instant; the inverse is `zonedToUtc`, which
 * also has to decide what a wall time the zone skips or repeats means.
 */

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday, as in `Date.prototype.getDay`. */
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for a zone Intl does not know, which is what we want:
    // code that silently treats "Europe/Nowhere" as UTC offers times an hour
    // or more away from the ones the clinic keeps.
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
export function partsIn(instant: Date, timeZone: string): ZonedParts {
  const parts: Partial<ZonedParts> = {};
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
  return parts as ZonedParts;
}

/** The zone's offset from UTC at an instant, in milliseconds (New York in winter: -5 h). */
function offsetMs(instant: number, timeZone: string): number {
  const p = partsIn(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
}

/**
 * The instant at which the zone's wall clock reads the given date and time.
 *
 * Twice a year a wall time is ambiguous, and the answer is fixed rather than
 * left to whichever guess lands first (the rule Temporal calls "compatible"):
 *
 *   - **A time the zone repeats** (clocks go back; 01:30 happens twice in New
 *     York on the first Sunday of November) is the earlier of the two
 *     instants, the one still on the old offset.
 *   - **A time the zone skips** (clocks go forward; there is no 02:30 in New
 *     York on the second Sunday of March) moves forward by the length of the
 *     gap: 02:30 is read as 03:30, the instant the clock passes 02:30.
 *
 * Both follow from trying the offset a day before and the offset a day after.
 * Whichever reads the requested wall time back is right, the earlier offset
 * first; when neither does, the time was skipped, and the earlier offset is
 * the one that lands after the gap. The direction matters for opening hours:
 * a range that closes at 02:00 on the night the clocks go forward closes when
 * the clock passes 02:00, not an hour early, and an opening inside the gap is
 * never offered before the clinic's clock has reached it.
 *
 * Hours and minutes past their range carry over, as Date.UTC carries them, so
 * 24:00 is midnight at the end of the day.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const reads = (instant: number) => instant + offsetMs(instant, timeZone) === wall;

  const before = wall - offsetMs(wall - DAY_MS, timeZone);
  if (reads(before)) return new Date(before);
  const after = wall - offsetMs(wall + DAY_MS, timeZone);
  if (reads(after)) return new Date(after);
  return new Date(before);
}
