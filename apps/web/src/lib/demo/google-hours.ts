/**
 * A clinic's opening hours from its Google Business Profile, for the demo's
 * "reachable now vs with AYA".
 *
 * Websites are the wrong source for this: packages/leadgen measured 420 clinic
 * homepages and found a day and a time on 12% of them (enrich/places.ts).
 * Google nags clinics until they publish hours, and publishes them structured,
 * closed days included, so the build asks Google first and keeps the
 * website's hours only as a fallback.
 *
 * Fetched through Apify's Google Maps crawler (`compass/crawler-google-places`,
 * the actor leadgen already uses) with the APIFY_TOKEN the scraper uses. The
 * listing is accepted only when its website is the clinic's own domain: a
 * chain with six studios has six listings, and a business with a similar
 * name is someone else's hours. Returns null on anything less.
 *
 * Business data: a public listing's name and hours.
 */

export type GoogleHours = {
  /** Google's name for the listing that matched, e.g. "Peachy West SoHo". */
  place: string;
  /** One row per day, in the profile's shape, so lib/demo/opening-hours.ts reads both. */
  hours: { days: string; hours: string }[];
};

type PlaceItem = {
  title?: string;
  website?: string;
  openingHours?: { day?: string; hours?: string }[];
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
};

const TIMEOUT_SECS = 120;

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The first open listing on the clinic's own domain that has hours. Exported for the test. */
export function pickListing(items: PlaceItem[], websiteUrl: string): GoogleHours | null {
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
    if (hours.length > 0) return { place: item.title ?? "", hours };
  }
  return null;
}

export async function fetchGoogleHours(clinicName: string, websiteUrl: string): Promise<GoogleHours | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return null;
  const endpoint =
    "https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items" +
    `?timeout=${TIMEOUT_SECS}&clean=true&format=json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // The name and the domain together find the clinic's own listings first.
      searchStringsArray: [`${clinicName} ${host(websiteUrl) ?? ""}`.trim()],
      maxCrawledPlacesPerSearch: 5,
      language: "en",
      skipClosedPlaces: true,
    }),
    signal: AbortSignal.timeout((TIMEOUT_SECS + 20) * 1000),
  });
  if (!response.ok) {
    const detail = ((await response.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(`Google listing lookup: Apify HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const items = (await response.json()) as PlaceItem[];
  return pickListing(Array.isArray(items) ? items : [], websiteUrl);
}
