import { createHash } from "node:crypto";

import { DIRECT_BOOKING_CLAUSE_BODY, DIRECT_BOOKING_CLAUSE_HEADING } from "./direct-booking-addendum";
import { wrap } from "./wrap";

/**
 * The click-through business associate agreement.
 *
 * Self-serve acquisition requires this to be click-through: if signing needs a
 * lawyer on a call, the funnel isn't automated. Three consequences follow, and
 * they shape this whole file.
 *
 * ## The agreement is assembled, not filled in
 *
 * An earlier version was one body of text with a few `{{name}}` holes. That is
 * fine for naming the parties and useless for everything else, because the
 * choices a clinic makes in the funnel change what data we actually receive:
 *
 *   - **Verified attribution** means we hold read-only credentials to their
 *     booking system and pull appointments and settled sales out of it.
 *     **Estimated** means we connect to nothing and see only our own calls.
 *     Those are different data flows and the data-sources clause has to say
 *     which one this clinic bought. (Verified is the phase-two read-back and
 *     is not offered at checkout in v1; the axis stays a live predicate so
 *     the variant set stays honest.)
 *   - **Covered-entity status** decides which regime applies to both parties.
 *     In 1.0.0 it also decided whether reactivation messaging could be
 *     switched on at all — the TCPA healthcare exemption is available only to
 *     a covered entity or its business associate. v1 has no outbound of any
 *     kind, so 1.2.0 carries no clause keyed to it.
 *
 * So a template is a PREAMBLE plus a library of CLAUSES, each of which knows
 * when it applies. Rendering assembles the clauses that apply to this clinic,
 * in a fixed order, and numbers them.
 *
 * The discipline that keeps this reviewable: the clause set is finite and the
 * predicates are pure, so every reachable variant can be enumerated and read.
 * tests/agreements.test.ts renders all of them and asserts each is complete.
 * Counsel reviews a matrix of clauses once rather than an unbounded set of
 * documents — which is the only way "the contract adapts" and "a lawyer has
 * approved the contract" can both be true.
 *
 * ## The hash covers the assembled text
 *
 * There is therefore no single "the BAA text". Two clinics who bought different
 * things signed genuinely different documents, so the hash has to cover the
 * exact assembled document that specific person saw. A template version alone
 * would not answer "what did they actually agree to".
 *
 * ## Rendering happens on the server
 *
 * The browser renders the same clauses through the same function so the preview
 * is honest, but the copy that is hashed and stored is produced again
 * server-side, and the client sends back a hash of what it displayed so a
 * mismatch is refused rather than recorded.
 *
 * ⚖️ Version 1.2.0 is the current template and is what clinics now sign. It
 * was released on 2026-10-01 by the owner, on the owner's own review and
 * without external counsel; the doc comment on `approvedByCounsel` records
 * exactly what that flag now means. 1.0.0, which counsel approved in
 * September 2026, 1.1.0-draft, which was never offered, and 0.1.0-draft are
 * retained below it and never offered again: accounts created against 1.0.0
 * and 0.1.0-draft signed that exact text, and their stored hash has to keep
 * reproducing from it. That reproducibility is the whole reason the ASSEMBLED
 * document is hashed rather than the template.
 *
 * `approvedByCounsel` is enforced rather than merely asserted —
 * provisionClinic() refuses to create a clinic against a template where it is
 * false — so a revision in progress cannot be signed into a live account by
 * accident.
 *
 * To publish a revision: add a new template version, never edit an existing
 * one. Someone has signed the old one.
 */

/**
 * What the clinic chose in the funnel, as far as the agreement cares.
 *
 * Deliberately NOT the whole checkout state. Plan and price have no legal
 * consequence and must not reach the document — a contract that changes with
 * the tier invites the argument that the obligations are negotiable.
 */
export type BaaSelections = {
  /** Display name, e.g. "Med spa". */
  specialty: string;
  /**
   * Verified means we hold read-only credentials to their systems. Estimated
   * means we connect to nothing. Different data flows, different clause.
   */
  attributionMode: "estimated" | "verified";
  /**
   * Booking platform display name, or null for "no booking software".
   *
   * Present even when attribution is estimated — a clinic can name its platform
   * and still decline the connection, and the agreement should not imply we
   * hold credentials we don't.
   */
  connectedPlatform: string | null;
  /**
   * Whether the practice bills insurance electronically.
   *
   * Null means they didn't know, which is a real and common answer for a
   * cash-pay med spa. See docs/research-conclusions.md, Part 3: this one
   * determination decides the contract, the consent standard, and the
   * state-law exposure simultaneously.
   */
  isCoveredEntity: boolean | null;
  /**
   * Whether outbound reminders and follow-ups are switched on.
   *
   * Reactivation is not offered; stays false. Both signing paths pass false
   * (apps/app agreements.ts, apps/web AgreementStep.tsx). In 1.0.0 the field
   * keys `outbound-consent`, the consent warranty — the only clause imposing
   * an obligation on the CLINIC, kept because signed 1.0.0 agreements contain
   * it. In 1.1.0-draft that clause is gone: healdesk captures callback consent
   * itself (`consented-callbacks`, always present), and the field keys only
   * `reactivation-gate`, which therefore never renders. No 1.2.0 clause reads
   * it at all: v1 is inbound only, neither `outbound-consent` nor
   * `reactivation-gate` is registered there, and a 1.2.0 document is
   * byte-identical whatever it holds.
   */
  outboundMessaging: boolean;
  /**
   * Whether the assistant may book a caller straight into the connected
   * calendar ("direct") or hands every request to the front desk
   * ("desk_confirms"). Keys the 1.1.0 `direct-booking` clause; no 1.0.0
   * clause reads it, so a 1.0.0 document is byte-identical whatever it holds.
   *
   * Optional, defaulting to "desk_confirms", so the callers that predate it
   * keep compiling in this wave; both signing paths are expected to pass it
   * explicitly (checkout does not ask, so both pass "desk_confirms"). The
   * election itself is evidenced by the standalone addendum's hash
   * (direct-booking-addendum.ts), never by this field. No 1.2.0 clause reads
   * it either: v1 books into the clinic's own Google Calendar under an
   * unconditional clause, with auto-confirm on by default, and the agreement
   * carries no direct-booking election.
   */
  bookingMode?: "desk_confirms" | "direct";
  /**
   * The calendar healdesk may write appointments into — its display name,
   * e.g. "Cal.com" — or null when no calendar is connected for writing. Keys
   * the 1.1.0 `calendar-write` clause and, for an estimated clinic, picks
   * `data-sources-calendar-only` over `data-sources-none`. Optional,
   * defaulting to null, for the same reason as `bookingMode`. Both signing
   * paths now pass null, identically: Cal.com is not a v1 write target, and
   * no 1.2.0 clause reads this — its Google Calendar clause is unconditional.
   */
  calendarWrite?: { platform: string } | null;
};

export type BaaVariables = BaaSelections & {
  /** The practice's legal name, as it will appear in the agreement. */
  clinicLegalName: string;
  /** Typed by the signer. This is the signature. */
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  /** ISO date. The day they signed, not the day the template was published. */
  effectiveDate: string;
};

export type BaaClause = {
  /** Stable id, recorded with the acceptance so the variant is reproducible. */
  id: string;
  heading: string;
  /**
   * Whether this clause belongs in THIS clinic's agreement.
   *
   * Pure and total: no I/O, no randomness, no throwing. That is what makes the
   * variant set enumerable, and enumerable is what makes it reviewable.
   */
  appliesWhen: (v: BaaVariables) => boolean;
  body: (v: BaaVariables) => string;
};

export type BaaTemplate = {
  version: string;
  /** When this template version was published. Not when anyone signed it. */
  publishedOn: string;
  /**
   * Approved for release by the owner, who takes responsibility for the text.
   * Provisioning refuses a template where this is false, and the signing
   * screen flags one as a draft.
   *
   * The name predates the decision it now records. 1.0.0 was approved by
   * counsel; version 1.2.0 was released on 2026-10-01 on the owner's own
   * review without external counsel, and this flag is what records that
   * release. Not renamed, because provisioning, agreements, AgreementStep and
   * the tests all read it by this name.
   */
  approvedByCounsel: boolean;
  preamble: (v: BaaVariables) => string;
  clauses: readonly BaaClause[];
};

export class BaaRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaaRenderError";
  }
}

const ALWAYS = () => true;

// wrap() — the 78-column wrap every clause renders through — lives in
// ./wrap.ts, shared with the direct-booking addendum so the clause the two
// documents have in common wraps to the same bytes in both.

// -----------------------------------------------------------------------------
// The clause library
// -----------------------------------------------------------------------------

const CLAUSES: readonly BaaClause[] = [
  {
    id: "covered-entity-status",
    heading: "Covered entity status",
    appliesWhen: ALWAYS,
    body: (v) => {
      if (v.isCoveredEntity === true) {
        return wrap(
          `${v.clinicLegalName} has confirmed that it transmits health information ` +
            `electronically in connection with a transaction covered by HIPAA, and is ` +
            `therefore a covered entity. This agreement governs.`,
        );
      }
      if (v.isCoveredEntity === false) {
        return wrap(
          `${v.clinicLegalName} has confirmed that it does NOT transmit health ` +
            `information electronically in connection with a HIPAA-covered transaction, ` +
            `and may therefore not be a covered entity. healdesk applies the same ` +
            `safeguards regardless. Note that state consumer-health-privacy law may ` +
            `still apply to both parties, and in some states carries a private right ` +
            `of action.`,
        );
      }
      return wrap(
        `${v.clinicLegalName} has not yet determined whether it is a covered entity. ` +
          `healdesk applies the same safeguards either way, and will confirm the ` +
          `determination before any real patient information is processed.`,
      );
    },
  },

  {
    id: "permitted-uses",
    heading: "What healdesk may do with patient information",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `healdesk may use and disclose protected health information only as necessary ` +
          `to provide the service to ${v.clinicLegalName}, and as required by law. It ` +
          `may not use or disclose it in any way that ${v.clinicLegalName} could not.`,
      ),
  },

  /**
   * Exactly one of the next two applies, and which one is the single biggest
   * factual difference between two clinics' agreements. A clinic on estimated
   * attribution has given us no credentials at all, and their contract should
   * not describe a connection they refused.
   */
  {
    id: "data-sources-verified",
    heading: "What healdesk reads from your systems",
    appliesWhen: (v) => v.attributionMode === "verified",
    body: (v) =>
      wrap(
        `${v.clinicLegalName} has chosen verified reporting and will grant healdesk ` +
          `READ-ONLY access to ${v.connectedPlatform}. ` +
          `healdesk reads appointments, their outcomes, and settled sales, solely to ` +
          `measure the revenue its agent recovered. It does not read clinical notes, ` +
          `charts, images, or anything not listed here, and it writes nothing except ` +
          `appointments it books on ${v.clinicLegalName}'s instruction. Access may be ` +
          `revoked by ${v.clinicLegalName} at any time, and revocation stops the ` +
          `reading immediately.`,
      ) +
      "\n\n" +
      wrap(
        `${v.clinicLegalName} confirms that its own agreement with ` +
          `${v.connectedPlatform} permits it to authorise a ` +
          `third-party service to receive this data. Some platforms require the ` +
          `practice to authorise third-party AI systems expressly.`,
      ),
  },
  {
    id: "data-sources-none",
    heading: "What healdesk reads from your systems",
    appliesWhen: (v) => v.attributionMode !== "verified",
    body: (v) =>
      wrap(
        `${v.clinicLegalName} has chosen estimated reporting. healdesk holds no ` +
          `credentials to ${v.connectedPlatform ?? "any practice management system"} ` +
          `and reads nothing from it. The only patient information healdesk receives ` +
          `is what patients themselves give it during a call or chat. Revenue figures ` +
          `are calculated from the average appointment value ${v.clinicLegalName} ` +
          `supplied, and are labelled as estimates wherever they appear.`,
      ),
  },

  /**
   * Every sentence here has to be true on the day it is signed.
   *
   * The previous version warranted "encrypted in transit" flatly. That was
   * false: Amazon SES defaults to OPPORTUNISTIC TLS, which silently delivers in
   * cleartext when the receiving mail server will not negotiate. The fix is in
   * two halves and both are needed — the wording below is narrowed to what we
   * actually control, and lib/reporting/deliver.ts now refuses to send unless
   * the SES configuration set enforces TlsPolicy=REQUIRE. A contract sentence
   * and a runtime check, because either alone rots.
   *
   * "United States infrastructure" is now true and stays true only while every
   * subprocessor is pinned to a US region. That is a standing operational
   * commitment, not a one-off configuration.
   */
  {
    id: "safeguards",
    heading: "Safeguards",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `healdesk will use appropriate administrative, physical and technical ` +
          `safeguards to prevent any use or disclosure of protected health information ` +
          `this agreement does not permit, and will comply with Subpart C of 45 CFR ` +
          `Part 164 — the HIPAA Security Rule — in respect of electronic protected ` +
          `health information.`,
      ) +
      "\n\n" +
      wrap(
        `Patient information is held on United States infrastructure and encrypted at ` +
          `rest. In transit it is encrypted wherever healdesk controls both ends, and ` +
          `healdesk will not transmit protected health information over a channel that ` +
          `cannot negotiate encryption — email included. Where a message cannot be ` +
          `delivered securely healdesk will fail the delivery and tell ` +
          `${v.clinicLegalName}, rather than send it in the clear.`,
      ),
  },

  /**
   * Real numbers, not a promise of a future number.
   *
   * This clause used to end "The executed agreement will state the timeline" —
   * but in a click-through funnel THIS IS the executed agreement, so it pointed
   * at a document that would never exist. That is worse than silence: silence
   * would default to the sixty days 45 CFR 164.410(b) allows, whereas deferring
   * invites the argument that the click-through was never the whole agreement,
   * which undercuts the entire evidentiary design.
   *
   * Five days is a commercial choice, not a legal minimum. It is deliberate:
   * the clinic's own sixty-day clock under 164.404 may start on the day WE
   * discovered the breach, so anything close to sixty consumes the time they
   * need to notify their own patients.
   *
   * The unsuccessful-incident carve-out matters as much as the deadline. Without
   * it, "any security incident of which it becomes aware" obliges us to report
   * every blocked sign-in and port scan, which generates noise nobody reads and
   * buries the one report that matters.
   */
  {
    id: "reporting",
    heading: "Reporting breaches and security incidents",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(`healdesk will tell ${v.clinicLegalName}:`) +
      "\n\n" +
      wrap(
        `a. within five business days of becoming aware of it, about any use or ` +
          `disclosure of protected health information this agreement does not permit;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. without unreasonable delay and no later than five calendar days after ` +
          `discovering it, about any breach of unsecured protected health information. ` +
          `That is well inside the sixty days 45 CFR 164.410 allows, and deliberately ` +
          `so — ${v.clinicLegalName}'s own sixty-day deadline to notify its patients ` +
          `may start on the day healdesk discovered the breach, not the day healdesk ` +
          `reported it;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. within five business days, about any security incident healdesk becomes ` +
          `aware of — except routine unsuccessful attempts that compromised nothing, ` +
          `such as blocked sign-ins, port scans and filtered traffic, which healdesk ` +
          `will summarise on request rather than report one by one.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `Each report will say what happened, which patients are affected so far as ` +
          `healdesk knows, and what healdesk has done about it.`,
      ),
  },

  /**
   * A covenant, not a statement of fact.
   *
   * The previous wording — "Each subcontractor ... IS bound by the same
   * restrictions" — asserted a present fact. Two problems with that. It creates
   * no forward obligation covering a subcontractor added next year, and if it is
   * not true on the day of signature it is a MISREPRESENTATION rather than a
   * breach of covenant, which is a materially worse thing to have said.
   *
   * It was also not true. Twilio will not sign below Security Edition, Boulevard
   * will not sign with an integrator at all, and the voice vendor's own six
   * subprocessors have no evidenced BAAs. The honest form is a promise about
   * what we will do BEFORE sending anyone's data, which is enforceable and which
   * we can actually keep — the gate moves into the code, not just the contract.
   *
   * Note this clause cannot discharge 45 CFR 164.504(e)(5). That provision
   * governs the healdesk-to-subcontractor paper, and nothing written HERE
   * satisfies it — only actually holding those downstream BAAs does.
   */
  {
    id: "subcontractors",
    heading: "Subcontractors",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `healdesk uses subcontractors to deliver the service — telephony, speech ` +
          `recognition and language models among them. Before healdesk sends any ` +
          `patient information to a subcontractor, healdesk will have obtained that ` +
          `subcontractor's written agreement binding it to the same restrictions and ` +
          `conditions this agreement places on healdesk, and requiring it to comply ` +
          `with the HIPAA Security Rule under a contract meeting 45 CFR 164.314(a). ` +
          `healdesk remains answerable to ${v.clinicLegalName} for what its ` +
          `subcontractors do with that information.`,
      ) +
      "\n\n" +
      wrap(
        `Language models are used to understand a patient and answer them during the ` +
          `conversation. They are not permitted to retain patient information after it ` +
          `ends, and they are not permitted to train on it.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps a current list of these subcontractors at ` +
          `healdesk.io/subprocessors and will give ${v.clinicLegalName} notice before ` +
          `adding one that will handle patient information.`,
      ),
  },

  /**
   * Unconditional, deliberately.
   *
   * This clause used to be predicated on `isCoveredEntity !== false`, which made
   * three MANDATORY subparagraphs — (E) access, (F) amendment, (G) accounting —
   * disappear from the agreement whenever a clinic owner ticked "cash-pay only".
   * That put the document's compliance in the hands of a legal self-diagnosis by
   * a buyer, and cash-pay practices that submit one electronic claim a year are
   * exactly the population most likely to get it wrong.
   *
   * There was never an upside: if the practice genuinely is not a covered
   * entity, the obligation is simply never triggered, at zero cost to us.
   */
  {
    id: "patient-rights",
    heading: "Patient access, amendment and accounting",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `When a patient asks to see their information, to have it corrected, or to be ` +
          `told who it was disclosed to, ${v.clinicLegalName} answers them — and ` +
          `healdesk gives ${v.clinicLegalName} what it needs to answer, within ten ` +
          `business days of being asked:`,
      ) +
      "\n\n" +
      wrap(
        `a. Access. healdesk will make available the protected health information it ` +
          `holds about that patient in a designated record set, so ${v.clinicLegalName} ` +
          `can meet its obligations under 45 CFR 164.524.`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. Amendment. healdesk will make that information available for amendment and ` +
          `will incorporate any amendment ${v.clinicLegalName} directs, under 45 CFR ` +
          `164.526. Incorporating it means healdesk's own copy is corrected, not merely ` +
          `annotated.`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. Accounting. healdesk will maintain and make available the information ` +
          `${v.clinicLegalName} needs to give a patient an accounting of disclosures ` +
          `under 45 CFR 164.528.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `If a patient makes one of these requests to healdesk directly, healdesk will ` +
          `not answer it. It will pass the request to ${v.clinicLegalName} within five ` +
          `business days and tell the patient it has done so.`,
      ),
  },

  /**
   * 45 CFR 164.504(e)(2)(ii)(H) — the classic omission, and live for this
   * product rather than theoretical.
   *
   * The outbound clause has healdesk sending messages "on the clinic's behalf
   * and in its name". That is the clinic discharging its own Privacy Rule
   * functions through us, and where we do that the standard that applies is the
   * COVERED ENTITY's, not the lighter business-associate one.
   *
   * Costs nothing when it does not apply — the obligation is self-limiting.
   */
  {
    id: "acting-in-your-place",
    heading: "Where healdesk acts in your place",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Some of what healdesk does is ${v.clinicLegalName} carrying out its own duties ` +
          `through healdesk, rather than healdesk doing something of its own — ` +
          `answering a patient who calls, and sending messages in ` +
          `${v.clinicLegalName}'s name, are both of those. Where healdesk carries out ` +
          `an obligation the HIPAA Privacy Rule places on ${v.clinicLegalName}, ` +
          `healdesk will meet the requirements that Rule places on ` +
          `${v.clinicLegalName} in performing it, and not only the lighter ones it ` +
          `places on a business associate. 45 CFR 164.504(e)(2)(ii)(H).`,
      ),
  },

  {
    id: "outbound-consent",
    heading: "Outbound contact, and who holds the patients' consent",
    appliesWhen: (v) => v.outboundMessaging,
    body: (v) =>
      wrap(
        `healdesk sends appointment reminders, confirmations, missed-call follow-ups ` +
          `and reactivation messages to ${v.clinicLegalName}'s patients, by call and ` +
          `by text, on ${v.clinicLegalName}'s behalf and in its name.`,
      ) +
      "\n\n" +
      `  By signing, ${v.clinicLegalName} warrants that:\n\n` +
      wrap(
        `a. It holds the consents required to contact those patients for the purposes ` +
          `above, obtained from the patients themselves.`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. Its consent for promotional or reactivation messaging is prior express ` +
          `WRITTEN consent, which is the standard the law applies to marketing ` +
          `regardless of how the message is worded.`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. It authorises healdesk to send those messages as its agent.`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `d. It will tell healdesk promptly when a patient withdraws consent by any ` +
          `route — in the clinic, by phone, or in writing.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `healdesk will, on every message and every call: honour STOP and any other ` +
          `plainly worded withdrawal, suppress the number across all channels, respect ` +
          `quiet hours in the patient's own local time, and hold to the frequency ` +
          `limits the healthcare exemption requires.`,
      ),
  },

  /**
   * Only reachable when messaging is on AND the covered-entity question is
   * unresolved. The exemption relied on for reactivation is available only to a
   * covered entity or its business associate, so where that is unsettled the
   * feature stays off — and the agreement says so rather than leaving the
   * clinic to discover it.
   */
  {
    id: "reactivation-gate",
    heading: "Reactivation messaging is not switched on",
    appliesWhen: (v) => v.outboundMessaging && v.isCoveredEntity !== true,
    body: (v) =>
      wrap(
        `The healthcare exemption relied on above is available only to a HIPAA covered ` +
          `entity or its business associate. Because the covered-entity determination ` +
          `for ${v.clinicLegalName} is ` +
          `${v.isCoveredEntity === false ? '"no"' : '"not yet determined"'}, healdesk ` +
          `will NOT switch on reactivation or win-back messaging until that question is ` +
          `settled. Appointment reminders and missed-call follow-ups are unaffected.`,
      ),
  },

  {
    id: "prohibited",
    heading: "What healdesk is not authorised to do",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `· Use protected health information to train, fine-tune, or evaluate any ` +
          `artificial intelligence model, its own or a third party's.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Disclose protected health information to any advertising platform, in any ` +
          `form, including hashed or aggregated.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Provide clinical advice, diagnosis, triage, or treatment recommendations ` +
          `through the agent.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(`· Sell, license, or otherwise monetise patient information.`),
  },

  {
    id: "return-or-destroy",
    heading: "When this agreement ends",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `On termination healdesk will, if feasible, return or destroy all protected ` +
          `health information it holds for ${v.clinicLegalName} and retain no copies. ` +
          `Where return or destruction is not feasible, healdesk will continue to ` +
          `protect the information under the terms of this agreement and limit further ` +
          `use of it to whatever makes return or destruction infeasible. ` +
          `${v.clinicLegalName} may terminate this agreement if healdesk materially ` +
          `breaches it.`,
      ),
  },

  /**
   * The liability allocation, and the one clause a founder is most tempted to
   * leave out.
   *
   * There was no cap at all, which sounds generous and is actually the worst
   * position available: uncapped downstream exposure sitting on top of upstream
   * vendors who cap at roughly $150 and $100. Every dollar of the gap lands on
   * healdesk personally.
   *
   * ⚖️ THE NUMBER IS A PLACEHOLDER AND IS THE SINGLE MOST LIKELY THING COUNSEL
   * WILL CHANGE. Two things are load-bearing regardless of what they set it to:
   *
   *   1. The carve-out. A cap that also limits liability for healdesk's own
   *      wilful misconduct or gross negligence is the kind a court declines to
   *      enforce, and a clinic's lawyer strikes on sight. Carving those out is
   *      what makes the rest of it credible.
   *   2. Naming the upstream mismatch out loud. It is unusual to write this into
   *      a customer contract, and it is the honest thing to do: the clinic is
   *      entitled to know that the money behind our promises is our own, not our
   *      vendors'. It is also the sentence that will start the conversation
   *      about raising Synthflow's six-month cap, which is the real fix.
   */
  {
    id: "liability",
    heading: "What healdesk is answerable for",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `healdesk is answerable to ${v.clinicLegalName} for its own failures under this ` +
          `agreement and for those of its subcontractors. Except for the two things ` +
          `below, healdesk's total liability under this agreement is limited to twelve ` +
          `times the monthly subscription fee ${v.clinicLegalName} was paying when the ` +
          `event giving rise to it occurred.`,
      ) +
      "\n\n" +
      wrap(
        `That limit does NOT apply to healdesk's wilful misconduct or gross ` +
          `negligence, and it does NOT apply to healdesk's obligation to bear the cost ` +
          `of notifying patients and regulators about a breach that healdesk caused.`,
      ) +
      "\n\n" +
      wrap(
        `${v.clinicLegalName} should know that healdesk's own suppliers cap their ` +
          `liability to healdesk at figures far below this one. healdesk is not passing ` +
          `those caps through — the commitment above is healdesk's own, backed by ` +
          `healdesk. It is stated plainly because a clinic is entitled to know where ` +
          `the money behind a promise comes from.`,
      ),
  },

  {
    id: "records-to-hhs",
    heading: "Availability of records",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will make its internal practices, books and records relating to the ` +
          `use and disclosure of protected health information available to the ` +
          `Secretary of Health and Human Services for the purpose of determining ` +
          `compliance.`,
      ),
  },
];

// -----------------------------------------------------------------------------
// Version 1.1.0 — DRAFT. Not offered, not signable, not counsel-approved.
// -----------------------------------------------------------------------------

/**
 * ⚖️ The revision the September 2026 review asked for, drafted so counsel
 * reviews a document rather than a list. It was never offered and never
 * signed: 1.2.0 (below) superseded it on 2026-10-01, keeping its structure
 * and dropping what v1 does not do. It stays registered, below the offered
 * version and with approvedByCounsel false, because docs/counsel/ cites its
 * rendering (docs/baa-v1.1.0-draft.txt) and the golden test freezes it — a
 * stray edit here is a failing test rather than a silent change to a document
 * other documents quote.
 *
 * What changed against 1.0.0, clause by clause, and why:
 *
 *   definitions      NEW. "Services", "Fees" and "Terms" by reference to the
 *                    terms of service; 1.0.0 used words no document defined.
 *   parties          The preamble names a legal entity, its form and state,
 *                    and a notice address; "healdesk" alone was not a party.
 *   practice status  The clinic is "Practice" throughout and NOTIFIES its
 *                    covered-entity status; healdesk no longer "determines" it.
 *   safeguards       Carves a patient's own chosen channel — a call they
 *                    placed, or a callback they asked for — out of the
 *                    encryption promise, narrowly. SMS is not carved out:
 *                    healdesk sends none (design of 23 September 2026).
 *   reporting        One discovery standard (164.404(a)(2)), one five-calendar-
 *                    day clock, and the report content 164.410(c) requires.
 *   subcontractors   The covenant triggers on the regulation's four verbs
 *                    (create, receive, maintain, transmit), not on healdesk
 *                    "sending"; the model-retention sentence is a covenant
 *                    healdesk can keep — no retention beyond the session
 *                    except as the vendor's BAA permits, and never training.
 *   own use          NEW. The standard grant for healdesk's management and
 *                    administration and for data aggregation, drawn narrowly.
 *   practice duties  NEW. Tell healdesk about restrictions, revocations and
 *                    notice-of-privacy-practices limits (164.504(e)(2)(i)(A)).
 *   minimum          NEW. Minimum necessary, both directions.
 *   term             NEW. Term, termination for material breach with cure,
 *                    and the 30-day return-or-destroy timeline with six-year
 *                    retention of the disclosure record.
 *   liability        One-way indemnity from Practice (claims, penalties,
 *                    defence and notification costs, reaching claims that
 *                    allege healdesk's negligence); healdesk's liability
 *                    excluded to the fullest extent the law allows, with
 *                    twelve months' Fees as the fallback cap; no indemnity
 *                    from healdesk. Decision of 22 September 2026.
 *   boilerplate      NEW. Notices, governing law and venue, change in law,
 *                    interpretation, entire agreement as to PHI.
 *
 * Added by the booking-and-callbacks design of 23 September 2026 — new and
 * unreviewed, on top of the September review's changes above:
 *
 *   callbacks        REPLACES outbound-consent. `consented-callbacks` is
 *                    unconditional: healdesk places only a callback the
 *                    patient agreed to on their own call or thread, captures
 *                    that consent itself, verbatim, and Practice gives no
 *                    consent warranty. `reactivation-gate` stays keyed to
 *                    outboundMessaging, which both signing paths leave false,
 *                    so it never renders in this version.
 *   calendar write   NEW. `calendar-write` when a calendar is connected for
 *                    writing (the `calendarWrite` selection; Cal.com only in
 *                    this release). An estimated clinic with one gets
 *                    `data-sources-calendar-only` in place of
 *                    `data-sources-none`, which now renders only when no
 *                    calendar is connected.
 *   direct booking   NEW. `direct-booking` when `bookingMode` is "direct".
 *                    The body lives in direct-booking-addendum.ts — it is the
 *                    standalone addendum a practice accepts on its setup
 *                    link, with its own version, approval flag and golden
 *                    hash — and is imported here so the two cannot drift.
 */
const ENTITY = "Viixi FZC";
const ENTITY_FORM = "a company registered under the Sharjah Publishing City Free Zone, United Arab Emirates";
// The Delaware registered-agent mailbox the legal pages and the CAN-SPAM
// footer print, plus email. Unlike the website, the BAA names the entity
// plainly — a BAA needs an identifiable party — and carries no
// "correspondence only" disclaimer; counsel should confirm a mailbox is
// adequate as a notice address (docs/handover.md "Decisions log", item 14).
const NOTICE_ADDRESS = "800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States, and by email to legal@healdesk.io";
const GOVERNING_STATE = "Delaware";
// No floor, by decision of 21 September 2026, and since 22 September 2026 the
// cap is only the fallback: healdesk's liability is excluded outright where the
// law allows, and every claim, defence and notification cost is Practice's by
// indemnity. healdesk carries no insurance, and a floor above the fees would be
// a promise with nothing behind it.

function byId(id: string): BaaClause {
  const clause = CLAUSES.find((c) => c.id === id);
  if (!clause) throw new Error(`No 1.0.0 clause ${id}`);
  return clause;
}

/**
 * The two selections 1.1.0 adds are optional on BaaSelections (see the type
 * for why). Predicates read them through these so none ever sees undefined.
 */
function bookingModeOf(v: BaaVariables): "desk_confirms" | "direct" {
  return v.bookingMode ?? "desk_confirms";
}
function calendarWriteOf(v: BaaVariables): { platform: string } | null {
  return v.calendarWrite ?? null;
}

const CLAUSES_1_1: readonly BaaClause[] = [
  {
    id: "definitions",
    heading: "Definitions",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `"Practice" means ${v.clinicLegalName}. "healdesk" means ${ENTITY}, ${ENTITY_FORM}. ` +
          `"Terms" means the healdesk Terms of Service at healdesk.io/terms as in force on ` +
          `the effective date. "Services" and "Fees" have the meanings the Terms give ` +
          `them. "Protected health information" (PHI), "breach", "unsecured PHI", ` +
          `"security incident", "subcontractor" and "designated record set" have the ` +
          `meanings given in 45 CFR Parts 160 and 164. "Business day" means a day other ` +
          `than a Saturday, Sunday or United States federal holiday.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement governs PHI healdesk creates, receives, maintains or transmits ` +
          `for Practice in the course of the Services. Where this agreement and the Terms ` +
          `conflict about PHI, this agreement governs.`,
      ),
  },

  {
    id: "practice-status",
    heading: "Practice's status",
    appliesWhen: ALWAYS,
    body: (v) => {
      const notified =
        v.isCoveredEntity === true
          ? `Practice has notified healdesk that it transmits health information electronically in ` +
            `connection with a transaction covered by HIPAA and is therefore a covered entity.`
          : v.isCoveredEntity === false
            ? `Practice has notified healdesk that it does NOT transmit health information ` +
              `electronically in connection with a HIPAA-covered transaction, and may therefore not ` +
              `be a covered entity.`
            : `Practice has not yet notified healdesk whether it is a covered entity, and will do so ` +
              `before any real patient information is processed.`;
      return (
        wrap(notified) +
        "\n\n" +
        wrap(
          `Practice's status is Practice's determination, not healdesk's. Whatever it is, ` +
            `healdesk applies the safeguards in this agreement, and this agreement is a ` +
            `business associate agreement under 45 CFR 164.502(e) and 164.504(e) where Practice ` +
            `is a covered entity, and a data-protection agreement on the same terms where it is ` +
            `not. Practice will tell healdesk promptly if its status changes. Where Practice is ` +
            `not a covered entity, state consumer-health-privacy law may apply to both parties ` +
            `and in some states carries a private right of action; the FTC Health Breach ` +
            `Notification Rule may apply to Practice.`,
        )
      );
    },
  },

  byId("permitted-uses"),
  byId("data-sources-verified"),

  /**
   * Exactly one data-sources clause applies. In 1.0.0 that is verified or
   * none; 1.1.0 splits "none" by whether a calendar is connected for writing,
   * because "holds no credentials to any practice system" is false the day a
   * Cal.com key is stored. The calendar-only wording keeps every other
   * sentence of data-sources-none and points at the calendar-write clause
   * for the one exception.
   */
  {
    id: "data-sources-calendar-only",
    heading: "What healdesk reads from your systems",
    appliesWhen: (v) => v.attributionMode !== "verified" && calendarWriteOf(v) !== null,
    body: (v) =>
      wrap(
        `${v.clinicLegalName} has chosen estimated reporting. Apart from the calendar ` +
          `access described in the calendar clause, healdesk holds no credentials to any ` +
          `practice system and reads nothing from it. The only patient information ` +
          `healdesk receives is what patients themselves give it during a call or chat. ` +
          `Revenue figures are calculated from the average appointment value ` +
          `${v.clinicLegalName} supplied, and are labelled as estimates wherever they ` +
          `appear.`,
      ),
  },
  {
    // The 1.0.0 body, word for word; only the predicate narrows.
    ...byId("data-sources-none"),
    appliesWhen: (v) => v.attributionMode !== "verified" && calendarWriteOf(v) === null,
  },

  /**
   * The one write healdesk performs, stated as an upper bound: one event
   * type, one action (add), two triggers (the desk confirmed, or the practice
   * elected direct booking), a fixed and short list of what crosses — and
   * never a phone number or a patient email, which the connector's input type
   * makes impossible to send rather than merely promises not to.
   */
  {
    id: "calendar-write",
    heading: "What healdesk writes to your calendar",
    appliesWhen: (v) => calendarWriteOf(v) !== null,
    body: (v) => {
      const platform = calendarWriteOf(v)?.platform ?? "the connected calendar";
      return wrap(
        `Practice has connected ${platform} so that healdesk may read that calendar's ` +
          `free and busy times for one event type Practice chooses, and may add an ` +
          `appointment to that event type only when Practice's front desk confirms a time ` +
          `on a booking request, or, where Practice has accepted the direct booking ` +
          `addendum, when the assistant books a caller by telephone. healdesk holds an API ` +
          `key for that purpose, sends ${platform} a first name, the service asked about and ` +
          `the time, never a telephone number or a patient's email address, and reads ` +
          `bookings back only to count them. It moves, edits or cancels nothing it did not ` +
          `create.`,
      );
    },
  },

  {
    id: "own-use",
    heading: "healdesk's own use, and data aggregation",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk may use PHI for its own proper management and administration and to ` +
          `carry out its legal responsibilities, and may disclose it for those purposes ` +
          `only where the law requires the disclosure, or where healdesk has obtained ` +
          `reasonable assurances from the recipient that the PHI will be held ` +
          `confidentially, used or further disclosed only as required by law or for the ` +
          `purpose it was disclosed for, and that the recipient will notify healdesk of ` +
          `any breach of its confidentiality. 45 CFR 164.504(e)(4).`,
      ) +
      "\n\n" +
      wrap(
        `healdesk may combine Practice's PHI with that of other practices only to ` +
          `produce de-identified, aggregate statistics about the Services (for example, ` +
          `what fraction of after-hours calls are answered). It will not use PHI to ` +
          `train, fine-tune or evaluate any model, and nothing in this clause permits ` +
          `it to.`,
      ),
  },

  {
    id: "practice-duties",
    heading: "What Practice will tell healdesk",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(`Practice will tell healdesk, promptly and in writing:`) +
      "\n\n" +
      wrap(
        `a. of any limitation in its notice of privacy practices that affects how ` +
          `healdesk may use or disclose PHI;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. of any change to, or revocation of, a patient's permission to use or ` +
          `disclose PHI, where it affects healdesk;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. of any restriction on the use or disclosure of PHI that Practice has agreed ` +
          `to under 45 CFR 164.522, where it affects healdesk.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `Practice will not ask healdesk to use or disclose PHI in a way that would not be ` +
          `permissible under the HIPAA Privacy Rule if done by Practice.`,
      ),
  },

  {
    id: "safeguards",
    heading: "Safeguards",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will use appropriate administrative, physical and technical ` +
          `safeguards to prevent any use or disclosure of PHI this agreement does not ` +
          `permit, and will comply with Subpart C of 45 CFR Part 164 — the HIPAA ` +
          `Security Rule — in respect of electronic PHI.`,
      ) +
      "\n\n" +
      wrap(
        `PHI is held on United States infrastructure and encrypted at rest. In transit ` +
          `it is encrypted wherever healdesk controls both ends, and healdesk will not ` +
          `transmit PHI over a channel that cannot negotiate encryption — email included. ` +
          `Where a message cannot be delivered securely healdesk will fail the delivery ` +
          `and tell Practice, rather than send it in the clear.`,
      ) +
      "\n\n" +
      wrap(
        `One narrow exception: a patient who telephones, or who asked on their own call ` +
          `or message to be called back, has chosen the telephone, and a telephone call ` +
          `is not end-to-end encrypted. healdesk may answer such a call and may place the ` +
          `callback described in the Callbacks clause, limited to the minimum necessary ` +
          `and never including clinical detail, test results or payment information. ` +
          `healdesk sends no SMS. This exception does not extend to any other channel or ` +
          `content.`,
      ),
  },

  {
    id: "minimum-necessary",
    heading: "Minimum necessary",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Each party will limit its use, disclosure and requests of PHI to the minimum ` +
          `necessary to accomplish the purpose, consistent with 45 CFR 164.502(b). ` +
          `healdesk's agent asks a caller for no more than is needed to book, message or ` +
          `route them; it does not ask for a diagnosis, a history or a reason beyond the ` +
          `service requested.`,
      ),
  },

  {
    id: "reporting",
    heading: "Reporting breaches and security incidents",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(`healdesk will report to Practice, in writing to the address in the Notices clause:`) +
      "\n\n" +
      wrap(
        `a. any use or disclosure of PHI not permitted by this agreement, within five ` +
          `business days of healdesk becoming aware of it;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. any breach of unsecured PHI, without unreasonable delay and in no case later ` +
          `than five calendar days after discovery. A breach is treated as discovered on ` +
          `the first day it is known, or by exercising reasonable diligence would have ` +
          `been known, to healdesk or to any person other than the one committing it who ` +
          `is healdesk's workforce member or agent, as 45 CFR 164.410(a)(2) provides. ` +
          `Five days is deliberately far inside the sixty the regulation allows, because ` +
          `Practice's own sixty-day clock to notify patients may run from healdesk's ` +
          `discovery, not from healdesk's report;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. any security incident, within five business days of becoming aware of it — ` +
          `except routine unsuccessful attempts that compromised nothing, such as blocked ` +
          `sign-ins, port scans and filtered traffic, which the parties agree this clause ` +
          `reports once, here, and which healdesk will summarise on request.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `A breach report will include, to the extent known and supplemented as learned: ` +
          `the identification of each individual whose unsecured PHI was or is reasonably ` +
          `believed to have been accessed, acquired, used or disclosed; a description of ` +
          `what happened, including the dates of the breach and of its discovery; the ` +
          `types of PHI involved; what healdesk is doing to investigate, mitigate and ` +
          `prevent recurrence; and a contact. 45 CFR 164.410(c). The cost of notifying ` +
          `patients, regulators and anyone else about a breach is Practice's, as the ` +
          `Liability clause provides.`,
      ),
  },

  {
    id: "subcontractors",
    heading: "Subcontractors",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk uses subcontractors to deliver the Services — telephony, speech ` +
          `recognition, language models, hosting and email among them. healdesk will ` +
          `ensure that any subcontractor that creates, receives, maintains or transmits ` +
          `PHI on healdesk's behalf agrees in writing, before it does so, to the same ` +
          `restrictions and conditions this agreement places on healdesk, and to comply ` +
          `with the HIPAA Security Rule, under a contract meeting 45 CFR 164.314(a) and ` +
          `164.504(e)(5). healdesk remains answerable to Practice for its ` +
          `subcontractors' acts and omissions with that PHI.`,
      ) +
      "\n\n" +
      wrap(
        `Language models are used to understand a caller and answer them during a ` +
          `conversation, under a business associate agreement with the model provider. ` +
          `healdesk does not permit, and its provider agreements prohibit, the use of PHI ` +
          `to train or improve any model, and healdesk configures each provider to retain ` +
          `conversation content no longer than that provider's agreement with healdesk ` +
          `requires for abuse detection and security, and never for any other purpose.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps a current list of these subcontractors at ` +
          `healdesk.io/subprocessors and will give Practice at least fifteen days' notice ` +
          `by email before adding one that will handle PHI. If Practice objects on ` +
          `reasonable grounds before the change takes effect, Practice may terminate ` +
          `under the Term clause without penalty.`,
      ),
  },

  byId("patient-rights"),
  byId("acting-in-your-place"),

  /**
   * Replaces outbound-consent, and is unconditional where that was keyed to
   * outboundMessaging: every sentence is an upper bound that holds for every
   * clinic, callbacks on or off. The warranty is gone because its premise
   * was — healdesk now captures the consent itself, on the patient's own call
   * or thread, verbatim and versioned (consent-wording.ts), so it no longer
   * needs the practice to warrant something only the practice could know.
   * An AI voice is an "artificial voice" under the TCPA (FCC 24-17), which
   * is why the consent, the disclosure, the window and the caps are all
   * stated here rather than in a support article.
   */
  {
    id: "consented-callbacks",
    heading: "Callbacks, and whose consent they rest on",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk places no calls to a patient except a callback about a booking request ` +
          `that patient made, and only after the patient agreed, on that same call or ` +
          `message thread, to be called back by an automated assistant. The only messages ` +
          `healdesk sends a patient are replies on a message thread the patient opened ` +
          `and, where the patient wrote on WhatsApp and agreed to it there, at most one ` +
          `fixed status message; none of those messages states an appointment time, ` +
          `service, practitioner or condition. healdesk captures and keeps that consent ` +
          `itself, verbatim, with its time, channel and wording version, and will produce ` +
          `the record on request; Practice gives no warranty about it. On every such call ` +
          `healdesk will state at the outset that the caller is an artificial voice, give ` +
          `Practice's telephone number, and say how to stop; honour "stop" and any plainly ` +
          `worded withdrawal at once by suppressing the number across all channels for ` +
          `good; call only between 8am and 8pm in Practice's local time, which healdesk ` +
          `treats as the patient's, and never on a Sunday; place no more than two attempts ` +
          `about one request and no more than four calls to one number in any thirty ` +
          `days; and send no text messages, reminders or marketing of any kind. Practice ` +
          `will tell healdesk promptly of any withdrawal it receives directly.`,
      ),
  },

  /**
   * The body is the direct-booking addendum's, imported so the clause in
   * this draft and the standalone addendum a practice actually accepts
   * cannot say different things. Keyed to bookingMode, which both signing
   * paths pass as "desk_confirms": the election is evidenced by the
   * addendum's own hash, never by a clause hashed out of this draft.
   */
  {
    id: "direct-booking",
    heading: DIRECT_BOOKING_CLAUSE_HEADING,
    appliesWhen: (v) => bookingModeOf(v) === "direct",
    body: () => wrap(DIRECT_BOOKING_CLAUSE_BODY),
  },

  // Kept keyed to outboundMessaging. Reactivation is not offered; stays
  // false on both signing paths, so this never renders in 1.1.0 — retained
  // rather than deleted so the 1.0.0 clause object is untouched.
  byId("reactivation-gate"),
  byId("prohibited"),

  {
    id: "term",
    heading: "Term, termination, and what happens to the information",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `This agreement takes effect on the effective date and continues for as long as ` +
          `healdesk holds any PHI for Practice. Either party may terminate it on written ` +
          `notice if the other materially breaches it and does not cure the breach within ` +
          `thirty days of being told of it in writing; where cure is not possible, on ` +
          `notice. Practice may also terminate under the subcontractor-objection right ` +
          `above. Ending the Services ends this agreement, subject to the rest of this ` +
          `clause.`,
      ) +
      "\n\n" +
      wrap(
        `Within thirty days of termination healdesk will return or destroy all PHI it ` +
          `holds for Practice and retain no copies, and will give Practice, on request ` +
          `before that date, an export of the PHI it holds in a usable electronic form. ` +
          `Where return or destruction is not feasible, healdesk will say why in writing, ` +
          `extend the protections of this agreement to that PHI for as long as it is ` +
          `held, and limit further use to what makes return or destruction infeasible.`,
      ) +
      "\n\n" +
      wrap(
        `Two records survive termination: the signed copy of this agreement, and the ` +
          `record of disclosures needed to answer an accounting request, each kept for ` +
          `six years from termination as 45 CFR 164.530(j) and 164.528 require. Neither ` +
          `contains more PHI than the record itself needs.`,
      ),
  },

  {
    id: "liability",
    heading: "Liability, and who indemnifies whom",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Practice will defend, indemnify and hold harmless healdesk and its ` +
          `subcontractors against every claim, loss, liability, regulatory penalty, ` +
          `fine, cost and expense — including reasonable legal fees, the cost of ` +
          `defending a claim, and the cost of investigating a security incident and of ` +
          `notifying patients, regulators, the media and anyone else about a breach — ` +
          `to the extent it arises from or relates to the Services, PHI that Practice or ` +
          `its patients give the Services, Practice's covered-entity status, ` +
          `instructions Practice gave, Practice's own breach of this agreement or ` +
          `violation of HIPAA or of state consumer-health-privacy law, or a claim by a ` +
          `patient, a regulator or any other third party. This indemnity applies to the ` +
          `fullest extent the law allows, including where the claim alleges negligence ` +
          `on healdesk's part, and the limits below do not apply to it.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk gives Practice no indemnity. To the fullest extent the law allows, ` +
          `healdesk is not liable to Practice for any loss arising out of or relating to ` +
          `this agreement or the Services, in contract, tort or otherwise, including ` +
          `lost profits and indirect, incidental, special or consequential damages. ` +
          `Where the law does not permit that exclusion, healdesk's total aggregate ` +
          `liability to Practice, across all claims, is limited to the Fees paid or ` +
          `payable by Practice in the twelve months before the event giving rise to the ` +
          `claim.`,
      ) +
      "\n\n" +
      wrap(
        `This clause allocates cost between the parties. It does not change what each ` +
          `party owes a regulator directly under HIPAA, and Practice's own duty under ` +
          `45 CFR 164.404 to notify its patients remains Practice's.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk does not carry liability insurance, and its own suppliers cap their ` +
          `liability to healdesk at figures far below what a breach can cost. Practice ` +
          `should size its own cover accordingly.`,
      ),
  },

  byId("records-to-hhs"),

  {
    id: "notices-and-law",
    heading: "Notices, governing law, and interpretation",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Notices under this agreement are in writing. To healdesk: ${NOTICE_ADDRESS}. ` +
          `To Practice: the email address of the signatory below, and any notice address ` +
          `Practice later gives healdesk in writing. Breach reports may additionally be ` +
          `given by telephone to Practice, but the written notice is the notice.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement is governed by the laws of the State of ${GOVERNING_STATE} and by ` +
          `HIPAA, without regard to conflict-of-laws rules, and the parties submit to the ` +
          `courts of that State. Any ambiguity is resolved in favour of a meaning that ` +
          `permits compliance with HIPAA. A reference to a section of HIPAA or of a ` +
          `regulation means that section as amended, and if a change in law requires a ` +
          `change to this agreement, the parties will agree it in good faith within ` +
          `thirty days of either asking, failing which either may terminate under the ` +
          `Term clause. If any provision is unenforceable the rest stands.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement, the Terms and the order Practice placed are the entire ` +
          `agreement between ${v.clinicLegalName} and ${ENTITY} about PHI, and replace ` +
          `any earlier version of this agreement between them from the effective date ` +
          `forward; PHI already held is governed by this version from that date.`,
      ),
  },
];

/** The 1.1.0 preamble: names a legal party, and says it is a draft while it is one. */
function draftPreamble110(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    `Version 1.1.0 — DRAFT FOR COUNSEL REVIEW — NOT FOR EXECUTION`,
    ``,
    `This Agreement is entered into under 45 CFR 164.502(e) and 164.504(e) and`,
    `takes effect on the date below. It governs Protected Health Information`,
    `that healdesk creates, receives, maintains or transmits for Practice in the`,
    `course of the Services defined in the Terms.`,
    ``,
    `BETWEEN`,
    `  ${v.clinicLegalName} ("Practice"), a ${v.specialty.toLowerCase()} practice`,
    `  ${ENTITY}, ${ENTITY_FORM} ("healdesk"), of ${NOTICE_ADDRESS}`,
    ``,
    `SIGNED FOR PRACTICE BY`,
    `  ${v.signatoryName}${title}`,
    `  ${v.signatoryEmail}`,
    ``,
    `ACCEPTED FOR HEALDESK BY`,
    `  [NAME, TITLE] — healdesk's acceptance is given by its countersignature`,
    `  record, sent to the signatory's email with the executed copy.`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Version 1.2.0 — the offered template. Released 2026-10-01.
// -----------------------------------------------------------------------------

/**
 * The v1 agreement, built on 1.1.0-draft's structure — the named party, the
 * definitions, Practice's status, own use, Practice's duties, minimum
 * necessary, term, liability and the boilerplate — and brought into line with
 * docs/v1-product-spec.md, which fences out everything the draft described
 * that v1 does not do. Released on 2026-10-01 by the owner, on the owner's own
 * review and without external counsel; the template entry's
 * `approvedByCounsel` records that (see the field's doc comment).
 *
 * What changed against 1.1.0-draft, clause by clause:
 *
 *   preamble         "executed electronically"; no DRAFT wording and no
 *                    acceptance placeholder. The two party lines wrap, so the
 *                    plain-text copy stays inside 78 columns.
 *   data sources     `data-sources-calendar-only` is gone. `data-sources-none`
 *                    is a new body: no credentials to any practice-management
 *                    or point-of-sale system, nothing read from one, and the
 *                    one access healdesk does hold is the calendar the next
 *                    clause describes. The "Revenue figures" sentence is gone:
 *                    v1 may not claim revenue (CLAUDE.md, "Claims and copy").
 *   google-calendar  NEW and unconditional, replacing `calendar-write`. Every
 *                    v1 clinic connects its own Google Calendar by OAuth, and
 *                    the appointment healdesk adds there is the only write it
 *                    performs anywhere.
 *   safeguards       The exception keeps only the call a patient placed. The
 *                    callback sentence is gone; healdesk places no calls and
 *                    sends no SMS.
 *   minimum          Adds what the assistant collects — a callback slip's
 *                    worth; no history, medication or diagnosis; no card
 *                    numbers — and the opening-line disclosure Practice
 *                    cannot switch off.
 *   reporting        Same clocks, same 164.410(c) content; the closing
 *                    sentence defers the notification-cost allocation to the
 *                    Liability clause rather than restating it.
 *   subcontractors   Names the model provider and the number. Anthropic
 *                    retains conversation content for 30 days, for abuse
 *                    detection and security, under its BAA with healdesk, then
 *                    deletes it; it never trains on it (spec, "Five rules",
 *                    third rule). The fifteen-day notice and objection right
 *                    stay.
 *   prohibited       New object (the 1.0.0 one is untouched). The advertising
 *                    bullet is replaced by one that is true of v1: no PHI to
 *                    any advertising or analytics platform, and on Instagram,
 *                    Messenger and WhatsApp — where Meta signs no BAA — the
 *                    assistant handles no clinical content and confirms no
 *                    appointment details. No training, no clinical advice and
 *                    no monetising stay.
 *   liability        The owner's allocation, the same as Terms §13–14:
 *                    healdesk's liability excluded where the law allows and
 *                    capped at twelve months' Fees where it does not, the cap
 *                    not reaching wilful misconduct, gross negligence or any
 *                    liability the law says cannot be limited; Practice
 *                    indemnifies as Terms §14 says, incident investigation and
 *                    breach notification costs included; a civil money penalty
 *                    a regulator imposes on healdesk stays healdesk's, which no
 *                    contract can shift. The 1.0.0 sentence making healdesk
 *                    bear notification costs is gone.
 *   notices          One word: notices to Practice go to the signatory's
 *                    address "above" (it is in the preamble), where 1.1.0
 *                    said "below". Otherwise 1.1.0's, including the
 *                    entire-agreement paragraph that replaces earlier
 *                    versions from the effective date.
 *   removed          `consented-callbacks`, `direct-booking`,
 *                    `reactivation-gate` and `calendar-write`. v1 has no
 *                    outbound of any kind and no booking election, so nothing
 *                    keyed to `outboundMessaging` or `bookingMode` may be
 *                    reachable; `calendarWrite` is null on both signing paths.
 *
 * Reused unchanged, by lookup rather than copy: definitions, practice-status,
 * own-use, practice-duties and term from 1.1.0-draft; permitted-uses,
 * data-sources-verified, patient-rights, acting-in-your-place and
 * records-to-hhs from 1.0.0. `data-sources-verified` is the phase-two
 * read-back and cannot render from checkout while VERIFIED_ATTRIBUTION_OFFERED
 * is false; it is kept so the attribution axis stays a live predicate, as in
 * every earlier version.
 */
function byId110(id: string): BaaClause {
  const clause = CLAUSES_1_1.find((c) => c.id === id);
  if (!clause) throw new Error(`No 1.1.0 clause ${id}`);
  return clause;
}

const CLAUSES_1_2: readonly BaaClause[] = [
  byId110("definitions"),
  byId110("practice-status"),
  byId("permitted-uses"),
  byId("data-sources-verified"),

  /**
   * The v1 statement of what healdesk reads: nothing, from any system a
   * practice runs. Names the platform when the practice named one, so a
   * Mindbody or Boulevard clinic in manual booking mode reads a sentence about
   * its own system rather than a generic one. The single access healdesk does
   * hold — the Google Calendar OAuth token — is the next clause's subject, and
   * this one points at it rather than pretending it away.
   */
  {
    id: "data-sources-none",
    heading: "What healdesk reads from your systems",
    appliesWhen: (v) => v.attributionMode !== "verified",
    body: (v) =>
      wrap(
        (v.connectedPlatform
          ? `healdesk holds no credentials to ${v.connectedPlatform}, or to any other ` +
            `practice-management or point-of-sale system, and reads nothing from them. `
          : `healdesk holds no credentials to any practice-management or point-of-sale ` +
            `system and reads nothing from one. `) +
          `The only patient information healdesk receives is what patients themselves ` +
          `give it during a call or chat, together with the calendar access the Google ` +
          `Calendar clause describes.`,
      ),
  },

  /**
   * The one write healdesk performs, as an upper bound: one calendar, one
   * action (add), two triggers (the assistant booked, or staff confirmed a
   * request where the practice requires approval), a fixed and short list of
   * what crosses, and never a phone number or an email address. Google is not
   * healdesk's subcontractor here — the calendar is the practice's own system
   * under the practice's own agreement with Google — which is why the clause
   * has Practice acknowledge where Google's BAA does and does not reach, and
   * places healdesk's access under this agreement.
   */
  {
    id: "google-calendar",
    heading: "Practice's Google Calendar",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Practice connects its own Google Calendar by OAuth, under Practice's own ` +
          `agreement with Google. healdesk reads that calendar's free and busy times and ` +
          `the events on the booking calendar Practice chooses, holds the OAuth token ` +
          `encrypted, and adds an appointment when the assistant books one or, where ` +
          `Practice has set bookings to require approval, when Practice's staff confirm a ` +
          `request. It sends the calendar a first name, the service asked about and the ` +
          `time, never a telephone number or an email address, and it moves, edits or ` +
          `cancels nothing it did not create.`,
      ) +
      "\n\n" +
      wrap(
        `Practice acknowledges that Google's business associate agreement covers ` +
          `Calendar only where Practice's Google Workspace administrator has accepted ` +
          `it, and that healdesk's access to the calendar is governed by this agreement.`,
      ),
  },

  byId110("own-use"),
  byId110("practice-duties"),

  /**
   * 1.1.0's first two paragraphs, word for word. The third keeps only the
   * exception that is true of v1: a patient who telephones has chosen the
   * telephone. The callback sentence is gone because healdesk places no calls.
   */
  {
    id: "safeguards",
    heading: "Safeguards",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will use appropriate administrative, physical and technical ` +
          `safeguards to prevent any use or disclosure of PHI this agreement does not ` +
          `permit, and will comply with Subpart C of 45 CFR Part 164 — the HIPAA ` +
          `Security Rule — in respect of electronic PHI.`,
      ) +
      "\n\n" +
      wrap(
        `PHI is held on United States infrastructure and encrypted at rest. In transit ` +
          `it is encrypted wherever healdesk controls both ends, and healdesk will not ` +
          `transmit PHI over a channel that cannot negotiate encryption — email included. ` +
          `Where a message cannot be delivered securely healdesk will fail the delivery ` +
          `and tell Practice, rather than send it in the clear.`,
      ) +
      "\n\n" +
      wrap(
        `One narrow exception: a patient who telephones has chosen the telephone, and a ` +
          `telephone call is not end-to-end encrypted. healdesk may answer such a call, ` +
          `limited to the minimum necessary and never including clinical detail, test ` +
          `results or payment information. healdesk places no calls and sends no SMS. ` +
          `This exception does not extend to any other channel or content.`,
      ),
  },

  /**
   * The regulation's sentence, then the product's: what the assistant
   * collects, stated as the ceiling, and the opening-line disclosure the
   * clinic cannot switch off (spec, "Five rules", first and fifth).
   */
  {
    id: "minimum-necessary",
    heading: "Minimum necessary",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Each party will limit its use, disclosure and requests of PHI to the minimum ` +
          `necessary to accomplish the purpose, consistent with 45 CFR 164.502(b).`,
      ) +
      "\n\n" +
      wrap(
        `The assistant collects what a receptionist would write on a callback slip — a ` +
          `name, a telephone number or email address, the service asked about and a ` +
          `preferred time — and no more. It does not ask for a history, a medication or ` +
          `a diagnosis, and it never takes a card number. On every channel its opening ` +
          `line says that it is an AI assistant and, on a call, that the call is ` +
          `transcribed; Practice cannot switch that statement off or edit it out.`,
      ),
  },

  /**
   * 1.1.0's reporting clause with one change: the closing sentence used to
   * say whose cost breach notification is, and now says which clause decides
   * it. One allocation, stated once, in the Liability clause.
   */
  {
    id: "reporting",
    heading: "Reporting breaches and security incidents",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(`healdesk will report to Practice, in writing to the address in the Notices clause:`) +
      "\n\n" +
      wrap(
        `a. any use or disclosure of PHI not permitted by this agreement, within five ` +
          `business days of healdesk becoming aware of it;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. any breach of unsecured PHI, without unreasonable delay and in no case later ` +
          `than five calendar days after discovery. A breach is treated as discovered on ` +
          `the first day it is known, or by exercising reasonable diligence would have ` +
          `been known, to healdesk or to any person other than the one committing it who ` +
          `is healdesk's workforce member or agent, as 45 CFR 164.410(a)(2) provides. ` +
          `Five days is deliberately far inside the sixty the regulation allows, because ` +
          `Practice's own sixty-day clock to notify patients may run from healdesk's ` +
          `discovery, not from healdesk's report;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. any security incident, within five business days of becoming aware of it — ` +
          `except routine unsuccessful attempts that compromised nothing, such as blocked ` +
          `sign-ins, port scans and filtered traffic, which the parties agree this clause ` +
          `reports once, here, and which healdesk will summarise on request.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `A breach report will include, to the extent known and supplemented as learned: ` +
          `the identification of each individual whose unsecured PHI was or is reasonably ` +
          `believed to have been accessed, acquired, used or disclosed; a description of ` +
          `what happened, including the dates of the breach and of its discovery; the ` +
          `types of PHI involved; what healdesk is doing to investigate, mitigate and ` +
          `prevent recurrence; and a contact. 45 CFR 164.410(c). Who bears the cost of ` +
          `notifying patients, regulators and anyone else about a breach is allocated by ` +
          `the Liability clause.`,
      ),
  },

  /**
   * The spec's third non-optional rule: the model provider's retention
   * contradicts minimum retention everywhere else, and the contradiction is
   * disclosed here, with the number and the reason, rather than left for a
   * clinic's counsel to find. The first and third paragraphs are 1.1.0's.
   */
  {
    id: "subcontractors",
    heading: "Subcontractors",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk uses subcontractors to deliver the Services — telephony, speech ` +
          `recognition, language models, hosting and email among them. healdesk will ` +
          `ensure that any subcontractor that creates, receives, maintains or transmits ` +
          `PHI on healdesk's behalf agrees in writing, before it does so, to the same ` +
          `restrictions and conditions this agreement places on healdesk, and to comply ` +
          `with the HIPAA Security Rule, under a contract meeting 45 CFR 164.314(a) and ` +
          `164.504(e)(5). healdesk remains answerable to Practice for its ` +
          `subcontractors' acts and omissions with that PHI.`,
      ) +
      "\n\n" +
      wrap(
        `Language models are used to understand a patient and answer them during a ` +
          `conversation. healdesk's language-model provider is Anthropic, which receives ` +
          `the content of each conversation to generate the assistant's replies, under a ` +
          `business associate agreement with healdesk. Under that agreement Anthropic ` +
          `retains conversation content for 30 days, for abuse detection and security, ` +
          `and then deletes it; its covered service cannot run with shorter retention. ` +
          `Anthropic never trains on that content, and healdesk may not use PHI to ` +
          `train, fine-tune or evaluate any model, its own or a third party's.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps a current list of these subcontractors at ` +
          `healdesk.io/subprocessors and will give Practice at least fifteen days' notice ` +
          `by email before adding one that will handle PHI. If Practice objects on ` +
          `reasonable grounds before the change takes effect, Practice may terminate ` +
          `under the Term clause without penalty.`,
      ),
  },

  byId("patient-rights"),
  byId("acting-in-your-place"),

  /**
   * A new object, because the 1.0.0 one is signed. Three of the four bullets
   * are 1.0.0's in substance. The advertising bullet is the change: the 1.0.0
   * ban on disclosing PHI "to any advertising platform" collided with
   * Instagram, Messenger and WhatsApp, which Meta operates and through which
   * the assistant replies to patients. The honest form keeps the ban on
   * advertising and analytics use and says how the Meta channels are scoped —
   * nothing clinical, no appointment details — which is the product rule the
   * adapter enforces (CLAUDE.md, "Channels and contact").
   */
  {
    id: "prohibited",
    heading: "What healdesk is not authorised to do",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `· Use PHI to train, fine-tune, or evaluate any artificial intelligence model, ` +
          `its own or a third party's.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Disclose PHI to any advertising or analytics platform, in any form, including ` +
          `hashed or aggregated. Instagram, Messenger and WhatsApp are operated by Meta, ` +
          `which signs no business associate agreement; where Practice connects them, the ` +
          `assistant replies there only inside a conversation the patient started, ` +
          `handles no clinical content, confirms no appointment details, and moves ` +
          `anything clinical to a call or to Practice's own secure route.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Provide clinical advice, diagnosis, triage, or treatment recommendations ` +
          `through the assistant.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(`· Sell, license, or otherwise monetise patient information.`),
  },

  byId110("term"),

  /**
   * The owner's allocation, decided 2026-10-01, and the same one Terms §13 and
   * §14 state: one answer in both documents, so neither can be read against
   * the other. What is load-bearing whatever the numbers:
   *
   *   1. The carve-out from the cap. A cap that also limits liability for
   *      healdesk's own wilful misconduct or gross negligence is the kind a
   *      court declines to enforce; carving those out, and anything the law
   *      says cannot be limited, is what makes the rest credible.
   *   2. The regulatory sentence. A civil money penalty a regulator imposes on
   *      healdesk is healdesk's to pay whatever this clause says; writing that
   *      down is reality, not generosity, and it stops the indemnity being
   *      read as a promise no contract can keep.
   *   3. Naming the upstream mismatch and the absence of insurance out loud.
   *      The clinic is entitled to know where the money behind a promise comes
   *      from, and to size its own cover.
   *
   * The 1.0.0 sentence making healdesk bear the cost of notifying patients and
   * regulators is gone: Terms §14 and docs/incident-response.md put that cost
   * on the practice, and the reporting clause above now defers to this one.
   */
  {
    id: "liability",
    heading: "Liability, and who indemnifies whom",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `To the fullest extent the law allows, healdesk is not liable to Practice for any ` +
          `loss arising out of or relating to this agreement or the Services, in contract, ` +
          `tort or otherwise, including lost profits and indirect, incidental, special or ` +
          `consequential damages. Where the law does not permit that exclusion, healdesk's ` +
          `total aggregate liability to Practice, across all claims, is limited to the Fees ` +
          `paid or payable by Practice in the twelve months before the event giving rise to ` +
          `the claim. That limit does not apply to healdesk's wilful misconduct or gross ` +
          `negligence, or to any liability the law does not allow to be limited.`,
      ) +
      "\n\n" +
      wrap(
        `Practice will defend, indemnify and hold harmless healdesk and its ` +
          `subcontractors as section 14 of the Terms provides: against every claim, loss, ` +
          `liability, penalty, fine, cost and expense — including reasonable legal fees, ` +
          `the cost of defending a claim, and the cost of investigating a security ` +
          `incident and of notifying patients, regulators, the media and anyone else about ` +
          `a breach — to the extent it arises from or relates to the Services, PHI that ` +
          `Practice or its patients give the Services, Practice's covered-entity status, ` +
          `instructions Practice gave, Practice's own breach of this agreement or ` +
          `violation of HIPAA or of state consumer-health-privacy law, or a claim by a ` +
          `patient, a regulator or any other third party. This indemnity applies to the ` +
          `fullest extent the law allows, including where the claim alleges negligence on ` +
          `healdesk's part, and the limit above does not apply to it. healdesk gives ` +
          `Practice no indemnity.`,
      ) +
      "\n\n" +
      wrap(
        `This clause allocates cost between the parties. It does not change what each ` +
          `party owes a regulator directly under HIPAA: nothing in it relieves healdesk ` +
          `of a civil money penalty a regulator imposes on healdesk itself, which no ` +
          `contract can shift, and Practice's own duty under 45 CFR 164.404 to notify its ` +
          `patients remains Practice's.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk does not carry liability insurance, and its own suppliers cap their ` +
          `liability to healdesk at figures far below what a breach can cost. Practice ` +
          `should size its own cover accordingly.`,
      ),
  },

  byId("records-to-hhs"),

  /**
   * 1.1.0's boilerplate with one word changed: the signatory's email address
   * is in the preamble, above the clauses, and 1.1.0 said "below", pointing
   * at nothing. Everything else — notices, Delaware law and venue, change in
   * law, severability, and the entire-agreement paragraph that replaces
   * earlier versions from the effective date — is word for word.
   */
  {
    id: "notices-and-law",
    heading: "Notices, governing law, and interpretation",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Notices under this agreement are in writing. To healdesk: ${NOTICE_ADDRESS}. ` +
          `To Practice: the email address of the signatory above, and any notice address ` +
          `Practice later gives healdesk in writing. Breach reports may additionally be ` +
          `given by telephone to Practice, but the written notice is the notice.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement is governed by the laws of the State of ${GOVERNING_STATE} and by ` +
          `HIPAA, without regard to conflict-of-laws rules, and the parties submit to the ` +
          `courts of that State. Any ambiguity is resolved in favour of a meaning that ` +
          `permits compliance with HIPAA. A reference to a section of HIPAA or of a ` +
          `regulation means that section as amended, and if a change in law requires a ` +
          `change to this agreement, the parties will agree it in good faith within ` +
          `thirty days of either asking, failing which either may terminate under the ` +
          `Term clause. If any provision is unenforceable the rest stands.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement, the Terms and the order Practice placed are the entire ` +
          `agreement between ${v.clinicLegalName} and ${ENTITY} about PHI, and replace ` +
          `any earlier version of this agreement between them from the effective date ` +
          `forward; PHI already held is governed by this version from that date.`,
      ),
  },
];

/**
 * The 1.2.0 preamble: 1.1.0's, in executed form. No DRAFT line, and no
 * acceptance block for healdesk — 1.0.0 had none either, and a block with a
 * placeholder name is exactly the kind of text this file refuses to render.
 * The two party lines go through wrap() so the plain-text copy stays inside
 * 78 columns however long the practice's name or the notice address is.
 */
function preamble120(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    `Version 1.2.0 — executed electronically`,
    ``,
    `This Agreement is entered into under 45 CFR 164.502(e) and 164.504(e) and`,
    `takes effect on the date below. It governs Protected Health Information`,
    `that healdesk creates, receives, maintains or transmits for Practice in the`,
    `course of the Services defined in the Terms.`,
    ``,
    `BETWEEN`,
    wrap(`${v.clinicLegalName} ("Practice"), a ${v.specialty.toLowerCase()} practice`),
    wrap(`${ENTITY}, ${ENTITY_FORM} ("healdesk"), of ${NOTICE_ADDRESS}`),
    ``,
    `SIGNED FOR PRACTICE BY`,
    `  ${v.signatoryName}${title}`,
    `  ${v.signatoryEmail}`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/**
 * The executed preamble, for the counsel-approved version.
 *
 * Kept beside the draft one rather than replacing it, because the draft is
 * still the exact text some accounts signed and their stored hash has to keep
 * reproducing. A signed agreement is a record of what a specific person saw on
 * a specific day; editing it in place would quietly invalidate every signature
 * taken against it.
 */
function approvedPreamble(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";

  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    `Version ${"1.0.0"} — executed electronically`,
    ``,
    `This Agreement is entered into under 45 CFR 164.502(e) and 164.504(e) and`,
    `takes effect on the date below. It governs Protected Health Information`,
    `disclosed by the Covered Entity to healdesk in the course of the Services.`,
    ``,
    `BETWEEN`,
    `  ${v.clinicLegalName} ("Covered Entity"), a ${v.specialty.toLowerCase()} practice`,
    `  healdesk ("Business Associate")`,
    ``,
    `SIGNED BY`,
    `  ${v.signatoryName}${title}`,
    `  ${v.signatoryEmail}`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

/** The pre-approval preamble. Retained so 0.1.0-draft still renders as signed. */
function preamble(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";

  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    ``,
    `⚠️ DRAFT — NOT FOR EXECUTION. This template has not been reviewed by`,
    `counsel and does not create a business associate relationship. Accounts`,
    `created against it are restricted to synthetic data, and the database`,
    `enforces that independently of this document.`,
    ``,
    `BETWEEN`,
    `  ${v.clinicLegalName} ("Covered Entity"), a ${v.specialty.toLowerCase()} practice`,
    `  healdesk ("Business Associate")`,
    ``,
    `SIGNED BY`,
    `  ${v.signatoryName}${title}`,
    `  ${v.signatoryEmail}`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

export const BAA_TEMPLATES: readonly BaaTemplate[] = [
  // Newest RELEASED first — CURRENT_BAA_VERSION and currentBaaTemplate() both
  // read [0], so a version stays at [0] until its successor is approved for
  // release too.
  {
    version: "1.2.0",
    publishedOn: "2026-10-01",
    // Approved for release by the owner on 2026-10-01, on the owner's own
    // review and without external counsel. The field's doc comment on
    // BaaTemplate says what the flag means; this is the entry it describes.
    approvedByCounsel: true,
    preamble: preamble120,
    clauses: CLAUSES_1_2,
  },
  // Counsel-approved in September 2026 and offered until 1.2.0 replaced it.
  // Retained, never offered again: accounts created against it signed this
  // exact text, and their stored hash must keep reproducing from it.
  {
    version: "1.0.0",
    publishedOn: "2026-09-05",
    approvedByCounsel: true,
    preamble: approvedPreamble,
    clauses: CLAUSES,
  },
  // ⚖️ The September 2026 revision, superseded by 1.2.0 without ever being
  // offered. Registered so the golden test keeps freezing it and
  // docs/baa-v1.1.0-draft.txt stays reproducible (`renderBaa(getBaaTemplate(
  // "1.1.0-draft"), …)`); it is not at [0] and approvedByCounsel is false, and
  // provisioning refuses an unapproved template regardless.
  {
    version: "1.1.0-draft",
    publishedOn: "2026-09-22",
    approvedByCounsel: false,
    preamble: draftPreamble110,
    clauses: CLAUSES_1_1,
  },
  // Retained, not deleted. Accounts that signed this signed THIS text, and
  // their stored hash must keep reproducing from it — that reproducibility is
  // the entire point of hashing the assembled document rather than the
  // template. It is never offered again: currentBaaTemplate() reads [0].
  {
    version: "0.1.0-draft",
    publishedOn: "2026-08-21",
    approvedByCounsel: false,
    preamble,
    clauses: CLAUSES,
  },
] as const;

export const CURRENT_BAA_VERSION = BAA_TEMPLATES[0]!.version;

/**
 * The words on the button that signs the agreement.
 *
 * Shared rather than written inline in the form, because this exact string is
 * frozen into every acceptance row and enforceability turns on it. A clickwrap
 * holds up when the assent action said what it was doing; "Continue" and the
 * sentence below are very different facts about the same click, and the
 * difference only ever surfaces years later when somebody disputes it.
 *
 * Changing this changes what future signatures say they agreed to. Existing
 * rows keep the label they were signed under — that is the point of storing it.
 *
 * Until 1.2.0 the label ended "and confirm the consent warranty above". No
 * offered document has carried a consent warranty since `outboundMessaging`
 * went false on both signing paths, and 1.2.0 has no clause that could, so
 * every signer was confirming a warranty their agreement did not contain. The
 * phrase was dropped with 1.2.0 on 2026-10-01; rows signed under the old label
 * keep it, as stored.
 */
export const BAA_ASSENT_LABEL = "I agree to the Business Associate Agreement";

/**
 * The COMPLETE sentence beside the checkbox, as the signer sees it.
 *
 * `BAA_ASSENT_LABEL` is the fixed half; the practice name is spliced into the
 * middle and the authority attestation closes it. The server stores this
 * whole sentence, re-derived from the clinic name it validated, rather than
 * whatever the browser reported — the September 2026 review found the client
 * could send any string and it would be frozen into the record as "what the
 * button said". The signing screen renders from this same function, so the
 * words on screen and the words in the record cannot differ.
 */
export function assentSentence(clinicLegalName: string): string {
  const name = clinicLegalName.trim() || "my practice";
  return `${BAA_ASSENT_LABEL} on behalf of ${name}, and I confirm I am authorised to enter into it.`;
}

/** The words on the button that completes the signature. Stored beside the sentence. */
export const BAA_ACTION_LABEL = "Sign and continue";

export function getBaaTemplate(version: string): BaaTemplate | undefined {
  return BAA_TEMPLATES.find((t) => t.version === version);
}

export function currentBaaTemplate(): BaaTemplate {
  return BAA_TEMPLATES[0]!;
}

/**
 * Which clauses this clinic's agreement contains.
 *
 * Exported separately from rendering because it is recorded with the
 * acceptance. Knowing the variant is what lets someone reproduce the document
 * years later without trusting that the predicates still evaluate the same way.
 */
export function applicableClauses(
  template: BaaTemplate,
  variables: BaaVariables,
): readonly BaaClause[] {
  return template.clauses.filter((clause) => clause.appliesWhen(variables));
}

/**
 * Assemble the agreement for one clinic.
 *
 * Strict about its inputs: an empty required field throws rather than rendering
 * a contract that names nobody. The dangerous failure here is not a crash, it
 * is a document that looks complete and binds no one.
 */
export function renderBaa(
  template: BaaTemplate,
  variables: BaaVariables,
): string {
  requireField(variables.clinicLegalName, "clinicLegalName");
  requireField(variables.signatoryName, "signatoryName");
  requireField(variables.signatoryEmail, "signatoryEmail");
  requireField(variables.specialty, "specialty");

  if (
    variables.attributionMode !== "estimated" &&
    variables.attributionMode !== "verified"
  ) {
    throw new BaaRenderError(
      `Unknown attribution mode: ${String(variables.attributionMode)}`,
    );
  }

  /**
   * Verified reporting with nothing connected is not a document we can write.
   *
   * The clause would have to describe read-only access to an unnamed system —
   * a data flow that cannot exist. Refusing here rather than in the request
   * validator puts the invariant on the DOCUMENT, so no caller can route
   * around it, and so the fallback wording that used to paper over this state
   * ("its practice management system") is gone.
   */
  if (variables.attributionMode === "verified" && !variables.connectedPlatform) {
    throw new BaaRenderError(
      "Verified reporting needs a named system to read from; nothing is connected.",
    );
  }

  const clauses = applicableClauses(template, variables);
  if (clauses.length === 0) {
    throw new BaaRenderError("No clauses apply — that cannot be an agreement.");
  }

  const numbered = clauses.map((clause, index) => {
    const body = clause.body(variables);
    if (!body.trim()) {
      throw new BaaRenderError(`Clause ${clause.id} rendered empty.`);
    }
    return `${index + 1}. ${clause.heading.toUpperCase()}\n\n${body}`;
  });

  const text = [template.preamble(variables), "", ...intersperse(numbered)].join(
    "\n",
  );

  // A placeholder that survived assembly means a clause body was written with
  // template syntax it no longer supports. Never show that to a customer.
  if (/\{\{/.test(text)) {
    throw new BaaRenderError("Unsubstituted placeholder in the assembled text.");
  }

  return text;
}

function intersperse(sections: string[]): string[] {
  return sections.flatMap((section, index) =>
    index === 0 ? [section] : ["", section],
  );
}

/**
 * SHA-256 of the exact assembled text.
 *
 * Recorded alongside every acceptance so "what did they actually agree to"
 * survives both the clause library changing and the clinic renaming itself.
 */
export function hashBaaText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Assemble, hash, and report the variant in one step.
 *
 * Callers that hash separately eventually hash something subtly different from
 * what they rendered — a trimmed string, a different date format — and the
 * record silently stops matching the document.
 */
export function prepareBaa(
  template: BaaTemplate,
  variables: BaaVariables,
): { text: string; hash: string; version: string; clauseIds: string[] } {
  const text = renderBaa(template, variables);
  return {
    text,
    hash: hashBaaText(text),
    version: template.version,
    clauseIds: applicableClauses(template, variables).map((c) => c.id),
  };
}

function requireField(value: string | undefined, field: string): void {
  if (!value?.trim()) {
    throw new BaaRenderError(`${field} is required to render the agreement.`);
  }
}

/** "2026-08-21" → "21 August 2026". Unambiguous across US/EU readers. */
function formatDate(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BaaRenderError(`Invalid effective date: ${iso}`);
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
