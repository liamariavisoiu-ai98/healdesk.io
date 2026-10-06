import type { BillingInterval, Channel } from "@healdesk/catalog";

/**
 * What a clinic (from the portal's Billing) or an operator (from the console)
 * can do to a subscription: change the plan, add a location, turn auto-renew
 * off or on, open Stripe's portal for the card and the invoices, and refund
 * the first period (build decisions BD10, BD12 to BD15; R5, R13 to R15).
 *
 * Every action works on the BILLING clinic of the clinic it is given, never
 * calls Stripe inside a database transaction, and holds the billing clinic's
 * Stripe mutation lease (`entitlements.stripe_mutation_lease_*`) for the
 * length of a change, so it answers `busy` rather than race a worker. The
 * result unions are the contract the portal and the console are built
 * against; a refusal always carries a sentence fit to show.
 *
 * STUB written by S0 with the final signatures (R30); Package C-actions
 * replaces the bodies. Until then each action answers `not_available` where
 * its union has a status for it, `unavailable` for the portal session, and
 * throws BillingActionNotBuiltError where it has neither.
 */

/** Thrown by an action whose result has no "not available" status, while it is a stub. */
export class BillingActionNotBuiltError extends Error {
  constructor(readonly action: string) {
    super(`${action} is not built yet (Package C-actions).`);
    this.name = "BillingActionNotBuiltError";
  }
}

const NOT_AVAILABLE = "This isn't available yet. Nothing was changed and nothing was charged.";

// -----------------------------------------------------------------------------
// changePlan (BD12, R7, R13)
// -----------------------------------------------------------------------------

export type ChangePlanInput = {
  clinicId: string;
  planId: string;
  interval: BillingInterval;
  /** Fresh per user attempt, supplied by the UI: a retry is recognised by it, never by comparing prices. */
  requestId: string;
  actorLabel: string;
};

export type ChangePlanResult =
  | {
      status: "changed";
      /** The invoice for the setup-fee difference or the proration, when one was raised. */
      hostedInvoiceUrl: string | null;
      /** Channels in service that the new package does not include: the gate passes them through. */
      droppedChannels: Channel[];
    }
  | { status: "refused" | "busy" | "payment_failed" | "not_available"; message: string };

export async function changePlan(input: ChangePlanInput): Promise<ChangePlanResult> {
  void input;
  return { status: "not_available", message: NOT_AVAILABLE };
}

// -----------------------------------------------------------------------------
// addLocation (BD13, R14)
// -----------------------------------------------------------------------------

export type AddLocationInput = {
  clinicId: string;
  /** Fresh per user attempt; the pending-location columns resume a failed attempt by it. */
  requestId: string;
  actorLabel: string;
  name?: string;
};

export type AddLocationResult =
  | { status: "added"; clinicId: string; slug: string }
  | {
      status: "pending_setup" | "refused" | "busy" | "payment_failed" | "not_available";
      message: string;
    };

export async function addLocation(input: AddLocationInput): Promise<AddLocationResult> {
  void input;
  return { status: "not_available", message: NOT_AVAILABLE };
}

// -----------------------------------------------------------------------------
// setAutoRenew (BD10, R5, R15)
// -----------------------------------------------------------------------------

export type SetAutoRenewInput = { clinicId: string; on: boolean; actorLabel: string };

export type SetAutoRenewResult =
  | {
      status: "ok";
      /** ISO date the account closes on with auto-renew off; null with it on. */
      closesOn: string | null;
    }
  | { status: "busy" | "refused"; message: string };

export async function setAutoRenew(input: SetAutoRenewInput): Promise<SetAutoRenewResult> {
  void input;
  throw new BillingActionNotBuiltError("setAutoRenew");
}

// -----------------------------------------------------------------------------
// createPortalSession (BD15)
// -----------------------------------------------------------------------------

export type CreatePortalSessionInput = {
  clinicId: string;
  /** Where Stripe's portal sends the browser back: a publicUrl() on apps/app. */
  returnUrl: string;
  /** Open straight on the card form. Payment method and invoice history are all the portal offers. */
  flow?: "payment_method_update";
};

/**
 * The URL lasts about five minutes: hand it to the browser at once, never put
 * it in an email.
 */
export type CreatePortalSessionResult = { url: string } | { status: "unavailable" };

export async function createPortalSession(
  input: CreatePortalSessionInput,
): Promise<CreatePortalSessionResult> {
  void input;
  return { status: "unavailable" };
}

// -----------------------------------------------------------------------------
// previewRefund and commitRefund (BD14, R15)
// -----------------------------------------------------------------------------

/**
 * Terms § 5: the first period refunded in full and the plan cancelled at once
 * (`first_period_cancel`), or one month's fee by operator judgement with the
 * plan kept (`guarantee`). They do not stack, and the setup fee is never
 * refunded.
 */
export type RefundKind = "first_period_cancel" | "guarantee";

export type PreviewRefundInput = { clinicId: string; kind: RefundKind };

export type PreviewRefundResult =
  | {
      status: "ok";
      kind: RefundKind;
      /** What commitRefund will refund. It refuses a confirmation of any other amount. */
      amountCents: number;
      /** first_period_cancel cancels the plan at once; guarantee keeps it. */
      cancelsPlan: boolean;
      /** The Terms' dates, for the operator: when the plan started and when this refund's window ends. ISO dates. */
      planStartedOn: string | null;
      windowEndsOn: string | null;
    }
  | { status: "refused" | "not_available"; message: string };

export async function previewRefund(input: PreviewRefundInput): Promise<PreviewRefundResult> {
  void input;
  return { status: "not_available", message: NOT_AVAILABLE };
}

export type CommitRefundInput = {
  clinicId: string;
  kind: RefundKind;
  /** The amount previewRefund showed; anything else is refused. */
  confirmAmountCents: number;
  /** Why, in the operator's words, for the billing history. Required. */
  reason: string;
  actorLabel: string;
};

export type CommitRefundResult =
  | {
      status: "refunded";
      amountCents: number;
      /** ISO timestamp the refund was stamped. */
      refundedAt: string;
      /** A first-period refund records a cancel_now request in the same transaction. */
      isCancelRequested: boolean;
    }
  | { status: "refused" | "busy" | "failed" | "not_available"; message: string };

export async function commitRefund(input: CommitRefundInput): Promise<CommitRefundResult> {
  void input;
  return { status: "not_available", message: NOT_AVAILABLE };
}
