/**
 * How the portal writes a day, a moment and money: the same forms the emails
 * use ("Tuesday 13 October", "2:32 pm EDT on Tuesday 13 October", "$897"),
 * so a date on Billing reads the way the email about it does. Dates are the
 * clinic's own: a moment is the day it falls on in the clinic's time zone,
 * and a bare calendar date (YYYY-MM-DD) is that day wherever the clinic is.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type Day = { year: number; month: number; day: number };

function dayOf(value: Date | string, timeZone: string): Day {
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    return { year, month, day };
  }
  const at = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/New_York";
  }
}

/**
 * "Tuesday 13 October", with the year only when it is not this year (as of
 * `now`, in the clinic's zone): "Friday 5 November 2027".
 */
export function portalDay(
  value: Date | string,
  timeZone: string,
  now: Date = new Date(),
  options: { weekday?: boolean } = {},
): string {
  const day = dayOf(value, timeZone);
  const thisYear = dayOf(now, timeZone).year;
  const noon = new Date(Date.UTC(day.year, day.month - 1, day.day, 12));
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
  }).formatToParts(noon);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return [
    options.weekday === false ? null : get("weekday"),
    String(day.day),
    get("month"),
    day.year === thisYear ? null : String(day.year),
  ]
    .filter(Boolean)
    .join(" ");
}

/** "2:32 pm EDT on Tuesday 13 October": where the hour matters. */
export function portalMoment(value: Date, timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(value);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = get("minute");
  const clock = `${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toLowerCase()}`;
  return `${clock} ${get("timeZoneName")} on ${portalDay(value, timeZone, now)}`.replace(
    /\s+/g,
    " ",
  );
}

/** "$897", "$24.50", "$11,484": whole dollars print without cents. */
export function portalMoney(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/** "1 voice minute", "1,000 voice minutes". */
export function portalCount(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
