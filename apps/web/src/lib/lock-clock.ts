/**
 * The month-one lock screen's clock, on the visitor's own clock (owner, 12
 * October 2026): the date and time it shows are the visitor's, and the times
 * on its notifications are read against them, so the screen is never set on
 * a morning that has not happened yet.
 *
 * Nothing here asks where the visitor is. The browser already keeps its
 * clock in its own time zone, so the visitor's date and time are simply the
 * device's; a location would add a permission prompt and nothing else. The
 * language is the site's, English, in the visitor's English where they have
 * one ("Monday 12 October" for en-GB) and the hours their device counts in
 * (a 24-hour device sees 21:41, not 9:41).
 *
 * The notifications' times are written in lib/outcomes.ts for a lock screen
 * read in the morning: "now", "2m ago", "26m ago", "7:02 AM", "11:48 PM",
 * "Yesterday", "Yesterday", "Monday". Against another clock some stop making
 * sense: at 3 a.m. "7:02 AM" is in the future, and on a Monday "Monday" is
 * today. So `noteTimes` keeps what is true and turns the rest into what a
 * phone would say: a time of day only once it has passed, half an hour behind
 * the "26m ago" above it; an evening time below a morning one is last night's;
 * anything earlier is "Yesterday"; and a weekday is "Yesterday" the day after
 * and a date a week on.
 */

/**
 * The visitor's English, or American English for a visitor without one. A
 * browser's language list is not always made of tags Intl accepts (a Linux
 * locale arrives as "en-US@posix", which throws), so each is checked first.
 */
export function englishLocale(languages: readonly string[]): string {
  for (const tag of languages) {
    if (!/^en(?:-|$)/i.test(tag)) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0] ?? "en-US";
    } catch {
      // Not a tag Intl can use: try the next.
    }
  }
  return "en-US";
}

/** Whether the visitor's device counts hours in twelve or in twenty-four. */
export function hourCycleOf(locale?: string): "h11" | "h12" | "h23" | "h24" {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle ?? "h12";
}

/** The lock screen's date line: "Monday, October 12". */
export function lockDate(now: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(now);
}

/** The lock screen's clock, without AM or PM, as a phone's is: "9:41", or "21:41". */
export function lockTime(now: Date, locale: string, hourCycle: string): string {
  const parts = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hourCycle: hourCycle as Intl.DateTimeFormatOptions["hourCycle"] }).formatToParts(now);
  const from = parts.findIndex((part) => part.type === "hour");
  const to = parts.findIndex((part) => part.type === "minute");
  return parts
    .slice(from, to + 1)
    .map((part) => part.value)
    .join("");
}

const CLOCK = /^(\d{1,2}):(\d{2}) (AM|PM)$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** The "26m ago" above the first time of day, and a few minutes more. */
const SINCE_MINUTES = 30;

/**
 * Each notification's time, read against `now`, by id. `items` are in the
 * lock screen's order, newest first, with their times as lib/outcomes.ts
 * writes them.
 */
export function noteTimes(
  items: readonly { id: string; time: string }[],
  now: Date,
  locale: string,
  hourCycle: string,
): Record<string, string> {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hourCycle: hourCycle as Intl.DateTimeFormatOptions["hourCycle"] });
  const out: Record<string, string> = {};
  /** Everything above is still today, or last night: no "Yesterday" yet. */
  let today = true;

  for (const { id, time } of items) {
    const at = CLOCK.exec(time);
    const weekday = WEEKDAYS.indexOf(time as (typeof WEEKDAYS)[number]);

    if (at) {
      const pm = at[3] === "PM";
      const t = ((Number(at[1]) % 12) + (pm ? 12 : 0)) * 60 + Number(at[2]);
      const then = new Date(now);
      then.setHours(Math.floor(t / 60), t % 60, 0, 0);
      if (t <= minutes - SINCE_MINUTES || (pm && t > minutes && today)) {
        out[id] = clock.format(then);
      } else {
        out[id] = "Yesterday";
        today = false;
      }
    } else if (weekday >= 0) {
      const back = (now.getDay() - weekday + 7) % 7 || 7;
      if (back === 1) out[id] = "Yesterday";
      else if (back < 7) out[id] = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
      else out[id] = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
      today = false;
    } else {
      out[id] = time;
      if (time === "Yesterday") today = false;
    }
  }
  return out;
}
