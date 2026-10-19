import {
  agreementKindOfVersion,
  getBaaTemplate,
  getDpaTemplate,
  TRANSCRIPT_RETENTION_DAYS,
  type BaaVariables,
  type DpaVariables,
} from "@healdesk/catalog";

/**
 * What an agreement version says, read from its own clauses, for the jobs
 * that run for a clinic because its agreement promises it: the nightly
 * purge (lib/retention/purge.ts, purgeIsPromised) and the destruction after
 * offboarding (lib/offboarding, exportRuleIsPromised). Each version decides
 * by its own text, so a new one is never swept in, or left out, by a list
 * someone forgot to update: 1.2.2 was nearly purged with the switch off
 * because a list of earlier versions predated it (third review, 12 October
 * 2026). A version the catalog does not hold has no text, and promises
 * nothing.
 */

/** Any practice: every clause body is pure and total, and the sentences read here are the same for all. */
const SAMPLE_BAA: BaaVariables = {
  specialty: "med-spa",
  attributionMode: "estimated",
  connectedPlatform: null,
  isCoveredEntity: true,
  outboundMessaging: false,
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  clinicLegalName: "Practice",
  signatoryName: "Signatory",
  signatoryEmail: "signatory@practice.test",
  effectiveDate: "2026-01-01",
};
const SAMPLE_DPA: DpaVariables = {
  clinicLegalName: "Practice",
  signatoryName: "Signatory",
  signatoryEmail: "signatory@practice.test",
  effectiveDate: "2026-01-01",
  specialty: "med-spa",
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
};

const texts = new Map<string, string>();

/**
 * The clauses a sample practice's copy of the version contains, joined, with
 * line breaks folded so the 78-column wrap cannot split a sentence. The
 * retention and Term clauses apply to every practice in both agreements.
 * Empty for a version the catalog does not hold.
 */
export function agreementText(version: string): string {
  let text = texts.get(version);
  if (text === undefined) {
    const bodies =
      agreementKindOfVersion(version) === "dpa"
        ? (getDpaTemplate(version)?.clauses ?? [])
            .filter((c) => c.appliesWhen(SAMPLE_DPA))
            .map((c) => c.body(SAMPLE_DPA))
        : (getBaaTemplate(version)?.clauses ?? [])
            .filter((c) => c.appliesWhen(SAMPLE_BAA))
            .map((c) => c.body(SAMPLE_BAA));
    text = bodies.join(" ").replace(/\s+/g, " ");
    texts.set(version, text);
  }
  return text;
}

/**
 * The purge's periods, as an agreement has to state them to promise the
 * nightly purge: BAA 1.3.0's clause 11 and the DPA's "Minimum necessary"
 * clause (since 12 October 2026, docs/counsel/dpa.md gap 2) say each of
 * these, word for word, with TRANSCRIPT_RETENTION_DAYS. 1.2.2 and earlier say
 * only "keeps transcripts and conversation records for 90 days", which
 * promises no period for a booking request, an appointment or a contact.
 *
 * Each period is a list of the wordings that state it, any one of which
 * will do. Only the conversation's has two: BAA 1.4.0, 1.5.0 and 1.5.1 and
 * the DPA keep "the record of each conversation, without what was said or
 * written in it", since no transcript is kept (owner, 13 October 2026), where
 * 1.3.0 kept "each conversation, with its transcript". Both are the period
 * the purge runs for a conversation row, so a 1.4.0, 1.5.0 or 1.5.1 clinic is
 * purged whatever the switch says, as a 1.3.0 clinic is. 1.5.0's retention
 * paragraph is 1.4.0's word for word (it changes only how long the
 * transcript's copy waits, which the purge does not run), and 1.5.1's is
 * 1.5.0's (it changes only which channels ask for the optional booking
 * details).
 */
const PURGE_PERIODS: readonly (readonly string[])[] = [
  [
    `keeps each conversation, with its transcript, for ${TRANSCRIPT_RETENTION_DAYS} days after it took place`,
    `keeps the record of each conversation, without what was said or written in it, for ${TRANSCRIPT_RETENTION_DAYS} days after it took place`,
  ],
  [`each appointment record for ${TRANSCRIPT_RETENTION_DAYS} days after the appointment's time`],
  [
    `keeps each booking request for ${TRANSCRIPT_RETENTION_DAYS} days after the latest of when it was made, the time it was confirmed for and its appointment's time`,
  ],
  [
    `contact details are kept while any conversation, appointment record or booking request of theirs is kept, and in any case until ${TRANSCRIPT_RETENTION_DAYS} days after the last time those details were recorded or changed`,
  ],
];

/** Whether an agreement's own clauses state every one of the purge's periods. */
export function agreementStatesThePurge(version: string): boolean {
  const text = agreementText(version);
  return PURGE_PERIODS.every((wordings) => wordings.some((period) => text.includes(period)));
}

/**
 * The export rule, as an agreement has to state it to promise destruction
 * on it: the export delivered unasked within thirty days after the Services
 * end, and the data destroyed no later than ninety days after they end
 * whether or not it has been (BAA 1.3.0's Term clause; the DPA's "Term,
 * termination, and what happens to the information"). 1.2.2 and earlier
 * say "within thirty days of termination healdesk will return or destroy",
 * the thirty days.
 */
const EXPORT_RULE: readonly string[] = [
  "Within thirty days after the Services end, healdesk will deliver to Practice",
  "whether or not the export has been delivered",
];

/** Whether an agreement's own clauses state the export rule. */
export function agreementStatesTheExportRule(version: string): boolean {
  const text = agreementText(version);
  return EXPORT_RULE.every((sentence) => text.includes(sentence));
}
