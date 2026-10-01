import { isBillingInterval, isPlanId } from "@healdesk/catalog";
import type { Metadata } from "next";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { Brand } from "@/components/Nav";
import { cheapestPlan } from "@/lib/pricing";

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
 * and the package is chosen again at step 6 anyway.
 */
export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string }>;
}) {
  const { plan, interval } = await searchParams;
  const initialPlan = isPlanId(plan) ? plan : cheapestPlan().id;
  const initialInterval = isBillingInterval(interval) ? interval : "month";

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
        <CheckoutFlow
          initialPlan={initialPlan}
          initialInterval={initialInterval}
        />
      </main>
    </div>
  );
}
