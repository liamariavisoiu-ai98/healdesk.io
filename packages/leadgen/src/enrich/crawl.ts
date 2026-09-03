import { ApifyClient } from "apify-client";

/**
 * Fetching what each clinic says about itself.
 *
 * The classification has to come from the clinic's own words, not from a
 * directory tag. Directory categories are assigned by whoever built the
 * directory, are multi-label, and — in this list — are absent for 85% of rows.
 * A homepage is the clinic stating its own primary business.
 *
 * ## Why the rendering crawler
 *
 * `apify/website-content-crawler` runs a real browser. Most clinic sites are
 * Wix, Squarespace or a React theme where the service menu is client-rendered,
 * so a plain HTTP fetch returns a shell with no services in it — and a
 * non-rendering crawler therefore produces confident FALSE NEGATIVES rather
 * than obvious failures. That is the worst possible error here: it looks like
 * data.
 *
 * ## Homepage only, and why — this was a bug once
 *
 * `maxCrawlPages` is a budget for the WHOLE run, not per start URL. The first
 * version paired it with `maxCrawlDepth: 1` and set it to 4, expecting "four
 * pages per clinic". What actually happened: the first site enqueued 140
 * links, the crawler spent the entire budget on it, and stopped — 4 pages
 * fetched across 200 clinics, with 196 reported unreadable. The run exited 0.
 *
 * So depth is 0 and the budget is one page per clinic. That is fair by
 * construction: no site can consume another's share, and the cost is exactly
 * one page-load each rather than something that depends on how many links the
 * unluckiest site happens to have.
 *
 * Little is lost. The homepage carries the nav — which is where the booking
 * link lives — and the hero copy, which is what the classifier's tie-break rule
 * already asks about ("what does the homepage lead with"). The four sites that
 * survived the broken run returned 16 to 43 links and 2,000 to 6,000 characters
 * from the homepage alone, which is both jobs covered.
 */

export type CrawlTarget = {
  clinicId: string;
  domain: string;
};

export type CrawlResult = {
  clinicId: string;
  domain: string;
  /** Concatenated text of the pages fetched, trimmed. Empty when nothing loaded. */
  text: string;
  /**
   * Every outbound link found, deduplicated.
   *
   * This is what identifies the booking system, and it has to come from the
   * crawl because it cannot be recovered afterwards. A clinic's booking
   * platform is almost never named in the page text — it is the href behind a
   * button that says "Book Now". So the text says "Book Now" and the URL says
   * `clients.mindbodyonline.com`, and only one of those is evidence.
   */
  links: string[];
  pagesFetched: number;
  /** Set when the site could not be read at all. Kept, not discarded. */
  error?: string;
};

/** Roughly a page and a half of text — enough to classify, cheap to send. */
const MAX_TEXT_CHARS = 6_000;

/**
 * Links kept per clinic.
 *
 * Generous, because the booking link is often buried behind a nav menu rather
 * than on the homepage hero, and because these are matched by a local regex
 * rather than sent to a model — they cost storage, not tokens.
 */
const MAX_LINKS = 400;

export type CrawlOptions = {
  token: string;
  /** Apify runs are billed by compute; batch so a failure loses one batch. */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function crawlSites(
  targets: CrawlTarget[],
  options: CrawlOptions,
): Promise<CrawlResult[]> {
  const client = new ApifyClient({ token: options.token });
  const batchSize = options.batchSize ?? 200;
  const results: CrawlResult[] = [];

  const usable = targets.filter((t) => t.domain);

  for (let i = 0; i < usable.length; i += batchSize) {
    const batch = usable.slice(i, i + batchSize);

    const run = await client.actor("apify/website-content-crawler").call({
      startUrls: batch.map((t) => ({ url: `https://${t.domain}` })),
      crawlerType: "playwright:adaptive",
      // Start URLs only. See the note above — depth 1 lets one site eat the
      // whole run's page budget.
      maxCrawlDepth: 0,
      // Global, so it must scale with the batch: one page per clinic.
      maxCrawlPages: batch.length,
      // Service menus are the signal; policy pages are noise that crowds out
      // the useful text inside the character budget.
      excludeUrlGlobs: [
        "**/privacy*",
        "**/terms*",
        "**/blog/**",
        "**/careers*",
        "**/*.pdf",
      ],
      // Markdown, not plain text, and not HTML.
      //
      // Plain text discards every href, which is where the booking platform
      // actually lives. Full HTML carries them but costs an order of magnitude
      // more storage and transfer across 4,500 sites, most of it framework
      // noise. Markdown keeps links as `[text](url)` — the anchor text and the
      // destination, which is exactly the pair needed and nothing else.
      saveMarkdown: true,
      saveHtml: false,
      proxyConfiguration: { useApifyProxy: true },
    });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    // Group the pages back onto the clinic that owns the domain.
    const byDomain = new Map<string, { text: string[]; links: Set<string> }>();
    for (const item of items as {
      url?: string;
      text?: string;
      markdown?: string;
    }[]) {
      if (!item.url) continue;
      const host = hostOf(item.url);
      const bucket = byDomain.get(host) ?? { text: [], links: new Set<string>() };

      if (item.text) bucket.text.push(item.text);
      for (const link of linksIn(item.markdown ?? "")) bucket.links.add(link);

      byDomain.set(host, bucket);
    }

    for (const target of batch) {
      const page = byDomain.get(target.domain);
      const pageCount = page?.text.length ?? 0;

      results.push({
        clinicId: target.clinicId,
        domain: target.domain,
        text: (page?.text ?? [])
          .join("\n\n")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_TEXT_CHARS),
        links: [...(page?.links ?? [])].slice(0, MAX_LINKS),
        pagesFetched: pageCount,
        // A site that did not load is a fact worth keeping. Dropping it would
        // silently shrink the denominator and flatter every segment share.
        error: pageCount === 0 ? "no pages fetched" : undefined,
      });
    }

    options.onProgress?.(Math.min(i + batchSize, usable.length), usable.length);
  }

  // A few dead domains in a list this age is normal. Most of them failing is
  // not a fact about the internet, it is a fact about this configuration —
  // and the first version of this file proved it by fetching 4 pages across
  // 200 clinics and exiting 0. Nothing downstream can tell the difference
  // between a site that would not load and one that was never attempted, so
  // the check belongs here, where the distinction still exists.
  const failed = results.filter((r) => r.error).length;
  if (results.length >= 20 && failed / results.length > 0.5) {
    throw new Error(
      `${failed} of ${results.length} sites returned nothing. That is a crawler ` +
        `configuration problem, not ${failed} broken websites — check ` +
        `maxCrawlPages (it is a budget for the whole run, not per site) and the ` +
        `Apify run log. Refusing to write a crawl this empty, because every ` +
        `stage after it would treat the gap as data.`,
    );
  }

  return results;
}

/**
 * Asset URLs, which are never booking links.
 *
 * A WordPress homepage yields dozens of /wp-content/ image URLs. They cannot
 * identify a booking platform and they crowd genuine links out of the per-site
 * cap, so a clinic whose booking button sits below a photo gallery could
 * otherwise lose it to the truncation.
 */
const ASSET = /\.(webp|png|jpe?g|gif|svg|ico|css|js|woff2?|ttf|eot|mp4|webm|pdf)(\?|$)/i;

/**
 * Pull hrefs out of markdown.
 *
 * Covers both shapes the crawler emits: inline `[text](url)` and bare
 * autolinks. Anchor text is deliberately discarded — "Book Now" is the same
 * three words on a Mindbody widget and a mailto, so the destination is the only
 * part that carries information.
 */
function linksIn(markdown: string): string[] {
  const found: string[] = [];

  for (const match of markdown.matchAll(/\]\(\s*(https?:\/\/[^\s)]+)/gi)) {
    found.push(match[1]!);
  }
  for (const match of markdown.matchAll(/<(https?:\/\/[^\s>]+)>/gi)) {
    found.push(match[1]!);
  }

  return found.filter((url) => !ASSET.test(url));
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}
