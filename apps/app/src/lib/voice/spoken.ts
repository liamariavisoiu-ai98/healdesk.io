import type { BookingField } from "@healdesk/catalog";

/**
 * Strings written for the ear, not the eye.
 *
 * Everything the phone agents read aloud comes through here so the
 * conversion from data to speech happens once and is tested once: a
 * timestamp becomes "Thursday the 26th at 2 PM", an E.164 number becomes
 * three groups of digits with "oh" for zero, and the requirement set becomes
 * one sentence the inbound agent can say. None of it is model text.
 */

const DIGIT_WORDS = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * "+14155550199" → "four one five — five five five — oh one nine nine".
 * A US number drops its country code; anything else is read digit by digit
 * in groups of three. §64.1200(b) wants the practice's number stated at the
 * outset of a callback, and a voice model reads "+14155550199" as a sum.
 */
export function spokenPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const groups = national.length === 10 ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)] : chunk(national, 3);
  return groups.map((g) => [...g].map((d) => DIGIT_WORDS[Number(d)]).join(" ")).join(" — ");
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

/** "Thursday the 26th at 2 PM" / "Thursday the 26th at 2:30 PM", in the given zone. */
export function spokenSlot(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const day = Number(get("day"));
  const minute = get("minute");
  const time = minute === "00" ? `${get("hour")} ${get("dayPeriod")}` : `${get("hour")}:${minute} ${get("dayPeriod")}`;
  return `${get("weekday")} the ${ordinal(day)} at ${time}`;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The requirement set as one sentence: "your first name, a number the
 * practice can call, a day or time that works best, one or two other times
 * that could work, and which service you're asking about". The catalogue's
 * `ask` strings, which name a thing and promise nothing.
 */
export function spokenFieldList(fields: readonly BookingField[]): string {
  return joinSpoken(fields.map((f) => f.ask));
}

/** "a, b, and c" — the Oxford comma so a voice model does not run two items together. */
export function joinSpoken(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
