import { ApifyClient } from "apify-client";

/**
 * Opening hours from Google Business Profile.
 *
 * The website is a dead end for this and the numbers say so plainly: measured
 * across 420 crawled homepages, 12% state a day and a time, 2% say "closed" on
 * a named day, and 0% carry schema.org openingHours — the structured form lives
 * in the <head>, which the content crawler strips. You cannot build an outreach
 * variable on 5% coverage; it would be blank for nineteen sends in twenty.
 *
 * Google is where clinics actually publish hours, because Google nags them
 * until they do, and it publishes them STRUCTURED — including the explicit
 * "Closed" days that matter most here.
 *
 * ## Why hours are the outreach variable worth having
 *
 * Not because a clinic wants to be told its own opening times. Because the
 * consequence is computable from them and the clinic has never computed it:
 * a practice open 42 hours a week is unreachable for the other 126, and that
 * arithmetic is what makes a cold email read as research rather than merge
 * fields. See closedHoursPerWeek() below.
 */

export type PlaceHours = {
  clinicId: string;
  /** Google's own name for the business, useful for confirming a match. */
  matchedName: string | null;
  /** Weekday opening, 24h HH:MM. Null when Google has no hours either. */
  opensAt: string | null;
  closesAt: string | null;
  /** One line, all seven days, including closed days. */
  hoursByDay: string | null;
  /** Days with no opening hours at all. The outreach hook. */
  closedDays: string[];
  /** Hours per week the phone is not answered by a person. */
  closedHoursPerWeek: number | null;
  /** The single longest unanswered stretch, and when it falls. */
  gap: BookingGap | null;
  /** Google's own booking link, when the clinic has one wired up. */
  reserveUrl: string | null;
  phone: string | null;
  /** How confident we are this is the right business — see matchQuality(). */
  match: "strong" | "weak" | "none";
};

type PlaceItem = {
  title?: string;
  website?: string;
  phone?: string;
  openingHours?: { day?: string; hours?: string }[];
  reserveTableUrl?: string;
  bookingLinks?: { url?: string }[];
  permanentlyClosed?: boolean;
};

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * "9 AM to 5 PM" → ["09:00", "17:00"]. Null for closed or unparseable.
 *
 * Google's strings vary more than they look — "9 AM to 5 PM", "9:30 AM to
 * 6 PM", "Open 24 hours", "Closed". Anything not confidently parsed returns
 * null rather than a guess, because these figures end up in clinics.
 * openingHours where a wrong one silently mis-bills a real call.
 */
export function parseRange(hours: string): [string, string] | null {
  const s = hours.trim().toLowerCase();
  if (!s || s.includes("closed")) return null;
  if (s.includes("24 hours")) return ["00:00", "23:59"];

  const m = s.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|–|—)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  );
  if (!m) return null;

  const to24 = (h: string, min: string | undefined, ap: string | undefined) => {
    let hour = Number(h);
    if (ap === "pm" && hour !== 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${min ?? "00"}`;
  };

  const close = to24(m[4]!, m[5], m[6]);

  // A missing am/pm on the opening time is resolved by what makes the range
  // valid, not by copying the closing one.
  //
  // "9 to 5 PM" means nine in the morning. Inheriting "pm" gives 21:00-17:00 —
  // a range that runs backwards, and one that would have been written into
  // clinics.openingHours where it silently mis-classifies every evening call.
  // So when no meridiem is given, take the reading where the clinic opens
  // before it closes.
  if (!m[3]) {
    const asPm = to24(m[1]!, m[2], m[6]);
    const asAm = to24(m[1]!, m[2], m[6] === "pm" ? "am" : "pm");
    return [asPm < close ? asPm : asAm, close];
  }

  return [to24(m[1]!, m[2], m[3]), close];
}

export type BookingGap = {
  /** Hours in the longest continuous stretch with nobody answering. */
  hours: number;
  /** When that stretch begins, e.g. "Friday 17:00". */
  startsDay: string;
  startsAt: string;
  /** When it ends — the first moment a human could pick up. */
  endsDay: string;
  endsAt: string;
};

/**
 * The longest stretch when nobody answers, and when it starts.
 *
 * The average is the wrong statistic here and it undersells the problem badly.
 * A clinic open 9-5 Monday to Friday is unreachable for 128 hours a week, but
 * quoting that invites "well, they're closed at night, so is everyone". The
 * number that lands is the single longest gap and where it falls: for that same
 * clinic it is Friday 17:00 to Monday 09:00 — sixty-four unbroken hours.
 *
 * And it falls in the worst possible place. Elective aesthetics is decided in
 * the evening and at weekends, when someone finally has time to think about it
 * and ring round. The clinic is shut for precisely the window in which its
 * next patient makes up their mind, which is a far more specific claim than
 * "you miss calls".
 *
 * Computed rather than asserted, per clinic, from their own published hours.
 */
export function longestGap(
  byDay: Record<string, [string, string] | null>,
): BookingGap | null {
  const known = DAYS.filter((d) => d in byDay);
  if (known.length === 0) return null;

  const mins = (hhmm: string) =>
    Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

  // Two weeks laid end to end, so a gap running through Sunday into Monday is
  // measured as one stretch instead of two — which is exactly the gap that
  // matters and the one a single-week loop would cut in half.
  const opens: { start: number; end: number }[] = [];
  for (let week = 0; week < 2; week += 1) {
    DAYS.forEach((day, i) => {
      const range = byDay[day];
      if (!range) return;
      const base = (week * 7 + i) * 1440;
      opens.push({ start: base + mins(range[0]), end: base + mins(range[1]) });
    });
  }
  if (opens.length === 0) return null;

  let best: BookingGap | null = null;
  for (let i = 0; i < opens.length - 1; i += 1) {
    const gapMins = opens[i + 1]!.start - opens[i]!.end;
    if (gapMins <= 0) continue;
    if (best && gapMins / 60 <= best.hours) continue;

    const at = (abs: number) => {
      const day = DAYS[Math.floor(abs / 1440) % 7]!;
      const m = abs % 1440;
      return [
        day,
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
      ] as const;
    };
    const [sd, sa] = at(opens[i]!.end);
    const [ed, ea] = at(opens[i + 1]!.start);

    best = {
      hours: Math.round(gapMins / 60),
      startsDay: sd,
      startsAt: sa,
      endsDay: ed,
      endsAt: ea,
    };
  }

  return best;
}

/**
 * Hours a week nobody answers the phone.
 *
 * The number the outreach actually uses. A clinic knows it closes at five; it
 * has never worked out that this leaves 126 hours a week when a new patient
 * reaches a machine — and the gap between those two is where a cold email stops
 * sounding like a mail merge.
 */
export function closedHoursPerWeek(
  byDay: Record<string, [string, string] | null>,
): number {
  let open = 0;
  for (const day of DAYS) {
    const range = byDay[day];
    if (!range) continue;
    const [a, b] = range;
    const mins =
      Number(b.slice(0, 2)) * 60 +
      Number(b.slice(3)) -
      (Number(a.slice(0, 2)) * 60 + Number(a.slice(3)));
    if (mins > 0) open += mins / 60;
  }
  return Math.round(168 - open);
}

/**
 * Is this Google result actually the clinic we asked about?
 *
 * A name-and-city search returns the best guess, not the right answer, and a
 * wrong match is worse than none: it puts another business's hours into a cold
 * email addressed to this one. Domain agreement is the strong signal because a
 * clinic's website is unique to it; a name match alone is weak, since "Radiance
 * Med Spa" exists in a dozen states.
 */
export function matchQuality(
  item: PlaceItem,
  domain: string,
  company: string,
): "strong" | "weak" | "none" {
  const site = (item.website ?? "").toLowerCase();
  const bare = domain.replace(/^www\./, "").toLowerCase();
  if (bare && site.includes(bare)) return "strong";

  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(item.title ?? "");
  const b = norm(company);
  if (a && b && (a.includes(b) || b.includes(a))) return "weak";

  return "none";
}

export function toPlaceHours(
  clinicId: string,
  item: PlaceItem | undefined,
  domain: string,
  company: string,
): PlaceHours {
  const empty: PlaceHours = {
    clinicId,
    matchedName: null,
    opensAt: null,
    closesAt: null,
    hoursByDay: null,
    closedDays: [],
    closedHoursPerWeek: null,
    gap: null,
    reserveUrl: null,
    phone: null,
    match: "none",
  };
  if (!item) return empty;

  const match = matchQuality(item, domain, company);
  // A weak match still carries a phone and a booking link worth having, but its
  // hours are not safe to put in an email addressed to someone else.
  if (match === "none") return { ...empty, match };

  const byDay: Record<string, [string, string] | null> = {};
  for (const entry of item.openingHours ?? []) {
    const day = DAYS.find((d) => (entry.day ?? "").startsWith(d.slice(0, 3)));
    if (day) byDay[day] = parseRange(entry.hours ?? "");
  }

  const known = DAYS.filter((d) => d in byDay);
  const closedDays = known.filter((d) => !byDay[d]);
  const weekdays = (["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const)
    .map((d) => byDay[d])
    .filter(Boolean) as [string, string][];

  return {
    clinicId,
    matchedName: item.title ?? null,
    // The modal weekday pair, not an average — a clinic open 9-5 four days and
    // 9-7 on Thursday opens at nine.
    opensAt: weekdays.length ? weekdays[0]![0] : null,
    closesAt: weekdays.length ? weekdays[0]![1] : null,
    hoursByDay: known.length
      ? known
          .map((d) => {
            const r = byDay[d];
            return `${d.slice(0, 3)} ${r ? `${r[0]}-${r[1]}` : "closed"}`;
          })
          .join("; ")
      : null,
    closedDays,
    closedHoursPerWeek: known.length ? closedHoursPerWeek(byDay) : null,
    gap: known.length ? longestGap(byDay) : null,
    reserveUrl: item.bookingLinks?.[0]?.url ?? item.reserveTableUrl ?? null,
    phone: item.phone ?? null,
    match,
  };
}

export type PlacesOptions = {
  token: string;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
};

export type PlacesTarget = {
  clinicId: string;
  company: string;
  city: string;
  state: string;
  domain: string;
};

export async function fetchPlaceHours(
  targets: PlacesTarget[],
  options: PlacesOptions,
): Promise<PlaceHours[]> {
  const client = new ApifyClient({ token: options.token });
  const batchSize = options.batchSize ?? 100;
  const out: PlaceHours[] = [];

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);

    const run = await client.actor("compass/crawler-google-places").call({
      // Name plus city and state, because a clinic name alone collides across
      // metros and the extra tokens are what make the top result the right one.
      searchStringsArray: batch.map(
        (t) => `${t.company} ${t.city} ${t.state}`.trim(),
      ),
      // One result per search. Asking for more invites the wrong business to
      // outrank the right one and multiplies the per-place cost.
      maxCrawledPlacesPerSearch: 1,
      // Hours live on the detail page, not the search card.
      scrapePlaceDetailPage: true,
      language: "en",
      countryCode: "us",
      // Permanently closed clinics are still worth recording: a closed business
      // is a fact about the list, and dropping it silently shrinks the
      // denominator.
      skipClosedPlaces: false,
    });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    // Results come back in search order, but relying on that would silently
    // attach one clinic's hours to another. Matched on website, then name.
    const pool = items as PlaceItem[];
    for (const target of batch) {
      const bare = target.domain.replace(/^www\./, "").toLowerCase();
      const found =
        pool.find((p) => (p.website ?? "").toLowerCase().includes(bare)) ??
        pool.find(
          (p) => matchQuality(p, target.domain, target.company) === "weak",
        );
      out.push(toPlaceHours(target.clinicId, found, target.domain, target.company));
    }

    options.onProgress?.(Math.min(i + batchSize, targets.length), targets.length);
  }

  return out;
}
