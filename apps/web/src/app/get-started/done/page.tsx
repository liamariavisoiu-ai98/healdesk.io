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
 * nothing. Arriving here is not proof of payment, anyone can type this URL,
 * and the account is created by the `checkout.session.completed` webhook, which
 * fires whether or not the customer's browser ever comes back.
 *
 * So the copy promises nothing this page cannot see. It does NOT promise a
 * "choose a password" email either — nothing sends one. Clinic logins were
 * removed on purpose (apps/app/src/lib/provisioning.ts): there is no console
 * to log into, and the only thing a clinic is ever sent to click is the
 * single-use connection link, issued separately and only when they chose
 * verified reporting. This mirrors the in-flow Complete screen in
 * components/checkout/CheckoutFlow.tsx, which says the same thing to a buyer
 * who finished inside the modal. If the webhook is still in flight, or
 * retrying, every sentence here is still true.
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
        <h1 className="font-display mt-6 text-[clamp(31.2px,4.32vw,45.6px)] leading-tight font-medium tracking-[-0.024em]">
          Payment received.
        </h1>
        <p className="text-muted mt-4 text-[19.2px] font-medium">
          Your agreement is on file and we&apos;ve emailed a copy to you.
        </p>
        <p className="text-muted mt-6 text-sm">
          Next we configure the agent for your clinic and provision your number.
          There is nothing for you to log into. If you chose verified reporting,
          we&apos;ll send you a single link to connect your booking system, and
          it takes about five minutes. Questions in the meantime: reply to your
          receipt.
        </p>
      </main>
    </div>
  );
}
