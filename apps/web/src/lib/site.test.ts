import { describe, expect, test } from "vitest";

import { normalizeSiteUrl } from "@/lib/site";

/**
 * NEXT_PUBLIC_SITE_URL is typed by hand into Vercel, and a bare domain or an
 * empty value used to fail every Production build at layout.tsx's
 * `new URL(site.url)` while Preview, with the variable unset, passed.
 */
describe("normalizeSiteUrl", () => {
  test("unset or blank is null, so the caller's fallback applies", () => {
    expect(normalizeSiteUrl(undefined)).toBeNull();
    expect(normalizeSiteUrl("")).toBeNull();
    expect(normalizeSiteUrl("  \n")).toBeNull();
  });

  test("a bare domain gains https", () => {
    expect(normalizeSiteUrl("healdesk.io")).toBe("https://healdesk.io");
    expect(normalizeSiteUrl("www.healdesk.io")).toBe("https://www.healdesk.io");
  });

  test("whitespace and a trailing slash go, since callers append a path", () => {
    expect(normalizeSiteUrl(" https://healdesk.io/\n")).toBe("https://healdesk.io");
  });

  test("a full origin passes through, including a local one", () => {
    expect(normalizeSiteUrl("https://healdesk.io")).toBe("https://healdesk.io");
    expect(normalizeSiteUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  test("anything still not a URL names the variable", () => {
    expect(() => normalizeSiteUrl("https://")).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });
});
