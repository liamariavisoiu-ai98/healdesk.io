import type { Metadata } from "next";

/**
 * Where every dead booking link ends. Expired, unknown and malformed are one
 * page, with nothing to look up, so a stale URL learns nothing about which
 * requests exist or which practice they belong to.
 */
export const metadata: Metadata = {
  title: "Booking request",
  robots: { index: false, follow: false },
};

export default function InvalidBookingLinkPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-14">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">healdesk</p>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">This link has expired</h1>
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Booking request links work for a week. If a patient may still be waiting, reply to the email that brought you here
        and we will resend a fresh link — they were told the practice would call, so a call is all that is owed.
      </p>
    </main>
  );
}
