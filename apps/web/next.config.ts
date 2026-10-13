import type { NextConfig } from "next";

// A relative import on purpose: next.config.ts is transpiled by Next's own
// loader outside the app bundle, where the "@/…" alias does not exist.
import { GOOGLE_DOCS_ORIGIN, RETELL_CALL_ORIGINS, readSecurityHeadersEnv, securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // This app handles no PHI, but the chat route proxies user text to a model —
  // keep the surface tight anyway.
  poweredByHeader: false,

  /**
   * Pages retired on 9 October 2026 (owner's decisions), kept answering so an
   * old link, a bookmark or a search result lands somewhere real rather than
   * on the 404.
   *
   * /pricing was retired the same day with a temporary (307) redirect to the
   * homepage, temporary so that it would not outlive a pricing page that came
   * back. It came back with the step pricing of 13 October 2026, so the
   * redirect is gone and the address serves the page again.
   *
   * /trust → /terms#security is permanent (308): its content is the terms'
   * closing annex, "How we protect data", for good. The fragment reaches the
   * browser in the Location header, which scrolls to the annex.
   *
   * /subprocessors is not redirected. No vendor is named publicly any more;
   * the list is given to signed clinics on request, so the address has no
   * successor page and answers 404.
   */
  async redirects() {
    return [
      { source: "/trust", destination: "/terms#security", permanent: true },
    ];
  },

  /**
   * CSP, HSTS, Permissions-Policy and the rest live in src/lib/security-headers.ts
   * as data, with the origin inventory and the nonce trade-off written down next
   * to the directives, and a unit test that fails if a directive goes missing.
   *
   * The environment is read once here, at BUILD time: Next evaluates
   * `headers()` during `next build` and bakes the result into
   * .next/routes-manifest.json, which `next start` serves as-is. So the
   * toggles below belong on the build, not on the running server. On Vercel
   * that is automatic (project env vars are present at build); locally it is
   * `CSP_REPORT_ONLY=1 npx next build`. `CSP_REPORT_ONLY=1` emits
   * Content-Security-Policy-Report-Only instead of the enforcing header so
   * the policy can be watched on a preview deployment before it ships;
   * `CSP_REPORT_URI` optionally adds a `report-uri` to collect the reports.
   *
   * `/:path*` matches the root as well, so this covers every page and every
   * route handler. Routes that set their own headers (the chat stream's
   * no-store) keep them: nothing in this list carries Cache-Control or
   * Content-Type, and the one shared key, X-Content-Type-Options, agrees.
   *
   * The second entry is the one per-route variation: /admin/crm frames the
   * marketing Sheet, so `/admin/:path*` (which also matches `/admin` itself)
   * gets a CSP whose frame-src allows docs.google.com beside the Calendly
   * every page frames, and nothing else. It MUST come after the generic
   * entry. Next's documented rule (headers.md, "Header Overriding Behavior")
   * is that when two entries match the same path and set the same key, the
   * last one wins; put this first and the generic frame-src, Calendly's
   * alone, would override it on every admin page.
   *
   * The third is the personalised demo (`/demo/:path*`): its visitor can
   * talk to the clinic's assistant from the browser, so it alone gets the
   * microphone and Retell's call origins, plus `https:` images for the
   * clinic's own logo. Same ordering rule, and it does not match /admin.
   *
   * The fourth is the homepage alone (`/`, which matches nothing but the
   * root): since 9 October 2026 its voice card offers the same browser call,
   * to AYA, so it gets the microphone and Retell's call origins too, and no
   * other page does.
   */
  async headers() {
    const env = readSecurityHeadersEnv(process.env);
    return [
      {
        source: "/:path*",
        headers: securityHeaders(env),
      },
      {
        source: "/admin/:path*",
        headers: securityHeaders(env, { frameSources: [GOOGLE_DOCS_ORIGIN] }),
      },
      {
        source: "/demo/:path*",
        headers: securityHeaders(env, {
          connectSources: RETELL_CALL_ORIGINS,
          imageSources: ["https:"],
          microphone: true,
        }),
      },
      {
        source: "/",
        headers: securityHeaders(env, {
          connectSources: RETELL_CALL_ORIGINS,
          microphone: true,
        }),
      },
    ];
  },
};

export default nextConfig;
