import { createHash } from "node:crypto";

import { agreementKindOfVersion } from "./agreement-kind";
import {
  CALENDAR_CLAUSE_HEADING,
  CalendarTermsError,
  currentCalendarElection,
  prepareCalendarElection,
  selectCalendarClause,
  type CalendarClauseId,
  type CalendarElection,
  type CalendarElectionVariables,
  type CalendarTermsKind,
} from "./calendar-terms";
import { dpaCalendarClauseBody } from "./dpa";
import { wrap } from "./wrap";

/**
 * The calendar election that names the Data Protection Agreement (plan Part
 * L; docs/counsel/dpa.md, gap 6).
 *
 * The DPA's calendar clause, like BAA 1.3.0's, ends with the location
 * paragraph: any other location's calendar, and the first location's after a
 * change of booking system or of the kind of Google account, are governed by
 * the calendar election Practice records for it. The one election form,
 * `calendar-election/1.0.0` in calendar-terms.ts, takes the place of the
 * calendar clause "of the Business Associate Agreement", defines "this
 * agreement" as that BAA, and carries the clause in the BAA's words, which
 * call the person a booking is for a patient. A DPA practice could not
 * lawfully be handed it. This is the DPA's own, built beside the DPA from
 * calendar-terms.ts's exported pieces and frozen with its own golden hash
 * (dpa-calendar-election.test.ts):
 *
 *   - the same layout and the same three sections as the BAA's election, so
 *     the two read as one kind of instrument;
 *   - section 1 names the Data Protection Agreement, and nothing else;
 *   - section 2 is the calendar clause the selector chooses from the two
 *     answers, in the DPA's words (`dpaCalendarClauseBody`: the person a
 *     client, the event's quoted fallback word apart), without the location
 *     paragraph, as the BAA's election carries the BAA's clause;
 *   - it may amend only a DPA: an agreement version that is not a DPA's is
 *     refused, as is one the selector cannot choose a clause for.
 *
 * ## Unreleased, and nothing can record it yet
 *
 * `approvedByCounsel` is false, the flag the BAA's election and every
 * agreement carry: the owner releases it with the DPA, after reading it in
 * docs/dpa-v1.0.0.txt (Appendix B). Until then, as for the BAA's election, it
 * is to count only for a demo clinic (plan A10), and the database is to
 * refuse a draft row for anyone else (plan §11.6). Neither the election rows
 * nor the code that writes them is on main (the calendar session's plan C6
 * and C7), so today no election of either kind can be recorded at all, and a
 * DPA practice can neither add a location under calendar terms nor change a
 * location's booking system or account kind: `addLocation` answers
 * "not_available", `createLocationClinic` is a stub behind
 * `LOCATION_CLINICS_READY = false`, and nothing writes a location's booking
 * system. That refusal is to be kept until this form is released. Whatever
 * records an election takes its form from `calendarElectionFor`, by the
 * kind of the agreement in effect, never `currentCalendarElection()` alone.
 *
 * To revise: add a new entry at DPA_CALENDAR_ELECTIONS[0] with a new version.
 * Once released, never edit one; an election row's stored hash points at it.
 */

export const DPA_CALENDAR_ELECTION_VERSION = "calendar-election-dpa/1.0.0";

export const DPA_CALENDAR_ELECTIONS: readonly CalendarElection[] = [
  // Newest first; currentDpaCalendarElection() reads [0]. Drafted on 7
  // October 2026 and unreleased, so changed in place, with its golden hash,
  // until the owner releases it.
  {
    version: DPA_CALENDAR_ELECTION_VERSION,
    publishedOn: "2026-10-07",
    approvedByCounsel: false,
    // Literal, not the BAA election's sentences with a word swapped: a new
    // version of that form must not move this one's bytes.
    purpose:
      "For the location named above, this election takes the place of the Google Calendar " +
      "clause of the Data Protection Agreement between Practice and healdesk, from the date " +
      "below until Practice records another election for the location. Everything else in that " +
      "agreement is unchanged. Where that agreement does not itself provide for calendar " +
      "elections, the parties agree that this election supplements it. In the clause below, " +
      '"this agreement" means that Data Protection Agreement.',
    acceptance:
      "Accepted for Practice by the person named below, who confirms authority to bind Practice.",
  },
] as const;

export function currentDpaCalendarElection(): CalendarElection {
  return DPA_CALENDAR_ELECTIONS[0]!;
}

export function getDpaCalendarElection(version: string): CalendarElection | undefined {
  return DPA_CALENDAR_ELECTIONS.find((e) => e.version === version);
}

/**
 * The exact text a DPA practice accepts: renderCalendarElection's layout,
 * titled for the Data Protection Agreement, with the clause in the DPA's
 * words. Strict for the same reasons: an election that names nobody, or
 * amends an agreement it cannot amend, throws rather than renders.
 */
export function renderDpaCalendarElection(
  variables: CalendarElectionVariables,
  election: CalendarElection = currentDpaCalendarElection(),
): string {
  requireField(variables.clinicLegalName, "clinicLegalName");
  requireField(variables.locationName, "locationName");
  requireField(variables.agreementVersion, "agreementVersion");
  requireField(variables.signatoryName, "signatoryName");
  const agreementVersion = variables.agreementVersion.trim();
  if (agreementKindOfVersion(agreementVersion) !== "dpa") {
    throw new CalendarTermsError(
      `This election amends a Data Protection Agreement, not version ${agreementVersion}.`,
    );
  }
  const clause = dpaCalendarClauseBody({
    bookingSystem: variables.bookingSystem,
    calendarAccount: variables.calendarAccount,
  });
  const title = variables.signatoryTitle?.trim() ? `, ${variables.signatoryTitle.trim()}` : "";

  const text = [
    `CALENDAR ELECTION`,
    `to the healdesk Data Protection Agreement`,
    `Version ${election.version} — executed electronically`,
    ``,
    `PRACTICE`,
    wrap(`${variables.clinicLegalName.trim()} ("Practice")`),
    ``,
    `LOCATION`,
    wrap(variables.locationName.trim()),
    ``,
    `AGREEMENT`,
    wrap(`version ${agreementVersion}, effective ${formatDate(variables.agreementEffectiveDate)}`),
    ``,
    `1. WHAT THIS ELECTION DOES`,
    ``,
    wrap(election.purpose),
    ``,
    `2. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}`,
    ``,
    clause,
    ``,
    `3. ACCEPTANCE`,
    ``,
    wrap(election.acceptance),
    ``,
    `ACCEPTED FOR PRACTICE BY`,
    wrap(`${variables.signatoryName.trim()}${title}`),
    ``,
    `ACCEPTED ${formatDate(variables.electedOn)}`,
  ].join("\n");

  if (/\{\{/.test(text)) {
    throw new CalendarTermsError("Unsubstituted placeholder in the election text.");
  }
  return text;
}

/** SHA-256 hex of the exact rendered text, the digest every agreement and election uses. */
export function hashDpaCalendarElection(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render, hash and name the version and the variant in one step, as prepareCalendarElection does. */
export function prepareDpaCalendarElection(
  variables: CalendarElectionVariables,
  election: CalendarElection = currentDpaCalendarElection(),
): {
  text: string;
  hash: string;
  version: string;
  kind: CalendarTermsKind;
  clauseId: CalendarClauseId;
} {
  const text = renderDpaCalendarElection(variables, election);
  const { kind, clauseId } = selectCalendarClause({
    bookingSystem: variables.bookingSystem,
    calendarAccount: variables.calendarAccount,
  });
  return {
    text,
    hash: hashDpaCalendarElection(text),
    version: election.version,
    kind,
    clauseId,
  };
}

/**
 * The election form for the agreement a location is under, by that
 * agreement's kind: a DPA's own form for a `dpa/…` version, the BAA's for
 * any other. The one way to pick a form, so nothing that records an election
 * can hand a DPA practice the BAA's, and a DPA practice's election stays as
 * unreleased as its form is.
 */
export function calendarElectionFor(agreementVersion: string): CalendarElection {
  return agreementKindOfVersion(agreementVersion) === "dpa"
    ? currentDpaCalendarElection()
    : currentCalendarElection();
}

/** prepareCalendarElection or prepareDpaCalendarElection, by the kind of the agreement it amends. */
export function prepareCalendarElectionFor(
  variables: CalendarElectionVariables,
): ReturnType<typeof prepareDpaCalendarElection> {
  return agreementKindOfVersion(variables.agreementVersion.trim()) === "dpa"
    ? prepareDpaCalendarElection(variables)
    : prepareCalendarElection(variables);
}

function requireField(value: string | undefined, field: string): void {
  if (!value?.trim()) {
    throw new CalendarTermsError(`${field} is required to render the calendar election.`);
  }
}

/** "2026-10-06" → "6 October 2026". Mirrors calendar-terms.ts's formatDate, which is not exported. */
function formatDate(iso: string): string {
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new CalendarTermsError(`Invalid date: ${iso}`);
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
