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
 * calculator, pricing, contact, and the legal and trust pages. Every path here
 * exists on disk; a path is added in the same commit as its page so the
 * sitemap never has to be remembered later, which is how legal pages end up
 * unindexed for a year.
 *
 * ## What is kept out
 *
 * /get-started is the purchase funnel. It carries its own noindex, but a
 * per-page noindex only works once the page has been crawled, and until then
 * a link-tracking rewrite from a cold email is enough to get the URL into an
 * index. The robots disallow stops the crawl before that. /admin and /claim
 * are private surfaces, and /api is not a page at all.
 *
 * Paths are absolute so the same list builds URLs from every base.
 */
export const PUBLIC_ROUTES = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.9 },
  { path: "/contact", changeFrequency: "monthly", priority: 0.7 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
  { path: "/subprocessors", changeFrequency: "monthly", priority: 0.3 },
  { path: "/trust", changeFrequency: "monthly", priority: 0.5 },
  { path: "/why-wait", changeFrequency: "monthly", priority: 0.8 },
] as const satisfies ReadonlyArray<{
  path: `/${string}`;
  changeFrequency: "weekly" | "monthly" | "yearly";
  priority: number;
}>;

export const CRAWL_DISALLOW = ["/admin", "/api", "/get-started", "/claim"] as const;

/**
 * `site.url` is read at call time rather than captured at import, so a test
 * that sets NEXT_PUBLIC_SITE_URL before importing sees its own base, and a
 * build with the variable unset falls back to the production domain rather
 * than to nothing.
 */
export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
