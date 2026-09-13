import type { NextConfig } from "next";

// A relative import on purpose: next.config.ts is transpiled by Next's own
// loader outside the app bundle, where the "@/…" alias does not exist.
import { readSecurityHeadersEnv, securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // This app handles no PHI, but the chat route proxies user text to a model —
  // keep the surface tight anyway.
  poweredByHeader: false,

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
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(readSecurityHeadersEnv(process.env)),
      },
    ];
  },
};

export default nextConfig;
