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
 *     about a person's health: "at", "around", "please", "after work", and
 *     a small closed set of filler ("I'm free Tuesday", "Saturday morning
 *     works", "anytime this week is fine", "after 5 if that's ok").
 *
 * And four shapes are refused although every word in them is a time word
 * (the branch review's R10), because each can carry something about the
 * person: "day 3" (a cycle day), a full date in a past year ("10/21/1985",
 * shaped like a date of birth), "after" or "before" with no time after it
 * ("the morning after", "2 weeks after": after what?), and a three-digit
 * number ("after 250"), which is no clock time.
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
  "months",
  "year",
  "years",
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
  // Filler around a time, closed: "I'm free Tuesday", "Saturday morning
  // works", "anytime this week is fine", "after 5 if that's ok".
  "i",
  "i'm",
  "im",
  "free",
  "available",
  "works",
  "is",
  "fine",
  "ok",
  "okay",
  "good",
  "great",
  "best",
  "perfect",
  "that",
  "that's",
  "thats",
  "for",
  "me",
  "would",
  "be",
]);

/** Words that count a day or a time in words, which "day" must not lead ("day three"). */
const NUMBER_WORDS = new Set([
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

/** Words "after" and "before" may pass over on the way to their time: "after the 3rd", "before about 4". */
const LEAD_INS = new Set([
  "the",
  "a",
  "an",
  "about",
  "around",
  "approx",
  "approximately",
  "next",
  "this",
  "mid",
  "early",
  "late",
]);

/** A year as written, two digits or four, in full. */
function fullYear(written: string): number {
  return written.length === 2 ? 2000 + Number(written) : Number(written);
}

/**
 * A numeric token: a clock time, a date, a day of the month or a year,
 * whose year, when it has one, is this year or next (see `bookable`).
 */
function numericIsTime(token: string, now: Date): boolean {
  const thisYear = now.getUTCFullYear();
  // A booking is this year or next. Any other year is no time to book, and
  // beside a day and a month it is shaped like a date of birth: a past one
  // ("10/21/1985"), and a two-digit one read in this century ("03/12/90"
  // as 2090).
  const bookable = (year: number) => year >= thisYear && year <= thisYear + 1;
  const t = token.replace(/(?:am|pm|st|nd|rd|th|ish|h)$/, "");
  // A clock time with minutes: 5:30, 5.30, 17:45.
  let m = /^(\d{1,2})[:.](\d{2})$/.exec(t);
  if (m) return Number(m[1]) <= 24 && Number(m[2]) < 60;
  // An hour or a day of the month: 3, 21.
  if (/^\d{1,2}$/.test(t)) return Number(t) <= 31;
  // A date: 10/21, 21-10, 10/21/26, 2026-10-21. A range of hours ("2-4") has the same shape.
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  if (m) {
    if (m[3] !== undefined && !bookable(fullYear(m[3]))) return false;
    return Number(m[1]) <= 31 && Number(m[2]) <= 31;
  }
  m = /^(\d{4})-\d{1,2}-\d{1,2}$/.exec(t);
  if (m) return bookable(Number(m[1]));
  // A year, or a time without its colon: 2026, 1030. Three digits ("250")
  // are neither.
  if (/^(19|20)\d{2}$/.test(t)) return bookable(Number(t));
  m = /^(\d{2})(\d{2})$/.exec(t);
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
export function isTimeWindow(text: string, now: Date = new Date()): boolean {
  const lowered = text
    .toLowerCase()
    .replace(/\ba\.m\.?/g, "am")
    .replace(/\bp\.m\.?/g, "pm");
  let anchored = false;
  // The word before this one, for "day 3"; and an "after" or "before" still
  // waiting for its time.
  let previous: string | null = null;
  let waiting = false;
  for (const match of lowered.matchAll(TOKEN)) {
    const [, numeric, word, separator, other] = match;
    if (separator !== undefined && SEPARATOR.test(separator)) continue;
    if (other !== undefined) return false;
    if (numeric !== undefined) {
      if (!numericIsTime(numeric, now)) return false;
      // "day 3", "days 3-5": a cycle day, not a date.
      if ((previous === "day" || previous === "days") && /^\d/.test(numeric)) return false;
      anchored = true;
      waiting = false;
      previous = numeric;
      continue;
    }
    if (word !== undefined) {
      const w = word.replace(/’/g, "'");
      if ((previous === "day" || previous === "days") && NUMBER_WORDS.has(w)) return false;
      if (ANCHORS.has(w)) {
        anchored = true;
        waiting = false;
      } else if (JOINERS.has(w)) {
        if (w === "after" || w === "before") {
          // "after after" or "before after" is still waiting.
          waiting = true;
        } else if (waiting && w !== "work" && w !== "school" && !LEAD_INS.has(w)) {
          return false;
        } else if (w === "work" || w === "school") {
          waiting = false;
        }
      } else {
        return false;
      }
      previous = w;
    }
  }
  return anchored && !waiting;
}
