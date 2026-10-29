import { runActorUntil } from "./apify";

/**
 * A clinic's Google Business Profile, for what its website does not say.
 *
 * Websites are the wrong source for opening hours: packages/leadgen measured
 * 420 clinic homepages and found a day and a time on 12% of them
 * (enrich/places.ts). Google nags clinics until they publish hours, and
 * publishes them structured, closed days included, so the build takes
 * Google's hours over the website's. The same listing also carries the phone
 * number, the address and Google's "about" details (parking, payment methods,
 * accessibility, whether an appointment is needed), which a caller asks about
 * and a clinic's website often leaves out (owner, 29 October 2026: "the demo
 * should know everything that is findable on the website and google"). Those
 * fill gaps: the website's own phone and address win where it gives them.
 *
 * Fetched through Apify's Google Maps crawler (`compass/crawler-google-places`,
 * the actor leadgen already uses) with the APIFY_TOKEN the scraper uses, beside
 * the website's reading and its extraction, until just before the profile is
 * due (lib/demo/budget.ts, lib/demo/build.ts). The listing is accepted only
 * when its website is the clinic's own domain: a chain with six studios has six
 * listings, and a business with a similar name is someone else's.
 *
 * Business data: a public listing's name, hours, phone, address and amenities.
 * Reviews and ratings are not read: they are other people's words.
 */

export type GoogleListing = {
  /** Google's name for the listing that matched, e.g. "Peachy West SoHo". */
  place: string;
  /** One row per day, in the profile's shape, so lib/demo/opening-hours.ts reads both; empty when the listing has none. */
  hours: { days: string; hours: string }[];
  phone: string | null;
  address: string | null;
  /** Google's "about" details as plain lines, e.g. "Parking: free parking lot, street parking". */
  about: string[];
};

type PlaceItem = {
  title?: string;
  website?: string;
  phone?: string;
  address?: string;
  openingHours?: { day?: string; hours?: string }[];
  additionalInfo?: Record<string, unknown>;
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
};

/**
 * The "about" groups a front desk is asked about. Others (crowd, highlights,
 * "from the business") are left out: they are Google's marketing labels, not
 * facts a caller needs.
 */
const ABOUT_GROUPS = ["Parking", "Payments", "Accessibility", "Planning", "Amenities", "Service options"] as const;

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

/**
 * Google's additionalInfo, `{ Parking: [{ "Free parking lot": true }, ...] }`,
 * as lines. Only what Google marks true: a false entry is something the place
 * does not have, which a front desk would not volunteer.
 */
export function aboutLines(info: Record<string, unknown> | undefined): string[] {
  if (!info || typeof info !== "object") return [];
  const lines: string[] = [];
  for (const group of ABOUT_GROUPS) {
    const entries = info[group];
    if (!Array.isArray(entries)) continue;
    const yes = entries
      .flatMap((entry) => (entry && typeof entry === "object" ? Object.entries(entry as Record<string, unknown>) : []))
      .filter(([, value]) => value === true)
      .map(([label]) => label.trim())
      .filter((label) => label.length > 0 && label.length <= 80);
    if (yes.length > 0) lines.push(`${group}: ${yes.slice(0, 8).join(", ").toLowerCase()}`);
  }
  return lines;
}

/** The first open listing on the clinic's own domain that has anything to give. Exported for the test. */
export function pickListing(items: PlaceItem[], websiteUrl: string): GoogleListing | null {
  const want = host(websiteUrl);
  if (!want) return null;
  for (const item of items) {
    if (item.permanentlyClosed || item.temporarilyClosed) continue;
    const got = host(item.website);
    if (!got || (got !== want && !got.endsWith(`.${want}`))) continue;
    const hours = (item.openingHours ?? [])
      .filter((h): h is { day: string; hours: string } => Boolean(h.day && h.hours))
      // Google appends holiday notes to a day ("Monday (Columbus Day)"); the weekday is what counts.
      .map((h) => ({ days: h.day.replace(/\s*\(.*\)\s*$/, "").trim(), hours: h.hours.replace(/\s+/g, " ").trim() }));
    const listing: GoogleListing = {
      place: item.title ?? "",
      hours,
      phone: text(item.phone, 40),
      address: text(item.address, 200),
      about: aboutLines(item.additionalInfo),
    };
    if (listing.hours.length > 0 || listing.phone || listing.address || listing.about.length > 0) return listing;
  }
  return null;
}

/** The clinic's listing, or null: no token, no match, or nothing read before `deadline`. */
export async function fetchGoogleListing(clinicName: string, websiteUrl: string, deadline: number): Promise<GoogleListing | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  const { items } = await runActorUntil<PlaceItem>(
    "compass~crawler-google-places",
    {
      // The name and the domain together find the clinic's own listings first.
      searchStringsArray: [`${clinicName} ${host(websiteUrl) ?? ""}`.trim()],
      maxCrawledPlacesPerSearch: 3,
      language: "en",
      skipClosedPlaces: true,
    },
    { token, deadline, what: "Google listing lookup" },
  );
  return pickListing(items, websiteUrl);
}
