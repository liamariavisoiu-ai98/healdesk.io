import type { Metadata } from "next";

/**
 * Where an unknown or malformed booking link ends. One page, with nothing to
 * look up, so a guessed URL learns nothing about which requests exist or
 * which practice they belong to. Requests themselves are on the portal's
 * Bookings screen, behind sign-in and the passkey.
 */
export const metadata: Metadata = {
  title: "Booking request",
  robots: { index: false, follow: false },
};

export default function InvalidBookingLinkPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">
        This link doesn&rsquo;t open a request
      </h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Every booking request is on Bookings in your healdesk portal. Sign in, confirm it&rsquo;s
        you on this device, and open Bookings.
      </p>
      <p className="mt-6">
        <a
          href="/sign-in"
          className="bg-ink inline-flex min-h-11 items-center rounded-full px-5 font-semibold text-white"
        >
          Sign in
        </a>
      </p>
    </main>
  );
}
