import { randomUUID } from "node:crypto";

import { BAA_ASSENT_LABEL, CURRENT_BAA_VERSION } from "@healdesk/catalog";

import { signAgreement } from "@/lib/agreements";
import { provisionClinic } from "@/lib/provisioning";

/**
 * A clinic as a purchase leaves it, for the portal's tests: an agreement
 * signed, the clinic provisioned on `plan` with its one sign-in, its
 * bought channels, settings defaults and knowledge. Synthetic, like every
 * fixture: provisioning's clinics start `synthetic`.
 */
export type PortalClinic = {
  userId: string;
  clinicId: string;
  clinicSlug: string;
  email: string;
};

export async function provisionPortalClinic(
  label: string,
  options: { plan?: string; specialty?: string } = {},
): Promise<PortalClinic> {
  const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
  const specialty = options.specialty ?? "med-spa";
  const signed = await signAgreement({
    clinicLegalName: `${label} Med Spa LLC`,
    specialty,
    signatoryName: "Laura Owner",
    signatoryEmail: email,
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform: "none",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  const result = await provisionClinic({
    clinicName: `${label} Med Spa LLC`,
    specialty,
    platform: "none",
    plan: options.plan ?? "web-voice",
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
