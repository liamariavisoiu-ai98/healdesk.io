import { isDemoSlug } from "./sessions";

/**
 * Which personalised demo a buyer came from, carried in a first-party cookie
 * from "Book Onboarding" (app/demo/[slug]/onboard) to the checkout.
 *
 * httpOnly, because only the server reads it: /get-started to prefill the
 * form, /api/checkout to put the slug on the Stripe Session. It names a
 * demo, not a person, and grants nothing on its own: checkout re-reads the
 * row before trusting it, exactly as it does `leadId`.
 *
 * Its own name, never the demo gate's. Until 14 October 2026 both were
 * `hd_demo`, with the same path, so a browser kept one cookie of that name:
 * unlocking a demo replaced the slug with the gate's token, and checkout lost
 * which demo the buyer came from and the setup discount that came with it;
 * "Book Onboarding" replaced the token with the slug, and the demo asked for
 * the email again. `lib/gate.ts` keeps `hd_demo`, the name the Privacy page
 * gives it.
 */
export const DEMO_COOKIE = "hd_demo_ref";

const MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export function demoCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/** The slug from a raw Cookie header, shape-checked; undefined otherwise. */
export function demoSlugFromCookieHeader(header: string | null | undefined): string | undefined {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DEMO_COOKIE}=`))
    ?.slice(DEMO_COOKIE.length + 1);
  return isDemoSlug(value) ? value : undefined;
}
