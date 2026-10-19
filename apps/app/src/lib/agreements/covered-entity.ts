import {
  agreementKindSufficient,
  type AgreementKind,
  type CoveredAnswer,
  type RegulatoryRegime,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics, type AgreementResignSource } from "@/db/schema";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { agreementInEffect } from "./in-effect";
import { openAgreementResign, sendAgreementToSign, withdrawAgreementResign } from "./resign";

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
 *     DPA→BAA supersede then starts (`startAgreementSupersede` below): the
 *     re-sign opens, AYA pauses in the same transaction, and L22 goes with
 *     its link after commit (lib/agreements/resign.ts). "No" again, while
 *     the re-sign is open, withdraws it: the DPA covers the practice again.
 *
 * The practice records the same answer itself from Billing ("We've started
 * billing insurance electronically", behind a passkey step-up), through this
 * same function with `source: "portal"`.
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
  /** Who recorded it, for the security event: the operator's address, or the device that stepped up. */
  actorLabel: string;
  /** Ops (the default), or the practice from Billing. */
  source?: AgreementResignSource;
  request?: RequestContext;
  now?: Date;
}): Promise<CoveredEntityOutcome> {
  const covered = coveredFlag(input.answer);
  const now = input.now ?? new Date();
  const outcome = await withTenant(
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
        metadata: {
          coveredEntity: covered,
          source: input.source ?? "operator",
          agreementKind: clinic.kind,
        },
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
              source: input.source ?? "operator",
              actorLabel: input.actorLabel,
              request: input.request,
              now,
            })
          : null;
      // "No" again: the DPA covers the practice, so a re-sign still open is moot.
      if (clinic.kind === "dpa" && stillCovered) {
        await withdrawAgreementResign(tx, { resolvedBy: input.actorLabel, now });
      }
      return {
        status: "recorded",
        agreementKind: clinic.kind,
        isCoveredEntity: covered,
        supersede,
        covered: stillCovered,
      } as const;
    },
  );

  // L22 goes after commit (X1.4): the re-sign it links to exists now. A send
  // that fails here is sent again by the hourly job (runAgreementResignsJob).
  if (outcome.status === "recorded" && outcome.supersede?.resignId) {
    const linkSent = await sendAgreementToSign({
      clinicId: input.clinicId,
      resignId: outcome.supersede.resignId,
      waitingDays: 0,
    });
    return { ...outcome, supersede: { ...outcome.supersede, linkSent } };
  }
  return outcome;
}

// -----------------------------------------------------------------------------
// The DPA→BAA supersede
// -----------------------------------------------------------------------------

export type SupersedeStart = {
  /** The DPA in force that a BAA is to replace, or null when none is. */
  fromAgreementId: string | null;
  /** The open re-sign (lib/agreements/resign.ts), or null when no DPA is in force to replace. */
  resignId: string | null;
  /**
   * Whether the practice has been sent its re-sign link (L22). False inside
   * the transaction; setCoveredEntity sends it after commit and says.
   */
  linkSent: boolean;
};

/**
 * Start replacing a clinic's data protection agreement with a business
 * associate agreement, in the transaction that recorded why: records that the
 * supersede is owed (`agreement_supersede_started`), opens the re-sign, which
 * pauses AYA, and leaves L22 to be sent after commit. The PHI gate already
 * refuses the practice's client data from this write until the BAA is in
 * force.
 */
export async function startAgreementSupersede(
  tx: TenantTx,
  input: {
    organizationId: string;
    reason: "now_covered" | "not_sure";
    source?: AgreementResignSource;
    actorLabel: string;
    request?: RequestContext;
    now?: Date;
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
  if (!fromAgreementId) return { fromAgreementId, resignId: null, linkSent: false };
  const { resignId } = await openAgreementResign(tx, {
    fromAgreementId,
    reason: input.reason,
    source: input.source ?? "operator",
    requestedBy: input.actorLabel,
    now: input.now,
  });
  return { fromAgreementId, resignId, linkSent: false };
}
