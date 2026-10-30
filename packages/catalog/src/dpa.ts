import { createHash } from "node:crypto";

import {
  AGREEMENT_PARTY,
  BACKUP_RETENTION_DAYS,
  NO_CALL_AUDIO_KEPT,
  PAYMENTS_CLAUSE_BODY,
  PAYMENTS_CLAUSE_HEADING,
  STATE_LAW_CLAUSE_HEADING,
  TRANSCRIPT_RETENTION_DAYS,
  VOICE_PROVIDER_RETENTION,
  stateLawClauseBody160,
} from "./baa";
import {
  bookingSyncFor,
  bookingSystemName,
  isBookingSystemId,
  type BookingSystemId,
} from "./booking-systems";
import {
  CALENDAR_CLAUSE_HEADING,
  CALENDAR_CLAUSE_IDS,
  CALENDAR_EVENT_FALLBACK_NAME,
  CALENDAR_LOCATION_PARAGRAPH,
  calendarTermsKind,
  isCalendarAccount,
  selectCalendarClause,
  type CalendarAccount,
  type CalendarTermsKind,
} from "./calendar-terms";
import { MODEL_RETENTION_AGREEMENT } from "./model-retention";
import { isSpecialtyId, regimeFor, type SpecialtyId } from "./specialties";
import { subprocessorNoticeClauseBody } from "./subprocessor-notice";
import { wrap } from "./wrap";

/**
 * The healdesk Data Protection Agreement: the paper a practice HIPAA does not
 * cover signs instead of the business associate agreement (plan Part L; the
 * v1 spec, "Who is what").
 *
 * Two kinds of practice sign it, and `agreementKindFor` (agreement-kind.ts)
 * decides which paper anyone signs:
 *
 *   - a veterinary practice, whose patients are animals and so outside HIPAA
 *     altogether (45 CFR 160.103 protects information about individuals);
 *   - a practice whose specialty HIPAA reaches only if it is a covered entity
 *     (med spas, hair restoration, massage and chiropractic) and which
 *     answered "No" to billing any health insurance electronically.
 *
 * A practice that is not sure signs the BAA, and so does every specialty HIPAA
 * always reaches. A business associate agreement sent to either kind above
 * would name duties neither side has; this one carries the terms state law
 * asks of a processor, and holds healdesk to the safeguards it uses for
 * protected health information, because the v1 spec says a DPA practice's
 * client data is controlled exactly as PHI.
 *
 * ## Built like the BAA, assembled separately
 *
 * A template is a preamble and a library of clauses, each with a pure, total
 * predicate, assembled in a fixed order and numbered, exactly as baa.ts does
 * it, and for the same reason: the variant set is finite and can be read in
 * full (docs/dpa-v1.0.0.txt). It is a parallel assembler rather than a
 * shared one so that nothing here can move a BAA golden hash; what the two
 * documents share is quoted from one place:
 *
 *   - the state-law processor clause is `stateLawClauseBody160` in this
 *     document's words (subject "Client Information"): the fuller clause BAA
 *     1.3.0 carries, with BAA 1.4.0's two transcript sentences (emailed to
 *     Practice, not kept; 13 October 2026) and BAA 1.6.0's two exceptions to
 *     deletion (what the Subcontractors clause says a subcontractor may keep,
 *     for the periods it states, where 1.4.0's named "abuse detection and
 *     security", a purpose Anthropic does not state; 19 October 2026), as the funnel and the BAA's pre-release redraft agreed on
 *     6 October 2026, with no PHI and no patient in it, this document's
 *     headings for the clauses it names, the CMIA sentence, and its calendar
 *     purposes and data following the booking sync. The Payments clause is
 *     baa.ts's constant, word for word. Neither is retyped;
 *   - the calendar clause is chosen by `selectCalendarClause`, from the
 *     booking system and the kind of Google account, exactly as BAA 1.3.0
 *     chooses it, and carries the selector's sentences with the person a
 *     booking is for called a client (`CALENDAR_PERSON_NOUNS`), except the
 *     word the event itself carries, quoted as the event writes it, then the
 *     location paragraph, as 1.3.0 does;
 *   - the subcontractor list on request and the notice of a new
 *     subcontractor are subprocessor-notice.ts's sentence, 24 hours by email
 *     with the right to object (owner, 6 October 2026), the list on written
 *     request rather than at a URL (owner, 9 October 2026), and "without
 *     penalty" in it has the effect BAA 1.3.0 gives it, in this document's
 *     Term, Liability and Definitions clauses;
 *   - the incident and breach notice is 1.3.0's one rule, without
 *     unreasonable delay and in no case later than 60 calendar days after
 *     discovery for all three (the spec's wording; owner, 9 October 2026),
 *     and "calendar election" is defined as 1.3.0's clause 1 defines it; the
 *     election form that names this agreement is dpa-calendar-election.ts,
 *     built from calendar-terms.ts's pieces;
 *   - Anthropic's retention is MODEL_RETENTION_AGREEMENT
 *     (model-retention.ts), the sentences BAA 1.6.0's Subcontractors clause
 *     states, word for word: no more than the 30 days of its standard
 *     retention, the only retention under which Anthropic offers its service
 *     under a business associate agreement, two years for flagged content
 *     alone, the law's own period for what the law requires, and no training
 *     without healdesk's permission. Until 19 October 2026 it was 1.2.1's
 *     sentence, which gave law-required content two years, the 30 days a
 *     purpose and the service "cannot run with shorter retention", none of
 *     which Anthropic says of the models the product calls
 *     (agreement-changes.md §17), and said Anthropic's agreement was in
 *     place; it is now, as in the BAA, signed before any client's
 *     information reaches Anthropic. The DPA was unreleased, so it was
 *     corrected in place and its hashes regenerated;
 *   - the party, its notice address and Delaware law are `AGREEMENT_PARTY`,
 *     as BAA 1.2.2 prints them: hello@healdesk.io is the notice email.
 *
 * ## What it deliberately does not vary on
 *
 * Plan, price, channels, retention and the practice's state are not
 * variables (plan Part L, "Customisable"). The variables are the legal name,
 * the signatory, the date, the specialty (which gives the legal descriptor
 * and the status clause) and the two calendar answers. A document that moved
 * with the package bought would invite the argument that its obligations are
 * negotiable by tier.
 *
 * ## Every sentence true on the day it is signed
 *
 * The Term clause is written from the offboarding clock in apps/app
 * (`DESTROY_AFTER_DAYS`, `DESTROY_WITHOUT_EXPORT_AFTER_DAYS` and
 * `dueForDestruction` in lib/offboarding/offboarding.ts, run by the
 * `offboarding-destroy` job), not from the BAA's "within thirty days", which
 * the code does not keep when the export has not been delivered. Since 7
 * October 2026 that job runs every hour and destroys a day before each limit
 * the clause states, so the clause's "once a day" and "at the first run once"
 * give the latest it destroys; the text is left as it is. The
 * deletion residue it names is what `destroyClinicData` and `eraseContact`
 * leave. docs/counsel/dpa.md lists every fact the text rests on and the file
 * it was read from.
 *
 * ## Released by the owner, never by default
 *
 * `approvedByCounsel` is the BAA's flag under the BAA's name: the owner's
 * release. While it was false nothing could sign this document:
 * `agreementKindFor` fell back to the BAA for "No" and refused a veterinary
 * practice (agreement-kind.ts reads this flag), and provisioning refused an
 * account bound to an unreleased DPA. The owner released dpa/1.0.0 on 20
 * October 2026, without external counsel; the text carried no draft marker,
 * so the release moved no hash (dpa.test.ts), and docs/dpa-v1.0.0.txt is the
 * released copy. On 21 October 2026, before it was pushed or signed by any
 * practice, the party block's label for the Delaware address changed from
 * "of" to "with a mailing address for notices and correspondence at", and the
 * golden hashes were regenerated. Later that day, on the owner's explicit
 * authorisation and with the version number unchanged, the Minimum necessary
 * clause was edited to say what the voice provider holds of a call
 * (agreement-changes.md §19), and the golden hashes were regenerated again.
 *
 * To publish a revision after release: add a new version at DPA_TEMPLATES[0],
 * never edit a released one. Someone has signed it.
 *
 * The first revision, dpa/1.1.0, was drafted on 30 October 2026 and released
 * by the owner the same day ("release DPA 1.1.0 as well", in chat), without
 * external counsel: 1.0.0 with the Safeguards clause's telephone exception
 * carrying the one optional payment-link text after a call, as BAA 1.6.0's
 * does (DPA_NO_SMS_1_1, below; agreement-changes.md §21). DPA_1_1_0_RELEASED
 * is true, so 1.1.0 is DPA_TEMPLATES[0] and 1.0.0 follows it, released and
 * never offered again. It applies to new signers only: a practice that signed
 * 1.0.0 stays on 1.0.0, since nothing in the product lets it re-sign a newer
 * DPA, and no payment-link text may go to a caller of a practice whose
 * accepted agreement is older than the one that carries the exception.
 */

export type DpaVariables = {
  /** The practice's legal name, as it will appear in the agreement. */
  clinicLegalName: string;
  /** Typed by the signer. This is the signature. */
  signatoryName: string;
  signatoryTitle?: string;
  /** The practice's one address: its sign-in, billing and the agreement's notice address. */
  signatoryEmail: string;
  /** ISO date. The day they signed, not the day the template was published. */
  effectiveDate: string;
  /**
   * The specialty id (specialties.ts), never its display name. Its regime
   * chooses the status clause, and `DPA_PRACTICE_DESCRIPTORS` gives the words
   * the preamble describes the practice with.
   */
  specialty: SpecialtyId;
  /** The answer to "Where do bookings live today?" (booking-systems.ts). */
  bookingSystem: BookingSystemId;
  /** The kind of Google account that holds the calendar (calendar-terms.ts). */
  calendarAccount: CalendarAccount;
};

export type DpaClause = {
  /** Stable id, recorded with the acceptance so the variant is reproducible. */
  id: string;
  heading: string;
  /** Pure and total: no I/O, no randomness, no throwing, whatever it is given. */
  appliesWhen: (v: DpaVariables) => boolean;
  body: (v: DpaVariables) => string;
};

export type DpaTemplate = {
  /** Namespaced, so a stored acceptance says which kind it is: "dpa/1.0.0". */
  version: string;
  /** When this template version was published. Not when anyone signed it. */
  publishedOn: string;
  /**
   * Released for signing by the owner, who takes responsibility for the text:
   * the flag and the name the BAA templates use (baa.ts). Nothing offers or
   * provisions a DPA whose flag is false.
   */
  approvedByCounsel: boolean;
  preamble: (v: DpaVariables) => string;
  clauses: readonly DpaClause[];
  /** The render guard: refuses variables no honest document of this version can be built from. */
  validate: (v: DpaVariables) => void;
};

export class DpaRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DpaRenderError";
  }
}

/**
 * How the preamble describes each practice, keyed by every specialty so a new
 * one cannot be added without deciding whether it may sign this document. Null
 * for a specialty HIPAA always reaches: it signs the BAA, and the render guard
 * refuses it here.
 */
export const DPA_PRACTICE_DESCRIPTORS: Readonly<Record<SpecialtyId, string | null>> = {
  "med-spa": "a medical spa, dermatology or aesthetics practice",
  "plastic-surgery": null,
  fertility: null,
  dental: null,
  glp1: null,
  "hair-restoration": "a hair restoration practice",
  veterinary: "a veterinary practice or pet spa",
  "massage-chiro": "a massage or chiropractic practice",
};

const {
  entity: ENTITY,
  entityForm: ENTITY_FORM,
  noticeAddress: NOTICE_ADDRESS,
  governingState: GOVERNING_STATE,
} = AGREEMENT_PARTY;

const ALWAYS = () => true;

/**
 * A veterinary practice, read from the specialty's regime rather than its id
 * (as audienceFor does), so a second animal specialty needs no change here.
 * Total: an unknown specialty is simply not one.
 */
export function isVeterinaryPractice(v: Pick<DpaVariables, "specialty">): boolean {
  return isSpecialtyId(v?.specialty) && regimeFor(v.specialty) === "non-hipaa";
}

/** The calendar terms kind, derived as BAA 1.3.0 derives it, defaulting a missing account to the most restrictive. */
function calendarKindOf(v: DpaVariables): CalendarTermsKind {
  const account: CalendarAccount = isCalendarAccount(v?.calendarAccount)
    ? v.calendarAccount
    : "workspace_no_baa";
  return calendarTermsKind(bookingSyncFor(v?.bookingSystem), account);
}

// -----------------------------------------------------------------------------
// What the DPA quotes, and the edits it makes to it
// -----------------------------------------------------------------------------

/**
 * The calendar selector's words for the person a booking is for, and this
 * document's. The selector's clauses say "patient" in exactly these places
 * (the WRITES sentence of calendar-terms.ts, as the BAA's pre-release audit
 * of 6 October 2026 left it), and a veterinary practice's agreement must never
 * call a person a patient. In this document everyone who contacts Practice is
 * a client, so the person booking "may not be the client the appointment is
 * for" where the BAA says "may not be the patient".
 */
export const CALENDAR_PERSON_NOUNS: readonly (readonly [string, string])[] = [
  ["about the patient", "about the client"],
  ["who may not be the patient", "who may not be the client the appointment is for"],
];

/**
 * The one "Patient" the calendar clause keeps: the word the event itself
 * carries when the first name given cannot be used, quoted. event.ts writes
 * it for every practice, so a DPA that printed anything else there would
 * misdescribe the event healdesk writes; quoting it calls no person a patient.
 */
export const CALENDAR_EVENT_FALLBACK_QUOTED = `"${CALENDAR_EVENT_FALLBACK_NAME}"`;

/**
 * The calendar clause in this document's words, without the location
 * paragraph: the selector's body, paragraph by paragraph, with the person
 * nouns replaced and the paragraph wrapped again. Refuses rather than prints
 * "patient" if the selector's wording ever moves, the quoted event word
 * apart. The DPA's own clause appends the location paragraph; the calendar
 * election that names this agreement (dpa-calendar-election.ts) carries the
 * clause without it, as the BAA's election carries the BAA's.
 */
export function dpaCalendarClauseBody(input: {
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
}): string {
  const selected = selectCalendarClause({
    bookingSystem: input.bookingSystem,
    calendarAccount: input.calendarAccount,
  });
  return selected.body
    .split("\n\n")
    .map((paragraph) => {
      let text = paragraph.replace(/\s+/g, " ").trim();
      for (const [from, to] of CALENDAR_PERSON_NOUNS) text = text.split(from).join(to);
      if (/\bpatients?\b/i.test(text.split(CALENDAR_EVENT_FALLBACK_QUOTED).join(""))) {
        throw new DpaRenderError(
          `The calendar clause ${selected.clauseId} says "patient" where the DPA says "client"; extend CALENDAR_PERSON_NOUNS.`,
        );
      }
      return wrap(text);
    })
    .join("\n\n");
}

/** The DPA's calendar clause: the clause in its words, then BAA 1.3.0's location paragraph. */
function dpaCalendarBody(v: DpaVariables): string {
  return [
    dpaCalendarClauseBody({ bookingSystem: v.bookingSystem, calendarAccount: v.calendarAccount }),
    wrap(CALENDAR_LOCATION_PARAGRAPH),
  ].join("\n\n");
}

// -----------------------------------------------------------------------------
// The clause library, version 1.0.0
// -----------------------------------------------------------------------------

const STATE_LAW_AND_PROTECTION =
  "healdesk nonetheless protects Client Information under this agreement with the safeguards " +
  "it uses for protected health information. State privacy, consumer-health and " +
  "breach-notification laws may apply to Client Information and to both parties, and in some " +
  "states carry a private right of action.";

const CLAUSES_1_0: readonly DpaClause[] = [
  {
    id: "definitions",
    heading: "Definitions",
    appliesWhen: ALWAYS,
    body: (v) => {
      const vet = isVeterinaryPractice(v);
      return (
        wrap(
          `"Practice" means ${v.clinicLegalName}. "healdesk" means ${ENTITY}, ${ENTITY_FORM}. ` +
            `"Terms" means the healdesk Terms of Service at healdesk.io/terms as in force on the ` +
            `effective date. "Services" and "Fees" have the meanings the Terms give them.`,
        ) +
        "\n\n" +
        wrap(
          (vet
            ? `A "client" is a person who contacts Practice through the Services, or about whom ` +
              `Practice gives healdesk information, in the course of seeking or receiving ` +
              `Practice's services for an animal in their care: the animal's owner or keeper. An ` +
              `animal is never a client. `
            : `A "client" is a person who contacts Practice through the Services, or about whom ` +
              `Practice gives healdesk information, in the course of seeking or receiving ` +
              `Practice's services. `) +
            `"Client Information" means any information about a client that healdesk creates, ` +
            `receives, maintains or transmits for Practice in the course of the Services, ` +
            `including what a client says in a call or message` +
            (vet ? `, and what they say about an animal in their care.` : `.`),
        ) +
        "\n\n" +
        wrap(
          `"HIPAA" means the Health Insurance Portability and Accountability Act of 1996 and its ` +
            `regulations at 45 CFR Parts 160 and 164, and "covered entity" and "protected health ` +
            `information" have the meanings those regulations give them. A "security incident" ` +
            `is the attempted or successful unauthorised access to, or use, disclosure, ` +
            `modification or destruction of, Client Information, or interference with the ` +
            `systems that hold it. A "breach" is the unauthorised acquisition of, or access to, ` +
            `Client Information that compromises its security, confidentiality or integrity, and ` +
            `also includes anything an applicable state breach-notification law treats as a breach ` +
            `of the security of Client Information. "Calendar election" means the document, in the ` +
            `form healdesk provides, by which Practice sets the Google Calendar terms for one ` +
            `location, accepted for Practice by a person with authority to bind it. Once accepted, ` +
            `it forms part of this agreement. "Business day" means a day other than a Saturday, ` +
            `Sunday or United States federal holiday.`,
        ) +
        "\n\n" +
        wrap(
          `This agreement governs Client Information. Where this agreement and the Terms ` +
            `conflict about Client Information, or about terminating this agreement and what then ` +
            `happens to the Services and the Fees, this agreement governs.`,
        )
      );
    },
  },

  /**
   * One status clause, two variants, exactly one of which renders. The
   * veterinary variant states a fact about the law; the other records the
   * practice's own warranty, the duty to say when it changes, and what
   * healdesk does then: pause until the BAA replaces this agreement, with
   * forwarded calls passing through to the direct line meanwhile, as the
   * Terms already provide for any pause.
   */
  {
    id: "status-veterinary",
    heading: "Practice's status",
    appliesWhen: (v) => isVeterinaryPractice(v),
    body: () =>
      wrap(
        `Practice is a veterinary practice or pet spa: it cares for animals. HIPAA ` +
          `protects health information about individuals, and an animal is not an individual ` +
          `under 45 CFR 160.103, so Practice is ` +
          `not a covered entity in respect of the animals in its care, the Client Information ` +
          `healdesk handles for it is not protected health information, and this agreement is ` +
          `not a business associate agreement.`,
      ) +
      "\n\n" +
      wrap(STATE_LAW_AND_PROTECTION),
  },
  {
    id: "status-not-covered",
    heading: "Practice's status",
    appliesWhen: (v) => !isVeterinaryPractice(v),
    body: () =>
      wrap(
        `Practice has told healdesk that it does not transmit health information ` +
          `electronically in connection with any transaction covered by HIPAA: it sends no ` +
          `claim, eligibility check, prior authorisation or claim-status enquiry electronically ` +
          `to any health plan, itself or through anyone acting for it. Practice warrants that ` +
          `this is true on the effective date. On that basis Practice is not a covered entity, ` +
          `the Client Information healdesk handles for it is not protected health information, ` +
          `and this agreement is not a business associate agreement.`,
      ) +
      "\n\n" +
      wrap(STATE_LAW_AND_PROTECTION) +
      "\n\n" +
      wrap(
        `Practice will tell healdesk in writing before it first sends any such transaction, and ` +
          `as soon as it learns that it is a covered entity for any other reason. From that ` +
          `notice, healdesk will pause the assistant for Practice until Practice signs ` +
          `healdesk's business associate agreement, which then replaces this agreement from that ` +
          `agreement's effective date. While the assistant is paused, calls Practice forwards to ` +
          `healdesk pass straight through to Practice's direct line, as the Terms provide.`,
      ),
  },

  /**
   * Reconciled with the shared state-law clause (§12.14, "The funnel's DPA"):
   * each duty is stated once, the more protective wording kept. What
   * Practice's instructions are is the shared clause's statement, which
   * bounds them by its purposes and names this agreement rather than the
   * Terms; so is Practice's covenant to make its notices and consents cover
   * the processing, a duty to act where this clause only allocated
   * responsibility. What stays here is what the shared clause does not say:
   * the unlawful-instruction notice, a client's limits and withdrawn
   * permissions, and the lawful-instruction promise, which reaches every law
   * and measures against what Practice itself may do, where the shared
   * clause's reaches the state privacy laws only.
   */
  {
    id: "instructions",
    heading: "Practice's instructions",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Practice's documented instructions to healdesk are those the clause headed ` +
          `"${STATE_LAW_CLAUSE_HEADING}" describes. healdesk will tell Practice if it believes an ` +
          `instruction would break a law that applies to Client Information, and need not follow ` +
          `that instruction.`,
      ) +
      "\n\n" +
      wrap(
        `Practice will tell healdesk, promptly and in writing, of any limit it has agreed with a ` +
          `client, and of any permission a client has withdrawn, that affects how healdesk may ` +
          `use or disclose that client's information. Practice will not ask healdesk to use or ` +
          `disclose Client Information in a way the law would not permit Practice itself to.`,
      ),
  },

  {
    id: "permitted-uses",
    heading: "What healdesk may do with Client Information",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk may use and disclose Client Information only as necessary to provide the ` +
          `Services to Practice, to keep them secure, and as required by law. It may not use or ` +
          `disclose it in any way that Practice could not.`,
      ),
  },

  // BAA 1.6.0's state-law clause, in this document's words (the subject
  // chooses them), its calendar text following the booking sync as there:
  // 1.3.0's but for purpose e and the data involved, which since 13 October
  // 2026 say that a transcript is emailed to Practice rather than kept, and
  // for the two exceptions to deletion, which since 19 October 2026 are what
  // the Subcontractors clause says a subcontractor may keep, for the periods
  // it states, and no longer name a purpose Anthropic does not state.
  {
    id: "state-law",
    heading: STATE_LAW_CLAUSE_HEADING,
    appliesWhen: ALWAYS,
    body: (v) =>
      stateLawClauseBody160({
        subject: "Client Information",
        sync: bookingSyncFor(v.bookingSystem),
      }),
  },

  // Quoted from baa.ts, word for word.
  {
    id: "payments",
    heading: PAYMENTS_CLAUSE_HEADING,
    appliesWhen: ALWAYS,
    body: () => wrap(PAYMENTS_CLAUSE_BODY),
  },

  /**
   * BAA 1.3.0's data-sources clause in this document's words: the same
   * credentials sentence, naming the system when it has a name, and calendar
   * access only where the calendar clause, or a calendar election that takes
   * its place, grants some. A practice whose booking system reads no Google
   * Calendar connects none, but an election may later give a location one
   * (the location paragraph of the calendar clause), so the clause says so
   * rather than become untrue the day one is recorded, as 1.3.0's does.
   */
  {
    id: "data-sources",
    heading: "What healdesk reads from your systems",
    appliesWhen: ALWAYS,
    body: (v) => {
      const named = bookingSystemName(v.bookingSystem);
      return wrap(
        (named
          ? `healdesk holds no credentials to ${named}, or to any other practice-management or ` +
            `point-of-sale system, and reads nothing from them. `
          : `healdesk holds no credentials to any practice-management or point-of-sale system ` +
            `and reads nothing from one. `) +
          `The only Client Information healdesk receives is what clients themselves give it ` +
          `during a call or chat` +
          (bookingSyncFor(v.bookingSystem) === "live"
            ? `, together with the calendar access the Google Calendar clause, or a calendar ` +
              `election that takes its place, describes.`
            : `, together with the calendar access any calendar election describes.`),
      );
    },
  },

  // One of three, chosen as BAA 1.3.0 chooses: the same ids, so a location's
  // calendar terms read the same off any acceptance's applied clauses.
  ...(["covered", "uncovered", "not_used"] as const).map((kind): DpaClause => ({
    id: CALENDAR_CLAUSE_IDS[kind],
    heading: CALENDAR_CLAUSE_HEADING,
    appliesWhen: (v) => calendarKindOf(v) === kind,
    body: (v) => dpaCalendarBody(v),
  })),

  /**
   * "The same as under HIPAA": the Security Rule's safeguards, applied as if
   * Client Information were ePHI, then 1.2.1's second and third paragraphs in
   * this document's words (A4's email sentence included).
   */
  {
    id: "safeguards",
    heading: "Safeguards",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will use appropriate administrative, physical and technical safeguards to ` +
          `prevent any use or disclosure of Client Information this agreement does not permit. ` +
          `They are the safeguards it uses for protected health information: healdesk will apply ` +
          `Subpart C of 45 CFR Part 164, the HIPAA Security Rule, to Client Information as if it ` +
          `were electronic protected health information, although HIPAA does not itself apply ` +
          `to it.`,
      ) +
      "\n\n" +
      wrap(
        `Client Information is held on United States infrastructure and encrypted at rest. In ` +
          `transit it is encrypted wherever healdesk controls both ends, and healdesk will not ` +
          `transmit Client Information over a channel that cannot negotiate encryption. An email ` +
          `whose receiving server will not negotiate encryption is failed, not sent, and ` +
          `healdesk tells Practice rather than send it in the clear; the list of clients in an ` +
          `incident report travels by secure transfer, never in the email itself.`,
      ) +
      "\n\n" +
      wrap(
        `One narrow exception: a client who telephones has chosen the telephone, and a ` +
          `telephone call is not end-to-end encrypted. healdesk may answer such a call, limited ` +
          `to the minimum necessary and never including clinical detail, test results or payment ` +
          `information. healdesk places no calls and sends no SMS. This exception does not ` +
          `extend to any other channel or content.`,
      ),
  },

  /**
   * What the assistant may ask for is the booking-field catalogue
   * (booking-requirements.ts: the locked four and the five a practice may
   * switch on), stated as a ceiling, plus the animal's name and species the
   * owner allowed for a veterinary practice on 6 October 2026. Email is not
   * on it: the catalogue excludes it. Then how long healdesk keeps what it
   * holds during the term, and who receives Client Information, by category,
   * which the state-law terms ask a processor to limit.
   *
   * The periods are BAA 1.3.0 clause 11's, in this document's words, and the
   * nightly purge's (apps/app src/lib/retention/purge.ts), which runs for
   * every DPA practice whatever its switch (purgeIsPromised, release gate 9).
   * Until 12 October 2026 the DPA stated none during the term (dpa.md, gap
   * 2) while its practices were purged at 90 days. Where 1.3.0 said
   * "Practice may shorten these periods in its portal", this said what the
   * portal did: its Settings shortened transcripts, to 30 or 7 days, and no
   * other period.
   *
   * Since 13 October 2026 healdesk keeps no transcript (the owner's decision
   * of that day; BAA 1.4.0 clause 11 says the same in its own words): when a
   * call or a website chat ends its transcript is emailed to Practice's one
   * address, one sealed copy waits in the outbox until SES has accepted the
   * email and for seven days after (or seven days after it was queued if it
   * never went), and then the email is Practice's record (apps/app
   * lib/conversations/transcript-outbox.ts, drizzle/0069). So the period here
   * is the conversation's record without its words, and the sentence letting
   * Practice shorten the period for transcripts is gone with the portal
   * setting it described. Edited in place, the DPA being unreleased; its
   * golden hashes and docs/dpa-v1.0.0.txt moved with it.
   *
   * Since 14 October 2026 the copy goes the moment delivery is confirmed (the
   * owner's decision of that day; BAA 1.5.0 clause 11 says the same in its own
   * words): it is held only until Practice's mail server confirms it has the
   * email, kept and sent again after a failure or a return until it is
   * delivered, deleted 72 hours after its last sending when neither delivery
   * nor failure is ever confirmed, and never held more than 30 days after it
   * was queued; a record of each transcript's delivery stays, without its
   * words, with the conversation's record (drizzle/0072). Edited in place
   * again, the goldens and docs/dpa-v1.0.0.txt with it.
   *
   * ⚖️ On 21 October 2026, after the release, edited in place once more on
   * the owner's explicit authorisation for this change alone, with the version
   * number unchanged (agreement-changes.md §19): "No call audio is kept at
   * all." became NO_CALL_AUDIO_KEPT, and the transcript paragraph gained
   * VOICE_PROVIDER_RETENTION after the Anthropic sentence, both baa.ts's
   * constants, as BAA 1.5.1 and 1.6.0 say them. The voice provider (Retell)
   * holds a call's transcript and recording until healdesk has its own copy,
   * then deletes them at healdesk's request, with its own one-day retention as
   * the backstop. Golden hashes and docs/dpa-v1.0.0.txt regenerated; counsel
   * has not reviewed it.
   */
  {
    id: "minimum-necessary",
    heading: "Minimum necessary, and who receives Client Information",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Each party will limit its use, disclosure and requests of Client Information to the ` +
          `minimum necessary to accomplish the purpose.`,
      ) +
      "\n\n" +
      wrap(
        `The assistant asks a client for no more than Practice's front desk needs to place a ` +
          `booking: a name, a telephone number, the service asked about, the times that suit ` +
          `them, whether they have been to Practice before, whether the visit is a consultation ` +
          `or a treatment, ` +
          (isVeterinaryPractice(v)
            ? `any practitioner they prefer, and the name and species of the animal. `
            : `and any practitioner they prefer. `) +
          `It does not ask for a history, a medication or a diagnosis, and it never takes a card ` +
          `number. On every channel its opening line says that it is an AI assistant and, on a ` +
          `call, that the call is transcribed; Practice cannot switch that statement off or edit ` +
          `it out. ${NO_CALL_AUDIO_KEPT}`,
      ) +
      "\n\n" +
      wrap(
        `healdesk does not keep transcripts. When a call or a website chat ends, healdesk emails ` +
          `its transcript to the email address on Practice's healdesk account, and to no other ` +
          `address, only over an encrypted connection, as the Safeguards clause provides. So that ` +
          `an email that fails or is returned can be sent again, healdesk holds one encrypted copy ` +
          `of the transcript only until Practice's mail server confirms that it has received the ` +
          `email, and then deletes the copy at once. If a send fails or the email is returned, ` +
          `healdesk keeps the copy and sends the email again until it is delivered. If the email ` +
          `is accepted for delivery but neither its delivery nor its failure is confirmed within ` +
          `72 hours of its last sending, healdesk deletes the copy then. In no case does healdesk ` +
          `hold the copy for more than 30 days after the transcript was queued for sending: a copy ` +
          `whose email has not been delivered by then is deleted. While it holds the copy, ` +
          `healdesk may also send the email again when Practice asks. healdesk keeps a record of ` +
          `each transcript's delivery, without what was said or written in it, for as long as it ` +
          `keeps the record of that conversation. It keeps no other copy of a transcript, apart ` +
          `from the backups described below; what Anthropic keeps is what the Subcontractors ` +
          `clause describes. ${VOICE_PROVIDER_RETENTION} Once healdesk's copy is deleted, the ` +
          `email is Practice's own record of what was said, and Practice is responsible for ` +
          `keeping, protecting and deleting it.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk keeps the record of each conversation, without what was said or written in it, ` +
          `for ${TRANSCRIPT_RETENTION_DAYS} days after it took place, and each appointment record ` +
          `for ${TRANSCRIPT_RETENTION_DAYS} days after the appointment's time. It keeps each ` +
          `booking request for ${TRANSCRIPT_RETENTION_DAYS} days after the latest of when it was ` +
          `made, the time it was confirmed for and its appointment's time. A client's contact ` +
          `details are kept while any conversation, appointment record or booking request of ` +
          `theirs is kept, and in any case until ${TRANSCRIPT_RETENTION_DAYS} days after the last ` +
          `time those details were recorded or changed. A backup copy of anything healdesk ` +
          `deletes expires within ${BACKUP_RETENTION_DAYS} days of the deletion. The clause headed ` +
          `"Term, termination, and what happens to the information" governs what is held after ` +
          `the Services end.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk discloses Client Information only to: Practice itself; healdesk's ` +
          `subcontractors, under the Subcontractors clause; the systems Practice connects and ` +
          `controls, which are its calendar, as the Google Calendar clause or a calendar election ` +
          `describes, its payment processor, as the Payments clause describes, and the messaging ` +
          `accounts Practice connects with Meta, in a conversation a client started there; and ` +
          `anyone to whom the law requires healdesk to disclose it, after telling Practice where ` +
          `the law allows. It discloses Client Information to no one else.`,
      ),
  },

  /**
   * 1.2.1's three paragraphs in this document's words: the flow-down, the
   * model provider with BAA 1.6.0's retention sentences (MODEL_RETENTION_AGREEMENT,
   * since 19 October 2026; 1.2.1's before), and the list on request and the
   * notice, which are the shared sentence (24 hours' notice of a new
   * subcontractor). Client Information reaches Anthropic in the
   * same HIPAA-ready account as PHI does, which is why the BAA is named, and
   * since 19 October 2026 named as BAA 1.3.0 on names it: an agreement
   * "signed before any client's information reaches it", a promise about
   * when it is signed (release gate 17), never one already in force.
   */
  {
    id: "subcontractors",
    heading: "Subcontractors",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk uses subcontractors to deliver the Services — telephony, speech recognition, ` +
          `language models, hosting and email among them. healdesk will ensure that any ` +
          `subcontractor that creates, receives, maintains or transmits Client Information on ` +
          `healdesk's behalf agrees in writing, before it does so, to restrictions and conditions ` +
          `at least as protective of Client Information as those this agreement places on ` +
          `healdesk. healdesk remains answerable to Practice for its subcontractors' acts and ` +
          `omissions with Client Information.`,
      ) +
      "\n\n" +
      wrap(
        `Language models are used to understand a client and answer them during a ` +
          `conversation. healdesk's language-model provider is Anthropic, which receives the ` +
          `content of each conversation to generate the assistant's replies, in the same account ` +
          `healdesk uses for the practices HIPAA covers, only under a business associate ` +
          `agreement with healdesk signed before any client's information reaches it. ` +
          `${MODEL_RETENTION_AGREEMENT} healdesk may not use Client Information ` +
          `to train, fine-tune or evaluate any model, its own or a third party's.`,
      ) +
      "\n\n" +
      wrap(subprocessorNoticeClauseBody()),
  },

  /**
   * BAA 1.3.0's one rule for every practice, in this document's words and
   * without its HIPAA citations (agreement-changes.md §12.14, §13): notice
   * without unreasonable delay and in no case later than 60 calendar days
   * after discovery, of a use or disclosure this agreement does not permit, a
   * breach and a security incident alike, so a breach never gets a looser
   * deadline than a lesser incident. That is the product spec's wording
   * (owner, 9 October 2026), replacing the 24 hours decided on 6 October;
   * the 24 hours stays the incident console's internal target (apps/app
   * lib/incidents), unpublished. ⚖️ The 60 days alone does not meet the
   * "immediately following discovery" Cal. Civ. Code 1798.82(b) asks of a
   * business that holds data it does not own; that statute binds healdesk
   * whatever the text says, and the internal 24 hours meets it. A
   * law-enforcement delay is honoured only as the law that applies provides.
   * The notice is itself the written report, as complete as healdesk can then
   * make it and added to promptly, with what Practice needs for its own
   * notices; the shared state-law clause's item f sends a state-law breach of
   * security here, and the definition of a breach includes one.
   */
  {
    id: "incidents",
    heading: "Reporting incidents and breaches",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will notify Practice, by email to Practice's address in the Notices clause, ` +
          `of any of the following without unreasonable delay and in no case later than 60 ` +
          `calendar days after discovery:`,
      ) +
      "\n\n" +
      [
        `a. any use or disclosure of Client Information that this agreement does not permit, by ` +
          `healdesk or by a subcontractor;`,
        `b. any breach;`,
        `c. any security incident, including anything a state breach-notification law treats as ` +
          `a breach of the security of Client Information.`,
      ]
        .map((text) => wrap(text, "    ", "       "))
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
          `exercising reasonable diligence would have known of it. healdesk knows what any of its ` +
          `workforce members or agents, other than the person committing the breach, knows or by ` +
          `exercising reasonable diligence would have known. Anything else this clause covers is ` +
          `discovered when healdesk becomes aware of it.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk delays a notice only where a law enforcement official states that the notice ` +
          `would impede a criminal investigation or damage national security. It then delays it ` +
          `only for as long as the law that applies provides, and gives it as soon as that delay ` +
          `ends.`,
      ) +
      "\n\n" +
      wrap(
        `Each notice is also a written report, sent to the same address and as complete as ` +
          `healdesk can then make it, and healdesk will add to the report promptly as information ` +
          `becomes available. For a breach, the report will include, to the extent possible, what ` +
          `Practice needs for its own notices:`,
      ) +
      "\n\n" +
      [
        `· the identification of each client whose Client Information has been, or is reasonably ` +
          `believed by healdesk to have been, accessed, acquired, used or disclosed during the ` +
          `breach, sent by secure transfer as the Safeguards clause provides;`,
        `· a brief description of what happened, including the date of the breach and the date ` +
          `of its discovery;`,
        `· the types of Client Information involved;`,
        `· any steps clients should take to protect themselves from potential harm resulting ` +
          `from the breach;`,
        `· what healdesk is doing to investigate the breach, to mitigate harm to clients and to ` +
          `protect against further breaches;`,
        `· whether a law enforcement official required a notice to be delayed;`,
        `· a contact at healdesk; and`,
        `· any other available information Practice must include in a notice that a state ` +
          `breach-notification law requires of it.`,
      ]
        .map((text) => wrap(text, "  ", "    "))
        .join("\n") +
      "\n\n" +
      wrap(
        `For anything else this clause covers, the report says what happened and when, what ` +
          `information was involved, and what healdesk has done about it. Who bears the cost of ` +
          `notifying clients, regulators and anyone else about a breach is allocated by the ` +
          `Liability clause.`,
      ),
  },

  /**
   * The state-law counterpart of 1.2.1's patient-rights clause, reconciled
   * with the shared state-law clause (§12.14, "The funnel's DPA"). The help
   * with a request stays here, because it reaches every client's request to
   * see, correct or delete, where the shared clause's item b reaches requests
   * under the state privacy laws only; deletion itself is the shared
   * clause's item c, which is the more protective statement (ten business
   * days, the raw copies, backups within 35 days, subcontractors, and only a
   * record of the request), so this clause points to it rather than state a
   * second, looser deletion duty. A request made to healdesk itself is the
   * one the shared clause sends here, so it covers any request about a
   * client's information, and it is answered only in healdesk's reply: v1
   * contacts nobody first or afterwards (BAA 1.3.0, PT-24).
   *
   * A correction is BAA 1.3.0's clause 14(b) in this document's words (PT-17:
   * a correction, as a client asks for one, and no 45 CFR citation). It is
   * made in healdesk's own copy for a client's contact details, and appended
   * and linked to every other record it reaches: a booking request's facts
   * never change (the no-rewrite trigger in drizzle/0039 refuses a new
   * `treatment` or `preferred_window`), the record of a conversation is kept
   * as it was made, and an appointment is the booking as the clinic's
   * calendar holds it. Until BAA 1.3.0's release audit of 12 October 2026 it
   * named only the first two as appended, which read as if an appointment
   * were corrected in place. "Correct that information as Practice directs"
   * alone promised a change the database forbids. The amendment record (BAA
   * 1.3.0 release gate 8, apps/app drizzle/0064 and
   * lib/patient-rights/amendments.ts) is what appends and links one, both
   * exports carry it, and the desk's view of a request says it is there;
   * `amendContact` corrects a contact in place. The operator runs both from
   * apps/app's own scripts (`ops:amend-record`, `ops:amend-contact`), never
   * through the ops envelope; on the AWS host only a field cleared by contact
   * id, until the portal (M5) takes the correction's text (dpa.md, gap 22).
   *
   * The last sentence says what a deletion keeps (gate 6, 12 October 2026;
   * dpa.md, gap 15). Until then it said the client's telephone number was kept
   * as the record of the request, as `eraseContact` kept it in
   * `suppressions`. The record is now `erasure_requests` (apps/app
   * lib/patient-rights/erasure.ts): who asked, the dates, the counts and the
   * subcontractor stamps, with no number, address or name, and keyed
   * references (one-way HMACs, never the details) emptied BACKUP_RETENTION_DAYS
   * after the deletion, used only by `reapplyErasures` after a restore. It
   * says the same as item c of the shared clause, more particularly. Who
   * asked is one of three, chosen, never typed (12 October 2026), so no name
   * reaches the record or its audit row. And it says what else is kept and
   * for how long: the practice's own message asking for the deletion, which
   * names the client, kept in healdesk's mailbox for the same 35 days as the
   * fallback a restore after a total loss needs (docs/handover.md, "Deletion
   * requests" and "Restoring"), then deleted. Until then the sentence said
   * only that the record held no number, while the runbook kept the message.
   *
   * The second paragraph is BAA 1.5.0 clause 14's in this document's words
   * (owner, 13 and 14 October 2026): a transcript is held only to deliver it,
   * for as long as the Minimum necessary clause allows, and once its copy is
   * deleted healdesk has none to give, correct or delete, so Practice answers
   * from the email that carried it.
   */
  {
    id: "requests",
    heading: "Clients' requests",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `When a client asks Practice to see, correct or delete their Client Information, ` +
          `healdesk will give Practice what it needs to answer within ten business days of ` +
          `Practice asking. It will correct that information as Practice directs, and delete it ` +
          `as the clause headed "${STATE_LAW_CLAUSE_HEADING}" provides. healdesk corrects a ` +
          `client's contact details in its own copy. It does not rewrite a booking request, an ` +
          `appointment record or the record of a conversation: it appends the correction to that ` +
          `record and links the two. Every later export of that record, and every screen of ` +
          `healdesk's that shows it, then carries the correction. When a client's information is ` +
          `deleted, healdesk keeps a record of the request that holds no telephone number, email ` +
          `address or name. For the ` +
          `${BACKUP_RETENTION_DAYS} days in which a backup could still bring the information ` +
          `back, the record also holds one-way keyed references to the client's numbers, ` +
          `addresses and messaging accounts, and healdesk keeps Practice's own message asking ` +
          `for the deletion, both used only to delete the information again if a backup is ` +
          `restored; then both are removed.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk holds a transcript only to deliver it to Practice, and only for as long as the ` +
          `clause headed "Minimum necessary, and who receives Client Information" allows. Once ` +
          `the copy is deleted, healdesk has no transcript to give Practice, correct or delete: ` +
          `the email that carried it is Practice's own record, and Practice answers a request ` +
          `about a transcript from that email.`,
      ) +
      "\n\n" +
      wrap(
        `If a client makes such a request, or any other request about their information, to ` +
          `healdesk itself rather than to Practice, healdesk will not act on it. It will pass the ` +
          `request to Practice within five business days and, in its reply to the client, tell ` +
          `them that healdesk cannot act on it and has passed it to Practice.`,
      ),
  },

  {
    id: "confidentiality",
    heading: "Confidentiality",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `healdesk will keep Client Information confidential. It will let only the people who ` +
          `need Client Information to provide the Services see it, and will bind each of them to ` +
          `keep it confidential.`,
      ) +
      (isVeterinaryPractice(v)
        ? "\n\n" +
          wrap(
            `Where Practice is a veterinary practice, state law may require it to keep what it ` +
              `knows about the animals in its care, and about their owners, confidential. ` +
              `healdesk treats everything a client tells the assistant about an animal, including ` +
              `its name and species and anything said about its health, as Client Information, ` +
              `and keeps it as confidential as anything else this agreement protects.`,
          )
        : ""),
  },

  /**
   * 1.2.1's four prohibitions in this document's words. Meta is named as it
   * is there; Meta is not healdesk's subcontractor, so the sentence says it
   * is not bound by this agreement rather than that it signs no BAA. The
   * scoping describes the safeguards, as BAA 1.3.0's clause 16 does: what the
   * assistant is instructed to do there and that its replies are filtered.
   * Until 12 October 2026 it said the assistant "handles no clinical content,
   * confirms no appointment details", which no filter guarantees (the owner's
   * decision after 1.3.0's second read, findings B1-B4).
   */
  {
    id: "prohibited",
    heading: "What healdesk is not authorised to do",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `· Use Client Information to train, fine-tune, or evaluate any artificial intelligence ` +
          `model, its own or a third party's.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Disclose Client Information to any advertising or analytics platform, in any form, ` +
          `including hashed or aggregated. Instagram, Messenger and WhatsApp are operated by ` +
          `Meta, which is not healdesk's subcontractor and is not bound by this agreement; where ` +
          `Practice connects them, the assistant replies there only inside a conversation the ` +
          `client started. It is instructed not to handle clinical content or confirm ` +
          `appointment details there and to move anything clinical to a call or to Practice's ` +
          `own secure route, and each reply the language model writes there is checked by ` +
          `automated filters designed to keep both out.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(
        `· Provide clinical advice, diagnosis, triage, or treatment recommendations through the ` +
          `assistant.`,
        "  ",
        "    ",
      ) +
      "\n" +
      wrap(`· Sell, license, or otherwise monetise Client Information.`, "  ", "    "),
  },

  /**
   * Reconciled with the shared state-law clause (§12.14, "The funnel's DPA").
   * For the state privacy laws the shared clause states the help once: its
   * item b (by appropriate technical and organisational measures, insofar as
   * possible, each request answered within ten business days), item d (what
   * an assessment needs) and its assessment paragraph, the more protective
   * wording, which this clause no longer restates in looser words. This
   * clause keeps what the shared clause does not reach: help under every
   * other law that applies to Client Information (breach notification,
   * medical and veterinary confidentiality among them), answers to Practice's
   * written questions about the whole agreement, and records to a regulator.
   */
  {
    id: "assistance",
    heading: "Assistance and audit",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `For the state privacy laws, healdesk helps Practice as the clause headed ` +
          `"${STATE_LAW_CLAUSE_HEADING}" provides. For any other law that applies to Client ` +
          `Information, healdesk will give Practice the reasonable help it needs to meet its own ` +
          `obligations, including to answer a regulator or a client. healdesk will answer ` +
          `Practice's reasonable written questions about how healdesk meets this agreement. ` +
          `healdesk will make its practices, books and records relating to Client Information ` +
          `available to a regulator with authority over Practice or over healdesk, where the law ` +
          `requires it to.`,
      ),
  },

  /**
   * Written from the clock apps/app runs (lib/offboarding/offboarding.ts):
   * offboarding starts when the subscription ends and sets destroy_after
   * thirty days out; the daily job destroyed once destroy_after had passed
   * and the export was delivered, or once ninety days had passed without
   * one. Since 7 October 2026 the job runs every hour and destroys a day
   * before each of those limits, at day 29 with the export delivered and at
   * day 89 without, which this text, left as it is, still bounds. 1.2.1 says
   * "within thirty days", which that clock keeps only when the export has
   * been delivered by then (agreement-changes.md § 12.11, item 8).
   *
   * Ending it, and the refund, are the owner's rule of 12 October 2026, which
   * BAA 1.3.0's Term clause (third paragraph) and the Terms (§ 15, in the
   * next legal version, on legal/130-pages) state too (dpa.md, gap 17): every termination
   * ends the Services and stops the Fees the same day; a refund only where
   * Practice terminates for healdesk's violation of a material term or under
   * the Subcontractors clause, and only of the prorated unused part of the
   * paid subscription period, never the setup fee or overage already billed,
   * and nothing before the plan starts; any other ending refunds nothing.
   * This document names no plan, price or fee (dpa.test.ts), so it says "a
   * fee for setting up the Services" and "subscription", and leaves the
   * annual plan's "rest of the year" to Terms § 15; the prorated unused part
   * of the period paid for is the same thing.
   * That is the effect "without penalty", which the shared notice of a new
   * subcontractor promises (subprocessor-notice.ts), has here, as in 1.3.0
   * (§12.14, HRC-07, SUB-03), and the Liability clause does not limit the
   * refund nor Practice's indemnity reach it. Until then this clause refunded
   * only a termination under the Subcontractors clause. A business associate
   * agreement replacing this one is not a termination: the Services go on
   * under it. After destruction nothing of a client is left: since gates 6
   * and 7 a deletion keeps no telephone number, and destruction deletes the
   * suppressions and the records of deletion requests with the rest
   * (destroyClinicData, apps/app drizzle/0058 and 0063), so the exception for
   * a deleted client's number is gone (dpa.md, gap 15).
   */
  {
    id: "term",
    heading: "Term, termination, and what happens to the information",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `This agreement takes effect on the effective date and continues for as long as ` +
          `healdesk holds any Client Information for Practice. Either party may terminate it on ` +
          `written notice if the other materially breaches it and does not cure the breach within ` +
          `thirty days of being told of it in writing; where cure is not possible, on notice. ` +
          `Practice may also terminate it under the Subcontractors clause. Ending the Services ` +
          `ends this agreement, subject to the rest of this clause. A business associate ` +
          `agreement that replaces this agreement under the clause on Practice's status ends it ` +
          `too: the Client Information healdesk then holds is governed by that agreement from its ` +
          `effective date, the Services go on under it, and nothing is destroyed because of the ` +
          `replacement.`,
      ) +
      "\n\n" +
      wrap(
        `Terminating this agreement, however it is terminated, ends the Services on the same ` +
          `day, and no Fees accrue for any time after that day. Where Practice terminates because ` +
          `healdesk has violated a material term of this agreement, or under the Subcontractors ` +
          `clause, healdesk refunds the Fees Practice has paid for the time after that day: the ` +
          `prorated unused part of the subscription period Practice has paid for. The refund ` +
          `never includes a fee for setting up the Services or usage above the allowance already ` +
          `billed, and there is nothing to refund if Practice's subscription has not started under ` +
          `the Terms. Where healdesk terminates because Practice has ` +
          `materially breached this agreement, or this agreement ends in any other way, nothing ` +
          `is refunded. Terminating under the Subcontractors clause is therefore without penalty ` +
          `to Practice.`,
      ) +
      "\n\n" +
      wrap(
        `When the Services end, the assistant stops answering for Practice, and healdesk uses ` +
          `Client Information only to pass forwarded calls through to Practice's direct line for ` +
          `as long as the Terms provide, to give Practice its export, and then to destroy it. ` +
          `Within thirty days after the Services end, healdesk will deliver to Practice an export ` +
          `of the Client Information it holds, in a usable electronic form. healdesk's destruction ` +
          `runs once a day. It destroys Practice's Client Information at the first run once ` +
          `thirty days have passed since the Services ended, if the export has been delivered by ` +
          `then; otherwise at the first run after the export is delivered; and in any case at the ` +
          `first run once ninety days have passed since the Services ended, whether or not the ` +
          `export has been delivered.`,
      ) +
      "\n\n" +
      wrap(
        `Destruction deletes the conversations, bookings, booking requests and contact details ` +
          `healdesk holds for Practice, and the credentials Practice connected through healdesk. ` +
          `After it, healdesk holds no Client Information for Practice. Copies in encrypted ` +
          `database backups are deleted as those ` +
          `backups expire. healdesk will also have its subcontractors delete what they hold for ` +
          `Practice, except what the Subcontractors clause says Anthropic may keep. What is in ` +
          `systems Practice controls, such as its calendar, is Practice's own.`,
      ) +
      "\n\n" +
      wrap(
        `Where destroying any Client Information is not feasible, healdesk will say why in ` +
          `writing, keep protecting it under this agreement for as long as it holds it, and use ` +
          `it only for what makes destruction infeasible. The signed copy of this agreement is ` +
          `kept for at least six years after it ends.`,
      ),
  },

  /**
   * 1.2.1's allocation, the same as Terms §§ 13–14, in this document's words,
   * and, as BAA 1.3.0's Liability clause does, the Term clause's refund kept
   * outside the exclusion and the indemnity: without that sentence the
   * refund "without penalty" promises could be read as excluded (§12.14,
   * HRC-07, verification of 7 October 2026).
   */
  {
    id: "liability",
    heading: "Liability, and who indemnifies whom",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `To the fullest extent the law allows, healdesk is not liable to Practice for any loss ` +
          `arising out of or relating to this agreement or the Services, in contract, tort or ` +
          `otherwise, including lost profits and indirect, incidental, special or consequential ` +
          `damages. Where the law does not permit that exclusion, healdesk's total aggregate ` +
          `liability to Practice, across all claims, is limited to the Fees paid or payable by ` +
          `Practice in the twelve months before the event giving rise to the claim. That limit ` +
          `does not apply to healdesk's wilful misconduct or gross negligence, or to any ` +
          `liability the law does not allow to be limited. Nothing in this clause limits the ` +
          `refund the Term clause provides, and Practice's indemnity below does not extend to a ` +
          `claim for it.`,
      ) +
      "\n\n" +
      wrap(
        `Practice will defend, indemnify and hold harmless healdesk and its subcontractors as ` +
          `section 14 of the Terms provides: against every claim, loss, liability, penalty, fine, ` +
          `cost and expense — including reasonable legal fees, the cost of defending a claim, and ` +
          `the cost of investigating a security incident and of notifying clients, regulators, ` +
          `the media and anyone else about a breach — to the extent it arises from or relates to ` +
          `the Services, Client Information that Practice or its clients give the Services, what ` +
          `Practice has told healdesk about its status, instructions Practice gave, Practice's own ` +
          `breach of this agreement or violation of a privacy, consumer-health or ` +
          `breach-notification law, or a claim by a client, a regulator or any other third party. ` +
          `This indemnity applies to the fullest extent the law allows, including where the claim ` +
          `alleges negligence on healdesk's part, and the limit above does not apply to it. ` +
          `healdesk gives Practice no indemnity.`,
      ) +
      "\n\n" +
      wrap(
        `This clause allocates cost between the parties. It does not change what each party owes ` +
          `a regulator directly: nothing in it shifts to Practice a civil penalty a regulator ` +
          `imposes on healdesk for healdesk's own conduct, and any duty Practice has to notify ` +
          `the people affected by a breach remains Practice's.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk does not carry liability insurance, and its own suppliers cap their liability ` +
          `to healdesk at figures far below what a breach can cost. Practice should size its own ` +
          `cover accordingly.`,
      ),
  },

  /**
   * 1.2.2's boilerplate without HIPAA: healdesk's notice address carries
   * hello@healdesk.io, its only email address (owner, 9 October 2026). The
   * practice's notice address is its
   * one address (owner, 6 October 2026): the signatory's email, which a
   * checkout intent requires to be the buying address and provisioning makes
   * the account's sign-in. An accepted calendar election is part of the
   * entire agreement, as the Definitions clause says it forms part of this
   * agreement (BAA 1.3.0, ICD-26).
   */
  {
    id: "notices-and-law",
    heading: "Notices, governing law, and interpretation",
    appliesWhen: ALWAYS,
    body: (v) =>
      wrap(
        `Notices under this agreement are in writing. To healdesk: ${NOTICE_ADDRESS}. To ` +
          `Practice: the email address of the signatory above, which is also the address of ` +
          `Practice's healdesk account, and any other notice address Practice later gives ` +
          `healdesk in writing. Incident reports may additionally be given by telephone to ` +
          `Practice, but the written notice is the notice.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement is governed by the laws of the State of ${GOVERNING_STATE}, without ` +
          `regard to conflict-of-laws rules, and the parties submit to the courts of that State. ` +
          `Any ambiguity is resolved in favour of a meaning that permits compliance with the laws ` +
          `that apply to Client Information. A reference to a law or regulation means it as ` +
          `amended, and if a change in law requires a change to this agreement, the parties will ` +
          `agree it in good faith within thirty days of either asking, failing which either may ` +
          `terminate under the Term clause. If any provision is unenforceable the rest stands.`,
      ) +
      "\n\n" +
      wrap(
        `This agreement (with any calendar election accepted under it), the Terms and the order ` +
          `Practice placed are the entire agreement between ${v.clinicLegalName} and ${ENTITY} ` +
          `about Client Information, and replace any earlier version of this agreement between ` +
          `them from the effective date forward; Client Information already held is governed by ` +
          `this version from that date.`,
      ),
  },
];

/** The 1.0.0 preamble: the BAA's layout, with this document's title and subject. */
function preamble100(v: DpaVariables): string {
  return preambleFrom100(v, "1.0.0");
}

/**
 * 1.0.0's preamble naming the given version. Only the version line moves, so
 * a later version's preamble is 1.0.0's word for word (as baa.ts's
 * preambleFrom130 does for the BAA).
 */
function preambleFrom100(v: DpaVariables, version: string): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  const descriptor = DPA_PRACTICE_DESCRIPTORS[v.specialty] ?? "";
  return [
    `HEALDESK DATA PROTECTION AGREEMENT`,
    `Version ${version} — executed electronically`,
    ``,
    wrap(
      `This Agreement takes effect on the date below. It governs Client Information, as ` +
        `defined below, that healdesk creates, receives, maintains or transmits for Practice in ` +
        `the course of the Services defined in the Terms. HIPAA does not apply to Client ` +
        `Information, for the reason the clause on Practice's status gives; healdesk protects ` +
        `it under this agreement with the safeguards it uses for protected health information.`,
      "",
      "",
    ),
    ``,
    `BETWEEN`,
    wrap(`${v.clinicLegalName} ("Practice"), ${descriptor}`),
    wrap(
      `${ENTITY}, ${ENTITY_FORM} ("healdesk"), with a mailing address for notices and ` +
        `correspondence at ${NOTICE_ADDRESS}`,
    ),
    ``,
    `SIGNED FOR PRACTICE BY`,
    wrap(`${v.signatoryName}${title}`),
    `  ${v.signatoryEmail}`,
    ``,
    `EFFECTIVE ${formatDate(v.effectiveDate)}`,
  ].join("\n");
}

/**
 * 1.0.0's render guard: a specialty that may sign a DPA, and the two calendar
 * answers, because a default would have the practice sign terms it never
 * chose (BAA 1.3.0's reasoning, `validate130`).
 */
function validate100(v: DpaVariables): void {
  if (!isSpecialtyId(v?.specialty)) {
    throw new DpaRenderError(
      `The agreement needs the practice's specialty; got ${JSON.stringify(v?.specialty ?? null)}.`,
    );
  }
  if (DPA_PRACTICE_DESCRIPTORS[v.specialty] === null) {
    throw new DpaRenderError(
      `A ${v.specialty} practice signs the business associate agreement, never this one.`,
    );
  }
  if (!isBookingSystemId(v.bookingSystem)) {
    throw new DpaRenderError(
      `The agreement needs the practice's booking system; got ${JSON.stringify(v.bookingSystem ?? null)}.`,
    );
  }
  if (!isCalendarAccount(v.calendarAccount)) {
    throw new DpaRenderError(
      `The agreement needs the kind of Google account that holds the calendar; got ${JSON.stringify(v.calendarAccount ?? null)}.`,
    );
  }
}

// -----------------------------------------------------------------------------
// 1.1.0 (released 30 October 2026): the one optional payment-link text after a call
// -----------------------------------------------------------------------------

/** 1.0.0's Safeguards clause, the object 1.1.0 changes. */
const SAFEGUARDS_1_0: DpaClause = CLAUSES_1_0.find((clause) => clause.id === "safeguards")!;

/** The two sentences that end 1.0.0's telephone exception. */
export const DPA_NO_SMS_1_0 =
  `healdesk places no calls and sends no SMS. This exception does not extend to any other ` +
  `channel or content.`;

/**
 * The same two sentences with the one optional payment-link text the owner
 * allowed after a call (28-29 October 2026), in the words BAA 1.6.0 uses for
 * it (baa.ts, NO_SMS_1_6), kept as general as the owner asked ("engineered
 * and designed to"): no sender, number, carrier, registration, vendor or
 * timing, and no promise that a text is offered or sent. The DPA's first
 * sentence has always said "places no calls", without the BAA's "to
 * patients", and keeps its own words; the exception after it is the BAA's
 * word for word, "Practice" being this document's defined term too. "That
 * text included" puts the text inside the paragraph's one narrow exception to
 * the encryption covenant, since a text message cannot negotiate encryption
 * either, and nothing else.
 */
export const DPA_NO_SMS_1_1 =
  `healdesk places no calls and sends no SMS, except that the assistant is engineered and ` +
  `designed to offer a caller a single text message that carries fixed wording and ` +
  `Practice's own payment link, where Practice has chosen that option. This exception, that ` +
  `text included, does not extend to any other channel or content.`;

/**
 * ⚖️ 1.1.0, drafted 30 October 2026 and released by the owner that day: 1.0.0's Safeguards clause
 * with its last two sentences as DPA_NO_SMS_1_1 says them (the telephone
 * exception now carries the one optional payment-link text, as BAA 1.6.0's
 * does; docs/counsel/agreement-changes.md §21). Every other sentence is
 * 1.0.0's, and the replacement refuses to render if 1.0.0's sentences are not
 * there, compared with the wrap undone.
 */
const SAFEGUARDS_1_1: DpaClause = {
  id: SAFEGUARDS_1_0.id,
  heading: SAFEGUARDS_1_0.heading,
  appliesWhen: SAFEGUARDS_1_0.appliesWhen,
  body: (v) => {
    const paragraphs = SAFEGUARDS_1_0.body(v).split("\n\n");
    const last = paragraphs[paragraphs.length - 1]!.replace(/\s+/g, " ").trim();
    if (!last.endsWith(` ${DPA_NO_SMS_1_0}`)) {
      throw new DpaRenderError(
        "1.1.0's Safeguards clause: 1.0.0's sentences on calls and SMS are not there.",
      );
    }
    paragraphs[paragraphs.length - 1] = wrap(
      last.slice(0, -DPA_NO_SMS_1_0.length) + DPA_NO_SMS_1_1,
    );
    return paragraphs.join("\n\n");
  },
};

/** 1.0.0's clauses in 1.0.0's order, the same objects, with 1.1.0's Safeguards clause in place of its own. */
const CLAUSES_1_1: readonly DpaClause[] = CLAUSES_1_0.map((clause) =>
  clause.id === SAFEGUARDS_1_1.id ? SAFEGUARDS_1_1 : clause,
);

/** 1.0.0's preamble, naming version 1.1.0. */
function preamble110(v: DpaVariables): string {
  return preambleFrom100(v, "1.1.0");
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/**
 * ⚖️ THE ONE SWITCH for releasing DPA 1.1.0 (owner's word only; see
 * docs/design/launch-readiness-2026-10-27/dpa-1-1-0-owner-checklist.md),
 * built as BAA_1_6_0_RELEASED was (baa.ts).
 *
 * Released by the owner: on 30 October 2026 he said "release DPA 1.1.0 as
 * well" in chat and released it himself, without external counsel, as he
 * released dpa/1.0.0 on 20 October and BAA 1.6.0 on 29 October.
 * `approvedByCounsel` keeps the flag's name for his release (see the field's
 * doc comment on DpaTemplate); docs/counsel/agreement-changes.md §21 still
 * recommends counsel review it.
 *
 * False (before the release): DPA_TEMPLATES was dpa/1.0.0 alone, so checkout
 * offered 1.0.0 and nothing could sign, provision, accept or offer 1.1.0.
 * Unlike BAA 1.6.0's draft, which sat after 1.5.1 in BAA_TEMPLATES and needed
 * a migration of its own (0091) to give it a destruction rule, 1.1.0 was not
 * registered at all while the switch was off.
 *
 * True (now): 1.1.0 is DPA_TEMPLATES[0] with approvedByCounsel true, and 1.0.0
 * follows it, released, signed by whoever signed it, and never offered again
 * (signableDpaTemplate takes only the current version). The DPA has no
 * go-live floor, so a practice bound to 1.0.0 still goes live under it. The
 * release migration (apps/app drizzle/0140_dpa_release_1_1_0.sql) landed in
 * the same commit: apps/app tests/dpa-release-1-1-0.test.ts fails on the flip
 * without it and on it without the flip.
 */
export const DPA_1_1_0_RELEASED: boolean = true;

const TEMPLATE_1_0_0: DpaTemplate = {
  version: "dpa/1.0.0",
  publishedOn: "2026-10-20",
  // Approved for release by the OWNER on 2026-10-20, on the owner's own
  // instruction ("Release the DPA now.") and without external counsel: as
  // the field's doc comment on DpaTemplate says, the flag records the
  // owner's release, not a lawyer's approval. Counsel approved the clauses
  // as they stood on 6 October 2026, not the edits since, which
  // agreement-changes.md §18 and docs/counsel/dpa.md recommend counsel
  // review before the first live DPA practice.
  approvedByCounsel: true,
  preamble: preamble100,
  clauses: CLAUSES_1_0,
  validate: validate100,
};

/**
 * DPA 1.1.0 as drafted, released by the owner on 30 October 2026. Its flag
 * becomes true only through dpaTemplatesFor(true), which DPA_TEMPLATES now
 * reads (DPA_1_1_0_RELEASED); this object keeps approvedByCounsel false so
 * that the switch, not a literal, is what releases it.
 */
export const DPA_TEMPLATE_1_1_0_DRAFT: DpaTemplate = {
  version: "dpa/1.1.0",
  publishedOn: "2026-10-30",
  approvedByCounsel: false,
  preamble: preamble110,
  clauses: CLAUSES_1_1,
  // 1.0.0's render guard: the variables are 1.0.0's, and so are its refusals.
  validate: validate100,
};

/** DPA_TEMPLATES as it reads once the switch is in the given state. */
export function dpaTemplatesFor(released: boolean): readonly DpaTemplate[] {
  return released
    ? [{ ...DPA_TEMPLATE_1_1_0_DRAFT, approvedByCounsel: true }, TEMPLATE_1_0_0]
    : [TEMPLATE_1_0_0];
}

// Newest released first, as BAA_TEMPLATES: CURRENT_DPA_VERSION and
// currentDpaTemplate() read [0]. dpa/1.0.0 was drafted 6 October 2026 and
// released on 2026-10-20, with its election form (calendar-election-dpa/1.0.0,
// dpa-calendar-election.ts). The migration of that day, dpa_release_1_0_0
// (apps/app drizzle/0104), added the version to app_dpa_version_released()
// (0090), go-live's copy of this flag, and the form to
// app_calendar_election_released(). No hash moved: nothing in the text marked
// it a draft (docs/counsel/dpa.md, gap 11). dpa/1.1.0, drafted on 30 October
// 2026, was released by the owner the same day (DPA_1_1_0_RELEASED): it is at
// [0], and 1.0.0 follows it, released but never offered again. The migration
// of that day, dpa_release_1_1_0 (apps/app drizzle/0140), added dpa/1.1.0 to
// app_dpa_version_released() and to app_destruction_rule().
export const DPA_TEMPLATES: readonly DpaTemplate[] = dpaTemplatesFor(DPA_1_1_0_RELEASED);

export const CURRENT_DPA_VERSION = DPA_TEMPLATES[0]!.version;

export function currentDpaTemplate(): DpaTemplate {
  return DPA_TEMPLATES[0]!;
}

export function getDpaTemplate(version: string): DpaTemplate | undefined {
  return DPA_TEMPLATES.find((t) => t.version === version);
}

/**
 * The words on the button that signs the agreement, and the sentence beside
 * the tick box, frozen into each acceptance as the BAA's are (baa.ts says why).
 * The server is to store the sentence re-derived from the validated name.
 */
export const DPA_ASSENT_LABEL = "I agree to the Data Protection Agreement";

export function dpaAssentSentence(clinicLegalName: string): string {
  const name = clinicLegalName.trim() || "my practice";
  return `${DPA_ASSENT_LABEL} on behalf of ${name}, and I confirm I am authorised to enter into it.`;
}

/** The words on the button that completes the signature. Stored beside the sentence. */
export const DPA_ACTION_LABEL = "Sign and continue";

/** Which clauses this practice's agreement contains, recorded with the acceptance. */
export function applicableDpaClauses(
  template: DpaTemplate,
  variables: DpaVariables,
): readonly DpaClause[] {
  return template.clauses.filter((clause) => clause.appliesWhen(variables));
}

/**
 * Assemble the agreement for one practice. Strict, as renderBaa is: a missing
 * name, signatory or answer throws rather than rendering a document that
 * looks complete and binds no one.
 */
export function renderDpa(template: DpaTemplate, variables: DpaVariables): string {
  template.validate(variables);

  requireField(variables.clinicLegalName, "clinicLegalName");
  requireField(variables.signatoryName, "signatoryName");
  requireField(variables.signatoryEmail, "signatoryEmail");
  requireField(variables.effectiveDate, "effectiveDate");

  const clauses = applicableDpaClauses(template, variables);
  if (clauses.length === 0) {
    throw new DpaRenderError("No clauses apply — that cannot be an agreement.");
  }

  const numbered = clauses.map((clause, index) => {
    const body = clause.body(variables);
    if (!body.trim()) {
      throw new DpaRenderError(`Clause ${clause.id} rendered empty.`);
    }
    return `${index + 1}. ${clause.heading.toUpperCase()}\n\n${body}`;
  });

  const text = [template.preamble(variables), "", ...intersperse(numbered)].join("\n");

  if (/\{\{/.test(text)) {
    throw new DpaRenderError("Unsubstituted placeholder in the assembled text.");
  }
  return text;
}

/** SHA-256 hex of the exact assembled text, the digest hashBaaText produces. */
export function hashDpaText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Assemble, hash and report the variant in one step, as prepareBaa does. */
export function prepareDpa(
  template: DpaTemplate,
  variables: DpaVariables,
): { text: string; hash: string; version: string; clauseIds: string[] } {
  const text = renderDpa(template, variables);
  return {
    text,
    hash: hashDpaText(text),
    version: template.version,
    clauseIds: applicableDpaClauses(template, variables).map((c) => c.id),
  };
}

function intersperse(sections: string[]): string[] {
  return sections.flatMap((section, index) => (index === 0 ? [section] : ["", section]));
}

function requireField(value: string | undefined, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new DpaRenderError(`${field} is required to render the agreement.`);
  }
}

/** "2026-10-06" → "6 October 2026". Mirrors baa.ts's formatDate, which is not exported. */
function formatDate(iso: string): string {
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new DpaRenderError(`Invalid effective date: ${iso}`);
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
