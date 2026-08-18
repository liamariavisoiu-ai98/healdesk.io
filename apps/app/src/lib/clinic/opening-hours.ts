/**
 * When a clinic's own front desk is open — and therefore when it wasn't.
 *
 * This exists to answer one question at ingestion: would anyone at the clinic
 * have picked up this call? If the answer is no because they were shut, the
 * conversation carries `recovery_reason = 'after_hours'` and the monthly report
 * counts it. That is the largest category of genuinely recovered contacts, and
 * before this existed it could not be recorded at all, so every report
 * understated the product.
 *
 * ## The rule that shapes the whole file
 *
 * **Unknown is not closed.** Every function here returns `null` rather than a
 * boolean when it cannot know, and callers must treat `null` as "record no
 * recovery reason". A clinic whose hours we never collected, wrongly assumed to
 * shut at 5, would have its 6pm calls claimed as recovered while its own staff
 * were answering them — inflating the one number the clinic checks us on, in
 * the direction that destroys trust. Wrong-low is survivable; wrong-high is not.
 *
 * ## Format
 *
 * Seven keys, `sun` through `sat`, each an array of `[open, close]` pairs in
 * 24-hour `HH:MM`, local to the clinic's own timezone.
 *
 *   { "mon": [["09:00", "17:00"]], "sat": [], ... }
 *
 * An empty array means closed that day, which is a real answer and distinct
 * from the day being absent (malformed). Multiple ranges per day support the
 * lunchtime closure that is common in single-room practices:
 *
 *   { "tue": [["09:00", "12:30"], ["13:30", "18:00"]] }
 *
 * A range whose close is at or before its open is treated as crossing midnight,
 * so `[["20:00", "02:00"]]` is a late clinic, not a data error.
 */

export const DAY_KEYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

export type DayKey = (typeof DAY_KEYS)[number];

/** `[open, close]`, 24-hour HH:MM, in the clinic's own timezone. */
export type TimeRange = readonly [string, string];

export type OpeningHours = {
  readonly [K in DayKey]: readonly TimeRange[];
};

export const DAY_LABELS: Record<DayKey, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

export class OpeningHoursError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "OpeningHoursError";
  }
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight, or null if not a valid HH:MM. */
function toMinutes(value: string): number | null {
  const match = HH_MM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Validate untrusted input into OpeningHours.
 *
 * Throws rather than coercing. A partially-understood schedule is worse than no
 * schedule, because no schedule is visibly null and honestly uncounted, while a
 * half-parsed one silently produces confident wrong answers.
 */
export function parseOpeningHours(input: unknown): OpeningHours {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OpeningHoursError("Opening hours must be an object.");
  }

  const source = input as Record<string, unknown>;
  const result = {} as { [K in DayKey]: TimeRange[] };

  for (const day of DAY_KEYS) {
    const raw = source[day];
    if (raw === undefined) {
      throw new OpeningHoursError(`Missing ${DAY_LABELS[day]}.`, day);
    }
    if (!Array.isArray(raw)) {
      throw new OpeningHoursError(
        `${DAY_LABELS[day]} must be a list of time ranges (use an empty list for closed).`,
        day,
      );
    }

    const ranges: TimeRange[] = [];
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new OpeningHoursError(
          `${DAY_LABELS[day]} has a range that is not [open, close].`,
          day,
        );
      }
      const [open, close] = entry as [unknown, unknown];
      if (typeof open !== "string" || typeof close !== "string") {
        throw new OpeningHoursError(
          `${DAY_LABELS[day]} has a non-text time.`,
          day,
        );
      }
      if (toMinutes(open) === null || toMinutes(close) === null) {
        throw new OpeningHoursError(
          `${DAY_LABELS[day]} has an invalid time — use 24-hour HH:MM, like 09:00.`,
          day,
        );
      }
      ranges.push([open, close] as const);
    }

    result[day] = ranges;
  }

  return result as OpeningHours;
}

/**
 * The clinic's local day-of-week and minute-of-day at a given instant.
 *
 * Uses Intl rather than date arithmetic on purpose. The clinic's timezone is an
 * IANA name, and the offset it implies changes twice a year — so "subtract five
 * hours" is correct for half of the year and silently wrong for the other half,
 * which would misclassify an hour of calls around every DST transition.
 */
function localParts(at: Date, timeZone: string): { day: DayKey; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const lookup = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekday = lookup("weekday").toLowerCase().slice(0, 3) as DayKey;
  // Intl renders midnight as "24" in some environments under hour12:false.
  const hour = Number(lookup("hour")) % 24;
  const minute = Number(lookup("minute"));

  return { day: weekday, minutes: hour * 60 + minute };
}

function isWithin(minutes: number, range: TimeRange): boolean {
  const open = toMinutes(range[0]);
  const close = toMinutes(range[1]);
  if (open === null || close === null) return false;

  // Open at the opening minute, shut at the closing minute: a call landing
  // exactly at close is after hours, which matches how a front desk behaves.
  if (close > open) return minutes >= open && minutes < close;

  // Crosses midnight — late evening through to the small hours.
  return minutes >= open || minutes < close;
}

/**
 * Is the clinic open at this instant?
 *
 * Returns null when hours have not been collected. Callers must not coerce that
 * to a boolean; see the file header.
 */
export function isOpenAt(
  hours: OpeningHours | null | undefined,
  at: Date,
  timeZone: string,
): boolean | null {
  if (!hours) return null;

  const { day, minutes } = localParts(at, timeZone);
  const today = hours[day];
  if (today === undefined) return null;

  if (today.some((range) => isWithin(minutes, range))) return true;

  // A range that began yesterday and runs past midnight still covers now.
  const yesterday = hours[DAY_KEYS[(DAY_KEYS.indexOf(day) + 6) % 7]!];
  const spillover = (yesterday ?? []).filter((range) => {
    const open = toMinutes(range[0]);
    const close = toMinutes(range[1]);
    return open !== null && close !== null && close <= open;
  });

  return spillover.some((range) => {
    const close = toMinutes(range[1])!;
    return minutes < close;
  });
}

/**
 * Would this contact have gone unanswered because the clinic was shut?
 *
 * The direct input to `recovery_reason`. Null means we cannot tell, and the
 * caller must then record NO recovery reason rather than defaulting either way
 * — an uncounted recovered call costs us credit for work we did, while a
 * wrongly-counted one costs the customer's trust in every other figure.
 */
export function isAfterHours(
  hours: OpeningHours | null | undefined,
  at: Date,
  timeZone: string,
): boolean | null {
  const open = isOpenAt(hours, at, timeZone);
  return open === null ? null : !open;
}

/** Mon–Fri 9–5, offered as a starting point in the console. Never a default. */
export const COMMON_WEEKDAY_HOURS: OpeningHours = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
};
