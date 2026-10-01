import { plans, type Plan } from "@healdesk/catalog";

/**
 * The facts the legal pages are built from.
 *
 * Two kinds. The first kind is code: which cookie the demo sets, which
 * vendors receive what, what the packages cost — those are imported from the
 * modules that own them (src/lib/gate.ts, src/lib/subprocessors.ts, the
 * catalog) so the pages cannot quote a stale number. The second kind is
 * something only the founder knows: the legal entity, its address, the
 * governing law, the liability floor, the refund window, the guarantee
 * thresholds. Those are the fields below. While any of the REQUIRED entity
 * facts was empty every legal page rendered a visible "draft" banner
 * (`legalFactsComplete()`, read by components/LegalPage.tsx); they have all
 * been supplied, so the banner no longer renders, and nothing was invented in
 * the meantime. The registered street address is still empty and is the one
 * fact that renders only once filled.
 *
 * Bump `VERSION` and `LAST_UPDATED` together whenever any page's text
 * changes; the footer of each page prints both.
 */

export const LEGAL_VERSION = "2026-10-01.2";
export const LEGAL_LAST_UPDATED = "1 October 2026";

export const ENTITY = {
  /** Full legal name, e.g. "Healdesk, Inc." Empty until the founder supplies it. */
  legalName: "Viixi FZC",
  /**
   * The entity's form, as it follows the name in the "Operating entity"
   * clause of each legal page (terms § 20, privacy § 10) and in the site
   * footer's entity line (`entityLine()` below). Not "trading as healdesk":
   * the trade name is the contracting party and the entity is disclosed as
   * its operator — decision of 23 September 2026, docs/handover.md
   * "Decisions log", item 14.
   */
  formation: "a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates",
  /**
   * The registered street address, exactly as it appears on the trade
   * licence. Empty until the founder supplies it: it is never guessed, and
   * nothing renders it while it is empty. Meta's Business Verification
   * compares this address with the licence, so when it is filled it must match
   * the licence character for character (docs/v1-product-spec.md,
   * "Verification details that decide pass or fail"). It is a different thing
   * from `postalAddress` below, which is a US correspondence mailbox.
   */
  registeredAddress: "",
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
   * The first-month guarantee (terms § 5, rendered from GUARANTEE_TEXT below).
   * A call counts as answered when the assistant's opening line starts within
   * this many seconds of the call reaching us; a message when the first reply
   * is sent within this many seconds of arriving; a call that ends sooner than
   * the abandoned threshold is a hang-up or a pocket dial, not a miss. Set by
   * the owner on 1 October 2026, adopting docs/counsel/guarantee-and-refund.md
   * without external counsel review and ahead of measured latency. Revisit
   * once the routed/answered counter in apps/app exists; the guarantee text
   * quotes these numbers, so changing one changes the contract.
   */
  guaranteeCallAnswerSeconds: 10,
  guaranteeMessageAnswerSeconds: 60,
  guaranteeAbandonedCallSeconds: 5,
  /** Days after the first month ends within which the account owner may claim. */
  guaranteeClaimWindowDays: 30,
  /** Days after a claim that shows a miss within which the refund is made. */
  guaranteeRefundWithinDays: 14,
  /**
   * Days after the service ends for which forwarded calls are still passed
   * straight through to the Practice's direct line (terms § 7). The spec's
   * rule — non-payment never produces a dead phone line — has no end date;
   * this is the floor the terms promise, and the pass-through stops sooner
   * only when the Practice removes its own call forwarding.
   */
  forwardingPassThroughDays: 30,
  /**
   * Fallback liability cap, reached only where the law refuses the outright
   * exclusion in terms § 13: the greater of 12 months' fees or this floor, in
   * USD. 0 = no floor. Decided 21 September 2026: no floor, and no insurance
   * behind it. Revised 22 September 2026: liability is excluded where the law
   * allows and every claim, defence and notification cost is shifted to the
   * practice by the § 14 indemnity — see docs/handover.md, "Decisions log",
   * item 10. The cap never reaches wilful misconduct, gross negligence or a
   * liability the law forbids limiting, and nothing shifts a civil money
   * penalty a regulator imposes on healdesk itself; the BAA allocates
   * liability for patient information the same way. Raising this number
   * without cover to pay it is a promise on paper.
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

/**
 * The first-month guarantee, word for word.
 *
 * The spec ("The guarantee") requires the wording to be identical on the
 * pricing page and in the service agreement, so it lives here once: terms § 5
 * renders it, and /pricing must render this same object rather than restate
 * it. Each paragraph is a bold lead-in and a body so both pages mark it up
 * the same way. The numbers are read from POLICY and the address from ENTITY,
 * so the text carries no placeholder and cannot drift from them. What the
 * terms add around it — that the refund sits outside the liability section
 * and that force majeure does not excuse a miss — is contract mechanics and
 * stays in the terms, where the section numbers mean something.
 *
 * Adopted by the owner on 1 October 2026 from the draft in
 * docs/counsel/guarantee-and-refund.md, without external counsel review:
 * claim-based, one refund per practice, one month at the annual per-month
 * price on annual plans, our records plus any carrier record the Practice
 * sends, and a failure of our own systems or suppliers counts as ours.
 */
export const GUARANTEE_TEXT = {
  heading: "Our first-month guarantee",
  paragraphs: [
    {
      lead: "Our first-month guarantee.",
      body:
        "If, during your first month, the assistant fails to answer any call or message routed to it, we refund your first month's subscription fee.",
    },
    {
      lead: "Your first month",
      body:
        "is the 30 days that start on the day your first channel goes live, as shown in your portal.",
    },
    {
      lead: "Routed to it",
      body:
        "means: a phone call that reaches the healdesk number assigned to your practice; a website chat message that reaches our servers from the widget on your site; and an Instagram, Messenger or WhatsApp message that Meta delivers to us from an account you connected.",
    },
    {
      lead: "Answered",
      body:
        `means: on a call, the assistant speaks its opening line within ${POLICY.guaranteeCallAnswerSeconds} seconds of the call reaching us; on a message, the assistant's first reply is sent within ${POLICY.guaranteeMessageAnswerSeconds} seconds of the message reaching us. A fixed safety reply, such as the one given when someone reports an urgent symptom, counts as an answer.`,
    },
    {
      lead: "What does not count:",
      body:
        `calls and messages that reach us while you have paused the assistant or switched that channel off; while your service is suspended for non-payment; or after your monthly allowance has run out and your setting is "Stop and fall back". Calls that end within ${POLICY.guaranteeAbandonedCallSeconds} seconds of reaching us. Calls and messages that never reach us because of your phone carrier, your call-forwarding settings, your website, or Meta. A call or message that reaches us and is not answered because our systems or one of our suppliers failed does count as missed, even if it then forwards to your own line, and an event outside our control does not excuse it.`,
    },
    {
      lead: "How to claim.",
      body:
        `Within ${POLICY.guaranteeClaimWindowDays} days after your first month ends, the account owner emails ${ENTITY.supportEmail} from the owner's address and asks us to check, giving the date, time and channel of any call or message you believe was missed, if you have one. We check our own records and any call record from your phone carrier that you send us. If one call or message was missed, we refund your first month's subscription fee to the card you paid with, within ${POLICY.guaranteeRefundWithinDays} days of your claim, and tell you what failed.`,
    },
    {
      lead: "Limits.",
      body:
        "One refund per practice. On an annual plan, the refund is one month at your plan's annual per-month price. The setup fee is not refundable under this guarantee or otherwise. You do not have to cancel to claim; if you stay, the service continues as normal. This refund is the only remedy for a call or message missed during your first month.",
    },
  ],
} as const;

/** True when every fact a contract needs from the founder is present. */
export function legalFactsComplete(): boolean {
  return Boolean(
    ENTITY.legalName && ENTITY.formation && ENTITY.postalAddress && ENTITY.governingLawState,
  );
}

/**
 * The entity as it should read in a contract, or the trading name while draft.
 * Called from the "Operating entity" clauses (terms § 20, privacy § 10).
 * Elsewhere the trade name is the party; the entity is named in those clauses
 * and in the footer's entity line, and nowhere else.
 */
export function entityDisplayName(): string {
  return ENTITY.legalName || "healdesk";
}

/**
 * The entity line the site footer prints on every page, worded as the spec
 * requires it in the footer and on the Terms and Privacy pages: "healdesk is a
 * service of Viixi FZC, a company registered under the Sharjah Publishing City
 * Free Zone, United Arab Emirates". The registered address follows only once
 * `ENTITY.registeredAddress` is filled in; until then the line ends at the
 * formation rather than printing a placeholder.
 */
export function entityLine(): string {
  const address = ENTITY.registeredAddress
    ? `, registered address ${ENTITY.registeredAddress}`
    : "";
  return `healdesk is a service of ${entityDisplayName()}, ${ENTITY.formation}${address}.`;
}

export function packagesForTerms(): readonly Plan[] {
  return plans;
}
