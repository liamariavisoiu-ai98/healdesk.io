/**
 * The site's "Sign in" link, to the clinic portal (plan Part A6; contracts
 * §8: `NEXT_PUBLIC_PORTAL_URL`, the portal's public origin, app.healdesk.io).
 *
 * Inlined at build time, so the navbar and the footer can read it in the
 * browser; declared in turbo.json's build.env for that reason. Unset, blank
 * or anything but an https origin (http only on localhost, for development)
 * is no link at all: the navbar and the footer render nothing rather than a
 * "Sign in" that goes nowhere, or that names the internal HEALDESK_APP_URL,
 * which must never reach a browser. Only the origin is used, whatever path
 * the variable carries, and the link goes to the portal's own /sign-in.
 */
export function portalSignInUrl(
  value: string | undefined = process.env.NEXT_PUBLIC_PORTAL_URL,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  return `${url.origin}/sign-in`;
}

export const SIGN_IN_LABEL = "Sign in";
