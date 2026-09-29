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

export const LEGAL_VERSION = "2026-09-29.1";
export const LEGAL_LAST_UPDATED = "29 September 2026";

export const ENTITY = {
  /** Full legal name, e.g. "Healdesk, Inc." Empty until the founder supplies it. */
  legalName: "Viixi FZC",
  /**
   * The entity's form, as it follows the name in the one "Operating entity"
   * clause of each legal page (terms § 20, privacy § 10). Not "trading as
   * healdesk": on the page the trade name is the contracting party and the
   * entity is disclosed, once, as its operator — decision of 23 September
   * 2026, docs/handover.md "Decisions log", item 14.
   */
  formation: "a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates",
  /**
   * A registered-agent mailbox in Delaware — the same one as
   * packages/leadgen/src/enrich/footer.ts POSTAL_ADDRESS and the Scalabid
   * site. It is for correspondence and the CAN-SPAM footer only: never
   * present it as a place of business, a registered office or a
   * service-of-process address (terms § 20 prints postalAddressDisclaimer
   * under it, and every legal page labels it with postalAddressLabel). No
   * UAE street address is published anywhere. The owner must confirm the
   * Stripe Business-details address matches this one, because Stripe prints
   * its own on receipts and invoices and the two must not disagree.
   */
  postalAddress: "800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States",
  /** How the mailbox is labelled wherever a legal page prints it. */
  postalAddressLabel: "US mailing address (correspondence only)",
  /** Printed under the mailbox in terms § 20 so nobody reads it as an office. */
  postalAddressDisclaimer:
    "The US mailing address is provided for convenience of US-based correspondence only and does not constitute a place of business, registered office, or service-of-process address for the operating entity.",
  /**
   * Governing law and venue. Delaware, by recommendation: the seller is a UAE
   * entity with no home state, US clinics will not accept UAE law or venue,
   * and Delaware is the neutral US default clinic counsel expects.
   */
  governingLawState: "Delaware",
  /** Email for legal notices. Exists on the catch-all; see the launch guide. */
  noticesEmail: "legal@healdesk.io",
  /** Email for privacy requests (access, deletion, do-not-sell). */
  privacyEmail: "privacy@healdesk.io",
  supportEmail: "hello@healdesk.io",
} as const;

export const POLICY = {
  /**
   * Days after purchase within which the first period is refundable in full.
   * 0 = no refund window. The setup fee is never refundable, regardless of
   * this value (decision of 21 September 2026).
   */
  refundWindowDays: 14,
  /** Whether an annual plan cancelled mid-term is refunded pro rata. */
  annualProRataRefund: false,
  /**
   * Fallback liability cap, reached only where the law refuses the outright
   * exclusion in terms § 13: the greater of 12 months' fees or this floor, in
   * USD. 0 = no floor. Decided 21 September 2026: no floor, and no insurance
   * behind it. Revised 22 September 2026: liability is excluded where the law
   * allows and every claim, defence and notification cost is shifted to the
   * practice by the § 14 indemnity — see docs/handover.md, "Decisions log",
   * item 10. Raising this number without cover to pay it is a promise on paper.
   */
  liabilityFloorUsd: 0,
  /** Months a demo lead that never becomes a customer is kept. */
  leadRetentionMonths: 12,
  /** Days server logs (IP + path, for abuse control) are kept. */
  logRetentionDays: 30,
  /**
   * How long the record of consent to a demo call is kept. The TCPA's
   * limitation period is four years; the record is the whole defence, so it
   * is kept for that and then purged (api/cron/purge-leads).
   */
  callConsentRetentionYears: 4,
  /** Days of notice before a new subprocessor that handles patient data goes live. */
  subprocessorNoticeDays: 15,
} as const;

/** True when every fact a contract needs from the founder is present. */
export function legalFactsComplete(): boolean {
  return Boolean(
    ENTITY.legalName && ENTITY.formation && ENTITY.postalAddress && ENTITY.governingLawState,
  );
}

/**
 * The entity as it should read in a contract, or the trading name while draft.
 * Called only from the two "Operating entity" clauses (terms § 20, privacy
 * § 10); everywhere else the trade name is the party and the entity is not
 * named. Keep it that way.
 */
export function entityDisplayName(): string {
  return ENTITY.legalName || "healdesk";
}

export function packagesForTerms(): readonly Plan[] {
  return plans;
}
