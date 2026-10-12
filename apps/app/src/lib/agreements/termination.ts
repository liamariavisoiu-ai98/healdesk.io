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
  /** Null when the location points at a billing clinic outside its organisation (review R6). */
  billingClinicId: string | null;
  offboarding: boolean;
  destroyed: boolean;
};

async function locationsOf(organizationId: string): Promise<Location[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    billing_clinic_id: string | null;
    offboarding_started_at: Date | string | null;
    destroyed_at: Date | string | null;
  }>(
    sql`select clinic_id, billing_clinic_id, offboarding_started_at, destroyed_at
          from app_organization_clinics(${organizationId}::text)`,
  );
  return result.rows.map((row) => ({
    clinicId: String(row.clinic_id),
    billingClinicId: row.billing_clinic_id === null ? null : String(row.billing_clinic_id),
    offboarding: row.offboarding_started_at !== null,
    destroyed: row.destroyed_at !== null,
  }));
}

type Steps = { offboarded: number; cancellations: number; failures: number };

/**
 * The billing clinics to cancel for these locations. A location whose
 * pointer leads outside its organisation has none here
 * (app_organization_clinics): its pointer is the runtime role's to write, so
 * it is never followed into another practice's subscription. Ops is told,
 * once per such location, to cancel its billing by hand.
 */
async function billingClinicsOf(
  locations: readonly Location[],
  agreementId: string,
): Promise<{ billingClinics: string[]; refused: number }> {
  const billingClinics = new Set<string>();
  let refused = 0;
  for (const location of locations) {
    if (location.billingClinicId !== null) {
      billingClinics.add(location.billingClinicId);
      continue;
    }
    refused += 1;
    log.error("termination refused a billing pointer outside the practice", {
      clinicId: location.clinicId,
      agreementId,
    });
    await notifyOps("agreement_termination_incomplete", {
      clinicId: location.clinicId,
      agreementId,
      phase: "billing_pointer",
    });
  }
  return { billingClinics: [...billingClinics], refused };
}

/**
 * The termination's two steps, for the locations and billing clinics given:
 * start each location's offboarding, and record each billing clinic's
 * cancellation, telling ops of each that fails, of a cancellation that waits
 * on the switched-off billing-requests job, and, where clause 17 ¶3 refunds,
 * that a refund is due. Each is tried on its own; never throws.
 */
async function endServicesFor(input: {
  agreementId: string;
  terminatedAt: Date;
  reason: string | null;
  locations: readonly Location[];
  billingClinics: readonly string[];
  actor: ActorContext;
  request?: RequestContext;
}): Promise<Steps> {
  const { agreementId, terminatedAt, reason, actor, request } = input;
  const steps: Steps = { offboarded: 0, cancellations: 0, failures: 0 };

  for (const location of input.locations) {
    // A destroyed clinic has nothing left to offboard; it was offboarded
    // before it was destroyed.
    if (location.destroyed) continue;
    try {
      const start = await withTenant({ clinicId: location.clinicId, actor, request }, (tx) =>
        startOffboarding(tx, AGREEMENT_TERMINATED_REASON, terminatedAt),
      );
      steps.offboarded += 1;
      await alertIfOffboardingStartedLate(location.clinicId, start);
    } catch (error) {
      steps.failures += 1;
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
  // The cancellation is carried out only by the billing-requests job, which
  // ships off; with it off the subscription keeps billing every period and
  // nothing else would say so. A switch that can't be read counts as off:
  // the alert is the safe side.
  const jobOn =
    input.billingClinics.length === 0 ||
    (await billingRequestsSwitchedOn().catch(() => false));
  for (const billingClinicId of input.billingClinics) {
    try {
      await withTenant({ clinicId: billingClinicId, actor, request }, (tx) =>
        requestCancelForAgreementEnd(tx, billingClinicId),
      );
      steps.cancellations += 1;
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
      steps.failures += 1;
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
  return steps;
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
  const { billingClinics, refused } = await billingClinicsOf(locations, agreementId);
  const steps = await endServicesFor({
    agreementId,
    terminatedAt,
    reason,
    locations,
    billingClinics,
    actor,
    request,
  });
  return {
    status: "services_ended",
    ...steps,
    failures: steps.failures + refused,
    refundDue: terminationRefundsFees(reason),
  };
}

const RECONCILE_ACTOR = { type: "service", serviceName: "termination-reconcile" } as const;

export type TerminationReconcileSummary = {
  /** Practices whose termination had a step left undone. */
  practices: number;
  offboarded: number;
  cancellations: number;
  failures: number;
};

/**
 * The termination's reconciler (the branch review's R5), hourly from the
 * billing-reconcile job.
 *
 * endServicesAfterTermination runs in-process after terminated_at commits,
 * with no durable marker of its own. A process killed in that gap leaves the
 * agreement terminated, the assistant stopped and the database refusing new
 * patient rows (both read the agreements themselves), but no location
 * offboarding and the subscription billing, silently; and the console
 * refuses a second termination. This finds every practice with a terminated
 * agreement and none in effect where a location that isn't destroyed has
 * not started offboarding, or a billing clinic whose subscription hasn't
 * ended has no cancel_now recorded, and finishes those steps the way the
 * termination would have, with its alerts (the refund due, the job off).
 * Then it tells ops what it finished, per practice and step. Idempotent: a
 * practice with nothing left undone costs a read and does nothing. A
 * cancel_now that exists in any state is left to the billing requests' own
 * re-arming and stuck alerts.
 */
export async function reconcileTerminations(): Promise<TerminationReconcileSummary> {
  const summary: TerminationReconcileSummary = {
    practices: 0,
    offboarded: 0,
    cancellations: 0,
    failures: 0,
  };
  const ended = await unsafeDb.execute<{
    organization_id: string;
    agreement_id: string;
    terminated_at: Date | string;
    termination_reason: string | null;
  }>(
    sql`select distinct on (b.organization_id)
               b.organization_id, b.id as agreement_id, b.terminated_at, b.termination_reason
          from baa_acceptances b
         where b.organization_id is not null
           and b.terminated_at is not null
           and not exists (select 1 from app_agreement_in_effect(b.organization_id))
         order by b.organization_id, b.terminated_at desc, b.accepted_at desc`,
  );
  for (const row of ended.rows) {
    const organizationId = String(row.organization_id);
    const agreementId = String(row.agreement_id);
    try {
      const locations = await locationsOf(organizationId);
      const toOffboard = locations.filter((l) => !l.destroyed && !l.offboarding);
      const toCancel: string[] = [];
      // A pointer outside the practice was refused, and told to ops, when
      // the termination ran; it is not followed here either.
      for (const billingClinicId of new Set(locations.map((l) => l.billingClinicId))) {
        if (billingClinicId !== null && (await cancellationOwed(billingClinicId))) {
          toCancel.push(billingClinicId);
        }
      }
      if (toOffboard.length === 0 && toCancel.length === 0) continue;
      summary.practices += 1;
      const steps = await endServicesFor({
        agreementId,
        terminatedAt: new Date(row.terminated_at),
        reason: row.termination_reason,
        locations: toOffboard,
        billingClinics: toCancel,
        actor: RECONCILE_ACTOR,
      });
      summary.offboarded += steps.offboarded;
      summary.cancellations += steps.cancellations;
      summary.failures += steps.failures;
      if (steps.offboarded > 0) {
        await notifyOps("agreement_termination_finished_late", {
          organizationId,
          agreementId,
          phase: "offboarding",
          count: steps.offboarded,
        });
      }
      if (steps.cancellations > 0) {
        await notifyOps("agreement_termination_finished_late", {
          organizationId,
          agreementId,
          phase: "billing",
          count: steps.cancellations,
        });
      }
    } catch (error) {
      summary.failures += 1;
      log.error("termination reconcile failed for a practice", {
        organizationId,
        agreementId,
        error: describeError(error),
      });
    }
  }
  return summary;
}

/**
 * Whether a terminated practice's billing clinic still needs its
 * cancellation recorded: no cancel_now row in any state, and a subscription
 * that hasn't already ended (no entitlements row means nothing to cancel).
 */
async function cancellationOwed(billingClinicId: string): Promise<boolean> {
  return withTenant({ clinicId: billingClinicId, actor: RECONCILE_ACTOR }, async (tx) => {
    const result = await tx.db.execute<{ owed: boolean }>(
      sql`select (exists (select 1 from entitlements e
                           where e.clinic_id = ${billingClinicId}::uuid
                             and e.status not in ('canceled', 'purged'))
                  and not exists (select 1 from billing_requests r
                                   where r.clinic_id = ${billingClinicId}::uuid
                                     and r.kind = 'cancel_now')) as owed`,
    );
    return result.rows[0]?.owed === true;
  });
}
