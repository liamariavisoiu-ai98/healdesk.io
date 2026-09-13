import { plans, type Plan } from "@healdesk/catalog";

/**
 * The facts the legal pages are built from.
 *
 * Two kinds. The first kind is code: which cookie the demo sets, which
 * vendors receive what, what the packages cost — those are imported from the
 * modules that own them (src/lib/gate.ts, src/lib/subprocessors.ts, the
 * catalog) so the pages cannot quote a stale number. The second kind is
 * something only the founder knows: the legal entity, its address, the
 * governing law, the liability floor, the refund window. Those are the
 * fields below, and while any of the REQUIRED ones is empty every legal
 * page renders a visible "draft" banner and the checkout does not claim the
 * terms are final. Fill them in and the banner goes away; nothing is
 * invented in the meantime.
 *
 * Bump `VERSION` and `LAST_UPDATED` together whenever any page's text
 * changes; the footer of each page prints both.
 */

export const LEGAL_VERSION = "2026-09-13.2";
export const LEGAL_LAST_UPDATED = "13 September 2026";

export const ENTITY = {
  /** Full legal name, e.g. "Healdesk, Inc." Empty until the founder supplies it. */
  legalName: "",
  /** "a Delaware corporation" / "a Texas limited liability company". */
  formation: "",
  /** Physical postal address for notices and the CAN-SPAM footer. */
  postalAddress: "",
  /** Governing law and venue, e.g. "Texas". */
  governingLawState: "",
  /** Email for legal notices. Exists on the catch-all; see the launch guide. */
  noticesEmail: "legal@healdesk.io",
  /** Email for privacy requests (access, deletion, do-not-sell). */
  privacyEmail: "privacy@healdesk.io",
  supportEmail: "hello@healdesk.io",
} as const;

export const POLICY = {
  /**
   * Days after purchase within which the first period is refundable in full.
   * 0 = no refund window. The setup fee is never refundable once provisioning
   * has begun, regardless of this value.
   */
  refundWindowDays: 0,
  /** Whether an annual plan cancelled mid-term is refunded pro rata. */
  annualProRataRefund: false,
  /**
   * Liability cap: the greater of 12 months' fees or this floor, in USD.
   * 0 = no floor (cap is 12 months' fees). The founder sets the floor.
   */
  liabilityFloorUsd: 0,
  /** Months a demo lead that never becomes a customer is kept. */
  leadRetentionMonths: 12,
  /** Days server logs (IP + path, for abuse control) are kept. */
  logRetentionDays: 30,
  /** Days of notice before a new subprocessor that handles patient data goes live. */
  subprocessorNoticeDays: 15,
} as const;

/** True when every fact a contract needs from the founder is present. */
export function legalFactsComplete(): boolean {
  return Boolean(
    ENTITY.legalName && ENTITY.formation && ENTITY.postalAddress && ENTITY.governingLawState,
  );
}

/** The entity as it should read in a contract, or the trading name while draft. */
export function entityDisplayName(): string {
  return ENTITY.legalName || "healdesk";
}

export function packagesForTerms(): readonly Plan[] {
  return plans;
}
