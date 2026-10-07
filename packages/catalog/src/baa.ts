import { createHash } from "node:crypto";

import {
  bookingSyncFor,
  bookingSystemName,
  isBookingSystemId,
  type BookingSystemId,
} from "./booking-systems";
import {
  CALENDAR_CLAUSE_HEADING,
  CALENDAR_CLAUSE_IDS,
  CALENDAR_LOCATION_PARAGRAPH,
  calendarClauseBody,
  calendarTermsKind,
  isCalendarAccount,
  type CalendarAccount,
  type CalendarClauseId,
  type CalendarTermsKind,
} from "./calendar-terms";
import { DIRECT_BOOKING_CLAUSE_BODY, DIRECT_BOOKING_CLAUSE_HEADING } from "./direct-booking-addendum";
import type { BookingSync } from "./platforms";
import { subprocessorNoticeClauseBody } from "./subprocessor-notice";
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
 *     is not offered at checkout in v1. The versions before 1.3.0 keep the
 *     axis a live predicate so their variant set stays honest; 1.3.0's
 *     render guard refuses verified reporting, which it does not describe.)
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
 * ⚖️ Version 1.2.1 is the current template and is what clinics now sign. It
 * was released on 2026-10-01 by the owner, on the owner's own review and
 * without external counsel, replacing 1.2.0 the same day; the doc comment on
 * `approvedByCounsel` records exactly what that flag now means. 1.3.0, the
 * calendar-dependent version, is drafted at BAA_TEMPLATES[1] and not offered
 * until it is released. 1.2.0, 1.0.0, which counsel approved in September
 * 2026, 1.1.0-draft, which was never offered, and 0.1.0-draft are retained
 * below them and never offered again: accounts created against 1.0.0 and
 * 0.1.0-draft signed that exact text, and their stored hash has to keep
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
   *
   * From 1.3.0 on it is the booking system's name (`bookingSystemName`), or
   * null where the answer names no product, and 1.3.0's render guard refuses
   * anything else; earlier versions name the phase-two platform, as they
   * always have (baa-selections.ts).
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
  /**
   * The booking system the practice named at checkout (booking-systems.ts).
   * Read from 1.3.0 on, where it decides the calendar clause through its sync
   * direction: only a system that reads Google Calendar for conflicts books
   * live. The sync itself is never a selection; it is derived from this
   * (`bookingSyncOf`), so nobody can sign "live" for a one-way system. No
   * earlier template reads it, so their documents are byte-identical
   * whatever it holds. buildBaaSelections sets it only for a template that
   * reads it.
   */
  bookingSystem?: BookingSystemId;
  /**
   * The kind of Google account that holds the calendar the assistant books
   * into: Workspace with Google's business associate agreement, Workspace
   * without it (or not sure), or a personal account. Read from 1.3.0 on,
   * like `bookingSystem`, and kept for a manual system in case that changes.
   */
  calendarAccount?: CalendarAccount;
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
  /**
   * The render guard: called first by renderBaa, and throws BaaRenderError
   * when the variables cannot produce an honest document of this version.
   * Clause predicates must stay total and never throw, so a selection a
   * version cannot do without is refused here, before any clause is chosen.
   * Templates before 1.3.0 have none, so nothing about them changes.
   */
  validate?: (v: BaaVariables) => void;
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

/**
 * The contracting party, its notice address and the governing law, exactly as
 * every BAA version from 1.1.0 on prints them, exported once so that the data
 * protection agreement (dpa.ts) names the same party at the same address under
 * the same law. Kind-neutral, and read-only: changing any of these would move
 * every BAA golden hash, so they are as frozen as the versions that print them.
 */
export const AGREEMENT_PARTY = {
  entity: ENTITY,
  entityForm: ENTITY_FORM,
  noticeAddress: NOTICE_ADDRESS,
  governingState: GOVERNING_STATE,
} as const;

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

// -----------------------------------------------------------------------------
// Version 1.2.1 — the offered version. Five accuracy fixes to 1.2.0.
// -----------------------------------------------------------------------------

/**
 * 1.2.1 corrects five factual defects an adversarial review found in 1.2.0 a
 * few hours after its release, before any clinic had signed it. Nothing
 * structural changes: every element of 45 CFR 164.504(e) and 164.314(a) was
 * already present. What changes is five sentences that said something the
 * vendors' own terms, the regulation or the product contradicted.
 *
 *   A1  practice-status   The "FTC Health Breach Notification Rule may apply
 *                         to Practice" sentence is gone. 16 CFR 318.2 reaches
 *                         vendors of personal health records and their
 *                         service providers, not a clinic's booking records.
 *                         State breach-notification law is named instead.
 *   A2  google-calendar   Says what healdesk reads, not what Google's scope
 *                         permits: when the calendar is free or busy, and the
 *                         appointments healdesk itself created. Google's
 *                         permission model gives it access to the calendar's
 *                         other events; it does not read or store them.
 *   A3  subcontractors    "then deletes it" overstated. Anthropic's own data
 *                         retention page (privacy.claude.com, updated 1 July
 *                         2026) says inputs and outputs are deleted within 30
 *                         days EXCEPT content its automated trust-and-safety
 *                         systems flag, or that the law requires it to keep,
 *                         which it may retain for up to two years. The clause
 *                         now says so.
 *   A4  safeguards        "— email included" contradicted the clause's own
 *                         fail-closed sentence and the SES design (TLS
 *                         required, delivery failed when the receiving server
 *                         will not negotiate it). Reworded to say that.
 *   A5  minimum-necessary The spec requires transcripts to live "under a
 *                         stated retention period", and no document stated
 *                         it. Now stated: 90 days, the code's default
 *                         (clinics.retention_media_days), shortenable by
 *                         Practice in its portal.
 *
 * Everything else is 1.2.0's, by lookup. 1.2.0 stays registered and frozen
 * below, as 1.1.0-draft is: it was offered for part of one day and must keep
 * reproducing whatever was signed against it.
 */
function byId120(id: string): BaaClause {
  const clause = CLAUSES_1_2.find((c) => c.id === id);
  if (!clause) throw new Error(`No 1.2.0 clause ${id}`);
  return clause;
}

/** The transcript retention the agreement states; the code's default (apps/app clinics.retention_media_days). */
export const TRANSCRIPT_RETENTION_DAYS = 90;

const CLAUSES_1_2_1: readonly BaaClause[] = [
  byId120("definitions"),

  // A1: 1.1.0's practice-status body with the HBNR sentence replaced.
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
            `not a covered entity, state breach-notification and consumer-health-privacy laws ` +
            `may apply to both parties, and in some states carry a private right of action.`,
        )
      );
    },
  },

  byId120("permitted-uses"),
  byId120("data-sources-verified"),
  byId120("data-sources-none"),

  // A2: what healdesk reads, not what the scope permits.
  {
    id: "google-calendar",
    heading: "Practice's Google Calendar",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Practice connects its own Google Calendar by OAuth, under Practice's own ` +
          `agreement with Google. healdesk reads when that calendar is free or busy and ` +
          `the appointments healdesk itself created; Google's permission model gives it ` +
          `access to the other events on that calendar, and it does not read or store ` +
          `them. healdesk holds the OAuth token encrypted, and adds an appointment when ` +
          `the assistant books one or, where Practice has set bookings to require ` +
          `approval, when Practice's staff confirm a request. It sends the calendar a ` +
          `first name, the service asked about and the time, never a telephone number or ` +
          `an email address, and it moves, edits or cancels nothing it did not create.`,
      ) +
      "\n\n" +
      wrap(
        `Practice acknowledges that Google's business associate agreement covers ` +
          `Calendar only where Practice's Google Workspace administrator has accepted ` +
          `it, and that healdesk's access to the calendar is governed by this agreement.`,
      ),
  },

  byId120("own-use"),
  byId120("practice-duties"),

  // A4: the email sentence says what the SES design does.
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
          `transmit PHI over a channel that cannot negotiate encryption. An email whose ` +
          `receiving server will not negotiate encryption is failed, not sent, and ` +
          `healdesk tells Practice rather than send it in the clear; the list of ` +
          `individuals in a breach report travels by secure transfer, never in the email ` +
          `itself.`,
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

  // A5: the retention period the spec requires the agreement to state.
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
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps transcripts and conversation records for ` +
          `${TRANSCRIPT_RETENTION_DAYS} days, which Practice may shorten in its portal; ` +
          `no call audio is kept at all. The Term clause governs what is held after ` +
          `termination.`,
      ),
  },

  byId120("reporting"),

  // A3: the retention sentence matches Anthropic's published terms.
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
          `and then deletes it, except content its automated trust-and-safety systems ` +
          `flag or the law requires it to keep, which it may retain for up to two years; ` +
          `its covered service cannot run with shorter retention. Anthropic never trains ` +
          `on that content, and healdesk may not use PHI to train, fine-tune or evaluate ` +
          `any model, its own or a third party's.`,
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

  byId120("patient-rights"),
  byId120("acting-in-your-place"),
  byId120("prohibited"),
  byId120("term"),
  byId120("liability"),
  byId120("records-to-hhs"),
  byId120("notices-and-law"),
];

/** The 1.2.1 preamble: 1.2.0's, with the version line. */
function preamble121(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    `Version 1.2.1 — executed electronically`,
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
// Version 1.3.0 — DRAFT. The calendar-dependent agreement. Not offered.
// -----------------------------------------------------------------------------

/**
 * The two selections 1.3.0 reads, through accessors so no predicate sees
 * undefined. Both defaults are the most restrictive answer: a calendar no
 * agreement with Google covers, and manual booking. The render guard means a
 * 1.3.0 document never actually renders on a default.
 */
export function calendarAccountOf(v: BaaVariables): CalendarAccount {
  return isCalendarAccount(v.calendarAccount) ? v.calendarAccount : "workspace_no_baa";
}

/** Derived from the booking system, never selected: only "yes" is live. */
export function bookingSyncOf(v: BaaVariables): BookingSync {
  return bookingSyncFor(v.bookingSystem);
}

function calendarKindOf(v: BaaVariables): CalendarTermsKind {
  return calendarTermsKind(bookingSyncOf(v), calendarAccountOf(v));
}

/**
 * How long a backup copy outlives the deletion of what it holds: the host's
 * automated backups expire after 35 days (docs/handover.md,
 * docs/hipaa-risk-analysis.md). The one figure 1.3.0 states wherever it
 * speaks of backups — per-person deletion, routine retention and termination
 * (owner, 6 October 2026, decision 2) — so the host's snapshot retention must
 * be set to it before the release.
 */
export const BACKUP_RETENTION_DAYS = 35;

/**
 * healdesk's registered address, its US mailing address and its notices
 * email, as 1.3.0 states them. They mirror apps/web/src/lib/legal.ts
 * (`ENTITY.registeredAddress`, exactly as the trade licence gives it, supplied
 * by the owner on 3 October 2026; `ENTITY.postalAddress`; `ENTITY.noticesEmail`)
 * as literals, not imports, so a released text cannot move when legal.ts does.
 * The mailbox is for correspondence only: never a place of business, a
 * registered office or an address for service of process, which the Notices
 * clause says. NOTICE_ADDRESS, above, stays for the 1.1.0–1.2.1 texts.
 */
const REGISTERED_ADDRESS =
  "Business Center, Sharjah Publishing City Free Zone, Sharjah, United Arab Emirates";
const US_MAILING_ADDRESS = "800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States";
const NOTICES_EMAIL = "legal@healdesk.io";

/**
 * 1.3.0's headings, wherever another clause names one. A clause names another
 * either as 'the clause headed "…"', with the heading exactly, or as "the …
 * clause" with the heading's opening words, which the Notices clause says is
 * how a name resolves. Keeping them here means a heading and every reference
 * to it change together.
 */
const HEADINGS_1_3 = {
  definitions: "Definitions",
  ownUse: "healdesk's own use, and de-identified statistics",
  minimum: "Minimum necessary",
  reporting: "Reporting breaches and security incidents",
  subcontractors: "Subcontractors",
  patientRights: "Patient access, amendment and accounting",
  term: "Term, termination, and what happens to the information",
} as const;

/** A lettered item, hanging under its letter, as every list in the agreement wraps. */
const item = (text: string) => wrap(text, "    ", "       ");
/** A bullet, as the prohibited clause and the breach report's contents wrap. */
const bullet = (text: string) => wrap(text, "  ", "    ");
/** A reference to another clause by its exact heading. */
const headed = (heading: string) => `the clause headed "${heading}"`;

// -----------------------------------------------------------------------------
// The shared modules: the state-law clause and the Payments clause
// -----------------------------------------------------------------------------

/**
 * The state-law clause's heading, in the BAA and in the funnel's DPA alike.
 * Clauses 1, 2 and 8 of 1.3.0 name it exactly.
 */
export const STATE_LAW_CLAUSE_HEADING = "Where Practice is not a covered entity";

/** Whom the clause protects, in the words of the agreement that carries it. */
export type StateLawSubject = "patient information" | "Client Information";

/**
 * The headings the clause names that the two agreements word differently. The
 * DPA's are its own (packages/catalog/src/dpa.ts); a heading changed there has
 * to change here too, and dpa.test.ts fails until it does.
 */
const STATE_LAW_HEADINGS: Record<
  "baa" | "dpa",
  { minimum: string; reporting: string; requests: string }
> = {
  baa: {
    minimum: HEADINGS_1_3.minimum,
    reporting: HEADINGS_1_3.reporting,
    requests: HEADINGS_1_3.patientRights,
  },
  dpa: {
    minimum: "Minimum necessary, and who receives Client Information",
    reporting: "Reporting incidents and breaches",
    requests: "Clients' requests",
  },
};

/**
 * The processor and service-provider terms state privacy law asks for, wrapped
 * and ready to follow the heading: the clause BAA 1.3.0 renders for every
 * practice, and the funnel's DPA renders for every client (owner, Q8; the
 * fuller clause chosen on 6 October 2026, agreement-changes.md §12.13).
 *
 * Redrafted by the pre-release audit (§12.14: HRC-09, ICD-03, SL-01 to SL-11
 * and the rest) so that it states each thing once: the instructions (this
 * agreement and the portal settings), the purposes (a–h, and in the BAA i,
 * the de-identified statistics), the data, the retention (no longer than the
 * agreement states; backups within BACKUP_RETENTION_DAYS), the combination
 * rule (security and fraud only) and the sale or share promise. Where it and
 * another clause differ, the more protective governs, never the looser. It
 * names other clauses only by their exact headings.
 *
 * `kind` decides what only a BAA can say: the paragraph that applies the
 * clause for a non-covered period and treats patient information as PHI, the
 * statistics purpose and paragraph (a DPA has no own-use clause), and the
 * BAA's headings. A DPA gets the CMIA sentence here, which the BAA carries in
 * its permitted-uses clause for every practice. It defaults to "baa" for
 * "patient information" and to "dpa" for "Client Information".
 *
 * `sync` is the location's booking sync (`bookingSyncFor`), required so no
 * caller gets the live text by default: a manual-booking practice is told of
 * no calendar purpose, data or recipient except under a calendar election.
 *
 * Unreleased in both documents, so changed in place. Once either is released
 * it is frozen with that document's golden hashes: a new wording is a new
 * function beside this one, never an edit to it.
 */
export function stateLawClauseBody(input: {
  subject: StateLawSubject;
  kind?: "baa" | "dpa";
  sync: BookingSync;
}): string {
  const S = input.subject;
  const kind = input.kind ?? (S === "patient information" ? "baa" : "dpa");
  const baa = kind === "baa";
  const live = input.sync === "live";
  const H = STATE_LAW_HEADINGS[kind];
  const calendar = headed(CALENDAR_CLAUSE_HEADING);
  const payments = headed(PAYMENTS_CLAUSE_HEADING);
  const paragraphs: string[] = [];

  if (baa) {
    paragraphs.push(
      wrap(
        `This clause applies for any period in which Practice is not a covered entity, ` +
          `whatever Practice has told healdesk about its status. For that period, patient ` +
          `information also includes any information about an identified or identifiable ` +
          `individual, other than Practice's own staff, that healdesk collects, receives or ` +
          `creates for Practice in the course of the Services. It includes all that would be PHI ` +
          `if Practice were a covered entity, and everything this agreement says about PHI ` +
          `applies to it.`,
      ),
    );
  }

  paragraphs.push(
    wrap(
      `healdesk is Practice's service provider and processor under the California Consumer ` +
        `Privacy Act and its regulations (Cal. Civ. Code 1798.100 and following; 11 CCR 7000 and ` +
        `following), the Washington My Health My Data Act (RCW 19.373), Nevada's consumer health ` +
        `data law (NRS 603A.400 to 603A.550) and the Connecticut Data Privacy Act (Conn. Gen. ` +
        `Stat. 42-515 to 42-526), to the extent each applies (together, "the state privacy ` +
        `laws"). Where this clause and another clause of this agreement differ about ${S}, the ` +
        `one that protects ${S} more governs, and where neither protects it more, this clause ` +
        `governs. Any ambiguity is resolved in favour of a meaning that permits compliance with ` +
        `the state privacy laws.`,
    ),
  );

  paragraphs.push(
    wrap(
      `Practice's documented instructions to healdesk are this agreement and the settings ` +
        `Practice chooses in its portal, within the purposes below. Practice makes ${S} ` +
        `available to healdesk, and healdesk collects it for Practice, only for those limited ` +
        `and specified purposes. healdesk processes ${S} only to:`,
    ),
  );

  const purposes = [
    `a. answer, in Practice's name, the calls, website chats and Instagram, Messenger and ` +
      `WhatsApp messages that people start with Practice, from Practice's own services, prices, ` +
      `hours and policies, using a language model to understand each message and write each ` +
      `reply;`,
    live
      ? `b. check Practice's calendar, hold a time and add the appointment where ${calendar}, or ` +
        `a calendar election that takes its place, provides for it, and otherwise take a booking ` +
        `request for Practice's staff to confirm;`
      : `b. take a booking request for Practice's staff to confirm in Practice's own system or, ` +
        `where a calendar election for a location provides for it, check that location's ` +
        `calendar, hold a time and add the appointment;`,
    `c. where Practice takes deposits, send a payment link in a website chat or an Instagram, ` +
      `Messenger or WhatsApp conversation, as ${payments} describes, and on a call flag the ` +
      `deposit for Practice's staff;`,
    `d. pass messages, including urgent ones and requests for a person, to Practice's staff or ` +
      `the contacts Practice names, and pass calls through, or transfer them, to Practice's own ` +
      `lines;`,
    `e. keep transcripts and records of those conversations and bookings, show them to ` +
      `Practice's staff, and export, correct or delete them when Practice asks;`,
    `f. count conversations, minutes and bookings, to bill Practice and to report them to it;`,
    `g. read a conversation that Practice flags, or that a fault or a complaint makes it ` +
      `necessary to read, to correct the assistant for Practice;` +
      (baa ? `` : ` and`),
    `h. keep the Services secure, find and fix faults, detect and prevent fraud and abuse, and ` +
      `meet healdesk's own legal obligations` +
      (baa ? `; and` : `.`),
  ];
  if (baa) {
    purposes.push(
      `i. de-identify it, as ${headed(HEADINGS_1_3.ownUse)} provides, to produce aggregate ` +
        `statistics that healdesk uses only to measure and improve the Services.`,
    );
  }
  paragraphs.push(purposes.map(item).join("\n"));

  paragraphs.push(
    wrap(
      `The ${S} involved is what people say or write, kept as transcripts with no call audio; ` +
        `their names and telephone numbers; the services and times they ask about, and the other ` +
        `booking details ${headed(H.minimum)} lists; messaging-account identifiers; the number or ` +
        `network address a call or chat comes from; and booking and deposit status. ` +
        (live
          ? `It also includes free and busy times on each calendar that ${calendar}, or a ` +
            `calendar election that takes its place, lets healdesk use, and the appointments ` +
            `healdesk adds to those calendars.`
          : `Where a calendar election for a location lets healdesk use a calendar, it also ` +
            `includes free and busy times on that calendar and the appointments healdesk adds to ` +
            `it.`),
    ),
  );

  paragraphs.push(
    wrap(
      `healdesk processes ${S} while Practice uses the Services and, to pass calls through to ` +
        `Practice's direct line, for as long afterwards as the Terms provide. It keeps it no ` +
        `longer than the periods this agreement states. When the Services end, it returns or ` +
        `destroys it, including copies in backups and what its subcontractors hold, as ` +
        `${headed(HEADINGS_1_3.term)} provides.`,
    ),
  );

  paragraphs.push(
    wrap(
      `healdesk will not sell or share ${S}, as Cal. Civ. Code 1798.140 defines those words. ` +
        `Except as a state privacy law expressly permits, it will not retain, use or disclose ${S} ` +
        `outside the direct business relationship between healdesk and Practice, or for any ` +
        `purpose other than those above. That rules out any other commercial purpose, and ` +
        `healdesk's own management and administration. It will not combine ${S} with personal ` +
        `information that it receives from or for anyone else, or collects from its own ` +
        `interaction with a person, except to keep the Services secure and to detect and prevent ` +
        `fraud and abuse. healdesk understands the restrictions in this clause and will comply ` +
        `with them.`,
    ),
  );

  if (baa) {
    // The de-identification conditions themselves (reasonable measures, the
    // public commitment, no re-identification, the contract with recipients)
    // are stated once, in the own-use clause, for every practice (SL-04).
    paragraphs.push(
      wrap(
        `healdesk makes the statistics in item i above only as ${headed(HEADINGS_1_3.ownUse)} ` +
          `provides, by combining information after it has been de-identified, never by ` +
          `combining patient information itself. It makes none of them from consumer health ` +
          `data as RCW 19.373.010 or NRS 603A.430 defines it. The contract that clause requires ` +
          `of anyone to whom healdesk gives de-identified information also binds them to meet ` +
          `what the state privacy laws require of anyone who receives it.`,
      ),
    );
  }

  paragraphs.push(
    wrap(
      `healdesk will comply with the obligations the state privacy laws place on it in that ` +
        `role, and give ${S} the same level of privacy protection they require of Practice. It ` +
        `will:`,
    ),
  );

  paragraphs.push(
    [
      `a. ensure that every person who processes ${S} for it is bound by a duty of ` +
        `confidentiality, and give access only to those who need it for the purposes above;`,
      `b. help Practice, by appropriate technical and organisational measures and insofar as it ` +
        `is possible, to meet its obligations under those laws, including answering the requests ` +
        `people make under them, giving Practice what it needs within ten business days of being ` +
        `asked;`,
      `c. when Practice tells it to delete a person's information, delete it within ten ` +
        `business days from healdesk's own records, including the raw copies it keeps of what ` +
        `other services sent it about that person. Copies in its backups are deleted as those ` +
        `backups expire, within ${BACKUP_RETENTION_DAYS} days after that. healdesk will have each ` +
        `subcontractor that holds the information delete it in time for Practice to meet the ` +
        `deadline the law sets. The only exception is what ${headed(HEADINGS_1_3.subcontractors)} ` +
        `says a subcontractor may keep for abuse detection and security, or because a law ` +
        `requires it. That is kept for that purpose and period only, and used for nothing else. ` +
        `healdesk keeps only a record of the request, for no longer than it needs one to make ` +
        `sure the information stays deleted, and uses it for nothing else;`,
      `d. give Practice the information it holds that Practice needs for any risk assessment, ` +
        `data protection or impact assessment, or cybersecurity audit those laws require of ` +
        `Practice, and misrepresent no fact relevant to one;`,
      `e. tell Practice promptly after it determines that it can no longer meet its obligations ` +
        `under this clause; and`,
      `f. notify Practice of any breach of the security of ${S}, as a state breach-notification ` +
        `law defines it, and report it, as ${headed(H.reporting)} provides for a breach. healdesk ` +
        `will also help Practice meet its own duties to secure ${S} and to give notice of a ` +
        `breach.`,
    ]
      .map(item)
      .join("\n"),
  );

  paragraphs.push(
    wrap(
      `Practice may take reasonable and appropriate steps to ensure that healdesk uses ${S} ` +
        `consistently with Practice's obligations under the state privacy laws. On notice, ` +
        `Practice may also take reasonable and appropriate steps to stop and remedy any ` +
        `unauthorised use, including requiring documents showing that healdesk has deleted what ` +
        `it was told to delete. On reasonable request, healdesk will make available all the ` +
        `information in its possession necessary to show that it meets this clause. Practice, or ` +
        `an assessor Practice designates, may assess healdesk's compliance with this clause on ` +
        `reasonable notice, once in any twelve months and after any breach, at Practice's cost, ` +
        `and healdesk will cooperate. healdesk may instead have a qualified and independent ` +
        `assessor assess its policies and technical and organisational measures, using an ` +
        `appropriate and accepted control standard or framework and assessment procedure, and ` +
        `will give Practice the report on request.`,
    ),
  );

  const subcontractors = headed(HEADINGS_1_3.subcontractors);
  paragraphs.push(
    wrap(
      `${subcontractors.charAt(0).toUpperCase()}${subcontractors.slice(1)} applies to ${S}, and ` +
        `the notice it gives before a new subcontractor handles ${S} is Practice's opportunity to ` +
        `object. healdesk will bind each subcontractor that handles ${S}, by the written agreement ` +
        `that clause requires, to meet the obligations this clause places on healdesk for that ` +
        `information. The only exception to a subcontractor's duty to delete is what that clause ` +
        `says it may keep for abuse detection and security, or because a law requires it. ` +
        (live
          ? `Practice's Google Calendar, its payment processor and its Instagram, Messenger and ` +
            `WhatsApp accounts are Practice's own services, which Practice connects, where it uses ` +
            `them, under its own accounts with their providers. They are not healdesk's ` +
            `subcontractors. healdesk sends ${S} to them only to add appointments to the calendar ` +
            `as ${calendar}, or a calendar election that takes its place, provides; to create the ` +
            `payment links ${payments} describes; and to reply on Instagram, Messenger or WhatsApp ` +
            `inside a conversation the person started there.`
          : `Practice's payment processor and its Instagram, Messenger and WhatsApp accounts are ` +
            `Practice's own services, which Practice connects, where it uses them, under its own ` +
            `accounts with their providers. So is any Google Calendar that a calendar election ` +
            `connects. They are not healdesk's subcontractors. healdesk sends ${S} to them only to ` +
            `create the payment links ${payments} describes; to reply on Instagram, Messenger or ` +
            `WhatsApp inside a conversation the person started there; and, where a calendar ` +
            `election for a location provides for it, to add appointments to that location's ` +
            `calendar.`),
    ),
  );

  if (!baa) {
    paragraphs.push(
      wrap(
        `Where Practice is a provider of health care under California's Confidentiality of ` +
          `Medical Information Act, healdesk receives medical information for Practice under Cal. ` +
          `Civ. Code 56.10(c)(3) and will not further disclose it in a way that would violate ` +
          `that Act.`,
      ),
    );
  }

  paragraphs.push(
    wrap(
      `Practice will tell healdesk of any request under the state privacy laws that healdesk ` +
        `must act on, with the information healdesk needs to act on it. It will make sure its own ` +
        `notices, consents and any consumer health data privacy policy cover the processing this ` +
        `clause describes, and will not instruct healdesk to process ${S} in a way those laws ` +
        `forbid. A request made to healdesk directly is handled as ${headed(H.requests)} ` +
        `provides.`,
    ),
  );

  return paragraphs.join("\n\n");
}

/**
 * The Payments clause, unwrapped, for BAA 1.3.0 and the funnel's DPA alike:
 * the spec's rule that nothing clinical reaches a payment artifact, put into
 * the agreement. Unconditional; "where Practice takes deposits" limits it.
 * It names no patient ("the person", "the payer"), so it stays a constant
 * the DPA shares word for word.
 *
 * Redrafted by the pre-release audit (§12.14: PT-11, ICD-10, SL-08): healdesk
 * "may" send a link, and only where one can be sent — website chat and
 * Instagram, Messenger and WhatsApp; on a call it sends none and flags the
 * deposit for staff, which is what `depositLine` in apps/app's voice tools
 * does today. What a link carries, what healdesk sends the processor, and
 * the payer details healdesk keeps from the processor's notice (none) are
 * package D's to build to (§12.14, release gates).
 */
export const PAYMENTS_CLAUSE_HEADING = "Payments";
export const PAYMENTS_CLAUSE_BODY =
  "Where Practice takes deposits, healdesk may send a payment link in a website chat or an " +
  "Instagram, Messenger or WhatsApp conversation. It creates the link through Practice's own " +
  "payment processor. On a call it sends none, and flags any deposit for Practice's staff to " +
  "collect. A link carries no information about the person or the booking except an amount, a " +
  "generic description and a reference number. The same holds for everything healdesk sends " +
  "the processor to create it, metadata and any statement descriptor included. Neither ever " +
  "carries a service name or any clinical detail. The processor tells healdesk whether each " +
  "link has been paid. Its notice may also carry the payer's details; healdesk keeps none of " +
  "them. healdesk never takes card numbers.";

/** One clause object per calendar kind; the predicates partition every input. */
function calendarClause(kind: CalendarTermsKind): BaaClause {
  return {
    id: CALENDAR_CLAUSE_IDS[kind],
    heading: CALENDAR_CLAUSE_HEADING,
    appliesWhen: (v) => calendarKindOf(v) === kind,
    body: (v) =>
      calendarClauseBody({
        kind,
        account: calendarAccountOf(v),
        // The render guard has refused an unknown booking system already.
        bookingSystem: v.bookingSystem as BookingSystemId,
      }) +
      "\n\n" +
      wrap(CALENDAR_LOCATION_PARAGRAPH),
  };
}

/**
 * ⚖️ 1.2.1 has one Google Calendar clause, unconditional, which tells every
 * practice that healdesk adds appointments to its calendar. That is untrue
 * for a practice whose booking system does not read Google Calendar (it runs
 * manual booking, and healdesk connects to nothing), and it says nothing
 * about who answers for a calendar Google's business associate agreement
 * does not cover. 1.3.0 asks both questions at checkout and lets the answers
 * choose the clause (plan §2.1–§2.5, owner decisions 2 and 3 of 5 October
 * 2026).
 *
 * The pre-release audit of 6 October 2026 (94 confirmed findings from four
 * lenses, each verified; docs/counsel/agreement-changes.md §12.14) redrafted
 * most of it, under the owner's four decisions of that day. Clause by clause,
 * against 1.2.1:
 *
 *   preamble         "This agreement", lower-case as in the body; the Services
 *                    as the Definitions clause defines them; the specialty in
 *                    the catalogue's own words ("a practice in the field of
 *                    …"); healdesk's registered address as the trade licence
 *                    gives it (apps/web/src/lib/legal.ts). The Delaware
 *                    mailbox appears only in the Notices clause, as a mailing
 *                    address. Every line goes through wrap().
 *   definitions      NEW object. "Services" and "Fees" are defined here, since
 *                    the Terms define neither, and the Services end when the
 *                    subscription does (the pass-through after it does not
 *                    continue them). HIPAA, its two Rules, "covered entity",
 *                    "business associate", "patient information" and
 *                    "calendar election" are defined too. A breach includes a
 *                    state-law breach of security. The agreement prevails
 *                    over the Terms on patient information and on termination.
 *   practice status  NEW object: plain wording, and the state laws that may
 *                    apply whatever the status.
 *   permitted uses   NEW object: the own-use exception the regulation allows
 *                    (164.504(e)(2)(i)(A)), "Practice" for the legal name, and
 *                    the CMIA undertaking, moved here from the state-law
 *                    clause so that it binds whatever Practice's status.
 *   state-law        stateLawClauseBody, shared with the funnel's DPA: one
 *                    statement each of the instructions, the purposes, the
 *                    data, the retention, the combination rule and the sale or
 *                    share promise; the more protective clause governs; the
 *                    calendar purposes and data follow the booking sync.
 *   data sources     NEW object, headed "What healdesk reads from Practice's
 *                    systems": no credentials to any booking,
 *                    practice-management or point-of-sale system, and every
 *                    source of PHI named. The phase-two `data-sources-verified`
 *                    is not registered; the render guard refuses verified
 *                    reporting instead.
 *   google calendar  Three clauses headed "Google Calendar", exactly one of
 *                    which renders: covered, uncovered or not-used, from
 *                    calendar-terms.ts, each followed here by the location
 *                    paragraph. Every rule applies to each calendar healdesk
 *                    uses, one per provider included.
 *   payments         A link only in website chat and on Instagram, Messenger
 *                    and WhatsApp ("may"), none on a call; what a link and the
 *                    processor carry; no payer details kept.
 *   own use          The regulation's breach-of-confidentiality condition;
 *                    statistics used only to measure and improve the
 *                    Services; the de-identification conditions state law
 *                    sets, stated once, for every practice.
 *   practice duties  NEW object: 164.520 and 164.522 cited, and the own-use
 *                    exception.
 *   safeguards       NEW object: PHI at rest only in the United States and
 *                    encrypted, as a covenant that reaches subcontractors;
 *                    calls passed through or transferred; no calls to
 *                    patients and no SMS.
 *   minimum          NEW object: what the booking-field catalogue asks, no
 *                    email, "the person booking", and each record's retention
 *                    as the purge runs it; backups within 35 days.
 *   reporting        NEW object: one rule for every practice, immediately
 *                    and within 24 hours; 164.412's delay; the notice is
 *                    itself the written report, with the contents 164.410(c)
 *                    and 164.404(c) require, added to promptly.
 *   subcontractors   Anthropic in covenant form; the notice goes to the
 *                    notice address and names the subcontractor
 *                    (subprocessor-notice.ts).
 *   patient rights   NEW object: "Practice"; an amendment appended and linked
 *                    where a record must stay as it was made; a request made
 *                    to healdesk itself answered only in healdesk's reply.
 *   acting           Headed "Where healdesk acts in Practice's place".
 *   prohibited       NEW object: the Meta replies carved out of the
 *                    advertising ban expressly, and described in paragraphs of
 *                    their own.
 *   term             Termination for a material violation; ending the
 *                    agreement ends the Services; no Fees after, and a refund,
 *                    where Practice terminates for healdesk's violation or on
 *                    objection; the export delivered unasked within 30 days;
 *                    destruction at 30 days if it has been delivered by then,
 *                    otherwise once it is, never later than 90 (the DPA's
 *                    rule); backups within 35 days; further uses and
 *                    disclosures limited.
 *   liability        NEW object: Terms §13 and §14's cap, carve-out,
 *                    indemnitees, triggers and defence paragraph; the Term
 *                    clause's refund outside the exclusion and the indemnity.
 *   records          NEW object: "PHI".
 *   notices          NEW object: email to healdesk is enough; Practice's one
 *                    notice address; the Delaware courts' exclusive
 *                    jurisdiction; clause names resolved by heading; a
 *                    change-in-law termination ends the Services.
 *
 * No 1.2.1 or older object changes: every clause above is a new object or
 * 1.3.0's own. 22 clauses are registered and 20 render: one calendar clause
 * of three.
 *
 * The render guard (`validate130`) refuses verified reporting, which is phase
 * two and which this version does not describe; a document without a known
 * booking system and Google account kind; and one whose `connectedPlatform`
 * names anything but that booking system. So the agreement and the system it
 * was signed with can never disagree.
 *
 * Drafted, not released: it sits at [1] with approvedByCounsel false, so
 * nothing offers it, and signing refuses it: validateSignRequest and
 * signAgreement (apps/app/src/lib/agreements.ts) both sign only
 * BAA_TEMPLATES[0], or a released version inside its BAA_RELEASE_OVERLAP
 * window. Provisioning does not check it: its approval gate reads
 * currentBaaTemplate(), not the bound acceptance's version, until plan C15
 * makes it read the bound one, and C15 must land before the release. The
 * owner releases it after the release gates in agreement-changes.md §12.14
 * are closed (owner, Q2; plan C19), when it moves to [0]. Its golden hashes
 * are regenerated with each edit before release, and noted in
 * agreement-changes.md §12.
 */
const CLAUSES_1_3: readonly BaaClause[] = [
  {
    id: "definitions",
    heading: HEADINGS_1_3.definitions,
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `"Practice" means ${v.clinicLegalName}. "healdesk" means ${ENTITY}, ${ENTITY_FORM}. ` +
          `"Terms" means the healdesk Terms of Service at healdesk.io/terms as in force on the ` +
          `effective date. "Services" means everything healdesk provides to Practice under the ` +
          `Terms and the order Practice placed, including the assistant on each channel Practice ` +
          `buys and Practice's portal. The Services end when Practice's subscription under the ` +
          `Terms ends, however it ends; passing forwarded calls through to Practice's direct line ` +
          `after that, as the Terms provide, does not continue them. "Fees" means the amounts ` +
          `Practice pays or owes healdesk under the Terms and that order.`,
      ) +
      "\n\n" +
      wrap(
        `"HIPAA" means the Health Insurance Portability and Accountability Act of 1996 and the ` +
          `Health Information Technology for Economic and Clinical Health Act, with their ` +
          `regulations at 45 CFR Parts 160 and 164. The "HIPAA Privacy Rule" is Subpart E, and the ` +
          `"HIPAA Security Rule" is Subpart C, of 45 CFR Part 164. "Protected health information" ` +
          `(PHI), "covered entity", "business associate", "unsecured PHI", "security incident", ` +
          `"subcontractor" and "designated record set" have the meanings given in 45 CFR Parts 160 ` +
          `and 164. "Breach" has the meaning 45 CFR 164.402 gives it, and also includes anything ` +
          `an applicable state breach-notification law treats as a breach of the security of ` +
          `patient information.`,
      ) +
      "\n\n" +
      wrap(
        `"Patient information" means PHI and, for any period in which Practice is not a covered ` +
          `entity, the information ${headed(STATE_LAW_CLAUSE_HEADING)} describes. "Calendar ` +
          `election" means the document, in the form healdesk provides, by which Practice sets the ` +
          `Google Calendar terms for one location, accepted for Practice by a person with authority ` +
          `to bind it. Once accepted, it forms part of this agreement. "Business day" means a day ` +
          `other than a Saturday, Sunday or United States federal holiday.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement governs the patient information healdesk creates, receives, maintains or ` +
          `transmits for Practice in the course of the Services. Where this agreement and the Terms ` +
          `differ about patient information, or about terminating this agreement and what then ` +
          `happens to the Services and the Fees, this agreement governs.`,
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
            ? `Practice has notified healdesk that it does not transmit health information ` +
              `electronically in connection with a transaction covered by HIPAA, and so believes ` +
              `that it is not a covered entity.`
            : `Practice has not yet notified healdesk whether it is a covered entity, and will do so ` +
              `before healdesk processes information about any real patient.`;
      return (
        wrap(notified) +
        "\n\n" +
        wrap(
          `Practice's status is Practice's determination, not healdesk's. Whatever it is, ` +
            `healdesk applies the safeguards in this agreement. Where Practice is a covered entity, ` +
            `this agreement is a business associate agreement under 45 CFR 164.502(e) and ` +
            `164.504(e). Where it is not, this agreement is a data-protection agreement on the same ` +
            `terms, with the additions in ${headed(STATE_LAW_CLAUSE_HEADING)}. Practice will tell ` +
            `healdesk promptly if its status changes.`,
        ) +
        "\n\n" +
        wrap(
          `Whatever Practice's status, state breach-notification and medical-confidentiality laws ` +
            `may also apply to both parties. Where Practice is not a covered entity, state ` +
            `consumer-privacy and consumer-health-privacy laws may apply as well. Some of these ` +
            `laws carry a private right of action.`,
        )
      );
    },
  },

  {
    id: "permitted-uses",
    heading: "What healdesk may do with patient information",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk may use and disclose PHI only as necessary to provide the Services to Practice, ` +
          `as ${headed(HEADINGS_1_3.ownUse)} permits, and as required by law. Except for what that ` +
          `clause permits, healdesk may not use or disclose PHI in a way that would violate the ` +
          `HIPAA Privacy Rule if done by Practice.`,
      ) +
      "\n\n" +
      wrap(
        `Where Practice is a provider of health care under California's Confidentiality of ` +
          `Medical Information Act, healdesk receives medical information for Practice under Cal. ` +
          `Civ. Code 56.10(c)(3), whether or not Practice is a covered entity. healdesk will not ` +
          `further disclose that information in a way that would violate that Act.`,
      ),
  },

  /**
   * The processor terms state privacy law asks for (owner, Q8), for every
   * practice: the first sentence limits them to a period in which Practice is
   * not a covered entity, so a practice that really is covered gets nothing
   * from them, and one that is not cannot lose them by ticking the wrong box.
   * The text is stateLawClauseBody's, which the funnel's DPA shares; its
   * calendar purposes and data follow the location's booking sync.
   */
  {
    id: "state-law",
    heading: STATE_LAW_CLAUSE_HEADING,
    appliesWhen: ALWAYS,
    body: (v) =>
      stateLawClauseBody({ subject: "patient information", kind: "baa", sync: bookingSyncOf(v) }),
  },

  /**
   * What healdesk reads, and where PHI comes from. healdesk holds credentials
   * to no booking, practice-management or point-of-sale system: the one
   * access it holds, where the booking system books live, is the calendar the
   * Google Calendar clause describes, and a manual-booking practice connects
   * nothing unless a calendar election later gives a location a calendar
   * (PT-04, ICD-11, ICD-27). It names the system when it has a name, and
   * renders for every 1.3.0 document, since the render guard refuses the
   * phase-two verified reporting `data-sources-verified` described (HRC-17).
   */
  {
    id: "data-sources-none",
    heading: "What healdesk reads from Practice's systems",
    appliesWhen: ALWAYS,
    body: (v) => {
      const live = bookingSyncOf(v) === "live";
      const none = v.connectedPlatform
        ? `healdesk holds no credentials to ${v.connectedPlatform} or to any other booking, ` +
          `practice-management or point-of-sale system Practice uses, and reads nothing from them.`
        : `healdesk holds no credentials to any booking, practice-management or point-of-sale ` +
          `system Practice uses, and reads nothing from one.`;
      // A manual practice connects no calendar, but a calendar election may
      // later give a location one (the location paragraph of the calendar
      // clause); clause 4 says the same, so this clause stays true after it.
      const sources = [
        `a. the people who call Practice, or write to it in a website chat or on Instagram, ` +
          `Messenger or WhatsApp: what they say or write, with the telephone number, ` +
          `messaging-account identifier or network address it comes from;`,
        `b. Practice's staff: what they enter, confirm or correct through healdesk, or send to ` +
          `it;`,
        `c. Practice's payment processor: its notice of whether a payment link healdesk sent has ` +
          `been paid, as the ${PAYMENTS_CLAUSE_HEADING} clause describes; and`,
        live
          ? `d. Practice's Google Calendar: what the ${CALENDAR_CLAUSE_HEADING} clause, or a ` +
            `calendar election that takes its place, says healdesk reads from it.`
          : `d. any Google Calendar that a calendar election lets healdesk use: what that ` +
            `election says healdesk reads from it.`,
      ];
      return (
        wrap(
          live
            ? `Apart from the access to Practice's Google Calendar that the ` +
                `${CALENDAR_CLAUSE_HEADING} clause describes, ${none}`
            : `Apart from any Google Calendar that a calendar election lets healdesk use, ${none}`,
        ) +
        "\n\n" +
        wrap(`The PHI healdesk receives for Practice comes from:`) +
        "\n\n" +
        sources.map(item).join("\n")
      );
    },
  },

  calendarClause("covered"),
  calendarClause("uncovered"),
  calendarClause("not_used"),

  {
    id: "payments",
    heading: PAYMENTS_CLAUSE_HEADING,
    appliesWhen: ALWAYS,
    body: () => wrap(PAYMENTS_CLAUSE_BODY),
  },

  // De-identify first, then combine, and never re-identify: no PHI is
  // aggregated across practices (owner, 6 October 2026). The conditions state
  // law sets for de-identified information are stated here, once, for every
  // practice (SL-04); the public commitment must be on healdesk.io/privacy
  // before release (§12.14, PAGE-C19).
  {
    id: "own-use",
    heading: HEADINGS_1_3.ownUse,
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk may use PHI where necessary for its own proper management and administration ` +
          `and to carry out its legal responsibilities. It may disclose PHI for those purposes ` +
          `only where the law requires the disclosure, or where it first obtains reasonable ` +
          `assurances from the recipient. The recipient must assure healdesk that it will hold the ` +
          `PHI confidentially, and use or further disclose it only as required by law or for the ` +
          `purpose for which it was disclosed. The recipient must also agree to notify healdesk of ` +
          `any instance of which it is aware in which the confidentiality of the PHI has been ` +
          `breached. 45 CFR 164.504(e)(4).`,
      ) +
      "\n\n" +
      wrap(
        `healdesk may de-identify Practice's PHI in accordance with 45 CFR 164.514(b), and ` +
          `combine the de-identified information with de-identified information from other ` +
          `practices, only to produce aggregate statistics about the Services. It uses those ` +
          `statistics only to measure and improve the Services, for example to learn what fraction ` +
          `of after-hours calls are answered. It combines only information that has already been ` +
          `de-identified, and never combines PHI itself with information from any other source to ` +
          `produce them.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk takes reasonable measures to ensure that the de-identified information cannot ` +
          `be associated with any individual or household. It commits publicly, at ` +
          `healdesk.io/privacy, to keep and use that information only in de-identified form and ` +
          `not to try to re-identify it. It will not re-identify, or try to re-identify, any ` +
          `individual from that information. It requires by contract anyone who receives that ` +
          `information from it to meet the same conditions. healdesk will not use PHI to train, ` +
          `fine-tune or evaluate any model, and nothing in this clause permits it to.`,
      ) +
      "\n\n" +
      wrap(
        `For any period in which Practice is not a covered entity, this clause permits only what ` +
          `${headed(STATE_LAW_CLAUSE_HEADING)} also permits.`,
      ),
  },

  {
    id: "practice-duties",
    heading: "What Practice will tell healdesk",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(`Practice will tell healdesk, promptly and in writing:`) +
      "\n\n" +
      [
        `a. of any limitation in its notice of privacy practices under 45 CFR 164.520 that ` +
          `affects how healdesk may use or disclose PHI;`,
        `b. of any change to, or revocation of, a patient's permission to use or disclose PHI, ` +
          `where it affects healdesk;`,
        `c. of any restriction on the use or disclosure of PHI that Practice has agreed to, or ` +
          `must comply with, under 45 CFR 164.522, where it affects healdesk.`,
      ]
        .map(item)
        .join("\n") +
      "\n\n" +
      wrap(
        `Practice will not ask healdesk to use or disclose PHI in a way that would not be ` +
          `permissible under the HIPAA Privacy Rule if done by Practice, except for the uses and ` +
          `disclosures ${headed(HEADINGS_1_3.ownUse)} permits.`,
      ),
  },

  /**
   * PHI is kept at rest only in the United States, encrypted, and reaches a
   * subcontractor only if it does the same: a covenant, not a statement about
   * vendors whose region is not yet confirmed in writing (HRC-13, PT-10; R6
   * for Retell). The telephone exception covers the three things the product
   * does with a call: answering it, passing it through to the practice's
   * direct line, and the live transfer a practice switches on (PT-03).
   */
  {
    id: "safeguards",
    heading: "Safeguards",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will use appropriate administrative, physical and technical safeguards to ` +
          `prevent any use or disclosure of PHI this agreement does not permit, and will comply ` +
          `with Subpart C of 45 CFR Part 164 — the HIPAA Security Rule — in respect of electronic ` +
          `PHI.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps PHI at rest only in the United States, always encrypted, and lets a ` +
          `subcontractor handle PHI only if that subcontractor does the same. In transit, PHI is ` +
          `encrypted wherever healdesk controls both ends, and healdesk will not transmit PHI over ` +
          `a channel that cannot negotiate encryption. An email whose receiving server will not ` +
          `negotiate encryption is failed, not sent, and healdesk tells Practice rather than send ` +
          `it in the clear. The list of individuals in a breach report travels by secure transfer, ` +
          `never in the email itself.`,
      ) +
      "\n\n" +
      wrap(
        `One narrow exception: a person who telephones Practice has chosen the telephone, and a ` +
          `telephone call is not end-to-end encrypted. healdesk may answer such a call, and what ` +
          `the assistant says on it is limited to the minimum necessary and never includes ` +
          `clinical detail, test results or card numbers. Whenever the assistant is not answering, ` +
          `including for as long after the Services end as the Terms provide, healdesk may pass ` +
          `such a call through, unchanged, to the direct line Practice gives it. Where Practice ` +
          `switches on live call transfer, the assistant may also transfer a caller to the number ` +
          `Practice gives for that purpose. What is said after that is between the caller and ` +
          `Practice. healdesk places no calls to patients and sends no SMS. This exception does ` +
          `not extend to any other channel or content.`,
      ),
  },

  /**
   * What the booking-field catalogue (booking-requirements.ts) can ask: the
   * locked four on every channel, and on a call the fields Practice's
   * settings or its specialty's defaults switch on; never an email address
   * (PT-02). The periods are the nightly purge's (apps/app
   * src/lib/retention/purge.ts), with TRANSCRIPT_RETENTION_DAYS the clinic's
   * default and BACKUP_RETENTION_DAYS the host's (PT-28). A booking request's
   * period runs from its own dates, which nothing moves once it is decided
   * (app_purge_booking_requests, apps/app drizzle/0054); it no longer goes
   * with its contact by cascade, so the text gives it its own sentence, and a
   * person's contact details stay while any record of theirs does (purge
   * step 3).
   */
  {
    id: "minimum-necessary",
    heading: HEADINGS_1_3.minimum,
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Each party will limit its use, disclosure and requests of PHI to the minimum necessary ` +
          `to accomplish the purpose, consistent with 45 CFR 164.502(b).`,
      ) +
      "\n\n" +
      wrap(
        `When someone wants to book, the assistant asks the person booking for no more than a ` +
          `receptionist would write on a callback slip:`,
      ) +
      "\n\n" +
      [
        `a. on every channel: a first name, a telephone number Practice can call, a preferred day ` +
          `or time, and one or two other times that could work;`,
        `b. on a call, where Practice's settings or its specialty's defaults ask for them: a last ` +
          `name and the service asked about; and`,
        `c. on a call, on the same condition: whether the person is a new or returning patient, ` +
          `whether the visit is a consultation or a treatment, and any practitioner they would ` +
          `like to see.`,
      ]
        .map(item)
        .join("\n") +
      "\n\n" +
      wrap(
        `It asks for no email address and no history, medication or diagnosis, and it never ` +
          `takes a card number. Anything else a person chooses to say or write is kept only in the ` +
          `transcript of that conversation, for the period below. Clinical content sent on ` +
          `Instagram, Messenger or WhatsApp is not kept at all. On every channel the assistant's ` +
          `opening line says that it is an AI assistant and, on a call, that the call is ` +
          `transcribed; Practice cannot switch that statement off or edit it out.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps each conversation, with its transcript, for ${TRANSCRIPT_RETENTION_DAYS} ` +
          `days after it took place, and each appointment record for ${TRANSCRIPT_RETENTION_DAYS} ` +
          `days after the appointment's time. It keeps each booking request for ` +
          `${TRANSCRIPT_RETENTION_DAYS} days after the latest of when it was made, the time it was ` +
          `confirmed for and its appointment's time. A person's contact details are kept while any ` +
          `conversation, appointment record or booking request of theirs is kept, and in any case ` +
          `until ${TRANSCRIPT_RETENTION_DAYS} days after the last time those details were recorded ` +
          `or changed. Practice may shorten these periods in its portal. A backup copy of anything ` +
          `healdesk deletes expires within ${BACKUP_RETENTION_DAYS} days of the deletion. No call ` +
          `audio is kept at all. The Term clause governs what is held after termination.`,
      ),
  },

  /**
   * One rule for every practice, whatever its status (owner, 6 October 2026;
   * HRC-05, HRC-06, HRC-12, PT-16): notice immediately following discovery
   * and within 24 hours, which also meets Cal. Civ. Code 1798.82(b); 164.412's
   * law-enforcement delay. The notice is itself the written report, as
   * complete as healdesk can then make it, so what 164.410(c) and 164.404(c)
   * require (the identification of each individual included) is due within
   * the same 24 hours to the extent it is known, and is added to promptly as
   * information arrives: 164.410(c)(1) puts the identification in the
   * notification itself, and (c)(2) the rest "at the time of the notification
   * ... or promptly thereafter" (verification of the redraft, 7 October 2026).
   * The incident console's deadline follows as a release gate (PT-14).
   */
  {
    id: "reporting",
    heading: HEADINGS_1_3.reporting,
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will notify Practice, by email to Practice's address in the Notices clause, ` +
          `immediately following discovery of any of the following, and in any case within 24 ` +
          `hours of discovery:`,
      ) +
      "\n\n" +
      [
        `a. any use or disclosure of PHI that this agreement does not permit, by healdesk or by a ` +
          `subcontractor;`,
        `b. any breach of unsecured PHI;`,
        `c. any security incident, including anything a state breach-notification law treats as ` +
          `a breach of the security of PHI.`,
      ]
        .map(item)
        .join("\n") +
      "\n\n" +
      wrap(
        `Routine unsuccessful attempts that compromised nothing, such as blocked sign-ins, port ` +
          `scans and filtered traffic, are security incidents that the parties agree this clause ` +
          `reports once, here; healdesk will summarise them on request.`,
      ) +
      "\n\n" +
      wrap(
        `A breach is treated as discovered on the first day healdesk knows of it, or by ` +
          `exercising reasonable diligence would have known of it, as 45 CFR 164.410(a)(2) ` +
          `provides. healdesk knows what any of its workforce members or agents, other than the ` +
          `person committing the breach, knows or by exercising reasonable diligence would have ` +
          `known. Anything else this clause covers is discovered when healdesk becomes aware of it.`,
      ) +
      "\n\n" +
      wrap(
        `For a breach, twenty-four hours is deliberately far inside the sixty days that 45 CFR ` +
          `164.410(b) allows, because Practice's own clock to notify patients may run from ` +
          `healdesk's discovery rather than from its notice. healdesk delays a notice only where a ` +
          `law enforcement official states that the notice would impede a criminal investigation ` +
          `or damage national security. It then delays it only for as long as 45 CFR 164.412, or ` +
          `the state law that applies, provides, and gives it as soon as that delay ends.`,
      ) +
      "\n\n" +
      wrap(
        `Each notice is also a written report, sent to the same address and as complete as ` +
          `healdesk can then make it, and healdesk will add to the report promptly as information ` +
          `becomes available. For a breach, the report will include, to the extent possible, what ` +
          `45 CFR 164.410(c) requires and what Practice needs for its own notices:`,
      ) +
      "\n\n" +
      [
        `· the identification of each individual whose unsecured PHI has been, or is reasonably ` +
          `believed by healdesk to have been, accessed, acquired, used or disclosed during the ` +
          `breach, sent by secure transfer as the Safeguards clause provides;`,
        `· a brief description of what happened, including the date of the breach and the date ` +
          `of its discovery;`,
        `· the types of unsecured PHI involved;`,
        `· any steps individuals should take to protect themselves from potential harm resulting ` +
          `from the breach;`,
        `· what healdesk is doing to investigate the breach, to mitigate harm to individuals and ` +
          `to protect against further breaches;`,
        `· whether a law enforcement official required a notice to be delayed;`,
        `· a contact at healdesk; and`,
        `· any other available information Practice must include in a notice that 45 CFR ` +
          `164.404(c) or a state breach-notification law requires of it.`,
      ]
        .map(bullet)
        .join("\n") +
      "\n\n" +
      wrap(
        `For anything else this clause covers, the report says what happened and when, what ` +
          `information was involved, and what healdesk has done about it. Who bears the cost of ` +
          `notifying patients, regulators and anyone else about a breach is allocated by the ` +
          `Liability clause.`,
      ),
  },

  // 1.2.1's flow-down paragraph, word for word; Anthropic in covenant form
  // (HRC-11, ICD-12, PT-09, SUB-04: its business associate agreement with
  // healdesk is still pending on the register); the notice is the shared
  // 24-hour sentence.
  {
    id: "subcontractors",
    heading: HEADINGS_1_3.subcontractors,
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
          `conversation. healdesk's language-model provider is Anthropic. Anthropic receives the ` +
          `content of each conversation, to generate the assistant's replies, only under a ` +
          `business associate agreement with healdesk signed before any patient's information ` +
          `reaches it. Anthropic retains conversation content for 30 days, for abuse detection ` +
          `and security, and then deletes it, except content its automated trust-and-safety ` +
          `systems flag or the law requires it to keep, which it may retain for up to two years. ` +
          `The service it provides under that agreement cannot run with shorter retention. ` +
          `Anthropic never trains on that content, and healdesk may not use PHI to train, ` +
          `fine-tune or evaluate any model, its own or a third party's.`,
      ) +
      "\n\n" +
      wrap(subprocessorNoticeClauseBody()),
  },

  {
    id: "patient-rights",
    heading: HEADINGS_1_3.patientRights,
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `When a patient asks to see their information, to have it corrected, or to be told who ` +
          `it was disclosed to, Practice answers them. healdesk gives Practice what it needs to ` +
          `answer within ten business days of being asked:`,
      ) +
      "\n\n" +
      [
        `a. Access. healdesk will make available the PHI it holds about that patient in a ` +
          `designated record set, so Practice can meet its obligations under 45 CFR 164.524.`,
        `b. Amendment. healdesk will make that information available for amendment and will ` +
          `incorporate any amendment Practice directs, under 45 CFR 164.526. Where the record can ` +
          `be changed, healdesk corrects its own copy. Where a record must stay as it was made, ` +
          `such as a booking request or the record of a conversation, healdesk appends the ` +
          `amendment to it and links the two, as 45 CFR 164.526(c)(1) provides. Every later use ` +
          `and export of that record then carries the amendment.`,
        `c. Accounting. healdesk will maintain and make available the information Practice needs ` +
          `to give a patient an accounting of disclosures under 45 CFR 164.528.`,
      ]
        .map(item)
        .join("\n") +
      "\n\n" +
      wrap(
        `If a patient makes one of these requests, or any other request about their ` +
          `information, to healdesk itself rather than to Practice, healdesk will not act on it. ` +
          `It will pass the request to Practice within five business days and, in its reply to ` +
          `the patient, tell them that healdesk cannot act on it and has passed it to Practice.`,
      ),
  },

  // Replying to a patient who writes, not "sending messages": v1 is inbound only.
  {
    id: "acting-in-your-place",
    heading: "Where healdesk acts in Practice's place",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Some of what healdesk does is Practice carrying out its own duties through healdesk, ` +
          `rather than healdesk doing something of its own. Answering a patient who calls, and ` +
          `replying in Practice's name to a patient who writes, are both of those. Where healdesk ` +
          `carries out an obligation the HIPAA Privacy Rule places on Practice, healdesk will meet ` +
          `the requirements that Rule places on Practice in performing it, and not only the ` +
          `lighter ones it places on a business associate. 45 CFR 164.504(e)(2)(ii)(H).`,
      ),
  },

  /**
   * The advertising ban stays absolute by recipient, with one express
   * exception: the replies on Instagram, Messenger and WhatsApp, which Meta
   * carries and keeps (HRC-10, ICD-14). The paragraphs below it state that
   * owner-accepted risk (review log R4) instead of contradicting it. The
   * inbound screen before the model and the first reply's greeting are
   * release gates in apps/app (PT-12, PT-13).
   */
  {
    id: "prohibited",
    heading: "What healdesk is not authorised to do",
    appliesWhen: ALWAYS,
    body: () =>
      [
        `· Use PHI to train, fine-tune, or evaluate any artificial intelligence model, its own or ` +
          `a third party's.`,
        `· Disclose PHI to any advertising or analytics platform, in any form, including hashed ` +
          `or aggregated, except by replying on Instagram, Messenger or WhatsApp as the paragraphs ` +
          `below describe.`,
        `· Provide clinical advice, diagnosis, triage, or treatment recommendations through the ` +
          `assistant.`,
        `· Sell, license, or otherwise monetise patient information.`,
      ]
        .map(bullet)
        .join("\n") +
      "\n\n" +
      wrap(
        `Instagram, Messenger and WhatsApp are operated by Meta, which signs no business ` +
          `associate agreement and keeps what passes through those channels. A reply there ` +
          `therefore discloses to Meta at least that the person is in contact with Practice. ` +
          `Practice connects these channels only if it chooses to, knowing this, and may switch ` +
          `them off at any time. healdesk gives Meta nothing for advertising or analytics.`,
      ) +
      "\n\n" +
      wrap(
        `Where Practice connects them, the assistant replies there only inside a conversation the ` +
          `person started, on the channel the person chose, and only within the window Meta ` +
          `allows. Its first reply in each conversation says that it is an AI assistant and that ` +
          `the channel is not secure. healdesk checks each message a person sends there for ` +
          `clinical content before the language model sees it, and keeps none, repeats none and ` +
          `carries none into a summary. The assistant names no treatment and confirms no ` +
          `appointment details there, and moves anything clinical to a call or to Practice's own ` +
          `secure route.`,
      ),
  },

  /**
   * Termination for a violation Practice determines (164.504(e)(2)(iii)),
   * and ending this agreement ends the Services the same day, so no PHI is
   * processed without one (164.502(e)(2)). Destruction is what the product
   * does (owner, 6 October 2026, decision 2), in the rule and words the
   * funnel's DPA 1.0.0 states and apps/app's offboarding clock keeps
   * (`dueForDestruction`, keyed on `export_delivered_at`; redraft brief, 7
   * October 2026): the export delivered unasked within thirty days after the
   * Services end; destruction thirty days after they end if the export has
   * been delivered by then, otherwise as soon as it is delivered, and never
   * later than ninety days after they end; backups within
   * BACKUP_RETENTION_DAYS after that. "Delivered", never "downloaded" or
   * "asked for". Further uses and disclosures are limited (decision 3;
   * 164.504(e)(2)(ii)(J)). The refund on termination for healdesk's violation
   * or on objection is a commercial term flagged for the owner (§12.14), and
   * the Liability clause carves it out of its exclusion and the indemnity.
   */
  {
    id: "term",
    heading: HEADINGS_1_3.term,
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `This agreement takes effect on the effective date and ends when the Services end, ` +
          `unless it is terminated earlier. In this agreement, "termination" means the day it ` +
          `ends, however it ends. After termination this agreement goes on protecting any PHI ` +
          `healdesk still holds for Practice, until that PHI is destroyed.`,
      ) +
      "\n\n" +
      wrap(
        `Practice may terminate this agreement by written notice if Practice determines that ` +
          `healdesk has violated a material term of it. Where the violation can be cured, ` +
          `Practice may do so only if healdesk has not cured it within thirty days of being told ` +
          `of it in writing. healdesk may terminate this agreement by written notice if Practice ` +
          `materially breaches it. Where the breach can be cured, healdesk may do so only if ` +
          `Practice has not cured it within thirty days of being told of it in writing. Practice ` +
          `may also terminate this agreement under the Subcontractors clause.`,
      ) +
      "\n\n" +
      wrap(
        `Terminating this agreement ends the Services on the same day. Where Practice ` +
          `terminates because healdesk has violated a material term, or under the Subcontractors ` +
          `clause, no Fees accrue for any time after that day, and healdesk refunds any Fees ` +
          `Practice has paid for that time.`,
      ) +
      "\n\n" +
      wrap(
        `After termination healdesk uses and discloses PHI only as this clause provides and to ` +
          `meet its duties under this agreement and the law. It may also pass forwarded calls ` +
          `straight through to Practice's direct line for as long as the Terms provide.`,
      ) +
      "\n\n" +
      wrap(
        `Within thirty days after the Services end, healdesk will deliver to Practice, without ` +
          `being asked, an export of the patient information it holds for Practice, in a usable ` +
          `electronic form. healdesk will then destroy all PHI it holds for Practice, other than ` +
          `the records this clause says survive, and retain no copies. It will do so thirty days ` +
          `after the Services end if the export has been delivered by then; otherwise as soon as ` +
          `the export is delivered; and in any case no later than ninety days after the Services ` +
          `end, whether or not the export has been delivered. healdesk will have each ` +
          `subcontractor that holds PHI for Practice delete it by the same time.`,
      ) +
      "\n\n" +
      wrap(
        `Two kinds of copy outlast that deadline, and this agreement says why. healdesk cannot ` +
          `delete one practice's information from a database backup, so copies in backups are ` +
          `destroyed as those backups expire, within ${BACKUP_RETENTION_DAYS} days after the ` +
          `destruction above. Anthropic may keep what the Subcontractors clause describes, only ` +
          `for the purposes and periods that clause states. Until these copies are destroyed this ` +
          `agreement protects them. healdesk uses and discloses its backup copies only to restore ` +
          `its systems, and destroys Practice's PHI again in anything it restores.`,
      ) +
      "\n\n" +
      wrap(
        `Where returning or destroying any other PHI is not feasible, healdesk will tell Practice ` +
          `why in writing. It will extend the protections of this agreement to that PHI for as ` +
          `long as it is held, and limit further uses and disclosures of it to those purposes that ` +
          `make its return or destruction infeasible.`,
      ) +
      "\n\n" +
      wrap(
        `Two records survive termination and are kept for at least six years after it. One is ` +
          `the signed copy of this agreement, which holds no PHI. The other is healdesk's record ` +
          `of disclosures, which identifies records only by reference number and holds no ` +
          `patient's name or contact details and no conversation content. A copy of it goes to ` +
          `Practice with the export, so that Practice can answer accounting requests under 45 CFR ` +
          `164.528. healdesk keeps its own copy only to account for how it handled PHI. This ` +
          `agreement protects that copy for as long as it is held, and healdesk uses and ` +
          `discloses it for nothing else.`,
      ),
  },

  /**
   * The owner's allocation, the same as Terms §13 and §14 (ICD-16, PT-26):
   * §13's cap measure (the Fees paid in the twelve months before the event)
   * and its carve-out, which reaches the exclusion as well as the cap;
   * §14's indemnitees and triggers, the BAA's own two (covered-entity status
   * and Practice's own breach or violation), and §14's defence paragraph by
   * reference. "revenue" is not imported from §13: no v1 document may say it.
   * The Term clause's refund sits outside the exclusion and the indemnity, as
   * §13 keeps its own first-month refund outside its limits (HRC-07, SUB-03;
   * verification of the redraft, 7 October 2026).
   */
  {
    id: "liability",
    heading: "Liability, and who indemnifies whom",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `To the fullest extent the law allows, healdesk is not liable to Practice for any loss ` +
          `arising out of or relating to this agreement or the Services, in contract, tort or ` +
          `otherwise. That includes lost profits and indirect, incidental, special, consequential ` +
          `or punitive damages, however caused. Where the law does not permit that exclusion, ` +
          `healdesk's total aggregate liability to Practice, across all claims, is limited to the ` +
          `Fees Practice paid healdesk in the twelve months before the event giving rise to the ` +
          `claim. Neither the exclusion nor that limit applies to healdesk's wilful misconduct or ` +
          `gross negligence, or to any liability the law does not allow to be excluded or limited. ` +
          `Nothing in this clause limits the refund the Term clause provides, and Practice's ` +
          `indemnity below does not extend to a claim for it.`,
      ) +
      "\n\n" +
      wrap(
        `Practice will defend, indemnify and hold harmless healdesk and its officers, ` +
          `contractors and subcontractors against every claim, loss, liability, penalty, fine, ` +
          `cost and expense, to the extent it arises from or relates to:`,
      ) +
      "\n\n" +
      [
        `a. the Services, or Practice's use of them;`,
        `b. the patient information Practice or its patients give the Services;`,
        `c. the calls and messages the assistant handles for Practice;`,
        `d. Practice's covered-entity status;`,
        `e. instructions Practice gave healdesk;`,
        `f. Practice's responsibilities in sections 8 and 9 of the Terms;`,
        `g. Practice's own breach of this agreement, or its violation of HIPAA or of any state ` +
          `privacy, consumer-health-privacy or breach-notification law; or`,
        `h. a claim by a patient, a regulator or any other third party.`,
      ]
        .map(item)
        .join("\n") +
      "\n\n" +
      wrap(
        `The costs covered include reasonable legal fees, the cost of defending a claim, and the ` +
          `cost of investigating a security incident and of notifying patients, regulators, the ` +
          `media and anyone else about a breach. This indemnity applies to the fullest extent the ` +
          `law allows, including where the claim alleges negligence on healdesk's part, and ` +
          `neither the exclusion nor the limit above applies to it. The defence of a claim is ` +
          `conducted as the last paragraph of section 14 of the Terms provides. healdesk gives ` +
          `Practice no indemnity.`,
      ) +
      "\n\n" +
      wrap(
        `This clause allocates cost between the parties. It does not change what each party owes ` +
          `a regulator directly under HIPAA. Nothing in it relieves healdesk of a civil money ` +
          `penalty a regulator imposes on healdesk itself, which no contract can shift, and ` +
          `Practice's own duty under 45 CFR 164.404 to notify its patients remains Practice's.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk does not carry liability insurance, and its own suppliers cap their liability ` +
          `to healdesk at figures far below what a breach can cost. Practice should size its own ` +
          `cover accordingly.`,
      ),
  },

  {
    id: "records-to-hhs",
    heading: "Availability of records",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will make its internal practices, books and records relating to the use and ` +
          `disclosure of PHI available to the Secretary of Health and Human Services for the ` +
          `purpose of determining compliance.`,
      ),
  },

  /**
   * Notices: email to healdesk is enough, and the Delaware mailbox is a
   * mailing address only, never the party's address (ICD-18, PT-19); Practice
   * has one notice address, its account's (ICD-31, PT-15). The courts in
   * Delaware have exclusive jurisdiction, as in Terms §17. A clause named by
   * words from its heading resolves to the clause whose heading contains them
   * (ICD-22). A change-in-law termination ends the Services, and the Term
   * clause then applies (ICD-30). An accepted calendar election is part of
   * the entire agreement (ICD-26).
   */
  {
    id: "notices-and-law",
    heading: "Notices, governing law, and interpretation",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Notices under this agreement are in writing. Notices to healdesk go by email to ` +
          `${NOTICES_EMAIL}, which is enough on its own. A copy may also be posted to healdesk's ` +
          `US mailing address for correspondence: ${US_MAILING_ADDRESS}. That mailing address is ` +
          `not a place of business, a registered office or an address for service of process. ` +
          `Notices to Practice go by email to Practice's notice address. That is the email ` +
          `address on Practice's healdesk account, or the signatory's email address above until ` +
          `that account exists, unless Practice has given healdesk another address for notices in ` +
          `writing. A notice is effective when delivered. Breach reports may also be given to ` +
          `Practice by telephone, but the written notice is the notice.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement is governed by the laws of the State of ${GOVERNING_STATE} and by HIPAA, ` +
          `without regard to conflict-of-laws rules. The state and federal courts located in ` +
          `${GOVERNING_STATE} have exclusive jurisdiction over any dispute about it, and the parties ` +
          `submit to those courts. Any ambiguity is resolved in favour of a meaning that permits ` +
          `compliance with HIPAA. A clause named in this agreement by words from its heading, such ` +
          `as "the Term clause", is the numbered clause whose heading contains those words. A ` +
          `reference to a section of HIPAA or of a regulation means that section as amended. If a ` +
          `change in law requires a change to this agreement, the parties will agree it in good ` +
          `faith within thirty days of either asking. If they do not, either party may terminate ` +
          `this agreement, and with it the Services, by written notice, and the Term clause then ` +
          `applies as it does to any other termination. If any provision is unenforceable the rest ` +
          `stands.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement (with any calendar election accepted under it), the Terms and the order ` +
          `Practice placed are the entire agreement between ${v.clinicLegalName} and ${ENTITY} ` +
          `about patient information. This agreement replaces any earlier version of it between ` +
          `them from the effective date forward, and patient information healdesk already holds ` +
          `is governed by this version from that date.`,
      ),
  },
];

/**
 * The 1.3.0 preamble. The opening paragraph and both party lines go through
 * wrap(), so the plain-text copy stays inside 78 columns however long the
 * practice's name or its specialty's. The specialty is the catalogue's display
 * name, as buildBaaSelections passes it, never lower-cased: "a practice in the
 * field of Weight Loss & GLP-1", where 1.2.1 printed "a weight loss & glp-1
 * practice". healdesk's line gives its registered address, never the
 * Delaware mailbox (ICD-18, PT-19).
 */
function preamble130(v: BaaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  return [
    `HEALDESK BUSINESS ASSOCIATE AGREEMENT`,
    `Version 1.3.0 — executed electronically`,
    ``,
    wrap(
      `This agreement is entered into under 45 CFR 164.502(e) and 164.504(e) and takes effect on ` +
        `the date below. It governs the patient information that healdesk creates, receives, ` +
        `maintains or transmits for Practice in the course of the Services, as the ` +
        `${HEADINGS_1_3.definitions} clause defines those terms.`,
      "",
      "",
    ),
    ``,
    `BETWEEN`,
    wrap(
      `${v.clinicLegalName} ("Practice"), a practice in the field of ${v.specialty}`,
      "  ",
      "    ",
    ),
    wrap(
      `${ENTITY} ("healdesk"), ${ENTITY_FORM}, whose registered address is ${REGISTERED_ADDRESS}`,
      "  ",
      "    ",
    ),
    ``,
    `SIGNED FOR PRACTICE BY`,
    `  ${v.signatoryName}${title}`,
    `  ${v.signatoryEmail}`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

/**
 * 1.3.0's render guard. Verified reporting is the phase-two read-back, which
 * this version does not describe (HRC-17, ICD-35): refused before anything
 * else. The clause predicates default a missing answer to the most
 * restrictive one, which is right for a predicate and wrong for a signature:
 * a practice that was never asked would sign "manual booking, no agreement
 * with Google" without having said either. So both answers are required, and
 * `connectedPlatform` must be exactly the name the booking system renders as
 * (null for Google Calendar alone, something else, or none), which
 * buildBaaSelections always produces.
 */
function validate130(v: BaaVariables): void {
  if (v.attributionMode !== "estimated") {
    throw new BaaRenderError(
      "Version 1.3.0 has no verified-reporting clause: verified reporting is phase two and is not offered in v1.",
    );
  }
  if (!isBookingSystemId(v.bookingSystem)) {
    throw new BaaRenderError(
      `Version 1.3.0 needs the practice's booking system; got ${JSON.stringify(v.bookingSystem ?? null)}.`,
    );
  }
  if (!isCalendarAccount(v.calendarAccount)) {
    throw new BaaRenderError(
      `Version 1.3.0 needs the kind of Google account that holds the calendar; got ${JSON.stringify(v.calendarAccount ?? null)}.`,
    );
  }
  const named = bookingSystemName(v.bookingSystem);
  if ((v.connectedPlatform ?? null) !== named) {
    throw new BaaRenderError(
      `The agreement must name the practice's booking system as ${JSON.stringify(named)}, not ${JSON.stringify(v.connectedPlatform ?? null)}.`,
    );
  }
}

export const BAA_TEMPLATES: readonly BaaTemplate[] = [
  // Newest RELEASED first — CURRENT_BAA_VERSION and currentBaaTemplate() both
  // read [0], so a version stays at [0] until its successor is approved for
  // release too.
  {
    version: "1.2.1",
    publishedOn: "2026-10-01",
    // Approved for release by the owner on 2026-10-01, on the owner's own
    // review and without external counsel, after the adversarial review of
    // 1.2.0 the same day. The field's doc comment on BaaTemplate says what
    // the flag means; this is the entry it describes.
    approvedByCounsel: true,
    preamble: preamble121,
    clauses: CLAUSES_1_2_1,
  },
  // ⚖️ Drafted on 2026-10-06; not released, so not at [0], and signing
  // refuses it, taking only [0] or a released version inside its
  // overlap. Provisioning's approval gate reads [0] too, not the bound
  // acceptance's version, until plan C15, which must land before the
  // release. Released by the owner after an audit of the full text (plan
  // C19): it then moves to [0] with a release date, and 1.2.1 stays signable
  // until the deadline in BAA_RELEASE_OVERLAP, unless the release raises
  // MIN_ACCEPTABLE_BAA_VERSION past it.
  {
    version: "1.3.0",
    publishedOn: "2026-10-06",
    approvedByCounsel: false,
    preamble: preamble130,
    clauses: CLAUSES_1_3,
    validate: validate130,
  },
  // Offered for part of 1 October 2026, then replaced by 1.2.1 for the five
  // accuracy fixes listed above it. Retained and frozen: anything signed
  // against it must keep reproducing. Not at [0], so never offered again.
  {
    version: "1.2.0",
    publishedOn: "2026-10-01",
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
 * The oldest agreement a clinic may go live under
 * (docs/counsel/agreement-changes.md §10, decided 3 October 2026).
 *
 * Go-live refuses an account whose agreement in effect is older than this,
 * and the ops console says so on the clinic's card. A floor, not "the
 * current version only": whether a revised text needs fresh assent is a
 * judgement made at each release, and a floor makes it a constant raised on
 * purpose rather than a side effect of publishing.
 *
 * 1.2.1, the version being signed, while 1.3.0 is a draft. It refuses 1.0.0,
 * 1.2.0 and every unreleased draft. Whether releasing 1.3.0 raises it is part
 * of that release (plan C19): 1.3.0 is the first version with the Payments
 * clause and the clause for a practice that is not a covered entity.
 *
 * At each release: decide whether the new version raises the floor, and add
 * every acceptable version to app_baa_version_acceptable() in a migration.
 * Go-live refuses any version that SQL list leaves out, and the parity test
 * in apps/app/tests/database-audit.test.ts fails until the two agree.
 */
export const MIN_ACCEPTABLE_BAA_VERSION = "1.2.1";

/**
 * Whether a clinic may go live under an agreement of this version: the
 * template is registered, approved for release, and no older than
 * MIN_ACCEPTABLE_BAA_VERSION. "Older" is position in BAA_TEMPLATES, which is
 * ordered newest released first, with a draft after the release it follows;
 * publishedOn cannot decide it, because 1.2.0 and 1.2.1 share a date. A draft
 * is never acceptable, wherever it sits: it is not approved for release.
 */
export function isBaaVersionAcceptable(version: string): boolean {
  const at = BAA_TEMPLATES.findIndex((t) => t.version === version);
  const floor = BAA_TEMPLATES.findIndex((t) => t.version === MIN_ACCEPTABLE_BAA_VERSION);
  return at !== -1 && floor !== -1 && at <= floor && BAA_TEMPLATES[at]!.approvedByCounsel;
}

/**
 * The calendar clause ids of 1.3.0. An acceptance whose `appliedClauses`
 * holds one of them carries calendar terms for the location provisioned
 * against it; one that holds none (every earlier version) leaves the location
 * to its first calendar election.
 */
export const CALENDAR_CLAUSE_IDS_1_3: readonly CalendarClauseId[] = [
  CALENDAR_CLAUSE_IDS.covered,
  CALENDAR_CLAUSE_IDS.uncovered,
  CALENDAR_CLAUSE_IDS.not_used,
];

/**
 * Whether a template asks the two calendar questions: the booking system and
 * the kind of Google account. True exactly when it registers a calendar
 * clause that depends on them, so the signing screens ask the questions
 * only for a document that reads the answers, and buildBaaSelections passes
 * them only to one.
 */
export function templateReadsCalendarAccount(template: BaaTemplate): boolean {
  return template.clauses.some((clause) =>
    (CALENDAR_CLAUSE_IDS_1_3 as readonly string[]).includes(clause.id),
  );
}

/**
 * Versions that stay signable for a short while after their successor is
 * released, mapped to the ISO time they stop. A release reaches apps/app and
 * apps/web in two deploys, and a buyer who loaded the agreement before the
 * second one would otherwise be refused mid-checkout. Empty until 1.3.0 is
 * released: the release (plan C19) sets 1.2.1 to the release time plus 72
 * hours, unless it raises MIN_ACCEPTABLE_BAA_VERSION past 1.2.1. Then 1.2.1
 * is not listed, because a buyer could sign it and then be refused at
 * go-live, and the go-live floor test in apps/app/tests/agreements.test.ts
 * fails while any version listed here is below the floor. Plan C20 empties
 * it once both production deployments are verified. apps/app's signing
 * reads it (signableTemplate in apps/app/src/lib/agreements.ts): a version
 * listed here signs only if it was released, and only before its deadline,
 * which must be an ISO 8601 instant with its own offset, such as
 * "2026-10-12T12:00:00Z". A deadline in any other form closes the window.
 */
export const BAA_RELEASE_OVERLAP: Readonly<Record<string, string>> = {};

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
  // The version's own guard first: a selection the version cannot do
  // without is a refusal, never a clause chosen on a default.
  template.validate?.(variables);

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
