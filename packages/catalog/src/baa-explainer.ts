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

/** The clauses of the current version (1.3.0) that have a note below. */
export type ExplainedClauseId =
  | "data-sources-none"
  | "google-calendar"
  | "payments"
  | "own-use"
  | "safeguards"
  | "minimum-necessary"
  | "subcontractors"
  | "acting-in-your-place"
  | "term"
  | "state-privacy-law";

/**
 * Plain-English notes for the clauses of the current version that describe
 * what the product does, or what 1.3.0 changed, rather than paraphrase the
 * regulation, keyed by clause id, for the signing screen to show beside the
 * clause. Kept separate from `BAA_EXPLAINER.terms` deliberately: those are
 * pin-cited to 45 CFR 164.504(e), whereas these are facts about the service —
 * what healdesk reads, the Google Calendar and payment access, what the
 * assistant collects, the model provider's retention, and what happens at the
 * end — which the spec says a clinic must not have to discover from its own
 * counsel. The same rules apply — descriptive, never "you need this", and the
 * agreement governs.
 *
 * ⚖️ Every note here must stay true to the clause it explains, and promise
 * nothing the clause does not. The golden test in apps/app freezes the 1.3.0
 * bytes, and the clause body is the thing to read if a note and a clause ever
 * seem to disagree. Most of these ids were also used by earlier versions with
 * different bodies; the notes describe the 1.3.0 body, and the signing screen
 * only ever renders the current template, so no earlier body is shown beside
 * them.
 */
export const BAA_CLAUSE_EXPLAINERS: Readonly<Record<ExplainedClauseId, BaaExplainerTerm>> = {
  "data-sources-none": {
    plain:
      "Apart from the payment-link access the Payments clause describes, healdesk holds no " +
      "credentials to any practice-management or point-of-sale system and reads nothing " +
      "from one. The only patient information it receives is what patients give it in a " +
      "call or chat, plus the calendar access the Google Calendar clause describes and the " +
      "payment status the Payments clause describes",
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
  payments: {
    plain:
      "healdesk never takes a patient's card number. If you connect your own payment " +
      "processor and switch deposits on, it may send a patient a link to a payment page " +
      "your processor hosts, in a website chat or a message conversation the patient " +
      "started — never on a call, where any deposit is left for your staff. The payment " +
      "goes into your own account, under your own agreement with the processor, which is " +
      "not healdesk's subcontractor. To make a link healdesk sends the processor an amount, " +
      "a generic description and a reference code, and nothing else about the patient or " +
      "the appointment, and it uses its access only to create links and learn whether they " +
      "were paid. It creates no customer record or invoice and saves no card",
    citation: "164.502(b), 164.506(c)(1)",
  },
  "own-use": {
    plain:
      "healdesk may use patient information where necessary for its own proper management " +
      "and administration and its legal duties, and disclose it for those purposes only " +
      "where the law requires it or the recipient has assured healdesk it will keep it " +
      "confidential, use it only for that purpose or as the law requires, and report any " +
      "breach. It may de-identify your patients' information to the HIPAA standard and " +
      "combine it with other practices' de-identified information only to produce " +
      "aggregate statistics about the service. It will not re-identify, or try to " +
      "re-identify, anyone from it, and never uses patient information to train, fine-tune " +
      "or evaluate a model",
    citation: "164.504(e)(4), 164.514(b)",
  },
  safeguards: {
    plain:
      "Patient information is encrypted at rest, and in transit wherever healdesk controls " +
      "both ends. An email whose receiving server will not negotiate encryption is not sent, " +
      "and you are told; the list of patients in a breach report goes by secure transfer, " +
      "never in the email. The one exception is a patient who telephones: a phone call is " +
      "not end-to-end encrypted, so healdesk answers it with the minimum necessary, never " +
      "including clinical detail, test results or card or bank details. healdesk places no " +
      "calls and sends no SMS",
    citation: "164.312(a)(2)(iv), (e)(2)(ii)",
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
  "acting-in-your-place": {
    plain:
      "Answering a patient who calls, and replying in your name to a patient who writes, " +
      "are your practice's own duties carried out through healdesk. Where healdesk carries " +
      "out an obligation the HIPAA Privacy Rule places on you, it meets the requirements " +
      "the Rule places on you, not only the lighter ones it places on a business associate",
    citation: "164.504(e)(2)(ii)(H)",
  },
  term: {
    plain:
      "Within thirty days of the agreement ending, healdesk delivers you an export of the " +
      "patient information it holds for you, then destroys that information and keeps no " +
      "copies: at day thirty if the export has been delivered by then, otherwise as soon " +
      "as it is, and never later than ninety days after the end. Until then the agreement " +
      "still protects it. Where destruction is not feasible, healdesk says why in writing, " +
      "keeps protecting what it holds and uses it only for what makes destruction " +
      "infeasible. The signed agreement and the record of disclosures are kept for six years",
    citation: "164.504(e)(2)(ii)(J), 164.530(j)",
  },
  "state-privacy-law": {
    plain:
      "Applies for any period in which your practice is not a HIPAA covered entity, " +
      "whatever you told healdesk when you signed. healdesk is then your service provider " +
      "and processor under the California, Washington, Nevada and Connecticut privacy " +
      "laws, to the extent each applies: it uses your patients' information only for the " +
      "purposes the clause lists, never sells or shares it as California defines those " +
      "words, gives you what you need to answer people's requests within ten business " +
      "days, deletes what you tell it to within ten business days (from backups within six " +
      "months), and tells you of a breach immediately following discovery where a state law " +
      "requires that",
    citation: "Cal. Civ. Code 1798.100(d); RCW 19.373.060",
  },
};
