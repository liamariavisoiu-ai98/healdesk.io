import { isSpecialtyId, specialtyOffered } from "@healdesk/catalog";

import type { DemoCheckout } from "@/components/checkout/DemoPackageExtras";
import { verifyGateToken } from "@/lib/gate";
import { findLeadByEmail } from "@/lib/leads";
import { getSpecialty } from "@/lib/specialties";

import { REPEAT_VISITS, typicalVisit } from "./roi";
import { displayName, profileOf, type DemoSession } from "./sessions";

/**
 * What the purchase knows from the demo a buyer came from, worked out once
 * for both places the purchase opens with one: /get-started, after "Book
 * Onboarding" or Stripe's cancel page, and the purchase window a homepage
 * demo opens in place from its "Get AYA" (app/demo/[slug]).
 */

/**
 * What the package step shows a demo buyer: estimates from the demo's own
 * prices. The demo's setup offer reaches the flow as `setupOffer`, decided by
 * the server like every other (lib/billing.ts `chooseSetupOffer`).
 */
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

/**
 * What the homepage chat demo's gate already knows: the address the visitor
 * unlocked it with (the signed `hd_demo` cookie, lib/gate.ts) and the
 * specialty they were demoing, which the gate recorded on their lead row.
 * Plan Part A3: "Email and specialty are pre-filled from the demo gate when
 * present." Read from our own cookie and row, never from the browser's word;
 * a cookie that does not verify, or a store that cannot be read, pre-fills
 * nothing. Undefined when there is nothing to pre-fill.
 */
export async function gatePrefill(
  token: string | undefined,
): Promise<{ contactEmail: string; specialty?: string } | undefined> {
  let email: string | undefined;
  try {
    email = verifyGateToken(token)?.email;
  } catch {
    // No signing secret: the cookie proves nothing.
    return undefined;
  }
  if (!email) return undefined;
  const lead = await findLeadByEmail(email).catch(() => null);
  const specialty = lead?.specialty;
  return {
    contactEmail: email,
    ...(isSpecialtyId(specialty) && specialtyOffered(specialty) ? { specialty } : {}),
  };
}
