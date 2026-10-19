import {
  agreementKindSufficient,
  type AgreementKind,
  type CoveredAnswer,
  type RegulatoryRegime,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { agreementInEffect } from "./in-effect";

/**
 * Recording whether a practice is a HIPAA covered entity, from ops
 * (`setCoveredEntity`; plan Part K, Part L).
 *
 * The practice's answer to "Do you bill any health insurance electronically,
 * yourself or through a clearinghouse?" decides which agreement covers it,
 * and clinics.is_covered_entity is where it is recorded (drizzle/0051):
 *
 *   - a veterinary practice is outside HIPAA, so there is nothing to record,
 *     and the operation refuses;
 *   - under a business associate agreement the answer is recorded and
 *     nothing else changes: a BAA covers a practice HIPAA can reach whatever
 *     it answered;
 *   - under a data protection agreement, "Yes" or "Not sure" means the DPA no
 *     longer covers the practice. Recording it is what closes the PHI gate:
 *     app_clinic_accepts_phi() asks app_agreement_kind_sufficient(), which is
 *     false for a DPA once the practice is covered or not sure, so the
 *     database refuses the practice's client data from this write until a
 *     BAA is signed and app_supersede_agreement() puts it in force. The
 *     DPA→BAA supersede then starts (`startAgreementSupersede` below), which
 *     is the seam WP9 builds on.
 *
 * Contract metadata only; never a patient.
 */

export type CoveredEntityOutcome =
  | {
      status: "recorded";
      agreementKind: AgreementKind;
      isCoveredEntity: boolean | null;
      /** The DPA no longer covers the practice: its re-sign as a BAA has started. */
      supersede: SupersedeStart | null;
      /** Whether the agreement on record still covers the practice: the PHI gate's answer. */
      covered: boolean;
    }
  | { status: "refused"; message: string };

export function coveredFlag(answer: CoveredAnswer): boolean | null {
  return answer === "yes" ? true : answer === "no" ? false : null;
}

export async function setCoveredEntity(input: {
  clinicId: string;
  answer: CoveredAnswer;
  actor: ActorContext;
  /** Who recorded it, for the security event: the operator's address. */
  actorLabel: string;
  request?: RequestContext;
}): Promise<CoveredEntityOutcome> {
  const covered = coveredFlag(input.answer);
  return withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const [clinic] = await tx.db
        .select({
          regime: clinics.regulatoryRegime,
          kind: clinics.agreementKind,
          before: clinics.isCoveredEntity,
          organizationId: clinics.organizationId,
          offboardingStartedAt: clinics.offboardingStartedAt,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return { status: "refused", message: "No such clinic." } as const;
      if (clinic.regime === "non-hipaa") {
        return {
          status: "refused",
          message:
            "A veterinary practice is outside HIPAA: its patients are animals, so it has no covered-entity status to record, and its data protection agreement stays as it is.",
        } as const;
      }
      if (clinic.kind === null || clinic.regime === null) {
        return {
          status: "refused",
          message:
            "This clinic has no agreement kind on record, so there is nothing to record the answer against. Check its agreement first.",
        } as const;
      }
      if (clinic.offboardingStartedAt) {
        return { status: "refused", message: "This clinic has left, so nothing changes." } as const;
      }

      await tx.db
        .update(clinics)
        .set({ isCoveredEntity: covered, updatedAt: new Date() })
        .where(eq(clinics.id, tx.clinicId));
      tx.audit.record({
        action: "update",
        resourceType: "clinic_covered_entity",
        resourceId: tx.clinicId,
        metadata: { coveredEntity: covered, source: "operator", agreementKind: clinic.kind },
      });

      const stillCovered = agreementKindSufficient(
        clinic.regime as RegulatoryRegime,
        clinic.kind,
        covered,
      );
      const supersede =
        clinic.kind === "dpa" && !stillCovered
          ? await startAgreementSupersede(tx, {
              organizationId: clinic.organizationId,
              reason: input.answer === "yes" ? "now_covered" : "not_sure",
              actorLabel: input.actorLabel,
              request: input.request,
            })
          : null;
      return {
        status: "recorded",
        agreementKind: clinic.kind,
        isCoveredEntity: covered,
        supersede,
        covered: stillCovered,
      } as const;
    },
  );
}

// -----------------------------------------------------------------------------
// The DPA→BAA supersede: the seam WP9 builds on
// -----------------------------------------------------------------------------

export type SupersedeStart = {
  /** The DPA in force that a BAA is to replace, or null when none is. */
  fromAgreementId: string | null;
  /**
   * Whether the practice has been sent its re-sign link. False until WP9
   * builds it: the signed one-time link that reuses AgreementStep and calls
   * supersedeAgreement (lib/agreements/kind.ts), with L22 and its reminders.
   */
  linkSent: boolean;
};

/**
 * Start replacing a clinic's data protection agreement with a business
 * associate agreement, in the transaction that recorded why. Today it
 * records that the supersede is owed (`agreement_supersede_started`), which
 * the PHI gate already enforces by itself: nothing of the practice's client
 * data is written until the BAA is in force.
 *
 * WP9: mint the re-sign link here (AgreementStep through a signed one-time
 * link, which calls supersedeAgreement once signed), queue L22
 * (`agreement_to_sign`) with its reminders at 3 and 7 days, and raise
 * `agreement_unsigned_7_days`. Return `linkSent: true` once it goes.
 */
export async function startAgreementSupersede(
  tx: TenantTx,
  input: {
    organizationId: string;
    reason: "now_covered" | "not_sure";
    actorLabel: string;
    request?: RequestContext;
  },
): Promise<SupersedeStart> {
  const agreement = await agreementInEffect(tx);
  const fromAgreementId = agreement?.agreementKind === "dpa" ? agreement.agreementId : null;
  await recordSecurityEvent(tx.db, {
    event: "agreement_supersede_started",
    actorLabel: input.actorLabel,
    organizationId: input.organizationId,
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
    metadata: {
      clinicId: tx.clinicId,
      fromAgreementId,
      fromKind: "dpa",
      toKind: "baa",
      reason: input.reason,
    },
  });
  return { fromAgreementId, linkSent: false };
}
