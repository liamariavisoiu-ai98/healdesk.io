import type { Metadata } from "next";

import { Brand } from "@/components/Nav";

export const metadata: Metadata = {
  title: "Thanks, you're in",
  robots: { index: false, follow: false },
};

/**
 * Where Stripe returns the buyer after checkout.
 *
 * Deliberately dumb: it reads nothing, verifies nothing, and provisions
 * nothing. Arriving here is not proof of payment, anyone can type this URL,
 * and the account is created by the Stripe webhook whether or not the
 * customer's browser ever comes back: checkout completion records it in
 * `provisioning`, and service switches on only when the first invoice is paid
 * (app/api/webhooks/stripe). So the heading says "Checkout complete", not
 * "Payment received": a delayed payment method can complete checkout with the
 * invoice still open.
 *
 * Interim copy. In v1 this page should hand the buyer straight into the
 * onboarding wizard, signed in through a one-time link, once the first
 * invoice is paid (docs/v1-product-spec.md, "Account access and
 * credentials"). That needs a status route here and an ops operation in
 * apps/app that composes the link from BETTER_AUTH_URL; neither exists yet.
 * Until then the page says what happens next, per channel, and promises
 * nothing it cannot see. If the webhook is still in flight, or retrying,
 * every sentence here is still true.
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
          Checkout complete.
        </h1>
        <p className="text-muted mt-4 text-[19.2px] font-medium">
          Your agreement is on file and we&apos;ve emailed a copy to you.
        </p>
        <p className="text-muted mt-6 text-sm">
          Your setup opens as soon as your first payment clears, from the
          sign-in link in your welcome email. It takes about fifteen minutes of
          your time: confirm your services, prices and hours, set how she
          behaves, connect your Google Calendar, then connect each channel.
        </p>
        <p className="text-muted mt-4 text-sm">
          Each channel then goes live on its own. Website chat, once the
          one-line snippet is on your site. Instagram and Messenger, as soon as
          you connect them. WhatsApp, once your WhatsApp account has a payment
          method on it. Your phone, once call forwarding is set on your line.
          Questions in the meantime: reply to your receipt.
        </p>
      </main>
    </div>
  );
}
