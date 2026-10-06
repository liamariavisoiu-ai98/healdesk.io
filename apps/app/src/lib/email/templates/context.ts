import { specialties } from "@healdesk/catalog";

import type { EmailAudience } from "./types";

/**
 * Patients or clients (Annex X1.3: "audienceFor decides patients or
 * clients"). A veterinary practice's customers own the animal that is the
 * patient, so its email says "clients"; everyone else's says "patients". Read
 * from the specialty's regulatory regime rather than its id, so a second
 * non-human specialty needs no change here.
 */
export function audienceFor(specialty: string | null | undefined): EmailAudience {
  const found = specialties.find((s) => s.id === specialty);
  return found?.regulatoryRegime === "non-hipaa" ? "clients" : "patients";
}

/**
 * Why a clinic's address receives a clinic email (the footer's X1.9 line).
 * Every clinic email goes to its one address, which is also its sign-in.
 */
export function clinicReason(clinicName: string): string {
  return `You're receiving this because this is the address on ${clinicName}'s healdesk account.`;
}

/** Why the ops address receives an alert. */
export const OPS_REASON =
  "You're receiving this because this address is set as healdesk's ops alert address.";
