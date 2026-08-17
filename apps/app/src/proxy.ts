import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 renamed `middleware` to `proxy`.
 *
 * A useful side effect for us: proxy defaults to the Node runtime and throws if
 * you try to set `runtime`, so the edge runtime is simply unavailable here.
 * docs/hipaa-compliance.md forbids edge on anything touching PHI, and this is
 * one rule the framework now enforces for us.
 *
 * Deliberately shallow. This is a redirect for unauthenticated visitors, NOT a
 * security boundary — it only checks that a session cookie is present, never
 * that it is valid. Every page and route handler re-resolves the session and
 * the clinic grant itself, because a proxy check protects neither route
 * handlers nor client-side navigations.
 */

const PUBLIC_PATHS = ["/sign-in", "/accept-invite"];

/**
 * Routes that authenticate themselves and must never be redirected.
 *
 * `/api/auth` is Better Auth's own surface. `/api/provision` is called
 * server-to-server by checkout with a signed request — redirecting it to a
 * sign-in page turns a valid API call into a 307 pointing at HTML, which is a
 * genuinely baffling failure to debug from the caller's side.
 *
 * `/api/webhooks` is called by booking platforms, which have no session and no
 * way to acquire one. It authenticates on the payload signature, verified in
 * the adapter against that clinic's own credential.
 *
 * Any future machine-to-machine endpoint belongs here, and must do its own
 * authentication. Being listed here is not an exemption from auth; it is a
 * statement that this route does its own.
 */
const SELF_AUTHENTICATING_PATHS = [
  "/api/auth",
  "/api/provision",
  "/api/webhooks",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    SELF_AUTHENTICATING_PATHS.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  // Presence only. Validity is checked downstream where the DB is available.
  const hasSession = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("hd.") && c.value.length > 0);

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
