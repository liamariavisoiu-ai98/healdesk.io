import { randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  type BookingSystemId,
  type CalendarAccount,
} from "@healdesk/catalog";

import { signAgreement } from "@/lib/agreements";
import { provisionClinic } from "@/lib/provisioning";

/**
 * A clinic as a purchase leaves it, for the portal's tests: an agreement
 * signed, the clinic provisioned on `plan` with its one sign-in, its
 * bought channels, settings defaults and knowledge. Synthetic, like every
 * fixture: provisioning's clinics start `synthetic`.
 *
 * The agreement is the current version, 1.3.0 since its release, signed with
 * the two calendar answers it reads; provisioning records the location's
 * first calendar terms from them. The default, no booking system and a
 * Workspace account without Google's agreement, is the uncovered clause.
 */
export type PortalClinic = {
  userId: string;
  clinicId: string;
  clinicSlug: string;
  email: string;
};

export async function provisionPortalClinic(
  label: string,
  options: {
    plan?: string;
    specialty?: string;
    bookingSystem?: BookingSystemId;
    calendarAccount?: CalendarAccount;
  } = {},
): Promise<PortalClinic> {
  const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
  const specialty = options.specialty ?? "med-spa";
  const bookingSystem = options.bookingSystem ?? "none";
  const platform = agreementPlatformFor(bookingSystem);
  // A med spa that answered "No" and signed the BAA before the DPA's
  // release (20 October 2026), as every "No" did until then: from that day a
  // "No" signs the DPA (tests/dpa-signing.test.ts), and one that signed the
  // BAA keeps it, which is the clinic these tests need.
  const signed = await signAgreement(
    {
      clinicLegalName: `${label} Med Spa LLC`,
      specialty,
      signatoryName: "Laura Owner",
      signatoryEmail: email,
      isCoveredEntity: false,
      attributionMode: "estimated",
      platform,
      bookingSystem,
      calendarAccount: options.calendarAccount ?? "workspace_no_baa",
      assentLabel: BAA_ASSENT_LABEL,
      templateVersion: CURRENT_BAA_VERSION,
    },
    {},
    { dpaReleased: false },
  );
  const result = await provisionClinic({
    clinicName: `${label} Med Spa LLC`,
    specialty,
    platform,
    plan: options.plan ?? "voice-webchat-1000-1000",
    contactName: "Laura Owner",
    contactEmail: email,
    agreementId: signed.agreementId,
    idempotencyKey: `idem-${randomUUID()}`,
  });
  return {
    userId: result.ownerUserId!,
    clinicId: result.clinicId,
    clinicSlug: result.clinicSlug,
    email,
  };
}
