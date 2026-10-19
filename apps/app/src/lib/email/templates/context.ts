import { audienceFor as catalogAudienceFor } from "@healdesk/catalog";

import type { EmailAudience } from "./types";

/**
 * Patients or clients (Annex X1.3: "audienceFor decides patients or
 * clients"). A veterinary practice's customers own the animal that is the
 * patient, so its email says "clients"; everyone else's says "patients". The
 * rule is the catalog's `audienceFor`, the one every surface asks (plan Part
 * L), so email cannot word a practice differently from the funnel or the
 * agreement.
 */
export function audienceFor(specialty: string | null | undefined): EmailAudience {
  return catalogAudienceFor(specialty);
}

/**
 * Why a clinic's address receives a clinic email (the footer's X1.9 line).
 * Every clinic email goes to its one address, which is also its sign-in.
 */
export function clinicReason(clinicName: string | null): string {
  return clinicName
    ? `You're receiving this because this is the address on ${clinicName}'s healdesk account.`
    : "You're receiving this because this is the address on your practice's healdesk account.";
}

/**
 * Why an address receives a sign-in link (B2, O6). Not the clinic line: a
 * sign-in email names no clinic, because an address can belong to several.
 */
export const SIGN_IN_REASON =
  "You're receiving this because someone asked to sign in to healdesk with this address.";

/** Why a sign-in's address receives an email about the sign-in itself (O3). */
export const ACCOUNT_REASON =
  "You're receiving this because this address is the sign-in for a healdesk account.";

/** Why a buyer receives an order email before their account exists (B3). */
export const ORDER_REASON =
  "You're receiving this because this address placed an order with healdesk.";

/** Why the ops address receives an alert. */
export const OPS_REASON =
  "You're receiving this because this address is set as healdesk's ops alert address.";
