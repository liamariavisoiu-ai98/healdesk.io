import { isSpecialtyId } from "@healdesk/catalog";

import type { DemoCheckout } from "@/components/checkout/DemoPackageExtras";
import { getSpecialty } from "@/lib/specialties";

import { REPEAT_VISITS, typicalVisit } from "./roi";
import { demoOfferEndsAt, demoSetupCredit, displayName, isDemoOfferOpen, profileOf, type DemoSession } from "./sessions";

/**
 * What the purchase knows from the demo a buyer came from, worked out once
 * for both places the purchase opens with one: /get-started, after "Book
 * Onboarding" or Stripe's cancel page, and the purchase window a homepage
 * demo opens in place from its "Get AYA" (app/demo/[slug]).
 */

/** What the package step shows a demo buyer: estimates from the demo's own prices, and the offer while it holds. */
export function demoCheckout(session: DemoSession): DemoCheckout {
  const profile = profileOf(session);
  const specialty = getSpecialty(session.specialty ?? profile?.specialty ?? "") ?? getSpecialty("med-spa")!;
  const visit = typicalVisit(profile, specialty.economics);
  return {
    clinicName: displayName(session),
    roi: {
      ...visit,
      bookingRate: specialty.economics.bookingRate,
      repeat: REPEAT_VISITS[specialty.id] ?? null,
    },
    offerEndsAt: isDemoOfferOpen(session) ? demoOfferEndsAt(session).toISOString() : undefined,
    // The share api/checkout takes off for this demo, so the page shows the figure Stripe charges.
    offerPercent: demoSetupCredit(session).percentOfSetupFee,
  };
}

/** The purchase's first answers, from the demo: every one still shown, and every one can be changed. */
export function demoPrefill(session: DemoSession): {
  clinicName: string;
  website?: string;
  contactEmail?: string;
  specialty?: string;
} {
  return {
    clinicName: displayName(session),
    // The site the demo was built from: step 2 starts with it, and reads it.
    ...(session.websiteUrl ? { website: session.websiteUrl } : {}),
    ...(session.leadEmail ? { contactEmail: session.leadEmail } : {}),
    ...(isSpecialtyId(session.specialty) ? { specialty: session.specialty } : {}),
  };
}
