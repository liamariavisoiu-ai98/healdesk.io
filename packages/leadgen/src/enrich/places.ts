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
  /**
   * Set when the lookup itself failed, as opposed to Google having no listing.
   *
   * Without this the two are the same row — match "none", hours null — so a
   * transient Apify failure would be checkpointed as fact and never retried.
   */
  error?: string;
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
 * null rather than a guess, because these figures are quoted to the clinic in a
 * cold email, and at most pre-fill the hours it confirms in onboarding. Once
 * confirmed, a clinic's hours drive its call forwarding schedule and the count
 * of calls that would have rung out, so a wrong one is never harmless.
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
  // a range that runs backwards, and one that would be quoted to the clinic as
  // its own hours and would mis-state every evening.
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
  /**
   * Called with everything fetched so far, after each paid batch lands.
   *
   * Stage 3c is ~28 sequential billed runs over about an hour. Without this the
   * whole hour is held in memory and returned only at the end, so one 5xx at
   * run 27 throws away 2,700 place scrapes Apify has already charged for. The
   * crawl stage solved exactly this; this is the same fix.
   */
  onBatch?: (partial: PlaceHours[]) => Promise<void> | void;
  /**
   * How many Apify runs to have in flight at once. Default 1.
   *
   * This stage was strictly sequential: ~12 minutes per 100-clinic batch, so
   * 1,886 clinics took about three hours on a plan allowing 32 concurrent runs.
   * Set it to the plan's cap, not above — Apify queues the excess rather than
   * running it, which looks like concurrency and is not.
   */
  concurrency?: number;
  /**
   * Test seam. Replaces the Apify call for one batch, the way crawl.ts does,
   * so the pool's ordering, write-serialisation and failure isolation can be
   * exercised without spending money or reaching the network.
   */
  runBatch?: (batch: PlacesTarget[]) => Promise<PlaceHours[]>;
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
  const concurrency = Math.max(1, options.concurrency ?? 1);

  const batches: PlacesTarget[][] = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    batches.push(targets.slice(i, i + batchSize));
  }
  if (batches.length === 0) return [];

  /**
   * Results indexed by batch, never appended in completion order.
   *
   * Concurrent batches finish out of order, so pushing as they land would make
   * the file depend on network timing: two identical runs producing differently
   * ordered output, and any diff between them unreadable.
   */
  const slots: PlaceHours[][] = batches.map(() => []);
  const flatten = (): PlaceHours[] => slots.flat();

  let completed = 0;

  /**
   * Persistence is serialised even though the lookups are not.
   *
   * onBatch writes the whole accumulated array to one file. Two writers
   * entering that at once interleave and leave a truncated JSON document, and
   * the failure is silent until the next run fails to parse it — by which point
   * the places have been paid for. So the fetching parallelises and the writing
   * does not, and each write snapshots current state rather than a captured
   * view so a queued write never persists a stale one.
   */
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain
      .then(() => options.onBatch?.(flatten()))
      .then(() => undefined)
      .catch((error) => {
        console.error(`\n  checkpoint write failed: ${String(error)}`);
      });
    return writeChain;
  };

  const runBatch = async (index: number): Promise<void> => {
    const batch = batches[index]!;

    if (options.runBatch) {
      slots[index] = await options.runBatch(batch);
      completed += batch.length;
      options.onProgress?.(completed, targets.length);
      await persist();
      return;
    }

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
    }, {
      // This actor is PAY_PER_EVENT. Without a ceiling the per-run spend is
      // whatever Apify's default happens to be, which is not a number we chose.
      // Ten times the expected batch cost: high enough that a normal run never
      // trips it, low enough that a runaway stops at one batch.
      maxTotalChargeUsd: Math.max(1, batch.length * 0.004 * 10),
      // A run that hangs would otherwise hang the whole pipeline, since the
      // client waits indefinitely by default.
      timeout: 1800,
      waitSecs: 1800,
    });

    // .call() is start() + waitForFinish(): it resolves for FAILED, ABORTED and
    // TIMED-OUT exactly as it does for SUCCEEDED. Reading the dataset without
    // checking would turn a broken run into 100 clinics recorded as "Google has
    // no listing" — indistinguishable from the real thing, and then frozen by
    // the checkpoint.
    if (run.status !== "SUCCEEDED") {
      throw new Error(
        `batch ${index + 1} ended ${run.status} (run ${run.id})`,
      );
    }

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    // Results come back in search order, but relying on that would silently
    // attach one clinic's hours to another. Matched on website, then name.
    const pool = items as PlaceItem[];
    slots[index] = batch.map((target) => {
      const bare = target.domain.replace(/^www\./, "").toLowerCase();
      const found =
        pool.find((p) => (p.website ?? "").toLowerCase().includes(bare)) ??
        pool.find(
          (p) => matchQuality(p, target.domain, target.company) === "weak",
        );
      return toPlaceHours(target.clinicId, found, target.domain, target.company);
    });

    completed += batch.length;
    options.onProgress?.(completed, targets.length);
    await persist();
  };

  // ---- The probe batch ----------------------------------------------------
  //
  // Run alone before any fan-out, for the same reason the crawl does it: eight
  // batches launched together are all billed before the first result can be
  // inspected, so a bad search-string change costs eight batches instead of
  // one. Here it is close to free — 17 batches at concurrency 8 is three waves
  // either way — so the check costs nothing and buys the same protection.
  await runBatch(0);

  const matched = slots[0]!.filter((h) => h.match !== "none").length;
  if (slots[0]!.length >= 20 && matched === 0) {
    throw new Error(
      `none of the first ${slots[0]!.length} clinics matched a Google listing. ` +
        `That is a search-string or actor-input problem, not ${slots[0]!.length} ` +
        `clinics missing from Google — check the Apify run before spending on ` +
        `the rest. Stopping after one batch.`,
    );
  }

  // ---- Everything else, concurrently --------------------------------------
  //
  // A worker pool rather than Promise.all over every batch: Apify caps
  // concurrent actor runs per plan (5 free, 32 Starter), and launching all of
  // them at once gets them queued rather than run. Workers pull from a shared
  // cursor so a slow batch never blocks a free worker.
  let cursor = 1;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;

      try {
        await runBatch(index);
      } catch (error) {
        // One batch failing must not abandon the others: each is a separate
        // Apify run and the rest are already paid for or in flight.
        failures.push(error);
        // Recorded WITH an error rather than as "no Google listing", which is
        // what a bare toPlaceHours(undefined) would produce and would be
        // indistinguishable from the real thing. The marker is what lets the
        // next run tell "we asked and Google had nothing" from "we never got
        // an answer", and retry only the second.
        slots[index] = batches[index]!.map((t) => ({
          ...toPlaceHours(t.clinicId, undefined, t.domain, t.company),
          error: `batch failed: ${
            error instanceof Error ? error.message.slice(0, 120) : "unknown"
          }`,
        }));
        completed += batches[index]!.length;
        options.onProgress?.(completed, targets.length);
        await persist();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length - 1) }, worker),
  );

  await writeChain;

  if (failures.length) {
    console.error(
      `\n  ${failures.length} of ${batches.length} hour batches failed. Those ` +
        `clinics are marked and will be retried on the next run.`,
    );
  }

  return flatten();
}
