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
  /**
   * How many Apify runs to have in flight at once. Default 1.
   *
   * This was the last stage still strictly sequential. On the batch-2 run it
   * had 618 pages to fetch, which at ~25 minutes per batch of 100 is close to
   * three hours with seven other CPUs idle and a plan allowing 32 concurrent
   * runs.
   */
  concurrency?: number;
  /**
   * Called after every batch with everything found so far.
   *
   * Without it nothing reached disk until all seven batches finished, so
   * stopping the run at batch two discarded both batches of paid fetches. That
   * is not hypothetical: it happened, and it is what prompted this rewrite.
   */
  onBatch?: (partial: BookingPageFinding[]) => Promise<void> | void;
  /** Test seam, as in crawl.ts and places.ts. Replaces the Apify call. */
  runBatch?: (batch: BookingPageTarget[]) => Promise<BookingPageFinding[]>;
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
  const concurrency = Math.max(1, options.concurrency ?? 1);

  const batches: BookingPageTarget[][] = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    batches.push(targets.slice(i, i + batchSize));
  }

  /** Indexed, so output order follows input rather than who finishes first. */
  const slots: BookingPageFinding[][] = batches.map(() => []);
  const flatten = (): BookingPageFinding[] => slots.flat();
  let completed = 0;

  /** Serialised, because two writers into one file leave a truncated document. */
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

  const fetchOne = async (batch: BookingPageTarget[]): Promise<BookingPageFinding[]> => {
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

    // .call() resolves for FAILED and ABORTED exactly as for SUCCEEDED, so a
    // broken run would otherwise read back as "no booking platform found" for
    // every clinic in the batch and be checkpointed as fact.
    if (run.status !== "SUCCEEDED") {
      throw new Error(`booking-page batch ended ${run.status} (run ${run.id})`);
    }

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    const byUrl = new Map<string, string>();
    for (const item of items as { url?: string; html?: string }[]) {
      if (item.url && item.html) byUrl.set(item.url.toLowerCase(), item.html);
    }

    const found: BookingPageFinding[] = [];
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
        found.push({ clinicId: target.clinicId, url: target.url, detection });
      }
    }
    return found;
  };

  const runBatch = async (index: number): Promise<void> => {
    const batch = batches[index]!;
    slots[index] = await (options.runBatch ?? fetchOne)(batch);
    completed += batch.length;
    options.onProgress?.(completed, targets.length);
    await persist();
  };

  // Probe batch alone before fan-out, as in crawl.ts: eight batches launched
  // together are all billed before the first result can be inspected.
  await runBatch(0);

  let cursor = 1;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;
      try {
        await runBatch(index);
      } catch (error) {
        // One batch failing must not abandon the rest; they are separate Apify
        // runs and already paid for or in flight. A failed batch contributes no
        // findings, which is the same as finding nothing — acceptable here,
        // because a missed booking page only weakens a clinic's angle rather
        // than putting a false claim in an email.
        failures.push(error);
        completed += batches[index]!.length;
        options.onProgress?.(completed, targets.length);
        await persist();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(batches.length - 1, 1)) }, worker),
  );
  await writeChain;

  if (failures.length) {
    console.error(
      `\n  ${failures.length} of ${batches.length} booking-page batches failed.`,
    );
  }

  return flatten();
}
