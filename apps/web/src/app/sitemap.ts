import type { MetadataRoute } from "next";

import { livePieces, piecePath } from "@/lib/content/registry";
import { PUBLIC_ROUTES, absoluteUrl } from "@/lib/seo";

/**
 * /sitemap.xml, from the same list as robots.txt (src/lib/seo.ts), plus every
 * live article from the content registry.
 *
 * `lastModified` is each page's real edit date, typed on its route entry or
 * taken from an article's last-reviewed date, and never the deploy time:
 * stamping every URL with "now" on each request tells crawlers the whole site
 * changed every time they look. Google reads these dates in place of
 * IndexNow, which it does not take (src/lib/indexnow.ts).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: MetadataRoute.Sitemap = PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    lastModified: route.lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
  const articles: MetadataRoute.Sitemap = livePieces().map((piece) => ({
    url: absoluteUrl(piecePath(piece)),
    lastModified: piece.lastReviewed,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  return [...pages, ...articles];
}
