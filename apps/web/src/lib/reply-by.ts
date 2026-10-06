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
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(local + ahead * DAY_MS));
}
