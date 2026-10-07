import { isBillingInterval, isSpecialtyId } from "@healdesk/catalog";
import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CheckoutFlow } from "@/components/checkout/CheckoutFlow";
import { type LinkNotice, SetupRequestForm } from "@/components/checkout/SetupRequestForm";
import { Brand } from "@/components/Nav";
import { DEMO_COOKIE } from "@/lib/demo/attribution";
import { displayName, getDemoSession, isDemoSlug } from "@/lib/demo/sessions";
import { checkoutStart } from "@/lib/pricing";
import { replyByDate } from "@/lib/reply-by";
import { gateState } from "@/lib/setup-gate";
import { SETUP_COOKIE } from "@/lib/setup-link";

/** Every link state a visitor can be told about, from the cookie or from /start's redirect. */
const NOTICES: readonly LinkNotice[] = ["invalid", "expired", "replaced", "used"];

export const metadata: Metadata = {
  title: "Get AYA",
  description:
    "Choose a package, tell us about your clinic, sign the agreement and pay the " +
    "setup fee. Each channel goes live as you connect it.",
  // A checkout funnel has no business in search results.
  robots: { index: false, follow: false },
};

/**
 * `plan` may name a pricing card or a package (`checkoutStart`); it is the
 * only way, beside a pricing card, that a package arrives preselected. A
 * stale or unknown one preselects nothing rather than erroring: the buyer
 * lands on the flow and chooses. `cancelled=1` is Stripe's cancel page
 * sending the buyer back, to Review and pay with every step intact.
 *
 * A buyer arriving from a personalised demo's "Book Onboarding" carries the
 * demo in a cookie (lib/demo/attribution.ts): the form opens with that
 * clinic's name, website, specialty and email already in it. Every step is
 * still shown, and every field can still be changed. A setup link's own
 * request goes over it: its clinic name and website, and its address, which
 * the purchase is bound to.
 */
async function demoPrefill() {
  const slug = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!isDemoSlug(slug)) return undefined;
  const session = await getDemoSession(slug);
  if (!session) return undefined;
  return {
    clinicName: displayName(session),
    // The site the demo was built from: step 2 starts with it, and reads it.
    ...(session.websiteUrl ? { website: session.websiteUrl } : {}),
    ...(session.leadEmail ? { contactEmail: session.leadEmail } : {}),
    ...(isSpecialtyId(session.specialty) ? { specialty: session.specialty } : {}),
  };
}

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; link?: string; cancelled?: string }>;
}) {
  const { plan, interval, link, cancelled } = await searchParams;
  const initialPlan = checkoutStart(plan) ? plan : undefined;
  const initialInterval = isBillingInterval(interval) ? interval : "month";
  const initialState = await demoPrefill();

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
            initialState={
              invited
                ? { ...initialState, clinicName: invited.clinicName, website: invited.website }
                : initialState
            }
            lockedEmail={invited?.email}
            returnedFromPayment={cancelled === "1"}
            // Stripe Tax is the server's setting; the page only says so.
            salesTax={process.env.STRIPE_AUTOMATIC_TAX === "true"}
          />
        )}
      </main>
    </div>
  );
}
