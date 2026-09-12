import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 renamed `middleware` to `proxy`.
 *
 * A useful side effect for us: proxy defaults to the Node runtime and throws if
 * you try to set `runtime`, so the edge runtime is simply unavailable here.
 * docs/hipaa-compliance.md forbids edge on anything touching PHI, and this is
 * one rule the framework now enforces for us.
 *
 * ## Why this file no longer redirects anybody
 *
 * It used to send any request without a session cookie to `/sign-in`, because
 * this app had a clinic console behind a login. It has neither any more. The
 * console was deleted on 7 September and its replacement lives at
 * healdesk.io/admin in apps/web, behind one account that never signs in here;
 * `(auth)/sign-in` and `(auth)/accept-invite` went with the invitation system,
 * so the destination of that redirect does not exist. A redirect to a 404 is a
 * worse answer than the 404 itself, and for the signed API calls that make up
 * almost all of this app's traffic it is worse again: a 307 pointing at HTML,
 * in reply to a POST, is a genuinely baffling thing to debug from the caller's
 * side.
 *
 * What is left in this app authenticates itself, every one of them, and none of
 * them on a session cookie:
 *
 *   - `/api/provision`, `/api/agreements`, `/api/ops` — an HMAC over the body
 *     and a timestamp, keyed on a secret that never reaches a browser.
 *   - `/api/webhooks` — the payload signature, checked in the adapter against
 *     that clinic's own credential.
 *   - `/api/auth` — Better Auth's own surface. The tables stay because
 *     `clinics.organizationId` is NOT NULL and references `organization`, so
 *     organisations remain a data concept even with nobody logging in.
 *   - `/connect/[token]` — the clinic's single-use credential handover. A
 *     clinic has no session and is never going to have one: they click one link
 *     in one email, paste one credential, and are finished. The route looks the
 *     token up by SHA-256 hash and consumes it with a conditional update the
 *     first time it is spent, and it holds no session before or after. The page
 *     and its server action each re-resolve that token server-side and take the
 *     clinic identity from the row they find, never from anything the browser
 *     sent alongside it.
 *
 * So there is nothing here to gate and nothing to gate it against. The file
 * stays rather than being deleted because `config.matcher` is what keeps the
 * Node runtime assertion above in force, and because the next person to add a
 * page to this app should find this reasoning rather than an empty directory.
 *
 * If a human-facing, session-backed page is ever added here, the check belongs
 * in the page, not in this file: a proxy check protects neither route handlers
 * nor client-side navigations, which is why the old one was explicitly labelled
 * as not a security boundary.
 */

export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
