/**
 * Reporting periods, in the clinic's timezone.
 *
 * A month boundary is not a UTC boundary. "August" for a clinic in Phoenix
 * starts at 07:00 UTC on 1 August; for one in New York it starts at 04:00 UTC,
 * and that shifts by an hour across a DST change. Getting this wrong moves
 * calls between reports — a clinic sees a late-evening booking on the 31st
 * counted in the following month, and the numbers stop matching their own
 * point-of-sale.
 *
 * Implemented with `Intl` rather than a date library: the offset lookup is the
 * only hard part, and it is about fifteen lines.
 */

export type Period = {
  /** Inclusive. */
  start: Date;
  /** Exclusive — half-open, so consecutive periods never double-count. */
  end: Date;
  /** e.g. "2026-08". Stable across timezones, used as an identifier. */
  key: string;
  /** e.g. "August 2026". For display. */
  label: string;
  timezone: string;
};

/**
 * Offset of `timezone` from UTC, in milliseconds, at a given instant.
 *
 * Positive east of UTC. Derived by formatting the instant in the target zone
 * and reading the wall-clock back — the only reliable way to get a historical
 * or DST-aware offset from the platform.
 */
function offsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Intl renders midnight as hour 24 in some engines; normalise it.
  const hour = read("hour") % 24;

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );

  return asUtc - instant.getTime();
}

/**
 * The UTC instant corresponding to a wall-clock time in `timezone`.
 *
 * Two passes: guess using the offset at the naive instant, then re-check the
 * offset at the guess. The second pass matters near a DST transition, where the
 * offset at the naive instant differs from the offset at the real one.
 */
function zonedToUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstGuess = new Date(naive - offsetMs(new Date(naive), timezone));
  const refined = new Date(naive - offsetMs(firstGuess, timezone));
  return refined;
}

/** The calendar month containing `instant`, in the clinic's timezone. */
export function monthContaining(instant: Date, timezone: string): Period {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(instant);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);

  return month_(year, month, timezone);
}

/** The calendar month immediately before the one containing `instant`. */
export function previousMonth(instant: Date, timezone: string): Period {
  const current = monthContaining(instant, timezone);
  // One millisecond before the start lands inside the previous month, whatever
  // its length and whatever the offset did in between.
  return monthContaining(new Date(current.start.getTime() - 1), timezone);
}

export function month_(
  year: number,
  month: number,
  timezone: string,
): Period {
  const start = zonedToUtc(year, month, 1, timezone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = zonedToUtc(nextYear, nextMonth, 1, timezone);

  return {
    start,
    end,
    key: `${year}-${String(month).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "long",
      year: "numeric",
    }).format(start),
    timezone,
  };
}

/** Whole days in the period. Used to annualise, and to detect partial months. */
export function periodDays(period: Period): number {
  return Math.round(
    (period.end.getTime() - period.start.getTime()) / 86_400_000,
  );
}
