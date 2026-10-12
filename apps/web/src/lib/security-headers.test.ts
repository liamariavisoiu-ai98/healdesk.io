import { describe, expect, it } from "vitest";

import { site } from "@/lib/site";

import {
  CALENDLY_ORIGIN,
  CSP_DIRECTIVES,
  GOOGLE_DOCS_ORIGIN,
  POSTHOG_ASSETS_ORIGIN,
  POSTHOG_INGEST_ORIGIN,
  STRIPE_CHECKOUT_ORIGIN,
  contentSecurityPolicy,
  readSecurityHeadersEnv,
  securityHeaders,
  type SecurityHeadersEnv,
} from "./security-headers";

const production: SecurityHeadersEnv = {
  nodeEnv: "production",
  cspReportOnly: undefined,
  cspReportUri: undefined,
  vercelEnv: "production",
};

/** Parse a serialised policy back into directive → sources, for assertions. */
function parse(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

function header(env: SecurityHeadersEnv, key: string): string | undefined {
  return securityHeaders(env).find((h) => h.key === key)?.value;
}

describe("contentSecurityPolicy", () => {
  const csp = parse(contentSecurityPolicy(production));

  it("emits every directive the policy promises", () => {
    for (const name of CSP_DIRECTIVES) expect(csp.has(name), name).toBe(true);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("never allows eval in production", () => {
    expect(contentSecurityPolicy(production)).not.toContain("'unsafe-eval'");
  });

  it("refuses to be framed and refuses plugins", () => {
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
  });

  it("locks the defaults to self", () => {
    expect(csp.get("default-src")).toEqual(["'self'"]);
    // Fonts are self-hosted by next/font; a font CDN here would be a regression.
    expect(csp.get("font-src")).toEqual(["'self'"]);
  });

  it("allows PostHog US and nothing else third-party for scripts and connections", () => {
    expect(POSTHOG_ASSETS_ORIGIN).toBe("https://us-assets.i.posthog.com");
    expect(POSTHOG_INGEST_ORIGIN).toBe("https://us.i.posthog.com");
    expect(contentSecurityPolicy(production)).not.toMatch(/eu[.-]/);
    expect(csp.get("script-src")).toContain(POSTHOG_ASSETS_ORIGIN);
    expect(csp.get("connect-src")).toEqual(
      expect.arrayContaining([POSTHOG_INGEST_ORIGIN, POSTHOG_ASSETS_ORIGIN]),
    );
    const external = (name: string) =>
      (csp.get(name) ?? []).filter((s) => s.startsWith("http") || s.startsWith("ws"));
    expect(external("script-src")).toEqual([POSTHOG_ASSETS_ORIGIN]);
    expect(external("connect-src").sort()).toEqual([POSTHOG_ASSETS_ORIGIN, POSTHOG_INGEST_ORIGIN].sort());
  });

  // Checkout is a redirect to Stripe-hosted Checkout, not an embedded Stripe.js,
  // so Stripe belongs in form-action only. If Stripe.js is ever added this test
  // is the reminder that script-src and frame-src need js.stripe.com too.
  it("lets forms post to Stripe Checkout but does not load Stripe.js", () => {
    expect(csp.get("form-action")).toEqual(["'self'", STRIPE_CHECKOUT_ORIGIN]);
    expect(contentSecurityPolicy(production)).not.toContain("js.stripe.com");
    expect(csp.get("frame-src")).not.toContain("https://js.stripe.com");
  });

  // "Get in touch" frames Calendly's booking page on every page with the
  // navbar; /admin/crm also frames the marketing Sheet. Those are the only
  // origins the site may frame. next.config.ts applies the admin variant to
  // `/admin/:path*` after the generic entry, which is what makes it win under
  // Next's last-match-wins rule.
  it("frames only Calendly by default, and docs.google.com as well on the admin variant", () => {
    expect(csp.get("frame-src")).toEqual([CALENDLY_ORIGIN]);
    // The modal frames the meeting link's own origin; the two move together.
    expect(new URL(site.meeting.url).origin).toBe(CALENDLY_ORIGIN);
    const admin = parse(contentSecurityPolicy(production, { frameSources: [GOOGLE_DOCS_ORIGIN] }));
    expect(admin.get("frame-src")).toEqual([CALENDLY_ORIGIN, GOOGLE_DOCS_ORIGIN]);
    for (const name of CSP_DIRECTIVES) {
      if (name !== "frame-src") expect(admin.get(name), name).toEqual(csp.get(name));
    }
    // The headers list carries the variant, and only the CSP differs.
    const base = securityHeaders(production);
    const variant = securityHeaders(production, { frameSources: [GOOGLE_DOCS_ORIGIN] });
    expect(variant.map((h) => h.key)).toEqual(base.map((h) => h.key));
    expect(variant.filter((h, i) => h.value !== base[i]!.value).map((h) => h.key)).toEqual(["Content-Security-Policy"]);
    // Being framed is still refused everywhere, including on /admin.
    expect(admin.get("frame-ancestors")).toEqual(["'none'"]);
    expect(variant.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
    // An empty option is the default policy, not an empty directive.
    expect(contentSecurityPolicy(production, { frameSources: [] })).toBe(contentSecurityPolicy(production));
    // On preview the toolbar host is kept alongside.
    const preview = parse(contentSecurityPolicy({ ...production, vercelEnv: "preview" }, { frameSources: [GOOGLE_DOCS_ORIGIN] }));
    expect(preview.get("frame-src")).toEqual(["https://vercel.live", CALENDLY_ORIGIN, GOOGLE_DOCS_ORIGIN]);
  });

  it("lets the videos play, and no longer allows what the 3D hero needed", () => {
    expect(csp.get("media-src")).toEqual(["'self'", "blob:"]);
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    // The glTF hero, removed on 3 October 2026, was the only reason for these.
    expect(csp.get("connect-src")).not.toContain("blob:");
    expect(csp.get("script-src")).not.toContain("'wasm-unsafe-eval'");
  });

  it("adds unsafe-eval and drops the https upgrade only in development", () => {
    const dev = parse(contentSecurityPolicy({ ...production, nodeEnv: "development" }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
    // An unset NODE_ENV is production, not development.
    expect(contentSecurityPolicy({ ...production, nodeEnv: undefined })).not.toContain("'unsafe-eval'");
  });

  it("allows the Vercel toolbar on preview deployments only", () => {
    const preview = contentSecurityPolicy({ ...production, vercelEnv: "preview" });
    expect(preview).toContain("https://vercel.live");
    expect(contentSecurityPolicy(production)).not.toContain("vercel.live");
    expect(contentSecurityPolicy({ ...production, vercelEnv: undefined })).not.toContain("vercel.live");
  });

  it("appends a report-uri only when one is configured", () => {
    expect(contentSecurityPolicy(production)).not.toContain("report-uri");
    const reported = contentSecurityPolicy({ ...production, cspReportUri: "https://example.com/csp" });
    expect(reported.endsWith("report-uri https://example.com/csp")).toBe(true);
  });

  it("serialises with no stray whitespace or empty directives", () => {
    const value = contentSecurityPolicy(production);
    expect(value).not.toMatch(/\s{2,}/);
    expect(value).not.toMatch(/;\s*;/);
    expect(value.endsWith(";")).toBe(false);
  });
});

describe("securityHeaders", () => {
  it("enforces by default and switches to report-only on CSP_REPORT_ONLY", () => {
    expect(header(production, "Content-Security-Policy")).toBeDefined();
    expect(header(production, "Content-Security-Policy-Report-Only")).toBeUndefined();

    for (const flag of ["1", "true", " TRUE "]) {
      const env = { ...production, cspReportOnly: flag };
      expect(header(env, "Content-Security-Policy-Report-Only"), flag).toBe(
        contentSecurityPolicy(production),
      );
      expect(header(env, "Content-Security-Policy"), flag).toBeUndefined();
    }
    for (const flag of ["0", "false", ""]) {
      expect(header({ ...production, cspReportOnly: flag }, "Content-Security-Policy"), flag).toBeDefined();
    }
  });

  it("carries the remaining headers a scanner looks for", () => {
    expect(header(production, "Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(header(production, "X-Content-Type-Options")).toBe("nosniff");
    expect(header(production, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header(production, "X-Frame-Options")).toBe("DENY");
    expect(header(production, "Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  // The site-wide default. Only the two pages with a browser call to an
  // assistant opt in to the microphone (next.config.ts; tested below).
  it("denies camera, microphone, geolocation and payment", () => {
    const policy = header(production, "Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy, feature).toContain(`${feature}=()`);
    }
    expect(policy).not.toContain("microphone=(self)");
  });

  it("has unique keys and does not touch what routes set for themselves", () => {
    const keys = securityHeaders(production).map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
    // /api/chat sets Cache-Control: no-store and its own Content-Type; the
    // global block must not carry either, or Next's last-wins rule could
    // clobber them.
    expect(keys).not.toContain("Cache-Control");
    expect(keys).not.toContain("Content-Type");
  });
});

describe("readSecurityHeadersEnv", () => {
  it("reads exactly the keys the policy depends on", () => {
    expect(
      readSecurityHeadersEnv({
        NODE_ENV: "production",
        CSP_REPORT_ONLY: "1",
        CSP_REPORT_URI: "https://example.com/csp",
        VERCEL_ENV: "preview",
        ANTHROPIC_API_KEY: "must-not-leak-into-the-result",
      }),
    ).toEqual({
      nodeEnv: "production",
      cspReportOnly: "1",
      cspReportUri: "https://example.com/csp",
      vercelEnv: "preview",
    });
  });
});

describe("the routes that may open a microphone", () => {
  // The homepage and the personalised demo carry a browser call to an
  // assistant (owner, 9 October 2026, for the homepage); nothing else may
  // even ask for the microphone.
  it("are exactly the homepage and the personalised demo pages", async () => {
    const { default: config } = await import("../../next.config");
    const entries = (await config.headers?.()) ?? [];
    const withMicrophone = entries
      .filter((entry) =>
        entry.headers.some((h) => h.key === "Permissions-Policy" && h.value.includes("microphone=(self)")),
      )
      .map((entry) => entry.source)
      .sort();
    expect(withMicrophone).toEqual(["/", "/demo/:path*"]);
  });
});
