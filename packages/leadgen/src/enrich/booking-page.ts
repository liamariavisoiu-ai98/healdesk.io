import { ApifyClient } from "apify-client";

import { detectBooking, type BookingDetection } from "./booking.ts";
import type { CrawlResult } from "./crawl.ts";

/**
 * Fetch the one booking page a homepage already links to.
 *
 * The crawl is depth 0, so a clinic's booking widget is routinely one click
 * away on a page never fetched. The homepage names that page, so the fetch is
 * targeted rather than guessed — which is what separates this from the blind
 * path-probing measured at two hits per 340 domains.
 *
 * ## Three guardrails, each closing a specific objection
 *
 * PATIENT PORTALS ARE NEVER FETCHED. An adversarial review found that roughly
 * a quarter of this strategy's yield came from paths like /patient-portal-login
 * and /new-patient. An unauthenticated burst against those across hundreds of
 * US medical practices is the traffic signature of credential-stuffing recon,
 * and under 45 CFR 164.308(a)(6) a covered entity must investigate and document
 * security incidents — so it can make a practice open one naming your IP, two
 * weeks before you cold-email them. Those paths are excluded outright, and the
 * yield they carried is given up deliberately.
 *
 * COMPETITOR ENDPOINTS ARE NEVER FETCHED. HighLevel's terms bar competitors
 * from using the platform, and healdesk is one. Reading a leadconnectorhq.com
 * URL out of someone's HTML is not using it; issuing a GET to that URL is. The
 * URL is still READ and still identifies the vendor — and DNS finds these
 * clinics anyway through their CNAME — so nothing is lost but the request.
 *
 * IT RUNS THROUGH APIFY, NOT A BARE FETCH. This is the one that mattered most.
 * A hand-rolled fetch at concurrency 12 against healthcare sites behind
 * Cloudflare gets fingerprinted, and the block lands on the founder's own IP —
 * the codebase has no robots handling, no User-Agent and no rate limiting,
 * because Apify supplies all three. So these pages go through the same actor
 * and the same proxy pool as the main crawl. It costs about half a cent a page
 * instead of nothing, over roughly one clinic in six, which is a rounding error
 * against the alternative.
 */

/** Paths worth fetching. Booking flows only. */
const BOOKING_PATH =
  /\/(book|booking|book-now|book-online|schedule|scheduling|appointment|appointments|request-appointment|make-an-appointment|reserve|consultation|consult)(\/|$|\?)/i;

/**
 * Paths never fetched, whatever they look like.
 *
 * Portals and intake forms sit behind authentication at covered entities and
 * are exactly what an intrusion looks like from the other side. `new-patient`
 * is here too: it usually leads to intake paperwork rather than a booking
 * widget, so it carries the risk without the yield.
 */
const NEVER_FETCH =
  /\/(patient-portal|patientportal|portal|login|signin|sign-in|account|my-account|new-patient|patient-resources|paperwork|intake|records|billing|pay|payment)(\/|$|\?)/i;

/**
 * Hosts whose endpoints we read but never request.
 *
 * Competitors whose terms bar us, plus platforms whose booking endpoints are
 * behind their own bot protection. Presence in a href is evidence either way;
 * the GET adds nothing except exposure.
 */
const NEVER_REQUEST =
  /(msgsndr|leadconnectorhq|ludicrous\.cloud|gohighlevel|podium\.com|birdeye|bookingbee|joinreviva|wellnessleads)/i;

export type BookingPageTarget = {
  clinicId: string;
  url: string;
};

/**
 * Pick at most one page per clinic, or none.
 *
 * One, because a second fetch of the same site doubles the cost and the
 * exposure for a marginal chance of a different answer. The first booking-shaped
 * same-origin link is the clinic's own primary path.
 */
export function selectBookingPage(crawl: CrawlResult): BookingPageTarget | null {
  if (crawl.error) return null;

  // Already identified from the homepage. Fetching adds nothing.
  if (detectBooking(crawl.links ?? []).platform) return null;

  const own = crawl.domain.replace(/^www\./, "").toLowerCase();

  for (const raw of crawl.links ?? []) {
    const url = raw.toLowerCase();
    if (NEVER_FETCH.test(url)) continue;
    if (NEVER_REQUEST.test(url)) continue;
    if (!BOOKING_PATH.test(url)) continue;

    // Same origin only. An off-site booking link is already a vendor hostname,
    // which the signature table has seen and either matched or not.
    try {
      const host = new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
      if (host !== own) continue;
    } catch {
      continue;
    }

    return { clinicId: crawl.clinicId, url: raw };
  }

  return null;
}

export type BookingPageFinding = {
  clinicId: string;
  url: string;
  detection: BookingDetection;
};

export type FetchOptions = {
  token: string;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
};

/**
 * Fetch the selected pages through the crawler actor and re-run detection.
 *
 * The same actor, the same proxy and the same settings as the main crawl, so
 * the requests are indistinguishable from it — and so a page that needs
 * rendering to show its widget still renders.
 */
export async function fetchBookingPages(
  targets: BookingPageTarget[],
  options: FetchOptions,
): Promise<BookingPageFinding[]> {
  if (targets.length === 0) return [];

  const client = new ApifyClient({ token: options.token });
  const batchSize = options.batchSize ?? 100;
  const out: BookingPageFinding[] = [];

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);

    const run = await client.actor("apify/website-content-crawler").call({
      startUrls: batch.map((t) => ({ url: t.url })),
      crawlerType: "playwright:adaptive",
      maxCrawlDepth: 0,
      maxCrawlPages: batch.length,
      saveMarkdown: true,
      saveHtml: true,
      htmlTransformer: "none",
      proxyConfiguration: { useApifyProxy: true },
    });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    const byUrl = new Map<string, string>();
    for (const item of items as { url?: string; html?: string }[]) {
      if (item.url && item.html) byUrl.set(item.url.toLowerCase(), item.html);
    }

    for (const target of batch) {
      const html = byUrl.get(target.url.toLowerCase());
      if (!html) continue;

      const links = [
        ...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi),
      ]
        .map((m) => m[1]!)
        .filter((u) => /^https?:\/\//i.test(u));

      const detection = detectBooking(links);
      if (detection.platform) {
        out.push({ clinicId: target.clinicId, url: target.url, detection });
      }
    }

    options.onProgress?.(Math.min(i + batchSize, targets.length), targets.length);
  }

  return out;
}
