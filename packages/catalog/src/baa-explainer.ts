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

/**
 * The bullets of "Why you're signing this" that 1.3.0 words differently,
 * keyed by the subparagraph they cite. 1.3.0's Term clause limits further
 * uses AND disclosures of what cannot be returned or destroyed (HRC-03), and
 * lets Practice terminate when Practice determines healdesk has violated a
 * material term (HRC-07), as 164.504(e)(2)(ii)(J) and (e)(2)(iii) say. The
 * Term clause of 1.2.1 and 1.2.2 (the same object) still says "use" and
 * "materially breaches", so BAA_EXPLAINER.terms keeps its bullets word for
 * word: a summary narrower than the clause beside
 * it, or than the regulation it cites, is the mis-citation the comment on
 * `terms` warns against (verification of the redraft, 7 October 2026).
 */
const TERMS_1_3_0: Readonly<Record<string, BaaExplainerTerm>> = {
  "164.504(e)(2)(ii)(J)": {
    plain:
      "At the end of the agreement, return or destroy the patient data we hold and keep " +
      "no copies — and where that is not feasible, keep protecting it under the same " +
      "terms and limit its use and disclosure to whatever makes return or destruction " +
      "infeasible",
    citation: "164.504(e)(2)(ii)(J)",
  },
  "164.504(e)(2)(iii)": {
    plain:
      "Let you terminate the agreement if you determine that we have violated a material term of it",
    citation: "164.504(e)(2)(iii)",
  },
};

/**
 * 1.3.0's nine bullets. 1.4.0, 1.5.0 and the 1.6.0 draft show the same list,
 * the same object: their Term clauses say the same in plain terms (1.6.0's
 * differs only in one phrase about Anthropic), no bullet speaks of
 * transcripts, and none of Anthropic's retention.
 */
const BULLETS_1_3_0: readonly BaaExplainerTerm[] = BAA_EXPLAINER.terms.map(
  (term) => TERMS_1_3_0[term.citation] ?? term,
);

/**
 * "Why you're signing this", for a version whose clauses the shared bullets
 * would understate, keyed by template version: the same nine bullets in the
 * same order, with the ones that version words differently replaced.
 */
export const BAA_EXPLAINER_TERMS_BY_VERSION: Readonly<Record<string, readonly BaaExplainerTerm[]>> =
  {
    "1.6.0": BULLETS_1_3_0,
    "1.5.0": BULLETS_1_3_0,
    "1.4.0": BULLETS_1_3_0,
    "1.3.0": BULLETS_1_3_0,
  };

/**
 * The bullets to show above one version of the agreement. The signing screen
 * is to read them through this, with the version it renders, as it reads the
 * clause notes through `clauseExplainer`: BAA_EXPLAINER.terms is right only
 * while it renders 1.2.2 or 1.2.1 (docs/counsel/agreement-changes.md §12.14,
 * release gate 11).
 */
export function baaExplainerTerms(templateVersion: string): readonly BaaExplainerTerm[] {
  // Own keys only: "toString" is no version.
  return Object.prototype.hasOwnProperty.call(BAA_EXPLAINER_TERMS_BY_VERSION, templateVersion)
    ? BAA_EXPLAINER_TERMS_BY_VERSION[templateVersion]!
    : BAA_EXPLAINER.terms;
}

/** "Why you're signing this" as a screen shows it: BAA_EXPLAINER's shape, with any version's bullets. */
export type BaaExplainer = {
  heading: string;
  lead: string;
  objection: string;
  terms: readonly BaaExplainerTerm[];
  disclaimer: string;
};

/** One explainer per version that words its bullets differently, built once. */
const BAA_EXPLAINERS_BY_VERSION: Readonly<Record<string, BaaExplainer>> = Object.fromEntries(
  Object.entries(BAA_EXPLAINER_TERMS_BY_VERSION).map(([version, terms]) => [
    version,
    { ...BAA_EXPLAINER, terms },
  ]),
);

/**
 * The whole of "Why you're signing this" for one version of the agreement,
 * its bullets from `baaExplainerTerms`: BAA_EXPLAINER itself for 1.2.2, the
 * version signed until 1.3.0's release, for 1.2.1 before it, and for any
 * version that words no bullet differently, so what that screen shows for
 * them stays byte for byte what it showed; for 1.3.0, 1.4.0 and 1.5.0, the
 * current version, the same heading, lead, objection and disclaimer above
 * 1.3.0's bullets.
 * The signing screen takes the explainer from here with the version it
 * renders, never BAA_EXPLAINER directly (agreement-changes.md §12.14, release
 * gate 11).
 */
export function baaExplainerFor(templateVersion: string): BaaExplainer {
  // Own keys only, as baaExplainerTerms: "toString" is no version.
  return Object.prototype.hasOwnProperty.call(BAA_EXPLAINERS_BY_VERSION, templateVersion)
    ? BAA_EXPLAINERS_BY_VERSION[templateVersion]!
    : BAA_EXPLAINER;
}

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
 * version that renders that clause id. The signing screen renders the
 * current template (1.3.0 since its release on 12 October 2026, which
 * replaced 1.2.2 outright; 1.2.2 before), and three ids carry a
 * different body in each: data-sources-none, minimum-necessary and
 * subcontractors. The pre-release audit of 6 October 2026 changed what each
 * of them says in 1.3.0 (the sources of patient information, the booking
 * fields and retention, Anthropic in covenant form and where a notice goes),
 * so this map keeps 1.2.1's notes, word for word what the checkout showed
 * for 1.2.1 and 1.2.2, and 1.3.0's are in BAA_CLAUSE_EXPLAINERS_BY_VERSION;
 * `clauseExplainer` picks between them. 1.2.2 shows the same notes as 1.2.1:
 * its clauses are 1.2.1's objects except reporting, subcontractors and
 * notices, and what the subcontractors note says (fifteen days' notice, the
 * objection, Anthropic's retention) is true of both; it says nothing of where
 * the list is kept, which is the only thing 1.2.2 changed in that clause.
 * The three calendar ids exist only in
 * 1.3.0, so their notes here are 1.3.0's. The golden test in apps/app freezes
 * every version's bytes, and the clause body is the thing to read if a note
 * and a clause ever seem to disagree.
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
  // (owner, 6 October 2026), and one calendar per provider; the covered note
  // names the organisation check before every booking, and the uncovered note
  // says "we treat", as the clause does (pre-release audit, 6 October 2026).
  "google-calendar-covered": {
    plain:
      "You connect your own Google account with a Google login, and you've told us your " +
      "Workspace administrator has accepted Google's business associate agreement — we can't " +
      "check that, so it is your statement. healdesk books only into calendars that belong to your " +
      "own Workspace organisation, and checks that before every booking. It reads the names of " +
      "your calendars, so you can choose the one it books into (or one per provider), and when " +
      "those calendars are free or busy; it adds each booking (made by the assistant or " +
      "confirmed by your staff) as a private event with the first name the person booking gave, " +
      "the service and the time — never a phone number, an email address or anything clinical " +
      "beyond the service's name — and never touches anything it didn't create",
    citation: "164.502(b), 164.504(e)(2)(i)",
  },
  "google-calendar-uncovered": {
    plain:
      "We treat this calendar as one Google's agreement doesn't cover (a personal Gmail account " +
      "can't have one). You are telling us to add bookings anyway — a first name, the service " +
      "and the time, as private events — and that disclosure to Google is yours to answer for. " +
      "healdesk reads the names of your calendars, so you can choose the one it books into (or " +
      "one per provider), and when those calendars are free or busy; it sends nothing else and " +
      "stops adding bookings as soon as you disconnect",
    citation: "164.502(a), 164.504(e)(2)(i)",
  },
  "google-calendar-not-used": {
    plain:
      "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
      "so healdesk doesn't connect to your calendar at all. The assistant takes each booking as " +
      "a request and your staff confirm it in your own system. Moving to a booking system that " +
      "checks Google Calendar for conflicts means recording a short calendar election",
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
 * and then clause id. In 1.3.0, after the pre-release audit of 6 October
 * 2026: the data-sources clause names every source of patient information,
 * the payment processor's notice included; the minimum-necessary clause lists
 * the booking fields the catalogue can ask, and never an email address; and
 * the subcontractors clause gives 24 hours' notice where 1.2.1's and 1.2.2's
 * give fifteen days, with an objection that has to come before the change takes effect,
 * which in a day is the part that matters, and states Anthropic's agreement
 * as a promise about when it is signed.
 *
 * In 1.4.0 the minimum-necessary clause also says that healdesk keeps no
 * transcript: each call's and website chat's goes to the practice's account
 * address by email, and healdesk's encrypted copy is deleted seven days after
 * the email first goes, after which the email is the practice's record (owner,
 * 13 October 2026). Its note says so; 1.4.0's other two notes are 1.3.0's,
 * the same objects, since those clauses are 1.3.0's own.
 *
 * In 1.5.0 that copy is deleted as soon as the practice's mail server
 * confirms delivery, kept and sent again until then, and never held past 30
 * days (owner, 14 October 2026). Its minimum-necessary note says so in place
 * of 1.4.0's seven days; its other two notes are 1.3.0's, as in 1.4.0.
 *
 * In the 1.6.0 draft (19 October 2026) the subcontractors clause states
 * Anthropic's retention as Anthropic's documentation states it for the models
 * the product calls: no more than the 30 days of its standard retention, the
 * two years for flagged content alone, content the law requires kept as long
 * as the law requires, and no training without healdesk's permission
 * (model-retention.ts; agreement-changes.md §16). Its subcontractors note
 * says the same; its other notes are 1.5.0's. 1.3.0's, 1.4.0's and 1.5.0's
 * subcontractors note stays as it is, because it must say what the clause
 * beside it says, and those clauses are frozen.
 */
const CLAUSE_NOTES_1_3_0: Partial<Record<ExplainedClauseId, BaaExplainerTerm>> = {
  "data-sources-none": {
    plain:
      "healdesk holds no credentials to your booking, practice-management or point-of-sale " +
      "system and reads nothing from one, apart from whatever Google Calendar access the " +
      "calendar clause describes. Patient information reaches healdesk from the conversations " +
      "themselves (with the number, messaging account or network address they come from), " +
      "from your staff through healdesk, and from your payment processor's notice that a " +
      "deposit link was paid",
    citation: "164.504(e)(2)(i)",
  },
  "minimum-necessary": {
    plain:
      "When someone books, the assistant asks only for what a receptionist would write on a " +
      "callback slip: a first name, a number you can call, a preferred time and one or two " +
      "others, and on calls, where your settings or your specialty's defaults ask for them, a " +
      "last name, the service, whether they're new or returning, consultation or treatment, " +
      "and a preferred practitioner. It asks for no email, history, medication or diagnosis, " +
      "and never takes a card number. It says it is an AI assistant in its first line on every " +
      "channel, and on calls that the call is transcribed; you cannot switch that off",
    citation: "164.502(b)",
  },
  subcontractors: {
    plain:
      "Every vendor that handles patient information signs the same obligations with " +
      "healdesk before it does. The language model is Anthropic's: it receives conversation " +
      "content only under a business associate agreement with healdesk, signed before any " +
      "patient's information reaches it, keeps that content for 30 days, for abuse detection " +
      "and security, then deletes it (content its safety systems flag, or the law requires it " +
      "to keep, may be held for up to two years), and never trains on it. You're told by email " +
      `at least ${SUBPROCESSOR_NOTICE_HOURS} hours before a new vendor handles patient ` +
      "information, and may end the agreement without penalty if you object on reasonable " +
      "grounds before the change takes effect: the service ends with it, and fees you paid " +
      "for the time after are refunded",
    citation: "164.504(e)(2)(ii)(D), 164.308(b)(2)",
  },
};

/** 1.5.0's notes: 1.3.0's, with the minimum-necessary note for its transcript copy. */
const CLAUSE_NOTES_1_5_0: Partial<Record<ExplainedClauseId, BaaExplainerTerm>> = {
  ...CLAUSE_NOTES_1_3_0,
  "minimum-necessary": {
    plain:
      "When someone books, the assistant asks only for what a receptionist would write on a " +
      "callback slip: a first name, a number you can call, a preferred time and one or two " +
      "others, and on calls, where your settings or your specialty's defaults ask for them, a " +
      "last name, the service, whether they're new or returning, consultation or treatment, " +
      "and a preferred practitioner. It asks for no email, history, medication or diagnosis, " +
      "and never takes a card number. It says it is an AI assistant in its first line on every " +
      "channel, and on calls that the call is transcribed; you cannot switch that off. " +
      "healdesk doesn't keep transcripts: when a call or website chat ends, its transcript is " +
      "emailed to your account's address, and healdesk deletes its encrypted copy as soon as " +
      "your mail server confirms delivery. If the email can't be delivered, healdesk keeps " +
      "trying for up to 30 days, then deletes the copy. From then on that email is your " +
      "practice's record, to keep and protect",
    citation: "164.502(b)",
  },
};

export const BAA_CLAUSE_EXPLAINERS_BY_VERSION: Readonly<
  Record<string, Partial<Record<ExplainedClauseId, BaaExplainerTerm>>>
> = {
  "1.6.0": {
    ...CLAUSE_NOTES_1_5_0,
    subcontractors: {
      plain:
        "Every vendor that handles patient information signs the same obligations with " +
        "healdesk before it does. The language model is Anthropic's: it receives conversation " +
        "content only under a business associate agreement with healdesk, signed before any " +
        "patient's information reaches it, keeps that content for no more than the 30 days of " +
        "its standard retention, then deletes it (content its safety systems flag may be held " +
        "for up to two years, and content the law requires it to keep for as long as the law " +
        "requires), and doesn't train on it without healdesk's permission, which healdesk won't " +
        `give. You're told by email at least ${SUBPROCESSOR_NOTICE_HOURS} hours before a new ` +
        "vendor handles patient information, and may end the agreement without penalty if you " +
        "object on reasonable grounds before the change takes effect: the service ends with it, " +
        "and fees you paid for the time after are refunded",
      citation: "164.504(e)(2)(ii)(D), 164.308(b)(2)",
    },
  },
  "1.5.0": CLAUSE_NOTES_1_5_0,
  "1.4.0": {
    ...CLAUSE_NOTES_1_3_0,
    "minimum-necessary": {
      plain:
        "When someone books, the assistant asks only for what a receptionist would write on a " +
        "callback slip: a first name, a number you can call, a preferred time and one or two " +
        "others, and on calls, where your settings or your specialty's defaults ask for them, a " +
        "last name, the service, whether they're new or returning, consultation or treatment, " +
        "and a preferred practitioner. It asks for no email, history, medication or diagnosis, " +
        "and never takes a card number. It says it is an AI assistant in its first line on every " +
        "channel, and on calls that the call is transcribed; you cannot switch that off. " +
        "healdesk doesn't keep transcripts: when a call or website chat ends, its transcript is " +
        "emailed to your account's address, and healdesk deletes its encrypted copy seven days " +
        "after the email goes. From then on that email is your practice's record, to keep and " +
        "protect",
      citation: "164.502(b)",
    },
  },
  "1.3.0": CLAUSE_NOTES_1_3_0,
};

/**
 * The note to show beside one clause of one version, or undefined when that
 * clause has none. The signing screen looks notes up through this, with the
 * version it renders: apps/web's agreement-kinds.ts does since the four-step
 * funnel (8d7fcd4), and AGREEMENT_COPY (agreement-copy.ts) hands it out as
 * `clauseNote`. The bullets above the agreement are `baaExplainerTerms`'s.
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
