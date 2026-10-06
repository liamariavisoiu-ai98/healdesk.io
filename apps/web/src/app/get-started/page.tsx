import { isBillingInterval, isSpecialtyId } from "@healdesk/catalog";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { Brand } from "@/components/Nav";
import { DEMO_COOKIE } from "@/lib/demo/attribution";
import { displayName, getDemoSession, isDemoSlug } from "@/lib/demo/sessions";
import { checkoutStart, cheapestPlan } from "@/lib/pricing";

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
 *
 * A buyer arriving from a personalised demo's "Book Onboarding" carries the
 * demo in a cookie (lib/demo/attribution.ts): the form opens with that
 * clinic's name, specialty and email already in it. Every step is still
 * shown, and every field can still be changed.
 */
async function demoPrefill() {
  const slug = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!isDemoSlug(slug)) return undefined;
  const session = await getDemoSession(slug);
  if (!session) return undefined;
  return {
    clinicName: displayName(session),
    ...(session.leadEmail ? { contactEmail: session.leadEmail } : {}),
    ...(isSpecialtyId(session.specialty) ? { specialty: session.specialty } : {}),
  };
}

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string }>;
}) {
  const { plan, interval } = await searchParams;
  const initialPlan = checkoutStart(plan) ? plan! : cheapestPlan().id;
  const initialInterval = isBillingInterval(interval) ? interval : "month";
  const initialState = await demoPrefill();

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
          initialState={initialState}
        />
      </main>
    </div>
  );
}
