import type { BookingSystemId } from "./booking-systems";
import type { CalendarAccount } from "./calendar-terms";
import { currentDpaTemplate, DPA_PRACTICE_DESCRIPTORS, prepareDpa, type DpaVariables } from "./dpa";
import { regimeFor, specialties } from "./specialties";
import { wrap } from "./wrap";

/**
 * docs/dpa-v1.0.0.txt, the text the owner reads to release the DPA, built
 * from the renderer so it can never drift from what a practice signs.
 *
 * `npm run dpa:review -w @healdesk/catalog` writes it, and dpa.test.ts fails
 * when the file in the repo is not exactly this. Any change to a clause the
 * DPA renders, its own or one it shares with the BAA, therefore regenerates
 * the file in the same commit, and the owner reads the text that would be
 * signed, not a copy of it.
 */

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

const VET_PRACTICE = "Golden Paws Veterinary LLC";
const RULE = "-".repeat(78);
const LIVE_SYSTEMS =
  '"Google Calendar only", "Calendly", "Cal.com", "HighLevel", "No booking system yet"';

type Entry = {
  caption: string;
  body: () => string;
};

function render(overrides: Partial<DpaVariables>): string {
  return prepareDpa(currentDpaTemplate(), { ...DPA_REVIEW_SAMPLE, ...overrides }).text;
}

/** One numbered clause of a rendered agreement, from its heading to the next clause's. */
function clause(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`The rendered DPA has no clause "${heading}".`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n\d+\. [A-Z]/);
  return (next === -1 ? rest : rest.slice(0, next + 1)).trimEnd();
}

function clauses(overrides: Partial<DpaVariables>, headings: readonly string[]): string {
  const text = render(overrides);
  return headings.map((h) => clause(text, h)).join("\n\n");
}

const DATA_SOURCES = "7. WHAT HEALDESK READS FROM YOUR SYSTEMS";
const CALENDAR = "8. PRACTICE'S GOOGLE CALENDAR";

function dataSources(bookingSystem: BookingSystemId): string {
  return clauses({ bookingSystem }, [DATA_SOURCES]);
}

function calendar(bookingSystem: BookingSystemId, calendarAccount: CalendarAccount): string {
  return clauses({ bookingSystem, calendarAccount }, [CALENDAR]);
}

const ENTRIES: readonly Entry[] = [
  {
    caption: `A veterinary practice ("${VET_PRACTICE}"; replaces clause 2 and changes clauses 1, 10 and 14; its preamble describes the practice as "${DPA_PRACTICE_DESCRIPTORS.veterinary}"):`,
    body: () =>
      clauses({ specialty: "veterinary", clinicLegalName: VET_PRACTICE }, [
        "1. DEFINITIONS",
        "2. PRACTICE'S STATUS",
        "10. MINIMUM NECESSARY, AND WHO RECEIVES CLIENT INFORMATION",
        "14. CONFIDENTIALITY",
      ]),
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
    caption: 'Bookings in "Google Calendar only" or "No booking system yet" (replaces clause 7):',
    body: () => dataSources("none"),
  },
  { caption: 'Bookings in "Calendly" (replaces clause 7):', body: () => dataSources("calendly") },
  { caption: 'Bookings in "Cal.com" (replaces clause 7):', body: () => dataSources("calcom") },
  {
    caption: 'Bookings in "HighLevel" (replaces clause 7):',
    body: () => dataSources("gohighlevel"),
  },
  { caption: 'Bookings in "Boulevard" (replaces clause 7):', body: () => dataSources("boulevard") },
  {
    caption: 'Bookings in "Something else" (replaces clause 7):',
    body: () => dataSources("other"),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a Google Workspace account whose administrator has accepted Google's business associate agreement (covered; replaces clause 8):`,
    body: () => calendar("google_calendar", "workspace_baa"),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a Google Workspace account without that agreement, or not sure (uncovered; replaces clause 8):`,
    body: () => calendar("google_calendar", "workspace_no_baa"),
  },
  {
    caption: `A booking system that reads Google Calendar (${LIVE_SYSTEMS}), with a personal Google account (uncovered; replaces clause 8):`,
    body: () => calendar("google_calendar", "personal"),
  },
  {
    caption:
      'Bookings in "Boulevard", which does not read Google Calendar, or is not confirmed to, whatever the Google account (not used; replaces clause 8):',
    body: () => calendar("boulevard", "personal"),
  },
  {
    caption:
      'Bookings in "Something else", which is not confirmed to read Google Calendar, whatever the Google account (not used; replaces clause 8):',
    body: () => calendar("other", "personal"),
  },
];

function header(): string {
  const template = currentDpaTemplate();
  const sample = prepareDpa(template, DPA_REVIEW_SAMPLE);
  const published = new Date(`${template.publishedOn}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return [
    `healdesk Data Protection Agreement — version ${template.version}, ${template.approvedByCounsel ? "RELEASED" : "DRAFT"}, rendered ${published} for the owner's release. Not released, so nothing can sign it: approvedByCounsel is false in packages/catalog/src/dpa.ts, which is the one switch. While it is false, agreementKindFor gives a practice that answers "No" the business associate agreement, as it always has, and refuses a veterinary practice, and provisioning refuses an account bound to an unreleased DPA. Nothing in the text marks it a draft, so releasing it moves no hash; an edit before release regenerates this file and the golden hashes in packages/catalog/src/dpa.test.ts in the same commit.`,
    `Who signs it (plan Part L): a veterinary practice, without being asked the covered-entity question; and a med spa, hair restoration, or massage and chiropractic practice that answers "No" to billing any health insurance electronically. "Not sure" signs the BAA, and so does every specialty HIPAA always reaches. Its launch-checklist items (Gate A): this text; vet readiness (the veterinary urgent set and its fixed reply, the emergency referral number, vet practice cases, client wording); and the supersede function for the "No" branch (app_supersede_agreement, drizzle/0051).`,
    `Rendered for a sample practice: a med spa that answered "No"; bookings in Mindbody, which does not read Google Calendar, so the calendar clause is the one under which healdesk connects nothing; and a personal Google account, which that clause does not depend on. From the title line on, the sample is exactly what packages/catalog/src/dpa.test.ts freezes as ${template.version} / sample (SHA-256 ${sample.hash}). The clauses that render only for some practices follow in the appendix, numbered as they render; nothing else in the text varies. What each sentence rests on in the code, and the gaps found, are in docs/counsel/dpa.md. Source: packages/catalog/src/dpa.ts, with the state-law and Payments clauses quoted from baa.ts, the calendar clause from calendar-terms.ts and the notice of a new subcontractor from subprocessor-notice.ts.`,
  ]
    .map((p) => wrap(p, ""))
    .join("\n\n");
}

/** The whole file, exactly as docs/dpa-v1.0.0.txt must hold it. */
export function dpaReviewDocument(): string {
  const appendix = ENTRIES.map(
    (entry, i) => `${wrap(`A${i + 1}. ${entry.caption}`, "")}\n\n${entry.body()}`,
  ).join("\n\n");
  return [
    header(),
    RULE,
    render({}).trimEnd(),
    RULE,
    `APPENDIX — CLAUSES THAT RENDER ONLY FOR SOME PRACTICES\n(not part of the sample above)`,
    appendix,
  ]
    .join("\n\n")
    .concat("\n");
}
