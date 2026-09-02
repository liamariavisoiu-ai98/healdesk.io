import type { Metadata } from "next";

import { Brand } from "@/components/Nav";

export const metadata: Metadata = {
  title: "You're set up",
  robots: { index: false, follow: false },
};

/**
 * Where Stripe returns the buyer after payment.
 *
 * Deliberately dumb: it reads nothing, verifies nothing, and provisions
 * nothing. Arriving here is not proof of payment — anyone can type this URL —
 * and the account is created by the `checkout.session.completed` webhook, which
 * fires whether or not the customer's browser ever comes back.
 *
 * So the copy promises an email rather than showing a login link. If the
 * webhook is still in flight, or retrying, this page is still true.
 */
export default function CheckoutDonePage() {
  return (
    <div className="min-h-screen">
      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center px-5 py-4 sm:px-8 lg:px-14">
          <Brand />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[560px] px-5 py-20 text-center sm:px-8">
        <div className="bg-brand-gradient mx-auto grid size-14 place-items-center rounded-full text-2xl text-white">
          ✓
        </div>
        <h1 className="font-display mt-6 text-[clamp(26px,3.6vw,38px)] leading-tight font-medium tracking-[-0.024em]">
          Payment received.
        </h1>
        <p className="text-muted mt-4 text-[16px] font-medium">
          We&apos;re setting up your account now. Check your inbox in the next
          couple of minutes for a link to choose a password and finish setup.
        </p>
        <p className="text-muted mt-6 text-sm">
          Your agreement is on file and your trial has started. Nothing else is
          needed from you right now — if the email hasn&apos;t arrived in ten
          minutes, reply to your receipt and we&apos;ll sort it out.
        </p>
      </main>
    </div>
  );
}
