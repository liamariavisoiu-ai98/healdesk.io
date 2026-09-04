import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

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
  /**
   * Fingerprints beyond hrefs — see extractFingerprints().
   *
   * Cheap to compute, tiny to store, and they catch what URL matching cannot:
   * a white-labelled platform serving from the clinic's own domain has no
   * vendor hostname to match, but still leaves a meta generator tag, a form
   * action, an iframe source, or a distinctive path shape.
   */
  fingerprints?: Fingerprints;
  /** Set when the site could not be read at all. Kept, not discarded. */
  error?: string;
};

/**
 * The non-href evidence a page carries about what software runs it.
 *
 * Every field here exists because a URL signature could not have found it.
 */
export type Fingerprints = {
  /** <meta name="generator"> — names Wix, Squarespace, WordPress outright. */
  generator: string | null;
  /** Distinct URL path shapes, digits and ids masked. Zenoti's /webstoreNew
   *  survived white-labelling as a PATH when its hostname did not. */
  pathShapes: string[];
  /** Where forms post to. A booking form posts to the booking vendor. */
  formActions: string[];
  /** iframe sources — the classic way a widget is embedded. */
  iframes: string[];
  /** Vendor-ish tokens seen in class names and ids, e.g. "wix-bookings". */
  classHints: string[];
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
  /**
   * How many of these targets have never been attempted.
   *
   * The mass-failure guard below is only meaningful over first attempts. On a
   * retry run the target set is, by construction, the domains that already
   * failed — so a high failure rate there is the expected outcome, not evidence
   * of misconfiguration.
   */
  firstAttempts?: number;
  /**
   * Called after every batch, with everything crawled so far.
   *
   * The crawl used to write one file at the very end, which is survivable over
   * 200 domains and reckless over 4,500: an interruption at domain 4,000 threw
   * away every page already paid for. Persisting per batch turns the crawl into
   * something that resumes rather than restarts.
   */
  onBatch?: (results: CrawlResult[]) => Promise<void> | void;
  /** Apify runs are billed by compute; batch so a failure loses one batch. */
  batchSize?: number;
  /**
   * How many Apify runs may be in flight at once.
   *
   * Defaults to 1 — sequential — because that is correct on the free plan,
   * which caps concurrent actor runs at 5 and where a runaway parallel crawl
   * would exhaust a $5 monthly budget before anyone could stop it. Raise it to
   * match the plan: Starter allows 32, and 21 batches at concurrency 8 is
   * roughly 25 minutes rather than 3 hours.
   *
   * Never set this above the plan's concurrent-run cap; Apify queues or rejects
   * the excess rather than running it.
   */
  concurrency?: number;
  /**
   * Where to archive the raw HTML, one gzipped file per clinic.
   *
   * The case for keeping it is not storage convenience, it is the cost of NOT
   * having it. Every fingerprint discovered later — and they will be, this
   * pipeline has found several by hand already — can only be applied to pages
   * still on disk. Without an archive, each new discovery means re-crawling
   * 4,512 domains at roughly $24 a time; with one, it is a local re-scan that
   * costs nothing and takes seconds.
   *
   * Measured at ~74 KB of HTML per clinic, gzip takes that to roughly 12 KB,
   * so the whole list is about 54 MB. That is a rounding error against a single
   * re-crawl, and it is the difference between "we can test that idea" and "we
   * would have to pay to find out".
   *
   * Fingerprints are extracted anyway, because they are countable across the
   * whole list in a way raw HTML is not. The archive answers questions nobody
   * has thought of yet; the fingerprints answer the ones we have.
   */
  htmlDir?: string;
  /**
   * Overrides the Apify call, for tests.
   *
   * The orchestration around it — probe-before-fan-out, slot ordering,
   * serialised writes, one failing batch not taking the others down — is the
   * part most likely to be subtly wrong and the part that cannot be exercised
   * without either a paid API call or a seam. This is the seam.
   */
  runBatch?: (batch: CrawlTarget[]) => Promise<CrawlResult[]>;
  onProgress?: (done: number, total: number) => void;
};

export async function crawlSites(
  targets: CrawlTarget[],
  options: CrawlOptions,
): Promise<CrawlResult[]> {
  const client = new ApifyClient({ token: options.token });
  const batchSize = options.batchSize ?? 200;
  const concurrency = Math.max(1, options.concurrency ?? 1);

  const usable = targets.filter((t) => t.domain);
  const batches: CrawlTarget[][] = [];
  for (let i = 0; i < usable.length; i += batchSize) {
    batches.push(usable.slice(i, i + batchSize));
  }
  if (batches.length === 0) return [];

  /**
   * Results indexed by batch, never appended in completion order.
   *
   * Concurrent batches finish out of order, so pushing as they land would make
   * the output depend on network timing — two identical runs producing
   * differently ordered files, and any diff between them unreadable. Slotting
   * each batch into its own index keeps the result deterministic regardless of
   * who wins the race.
   */
  const slots: CrawlResult[][] = batches.map(() => []);
  const flatten = (): CrawlResult[] => slots.flat();

  let completed = 0;

  /**
   * Persistence is serialised even though the crawls are not.
   *
   * onBatch writes the whole accumulated array to one file. Two writers
   * entering that at once interleave their writes and leave a truncated or
   * doubled JSON document — and the failure is silent until the next run tries
   * to parse it, by which point the crawl has been paid for. So writes are
   * chained: the crawling parallelises, the writing does not.
   *
   * Each write also snapshots the CURRENT state rather than a captured one, so
   * a queued write never persists a stale view.
   */
  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain
      .then(() => options.onBatch?.(flatten()))
      .then(() => undefined)
      // A failed checkpoint must not abort the crawl — the pages are already
      // paid for, and losing them to a transient disk error would be the
      // expensive outcome. It is reported and the run continues.
      .catch((error) => {
        console.error(`\n  checkpoint write failed: ${String(error)}`);
      });
    return writeChain;
  };

  const runBatch = async (index: number): Promise<void> => {
    const run =
      options.runBatch ??
      ((b: CrawlTarget[]) => crawlOneBatch(client, b, options.htmlDir));
    slots[index] = await run(batches[index]!);
    completed += 1;
    options.onProgress?.(
      Math.min(completed * batchSize, usable.length),
      usable.length,
    );
    await persist();
  };

  // ---- The probe batch --------------------------------------------------
  //
  // Deliberately run alone, before any fan-out.
  //
  // The mass-failure guard exists so a misconfiguration costs one batch rather
  // than the whole run — and that property is destroyed by concurrency, because
  // eight batches launched together are all billed before the first result can
  // be inspected. Serialising exactly one batch buys the check back. It costs
  // one batch of latency on a run of twenty-one, and it is the difference
  // between a $1 mistake and a $24 one.
  await runBatch(0);

  const firstAttempts = options.firstAttempts ?? usable.length;
  const probe = slots[0]!;
  const failed = probe.filter((r) => r.error).length;

  if (firstAttempts > 0 && probe.length >= 20 && failed / probe.length > 0.5) {
    throw new Error(
      `${failed} of the first ${probe.length} sites returned nothing. That is a ` +
        `crawler configuration problem, not ${failed} broken websites — check ` +
        `the Apify run log before spending on the rest. Stopping after one ` +
        `batch, because every stage after this would treat the gap as data.`,
    );
  }

  // ---- Everything else, concurrently -------------------------------------
  //
  // A worker pool rather than Promise.all over every batch: Apify enforces a
  // per-plan cap on concurrent actor runs (5 on free, 32 on Starter), and
  // launching twenty-one at once gets them queued or rejected rather than run.
  // Workers pull from a shared cursor, so a slow batch never blocks a free
  // worker from starting the next one.
  let cursor = 1;
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;

      try {
        await runBatch(index);
      } catch (error) {
        // One batch failing must not abandon the others — each is a separate
        // Apify run and the rest are already paid for or in flight. The
        // failures are collected and reported once, after the pool drains.
        failures.push(error);
        slots[index] = batches[index]!.map((t) => ({
          clinicId: t.clinicId,
          domain: t.domain,
          text: "",
          links: [],
          pagesFetched: 0,
          error: `batch failed: ${
            error instanceof Error ? error.message.slice(0, 120) : "unknown"
          }`,
        }));
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length - 1) }, worker),
  );

  // Drain the write chain before returning, or the caller can observe a
  // complete in-memory result while the file on disk is still one batch behind.
  await writeChain;

  if (failures.length) {
    console.error(
      `\n  ${failures.length} of ${batches.length} batches failed; their clinics ` +
        `are recorded with an error and will be retried on the next run.`,
    );
  }

  return flatten();
}

/**
 * One Apify run over one batch of domains.
 *
 * Split out of crawlSites so the orchestration above reads as orchestration.
 * It is pure with respect to the caller — no shared state, no writes — which is
 * what makes it safe to run several at once.
 */
async function crawlOneBatch(
  client: ApifyClient,
  batch: CrawlTarget[],
  htmlDir?: string,
): Promise<CrawlResult[]> {
  const run = await client.actor("apify/website-content-crawler").call({
    startUrls: batch.map((t) => ({ url: `https://${t.domain}` })),
    crawlerType: "playwright:adaptive",
    // Start URLs only. Depth 1 lets one site eat the whole run's page budget.
    maxCrawlDepth: 0,
    // Global, so it must scale with the batch: one page per clinic.
    maxCrawlPages: batch.length,
    // Service menus are the signal; policy pages are noise that crowds out the
    // useful text inside the character budget.
    excludeUrlGlobs: [
      "**/privacy*",
      "**/terms*",
      "**/blog/**",
      "**/careers*",
      "**/*.pdf",
    ],
    // Both, because the two jobs want different views of the same page.
    // Markdown is the readable content, which is right for classification.
    // HTML is only used to harvest hrefs, then dropped.
    saveMarkdown: true,
    saveHtml: true,
    // The setting that actually mattered, found by measuring rather than
    // reasoning: the default transformer extracts readable content and saveHtml
    // then saves ITS OUTPUT, not the page — so links were discarded before
    // saveHtml ever ran. Measured on one clinic homepage, hrefs recovered:
    // "readableText" (default) 44, "none" 93. An attempt to fix this by
    // overriding removeElementsCssSelector made it worse (2), so that stays at
    // its default.
    htmlTransformer: "none",
    proxyConfiguration: { useApifyProxy: true },
  });

  const { items } = await client
    .dataset(run.defaultDatasetId)
    .listItems({ clean: true });

  // Group the pages back onto the clinic that owns the domain.
  const byDomain = new Map<
    string,
    { text: string[]; links: Set<string>; html: string }
  >();
  for (const item of items as {
    url?: string;
    text?: string;
    markdown?: string;
    html?: string;
  }[]) {
    if (!item.url) continue;
    const host = hostOf(item.url);
    const bucket = byDomain.get(host) ?? {
      text: [],
      links: new Set<string>(),
      html: "",
    };

    if (item.text) bucket.text.push(item.text);
    // Markdown first (clean, in-content links), then the raw HTML, which is the
    // only place the nav survives.
    for (const link of linksIn(item.markdown ?? "")) bucket.links.add(link);
    for (const link of hrefsIn(item.html ?? "", item.url)) bucket.links.add(link);
    // Kept only long enough to fingerprint, then dropped — see below.
    if (item.html) bucket.html += item.html;

    byDomain.set(host, bucket);
  }

  // Archived before the HTML goes out of scope. Failures here are logged and
  // ignored: a missing archive costs a future re-crawl, while throwing would
  // cost the pages just paid for.
  if (htmlDir) {
    await mkdir(htmlDir, { recursive: true }).catch(() => {});
    await Promise.all(
      batch.map(async (target) => {
        const html = byDomain.get(target.domain)?.html;
        if (!html) return;
        try {
          await writeFile(
            join(htmlDir, `${target.clinicId}.html.gz`),
            gzipSync(html),
          );
        } catch (error) {
          console.error(`\n  html archive failed for ${target.domain}: ${String(error)}`);
        }
      }),
    );
  }

  return batch.map((target) => {
    const page = byDomain.get(target.domain);
    const pageCount = page?.text.length ?? 0;

    return {
      clinicId: target.clinicId,
      domain: target.domain,
      text: (page?.text ?? [])
        .join("\n\n")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TEXT_CHARS),
      links: [...(page?.links ?? [])].slice(0, MAX_LINKS),
      // Extracted here and the HTML discarded immediately after.
      //
      // Storing the raw HTML would be ~54 MB gzipped across 4,512 clinics,
      // which is affordable — but it is also 74 KB of framework noise per
      // clinic to hold the handful of fields that actually identify software.
      // These fingerprints are a few hundred bytes and answer the same
      // question, and unlike the HTML they can be diffed and counted across
      // the whole list to find patterns nobody has thought to look for yet.
      fingerprints: page
        ? extractFingerprints(page.html, [...page.links])
        : undefined,
      pagesFetched: pageCount,
      // A site that did not load is a fact worth keeping. Dropping it would
      // silently shrink the denominator and flatter every segment share.
      error: pageCount === 0 ? "no pages fetched" : undefined,
    };
  });
}

/**
 * Asset URLs, which are never booking links.
 *
 * A WordPress homepage yields dozens of /wp-content/ image URLs. They cannot
 * identify a booking platform and they crowd genuine links out of the per-site
 * cap, so a clinic whose booking button sits below a photo gallery could
 * otherwise lose it to the truncation.
 */
const ASSET =
  /\.(webp|png|jpe?g|gif|svg|ico|css|woff2?|ttf|eot|mp4|webm|pdf)(\?|$)/i;

/**
 * Scripts are dropped too — except the ones that ARE the evidence.
 *
 * Seven verified signatures point at widget loaders: booking.mangomint.com's
 * app.js, embed.acuityscheduling.com/js/embed.js, booksy's widget/code.js,
 * healcode.js, simplybook's widget.js. Filtering every .js URL as an asset
 * deleted exactly those, so the signatures could never fire — a whole class of
 * detections lost to a filter written for photo galleries.
 */
const SCRIPT = /\.js(\?|$)/i;
const BOOKING_SCRIPT =
  /(mangomint|acuityscheduling|squarespacescheduling|booksy|healcode|simplybook|setmore|leadconnectorhq|msgsndr|birdeye|patientpop)/i;

/** Assets out, booking-widget scripts in. */
function keepable(url: string): boolean {
  if (ASSET.test(url)) return false;
  if (SCRIPT.test(url)) return BOOKING_SCRIPT.test(url);
  return true;
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

  return found.filter(keepable);
}

/**
 * Every href and src in the raw HTML, resolved to absolute.
 *
 * src as well as href: a booking widget arrives as <script src=...>, and
 * matching only href misses every embed-based platform.
 *
 * Relative URLs matter more than they look — a clinic running a self-hosted
 * booking page links to `/book-now`, and without the page URL to resolve
 * against, that is indistinguishable from any other path fragment.
 */
function hrefsIn(html: string, pageUrl?: string): string[] {
  const found: string[] = [];

  for (const match of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    const href = match[1]!.trim();
    if (!href || href.startsWith("#")) continue;

    if (/^https?:\/\//i.test(href)) {
      found.push(href);
    } else if (pageUrl && !/^[a-z]+:/i.test(href)) {
      try {
        found.push(new URL(href, pageUrl).toString());
      } catch {
        // A malformed href is the page's problem, not ours.
      }
    }
  }

  return found.filter(keepable);
}

/**
 * Everything about a page that identifies its software, other than hrefs.
 *
 * This exists because of one clinic. book.vivecenter.com/webstoreNew/services
 * is a Zenoti tenant on the clinic's own domain: no vendor hostname anywhere,
 * so every hostname-anchored signature missed it. What gave it away was the
 * PATH — /webstoreNew is Zenoti's own shape and it travels onto white-labelled
 * domains because the vendor's application, not the customer, defines it.
 *
 * That is the general lesson, and this generalises it. A vendor controls its
 * own routes, its own form endpoints, its own iframe hosts, its own generated
 * class names, and its own generator tag. A customer controls only the domain.
 * So when the domain stops being evidence, everything else still is.
 */
function extractFingerprints(html: string, links: string[]): Fingerprints {
  const generator =
    html.match(
      /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i,
    )?.[1] ??
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i,
    )?.[1] ??
    null;

  // Path shapes with ids masked, so /webstore/12345/services and
  // /webstore/98765/services collapse to one comparable shape. Without the
  // masking every tenant looks unique and nothing can be counted.
  const pathShapes = [
    ...new Set(
      links
        .map((u) => {
          try {
            return new URL(u).pathname
              .toLowerCase()
              .replace(/\/[0-9a-f]{8,}/g, "/:id")
              .replace(/\/\d+/g, "/:n")
              .slice(0, 80);
          } catch {
            return "";
          }
        })
        .filter((p) => p.length > 1),
    ),
  ].slice(0, 60);

  const formActions = [
    ...new Set(
      [...html.matchAll(/<form[^>]+action=["']([^"']+)["']/gi)]
        .map((m) => m[1]!.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

  const iframes = [
    ...new Set(
      [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => m[1]!.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

  // Class and id tokens that name a vendor. Builders generate these and they
  // survive any amount of custom domain configuration — a Wix Bookings widget
  // is still called a Wix Bookings widget in the markup.
  const VENDORISH =
    /\b((?:wix|squarespace|shopify|hubspot|mindbody|healcode|vagaro|zenoti|boulevard|blvd|mangomint|acuity|calendly|booksy|fresha|janeapp|setmore|simplybook|amelia|bookly|ssa|phorest|meevo|nextech|modmed|symplast|aesthetic)[a-z0-9_-]*)/gi;
  const classHints = [
    ...new Set(
      [...html.matchAll(/(?:class|id)=["']([^"']+)["']/gi)]
        .flatMap((m) => [...m[1]!.matchAll(VENDORISH)].map((v) => v[1]!.toLowerCase()))
        .filter(Boolean),
    ),
  ].slice(0, 30);

  return { generator, pathShapes, formActions, iframes, classHints };
}

function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}
