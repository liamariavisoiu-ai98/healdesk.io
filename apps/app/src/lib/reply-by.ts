/**
 * The date we promise to reply by: the next business day in New York, written
 * out ("Wednesday 7 October"). Copy never says "within one business day"; it
 * names the day. The same rule as apps/web's lib/reply-by.ts, which this
 * mirrors for the pages and emails this app owns.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function replyByDate(now: Date = new Date(), timeZone = "America/New_York"): string {
  return formatReplyBy(replyByDay(now, timeZone));
}

/**
 * The same day as an ISO date (YYYY-MM-DD), for an email payload, which
 * carries dates and never sentences (Annex X4).
 */
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

/** "Wednesday 7 October", from an ISO date. */
export function formatReplyBy(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}
