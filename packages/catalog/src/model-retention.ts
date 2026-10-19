/**
 * What the language-model provider keeps of a patient conversation, said once.
 *
 * Every public page and every agreement that states the model provider's
 * retention reads it from here, because the wording drifted when each surface
 * kept its own copy. Finding A3 of the counsel log quoted Anthropic's
 * retention page with an ellipsis that cut out "As a result, if a chat or
 * session is flagged", which is what ties the two years to flagged content
 * alone, and its wording was then copied into the terms, the homepage FAQ,
 * /data-deletion, the subprocessor register, BAA 1.2.1 to 1.5.1 and the DPA.
 * Those copies gave law-required content a two-year cap Anthropic does not
 * state, gave the 30 days a purpose ("abuse detection and security") its pages
 * do not give for these models, and said the service "cannot run with shorter
 * retention", which Anthropic says only of its Covered Models
 * (docs/counsel/agreement-changes.md §17).
 *
 * What Anthropic's documentation says for the models the product calls,
 * checked on MODEL_RETENTION_VERIFIED_ON against MODEL_RETENTION_SOURCES:
 *
 *   - a HIPAA-ready API organisation runs under standard retention, and
 *     standard retention deletes inputs and outputs within 30 days (the
 *     platform page says conversation content is not retained by default for
 *     a model outside the Covered list; the privacy centre says "within 30
 *     days"; "no more than 30 days" is true under both);
 *   - content its automated trust-and-safety systems flag as violating its
 *     usage policy may be kept for up to two years;
 *   - it may keep what the law requires it to keep, and states no limit for
 *     that, so neither do we;
 *   - retained data is never used to train its models without the
 *     customer's express permission.
 *
 * That holds only for the models in PATIENT_MODEL_IDS. Anthropic's Covered
 * Models (Claude Fable 5 and 5.1, Claude Mythos 5 and 5.1) must keep content
 * for at least 30 days, so a patient channel moved onto one would make "no more
 * than 30 days" false in a signed agreement. apps/app's responder accepts a
 * model override only from this list for that reason, and
 * model-retention.test.ts fails if a Covered Model is added to it: moving to
 * one needs this wording, the terms and a new BAA version first.
 *
 * Vendor documentation changes without notice. The verified-on date fails the
 * test once it is a year old, as a stale source fails the editorial library,
 * but it cannot see a change in between: re-read the sources whenever the
 * model list changes, and against the executed Anthropic BAA and its HIPAA
 * Implementation Guide when the owner signs them (the BAA is the source of
 * truth Anthropic itself names).
 *
 * No dependencies and nothing patient-specific, like the rest of the catalog:
 * apps/web reads the public sentence, the agreements the other.
 */

/**
 * The models apps/app calls on the patient-data organisation's key: the web
 * chat and the Meta front door on Opus 5.5, calls on Sonnet 5.5
 * (lib/assistant/responder.ts), and the portal's support chat, which carries
 * no patient's words by design, on Opus 5.5 (lib/support/model.ts). None is a
 * Covered Model.
 */
export const PATIENT_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5"] as const;

export type PatientModelId = (typeof PATIENT_MODEL_IDS)[number];

export function isPatientModelId(value: unknown): value is PatientModelId {
  return typeof value === "string" && (PATIENT_MODEL_IDS as readonly string[]).includes(value);
}

/** The day the sentences below were last checked against the sources. */
export const MODEL_RETENTION_VERIFIED_ON = "2026-10-19";

/** Anthropic's pages the sentences below are read from. */
export const MODEL_RETENTION_SOURCES = [
  // Not retained by default outside the Covered Models; flagged content up to
  // two years; retention where the law requires it, with no period; no
  // training without express permission.
  "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
  // Standard retention: deleted within 30 days; flagged inputs and outputs up
  // to two years, their trust-and-safety scores up to seven.
  "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
  // The Covered Models (Fable and Mythos, 5 and 5.1), which keep content at
  // least 30 days; every other model keeps its configured retention.
  "https://support.claude.com/en/articles/15425695",
  // The HIPAA-ready API organisation operates with standard retention.
  "https://support.claude.com/en/articles/15455031",
] as const;

/** The most standard retention keeps conversation content, in days. */
export const MODEL_STANDARD_RETENTION_DAYS = 30;

/** The most flagged content may be kept, in years. */
export const MODEL_FLAGGED_RETENTION_YEARS = 2;

const STANDARD = `for no more than the ${MODEL_STANDARD_RETENTION_DAYS} days of its standard retention, and then deletes it`;

/**
 * The two exceptions, with the provider as "it". The two years belong to
 * flagged content alone; law-required content is kept as long as the law
 * requires, with no cap, because Anthropic states none.
 */
export const MODEL_RETENTION_EXCEPTIONS =
  `Two exceptions apply even then: content its automated trust-and-safety systems flag as ` +
  `violating its usage policy, which it may keep for up to two years, and content the law ` +
  `requires it to keep, which it may keep for as long as the law requires.`;

/**
 * The public pages' sentences, after one that names "our language-model
 * provider" and the business associate agreement it receives content under:
 * the provider is "it", and its name stays off the page (owner, 9 October
 * 2026). Terms § 9 prints it as it stands.
 */
export const MODEL_RETENTION_PUBLIC =
  `Under that agreement it keeps conversation content ${STANDARD}. ${MODEL_RETENTION_EXCEPTIONS} ` +
  `It does not use that content to train its models without our permission, which we do not give.`;

/**
 * The agreements' sentences, after one that names Anthropic and the business
 * associate agreement it receives content under: BAA 1.6.0's Subcontractors
 * clause and the DPA's. The caller adds healdesk's own covenant not to train
 * on the information, in its own document's word for it.
 *
 * The retention is Anthropic's standard retention, not a term of its business
 * associate agreement: nobody at healdesk has read that agreement yet (it is
 * signed in the HIPAA-ready organisation's Console, agreement-changes.md
 * § 17.5), and the sources describe the organisation, not the agreement's
 * text. Until 19 October 2026 the sentence began "Under that agreement
 * Anthropic keeps", which made the 30 days read as a promise in a contract
 * healdesk had not seen. The second sentence is why the window exists, which
 * the spec asks the clinic-facing agreement to say: the HIPAA-ready
 * organisation operates with standard retention and cannot also have zero
 * data retention (support article 15455031), and healdesk does not control
 * it. It says so of Anthropic's offering, never "cannot run with shorter
 * retention", which Anthropic says only of its Covered Models.
 */
export const MODEL_RETENTION_AGREEMENT =
  `Anthropic keeps conversation content ${STANDARD}. Anthropic offers its service under a ` +
  `business associate agreement only with that standard retention, which healdesk does not ` +
  `control. ${MODEL_RETENTION_EXCEPTIONS} ` +
  `Anthropic does not use that content to train its models without healdesk's permission, which ` +
  `healdesk will not give.`;
