import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { CRAWL_DISALLOW } from "./seo";

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
  it("lists exactly the public pages, as absolute URLs", () => {
    expect(sitemap().map((entry) => entry.url)).toEqual([
      "https://healdesk.io/",
      "https://healdesk.io/pricing",
      "https://healdesk.io/contact",
      "https://healdesk.io/privacy",
      "https://healdesk.io/terms",
      "https://healdesk.io/subprocessors",
      "https://healdesk.io/trust",
      "https://healdesk.io/why-wait",
      "https://healdesk.io/data-deletion",
    ]);
  });

  it("never lists a URL that robots.txt disallows", () => {
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname;
      for (const blocked of CRAWL_DISALLOW) {
        expect(path.startsWith(blocked)).toBe(false);
      }
    }
  });

  it("carries no lastModified, so a deploy does not claim every page changed", () => {
    for (const entry of sitemap()) {
      expect(entry.lastModified).toBeUndefined();
    }
  });
});
