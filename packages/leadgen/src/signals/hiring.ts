import type { ApifyClient } from "apify-client";

/**
 * Trigger signal — a clinic hiring a front desk.
 *
 * The best-timed signal available. A clinic posting for a receptionist is
 * publicly announcing the exact pain the product solves, and doing it at the
 * moment they have budget approved and a decision to make. The pitch writes
 * itself: a front-desk hire is $47,000–58,000 a year fully loaded for forty
 * hours a week; we cover a hundred and sixty-eight for a fraction of it.
 *
 * Unlike the firmographic signals, this one decays. A posting filled three
 * months ago is worse than useless — leading with it tells the owner we haven't
 * looked at them since. Hence `postedAt` and `isStale`.
 */

export const FRONT_DESK_TITLES = [
  "patient care coordinator",
  "patient coordinator",
  "front desk associate",
  "front desk coordinator",
  "front desk receptionist",
  "medical receptionist",
  "receptionist",
  "front office coordinator",
  "scheduling coordinator",
  "patient services representative",
] as const;

/**
 * Titles that look like a match but aren't.
 *
 * "Patient care technician" is clinical. "Front desk" at a hotel or gym is a
 * different business entirely and will show up on any keyword search that
 * isn't industry-filtered.
 */
const EXCLUDE_TITLES = [
  "technician",
  "medical assistant",
  "nurse",
  "hotel",
  "spa attendant",
  "housekeeping",
  "security",
] as const;

/** A posting older than this is treated as probably filled. */
export const STALE_AFTER_DAYS = 45;

export type JobPosting = {
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  postedAt: Date | null;
  source: string;
};

export type HiringSignal = {
  /** Postings that look like a front-desk role at this clinic. */
  postings: JobPosting[];
  /** Most recent relevant posting, if any. */
  mostRecent: Date | null;
  /** True when the newest posting is old enough to have been filled. */
  isStale: boolean;
};

export const NO_HIRING_SIGNAL: HiringSignal = {
  postings: [],
  mostRecent: null,
  isStale: false,
};

export function isFrontDeskRole(title: string): boolean {
  const normalized = title.toLowerCase();
  if (EXCLUDE_TITLES.some((bad) => normalized.includes(bad))) return false;
  return FRONT_DESK_TITLES.some((good) => normalized.includes(good));
}

export function summariseHiring(
  postings: JobPosting[],
  now: Date = new Date(),
): HiringSignal {
  const relevant = postings.filter((p) => isFrontDeskRole(p.title));
  if (relevant.length === 0) return NO_HIRING_SIGNAL;

  const dated = relevant
    .map((p) => p.postedAt)
    .filter((d): d is Date => d instanceof Date);

  const mostRecent = dated.length
    ? new Date(Math.max(...dated.map((d) => d.getTime())))
    : null;

  const ageDays = mostRecent
    ? (now.getTime() - mostRecent.getTime()) / 86_400_000
    : Number.POSITIVE_INFINITY;

  return {
    postings: relevant,
    mostRecent,
    // Undated postings are treated as stale. A signal we can't date is one we
    // shouldn't lead an email with.
    isStale: ageDays > STALE_AFTER_DAYS,
  };
}

/**
 * Search job boards for front-desk openings in a metro.
 *
 * Actor-agnostic: pass whichever Apify job-board actor you have access to and
 * a mapper for its output shape. They differ enough that hard-coding one would
 * mean rewriting this the first time it changes or gets deprecated.
 *
 * Returns postings by COMPANY, which then need matching to the clinic universe
 * from Stage 1 — the name on a job board rarely matches the name on Google Maps
 * exactly, so matchPostingsToClinic() does that fuzzily and conservatively.
 */
export async function searchFrontDeskPostings(
  apify: ApifyClient,
  options: {
    actorId: string;
    location: string;
    /** Defaults to the front-desk title list. */
    titles?: readonly string[];
    /** Maps the actor's own output shape onto JobPosting. */
    map: (item: Record<string, unknown>) => JobPosting | null;
    maxItems?: number;
  },
): Promise<JobPosting[]> {
  const titles = options.titles ?? FRONT_DESK_TITLES;

  const run = await apify.actor(options.actorId).call({
    position: titles.join(" OR "),
    location: options.location,
    maxItems: options.maxItems ?? 200,
  });

  const { items } = await apify.dataset(run.defaultDatasetId).listItems();

  return (items as unknown as Record<string, unknown>[])
    .map((item) => options.map(item))
    .filter((p): p is JobPosting => p !== null && isFrontDeskRole(p.title));
}

/**
 * Match postings to a clinic by name.
 *
 * Conservative on purpose. A false positive here means telling an owner we saw
 * them hiring when they weren't, which destroys the credibility the whole
 * signal was meant to buy. Requires a normalised containment match in one
 * direction or the other, not a fuzzy distance score.
 */
export function matchPostingsToClinic(
  clinicName: string,
  postings: JobPosting[],
): JobPosting[] {
  const clinic = normaliseCompany(clinicName);
  if (clinic.length < 4) return [];

  return postings.filter((posting) => {
    const company = normaliseCompany(posting.company);
    if (company.length < 4) return false;
    return company.includes(clinic) || clinic.includes(company);
  });
}

function normaliseCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|pllc|pc|pa|ltd|co|corp)\b/g, "")
    // Generic words that make unrelated clinics look like each other.
    .replace(/\b(med|medical|spa|clinic|aesthetics|aesthetic|center|centre)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}
