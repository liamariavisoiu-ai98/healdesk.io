/**
 * The response headers every page and route on healdesk.io carries, as data.
 *
 * next.config.ts wires this into `headers()`; this file is where the policy
 * lives so it can be unit-tested without booting Next, and so the answer to
 * "why is origin X allowed" is one grep away from the directive that allows it.
 *
 * ## Why this exists at all
 *
 * This is the site that takes payment and, in checkout, presents the BAA a
 * clinic signs. A clinic's IT reviewer runs a header scan before approving a
 * vendor, and a missing Content-Security-Policy on a healthcare-adjacent
 * purchase flow is a finding they send back. Concretely: without HSTS the
 * first request after the DNS cutover is plaintext and downgradeable, and
 * without a CSP any script injected on /get-started can read the clinic's
 * details as they are typed.
 *
 * ## The origin inventory (re-check this when adding a third-party anything)
 *
 * Everything the pages load today is same-origin:
 *   - Fonts: Fraunces and Hanken Grotesk come through next/font (self-hosted
 *     at build time) and TAN Ashford is a local woff2. No font CDN, so no
 *     fonts.googleapis.com / fonts.gstatic.com here, and adding them would be
 *     a regression, not a fix.
 *   - Video: the niche cards and HealdeskSoul play from /public (webm + mp4),
 *     and HealdeskSoul's posters are local images (a PNG for the demo panels,
 *     a WebP for the hero), as are the hero's logos. `blob:` is allowed in media-src
 *     because MediaSource-backed playback surfaces as a blob: URL and it costs
 *     nothing to permit.
 *   - No WebAssembly and no blob: fetches. The 3D hero needed both
 *     (`'wasm-unsafe-eval'` for its MeshoptDecoder, `blob:` in connect-src for
 *     its texture) and was removed on 3 October 2026, so both went with it.
 *   - Payment: checkout POSTs to /api/checkout and then `location.assign`s the
 *     Stripe-hosted Checkout URL. There is NO Stripe.js on the page, so
 *     js.stripe.com is deliberately absent from script-src and there is no
 *     frame-src for it either. checkout.stripe.com appears only in
 *     form-action, which is harmless today (the hop is a script navigation,
 *     not a form submit) and correct the day a plain <form> posts there.
 *   - Analytics: PostHog on its US cloud, per the owner's decision of
 *     23 September 2026 (the client base is US). The snippet loads from
 *     us-assets.i.posthog.com and sends events to us.i.posthog.com (also
 *     lazily fetching modules such as the recorder from the assets host, hence
 *     both in connect-src). Nothing else; docs/architecture.md's "No conversion
 *     attribution to ad platforms" is enforced here as much as in layout.tsx:
 *     a tag manager or pixel added without touching this file is blocked.
 *   - Scheduling: "Get in touch" in the navbar frames Calendly's booking page
 *     (calendly.com) in a modal, on every page that has the navbar, so
 *     calendly.com is the one origin frame-src allows site-wide. The frame is
 *     built by GetInTouch.tsx, not by Calendly's widget.js, so script-src gains
 *     nothing; what Calendly's page loads inside the frame is under its own
 *     policy, not this one. The origin must match site.meeting.url, and a test
 *     holds the two together.
 *   - The voice demo: scripted playback plus a POST to /api/callback that has
 *     AYA ring the visitor. It never opens the microphone, which is why
 *     Permissions-Policy says `microphone=()` rather than `(self)`.
 *   - Server-side fetches (Resend, Synthflow, GitHub, Anthropic) happen in
 *     route handlers and are invisible to a browser CSP. Do not add them.
 *
 * ## The trade-off: `'unsafe-inline'` instead of nonces
 *
 * The strict form of a CSP is `script-src 'self' 'nonce-…' 'strict-dynamic'`.
 * Next 16 supports it, but only through a proxy.ts that mints a nonce per
 * request, and the guide is explicit that every page must then be DYNAMICALLY
 * rendered: static generation, ISR and CDN caching are all off, and PPR is
 * incompatible. Every marketing page here (/, /pricing, /get-started,
 * /contact) is static today and that is worth keeping for a site whose job is
 * to load fast on a clinic manager's phone. Hashes are not an alternative:
 * Next's inline scripts carry the per-page RSC payload, so their hashes change
 * with every build and every page.
 *
 * So script-src is `'self' 'unsafe-inline'` plus the allowed hosts, which is
 * exactly the shape the Next guide documents for a next.config CSP. What it
 * still buys: an injected `<script src="https://evil…">` is blocked, so is any
 * exfiltration by fetch/XHR/beacon to a host not in connect-src, so are
 * plugins, iframes, base-tag hijacks and framing by another site. What it does
 * NOT buy: blocking an inline script injected by an XSS bug in our own markup.
 * The site renders no user-supplied HTML (the chat demo streams text into
 * React state, never into innerHTML), so that residual risk is bounded, but it
 * is a residual risk and it is written down here on purpose. The upgrade path
 * is proxy.ts + `await connection()` on each page, at the cost above.
 *
 * `style-src 'unsafe-inline'` is unavoidable without nonces for a different
 * reason: React `style={{…}}` props become `style=""` attributes in the
 * server-rendered HTML (the hero's mask images, motion's transforms) and a
 * style-src without 'unsafe-inline' blocks every one of them on first paint.
 *
 * ## Shipping it: report-only first
 *
 * `CSP_REPORT_ONLY=1` in the environment emits the same policy under
 * `Content-Security-Policy-Report-Only`, which logs violations in the browser
 * console (and to `CSP_REPORT_URI`, if one is set) without blocking anything.
 * The intended sequence is: set it on the preview deployment, click through
 * every page including the full /get-started checkout in Stripe test mode,
 * fix or allow whatever is reported, unset it, promote. The toggle changes the
 * header NAME only; the policy text is identical either way, so what was
 * tested is what ships.
 *
 * ⚠️ Every environment variable read here is a BUILD-TIME input. Next
 * evaluates `headers()` during `next build` and writes the result into
 * .next/routes-manifest.json; `next start` serves that manifest and does not
 * re-run this code (verified: `CSP_REPORT_ONLY=1 next start` on an enforcing
 * build still emits the enforcing header). On Vercel that is the natural
 * flow, since the project's environment variables are present at build:
 * set CSP_REPORT_ONLY=1, redeploy, watch, unset it, redeploy. Locally, the
 * variable has to be on the `next build` command, not on `next start`.
 *
 * ## Development
 *
 * React uses `eval` in development to rebuild server-side stack traces in the
 * browser, so `'unsafe-eval'` is added under NODE_ENV=development only, per
 * the Next guide. `upgrade-insecure-requests` is production-only as well: it
 * is a no-op on localhost (a potentially-trustworthy origin) but would break
 * anyone running `next dev` on a LAN address over plain http.
 */

/** One response header, in the shape `next.config.ts`'s `headers()` wants. */
export type SecurityHeader = { key: string; value: string };

/**
 * The slice of the environment the policy depends on, read once in
 * next.config.ts. Narrowed here rather than reading `process.env` inside so a
 * test can hand in exactly the environment it means.
 */
export type SecurityHeadersEnv = {
  /** `process.env.NODE_ENV`. Anything but "development" is treated as production. */
  nodeEnv: string | undefined;
  /** `process.env.CSP_REPORT_ONLY`: "1" or "true" switches to the report-only header. */
  cspReportOnly: string | undefined;
  /** `process.env.CSP_REPORT_URI`: optional absolute URL that receives violation reports. */
  cspReportUri: string | undefined;
  /**
   * `process.env.VERCEL_ENV`: "production", "preview" or "development" on
   * Vercel, unset elsewhere. Only "preview" changes anything, see below.
   */
  vercelEnv: string | undefined;
};

/** Pull the relevant keys out of a `process.env`-shaped object. */
export function readSecurityHeadersEnv(
  env: Record<string, string | undefined>,
): SecurityHeadersEnv {
  return {
    nodeEnv: env.NODE_ENV,
    cspReportOnly: env.CSP_REPORT_ONLY,
    cspReportUri: env.CSP_REPORT_URI,
    vercelEnv: env.VERCEL_ENV,
  };
}

/** PostHog US: the snippet and its lazily-loaded modules. */
export const POSTHOG_ASSETS_ORIGIN = "https://us-assets.i.posthog.com";
/** PostHog US: where events go. */
export const POSTHOG_INGEST_ORIGIN = "https://us.i.posthog.com";
/**
 * Google Sheets, framed by /admin/crm and by nothing else. The public site
 * does not frame it; next.config.ts applies this to `/admin/:path*` only,
 * through the `frameSources` option below.
 */
export const GOOGLE_DOCS_ORIGIN = "https://docs.google.com";
/** Calendly's booking page, framed by "Get in touch" on every page with the navbar. */
export const CALENDLY_ORIGIN = "https://calendly.com";
/** Stripe-hosted Checkout, the only place a form on this site may ever post besides itself. */
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

/**
 * The Vercel Toolbar that Vercel injects into PREVIEW deployments for
 * logged-in team members. It is not part of the site, but with a report-only
 * CSP on the preview URL its violations would drown out the real ones, and
 * with an enforcing CSP it would not load at all. Allowed on preview only;
 * production never sees these hosts.
 *
 * ⚠️ These are Vercel's documented toolbar requirements as remembered, not
 * re-verified from vercel.com at the time of writing (the docs were
 * unreachable from the build environment). If the toolbar still reports
 * violations on preview, extend this list from the console output rather
 * than from guesswork. Nothing here reaches production either way.
 */
const VERCEL_TOOLBAR = {
  script: ["https://vercel.live"],
  connect: ["https://vercel.live", "wss://ws-us3.pusher.com"],
  img: ["https://vercel.live", "https://vercel.com"],
  frame: ["https://vercel.live"],
  style: ["https://vercel.live"],
  font: ["https://vercel.live", "https://assets.vercel.com"],
} as const;

/**
 * The directive names the policy always emits, in the order they are emitted.
 * Exported so the test can assert that every one of them is present rather
 * than whichever subset the author remembered to check.
 */
export const CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "media-src",
  "connect-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
] as const;

export type CspDirective = (typeof CSP_DIRECTIVES)[number];

/**
 * Per-route variations of the policy. Only one exists: the operator console
 * frames the marketing Sheet at /admin/crm, so that route family may frame
 * docs.google.com. Everything else on the site frames Calendly and nothing
 * more.
 */
export type CspOptions = {
  /** Extra `frame-src` origins, beside Calendly's. */
  frameSources?: readonly string[];
};

/**
 * The policy as a map from directive to its source list, before it is joined
 * into a header value. `upgrade-insecure-requests` and `report-uri` are added
 * at serialisation time because the first has no value and the second is
 * conditional.
 */
export function cspDirectives(
  env: SecurityHeadersEnv,
  options: CspOptions = {},
): Record<CspDirective, readonly string[]> {
  const dev = env.nodeEnv === "development";
  const preview = env.vercelEnv === "preview";
  const frames = [
    ...(preview ? VERCEL_TOOLBAR.frame : []),
    CALENDLY_ORIGIN,
    ...(options.frameSources ?? []),
  ];

  const self = "'self'";

  return {
    "default-src": [self],
    "script-src": [
      self,
      // See "The trade-off" above. Next's own inline bootstrap scripts need it.
      "'unsafe-inline'",
      POSTHOG_ASSETS_ORIGIN,
      ...(dev ? ["'unsafe-eval'"] : []),
      ...(preview ? VERCEL_TOOLBAR.script : []),
    ],
    "style-src": [self, "'unsafe-inline'", ...(preview ? VERCEL_TOOLBAR.style : [])],
    // data: for the inline SVGs the components build, blob: for canvas exports.
    "img-src": [self, "data:", "blob:", ...(preview ? VERCEL_TOOLBAR.img : [])],
    // next/font and the local Ashford woff2. No CDN.
    "font-src": [self, ...(preview ? VERCEL_TOOLBAR.font : [])],
    // The niche and soul videos from /public; blob: for MediaSource playback.
    "media-src": [self, "blob:"],
    // Our own /api routes (the chat stream, the gate, checkout, the callback)
    // plus PostHog. 'self' also covers the dev server's HMR websocket.
    "connect-src": [
      self,
      POSTHOG_INGEST_ORIGIN,
      POSTHOG_ASSETS_ORIGIN,
      ...(preview ? VERCEL_TOOLBAR.connect : []),
    ],
    // Calendly's booking page, in the "Get in touch" modal, and nothing else.
    // Stripe Checkout is a redirect, not an iframe. One route family adds an
    // origin of its own (`frameSources`): /admin/crm.
    "frame-src": frames,
    "object-src": ["'none'"],
    "base-uri": [self],
    "form-action": [self, STRIPE_CHECKOUT_ORIGIN],
    // Belt and braces with X-Frame-Options: DENY below.
    "frame-ancestors": ["'none'"],
  };
}

/** Serialise the policy into a single header value. */
export function contentSecurityPolicy(env: SecurityHeadersEnv, options: CspOptions = {}): string {
  const directives = cspDirectives(env, options);
  const parts = CSP_DIRECTIVES.map((name) => `${name} ${directives[name].join(" ")}`);
  if (env.nodeEnv !== "development") parts.push("upgrade-insecure-requests");
  if (env.cspReportUri) parts.push(`report-uri ${env.cspReportUri}`);
  return parts.join("; ");
}

/** True when the environment asks for the report-only header. */
export function isReportOnly(env: SecurityHeadersEnv): boolean {
  const flag = env.cspReportOnly?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Two years, subdomains included, and eligible for the browser preload list.
 *
 * Only honoured by browsers on an HTTPS response, so it is inert on
 * localhost and only starts to matter once https://healdesk.io is serving.
 * `includeSubDomains` also covers app.healdesk.io, which must be HTTPS-only
 * anyway since it carries PHI. `preload` is a commitment: once submitted to
 * hstspreload.org, backing out takes months, which is the point.
 */
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000; includeSubDomains; preload";

/**
 * Nothing on the site needs any of these. The voice demo is scripted playback
 * and the live call is placed by Synthflow to the visitor's PHONE, so the
 * browser never opens a microphone. Payment is Stripe-hosted, so the Payment
 * Request API is never used here either.
 *
 * `interest-cohort=()` (FLoC opt-out) is deliberately not included: Chrome
 * removed the feature and now logs "Unrecognized feature" for it, which is
 * noise in exactly the console session the report-only rollout depends on.
 */
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";

/**
 * The full header list for `headers()` in next.config.ts.
 *
 * Keys are unique on purpose: Next applies the last matching value for a
 * repeated key, and a duplicate here would silently win over an earlier one.
 * The list deliberately does not carry Cache-Control or Content-Type, so a
 * route that sets its own (the chat stream's `no-store` + ndjson) keeps them.
 * The one key shared with /api/chat, X-Content-Type-Options, has the same
 * value in both places, so whichever wins nothing is weakened.
 */
export function securityHeaders(env: SecurityHeadersEnv, options: CspOptions = {}): SecurityHeader[] {
  return [
    {
      key: isReportOnly(env) ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
      value: contentSecurityPolicy(env, options),
    },
    { key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    // Superseded by frame-ancestors, kept for the scanners that still look.
    { key: "X-Frame-Options", value: "DENY" },
    // Nothing here opens a window it needs a handle to; Stripe is a full
    // navigation. Isolating the browsing context closes the Spectre-style
    // cross-origin window reference for free.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ];
}
