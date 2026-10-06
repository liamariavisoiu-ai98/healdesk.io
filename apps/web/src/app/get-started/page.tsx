import { isBillingInterval } from "@healdesk/catalog";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { type LinkNotice, SetupRequestForm } from "@/components/checkout/SetupRequestForm";
import { Brand } from "@/components/Nav";
import { checkoutStart, cheapestPlan } from "@/lib/pricing";
import { replyByDate } from "@/lib/reply-by";
import { gateState } from "@/lib/setup-gate";
import { SETUP_COOKIE } from "@/lib/setup-link";

/** Every link state a visitor can be told about, from the cookie or from /start's redirect. */
const NOTICES: readonly LinkNotice[] = ["invalid", "expired", "replaced", "used"];

export const metadata: Metadata = {
  title: "Get started",
  description:
    "About fifteen minutes of your time, and each channel goes live as you " +
    "connect it. Works with your Google Calendar.",
  // A checkout funnel has no business in search results.
  robots: { index: false, follow: false },
};

/**
 * Both query parameters are validated against the catalog and fall back
 * quietly rather than erroring: a stale link from an old email that names a
 * plan that no longer exists should land the buyer on the flow, not on a 404,
 * and the package is chosen again at step 6 anyway. `plan` may name a pricing
 * card or a package (`checkoutStart`).
 */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; link?: string }>;
}) {
  const { plan, interval, link } = await searchParams;
  const initialPlan = checkoutStart(plan) ? plan! : cheapestPlan().id;
  const initialInterval = isBillingInterval(interval) ? interval : "month";

  /**
   * While the purchase is by invitation, the setup cookie decides what this
   * page is (lib/setup-gate.ts): the purchase, pre-filled from the request
   * and bound to its address, or "Tell us about your clinic". The routes
   * behind the purchase check the same cookie again, so this is what the
   * page shows, not what protects it.
   */
  const gate = await gateState((await cookies()).get(SETUP_COOKIE)?.value);
  const invited = gate.mode === "pilot" && gate.link === "valid" ? gate.request : null;
  const notice =
    gate.mode === "pilot" && gate.link !== "valid" && gate.link !== "none"
      ? gate.link
      : NOTICES.find((n) => n === link) ?? null;

  return (
    <div className="min-h-screen">
      <header className="border-line/60 border-b">
        <div className="mx-auto flex max-w-[1240px] items-center px-5 py-4 sm:px-8 lg:px-14">
          <Brand />
          <a
            href="/"
            className="text-muted hover:text-ink ml-auto text-sm font-semibold transition-colors"
          >
            Back to site
          </a>
        </div>
      </header>

      <main className="px-5 py-12 sm:px-8 sm:py-16">
        {gate.mode === "pilot" && !invited ? (
          <SetupRequestForm replyBy={replyByDate()} notice={notice} />
        ) : (
          <CheckoutFlow
            initialPlan={initialPlan}
            initialInterval={initialInterval}
            initialState={invited ? { clinicName: invited.clinicName } : undefined}
            lockedEmail={invited?.email}
          />
        )}
      </main>
    </div>
  );
}
