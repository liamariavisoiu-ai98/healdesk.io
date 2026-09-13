import { createHash } from "node:crypto";

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
 *     Those are different data flows and the permitted-uses clause has to say
 *     which one this clinic bought.
 *   - **Covered-entity status** decides which regime applies to both parties,
 *     and separately decides whether reactivation messaging can be switched on
 *     at all — the TCPA healthcare exemption is available only to a covered
 *     entity or its business associate.
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
 * ⚖️ Version 1.0.0 is counsel-approved and is what clinics now sign. The
 * 0.1.0-draft entry is retained below it, never offered: accounts created
 * before approval signed that exact text, and their stored hash has to keep
 * reproducing from it. That reproducibility is the whole reason the ASSEMBLED
 * document is hashed rather than the template.
 *
 * `approvedByCounsel` is now enforced rather than merely asserted —
 * provisionClinic() refuses to create a clinic against an unapproved template.
 * It is a no-op while 1.0.0 is current, and exists so the next revision in
 * progress cannot be signed into a live account by accident.
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
   * Carries the consent warranty, which is the only clause imposing an
   * obligation on the CLINIC. Under the TCPA that consent has to come from the
   * patient, and the clinic is the only party who could have obtained it.
   */
  outboundMessaging: boolean;
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
  /** True once counsel has approved this version. Provisioning refuses otherwise. */
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

/**
 * Wrap at 78 columns so the document reads the same in a browser and a text
 * file — the downloadable copy is plain text, and a contract that reflows
 * differently depending on where you opened it is a contract people mistrust.
 *
 * `hanging` indents continuation lines past a list marker. Without it,
 * "a. It holds the consents…" wraps back under the "a.", and the reader cannot
 * see where one lettered warranty ends and the next begins. In a clause that
 * imposes obligations on the SIGNER, that is not a cosmetic problem.
 */
function wrap(text: string, indent = "  ", hanging = indent): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = indent;
  let prefix = indent;

  for (const word of words) {
    if (line.length + word.length + 1 > 78 && line.trim() !== prefix.trim()) {
      lines.push(line);
      prefix = hanging;
      line = hanging + word;
    } else {
      line = line.trim() ? `${line} ${word}` : prefix + word;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

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
  // Newest first — CURRENT_BAA_VERSION and currentBaaTemplate() both read [0].
  {
    version: "1.0.0",
    publishedOn: "2026-09-05",
    approvedByCounsel: true,
    preamble: approvedPreamble,
    clauses: CLAUSES,
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
 */
export const BAA_ASSENT_LABEL =
  "I agree to the Business Associate Agreement and confirm the consent warranty above";

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
