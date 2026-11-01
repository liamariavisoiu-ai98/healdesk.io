import type { AgreementExplainer } from "./agreement-copy";
import { BAA_CLAUSE_EXPLAINERS, type BaaExplainerTerm } from "./baa-explainer";
import { CALENDAR_CLAUSE_HEADING, CALENDAR_CLAUSE_IDS } from "./calendar-terms";
import { getDpaTemplate } from "./dpa";
import { SUBPROCESSOR_NOTICE_DAYS_1_7, SUBPROCESSOR_NOTICE_HOURS } from "./subprocessor-notice";

/**
 * Why a Data Protection Agreement exists, explained to the person about to
 * sign one: the DPA's counterpart of BAA_EXPLAINER, which must never be shown
 * beside a DPA (plan Part L). The BAA's explanation is a paraphrase of 45 CFR
 * 164.504(e), the rule that requires it; nothing requires this one, so each
 * line here paraphrases a clause of the DPA itself and cites that clause by
 * its heading, which is what a reader can check it against.
 *
 * Kept as data, like baa-explainer.ts, so there is one copy of the wording
 * and it can be read without React. The same rules hold: descriptive, never
 * "you need this", and the agreement governs where the two differ. It says
 * "clients" throughout, so a veterinary practice is never told its patients
 * are people.
 */

/** The heading of a DPA clause, in the quotation marks the signing screen prints a citation in. */
function clause(heading: string): string {
  return `“${heading}”`;
}

export const DPA_EXPLAINER = {
  heading: "Why you're signing this",

  lead:
    "HIPAA covers health information about people, held by health plans, clearinghouses and " +
    "the providers that send insurance transactions electronically. A veterinary practice, and " +
    "a practice that sends no claim or other insurance transaction electronically, are outside " +
    "it, so a business associate agreement would name duties neither side has. Your clients " +
    "still trust you with their names, numbers and reasons for getting in touch, and several " +
    "states' privacy and consumer-health laws set terms for a business that handles that " +
    "information for you. This agreement holds healdesk to those terms, and to the safeguards " +
    "it uses where HIPAA does apply.",

  objection:
    "It is also the answer to a fair question: if healdesk already promises never to train AI " +
    "models on your clients' information, why is a contract needed? Because a promise in a " +
    "privacy policy is a statement we could revise. This agreement is a commitment to your " +
    "practice, and healdesk cannot change it without your signature on a new version.",

  terms: [
    {
      plain:
        "Use your clients' information only on your instructions and only to provide the " +
        "service: never sell or share it, and never combine it with other information beyond " +
        "what the service needs",
      citation: `${clause("Practice's instructions")}, ${clause("Where Practice is not a covered entity")}`,
    },
    {
      plain:
        "Protect it with the safeguards healdesk uses where HIPAA does apply, the HIPAA Security " +
        "Rule's included",
      citation: clause("Safeguards"),
    },
    {
      plain:
        "Ask your clients for no more than your front desk needs to book them, and pass their " +
        "information to nobody outside the categories the agreement lists",
      citation: clause("Minimum necessary, and who receives Client Information"),
    },
    {
      plain:
        "Tell you of any misuse, security incident or breach without unreasonable delay, and " +
        "in no case later than 60 calendar days after discovery, with a written report you can " +
        "use for your own notices",
      citation: clause("Reporting incidents and breaches"),
    },
    {
      plain:
        "Hold every subcontractor that handles it to terms as protective, and tell you by email " +
        `at least ${SUBPROCESSOR_NOTICE_HOURS} hours before a new one does, so you can end the ` +
        "agreement without penalty if you object",
      citation: clause("Subcontractors"),
    },
    {
      plain: "Help you answer a client who asks to see, correct or delete their information",
      citation: clause("Clients' requests"),
    },
    {
      plain:
        "When you leave, give you an export and then destroy what healdesk holds, on the " +
        "schedule the agreement states",
      citation: clause("Term, termination, and what happens to the information"),
    },
  ] as const satisfies readonly BaaExplainerTerm[],

  disclaimer:
    "This summary is a plain-English paraphrase, provided for convenience. It is not legal " +
    "advice and healdesk is not your lawyer. The agreement below is the operative document; if " +
    "the two differ, the agreement governs. Whether HIPAA or a state privacy law applies to your " +
    "practice, and what it requires of you, are questions for your own counsel.",
} as const satisfies AgreementExplainer;

/**
 * The DPA's subcontractors note, with the notice period its version gives:
 * "24 hours" for dpa/1.0.0 and dpa/1.1.0, word for word what their checkout
 * showed, and "15 days" for dpa/1.2.0 (subprocessorNoticeClauseBody15Days;
 * agreement-changes.md §22).
 */
function subcontractorsNote(notice: string): BaaExplainerTerm {
  return {
    plain:
      "Every vendor that handles client information agrees in writing to terms as protective " +
      "before it does. The language model is Anthropic's: it receives conversation content only " +
      "under a business associate agreement with healdesk, signed before any client's " +
      "information reaches it, keeps that content for no more than the 30 days " +
      "of its standard retention, then deletes it (content its safety systems flag may be held " +
      "for up to two years, and content the law requires it to keep for as long as the law " +
      "requires), and doesn't train on it without healdesk's permission, which healdesk won't " +
      `give. You're told by email at least ${notice} before a new vendor ` +
      "handles client information, and may end the agreement without penalty if you object on " +
      "reasonable grounds before the change takes effect: the service ends with it, and fees you " +
      "paid for the time after are refunded",
    citation: clause("Subcontractors"),
  };
}

/**
 * Notes for the DPA's clauses that describe what the product does, keyed by
 * DPA clause id, for the signing screen to show beside the clause. The three
 * calendar notes are the BAA's own words, because the DPA chooses and prints
 * the same calendar clause (the BAA notes name no patient); their citation is
 * this document's clause, by the heading it prints ("Google Calendar", since
 * the pre-release audit renamed it), never 45 CFR. The other three are
 * written for this document: client information, the DPA's categories of
 * recipient, and its 24 hours' notice of a new subcontractor with the effect
 * "without penalty" has.
 */
export const DPA_CLAUSE_EXPLAINERS: Readonly<Record<string, BaaExplainerTerm>> = {
  "data-sources": {
    plain:
      "healdesk connects to no practice-management or point-of-sale system and holds no " +
      "credentials to one. The only client information it receives is what your clients give it " +
      "in a call or chat, plus whatever Google Calendar access the calendar clause, or a " +
      "calendar election, describes",
    citation: clause("What healdesk reads from your systems"),
  },
  [CALENDAR_CLAUSE_IDS.covered]: {
    plain: BAA_CLAUSE_EXPLAINERS["google-calendar-covered"].plain,
    citation: clause(CALENDAR_CLAUSE_HEADING),
  },
  [CALENDAR_CLAUSE_IDS.uncovered]: {
    plain: BAA_CLAUSE_EXPLAINERS["google-calendar-uncovered"].plain,
    citation: clause(CALENDAR_CLAUSE_HEADING),
  },
  [CALENDAR_CLAUSE_IDS.not_used]: {
    plain: BAA_CLAUSE_EXPLAINERS["google-calendar-not-used"].plain,
    citation: clause(CALENDAR_CLAUSE_HEADING),
  },
  "minimum-necessary": {
    plain:
      "The assistant asks only what your front desk needs to place a booking: a name, a number, " +
      "the service, the times that suit, whether they've been before, consultation or treatment, " +
      "and any practitioner they prefer (and at a veterinary practice, the animal's name and " +
      "species). It never asks for a history, a medication or a diagnosis, and never takes a card " +
      "number. It says it is an AI assistant in its first line on every channel, and on calls that " +
      "the call is transcribed; you cannot switch that off. healdesk passes client information " +
      "only to you, its subcontractors, the systems you connect, and anyone the law requires",
    citation: clause("Minimum necessary, and who receives Client Information"),
  },
  subcontractors: subcontractorsNote(`${SUBPROCESSOR_NOTICE_HOURS} hours`),
};

/**
 * The note to show beside one clause of one DPA version, or undefined. Only
 * for a version that exists and registers that clause, so a note can never be
 * shown beside a clause the document does not carry.
 */
export function dpaClauseExplainer(
  templateVersion: string,
  clauseId: string,
): BaaExplainerTerm | undefined {
  if (!Object.prototype.hasOwnProperty.call(DPA_CLAUSE_EXPLAINERS, clauseId)) return undefined;
  const template = getDpaTemplate(templateVersion);
  if (!template?.clauses.some((c) => c.id === clauseId)) return undefined;
  const forVersion = Object.prototype.hasOwnProperty.call(
    DPA_CLAUSE_EXPLAINERS_BY_VERSION,
    templateVersion,
  )
    ? DPA_CLAUSE_EXPLAINERS_BY_VERSION[templateVersion]
    : undefined;
  return forVersion?.[clauseId] ?? DPA_CLAUSE_EXPLAINERS[clauseId];
}

/**
 * Notes for a version whose clause says something different from what
 * DPA_CLAUSE_EXPLAINERS describes (dpa/1.0.0's), keyed by version and then
 * clause id. dpa/1.2.0 gives fifteen days' notice of a new subcontractor
 * (released 30 October 2026, landed 1 November 2026); dpa/1.1.0 gives
 * dpa/1.0.0's 24 hours, as DPA_CLAUSE_EXPLAINERS says.
 */
export const DPA_CLAUSE_EXPLAINERS_BY_VERSION: Readonly<
  Record<string, Readonly<Record<string, BaaExplainerTerm>>>
> = {
  "dpa/1.2.0": { subcontractors: subcontractorsNote(`${SUBPROCESSOR_NOTICE_DAYS_1_7} days`) },
};

/**
 * "Why you're signing this" for dpa/1.2.0: DPA_EXPLAINER with its two
 * bullets that state a period said as 1.2.0's clauses say them, ten
 * calendar days to report and fifteen days' notice of a new subcontractor.
 * Every other line is DPA_EXPLAINER's.
 */
const DPA_EXPLAINER_1_2: AgreementExplainer = {
  ...DPA_EXPLAINER,
  terms: DPA_EXPLAINER.terms.map((term) => {
    if (term.citation === clause("Reporting incidents and breaches")) {
      return {
        ...term,
        plain: term.plain.replace(
          "in no case later than 60 calendar days after discovery",
          "in no case later than 10 calendar days after discovery",
        ),
      };
    }
    if (term.citation === clause("Subcontractors")) {
      return {
        ...term,
        plain: term.plain.replace(
          `at least ${SUBPROCESSOR_NOTICE_HOURS} hours before`,
          `at least ${SUBPROCESSOR_NOTICE_DAYS_1_7} days before`,
        ),
      };
    }
    return term;
  }),
};

/**
 * "Why you're signing this" for one DPA version: DPA_EXPLAINER for
 * dpa/1.0.0, dpa/1.1.0 and any version that words no bullet differently,
 * and DPA_EXPLAINER_1_2 for dpa/1.2.0.
 */
export function dpaExplainerFor(templateVersion: string): AgreementExplainer {
  return templateVersion === "dpa/1.2.0" ? DPA_EXPLAINER_1_2 : DPA_EXPLAINER;
}
