import { site } from "@/lib/site";

/**
 * Whether a state-changing request to /api/admin came from a page of this
 * site, for routes whose effect reaches beyond this app (dispatching a
 * workflow that changes production).
 *
 * The operator cookie is SameSite=Strict, so a cross-site request carries no
 * session in the first place and `requireOperator()` refuses it. This is the
 * second statement of the same rule, made from what the browser says about
 * the request rather than from what it chose not to send: a browser sets
 * `Sec-Fetch-Site` and `Origin` on every POST, and neither can be set by a
 * page. A request that carries neither did not come from a browser page at
 * all and is refused too; nothing legitimate calls these routes from a
 * script.
 *
 * The origin is compared with the request's own host (Vercel serves preview
 * deployments under their own names) and with NEXT_PUBLIC_SITE_URL.
 */
export function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return fetchSite === "same-origin";

  let originHost: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    originHost = parsed.host;
  } catch {
    return false;
  }

  const ownHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? safeHost(request.url);
  if (ownHost !== null && originHost === ownHost) return true;
  return originHost === safeHost(site.url);
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
