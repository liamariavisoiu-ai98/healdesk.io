import type { MetadataRoute } from "next";

import { PUBLIC_ROUTES, absoluteUrl } from "@/lib/seo";

/**
 * /sitemap.xml, from the same list as robots.txt. See src/lib/seo.ts.
 *
 * No `lastModified`. The honest value would be the deploy time, and stamping
 * every URL with "now" on each request tells crawlers the whole site changed
 * every time they look, which is worse than saying nothing. When a page has a
 * real edit date to report, put it on the route entry in seo.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route.path),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
