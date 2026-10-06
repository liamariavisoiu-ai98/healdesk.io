import { SUBPROCESSOR_NOTICE_HOURS } from "./subprocessor-notice";

/**
 * Why a BAA exists, explained to the person about to sign one.
 *
 * Shown in the purchase flow before payment. Three reasons it earns the space
 * rather than being a link to a help article:
 *
 *   1. Most buyers here are clinic owners, not compliance officers. A signature
 *      collected from someone who does not know what they are signing is worth
 *      less — evidentially and ethically — than one collected from someone who
 *      does.
 *   2. It is the answer to the objection this product actually gets: "you
 *      already promise not to train on my data, so why the paperwork?" Training
 *      is one line; the list below is what the contract adds.
 *   3. Conspicuous, plain-language disclosure adjacent to the assent button is
 *      what makes a clickwrap hold up. Burying it helps nobody.
 *
 * ⚖️ Kept as data rather than JSX so there is exactly one copy of the wording,
 * and so counsel can review this file without reading React. Every clause is
 * paraphrased from 45 CFR 164.504(e)(2)(ii); the paraphrase is deliberately
 * plainer than the regulation, and the citation is shown so a reader who wants
 * the real thing can go and get it.
 */

export type BaaExplainerTerm = {
  /** Plain-English summary. What the clinic owner actually reads. */
  plain: string;
  /** The subparagraph it paraphrases, so the claim is checkable. */
  citation: string;
};

export const BAA_EXPLAINER = {
  heading: "Why you're signing this",

  /**
   * The lead.
   *
   * Descriptive ("HIPAA requires"), never imperative ("you need this"). The
   * imperative asserts a conclusion about the buyer's own legal status that we
   * cannot verify — whether this particular practice is a covered entity is
   * exactly the thing we ask them, rather than tell them.
   */
  lead:
    "A healthcare provider may not hand patient information to a supplier without a " +
    "written contract in place first. That contract is a Business Associate Agreement, " +
    "and the requirement is 45 CFR 164.502(e).",

  objection:
    "It is also the answer to a fair question: if healdesk already promises never to " +
    "train AI models on your patients' data, why is a contract needed? Because a promise " +
    "in a privacy policy is one line that we could revise. 45 CFR 164.504(e) sets out " +
    "what the agreement has to contain — and none of it exists without one.",

  /**
   * Each bullet is pin-cited to its OWN subparagraph.
   *
   * An earlier draft said "164.504(e)(2)(ii) lists what the contract has to
   * contain" and then listed items that aren't all in it — termination is at
   * (e)(2)(iii), and the security-incident duty is not in 164.504 at all, it is
   * in the Security Rule at 164.314(a)(2)(i)(C). A summary of the law that
   * mis-cites the law is worse than no summary, because it is the vendor
   * telling the customer something checkable and getting it wrong.
   *
   * The first item is first deliberately: the use-and-disclosure limitation is
   * the provision that actually answers the training objection, and the earlier
   * draft posed that question and then omitted the answer.
   */
  terms: [
    {
      plain:
        "Define exactly what we may do with your patient data — and it cannot let us use " +
        "or disclose it in ways HIPAA would not let you. This is the part a privacy policy " +
        "cannot do: an enforceable limit rather than a statement of intent",
      citation: "164.504(e)(2)(i), (e)(2)(ii)(A)",
    },
    {
      plain: "Use appropriate safeguards, and comply with the HIPAA Security Rule",
      citation: "164.504(e)(2)(ii)(B)",
    },
    {
      plain:
        "Report to you any use or disclosure the agreement does not permit — including, " +
        "but not limited to, breaches of unsecured patient data",
      citation: "164.504(e)(2)(ii)(C), 164.410",
    },
    {
      plain: "Report any security incident we become aware of",
      citation: "164.314(a)(2)(i)(C)",
    },
    {
      plain:
        "Flow the same obligations down to our own subcontractors that touch your data",
      citation: "164.504(e)(2)(ii)(D)",
    },
    {
      plain:
        "Help you respond when a patient asks to see their information, asks to correct " +
        "it, or asks for an accounting of who it was disclosed to",
      citation: "164.504(e)(2)(ii)(E)–(G)",
    },
    {
      plain: "Make records available to Health and Human Services if it investigates",
      citation: "164.504(e)(2)(ii)(I)",
    },
    {
      plain:
        "At the end of the agreement, return or destroy the patient data we hold and keep " +
        "no copies — and where that is not feasible, keep protecting it under the same " +
        "terms and use it only for whatever makes return or destruction infeasible",
      citation: "164.504(e)(2)(ii)(J)",
    },
    {
      plain: "Let you terminate the agreement if we materially breach it",
      citation: "164.504(e)(2)(iii)",
    },
  ] as const satisfies readonly BaaExplainerTerm[],

  /**
   * Required, and it sits with the explanation rather than in a footer.
   *
   * A vendor explaining the law to a customer is genuinely useful and also
   * genuinely a place where "you told me it was fine" arguments start. Saying
   * plainly that this is a summary and that we are not their lawyer costs one
   * sentence and removes the ambiguity.
   */
  disclaimer:
    "This summary is a plain-English paraphrase, provided for convenience. It is not " +
    "legal advice and healdesk is not your lawyer. The agreement below is the operative " +
    "document; if the two differ, the agreement governs. Whether your practice is a " +
    "covered entity, and what HIPAA requires of you, are questions for your own counsel.",
} as const;

/** The clauses that have a note below. */
export type ExplainedClauseId =
  | "data-sources-none"
  | "google-calendar"
  | "google-calendar-covered"
  | "google-calendar-uncovered"
  | "google-calendar-not-used"
  | "minimum-necessary"
  | "subcontractors";

/**
 * Plain-English notes for the clauses that describe what the product does
 * rather than paraphrase the regulation, keyed by clause id, for the signing
 * screen to show beside the clause. Kept separate from `BAA_EXPLAINER.terms`
 * deliberately: those are pin-cited to 45 CFR 164.504(e), whereas these are
 * facts about the service — what healdesk reads, the Google Calendar access,
 * what the assistant collects, and the model provider's retention, which the
 * spec says a clinic must not have to discover from its own counsel. The same
 * rules apply — descriptive, never "you need this", and the agreement governs.
 *
 * ⚖️ Every note here must stay true to the clause it explains, in every
 * version that renders that clause id. The signing screen renders only the
 * current template (1.2.1 today, 1.3.0 once released), and two ids carry a
 * different body in each. The data-sources note is worded to hold for both:
 * it does not promise calendar access a manual booking system never grants.
 * The subcontractors note cannot be, because the notice period is the point
 * of it (fifteen days in 1.2.1, 24 hours in 1.3.0), so this map keeps
 * 1.2.1's note, word for word what the live checkout shows, and 1.3.0's is
 * in BAA_CLAUSE_EXPLAINERS_BY_VERSION; `clauseExplainer` picks between them.
 * The three calendar ids exist only in 1.3.0. The golden test in apps/app
 * freezes every version's bytes, and the clause body is the thing to read if
 * a note and a clause ever seem to disagree.
 */
export const BAA_CLAUSE_EXPLAINERS: Readonly<Record<ExplainedClauseId, BaaExplainerTerm>> = {
  "data-sources-none": {
    plain:
      "healdesk connects to no practice-management or point-of-sale system and holds no " +
      "credentials to one. The only patient information it receives is what patients give " +
      "it in a call or chat, plus whatever Google Calendar access the calendar clause describes",
    citation: "164.504(e)(2)(i)",
  },
  "google-calendar": {
    plain:
      "You connect your own Google Calendar with a Google login. healdesk reads when it is " +
      "free or busy, adds an appointment when the assistant books one (or when your staff " +
      "approve a request, if you set bookings to need approval), sends it a first name, the " +
      "service and the time — never a phone number or an email address — and never moves, " +
      "edits or cancels anything it did not create. Google's own agreement covers Calendar " +
      "only where your Workspace administrator has accepted it",
    citation: "164.502(b), 164.504(e)(2)(i)",
  },
  // 1.3.0: exactly one of the next three renders, chosen by the booking
  // system and the kind of Google account the practice named (calendar-terms.ts).
  // Both connected kinds name the calendar-list read beside the free/busy
  // one, as the clause does since the calendar-list permission was included
  // (owner, 6 October 2026).
  "google-calendar-covered": {
    plain:
      "You connect your own Google Calendar with a Google login, and you've told us your " +
      "Workspace administrator has accepted Google's business associate agreement — we can't " +
      "check that, so it is your statement. healdesk reads the names of your calendars, so you " +
      "can choose the one it books into, and when that calendar is free or busy; it adds each " +
      "booking (made by the assistant or confirmed by your staff) as a private event with a " +
      "first name, the service and the time — never a phone number, an email address or " +
      "anything clinical — and never touches anything it didn't create",
    citation: "164.502(b), 164.504(e)(2)(i)",
  },
  "google-calendar-uncovered": {
    plain:
      "Google's agreement doesn't cover this calendar (a personal Gmail account can't have " +
      "one). You are telling us to add bookings anyway — a first name, the service and the " +
      "time, as private events — and that disclosure to Google is yours to answer for. " +
      "healdesk reads the names of your calendars, so you can choose the one it books into, " +
      "and when that calendar is free or busy; it sends nothing else and stops adding " +
      "bookings as soon as you disconnect",
    citation: "164.502(a), 164.504(e)(2)(i)",
  },
  "google-calendar-not-used": {
    plain:
      "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
      "so healdesk doesn't connect to your calendar at all. The assistant takes each booking as " +
      "a request and your staff confirm it in your own system. Switching later means recording " +
      "a short calendar election",
    citation: "164.502(b)",
  },
  "minimum-necessary": {
    plain:
      "The assistant takes what a receptionist would write on a callback slip — a name, a " +
      "number or email, the service asked about and a preferred time — and asks for no " +
      "history, medication or diagnosis. It never takes a card number. It says it is an AI " +
      "assistant in its first line on every channel, and on calls that the call is " +
      "transcribed; you cannot switch that off",
    citation: "164.502(b)",
  },
  subcontractors: {
    plain:
      "Every vendor that handles patient information signs the same obligations with " +
      "healdesk before it does. The language model is Anthropic's: under its agreement with " +
      "healdesk it keeps conversation content for 30 days, for abuse detection and security, " +
      "then deletes it (content its safety systems flag, or the law requires it to keep, may " +
      "be held for up to two years), and never trains on it. You get fifteen days' notice before a new " +
      "vendor handles patient information, and may end the agreement if you object on " +
      "reasonable grounds",
    citation: "164.504(e)(2)(ii)(D), 164.308(b)(2)",
  },
};

/**
 * Notes for a clause id whose body says something different in one version
 * than in the one BAA_CLAUSE_EXPLAINERS describes, keyed by template version
 * and then clause id. 1.3.0's subcontractors clause gives 24 hours' notice
 * where 1.2.1's gives fifteen days, and its objection has to come before the
 * change takes effect, which in a day is the part that matters.
 */
export const BAA_CLAUSE_EXPLAINERS_BY_VERSION: Readonly<
  Record<string, Partial<Record<ExplainedClauseId, BaaExplainerTerm>>>
> = {
  "1.3.0": {
    subcontractors: {
      plain:
        "Every vendor that handles patient information signs the same obligations with " +
        "healdesk before it does. The language model is Anthropic's: under its agreement with " +
        "healdesk it keeps conversation content for 30 days, for abuse detection and security, " +
        "then deletes it (content its safety systems flag, or the law requires it to keep, may " +
        "be held for up to two years), and never trains on it. You're told by email at least " +
        `${SUBPROCESSOR_NOTICE_HOURS} hours before a new vendor handles patient information, ` +
        "and may end the agreement without penalty if you object on reasonable grounds before " +
        "the change takes effect",
      citation: "164.504(e)(2)(ii)(D), 164.308(b)(2)",
    },
  },
};

/**
 * The note to show beside one clause of one version, or undefined when that
 * clause has none. The signing screen is to look notes up through this, with
 * the version it renders. AgreementStep reads BAA_CLAUSE_EXPLAINERS directly
 * today, which is right only while it renders 1.2.1; it has to switch before
 * 1.3.0 is released (docs/counsel/agreement-changes.md §12.11).
 */
export function clauseExplainer(
  templateVersion: string,
  clauseId: string,
): BaaExplainerTerm | undefined {
  // Own keys only: "toString" is no clause.
  if (!Object.prototype.hasOwnProperty.call(BAA_CLAUSE_EXPLAINERS, clauseId)) return undefined;
  const id = clauseId as ExplainedClauseId;
  const forVersion = Object.prototype.hasOwnProperty.call(
    BAA_CLAUSE_EXPLAINERS_BY_VERSION,
    templateVersion,
  )
    ? BAA_CLAUSE_EXPLAINERS_BY_VERSION[templateVersion]
    : undefined;
  return forVersion?.[id] ?? BAA_CLAUSE_EXPLAINERS[id];
}
