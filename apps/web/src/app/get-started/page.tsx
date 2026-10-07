import { isBillingInterval, isSpecialtyId, NO_PLATFORM_ID } from "@healdesk/catalog";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { type LinkNotice, SetupRequestForm } from "@/components/checkout/SetupRequestForm";
import { Brand } from "@/components/Nav";
import { DEMO_COOKIE } from "@/lib/demo/attribution";
import { REPEAT_VISITS, typicalVisit } from "@/lib/demo/roi";
import { displayName, getDemoSession, isDemoActive, isDemoSlug, profileOf, type DemoSession } from "@/lib/demo/sessions";
import { getSpecialty } from "@/lib/specialties";
import { checkoutStart, cheapestPlan } from "@/lib/pricing";
import { replyByDate } from "@/lib/reply-by";
import { gateState } from "@/lib/setup-gate";
import { SETUP_COOKIE } from "@/lib/setup-link";

/** Every link state a visitor can be told about, from the cookie or from /start's redirect. */
const NOTICES: readonly LinkNotice[] = ["invalid", "expired", "replaced", "used"];

export const metadata: Metadata = {
  title: "Get AYA",
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
async function demoFromCookie(): Promise<DemoSession | null> {
  const slug = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!isDemoSlug(slug)) return null;
  const session = await getDemoSession(slug);
  // The same test as the routes' (lib/setup-gate.ts demoInvitation).
  return session && session.status === "ready" && !session.claimed ? session : null;
}

/** The package step's estimate inputs, from the demo's own prices and specialty (lib/demo/roi.ts). */
function demoRoi(session: DemoSession) {
  const profile = profileOf(session);
  const specialty = getSpecialty(session.specialty ?? profile?.specialty ?? "") ?? getSpecialty("med-spa")!;
  const visit = typicalVisit(profile, specialty.economics);
  return {
    clinicName: displayName(session),
    ...visit,
    bookingRate: specialty.economics.bookingRate,
    repeat: REPEAT_VISITS[specialty.id] ?? null,
  };
}

function demoPrefill(session: DemoSession | null) {
  if (!session) return undefined;
  return {
    clinicName: displayName(session),
    // The question a demo buyer skips: v1 reads from no booking system.
    platform: NO_PLATFORM_ID,
    ...(session.leadEmail ? { contactEmail: session.leadEmail } : {}),
    ...(isSpecialtyId(session.specialty) ? { specialty: session.specialty } : {}),
  };
}

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; link?: string }>;
}) {
  const { plan, interval, link } = await searchParams;
  const initialPlan = checkoutStart(plan) ? plan! : cheapestPlan().id;
  const initialInterval = isBillingInterval(interval) ? interval : "month";
  const demo = await demoFromCookie();
  const initialState = demoPrefill(demo);

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
        {gate.mode === "pilot" && !invited && !demo ? (
          <SetupRequestForm replyBy={replyByDate()} notice={notice} />
        ) : (
          <CheckoutFlow
            initialPlan={initialPlan}
            initialInterval={initialInterval}
            initialState={
              invited ? { ...initialState, clinicName: invited.clinicName } : initialState
            }
            lockedEmail={invited?.email}
            fromDemo={Boolean(demo) && !invited}
            roi={demo && !invited ? demoRoi(demo) : undefined}
            setupCredit={Boolean(demo && isDemoActive(demo))}
            offerEndsAt={demo && isDemoActive(demo) ? demo.expiresAt.toISOString() : undefined}
          />
        )}
      </main>
    </div>
  );
}
