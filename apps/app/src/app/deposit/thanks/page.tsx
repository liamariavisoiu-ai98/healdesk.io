import type { Metadata } from "next";

/**
 * Where Stripe Checkout sends a patient after paying a deposit (the
 * `success_url` of lib/billing/deposit-link.ts). The checkout ran on the
 * clinic's own Stripe account; this page only says thank you.
 *
 * Static and generic on purpose. It loads nothing and names nothing: no
 * clinic, no amount, no appointment, no time, because the URL is the same for
 * every patient and every clinic and anyone can open it. Whether the payment
 * landed is recorded by the Connect webhook, not by a visit here, so the page
 * makes no promise beyond the payment itself.
 */

export const metadata: Metadata = {
  title: "Deposit paid",
  description: "Your deposit payment went through.",
  robots: { index: false, follow: false },
};

export default function DepositThanksPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        Thank you, your deposit is paid
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        The payment went to the practice through Stripe. There is nothing more to do here; you can
        close this page.
      </p>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">
        If you have a question about your appointment, contact the practice directly.
      </p>
    </main>
  );
}
