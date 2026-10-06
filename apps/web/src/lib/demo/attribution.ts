import { isDemoSlug } from "./sessions";

/**
 * Which personalised demo a buyer came from, carried in a first-party cookie
 * from "Book Onboarding" (app/demo/[slug]/onboard) to the checkout.
 *
 * httpOnly, because only the server reads it: /get-started to prefill the
 * form, /api/checkout to put the slug on the Stripe Session. It names a
 * demo, not a person, and grants nothing on its own: checkout re-reads the
 * row before trusting it, exactly as it does `leadId`.
 */
export const DEMO_COOKIE = "hd_demo";

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
