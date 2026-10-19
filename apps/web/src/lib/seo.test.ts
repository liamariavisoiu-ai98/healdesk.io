import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { livePieces, piecePath } from "@/lib/content/registry";
import { CRAWL_DISALLOW, PUBLIC_ROUTES } from "./seo";

/**
 * The two files are generated from one list precisely so these properties
 * hold; the tests pin them so a later edit to one file cannot quietly break
 * the other.
 */
describe("robots()", () => {
  it("keeps the funnel and private surfaces out of every crawler", () => {
    const out = robots();
    expect(out.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api", "/get-started", "/claim", "/demo"],
    });
  });

  it("points at the sitemap on the site's own origin", () => {
    expect(robots().sitemap).toBe("https://healdesk.io/sitemap.xml");
  });
});

describe("sitemap()", () => {
  it("lists the fixed public pages first, as absolute URLs", () => {
    expect(
      sitemap()
        .map((entry) => entry.url)
        .slice(0, 10),
    ).toEqual([
      "https://healdesk.io/",
      "https://healdesk.io/pricing",
      "https://healdesk.io/contact",
      "https://healdesk.io/privacy",
      "https://healdesk.io/terms",
      "https://healdesk.io/why-wait",
      "https://healdesk.io/data-deletion",
      "https://healdesk.io/guides",
      "https://healdesk.io/about",
      "https://healdesk.io/glossary",
    ]);
  });

  it("lists every live article and nothing else from the registry", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const piece of livePieces()) expect(urls).toContain(`https://healdesk.io${piecePath(piece)}`);
    expect(urls).toHaveLength(PUBLIC_ROUTES.length + livePieces().length);
  });

  it("never lists a URL that robots.txt disallows", () => {
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname;
      for (const blocked of CRAWL_DISALLOW) {
        expect(path.startsWith(blocked)).toBe(false);
      }
    }
  });

  it("dates every URL with a fixed calendar date, never the build time", () => {
    const first = sitemap();
    const second = sitemap();
    expect(second).toEqual(first);
    for (const entry of first) {
      expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
