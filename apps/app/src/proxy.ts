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

const PUBLIC_PATHS = ["/sign-in", "/accept-invite", "/api/auth"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
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
