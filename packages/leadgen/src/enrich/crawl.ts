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
 * ## Why these page limits
 *
 * The homepage plus a couple of service pages is enough to name the primary
 * offering, and going deeper multiplies cost across 4,500 domains for very
 * little extra signal. `maxCrawlDepth: 1` and `maxCrawlPages: 4` keeps the run
 * to roughly one page-load per clinic plus a shallow menu crawl.
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
  pagesFetched: number;
  /** Set when the site could not be read at all. Kept, not discarded. */
  error?: string;
};

/** Roughly a page and a half of text — enough to classify, cheap to send. */
const MAX_TEXT_CHARS = 6_000;

export type CrawlOptions = {
  token: string;
  /** Apify runs are billed by compute; batch so a failure loses one batch. */
  batchSize?: number;
  maxPagesPerSite?: number;
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
      maxCrawlDepth: 1,
      maxCrawlPages: options.maxPagesPerSite ?? 4,
      // Service menus are the signal; policy pages are noise that crowds out
      // the useful text inside the character budget.
      excludeUrlGlobs: [
        "**/privacy*",
        "**/terms*",
        "**/blog/**",
        "**/careers*",
        "**/*.pdf",
      ],
      saveMarkdown: false,
      saveHtml: false,
      proxyConfiguration: { useApifyProxy: true },
    });

    const { items } = await client
      .dataset(run.defaultDatasetId)
      .listItems({ clean: true });

    // Group the pages back onto the clinic that owns the domain.
    const byDomain = new Map<string, string[]>();
    for (const item of items as { url?: string; text?: string }[]) {
      if (!item.url || !item.text) continue;
      const host = hostOf(item.url);
      const bucket = byDomain.get(host) ?? [];
      bucket.push(item.text);
      byDomain.set(host, bucket);
    }

    for (const target of batch) {
      const pages = byDomain.get(target.domain) ?? [];
      results.push({
        clinicId: target.clinicId,
        domain: target.domain,
        text: pages.join("\n\n").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS),
        pagesFetched: pages.length,
        // A site that did not load is a fact worth keeping. Dropping it would
        // silently shrink the denominator and flatter every segment share.
        error: pages.length === 0 ? "no pages fetched" : undefined,
      });
    }

    options.onProgress?.(Math.min(i + batchSize, usable.length), usable.length);
  }

  return results;
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}
