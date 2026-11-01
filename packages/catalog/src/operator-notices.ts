/**
 * The closed vocabularies behind the notices an operator sends from /admin
 * (Annex X5 of docs/design/funnel-onboarding-portal-2026-10-06.md: L28 to
 * L31 and L33): what an incident report may say happened, which kinds of
 * information it may count, what was done about it, which subcontractor a
 * notice may name, what a terms notice may say changes, why a service may be
 * suspended, what can have failed under the guarantee, and the product
 * updates there are to announce.
 *
 * Why closed lists and not a text box. Every one of these emails goes
 * through Resend, which signs no business associate agreement, and the
 * sender refuses any payload holding something its allowlist does not class
 * (apps/app lib/email/lint.ts): ids, counts, dates and bare codes. An
 * operator writing an incident report under pressure is exactly who might
 * paste a caller's number into it. So the console sends a code, apps/app
 * checks the code is one of these, and the template prints the sentence the
 * code stands for. The words are written here once, read by the console's
 * forms (apps/web) and the emails (apps/app), and linted with the emails.
 *
 * Every sentence is about "people who contacted your practice" rather than
 * patients or clients, so one wording serves a medical practice and a
 * veterinary one. None of them may promise a reporting deadline: the
 * agreements promise "without unreasonable delay and in no case later than"
 * 10 "calendar days" (BAA 1.7.0, DPA 1.2.0) or 60 (BAA 1.2.2 to 1.6.0, DPA
 * 1.0.0 and 1.1.0), and healdesk's own 24-hour
 * target is internal (owner, 12 October 2026).
 *
 * Pure data, with no imports, so the console's client components can import
 * it.
 */

// -----------------------------------------------------------------------------
// L29: an incident report, built from fixed fields only
// -----------------------------------------------------------------------------

/** What happened: the first fixed field of an incident report (45 CFR 164.410(c)(1)). */
export const INCIDENT_REPORT_EVENTS = {
  misdirected_email: {
    label: "An email went to the wrong recipient",
    sentence:
      "An email carrying information about people who contacted your practice went to a recipient who should not have received it.",
  },
  unauthorized_account_access: {
    label: "Someone without permission signed in to the practice's account",
    sentence: "Someone without permission signed in to your practice's healdesk account.",
  },
  unauthorized_system_access: {
    label: "Someone without permission got into healdesk's systems",
    sentence:
      "Someone without permission got into a part of healdesk's systems that holds information about people who contacted your practice.",
  },
  software_fault: {
    label: "A fault in our software showed or sent information to the wrong person",
    sentence:
      "A fault in healdesk's software showed or sent information about people who contacted your practice to someone who should not have seen it.",
  },
  subcontractor_incident: {
    label: "A subcontractor reported an incident",
    sentence:
      "A company that runs part of the service for healdesk, under its own agreement with us, reported an incident affecting information it handles for your practice.",
  },
  lost_or_stolen_device: {
    label: "A team member's device was lost or stolen",
    sentence: "A device used by a member of healdesk's team was lost or stolen.",
  },
  malicious_software: {
    label: "Malicious software on a system we use",
    sentence: "Malicious software was found on a system healdesk uses to run the service.",
  },
  impermissible_use: {
    label: "Information used or disclosed for a purpose the agreement doesn't permit",
    sentence:
      "Information about people who contacted your practice was used or disclosed for a purpose your agreement with healdesk does not permit.",
  },
  other: {
    label: "Something else (describe it to the practice directly, then in an update)",
    sentence:
      "An incident that none of our standard descriptions fits. We'll describe it to you directly, and in an update to this report.",
  },
} as const;

export type IncidentReportEvent = keyof typeof INCIDENT_REPORT_EVENTS;

/**
 * The kinds of information an incident can involve, counted (45 CFR
 * 164.410(c)(2)'s "types of unsecured PHI"): what the assistant asks for
 * (BAA 1.5.0's Minimum necessary clause), what a conversation's transcript
 * and records hold, and the identifier Meta attaches. A count is an
 * aggregate, which Annex X1.1 allows; the identification of each person is
 * never emailed.
 */
export const INCIDENT_INFORMATION_TYPES = {
  first_name: { one: "first name", many: "first names" },
  last_name: { one: "last name", many: "last names" },
  phone_number: { one: "phone number", many: "phone numbers" },
  email_address: { one: "email address", many: "email addresses" },
  preferred_times: { one: "preferred appointment time", many: "preferred appointment times" },
  service_asked_about: { one: "service someone asked about", many: "services people asked about" },
  visit_details: {
    one: "set of visit details (new or returning, consultation or treatment, practitioner)",
    many: "sets of visit details (new or returning, consultation or treatment, practitioner)",
  },
  conversation_transcript: { one: "conversation transcript", many: "conversation transcripts" },
  conversation_record: {
    one: "conversation record, without its words",
    many: "conversation records, without their words",
  },
  booking_request: { one: "booking request", many: "booking requests" },
  appointment_record: { one: "appointment record", many: "appointment records" },
  messaging_identifier: {
    one: "messaging account identifier",
    many: "messaging account identifiers",
  },
} as const;

export type IncidentInformationType = keyof typeof INCIDENT_INFORMATION_TYPES;

/** What healdesk did, or is doing, about it (45 CFR 164.410(c)(2): investigate, mitigate, prevent). */
export const INCIDENT_MITIGATIONS = {
  access_revoked: "We revoked the access that was used.",
  credentials_rotated: "We changed the passwords and keys involved.",
  recipient_confirmed_deletion:
    "We asked the recipient to delete what they received, and they confirmed that they have.",
  fault_fixed: "We fixed the fault that caused it.",
  subcontractor_contained:
    "The subcontractor contained the incident and confirmed that to us in writing.",
  device_erased: "We erased the device remotely.",
  monitoring_added: "We added monitoring to catch it if it happens again.",
  investigating: "We're still investigating, and we'll add to this report as we learn more.",
  law_enforcement_informed: "We reported it to law enforcement.",
} as const;

export type IncidentMitigation = keyof typeof INCIDENT_MITIGATIONS;

/**
 * What the people affected can do to protect themselves (45 CFR
 * 164.410(c)(1)(D); the BAA's Reporting clause lists "any steps individuals
 * should take to protect themselves from potential harm resulting from the
 * breach" among what a breach report gives, and its Notices clause makes the
 * written notice the notice). Chosen by the operator on /admin/incidents for
 * the incident at hand, never typed; each is a step a person can take
 * whatever the information was, so none names anyone or anything clinical.
 */
export const INCIDENT_PATIENT_STEPS = {
  unexpected_contact:
    "Be wary of calls, texts and emails that mention their visit or say they come from your practice, and reach your practice through a number they already know before answering one.",
  confirm_details_requests:
    "Don't confirm personal details, a password or a payment to a message they weren't expecting.",
  tell_practice:
    "Tell your practice about any message that seems to come from it and that they didn't expect.",
  no_card_involved:
    "No card numbers were involved: AYA never takes them, so there's no card to cancel because of this.",
  nothing_needed:
    "As far as we know there's nothing they need to do: what was involved was deleted before anyone used it.",
} as const;

export type IncidentPatientStep = keyof typeof INCIDENT_PATIENT_STEPS;

/** What healdesk recommends the practice do, chosen the same way (the incident response's "what we recommend the clinic do"). */
export const INCIDENT_RECOMMENDATIONS = {
  assess_notice_duty:
    "Decide, with your own counsel if you have one, whether the law requires you to notify the people affected, and anyone else, and by when.",
  notify_people:
    "Notify the people affected, using the list of who it affected on this incident's page in healdesk.",
  brief_front_desk:
    "Let your front desk know to expect questions from the people affected, and how you'd like them answered.",
  review_access:
    "Check who on your team can open healdesk, and remove any device that no longer needs to.",
  check_address:
    "Check that your practice's address in healdesk is the inbox you intend, so reports like this reach the right people.",
  keep_record:
    "Keep this report with your own records of the incident.",
} as const;

export type IncidentRecommendation = keyof typeof INCIDENT_RECOMMENDATIONS;

/** The most rows one report may carry of either list: one per code. */
export const INCIDENT_REPORT_MAX_COUNT = 1_000_000;

// -----------------------------------------------------------------------------
// L29: notice of a subcontractor that will handle protected information
// -----------------------------------------------------------------------------

/**
 * The subcontractors that handle the information the agreements protect,
 * worded for the notice each agreement promises before one is added (BAA
 * 1.7.0 and DPA 1.2.0: at least fifteen days; BAA 1.3.0 to 1.6.0, DPA 1.0.0
 * and DPA 1.1.0: at least 24 hours; 1.2.2 and earlier: fifteen days;
 * subprocessor-notice.ts): the notice "names the subcontractor, what it will
 * receive and why". apps/web's internal register (src/lib/subprocessors.ts)
 * holds the same companies; its test holds every row that handles patient
 * information to an entry here, so a vendor added there can be announced.
 *
 * A new subcontractor is a code change before it is a notice: add its entry
 * here, with what it receives and why, and the console offers it.
 *
 * The list is never published or linked: it is given to a signed practice on
 * written request (owner, 9 October 2026).
 */
export const PHI_SUBCONTRACTORS = {
  aws: {
    name: "Amazon Web Services",
    receives:
      "the information the service stores for your practice, encrypted, and the emails that carry transcripts to you",
    why: "to host the service: its servers, its database and the transcript emails",
  },
  retell: {
    name: "Retell",
    receives:
      "each forwarded call's audio while the call is live, the caller's number, the call's transcript and a recording of the call, held only until healdesk has the transcript and for no more than a day",
    why: "to answer and transcribe the calls you forward to AYA",
  },
  anthropic: {
    name: "Anthropic",
    receives: "the words of each conversation and your practice's own service information",
    why: "to run the language model that writes AYA's replies",
  },
} as const;

export type PhiSubcontractor = keyof typeof PHI_SUBCONTRACTORS;

// -----------------------------------------------------------------------------
// L28: a change to the terms or to prices (Terms §4 and §16)
// -----------------------------------------------------------------------------

/** How many days ahead a terms notice must go (Terms §4 and §16). */
export const TERMS_NOTICE_DAYS = 30;

/** What a change to the terms is about, as the notice names it. */
export const TERMS_CHANGE_TOPICS = {
  fees: "your fees, or how they're charged",
  renewal: "renewal and cancellation",
  refunds: "refunds and the first-month guarantee",
  service: "what the service does and doesn't do",
  data: "how information about the people who contact you is handled",
  liability: "liability and indemnity",
  disputes: "governing law and disputes",
  general: "the general terms",
} as const;

export type TermsChangeTopic = keyof typeof TERMS_CHANGE_TOPICS;

// -----------------------------------------------------------------------------
// L31: a suspension for a legal or security reason (Terms §15)
// -----------------------------------------------------------------------------

/**
 * Why the service was suspended: Terms §15 lets healdesk suspend "immediately
 * if your use creates a legal or security risk, telling you why".
 */
export const SUSPENSION_CAUSES = {
  account_compromised: {
    label: "The practice's account looks compromised",
    sentence:
      "We saw signs that your practice's healdesk account, or an account connected to it, is being used by someone outside your practice.",
  },
  unlawful_use: {
    label: "The service is being used unlawfully",
    sentence: "The service was being used in a way that we believe breaks the law.",
  },
  legal_order: {
    label: "A court order or a regulator's direction",
    sentence:
      "We received a court order or a regulator's direction that requires us to suspend the service.",
  },
  abusive_traffic: {
    label: "Traffic meant to misuse the service",
    sentence:
      "Your assistant was receiving traffic meant to misuse it, which put the service and the information it holds at risk.",
  },
} as const;

export type SuspensionCause = keyof typeof SUSPENSION_CAUSES;

// -----------------------------------------------------------------------------
// L30: the first-month guarantee (Terms §5)
// -----------------------------------------------------------------------------

/** Business days after a claim within which the finding is due (Terms §5). */
export const GUARANTEE_FINDING_BUSINESS_DAYS = 10;

/** Days after a finding of a miss within which the refund is made (Terms §5). */
export const GUARANTEE_REFUND_WITHIN_DAYS = 14;

/** Our finding on a guarantee claim. */
export const GUARANTEE_OUTCOMES = {
  miss_found: "We found a missed call or message",
  no_miss_found: "We found no missed call or message",
} as const;

export type GuaranteeOutcome = keyof typeof GUARANTEE_OUTCOMES;

/**
 * What failed, when a call or message was missed: Terms §5 counts a miss
 * "whatever the cause of that failure", and names the suppliers as
 * "telephony and speech, the language model, and hosting".
 */
export const GUARANTEE_FAILURES = {
  our_software: "healdesk's own software",
  telephony_and_speech: "the telephony and speech supplier we use for calls",
  language_model: "the language model supplier we use",
  hosting: "the hosting the service runs on",
} as const;

export type GuaranteeFailure = keyof typeof GUARANTEE_FAILURES;

// -----------------------------------------------------------------------------
// L33: what changed in healdesk
// -----------------------------------------------------------------------------

/** The portal screens a product update may point to: the portal's six (spec, "Portal map"). */
export const PRODUCT_UPDATE_SCREENS = [
  "home",
  "settings",
  "knowledge",
  "conversations",
  "bookings",
  "billing",
] as const;

export type ProductUpdateScreen = (typeof PRODUCT_UPDATE_SCREENS)[number];

export type ProductUpdate = {
  /** How the console lists it. */
  label: string;
  subject: string;
  /** Changes to features the practice already has: transactional, never promotional (Annex X5, L33). */
  paragraphs: readonly string[];
  action: { label: string; screen: ProductUpdateScreen };
};

/**
 * The product updates there are to announce, each written and reviewed with
 * the change it describes, and linted with every other email. The console
 * sends one by its code; nothing typed in /admin reaches a practice.
 */
export const PRODUCT_UPDATES = {
  transcripts_by_email: {
    label: "Transcripts are emailed when a conversation ends",
    subject: "Transcripts arrive by email when a conversation ends",
    paragraphs: [
      "When a call or a website chat ends, AYA emails its transcript to your practice's address on healdesk, over an encrypted connection.",
      "healdesk keeps its copy only until your mail server confirms it has the email, and then deletes it. Conversations in your portal still show how each one ended and whether it led to a booking, with a receipt for each transcript email.",
    ],
    action: { label: "Open Conversations", screen: "conversations" },
  },
} as const satisfies Readonly<Record<string, ProductUpdate>>;

export type ProductUpdateCode = keyof typeof PRODUCT_UPDATES;

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

function isKeyOf<T extends object>(table: T, value: unknown): value is keyof T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

export const isIncidentReportEvent = (v: unknown): v is IncidentReportEvent =>
  isKeyOf(INCIDENT_REPORT_EVENTS, v);
export const isIncidentInformationType = (v: unknown): v is IncidentInformationType =>
  isKeyOf(INCIDENT_INFORMATION_TYPES, v);
export const isIncidentMitigation = (v: unknown): v is IncidentMitigation =>
  isKeyOf(INCIDENT_MITIGATIONS, v);
export const isIncidentPatientStep = (v: unknown): v is IncidentPatientStep =>
  isKeyOf(INCIDENT_PATIENT_STEPS, v);
export const isIncidentRecommendation = (v: unknown): v is IncidentRecommendation =>
  isKeyOf(INCIDENT_RECOMMENDATIONS, v);
export const isPhiSubcontractor = (v: unknown): v is PhiSubcontractor =>
  isKeyOf(PHI_SUBCONTRACTORS, v);
export const isTermsChangeTopic = (v: unknown): v is TermsChangeTopic =>
  isKeyOf(TERMS_CHANGE_TOPICS, v);
export const isSuspensionCause = (v: unknown): v is SuspensionCause =>
  isKeyOf(SUSPENSION_CAUSES, v);
export const isGuaranteeOutcome = (v: unknown): v is GuaranteeOutcome =>
  isKeyOf(GUARANTEE_OUTCOMES, v);
export const isGuaranteeFailure = (v: unknown): v is GuaranteeFailure =>
  isKeyOf(GUARANTEE_FAILURES, v);
export const isProductUpdateCode = (v: unknown): v is ProductUpdateCode =>
  isKeyOf(PRODUCT_UPDATES, v);
