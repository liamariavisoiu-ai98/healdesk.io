/**
 * Who ended an agreement, and why: the closed set a recorded termination
 * carries (`baa_acceptances.termination_reason`, with a CHECK holding the
 * same list), shared by the operator console that records it and apps/app,
 * which decides from it whether a refund is owed.
 *
 * BAA 1.3.0 clause 17 ¶3: "Terminating this agreement ends the Services on
 * the same day. Where Practice terminates because healdesk has violated a
 * material term, or under the Subcontractors clause, no Fees accrue for any
 * time after that day, and healdesk refunds any Fees Practice has paid for
 * that time." Every ending stops the Services, and with them the Fees, on
 * the day; only those two reasons are refunded. healdesk terminating for
 * Practice's breach, a change in law (clause 20), and the agreement ending
 * because the Services ended are not.
 */

export const AGREEMENT_TERMINATION_REASONS = [
  "practice_healdesk_breach",
  "practice_subcontractor_objection",
  "healdesk_practice_breach",
  "change_in_law",
  "services_ended",
] as const;

export type AgreementTerminationReason = (typeof AGREEMENT_TERMINATION_REASONS)[number];

export type AgreementTerminationReasonCopy = {
  /** Who gave the notice. */
  by: "practice" | "healdesk" | "either";
  /** The console's label for the choice. */
  label: string;
  /** Clause 17 ¶3 refunds the fees paid for time after the termination day. */
  refundsFees: boolean;
};

export const AGREEMENT_TERMINATION_REASON_COPY: Readonly<
  Record<AgreementTerminationReason, AgreementTerminationReasonCopy>
> = {
  practice_healdesk_breach: {
    by: "practice",
    label: "The practice ended it: healdesk violated a material term",
    refundsFees: true,
  },
  practice_subcontractor_objection: {
    by: "practice",
    label: "The practice ended it under the Subcontractors clause",
    refundsFees: true,
  },
  healdesk_practice_breach: {
    by: "healdesk",
    label: "healdesk ended it: the practice materially breached it",
    refundsFees: false,
  },
  change_in_law: {
    by: "either",
    label: "Either party ended it after a change in law",
    refundsFees: false,
  },
  services_ended: {
    by: "either",
    label: "It ended with the Services (the subscription ended)",
    refundsFees: false,
  },
};

export function isAgreementTerminationReason(value: unknown): value is AgreementTerminationReason {
  return (
    typeof value === "string" &&
    (AGREEMENT_TERMINATION_REASONS as readonly string[]).includes(value)
  );
}

/** Whether clause 17 ¶3 refunds the fees paid for time after a termination for this reason. */
export function terminationRefundsFees(reason: string | null | undefined): boolean {
  return (
    isAgreementTerminationReason(reason) && AGREEMENT_TERMINATION_REASON_COPY[reason].refundsFees
  );
}
