import { STATE_LAW_CLAUSE_HEADING } from "./baa";
import type { BookingSystemId } from "./booking-systems";
import {
  CALENDAR_CLAUSE_HEADING,
  type CalendarAccount,
  type CalendarElectionVariables,
} from "./calendar-terms";
import {
  DPA_NO_SMS_1_0,
  DPA_NO_SMS_1_1,
  DPA_PRACTICE_DESCRIPTORS,
  DPA_TEMPLATE_1_1_0_DRAFT,
  DPA_TEMPLATE_1_2_0_DRAFT,
  getDpaTemplate,
  prepareDpa,
  type DpaTemplate,
  type DpaVariables,
} from "./dpa";
import { currentDpaCalendarElection, prepareDpaCalendarElection } from "./dpa-calendar-election";
import { regimeFor, specialties } from "./specialties";
import { wrap } from "./wrap";

/**
 * docs/dpa-v1.0.0.txt, the released copy of the DPA (the owner read it to
 * release the DPA on 20 October 2026), built from the renderer so it can
 * never drift from what a practice signs.
 *
 * `npm run dpa:review -w @healdesk/catalog` writes it, and dpa.test.ts fails
 * when the file in the repo is not exactly this. Released, its clauses no
 * longer change: a clause the DPA shares with the BAA that moves would move
 * this file and the golden hashes, and dpa.test.ts fails on both, because a
 * change to a released agreement is a new version.
 *
 * docs/dpa-v1.1.0.txt is the first revision, released 30 October 2026
 * (dpaDraft110ReviewDocument, below), written by the same command and held to
 * the renderer the same way. Both files render a named version, never
 * "whatever is current", so releasing 1.1.0 moves neither file's agreement
 * text.
 */

/** dpa/1.0.0, the released text docs/dpa-v1.0.0.txt prints whatever is current. */
function template100(): DpaTemplate {
  const template = getDpaTemplate("dpa/1.0.0");
  if (!template) throw new Error("dpa/1.0.0 is not registered.");
  return template;
}

/** The sample practice: a med spa that answered "No", on Mindbody, with a personal Google account. */
export const DPA_REVIEW_SAMPLE: DpaVariables = {
  clinicLegalName: "Glow Med Spa LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@glowmedspa.test",
  effectiveDate: "2026-10-06",
  specialty: "med-spa",
  bookingSystem: "mindbody",
  calendarAccount: "personal",
};

/**
 * The sample practice's election for a second location, in Appendix B: the
 * uncovered clause, the longest, which shows every sentence the DPA's words
 * change, the quoted event word included. dpa-calendar-election.test.ts
 * freezes it.
 */
export const DPA_ELECTION_REVIEW_SAMPLE: CalendarElectionVariables = {
  clinicLegalName: DPA_REVIEW_SAMPLE.clinicLegalName,
  locationName: "Glow Med Spa, Main Street",
  agreementVersion: "dpa/1.0.0",
  agreementEffectiveDate: DPA_REVIEW_SAMPLE.effectiveDate,
  bookingSystem: "google_calendar",
  calendarAccount: "personal",
  signatoryName: DPA_REVIEW_SAMPLE.signatoryName,
  signatoryTitle: DPA_REVIEW_SAMPLE.signatoryTitle,
  electedOn: "2026-10-07",
};

const VET_PRACTICE = "Golden Paws Veterinary LLC";
const RULE = "-".repeat(78);
const LIVE_SYSTEMS =
  '"Google Calendar only", "Calendly", "Cal.com", "HighLevel", "No booking system yet"';

type Entry = {
  caption: string;
  body: (template?: DpaTemplate) => string;
};

function render(overrides: Partial<DpaVariables>, template: DpaTemplate = template100()): string {
  return prepareDpa(template, { ...DPA_REVIEW_SAMPLE, ...overrides }).text;
}

/** One numbered clause of a rendered agreement, from its heading to the next clause's. */
function clause(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`The rendered DPA has no clause "${heading}".`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n\d+\. [A-Z]/);
  return (next === -1 ? rest : rest.slice(0, next + 1)).trimEnd();
}

function clauses(
  overrides: Partial<DpaVariables>,
  headings: readonly string[],
  template?: DpaTemplate,
): string {
  const text = render(overrides, template);
  return headings.map((h) => clause(text, h)).join("\n\n");
}

const STATE_LAW = `5. ${STATE_LAW_CLAUSE_HEADING.toUpperCase()}`;
const DATA_SOURCES = "7. WHAT HEALDESK READS FROM YOUR SYSTEMS";
const CALENDAR = `8. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}`;

function dataSources(bookingSystem: BookingSystemId, template?: DpaTemplate): string {
  return clauses({ bookingSystem }, [DATA_SOURCES], template);
}

function calendar(
  bookingSystem: BookingSystemId,
  calendarAccount: CalendarAccount,
  template?: DpaTemplate,
): string {
  return clauses({ bookingSystem, calendarAccount }, [CALENDAR], template);
}

const ENTRIES: readonly Entry[] = [
  {
    caption: `A veterinary practice ("${VET_PRACTICE}"; replaces clause 2 and changes clauses 1, 10 and 14; its preamble describes the practice as "${DPA_PRACTICE_DESCRIPTORS.veterinary}"):`,
    body: (template) =>
      clauses(
        { specialty: "veterinary", clinicLegalName: VET_PRACTICE },
        [
          "1. DEFINITIONS",
          "2. PRACTICE'S STATUS",
          "10. MINIMUM NECESSARY, AND WHO RECEIVES CLIENT INFORMATION",
          "14. CONFIDENTIALITY",
        ],
        template,
      ),
  },
  {
    caption: "How the preamble describes the practice, by specialty (the sample's is the first):",
    body: () =>
      specialties
        .filter((s) => DPA_PRACTICE_DESCRIPTORS[s.id])
        .sort(
          (a, b) =>
            Number(regimeFor(a.id) === "non-hipaa") - Number(regimeFor(b.id) === "non-hipaa"),
        )
        .map((s) => `  ${s.name}:\n    ${DPA_PRACTICE_DESCRIPTORS[s.id]}`)
        .join("\n"),
  },
  {
    // The shared state-law clause follows the booking sync, as in BAA 1.3.0:
    // the sample's booking system does not read Google Calendar.
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), whatever the Google account (replaces clause 5):`,
    body: (template) => clauses({ bookingSystem: "google_calendar" }, [STATE_LAW], template),
  },
  {
    caption: 'Bookings in "Google Calendar only" or "No booking system yet" (replaces clause 7):',
    body: (template) => dataSources("none", template),
  },
  { caption: 'Bookings in "Calendly" (replaces clause 7):', body: (template) => dataSources("calendly", template) },
  { caption: 'Bookings in "Cal.com" (replaces clause 7):', body: (template) => dataSources("calcom", template) },
  {
    caption: 'Bookings in "HighLevel" (replaces clause 7):',
    body: (template) => dataSources("gohighlevel", template),
  },
  { caption: 'Bookings in "Boulevard" (replaces clause 7):', body: (template) => dataSources("boulevard", template) },
  {
    caption: 'Bookings in "Something else" (replaces clause 7):',
    body: (template) => dataSources("other", template),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a Google Workspace account whose administrator has accepted Google's business associate agreement (covered; replaces clause 8):`,
    body: (template) => calendar("google_calendar", "workspace_baa", template),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a Google Workspace account without that agreement, or not sure (uncovered; replaces clause 8):`,
    body: (template) => calendar("google_calendar", "workspace_no_baa", template),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a personal Google account (uncovered; replaces clause 8):`,
    body: (template) => calendar("google_calendar", "personal", template),
  },
  {
    caption:
      'Bookings in "Boulevard", which does not read Google Calendar, or is not confirmed to, whatever the Google account (not used; replaces clause 8):',
    body: (template) => calendar("boulevard", "personal", template),
  },
  {
    caption:
      'Bookings in "Something else", which is not confirmed to read Google Calendar, whatever the Google account (not used; replaces clause 8):',
    body: (template) => calendar("other", "personal", template),
  },
];

/** "2026-10-20" → "20 October 2026". */
function formatDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function header(): string {
  const template = template100();
  const sample = prepareDpa(template, DPA_REVIEW_SAMPLE);
  const published = formatDay(template.publishedOn);
  return [
    `healdesk Data Protection Agreement — version ${template.version}, ${template.approvedByCounsel ? "RELEASED" : "DRAFT"}, rendered ${published}, the day it was released. Approved for release by the owner, on the owner's own instruction and without external counsel (docs/counsel/agreement-changes.md §18, which recommends that counsel review it before the first live DPA practice): approvedByCounsel is true in packages/catalog/src/dpa.ts, and app_dpa_version_released lists ${template.version} (apps/app drizzle/0104_dpa_release_1_0_0). From that day agreementKindFor gives a practice that answers "No" this agreement where it gave the business associate agreement, checkout offers a veterinary practice, which it refused while there was no agreement for it to sign, and provisioning, and go-live's agreement check, accept an account bound to it. Drafted 6 October 2026; nothing in the text marked it a draft, so the release moved no hash. On 21 October 2026, before the text was pushed or any practice had signed it, the party block's label for healdesk's Delaware address changed from "of" to "with a mailing address for notices and correspondence at", so the text no longer describes a mailbox as where healdesk is; the party's identity, the Notices clause and every other sentence are unchanged, and the golden hashes were regenerated. Later on 21 October 2026, on the owner's explicit authorisation for this change alone and with the version number unchanged, clause 10 (Minimum necessary) changed in two sentences to say what healdesk's voice provider holds of a call: "No call audio is kept at all." became "healdesk keeps no call audio; its voice provider holds a call's recording only as this clause describes.", and the transcript paragraph gained, after the sentence on what Anthropic keeps, that the provider holds a call's transcript and recording only while the call runs and until healdesk has taken its own copy of the transcript, that healdesk then has the provider delete them, and that the provider's own retention for anything left is one day (docs/counsel/agreement-changes.md §19; counsel has not reviewed it). Every other sentence is unchanged, and the golden hashes were regenerated. It is frozen now: a change is a new version, never an edit, and packages/catalog/src/dpa.test.ts holds this file and the golden hashes to the renderer.`,
    `Who signs it (plan Part L): a veterinary practice, without being asked the covered-entity question; and a med spa, hair restoration, or massage and chiropractic practice that answers "No" to billing any health insurance electronically. "Not sure" signs the BAA, and so does every specialty HIPAA always reaches. A practice that signed this agreement and later answers "Yes" or "Not sure" is paused and signs the business associate agreement in its place (apps/app lib/agreements/resign.ts; app_supersede_agreement, drizzle/0051).`,
    `Rendered for a sample practice: a med spa that answered "No"; bookings in Mindbody, which does not read Google Calendar, so the calendar clause is the one under which healdesk connects nothing; and a personal Google account, which that clause does not depend on. From the title line on, the sample is exactly what packages/catalog/src/dpa.test.ts freezes as ${template.version} / sample (SHA-256 ${sample.hash}). The clauses that render only for some practices follow in Appendix A, numbered as they render; nothing else in the text varies. Appendix B is the calendar election that names this agreement, which its Definitions clause and its calendar clause refer to. What each sentence rests on in the code, and the gaps found, are in docs/counsel/dpa.md. Source: packages/catalog/src/dpa.ts, with the state-law and Payments clauses quoted from baa.ts, the calendar clause from calendar-terms.ts and the notice of a new subcontractor from subprocessor-notice.ts; the election is dpa-calendar-election.ts.`,
  ]
    .map((p) => wrap(p, ""))
    .join("\n\n");
}

/** Appendix B: what the election is, then the sample practice's, exactly as it would be accepted. */
function electionAppendix(): string {
  const election = currentDpaCalendarElection();
  const prepared = prepareDpaCalendarElection(DPA_ELECTION_REVIEW_SAMPLE, election);
  return [
    `APPENDIX B — THE CALENDAR ELECTION (${election.version}, ${election.approvedByCounsel ? "RELEASED" : "DRAFT"})`,
    wrap(
      `How a location's calendar terms change after signing, and how a second location gets calendar terms at all: the form this agreement's calendar clause sends both to, and its Definitions clause makes part of the agreement once accepted. Section 2 is the calendar clause that applies, in this agreement's words, without its location paragraph. Released with the agreement on ${formatDay(election.publishedOn)}, on the owner's own instruction and without external counsel: app_calendar_election_released lists it, so an election under it counts for every practice under this agreement, and the election guard records it only under a Data Protection Agreement, and the business associate agreement's form never under one (apps/app lib/booking/elections.ts, calendarElectionFor; drizzle/0104_dpa_release_1_0_0). Rendered for the sample practice electing a personal Google account for a second location; frozen as ${election.version} in packages/catalog/src/dpa-calendar-election.test.ts (SHA-256 ${prepared.hash}).`,
      "",
    ),
    prepared.text,
  ].join("\n\n");
}

/** Appendix A for one version: every clause that renders only for some practices. */
function variantAppendix(template: DpaTemplate): string {
  return ENTRIES.map(
    (entry, i) => `${wrap(`A${i + 1}. ${entry.caption}`, "")}\n\n${entry.body(template)}`,
  ).join("\n\n");
}

/** The whole file, exactly as docs/dpa-v1.0.0.txt must hold it. */
export function dpaReviewDocument(): string {
  const template = template100();
  return [
    header(),
    RULE,
    render({}, template).trimEnd(),
    RULE,
    `APPENDIX A — CLAUSES THAT RENDER ONLY FOR SOME PRACTICES\n(not part of the sample above)`,
    variantAppendix(template),
    RULE,
    electionAppendix(),
  ]
    .join("\n\n")
    .concat("\n");
}

/** docs/dpa-v1.1.0.txt's header: what the version is, what changed against 1.0.0, and who it applies to. */
function header110(): string {
  const template = DPA_TEMPLATE_1_1_0_DRAFT;
  const sample = prepareDpa(template, DPA_REVIEW_SAMPLE);
  const was = prepareDpa(template100(), DPA_REVIEW_SAMPLE);
  return [
    `healdesk Data Protection Agreement — version ${template.version}, RELEASED, drafted and released ${formatDay(template.publishedOn)}. Released by the owner, on the owner's own instruction ("release DPA 1.1.0 as well") and without external counsel: DPA_1_1_0_RELEASED is true in packages/catalog/src/dpa.ts, and app_dpa_version_released lists it (apps/app drizzle/0140_dpa_release_1_1_0). Checkout offered it from its release until dpa/1.2.0 took its place at DPA_TEMPLATES[0] (drizzle/0142_baa_release_1_7_0_dpa_1_2_0, docs/dpa-v1.2.0.txt); it stays released and frozen for every practice that signed it. A practice that signed dpa/1.0.0 stays on dpa/1.0.0: the product has no way for it to re-sign a newer DPA, and no payment-link text may go to a caller of a practice whose accepted agreement is older than this version. Drafted by an AI assistant on the owner's instruction and AI-reviewed; counsel has not reviewed it (docs/counsel/agreement-changes.md §21). It is frozen now: a change is a new version, never an edit.`,
    `What changed against dpa/1.0.0, and nothing else: the version line of the preamble, and the last two sentences of clause 9 (Safeguards), the telephone exception. dpa/1.0.0 says "${DPA_NO_SMS_1_0}" This version says "${DPA_NO_SMS_1_1}" The words are BAA 1.6.0's for the same text (packages/catalog/src/baa.ts, SAFEGUARDS_1_6), with the DPA's own "places no calls". Every other clause is 1.0.0's own, in 1.0.0's order, and renders byte for byte as docs/dpa-v1.0.0.txt prints it.`,
    `Rendered for the same sample practice as docs/dpa-v1.0.0.txt: a med spa that answered "No"; bookings in Mindbody; a personal Google account. From the title line on, the sample is exactly what packages/catalog/src/dpa.test.ts freezes as ${template.version} / sample (SHA-256 ${sample.hash}; dpa/1.0.0's is ${was.hash}). The clauses that render only for some practices follow in Appendix A, numbered as they render; none of them changed. The calendar election that names this agreement is Appendix B of docs/dpa-v1.0.0.txt (calendar-election-dpa/1.0.0), unchanged, which amends this version as it amends 1.0.0. Source: packages/catalog/src/dpa.ts (DPA_TEMPLATE_1_1_0_DRAFT, released through dpaTemplatesFor); written by npm run dpa:review -w @healdesk/catalog.`,
  ]
    .map((p) => wrap(p, ""))
    .join("\n\n");
}

/** docs/dpa-v1.2.0.txt's header: what the version is, why its number is 1.2.0, and what changed against 1.1.0. */
function header120(): string {
  const template = DPA_TEMPLATE_1_2_0_DRAFT;
  const sample = prepareDpa(template, DPA_REVIEW_SAMPLE);
  const was = prepareDpa(DPA_TEMPLATE_1_1_0_DRAFT, DPA_REVIEW_SAMPLE);
  return [
    `healdesk Data Protection Agreement — version ${template.version}, RELEASED, landed ${formatDay(template.publishedOn)}. Released by the owner: on 30 October 2026 he said "release BAA 1.7.0 and DPA 1.1.0" for this content, built that day on a branch as "dpa/1.1.0"; main released a different dpa/1.1.0 (the payment-link text) the same day and deployed it, and a released version is never edited, so this content landed as dpa/1.2.0, on top of it, on the owner's word of 1 November 2026 ("Go C13"), without external counsel. DPA_1_2_0_RELEASED is true in packages/catalog/src/dpa.ts, so DPA_TEMPLATES holds dpa/1.2.0 first, then dpa/1.1.0 and dpa/1.0.0, checkout offers dpa/1.2.0, and app_dpa_version_released lists it (apps/app drizzle/0142_baa_release_1_7_0_dpa_1_2_0). It applies to practices that sign from the release on; a practice that signed an earlier DPA stays on it. Drafted by an AI assistant on the owner's instruction and AI-reviewed; counsel has not reviewed it (docs/counsel/agreement-changes.md §21). It is frozen now: a change is a new version, never an edit.`,
    `What changed against dpa/1.1.0, on the owner's instruction of 30 October 2026 ("Breach notice of 60 days vs California's 'immediately': adjust whatever's needed"; "24 hours' notice before adding a new vendor: adjust whatever's needed"), and nothing else: the version line of the preamble and two sentences in two clauses. Clause 12, Reporting incidents and breaches: "in no case later than 60 calendar days after discovery" became "in no case later than 10 calendar days after discovery", "without unreasonable delay" still first. Clause 11, Subcontractors: "at least 24 hours' notice by email" became "at least 15 days' notice by email", with the same recipient, contents and right to object and terminate without penalty. The same two sentences changed in BAA 1.7.0. Every other clause is 1.1.0's own, in 1.1.0's order, the payment-link text in clause 9 included, and renders byte for byte as docs/dpa-v1.1.0.txt prints it.`,
    `Rendered for the same sample practice as docs/dpa-v1.0.0.txt: a med spa that answered "No"; bookings in Mindbody; a personal Google account. From the title line on, the sample is exactly what packages/catalog/src/dpa.test.ts freezes as ${template.version} / sample (SHA-256 ${sample.hash}; dpa/1.1.0's is ${was.hash}). The clauses that render only for some practices follow in Appendix A, numbered as they render; none of them changed. The calendar election that names this agreement is Appendix B of docs/dpa-v1.0.0.txt (calendar-election-dpa/1.0.0), unchanged, which amends this version as it amends 1.0.0 and 1.1.0. Source: packages/catalog/src/dpa.ts (DPA_TEMPLATE_1_2_0_DRAFT, released through dpaTemplatesFor) and subprocessor-notice.ts (subprocessorNoticeClauseBody15Days); written by npm run dpa:review -w @healdesk/catalog.`,
  ]
    .map((p) => wrap(p, ""))
    .join("\n\n");
}

/** The whole file, exactly as docs/dpa-v1.2.0.txt must hold it: 1.2.0, rendered from its template. */
export function dpaRelease120ReviewDocument(): string {
  const template = DPA_TEMPLATE_1_2_0_DRAFT;
  return [
    header120(),
    RULE,
    render({}, template).trimEnd(),
    RULE,
    `APPENDIX A — CLAUSES THAT RENDER ONLY FOR SOME PRACTICES\n(not part of the sample above)`,
    variantAppendix(template),
  ]
    .join("\n\n")
    .concat("\n");
}

/** The whole file, exactly as docs/dpa-v1.1.0.txt must hold it: 1.1.0, rendered from its template. */
export function dpaDraft110ReviewDocument(): string {
  const template = DPA_TEMPLATE_1_1_0_DRAFT;
  return [
    header110(),
    RULE,
    render({}, template).trimEnd(),
    RULE,
    `APPENDIX A — CLAUSES THAT RENDER ONLY FOR SOME PRACTICES\n(not part of the sample above)`,
    variantAppendix(template),
  ]
    .join("\n\n")
    .concat("\n");
}
