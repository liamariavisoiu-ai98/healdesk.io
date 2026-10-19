import { randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 renamed `middleware` to `proxy`.
 *
 * A useful side effect for us: proxy defaults to the Node runtime and throws if
 * you try to set `runtime`, so the edge runtime is simply unavailable here.
 * docs/hipaa-compliance.md forbids edge on anything touching PHI, and this is
 * one rule the framework now enforces for us.
 *
 * ## Why it gates nothing
 *
 * Everything here authenticates itself, and a proxy check would protect
 * neither route handlers nor client-side navigations. The clinic portal's
 * pages and server actions each call requirePortal, and patient pages
 * requireStepUp. The signed API routes (`/api/provision`, `/api/ops`,
 * `/api/billing/events`) check an HMAC over the body and a timestamp,
 * the webhooks check their provider's signature, and the single-use link
 * pages (`/link`, `/connect`, `/booking`) resolve their token server-side.
 *
 * ## What it does
 *
 * 1. **Tells a page its own path.** A patient page that needs a passkey
 *    step-up sends the browser to `/c/<slug>/step-up?next=<this page>`, and a
 *    server component cannot see its own URL, so the path is passed down as a
 *    request header (PATH_HEADER in lib/portal/step-up.ts), overwriting any
 *    the client sent. Only the pathname: a query string can carry a search
 *    term, and `next` ends up in history. It is validated where it is used.
 * 2. **Gives every request its own script nonce** (plan Part D6). The page's
 *    Content-Security-Policy allows only scripts carrying that nonce, and
 *    whatever they load ('strict-dynamic'), so a script injected into a page,
 *    through a transcript, a clinic's knowledge or anything else rendered
 *    here, does not run. Next reads the nonce from the request's policy and
 *    stamps it on its own scripts and inline styles, for every dynamically
 *    rendered page, which is every page in this app that shows anything of a
 *    clinic's.
 */

/**
 * Where a form here may send the browser: this app, and the login pages its
 * connect buttons open. Browsers apply form-action to the redirects after a
 * post too, so the Facebook login, which /api/meta/login answers with a 303
 * to Facebook's dialog, needs its origin here as Google's sign-in does.
 */
const FORM_TARGETS = [
  "https://accounts.google.com",
  "https://connect.stripe.com",
  "https://www.facebook.com",
] as const;

/** The policy for one response. Development keeps eval for React's tooling, and plain http. */
export function contentSecurityPolicy(
  nonce: string,
  production: boolean = process.env.NODE_ENV === "production",
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${FORM_TARGETS.join(" ")}`,
    "frame-ancestors 'none'",
    ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const policy = contentSecurityPolicy(nonce);

  const forwarded = new Headers(request.headers);
  forwarded.set("x-healdesk-path", request.nextUrl.pathname);
  forwarded.set("x-nonce", nonce);
  forwarded.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
