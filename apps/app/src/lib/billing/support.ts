import { randomUUID } from "node:crypto";

import { and, eq, isNull, lt, or } from "drizzle-orm";
import type Stripe from "stripe";

import { billingRequests } from "@/db/schema";
import { assertNoPhi, type ActorContext } from "@/lib/audit";
import { withTenant } from "@/lib/tenant";

import { retryOverageWindow, type OverageWindowResult } from "./annual-overage";
import { resolveBillingClinicId } from "./billing-clinic";
import {
  claimStripeMutationLease,
  getEntitlementsForUpdate,
  hasPlanStarted,
  releaseStripeMutationLease,
  setGrace,
  setSetupDeadline,
} from "./entitlements";
import { suspendedForNonPayment } from "./events";
import { recordBillingNote, transition } from "./state-machine";
import { resumeLocationSetup, type ResumeLocationSetupResult } from "./stripe-actions";

/**
 * The library behind the console's billing support operations (R35), for
 * the ops billing panel (wave 2) to call: lift a suspension, extend the setup
 * window, finish a location whose clinic was not created, and retry an
 * annual overage invoice. Each works on the BILLING clinic of the clinic it
 * is given, records who did it, and refuses in a sentence an operator can act
 * on. Moving money stays in the actions and jobs these delegate to.
 */

function actorFor(actorLabel: string): ActorContext {
  const label = actorLabel.trim().slice(0, 200);
  return { type: "service", serviceName: label.length > 0 ? label : "ops-billing" };
}

async function billingClinicOf(clinicId: string, actor: ActorContext): Promise<string> {
  return withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
}

/**
 * Operator prose goes into the audit row under `remark`. It must pass the
 * audit's PHI guard BEFORE anything is written: a guard that threw inside the
 * transaction would roll back a change the operator was told had happened.
 */
function remarkProblem(remark: string): string | null {
  if (remark.length === 0 || remark.length > 500) return "Give a reason (up to 500 characters).";
  try {
    assertNoPhi({ remark }, "reason");
    return null;
  } catch {
    return "The reason looks like it carries an email address or a phone number. Describe it without them.";
  }
}

// -----------------------------------------------------------------------------
// liftSuspension
// -----------------------------------------------------------------------------

export type LiftSuspensionInput = { clinicId: string; reason: string; actorLabel: string };

export type LiftSuspensionResult = { status: "lifted" } | { status: "refused"; message: string };

/**
 * Lift a suspension by hand (R35): support only, and refused while an
 * invoice is open, because a lift would clear grace and hand back service
 * the clinic still owes for. For the suspensions nothing else can lift: a
 * dispute that was resolved, or one ops imposed.
 *
 * The refusal says what happens next, which depends on the cause. A
 * suspension for not paying comes back by itself when the invoice is paid
 * (R10); a dispute's or an operator's never does, so for those the invoice is
 * paid first and the suspension then lifted here (suspendedForNonPayment).
 *
 * Moves `suspended` to `active` through the state machine (actor `support`),
 * clears any grace left over, and records the operator's reason.
 */
export async function liftSuspension(input: LiftSuspensionInput): Promise<LiftSuspensionResult> {
  const remark = input.reason.trim();
  const problem = remarkProblem(remark);
  if (problem) return { status: "refused", message: problem };
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await billingClinicOf(input.clinicId, actor);
  return withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    if (!row) return { status: "refused", message: "This clinic has no billing account." };
    if (row.status !== "suspended") {
      return { status: "refused", message: "This account isn't suspended." };
    }
    if (row.openInvoiceId) {
      return {
        status: "refused",
        message: (await suspendedForNonPayment(tx))
          ? "An invoice is still open. The account comes back by itself when it's paid; it can't be lifted by hand while it's owed."
          : "An invoice is still open. Have it paid first, then lift the suspension here: paying alone won't restore it.",
      };
    }
    await transition(tx, "active", { actor: "support", reason: "suspension_lifted" });
    await setGrace(tx.db, billingClinicId, null);
    tx.audit.record({
      action: "update",
      resourceType: "entitlements",
      resourceId: billingClinicId,
      metadata: { field: "suspension", lifted: true, remark },
    });
    return { status: "lifted" };
  });
}

// -----------------------------------------------------------------------------
// extendSetupDeadline
// -----------------------------------------------------------------------------

export type ExtendSetupDeadlineInput = {
  clinicId: string;
  days: number;
  actorLabel: string;
  /**
   * The deadline the caller saw. When given, the extension is refused once
   * the stored deadline differs, so a repeated or replayed request (the ops
   * envelope has a 300-second replay window and no nonce) cannot add the
   * days twice.
   */
  expectedDeadlineAt?: Date;
};

export type ExtendSetupDeadlineResult =
  { status: "extended"; setupDeadlineAt: string } | { status: "refused" | "busy"; message: string };

/**
 * Give a clinic more time to finish its setup (R12, R35): `days`, 1 to 30,
 * added to its current deadline (or to now, if that has passed).
 *
 * A setup closure already recorded and not yet carried out is moved to the
 * new deadline in the same transaction: the closure worker does not re-check
 * the deadline (it re-checks only that nothing is live), so without this an
 * extension granted after the reconcile recorded the closure would still
 * close the account. Holds the billing clinic's mutation lease while it does
 * that, and refuses `busy` while the closure (or anything else) is
 * mid-flight. Refused once the plan has started (there is no setup window
 * any more) and on an ended account.
 */
export async function extendSetupDeadline(
  input: ExtendSetupDeadlineInput,
  options: { now?: Date } = {},
): Promise<ExtendSetupDeadlineResult> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 30) {
    return { status: "refused", message: "Extend by a whole number of days, from 1 to 30." };
  }
  const now = options.now ?? new Date();
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await billingClinicOf(input.clinicId, actor);
  const owner = `extend_deadline:${randomUUID()}`;
  return withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const row = await getEntitlementsForUpdate(tx.db, billingClinicId);
    if (!row) return { status: "refused", message: "This clinic has no billing account." };
    if (row.status === "canceled" || row.status === "purged") {
      return { status: "refused", message: "This account has already closed." };
    }
    if (hasPlanStarted(row)) {
      return {
        status: "refused",
        message: "The plan has started, so there is no setup window to extend.",
      };
    }
    if (!row.setupDeadlineAt) {
      return { status: "refused", message: "This account has no setup deadline to extend." };
    }
    // Checked under the row lock, so two copies of one request cannot both
    // pass: the first moves the deadline and the second finds it moved.
    if (
      input.expectedDeadlineAt &&
      row.setupDeadlineAt.getTime() !== input.expectedDeadlineAt.getTime()
    ) {
      return {
        status: "refused",
        message:
          "The setup deadline has changed since this was asked, so nothing was extended. Reload to see the new deadline.",
      };
    }
    if (!(await claimStripeMutationLease(tx.db, billingClinicId, owner))) {
      return {
        status: "busy",
        message: "A billing change for this account is in progress. Try again in a minute.",
      };
    }
    const from = Math.max(row.setupDeadlineAt.getTime(), now.getTime());
    const deadline = new Date(from + input.days * 24 * 60 * 60 * 1000);
    // A pending closure waits for the new deadline. A row a worker has
    // leased is never moved under it: that worker's next write would
    // overwrite the deferral, so the extension is refused instead.
    const leased = await tx.db
      .select({ id: billingRequests.id })
      .from(billingRequests)
      .where(
        and(
          eq(billingRequests.clinicId, billingClinicId),
          eq(billingRequests.kind, "close_setup"),
          isNull(billingRequests.doneAt),
        ),
      );
    if (leased.length > 0) {
      const moved = await tx.db
        .update(billingRequests)
        .set({ nextAttemptAt: deadline })
        .where(
          and(
            eq(billingRequests.clinicId, billingClinicId),
            eq(billingRequests.kind, "close_setup"),
            isNull(billingRequests.doneAt),
            or(isNull(billingRequests.leaseUntil), lt(billingRequests.leaseUntil, new Date())),
          ),
        )
        .returning({ id: billingRequests.id });
      if (moved.length !== leased.length) {
        await releaseStripeMutationLease(tx.db, billingClinicId, owner);
        return {
          status: "busy",
          message: "The setup closure is being processed right now. Try again in a minute.",
        };
      }
    }
    await setSetupDeadline(tx.db, billingClinicId, deadline);
    await recordBillingNote(tx, { actor: "support", reason: "setup_deadline_extended" });
    tx.audit.record({
      action: "update",
      resourceType: "entitlements",
      resourceId: billingClinicId,
      metadata: { field: "setup_deadline", days: input.days },
    });
    await releaseStripeMutationLease(tx.db, billingClinicId, owner);
    return { status: "extended", setupDeadlineAt: deadline.toISOString() };
  });
}

// -----------------------------------------------------------------------------
// retryLocationSetup
// -----------------------------------------------------------------------------

export type RetryLocationSetupInput = { clinicId: string; actorLabel: string };

/**
 * Finish a location that was charged but whose clinic was not created, or
 * clear a request that never charged (R14, R35). Delegates to the same
 * resume the billing actions use (`resumeLocationSetup`); it never charges.
 */
export async function retryLocationSetup(
  input: RetryLocationSetupInput,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<ResumeLocationSetupResult> {
  return resumeLocationSetup({ clinicId: input.clinicId, actorLabel: input.actorLabel }, options);
}

// -----------------------------------------------------------------------------
// retryOverageInvoice
// -----------------------------------------------------------------------------

export type RetryOverageInvoiceInput = {
  clinicId: string;
  /** The window's start, as the overage ledger shows it: an ISO timestamp. */
  windowStart: string;
  actorLabel: string;
};

/**
 * Retry an annual overage invoice that failed (R35), now rather than at the
 * next 05 UTC run. Resumes any invoice the failed attempt left in Stripe by
 * its `hd_ref`, so it never invoices a month twice.
 */
export async function retryOverageInvoice(
  input: RetryOverageInvoiceInput,
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<OverageWindowResult | { status: "refused"; message: string }> {
  const windowStart = new Date(input.windowStart);
  if (Number.isNaN(windowStart.getTime())) {
    return { status: "refused", message: "That isn't a date the overage ledger knows." };
  }
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await billingClinicOf(input.clinicId, actor);
  const result = await retryOverageWindow(billingClinicId, windowStart, options);
  await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    tx.audit.record({
      action: "update",
      resourceType: "overage_invoice",
      resourceId: billingClinicId,
      metadata: { field: "overage_retry", outcome: result.status },
    });
  });
  return result;
}
