import { createHash } from "node:crypto";

import {
  AGREEMENT_PARTY,
  PAYMENTS_CLAUSE_BODY,
  PAYMENTS_CLAUSE_HEADING,
  STATE_LAW_CLAUSE_BODY,
  STATE_LAW_CLAUSE_HEADING,
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
  CALENDAR_LOCATION_PARAGRAPH,
  calendarTermsKind,
  isCalendarAccount,
  selectCalendarClause,
  type CalendarAccount,
  type CalendarTermsKind,
} from "./calendar-terms";
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
 *   - the state-law processor clause and the Payments clause are baa.ts's
 *     exported constants. The state-law text is used with the two edits a
 *     document without PHI needs (`DPA_STATE_LAW_EDITS`, below), never
 *     retyped;
 *   - the calendar clause is chosen by `selectCalendarClause`, from the
 *     booking system and the kind of Google account, exactly as BAA 1.3.0
 *     chooses it, and carries the selector's sentences with the person a
 *     booking is for called a client (`CALENDAR_PERSON_NOUNS`), then the
 *     location paragraph, as 1.3.0 does;
 *   - the notice of a new subcontractor is subprocessor-notice.ts's sentence,
 *     24 hours by email with the right to object (owner, 6 October 2026);
 *   - Anthropic's retention is 1.2.1's sentence, word for word, from
 *     "retains conversation content for 30 days" to "never trains on that
 *     content" (`ANTHROPIC_RETENTION`);
 *   - the party, its notice address and Delaware law are `AGREEMENT_PARTY`.
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
 * `dueForDestruction` in lib/offboarding/offboarding.ts, run once a day by the
 * `offboarding-destroy` job), not from the BAA's "within thirty days", which
 * the code does not keep when the export has not been delivered. The
 * deletion residue it names is what `destroyClinicData` and `eraseContact`
 * leave. docs/counsel/dpa.md lists every fact the text rests on and the file
 * it was read from.
 *
 * ## Released by the owner, never by default
 *
 * `approvedByCounsel` is the BAA's flag under the BAA's name: the owner's
 * release. While it is false nothing may sign this document:
 * `agreementKindFor` falls back to the BAA for "No" and refuses a veterinary
 * practice (agreement-kind.ts reads this flag), and provisioning refuses an
 * account bound to an unreleased DPA. The text carries no draft marker, so
 * releasing it moves no hash; an edit before release regenerates the golden
 * hashes (dpa.test.ts) and docs/dpa-v1.0.0.txt in the same commit.
 *
 * To publish a revision after release: add a new version at DPA_TEMPLATES[0],
 * never edit a released one. Someone has signed it.
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
 * The two edits the state-law clause needs in a document without PHI. Its
 * first words name "patient information", which this document calls Client
 * Information; its last sentence applies four clauses "to that information as
 * they apply to PHI", and here those clauses govern Client Information
 * already, so it goes (baa.ts says the DPA words that sentence for itself).
 * Everything between is the constant's, byte for byte, which dpa.test.ts pins.
 */
export const DPA_STATE_LAW_EDITS = {
  opening: ["healdesk processes patient information", "healdesk processes Client Information"],
  droppedLastSentence:
    "The reporting, subcontractor, security and return-or-destroy clauses of this agreement " +
    "apply to that information as they apply to PHI.",
} as const;

function dpaStateLawBody(): string {
  const [from, to] = DPA_STATE_LAW_EDITS.opening;
  const last = ` ${DPA_STATE_LAW_EDITS.droppedLastSentence}`;
  if (!STATE_LAW_CLAUSE_BODY.startsWith(from) || !STATE_LAW_CLAUSE_BODY.endsWith(last)) {
    throw new DpaRenderError(
      "The shared state-law clause no longer has the shape the DPA quotes; re-derive DPA_STATE_LAW_EDITS.",
    );
  }
  return to + STATE_LAW_CLAUSE_BODY.slice(from.length, STATE_LAW_CLAUSE_BODY.length - last.length);
}

/** The state-law processor terms as the DPA prints them, unwrapped. */
export const DPA_STATE_LAW_CLAUSE_BODY = dpaStateLawBody();

/**
 * The calendar selector's words for the person a booking is for, and this
 * document's. The selector's clauses say "patient" in exactly these two
 * places (the WRITES sentence of calendar-terms.ts), and a veterinary
 * practice's agreement must never call a person a patient.
 */
export const CALENDAR_PERSON_NOUNS: readonly (readonly [string, string])[] = [
  ["the patient's first name", "the client's first name"],
  ["about the patient", "about the client"],
];

/**
 * The calendar clause: the selector's body, paragraph by paragraph, with the
 * person nouns replaced and the paragraph wrapped again, then BAA 1.3.0's
 * location paragraph. Refuses rather than prints "patient" if the selector's
 * wording ever moves.
 */
function dpaCalendarBody(v: DpaVariables): string {
  const selected = selectCalendarClause({
    bookingSystem: v.bookingSystem,
    calendarAccount: v.calendarAccount,
  });
  const paragraphs = selected.body.split("\n\n").map((paragraph) => {
    let text = paragraph.replace(/\s+/g, " ").trim();
    for (const [from, to] of CALENDAR_PERSON_NOUNS) text = text.split(from).join(to);
    if (/\bpatients?\b/i.test(text)) {
      throw new DpaRenderError(
        `The calendar clause ${selected.clauseId} says "patient" where the DPA says "client"; extend CALENDAR_PERSON_NOUNS.`,
      );
    }
    return wrap(text);
  });
  return [...paragraphs, wrap(CALENDAR_LOCATION_PARAGRAPH)].join("\n\n");
}

/**
 * Anthropic's retention, as BAA 1.2.1 states it. dpa.test.ts asserts that
 * 1.2.1's rendered subcontractors clause contains this exact run of words.
 */
export const ANTHROPIC_RETENTION =
  "retains conversation content for 30 days, for abuse detection and security, and then " +
  "deletes it, except content its automated trust-and-safety systems flag or the law requires " +
  "it to keep, which it may retain for up to two years; its covered service cannot run with " +
  "shorter retention. Anthropic never trains on that content";

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
            `Client Information that compromises its security, confidentiality or integrity. ` +
            `"Business day" means a day other than a Saturday, Sunday or United States federal ` +
            `holiday.`,
        ) +
        "\n\n" +
        wrap(
          `This agreement governs Client Information. Where this agreement and the Terms ` +
            `conflict about Client Information, this agreement governs.`,
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

  {
    id: "instructions",
    heading: "Practice's instructions",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `Practice decides what the Services do with Client Information, through the Terms and ` +
          `the settings Practice chooses in its portal, which are its instructions to healdesk. ` +
          `healdesk will tell Practice if it believes an instruction would break a law that ` +
          `applies to Client Information, and need not follow that instruction.`,
      ) +
      "\n\n" +
      wrap(
        `Practice will tell healdesk, promptly and in writing, of any limit it has agreed with a ` +
          `client, and of any permission a client has withdrawn, that affects how healdesk may ` +
          `use or disclose that client's information. Practice will not ask healdesk to use or ` +
          `disclose Client Information in a way the law would not permit Practice itself to, and ` +
          `is responsible for any notice the law requires Practice to give its clients, and any ` +
          `consent it requires Practice to obtain from them, for their information to be handled ` +
          `through the Services.`,
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

  // Quoted from baa.ts, with the two edits DPA_STATE_LAW_EDITS records.
  {
    id: "state-law",
    heading: STATE_LAW_CLAUSE_HEADING,
    appliesWhen: ALWAYS,
    body: () => wrap(DPA_STATE_LAW_CLAUSE_BODY),
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
   * access only where the calendar clause grants some.
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
            ? `, together with the calendar access the Google Calendar clause describes.`
            : `.`),
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
   * on it: the catalogue excludes it. Then who receives Client Information,
   * by category, which the state-law terms ask a processor to limit.
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
          `it out. No call audio is kept at all.`,
      ) +
      "\n\n" +
      wrap(
        `healdesk discloses Client Information only to: Practice itself; healdesk's ` +
          `subcontractors, under the Subcontractors clause; the systems Practice connects and ` +
          `controls, which are its calendar, as the Google Calendar clause describes, its payment ` +
          `processor, as the Payments clause describes, and the messaging accounts Practice ` +
          `connects with Meta, in a conversation a client started there; and anyone to whom the ` +
          `law requires healdesk to disclose it, after telling Practice where the law allows. It ` +
          `discloses Client Information to no one else.`,
      ),
  },

  /**
   * 1.2.1's three paragraphs in this document's words: the flow-down, the
   * model provider with 1.2.1's retention sentence, and the notice, which is
   * the shared 24-hour sentence. Client Information reaches Anthropic in the
   * same HIPAA-ready account as PHI does, which is why the BAA is named.
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
          `healdesk uses for the practices HIPAA covers, under a business associate agreement ` +
          `with healdesk. In that account Anthropic ${ANTHROPIC_RETENTION}, and healdesk may not ` +
          `use Client Information to train, fine-tune or evaluate any model, its own or a third ` +
          `party's.`,
      ) +
      "\n\n" +
      wrap(subprocessorNoticeClauseBody()),
  },

  /** 1.2.1's reporting clause: the same three clocks and report contents, without the 164.410 citations. */
  {
    id: "incidents",
    heading: "Reporting incidents and breaches",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(`healdesk will report to Practice, in writing to the address in the Notices clause:`) +
      "\n\n" +
      wrap(
        `a. any use or disclosure of Client Information not permitted by this agreement, within ` +
          `five business days of healdesk becoming aware of it;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `b. any breach, without unreasonable delay and in no case later than five calendar days ` +
          `after discovery. A breach is treated as discovered on the first day it is known, or ` +
          `by exercising reasonable diligence would have been known, to healdesk or to any ` +
          `person, other than the one committing it, who is healdesk's workforce member or ` +
          `agent. Five days is deliberately short, to leave Practice time to meet any duty it ` +
          `has under state breach-notification law to notify the people affected;`,
        "    ",
        "       ",
      ) +
      "\n" +
      wrap(
        `c. any security incident, within five business days of becoming aware of it — except ` +
          `routine unsuccessful attempts that compromised nothing, such as blocked sign-ins, ` +
          `port scans and filtered traffic, which the parties agree this clause reports once, ` +
          `here, and which healdesk will summarise on request.`,
        "    ",
        "       ",
      ) +
      "\n\n" +
      wrap(
        `A breach report will include, to the extent known and supplemented as learned: the ` +
          `identification of each client whose Client Information was or is reasonably believed ` +
          `to have been accessed, acquired, used or disclosed; a description of what happened, ` +
          `including the dates of the breach and of its discovery; the types of Client ` +
          `Information involved; what healdesk is doing to investigate, mitigate and prevent ` +
          `recurrence; and a contact. Who bears the cost of notifying clients, regulators and ` +
          `anyone else about a breach is allocated by the Liability clause.`,
      ),
  },

  /**
   * The state-law counterpart of 1.2.1's patient-rights clause. What a
   * deletion leaves is what `eraseContact` (apps/app lib/retention/purge.ts)
   * leaves: the number, on the suppression list, as the record of the
   * request.
   */
  {
    id: "requests",
    heading: "Clients' requests",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `When a client asks Practice to see, correct or delete their Client Information, ` +
          `healdesk will give Practice what it needs to answer within ten business days of ` +
          `Practice asking, and will correct or delete that information as Practice directs. The ` +
          `telephone number of a client whose information is deleted is kept only as the record ` +
          `that the deletion was asked for.`,
      ) +
      "\n\n" +
      wrap(
        `If a client makes such a request to healdesk directly, healdesk will not answer it. It ` +
          `will pass the request to Practice within five business days and tell the client it ` +
          `has done so.`,
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
   * is there, and the scoping is the same product rule the adapter enforces;
   * Meta is not healdesk's subcontractor, so the sentence says it is not bound
   * by this agreement rather than that it signs no BAA.
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
          `client started, handles no clinical content, confirms no appointment details, and ` +
          `moves anything clinical to a call or to Practice's own secure route.`,
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

  {
    id: "assistance",
    heading: "Assistance and audit",
    appliesWhen: ALWAYS,
    body: () =>
      wrap(
        `healdesk will give Practice the reasonable help it needs to meet its own obligations ` +
          `under the laws that apply to Client Information, including to answer a regulator or a ` +
          `client, and will answer Practice's reasonable written questions about how healdesk ` +
          `meets this agreement. healdesk will make its practices, books and records relating to ` +
          `Client Information available to a regulator with authority over Practice or over ` +
          `healdesk, where the law requires it to.`,
      ),
  },

  /**
   * Written from the clock apps/app runs (lib/offboarding/offboarding.ts):
   * offboarding starts when the subscription ends and sets destroy_after
   * thirty days out; the daily job destroys once destroy_after has passed and
   * the export was delivered, or once ninety days have passed without one.
   * 1.2.1 says "within thirty days", which that clock keeps only when the
   * export has been delivered by then (agreement-changes.md § 12.11, item 8).
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
          `Practice may also terminate under the subcontractor-objection right above. Ending the ` +
          `Services ends this agreement, subject to the rest of this clause. A business associate ` +
          `agreement that replaces this agreement under the clause on Practice's status ends it ` +
          `too: the Client Information healdesk then holds is governed by that agreement from its ` +
          `effective date, and nothing is destroyed because of the replacement.`,
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
          `After it, healdesk holds no Client Information for Practice except the telephone ` +
          `number of any client who asked to have their information deleted, kept only as the ` +
          `record of that request. Copies in encrypted database backups are deleted as those ` +
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

  /** 1.2.1's allocation, the same as Terms §§ 13–14, in this document's words. */
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
          `liability the law does not allow to be limited.`,
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
   * 1.2.1's boilerplate without HIPAA. The practice's notice address is its
   * one address (owner, 6 October 2026): the signatory's email, which a
   * checkout intent requires to be the buying address and provisioning makes
   * the account's sign-in.
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
        `This agreement, the Terms and the order Practice placed are the entire agreement ` +
          `between ${v.clinicLegalName} and ${ENTITY} about Client Information, and replace any ` +
          `earlier version of this agreement between them from the effective date forward; ` +
          `Client Information already held is governed by this version from that date.`,
      ),
  },
];

/** The 1.0.0 preamble: the BAA's layout, with this document's title and subject. */
function preamble100(v: DpaVariables): string {
  const title = v.signatoryTitle?.trim() ? `, ${v.signatoryTitle.trim()}` : "";
  const descriptor = DPA_PRACTICE_DESCRIPTORS[v.specialty] ?? "";
  return [
    `HEALDESK DATA PROTECTION AGREEMENT`,
    `Version 1.0.0 — executed electronically`,
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
    wrap(`${ENTITY}, ${ENTITY_FORM} ("healdesk"), of ${NOTICE_ADDRESS}`),
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
// Templates
// -----------------------------------------------------------------------------

export const DPA_TEMPLATES: readonly DpaTemplate[] = [
  // Newest released first, as BAA_TEMPLATES: CURRENT_DPA_VERSION and
  // currentDpaTemplate() read [0]. Drafted 6 October 2026; the owner releases
  // it at launch (Gate A) after reading docs/dpa-v1.0.0.txt, by setting
  // approvedByCounsel to true here. Nothing else changes, and no hash moves.
  {
    version: "dpa/1.0.0",
    publishedOn: "2026-10-06",
    approvedByCounsel: false,
    preamble: preamble100,
    clauses: CLAUSES_1_0,
    validate: validate100,
  },
] as const;

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
