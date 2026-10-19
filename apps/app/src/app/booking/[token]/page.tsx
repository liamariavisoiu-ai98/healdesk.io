import type { Metadata } from "next";

/**
 * Where an old desk link lands. Until 19 October 2026 the desk was emailed a
 * single-use link to this path for each booking request taken by phone or on
 * a Meta thread, and the page showed the person's name, number, times and
 * service to whoever held the link: the token was the whole of the
 * authentication. The portal rule puts a sign-in and the passkey step-up
 * before any booking opens, so requests are now read and decided in the
 * portal's Bookings screen (app/c/[slug]/bookings), and the clinic's alert
 * (L7) points there.
 *
 * The page is a pointer and nothing else: it reads neither the token nor the
 * database, so every path under /booking/ answers alike and an old link
 * learns nothing about which requests exist or whose they are (funnel plan
 * F5: "shows no patient fields and no actions").
 */
export const metadata: Metadata = {
  title: "Booking requests · healdesk",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RetiredBookingLinkPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">
        Booking requests are in Bookings now
      </h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        This link no longer opens a request. Sign in to healdesk and open Bookings: every request waiting
        for your team is there, and you confirm, offer other times or decline it once you have confirmed
        it&rsquo;s you on this device.
      </p>
      <p className="mt-6">
        <a href="/sign-in" className="inline-flex min-h-11 items-center font-semibold underline">
          Sign in to healdesk
        </a>
      </p>
    </main>
  );
}
