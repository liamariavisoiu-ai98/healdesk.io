import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { portalSignInUrl } from "./portal-link";

/**
 * The site's "Sign in" link to the clinic portal: the portal's own /sign-in on
 * its public origin, from NEXT_PUBLIC_PORTAL_URL, and nothing at all while the
 * variable is unset or not a public https origin.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portalSignInUrl", () => {
  test("the portal's /sign-in, on the origin given, whatever path it carries", () => {
    expect(portalSignInUrl("https://app.healdesk.io")).toBe("https://app.healdesk.io/sign-in");
    expect(portalSignInUrl("https://app.healdesk.io/")).toBe("https://app.healdesk.io/sign-in");
    expect(portalSignInUrl(" https://app.healdesk.io/sign-in?x=1 ")).toBe(
      "https://app.healdesk.io/sign-in",
    );
    expect(portalSignInUrl("http://localhost:3001")).toBe("http://localhost:3001/sign-in");
  });

  test("no link while unset, blank, not https, or not a URL", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "app.healdesk.io",
      "http://app.healdesk.io",
      "ftp://app.healdesk.io",
      "javascript:alert(1)",
      "https://user:pw@app.healdesk.io",
    ]) {
      expect(portalSignInUrl(value), String(value)).toBeNull();
    }
  });

  test("read from NEXT_PUBLIC_PORTAL_URL by default", () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "");
    expect(portalSignInUrl()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://app.healdesk.io");
    expect(portalSignInUrl()).toBe("https://app.healdesk.io/sign-in");
  });
});

describe("the navbar and the footer", () => {
  async function render(): Promise<{ nav: string; footer: string }> {
    const [{ Nav }, { Footer }] = await Promise.all([
      import("@/components/Nav"),
      import("@/components/Footer"),
    ]);
    return { nav: renderToStaticMarkup(h(Nav)), footer: renderToStaticMarkup(h(Footer)) };
  }

  test("carry no Sign in link while the variable is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "");
    const { nav, footer } = await render();
    expect(nav).not.toContain("Sign in");
    expect(footer).not.toContain("Sign in");
  });

  test("link Sign in to the portal's /sign-in once it is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://app.healdesk.io");
    const { nav, footer } = await render();
    for (const markup of [nav, footer]) {
      expect(markup).toMatch(/<a href="https:\/\/app\.healdesk\.io\/sign-in"[^>]*>Sign in<\/a>/);
    }
  });
});
