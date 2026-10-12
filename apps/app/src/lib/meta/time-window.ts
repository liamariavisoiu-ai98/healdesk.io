/**
 * The closed time grammar a Meta booking window must fit (BAA 1.3.0 clause
 * 11, "Clinical content sent on Instagram, Messenger or WhatsApp is not kept
 * at all"; clause 16, "keeps none, repeats none").
 *
 * A Meta request keeps one free-text field, the preferred day or time, and
 * its alternatives, for the request's 90 days. A list of refused words could
 * never be complete ("Tuesday after my chemo", "after my semaglutide shot"
 * and "I have diabetes" all passed one), so a window is accepted only when
 * EVERY word in it is a word for a time, and anything else is dropped and
 * asked for again (lib/meta/booking-requests.ts, windowIsClean):
 *
 *   - weekdays, months and dates ("Tues", "Oct 21", "10/21", "the 22nd");
 *   - clock times ("3", "5:30pm", "3 pm", "half past 4", "noon");
 *   - parts of the day (morning, afternoon, evening, lunchtime, and the
 *     early, mid and late of them);
 *   - days relative to today (today, tomorrow, next week, this weekend);
 *   - "before" and "after" a time, "any time", ranges ("2-4", "between 2 and
 *     4", "from 10 until noon") and "or" between them;
 *   - a few words people use around those and that cannot carry anything
 *     about a person's health: "at", "around", "please", "after work".
 *
 * A word in any other language, a name, a drug, a body part or a reason is
 * outside the grammar, so it is refused without anyone having to think of it
 * first. A window must also name a time at all: "after", "or" and "please"
 * alone are not one.
 */

const WEEKDAYS = [
  "monday",
  "mon",
  "tuesday",
  "tue",
  "tues",
  "wednesday",
  "wed",
  "weds",
  "thursday",
  "thu",
  "thur",
  "thurs",
  "friday",
  "fri",
  "saturday",
  "sat",
  "sunday",
  "sun",
  "weekday",
  "weekend",
];

const MONTHS = [
  "january",
  "jan",
  "february",
  "feb",
  "march",
  "mar",
  "april",
  "apr",
  "may",
  "june",
  "jun",
  "july",
  "jul",
  "august",
  "aug",
  "september",
  "sep",
  "sept",
  "october",
  "oct",
  "november",
  "nov",
  "december",
  "dec",
];

/** Words that name a time on their own: an anchor. */
const ANCHORS = new Set([
  ...WEEKDAYS,
  ...WEEKDAYS.map((day) => `${day}s`),
  ...MONTHS,
  // Parts of the day.
  "morning",
  "mornings",
  "afternoon",
  "afternoons",
  "evening",
  "evenings",
  "lunchtime",
  "lunch",
  "noon",
  "midday",
  "midnight",
  "night",
  "nights",
  "tonight",
  "am",
  "pm",
  // Days relative to today, and spans.
  "today",
  "tomorrow",
  "tmrw",
  "tmr",
  "week",
  "weeks",
  "month",
  "day",
  "days",
  "time",
  "anytime",
  "whenever",
  "now",
  "soon",
  "asap",
  "o'clock",
  "oclock",
  // A clock time in words.
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "quarter",
  "half",
  // An ordinal day ("the first", "the twenty-second").
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
]);

/** Words that join or qualify times, and never stand for one alone. */
const JOINERS = new Set([
  "before",
  "after",
  "by",
  "from",
  "until",
  "till",
  "til",
  "to",
  "between",
  "and",
  "or",
  "either",
  "through",
  "thru",
  "any",
  "every",
  "other",
  "all",
  "at",
  "on",
  "in",
  "of",
  "the",
  "a",
  "an",
  "around",
  "about",
  "approx",
  "approximately",
  "ish",
  "past",
  "next",
  "this",
  "coming",
  "following",
  "same",
  "early",
  "earlier",
  "late",
  "later",
  "mid",
  "middle",
  "end",
  "start",
  "beginning",
  "last",
  "also",
  "else",
  "sometime",
  "as",
  "thing",
  "possible",
  "if",
  "please",
  "pls",
  "preferably",
  "ideally",
  "maybe",
  "perhaps",
  "so",
  // "after work", "before school": a routine, not a reason.
  "work",
  "school",
]);

/** A numeric token: a clock time, a date, a day of the month or a year. */
function numericIsTime(token: string): boolean {
  const t = token.replace(/(?:am|pm|st|nd|rd|th|ish|h)$/, "");
  // A clock time with minutes: 5:30, 5.30, 17:45.
  let m = /^(\d{1,2})[:.](\d{2})$/.exec(t);
  if (m) return Number(m[1]) <= 24 && Number(m[2]) < 60;
  // An hour or a day of the month: 3, 21.
  if (/^\d{1,2}$/.test(t)) return Number(t) <= 31;
  // A date: 10/21, 21-10, 10/21/26, 2026-10-21. A range of hours ("2-4") has the same shape.
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  if (m) return Number(m[1]) <= 31 && Number(m[2]) <= 31;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return true;
  // A year, or a time without its colon: 2026, 1030.
  if (/^(19|20)\d{2}$/.test(t)) return true;
  m = /^(\d{1,2})(\d{2})$/.exec(t);
  if (m) return Number(m[1]) <= 23 && Number(m[2]) < 60;
  return false;
}

const SEPARATOR = /^[\s,;:!?()/&+.\-–—~'’"]+$/u;
const TOKEN =
  /(\d{1,4}(?:[:./-]\d{1,4}){0,2}(?:am|pm|st|nd|rd|th|ish|h)?)|(\p{L}+(?:['’]\p{L}+)*)|([\s,;:!?()/&+.\-–—~'’"]+)|(.)/gu;

/**
 * True when every word of `text` is a word for a time and at least one of
 * them names one. The window is otherwise dropped and asked for again.
 */
export function isTimeWindow(text: string): boolean {
  const lowered = text
    .toLowerCase()
    .replace(/\ba\.m\.?/g, "am")
    .replace(/\bp\.m\.?/g, "pm");
  let anchored = false;
  for (const match of lowered.matchAll(TOKEN)) {
    const [, numeric, word, separator, other] = match;
    if (separator !== undefined && SEPARATOR.test(separator)) continue;
    if (other !== undefined) return false;
    if (numeric !== undefined) {
      if (!numericIsTime(numeric)) return false;
      anchored = true;
      continue;
    }
    if (word !== undefined) {
      const w = word.replace(/’/g, "'");
      if (ANCHORS.has(w)) {
        anchored = true;
        continue;
      }
      if (JOINERS.has(w)) continue;
      return false;
    }
  }
  return anchored;
}
