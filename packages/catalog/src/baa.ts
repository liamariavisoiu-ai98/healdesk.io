import { createHash } from "node:crypto";

/**
 * The click-through business associate agreement.
 *
 * Self-serve acquisition requires this to be click-through: if signing needs a
 * lawyer on a call, the funnel isn't automated. Two consequences follow, and
 * both shape this file.
 *
 * **The document is per-clinic, so the record has to be per-clinic too.** The
 * agreement names the practice, the person signing, their title, and the
 * effective date. That means there is no single "the BAA text" to hash — the
 * hash has to cover the exact rendered document that specific person saw. A
 * template version alone would not answer "what did they actually agree to",
 * which is the only question that matters when someone disputes it years later.
 *
 * **Rendering happens on the server, never in the browser.** The client is
 * shown the rendered text, but the copy that is hashed and stored is produced
 * again server-side from the stored variables. Otherwise the record is only as
 * trustworthy as a form field, and a defendant cannot testify to what the
 * screen displayed.
 *
 * ⚖️ THE TEMPLATE BELOW IS A PLACEHOLDER AND MUST BE REPLACED BY COUNSEL BEFORE
 * ANY REAL CLINIC SEES IT. It is deliberately marked as a draft in its own body
 * so it cannot be mistaken for a reviewed agreement, and `approvedByCounsel`
 * is false so provisioning refuses to classify a clinic as production. What is
 * production-ready is the machinery: templating, versioning, hashing, and an
 * append-only acceptance record captured BEFORE payment.
 *
 * To publish a revision: add a new entry, never edit an existing one. The text
 * of a released version is a historical fact, and someone has signed it.
 */

export type BaaVariables = {
  /** The practice's legal name, as it will appear in the agreement. */
  clinicLegalName: string;
  /** Typed by the signer. This is the signature. */
  signatoryName: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  /** ISO date. The day they signed, not the day the template was published. */
  effectiveDate: string;
  /** Display name, e.g. "Med spa". */
  specialty: string;
  /**
   * Whether the practice bills insurance electronically.
   *
   * Null means they didn't know, which is a real and common answer — and it
   * changes which paragraph applies, so it is rendered rather than guessed.
   * See docs/research-conclusions.md, Part 3: this one determination decides
   * the contract, the consent standard, and the state-law exposure.
   */
  isCoveredEntity: boolean | null;
};

export type BaaTemplate = {
  version: string;
  /** When this template version was published. Not when anyone signed it. */
  publishedOn: string;
  /** True once counsel has approved this version. Provisioning refuses otherwise. */
  approvedByCounsel: boolean;
  /** Contains {{variable}} placeholders. Render with renderBaa(). */
  body: string;
};

export class BaaRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaaRenderError";
  }
}

const DRAFT_BODY = `HEALDESK BUSINESS ASSOCIATE AGREEMENT
Version {{version}} · Effective {{effectiveDate}}

⚠️ DRAFT — NOT FOR EXECUTION. This template has not been reviewed by counsel
and does not create a business associate relationship. Accounts created against
it are restricted to synthetic data, and the database enforces that
independently of this document.

BETWEEN
  {{clinicLegalName}} ("Covered Entity"), a {{specialty}} practice
  healdesk ("Business Associate")

SIGNED BY
  {{signatoryName}}{{signatoryTitleClause}}
  {{signatoryEmail}}

COVERED ENTITY STATUS
{{coveredEntityClause}}

THE EXECUTED AGREEMENT WILL ADDRESS, AT MINIMUM

  1. Permitted uses and disclosures of protected health information, limited to
     what is necessary to provide the service.
  2. Safeguards consistent with the HIPAA Security Rule.
  3. Reporting of security incidents and breaches to {{clinicLegalName}},
     including the timeline for doing so.
  4. Obligations flowed down to healdesk's own subcontractors that handle
     protected health information.
  5. Access, amendment, and accounting of disclosures.
  6. Return or destruction of protected health information on termination.
  7. Availability of records to the Secretary of Health and Human Services.

WHAT HEALDESK IS NOT AUTHORISED TO DO
  · Use protected health information to train, fine-tune, or evaluate any
    artificial intelligence model, its own or a third party's.
  · Disclose protected health information to any advertising platform, in any
    form, including hashed or aggregated.
  · Provide clinical advice, diagnosis, triage, or treatment recommendations
    through the agent.

This draft is shown so the signing mechanism can be exercised end to end before
counsel delivers the final text. Nothing in it is legal advice, and healdesk is
not your lawyer.`;

/**
 * v0.0.1 — adds the outbound-contact warranty.
 *
 * The product sends appointment reminders and reactivation messages on the
 * clinic's behalf from launch. Under the TCPA, consent to receive those has to
 * come from the RECIPIENT — the patient — and the clinic is the party that
 * obtained it at intake. healdesk never speaks to the patient beforehand, so
 * there is no route by which we could hold it ourselves.
 *
 * A bare "I accept the BAA" tick does not supply this. It establishes our right
 * to process the clinic's data and nothing more, which would leave the entire
 * outbound feature resting on no consent basis at all — and the liability for a
 * $500–1,500-per-message claim landing on us rather than on the party that
 * actually holds the consents.
 *
 * So the warranty lives in the signed document rather than in a separate
 * checkbox: it is hashed, stored, and reproducible with everything else. The
 * assent label names it too, because what the button said is what makes a
 * clickwrap enforceable.
 */
const DRAFT_BODY_V1 = `${DRAFT_BODY}

OUTBOUND CONTACT, AND WHO HOLDS THE PATIENTS' CONSENT

  healdesk sends appointment reminders, confirmations, missed-call follow-ups
  and reactivation messages to {{clinicLegalName}}'s patients, by call and by
  text, on {{clinicLegalName}}'s behalf and in its name.

  By signing, {{clinicLegalName}} warrants that:

    a. It holds the consents required to contact those patients for the
       purposes above, obtained from the patients themselves.
    b. Its consent for promotional or reactivation messaging is prior express
       WRITTEN consent, which is the standard the law applies to marketing
       regardless of how the message is worded.
    c. It authorises healdesk to send those messages as its agent.
    d. It will tell healdesk promptly when a patient withdraws consent by any
       route — in the clinic, by phone, or in writing.

  healdesk will, on every message and every call: honour STOP and any other
  plainly worded withdrawal, suppress the number across all channels, respect
  quiet hours in the patient's own local time, and hold to the frequency limits
  the healthcare exemption requires.

  Note that the exemption relied on in (b) is available only to a HIPAA covered
  entity or its business associate. Where the covered-entity determination above
  is "no" or "not yet determined", healdesk will not switch on reactivation
  messaging until that question is settled.`;

export const BAA_TEMPLATES: readonly BaaTemplate[] = [
  // Newest first — CURRENT_BAA_VERSION and currentBaaTemplate() both read [0].
  {
    version: "0.0.1-draft",
    publishedOn: "2026-08-18",
    approvedByCounsel: false,
    body: DRAFT_BODY_V1,
  },
  {
    version: "0.0.0-draft",
    publishedOn: "2026-08-18",
    approvedByCounsel: false,
    body: DRAFT_BODY,
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

export function getBaaTemplate(version: string): BaaTemplate | undefined {
  return BAA_TEMPLATES.find((t) => t.version === version);
}

export function currentBaaTemplate(): BaaTemplate {
  return BAA_TEMPLATES[0]!;
}

/**
 * Substitute the per-clinic values into a template.
 *
 * Deliberately strict in both directions. An unknown placeholder throws rather
 * than rendering empty, because a customer must never be shown a contract with
 * a literal `{{clinicLegalName}}` in it — and a silently-empty substitution is
 * worse, since it looks fine and names nobody.
 */
export function renderBaa(
  template: BaaTemplate,
  variables: BaaVariables,
): string {
  const values: Record<string, string> = {
    version: template.version,
    effectiveDate: formatDate(variables.effectiveDate),
    clinicLegalName: required(variables.clinicLegalName, "clinicLegalName"),
    signatoryName: required(variables.signatoryName, "signatoryName"),
    signatoryEmail: required(variables.signatoryEmail, "signatoryEmail"),
    specialty: required(variables.specialty, "specialty").toLowerCase(),
    signatoryTitleClause: variables.signatoryTitle?.trim()
      ? `, ${variables.signatoryTitle.trim()}`
      : "",
    coveredEntityClause: coveredEntityClause(variables),
  };

  return template.body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new BaaRenderError(
        `Template ${template.version} references {{${key}}}, which has no value. ` +
          `Every placeholder must resolve — a contract must never be shown with an ` +
          `unsubstituted or silently empty field.`,
      );
    }
    return value;
  });
}

/**
 * The paragraph that changes with covered-entity status.
 *
 * Three outcomes, not two. "We don't know yet" is the honest answer for a
 * cash-pay clinic that has never thought about it, and pretending otherwise in
 * a signed document is worse than saying so — this is the determination that
 * decides which law applies to both parties.
 */
function coveredEntityClause(variables: BaaVariables): string {
  const name = variables.clinicLegalName.trim();

  if (variables.isCoveredEntity === true) {
    return (
      `  ${name} has confirmed that it transmits health information ` +
      `electronically in connection with a transaction covered by HIPAA, and is\n` +
      `  therefore a covered entity. This agreement governs.`
    );
  }

  if (variables.isCoveredEntity === false) {
    return (
      `  ${name} has confirmed that it does NOT transmit health information\n` +
      `  electronically in connection with a HIPAA-covered transaction, and may\n` +
      `  therefore not be a covered entity. healdesk applies the same safeguards\n` +
      `  regardless. Note that state consumer-health-privacy law may still apply\n` +
      `  to both parties, and in some states carries a private right of action.`
    );
  }

  return (
    `  ${name} has not yet determined whether it is a covered entity. healdesk\n` +
    `  applies the same safeguards either way, and will confirm the determination\n` +
    `  before any real patient information is processed.`
  );
}

/**
 * SHA-256 of the exact rendered text.
 *
 * Recorded alongside every acceptance so "what did they actually agree to"
 * survives both the template changing and the clinic renaming itself.
 */
export function hashBaaText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Render and hash in one step, so the two can never drift apart.
 *
 * Callers that hash separately eventually hash something subtly different from
 * what they rendered — a trimmed string, a different date format — and the
 * record silently stops matching the document.
 */
export function prepareBaa(
  template: BaaTemplate,
  variables: BaaVariables,
): { text: string; hash: string; version: string } {
  const text = renderBaa(template, variables);
  return { text, hash: hashBaaText(text), version: template.version };
}

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new BaaRenderError(`${field} is required to render the agreement.`);
  }
  return trimmed;
}

/** "2026-08-18" → "18 August 2026". Unambiguous across US/EU readers. */
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
