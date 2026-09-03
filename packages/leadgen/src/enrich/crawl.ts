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

  return results;
}

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

  return found;
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}
