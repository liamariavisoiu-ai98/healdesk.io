import { terminationRefundsFees, type AgreementTerminationReason } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { billingRequestsSwitchedOn, requestCancelForAgreementEnd } from "@/lib/billing/requests";
import { describeError, log } from "@/lib/log";
import { alertIfOffboardingStartedLate, startOffboarding } from "@/lib/offboarding/offboarding";
import { notifyOps } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

import { agreementInEffectFor } from "./in-effect";

/**
 * What a recorded termination does to the Services (BAA 1.3.0 clause 1, the
 * Services "end when Practice's subscription under the Terms ends"; clause 17
 * ¶3, "Terminating this agreement ends the Services on the same day ... and
 * healdesk refunds any Fees Practice has paid for that time"; clause 20, a
 * change-in-law termination "and with it the Services").
 *
 * Called by markAgreementTerminated (lib/ops/api.ts) after the termination
 * has committed, so that a failure here can never leave the agreement looking
 * live. Once no agreement is in effect for the practice:
 *
 *   - the assistant stops at once: the answer gate refuses with
 *     `no_agreement` (lib/billing/answering.ts), and the database refuses new
 *     patient rows for a production clinic (app_clinic_accepts_phi,
 *     drizzle/0063). Neither needs this function: both read the agreements
 *     themselves;
 *   - every location starts offboarding, its service ended at the
 *     termination (the database clamps a date more than a week back, and ops
 *     hears of it), which starts the export and destruction clock of the
 *     agreement it was bound to;
 *   - each billing clinic records a `cancel_now` request (requestCancelNow),
 *     whose worker cancels the subscription at once and without proration
 *     (lib/billing/requests.ts), retrying with the billing requests' backoff
 *     until it goes, and telling ops when it is stuck for a day or
 *     dead-lettered. That worker is the billing-requests job, which ships
 *     off: while it is off, ops is told at once (phase billing_job_off) to
 *     switch it on or cancel in Stripe. Every ending stops the Fees on the
 *     day;
 *   - where clause 17 ¶3 refunds (the practice ended it because healdesk
 *     violated a material term, or under the Subcontractors clause), ops is
 *     told once per billing clinic that a refund is due
 *     (agreement_refund_due): the operator previews it and confirms it on
 *     the clinic's Billing page (commitRefund's `agreement_terminated`), as
 *     every refund is confirmed. Every other ending refunds nothing.
 *
 * A practice with another agreement still in effect (the newer one of a
 * supersede) is untouched. Never throws: each location and billing clinic is
 * tried on its own, and ops is told, with ids only, about any that failed.
 */

/** The reason startOffboarding records for a termination. */
export const AGREEMENT_TERMINATED_REASON = "agreement_terminated";

export type TerminationEffect =
  | { status: "unbound" }
  | { status: "agreement_in_effect" }
  | {
      status: "services_ended";
      /** Locations whose offboarding is now started (this call or before it). */
      offboarded: number;
      /** Billing clinics whose cancellation is recorded, re-armed or already standing. */
      cancellations: number;
      /** Clause 17 ¶3 refunds this ending: ops was told, per billing clinic, to confirm the refund. */
      refundDue: boolean;
      /** Locations or billing clinics this call could not reach; ops was told of each. */
      failures: number;
    };

type Location = {
  clinicId: string;
  billingClinicId: string;
  destroyed: boolean;
};

async function locationsOf(organizationId: string): Promise<Location[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    billing_clinic_id: string;
    destroyed_at: Date | string | null;
  }>(
    sql`select clinic_id, billing_clinic_id, destroyed_at
          from app_organization_clinics(${organizationId}::text)`,
  );
  return result.rows.map((row) => ({
    clinicId: String(row.clinic_id),
    billingClinicId: String(row.billing_clinic_id),
    destroyed: row.destroyed_at !== null,
  }));
}

export async function endServicesAfterTermination(input: {
  agreementId: string;
  organizationId: string | null;
  /** The instant recorded as terminated_at: the end of the termination's UTC day. */
  terminatedAt: Date;
  /** Who ended it and why, as recorded. */
  reason: AgreementTerminationReason;
  actor: ActorContext;
  request?: RequestContext;
}): Promise<TerminationEffect> {
  const { agreementId, organizationId, terminatedAt, reason, actor, request } = input;
  // An agreement signed but never bound covers no practice yet.
  if (!organizationId) return { status: "unbound" };
  if (await agreementInEffectFor(unsafeDb, organizationId))
    return { status: "agreement_in_effect" };

  const locations = await locationsOf(organizationId);
  let offboarded = 0;
  let cancellations = 0;
  let failures = 0;

  for (const location of locations) {
    // A destroyed clinic has nothing left to offboard; it was offboarded
    // before it was destroyed.
    if (location.destroyed) continue;
    try {
      const start = await withTenant({ clinicId: location.clinicId, actor, request }, (tx) =>
        startOffboarding(tx, AGREEMENT_TERMINATED_REASON, terminatedAt),
      );
      offboarded += 1;
      await alertIfOffboardingStartedLate(location.clinicId, start);
    } catch (error) {
      failures += 1;
      log.error("termination could not start offboarding", {
        clinicId: location.clinicId,
        agreementId,
        error: describeError(error),
      });
      await notifyOps("agreement_termination_incomplete", {
        clinicId: location.clinicId,
        agreementId,
        phase: "offboarding",
      });
    }
  }

  const refundDue = terminationRefundsFees(reason);
  const billingClinics = [...new Set(locations.map((location) => location.billingClinicId))];
  // The cancellation is carried out only by the billing-requests job, which
  // ships off; with it off the subscription keeps billing every period and
  // nothing else would say so.
  // A switch that can't be read counts as off: the alert is the safe side.
  const jobOn =
    billingClinics.length === 0 || (await billingRequestsSwitchedOn().catch(() => false));
  for (const billingClinicId of billingClinics) {
    try {
      await withTenant({ clinicId: billingClinicId, actor, request }, (tx) =>
        requestCancelForAgreementEnd(tx, billingClinicId),
      );
      cancellations += 1;
      if (!jobOn) {
        await notifyOps("agreement_termination_incomplete", {
          clinicId: billingClinicId,
          agreementId,
          phase: "billing_job_off",
        });
      }
      if (refundDue) {
        await notifyOps("agreement_refund_due", { clinicId: billingClinicId, agreementId });
      }
    } catch (error) {
      failures += 1;
      log.error("termination could not record the cancellation", {
        clinicId: billingClinicId,
        agreementId,
        error: describeError(error),
      });
      await notifyOps("agreement_termination_incomplete", {
        clinicId: billingClinicId,
        agreementId,
        phase: "billing",
      });
    }
  }

  return { status: "services_ended", offboarded, cancellations, failures, refundDue };
}
