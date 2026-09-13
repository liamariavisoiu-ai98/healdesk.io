import type { MetadataRoute } from "next";

import { CRAWL_DISALLOW, absoluteUrl } from "@/lib/seo";

/**
 * /robots.txt, generated so the disallow list and the sitemap share a source.
 * See src/lib/seo.ts for what is kept out and why.
 *
 * One rule for every agent. There is no reason to treat Googlebot and Bingbot
 * differently on a five-page marketing site, and a per-agent list is one more
 * thing to keep in step.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...CRAWL_DISALLOW],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
