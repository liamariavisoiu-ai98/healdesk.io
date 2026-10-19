/**
 * The date we promise to reply by: the next business day, written out.
 *
 * Copy never says "within one business day" or "we'll be in touch". It
 * names the day ("We'll reply by Tuesday 7 October"), because a vague
 * promise reads as one nobody intends to keep (the owner's rule of
 * 5 October 2026). Business days are counted in New York time, where our
 * buyers are: a request sent on a Friday afternoon there is answered on
 * Monday, not on the Saturday it already is in Dubai.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function replyByDate(now: Date = new Date(), timeZone = "America/New_York"): string {
  const [year, month, day] = replyByDay(now, timeZone).split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** The same day as an ISO date (YYYY-MM-DD), for comparing rather than printing. */
export function replyByDay(now: Date = new Date(), timeZone = "America/New_York"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const ahead = weekday === "Fri" ? 3 : weekday === "Sat" ? 2 : 1;
  const local = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), 12);
  return new Date(local + ahead * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whether a promise to reply by `isoDay` has lapsed at `now`: the whole of
 * that day has passed in New York, where it was counted. On the day itself
 * the promise still holds. For the setup requests' past-due alert.
 */
export function replyByPassed(isoDay: string, now: Date = new Date(), timeZone = "America/New_York"): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return false;
  return `${get("year")}-${get("month")}-${get("day")}` > isoDay;
}
