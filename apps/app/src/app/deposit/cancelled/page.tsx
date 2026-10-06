import type { Metadata } from "next";

/**
 * Where Stripe Checkout sends a patient who leaves the deposit page without
 * paying (the `cancel_url` of lib/billing/deposit-link.ts).
 *
 * Static and generic, like /deposit/thanks: it loads nothing and names no
 * clinic, amount or appointment. The link itself stays usable until it
 * expires, so the page says so rather than implying the chance has gone; what
 * happens to the booking without a deposit is the clinic's own setting, so it
 * promises nothing about that either.
 */

export const metadata: Metadata = {
  title: "No payment taken",
  description: "You left the deposit page before paying.",
  robots: { index: false, follow: false },
};

export default function DepositCancelledPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        No payment was taken
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        You left the payment page before paying, so nothing was charged. If you still want to pay
        the deposit, open the same link again while it is still valid.
      </p>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        If you have a question about the deposit or your appointment, contact the practice directly.
      </p>
    </main>
  );
}
