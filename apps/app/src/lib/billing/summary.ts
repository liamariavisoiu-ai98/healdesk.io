import type { BillingInterval, Channel } from "@healdesk/catalog";

import type { BillingStatus, UsageMeter } from "@/db/schema";

import { BillingActionNotBuiltError } from "./stripe-actions";

/**
 * What the portal's Billing screen reads (R30, finding 19).
 *
 * `getBillingSummary` reads the database only, never Stripe, so the screen
 * renders even while Stripe is slow or down and a page view costs no API
 * call; it describes the BILLING clinic of the clinic it is given. The
 * previews ask Stripe what an action would charge before the clinic confirms
 * it, outside any transaction.
 *
 * STUB written by S0 with the final signatures; Package C-actions replaces
 * the bodies. Until then each preview answers `not_available`, and
 * getBillingSummary, whose result has no such status, throws
 * BillingActionNotBuiltError.
 */

const NOT_AVAILABLE = "This isn't available yet.";

/** One allowance meter, pooled across the billing group's locations. */
export type UsageMeterSummary = {
  meter: UsageMeter;
  used: number;
  /** effectiveIncluded (BD5): the allowance for the window, times the locations. */
  included: number;
  /** ISO timestamps of the allowance window; null before the plan starts (BD6). */
  windowStart: string | null;
  windowEnd: string | null;
};

export type BillingSummary = {
  /** The clinic the subscription belongs to: a location's summary is its billing clinic's. */
  billingClinicId: string;
  status: BillingStatus;
  boughtPlanId: string | null;
  /** The package Stripe bills now; null before the plan starts, while the $0 line stands. */
  billedPlanId: string | null;
  interval: BillingInterval;
  locations: number;
  /** R8: the plan-start update went through, or the first plan invoice was paid. */
  isPlanStarted: boolean;
  /** ISO timestamps from here on. When the first plan invoice was paid. */
  planStartedAt: string | null;
  /** The end of the first plan period: the first renewal. */
  firstPeriodEndsAt: string | null;
  paidThrough: string | null;
  setupDeadlineAt: string | null;
  isAutoRenewOn: boolean;
  /**
   * When the account closes, if it does: Stripe's cancel_at, or before the
   * start the earlier of that and the setup deadline (BD10). Null while it
   * renews.
   */
  closesOn: string | null;
  /** Every channel with a first answer, across the billing group's locations. */
  channelsInService: Channel[];
  /** In service but not yet in the billed package: their price joins at the next step-up. */
  channelsNotYetPriced: Channel[];
  overageMode: "allow" | "hard_cap";
  usageAlertsEnabled: boolean;
  /** The unpaid invoice, while there is one: Stripe's hosted pay page and what it asks for. */
  openInvoice: { url: string | null; amountDueCents: number | null } | null;
  graceEndsAt: string | null;
  usage: UsageMeterSummary[];
};

/** Null when the billing clinic has no entitlements row (a synthetic or demo clinic). */
export async function getBillingSummary(clinicId: string): Promise<BillingSummary | null> {
  void clinicId;
  throw new BillingActionNotBuiltError("getBillingSummary");
}

export type PreviewNextInvoiceResult =
  | {
      status: "ok";
      amountDueCents: number;
      /** ISO date Stripe will charge it. */
      nextPaymentOn: string | null;
      periodStartsOn: string | null;
      periodEndsOn: string | null;
    }
  | { status: "not_available"; message: string };

export async function previewNextInvoice(clinicId: string): Promise<PreviewNextInvoiceResult> {
  void clinicId;
  return { status: "not_available", message: NOT_AVAILABLE };
}

export type PreviewChangePlanInput = {
  clinicId: string;
  planId: string;
  interval: BillingInterval;
};

export type PreviewChangePlanResult =
  | {
      status: "ok";
      planId: string;
      interval: BillingInterval;
      /** The new package's setup fee less the bought one's, times the locations; never negative. */
      setupFeeDeltaCents: number;
      /** What Stripe would invoice now for the rest of the period. */
      prorationCents: number;
      /** The recurring price afterwards, for every location. */
      recurringCents: number;
      /** Channels in service the new package would drop. */
      droppedChannels: Channel[];
    }
  | { status: "refused" | "not_available"; message: string };

export async function previewChangePlan(
  input: PreviewChangePlanInput,
): Promise<PreviewChangePlanResult> {
  void input;
  return { status: "not_available", message: NOT_AVAILABLE };
}

export type PreviewAddLocationResult =
  | {
      status: "ok";
      /** The location count afterwards. */
      locations: number;
      /** The package's recurring price for the new location. */
      recurringCents: number;
      /** The setup fee, charged once. */
      setupFeeCents: number;
      /** What Stripe would invoice now for the rest of the period; 0 before the plan starts. */
      prorationCents: number;
    }
  | { status: "refused" | "not_available"; message: string };

export async function previewAddLocation(clinicId: string): Promise<PreviewAddLocationResult> {
  void clinicId;
  return { status: "not_available", message: NOT_AVAILABLE };
}
