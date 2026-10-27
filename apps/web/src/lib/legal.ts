import { BAA_1_6_0_RELEASED } from "@healdesk/catalog";

import {
  FIRST_PERIOD_REFUND_DAYS,
  type PackageId,
  PACKAGES,
  packageSetupFeeUsd,
  type Product,
  PRODUCTS,
} from "@healdesk/catalog";

/**
 * The facts the legal pages are built from.
 *
 * Two kinds. The first kind is code: which cookie the demo sets, which
 * kinds of vendor receive what, what the packages cost — those are imported
 * from the modules that own them (src/lib/gate.ts, src/lib/subprocessors.ts,
 * the catalog) so the pages cannot quote a stale number. The second kind is
 * something only the founder knows: the legal entity, its address, the
 * governing law, the liability floor, the refund window, the guarantee
 * thresholds. Those are the fields below. While any of the REQUIRED entity
 * facts was empty every legal page rendered a visible "draft" banner
 * (`legalFactsComplete()`, read by components/LegalPage.tsx); they have all
 * been supplied, so the banner no longer renders, and nothing was invented in
 * the meantime. The registered street address was the last one outstanding
 * and came in on 3 October 2026; it prints on the legal pages, not in the
 * footer, and the comment on it says why.
 *
 * Bump `VERSION` and `LAST_UPDATED` together whenever any page's text
 * changes; the footer of each page prints both. src/lib/legal-version.test.ts
 * pins a hash of each page's text to the version, so a change that forgets
 * the bump fails the build.
 */

// BAA 1.6.0's release brings back terms section 9's "The Business Associate
// Agreement states the same", so it is a new text and a new version; the flag
// is the same one that moves the agreement (packages/catalog/src/baa.ts).
export const LEGAL_VERSION = BAA_1_6_0_RELEASED ? "2026-10-27.2" : "2026-10-27.1";
export const LEGAL_LAST_UPDATED = "27 October 2026";

export const ENTITY = {
  /** Full legal name, e.g. "Healdesk, Inc." Empty until the founder supplies it. */
  legalName: "Viixi FZC",
  /**
   * The entity's form, as it follows the name in the "Operating entity"
   * clause of each legal page (terms § 20, privacy § 10) and in the entity
   * line (`entityLine()` below). Not "trading as healdesk":
   * the trade name is the contracting party and the entity is disclosed as
   * its operator — decision of 23 September 2026, docs/handover.md
   * "Decisions log", item 14.
   */
  formation: "a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates",
  /**
   * The registered street address, exactly as it appears on the trade
   * licence. Supplied by the owner on 3 October 2026. Meta's Business
   * Verification compares this address with the licence, so it must match the
   * licence character for character (docs/v1-product-spec.md, "Verification
   * details that decide pass or fail"). It is a different thing from
   * `postalAddress` below, which is a US correspondence mailbox.
   *
   * It renders on the legal pages only — terms § 20 and privacy § 10, where a
   * reader is looking for the contracting entity and the surrounding clauses
   * can say what the address is. It is deliberately NOT in the site footer:
   * `entityLine()` ends at the formation, and the footer prints
   * `postalAddress` instead, which is the address the business actually rents
   * for correspondence (owner's decision, 3 October 2026). Business
   * Verification reads the legal name off the website, not the address, so
   * nothing in that gate needs it in the footer.
   */
  registeredAddress: "Business Center, Sharjah Publishing City Free Zone, Sharjah, United Arab Emirates",
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
  /**
   * The one email address, for everything: legal notices (terms § 18),
   * privacy and deletion requests, security questions, the guarantee claim,
   * and support. There is no legal@ or privacy@ mailbox, and no page may name
   * one (owner, 9 October 2026). Every legal page reads this field rather
   * than typing the address, `site.email` in src/lib/site.ts and the
   * catalog's `SENDER_IDENTITY.replyTo` must equal it
   * (src/lib/sender-identity.test.ts), and src/lib/site-copy.test.ts fails on
   * any other @healdesk.io address in the site's copy.
   */
  email: "hello@healdesk.io",
} as const;

export const POLICY = {
  /**
   * Days after the plan start (the day the agent first answers a patient)
   * within which the first period is refundable in full. 0 = no refund
   * window. The setup fee is never refunded (owner, 6 October 2026, which
   * ended the 3 October exception for a Practice with nothing live after 30
   * days). The number lives in the catalog so apps/app's refund actions read
   * the same one.
   */
  refundWindowDays: FIRST_PERIOD_REFUND_DAYS,
  /** Whether an annual plan cancelled mid-term is refunded pro rata. */
  annualProRataRefund: false,
  /**
   * The first-month guarantee (terms § 5, rendered from GUARANTEE_TEXT below).
   * A call counts as answered when the assistant's opening line starts within
   * this many seconds of the call reaching us; a message when the first reply
   * is sent within this many seconds of arriving; a call the caller ends sooner
   * than the abandoned threshold is a hang-up or a pocket dial, not a miss. Set by
   * the owner on 1 October 2026, adopting docs/counsel/guarantee-and-refund.md
   * without external counsel review and ahead of measured latency. Revisit
   * once the routed/answered counter in apps/app exists; the guarantee text
   * quotes these numbers, so changing one changes the contract.
   */
  guaranteeCallAnswerSeconds: 10,
  guaranteeMessageAnswerSeconds: 60,
  guaranteeAbandonedCallSeconds: 5,
  /** The guarantee's first month, in days from the plan start: the day the agent first answers a patient. */
  guaranteeFirstMonthDays: 30,
  /** Days after the first month ends within which the account owner may claim. */
  guaranteeClaimWindowDays: 30,
  /** Business days after a claim within which we tell the account owner our finding. */
  guaranteeFindingBusinessDays: 10,
  /** Days after our finding of a miss within which the refund is made. */
  guaranteeRefundWithinDays: 14,
  /**
   * Days after our own records show a miss within which we tell the account
   * owner, whether or not they have claimed: only we can see the counter, so a
   * claim window with no duty to speak would be a trap.
   */
  guaranteeMissNoticeDays: 7,
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
  /**
   * The longest a call back asked for on a demo call is kept: the number and
   * the one line about what to discuss go once the team has called, or after
   * this many days, whichever comes first (lib/demo/callbacks.ts; owner,
   * 26 October 2026).
   */
  demoCallbackRetentionDays: 30,
} as const;

/**
 * The first-month guarantee, word for word.
 *
 * The spec ("The guarantee") requires the wording to be identical wherever
 * the guarantee is advertised and in the service agreement, so it lives here
 * once: terms § 5 renders it, and so does checkout's Review and pay step
 * (components/checkout/ReviewStep.tsx), in full beside the prices, which is
 * where a buyer meets it now that there is no pricing page (owner, 9 October
 * 2026). 16 CFR 239.3(b) wants the conditions where the claim is made, and
 * components/guarantee-copy.test.ts holds the two surfaces to the same words.
 * Each paragraph is a bold lead-in and a body so both mark it up the same
 * way. The numbers are read from POLICY and the address from ENTITY,
 * so the text carries no placeholder and cannot drift from them. What the
 * terms add around it — that the refund sits outside the liability section
 * and that force majeure does not excuse a miss — is contract mechanics and
 * stays in the terms, where the section numbers mean something.
 *
 * The adopted text of docs/counsel/guarantee-and-refund.md ("The adopted
 * text"), word for word, adopted by the owner on 1 October 2026 without
 * external counsel review: claim-based, one refund per practice, one month at
 * the annual per-month price on annual plans, our records plus any record the
 * Practice sends, and a failure of our own systems or suppliers counts as
 * ours. One sentence was added to "How to claim" on 3 October 2026, the one
 * after the records we check: the claim goes to a mailbox on the no-PHI side,
 * so a carrier record or an inbox screenshot must arrive with the patients'
 * numbers blacked out and without a transcript.
 */
export const GUARANTEE_TEXT = {
  heading: "Our first-month guarantee",
  paragraphs: [
    {
      lead: "Our first-month guarantee.",
      body:
        "If, during your first month, the assistant fails to answer a call or message routed to it, we refund your first month's subscription fee. The setup fee is not part of this guarantee.",
    },
    {
      lead: "Your first month",
      body:
        `is the ${POLICY.guaranteeFirstMonthDays} days that start on your plan start, the day the assistant first answers a patient, as shown in your portal. A channel that goes live later is covered from the day it goes live until the end of those ${POLICY.guaranteeFirstMonthDays} days. A channel that goes live after your first month ends is not covered.`,
    },
    {
      lead: "Routed to it",
      body:
        "means: a phone call your carrier forwards to a healdesk number assigned to one of your locations, from the moment your carrier's record or ours shows the forward; a message a visitor sends from the healdesk widget on your website; and an Instagram, Messenger or WhatsApp message sent to an account you connected while that channel was switched on. A call or message that was routed to us and that our systems or our suppliers failed to receive still counts as routed.",
    },
    {
      lead: "Answered",
      body:
        `means: on a call, the assistant starts its opening line within ${POLICY.guaranteeCallAnswerSeconds} seconds of the call reaching us and the call is not later cut off by our systems or our suppliers; on a message, the assistant's first reply is sent within ${POLICY.guaranteeMessageAnswerSeconds} seconds of the message reaching us. A fixed safety reply, such as the one given when someone reports an urgent symptom, counts as an answer. A fixed line sent only because our systems or our suppliers had failed does not.`,
    },
    {
      lead: "What does not count:",
      body:
        `calls and messages that reach us while you have paused the assistant or switched that channel off, while your service is suspended for non-payment, or after your monthly allowance has run out and your setting is "Stop and fall back"; calls the caller ends within ${POLICY.guaranteeAbandonedCallSeconds} seconds of reaching us; and calls and messages that never reach us because of your phone carrier, your call-forwarding settings, your website, the visitor's connection, or Meta. A call the caller ends after ${POLICY.guaranteeAbandonedCallSeconds} seconds and before the opening line has started does count as missed. A call or message that reaches us and is not answered because our systems or one of our suppliers failed counts as missed whatever the cause of that failure, even if the call then forwards to your own line; an event outside our control does not excuse it. Our suppliers are the companies we choose to run the service: telephony and speech, the language model, and hosting. Your carrier, Google and Meta are not our suppliers.`,
    },
    {
      lead: "How to claim.",
      body:
        `Within ${POLICY.guaranteeClaimWindowDays} days after your first month ends, the account owner emails ${ENTITY.email} from the address on your account and asks us to check, giving the date, time and channel of any call or message you believe was missed, if you have one. We check our own records and any record you send us: a call record from your phone carrier, or a screenshot of an unanswered message in your Instagram, Messenger or WhatsApp inbox. Send dates and times, not names: black out every phone number on a carrier record or screenshot except its last four digits, and never send a transcript. A call your carrier's record shows forwarded to your healdesk number, or a message your inbox shows with no reply from us within the time above, counts as missed unless our records show it was answered, or show that it never left your carrier or Meta. We tell you our finding within ${POLICY.guaranteeFindingBusinessDays} business days of your claim. If one call or message was missed, we refund your first month's subscription fee to the payment method you paid with, within ${POLICY.guaranteeRefundWithinDays} days of that finding, and tell you what failed. If our own records show a miss, we tell the account owner by email within ${POLICY.guaranteeMissNoticeDays} days of recording it, whether or not you have claimed.`,
    },
    {
      lead: "Limits.",
      body:
        "One refund per practice, meaning one account, however many locations or channels it has. On an annual plan, the refund is one month at your plan's annual per-month price, meaning the annual fee divided by twelve. You do not have to cancel to claim; if you stay, the service continues as normal. This refund is your only remedy for a call or message missed during your first month. It does not limit your rights under your Data Agreement, or for anything other than the missed call or message itself.",
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
 * and in `entityLine()` below, and nowhere else.
 */
export function entityDisplayName(): string {
  return ENTITY.legalName || "healdesk";
}

/**
 * The entity line, worded as the spec requires it: "healdesk is a service of
 * Viixi FZC, a company registered under the Sharjah Publishing City Free
 * Zone, United Arab Emirates". The Terms and Privacy pages name the entity in
 * their "Operating entity" clauses (terms § 20, privacy § 10); this line is
 * printed by the personalised demo's notice and the email footers
 * (lib/email/setup-emails.ts, and apps/app through the catalog's
 * SENDER_IDENTITY). The site footer carried it until 9 October 2026, when the
 * owner took it out: the spec asked for it there for Meta's Business
 * Verification, which cleared on 4 October.
 *
 * The line ends at the formation and never carries `ENTITY.registeredAddress`.
 * The registered address is a legal fact, and it belongs where a reader has
 * the clauses around it to tell it apart from a place of business: terms § 20
 * and privacy § 10 print it, beside `ENTITY.postalAddress`, the US mailbox the
 * business rents, under its own label. Owner's decision, 3 October 2026.
 */
export function entityLine(): string {
  return `healdesk is a service of ${entityDisplayName()}, ${ENTITY.formation}.`;
}

/**
 * Terms § 3's product table: the three products of the pricing sheet of
 * 13 October 2026, in its order, each with its price per 100, its extra-100
 * price and its setup fee. Plans are a package at its steps, 495 of them, so
 * the terms state the products and the rule that builds a plan from them,
 * never a row per plan.
 */
export function productsForTerms(): readonly Product[] {
  return [PRODUCTS.voice, PRODUCTS.webchat, PRODUCTS.metachat];
}

/** Terms § 3's package table: the five packages and each one's setup fee at list price. */
export function packagesForTerms(): readonly { id: PackageId; name: string; setupFeeUsd: number }[] {
  return PACKAGES.map((pkg) => ({ id: pkg.id, name: pkg.name, setupFeeUsd: packageSetupFeeUsd(pkg) }));
}
