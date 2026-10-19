import { site } from "@/lib/site";

/**
 * What crawlers may see, in one place.
 *
 * app/robots.ts and app/sitemap.ts both read from here so the two cannot
 * disagree: a path that is disallowed below is never listed in the sitemap,
 * and a path in the sitemap is never disallowed. Google treats that particular
 * contradiction as a signal that the site is misconfigured, and it is the
 * easiest one to ship by accident when the lists live in two files.
 *
 * ## What is listed
 *
 * The public pages a stranger should be able to find: the homepage, the
 * calculator, contact, and the legal pages. Every path here exists on disk; a
 * path is added in the same commit as its page so the sitemap never has to be
 * remembered later, which is how legal pages end up unindexed for a year, and
 * leaves in the same commit as its page. /pricing, /subprocessors and /trust
 * left on 9 October 2026 (owner's decisions): /pricing and /trust redirect
 * (next.config.ts), and a redirect is not a page to list.
 *
 * ## What is kept out
 *
 * /get-started is the purchase funnel. It carries its own noindex, but a
 * per-page noindex only works once the page has been crawled, and until then
 * a link-tracking rewrite from a cold email is enough to get the URL into an
 * index. The robots disallow stops the crawl before that. /admin and /claim
 * are private surfaces, /demo holds one prospect's personalised demo per
 * unguessable link, and /api is not a page at all.
 *
 * Paths are absolute so the same list builds URLs from every base.
 */
export const PUBLIC_ROUTES = [
  { path: "/", changeFrequency: "weekly", priority: 1, lastModified: "2026-10-19" },
  // Back on 13 October 2026, with the step pricing (app/pricing/page.tsx).
  { path: "/pricing", changeFrequency: "monthly", priority: 0.8, lastModified: "2026-10-19" },
  { path: "/contact", changeFrequency: "monthly", priority: 0.7, lastModified: "2026-10-12" },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3, lastModified: "2026-10-14" },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3, lastModified: "2026-10-14" },
  { path: "/why-wait", changeFrequency: "monthly", priority: 0.8, lastModified: "2026-10-12" },
  // The deletion instructions Meta's App Review asks for, linked from the
  // footer and from privacy § 13.
  { path: "/data-deletion", changeFrequency: "yearly", priority: 0.3, lastModified: "2026-10-14" },
  // The editorial library (strategy of 14 October 2026): the hub, the About
  // page every article's byline links to, and the glossary. The articles
  // themselves are listed from the content registry by app/sitemap.ts, each
  // with its own last-reviewed date.
  { path: "/guides", changeFrequency: "weekly", priority: 0.7, lastModified: "2026-10-19" },
  { path: "/about", changeFrequency: "monthly", priority: 0.5, lastModified: "2026-10-19" },
  { path: "/glossary", changeFrequency: "monthly", priority: 0.5, lastModified: "2026-10-19" },
] as const satisfies ReadonlyArray<{
  path: `/${string}`;
  changeFrequency: "weekly" | "monthly" | "yearly";
  priority: number;
  /**
   * The date the page's content last changed, by hand, never the build time:
   * stamping every URL with "now" tells crawlers the whole site changed on
   * every deploy. Bump it in the commit that changes what the page says.
   */
  lastModified: `${number}-${number}-${number}`;
}>;

export const CRAWL_DISALLOW = ["/admin", "/api", "/get-started", "/claim", "/demo"] as const;

/**
 * `site.url` is read at call time rather than captured at import, so a test
 * that sets NEXT_PUBLIC_SITE_URL before importing sees its own base, and a
 * build with the variable unset falls back to the production domain rather
 * than to nothing.
 */
export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
