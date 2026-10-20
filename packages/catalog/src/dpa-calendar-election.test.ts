import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { BOOKING_SYSTEMS, type BookingSystemId } from "./booking-systems";
import {
  CALENDAR_ACCOUNTS,
  CALENDAR_CLAUSE_HEADING,
  CALENDAR_ELECTION_VERSION,
  CALENDAR_LOCATION_PARAGRAPH,
  CalendarTermsError,
  currentCalendarElection,
  prepareCalendarElection,
  selectCalendarClause,
  type CalendarElectionVariables,
} from "./calendar-terms";
import { CALENDAR_EVENT_FALLBACK_QUOTED, currentDpaTemplate, prepareDpa } from "./dpa";
import {
  calendarElectionFor,
  currentDpaCalendarElection,
  DPA_CALENDAR_ELECTION_VERSION,
  DPA_CALENDAR_ELECTIONS,
  getDpaCalendarElection,
  hashDpaCalendarElection,
  prepareCalendarElectionFor,
  prepareDpaCalendarElection,
  renderDpaCalendarElection,
} from "./dpa-calendar-election";
import { DPA_ELECTION_REVIEW_SAMPLE, DPA_REVIEW_SAMPLE } from "./dpa-review";
import { wrap } from "./wrap";

/**
 * The calendar election that names the Data Protection Agreement
 * (docs/counsel/dpa.md, gap 6): what it must say on every variant, read out
 * of the rendered text, and its golden hash. Released with the DPA by the
 * owner on 20 October 2026, which moved no hash; from then on a change is a
 * new version at DPA_CALENDAR_ELECTIONS[0].
 */

/** The review sample's election (Appendix B), frozen from the draft and released unchanged. */
const GOLDEN_SAMPLE = "ee7dec03829f090cd7dcf43c2529a21c0463f2f14b4e262ee376253f5e709007";

const SYSTEMS = BOOKING_SYSTEMS.map((s) => s.id) as BookingSystemId[];

/** Every election the two answers can produce, for the review sample's practice. */
function everyElection(): CalendarElectionVariables[] {
  return SYSTEMS.flatMap((bookingSystem) =>
    CALENDAR_ACCOUNTS.map((calendarAccount) => ({
      ...DPA_ELECTION_REVIEW_SAMPLE,
      bookingSystem,
      calendarAccount,
    })),
  );
}

const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

/** Section 2 of an election: the clause, between its heading and section 3. */
function clauseOf(text: string): string {
  const start = text.indexOf(`2. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}\n\n`);
  const end = text.indexOf("\n\n3. ACCEPTANCE");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + `2. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}\n\n`.length, end);
}

describe("the DPA's calendar election", () => {
  test("is registered once, versioned like the BAA's, and released with the DPA", () => {
    expect(DPA_CALENDAR_ELECTIONS.map((e) => e.version)).toEqual(["calendar-election-dpa/1.0.0"]);
    expect(DPA_CALENDAR_ELECTION_VERSION).toBe("calendar-election-dpa/1.0.0");
    expect(currentDpaCalendarElection()).toBe(DPA_CALENDAR_ELECTIONS[0]);
    expect(getDpaCalendarElection(DPA_CALENDAR_ELECTION_VERSION)).toBe(
      currentDpaCalendarElection(),
    );
    expect(getDpaCalendarElection(CALENDAR_ELECTION_VERSION)).toBeUndefined();
    // Drafted 7 October 2026; released by the owner with the DPA on 20 October 2026.
    expect(currentDpaCalendarElection().publishedOn).toBe("2026-10-20");
    expect(currentDpaCalendarElection().approvedByCounsel).toBe(true);
    expect(currentDpaCalendarElection().approvedByCounsel).toBe(
      currentDpaTemplate().approvedByCounsel,
    );
  });

  test("the review sample still renders the bytes drafted", () => {
    const prepared = prepareDpaCalendarElection(DPA_ELECTION_REVIEW_SAMPLE);
    expect(
      prepared.hash,
      "The DPA's election text changed. It was released on 20 October 2026: never edit it, add a new version at DPA_CALENDAR_ELECTIONS[0].",
    ).toBe(GOLDEN_SAMPLE);
    expect(prepared.hash).toBe(hashDpaCalendarElection(prepared.text));
    expect(prepared).toMatchObject({
      version: DPA_CALENDAR_ELECTION_VERSION,
      kind: "uncovered",
      clauseId: "google-calendar-uncovered",
    });
  });

  test("names the Data Protection Agreement, and never the Business Associate Agreement", () => {
    for (const variables of everyElection()) {
      const text = renderDpaCalendarElection(variables);
      const label = `${variables.bookingSystem} ${variables.calendarAccount}`;
      expect(
        text.startsWith(
          "CALENDAR ELECTION\nto the healdesk Data Protection Agreement\nVersion calendar-election-dpa/1.0.0 — executed electronically\n",
        ),
        label,
      ).toBe(true);
      expect(unwrap(text), label).toContain(
        "this election takes the place of the Google Calendar clause of the Data Protection Agreement between Practice and healdesk",
      );
      expect(unwrap(text), label).toContain(
        'In the clause below, "this agreement" means that Data Protection Agreement.',
      );
      expect(text, label).not.toMatch(/Business Associate Agreement/);
      // The agreement it amends is named by its version.
      expect(text, label).toContain("AGREEMENT\n  version dpa/1.0.0, effective 6 October 2026");
    }
  });

  test("calls nobody a patient and says no PHI, the event's quoted word apart", () => {
    for (const variables of everyElection()) {
      const text = renderDpaCalendarElection(variables)
        .split(CALENDAR_EVENT_FALLBACK_QUOTED)
        .join("");
      const label = `${variables.bookingSystem} ${variables.calendarAccount}`;
      expect(text, label).not.toMatch(/\bpatients?\b/i);
      expect(text, label).not.toMatch(/\bPHI\b/);
    }
  });

  test("section 2 is the DPA's own calendar clause for the same answers, without the location paragraph", () => {
    for (const variables of everyElection()) {
      const label = `${variables.bookingSystem} ${variables.calendarAccount}`;
      const election = renderDpaCalendarElection(variables);
      const dpa = prepareDpa(currentDpaTemplate(), {
        ...DPA_REVIEW_SAMPLE,
        bookingSystem: variables.bookingSystem,
        calendarAccount: variables.calendarAccount,
      }).text;
      const start = dpa.indexOf(`8. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}\n\n`);
      const location = dpa.indexOf(`\n\n${wrap(CALENDAR_LOCATION_PARAGRAPH)}`, start);
      expect(start, label).toBeGreaterThan(-1);
      expect(location, label).toBeGreaterThan(start);
      const ownClause = dpa.slice(
        start + `8. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}\n\n`.length,
        location,
      );
      expect(clauseOf(election), label).toBe(ownClause);
      expect(unwrap(election), label).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
      // The same clause, kind and id the BAA's election would carry, in the DPA's words.
      const selected = selectCalendarClause(variables);
      const baa = prepareCalendarElection({ ...variables, agreementVersion: "1.3.0" });
      expect(prepareDpaCalendarElection(variables), label).toMatchObject({
        kind: selected.kind,
        clauseId: selected.clauseId,
      });
      expect(baa.clauseId, label).toBe(selected.clauseId);
    }
  });

  test("every line fits in 78 columns, however long the names", () => {
    for (const variables of everyElection().slice(0, 6)) {
      const text = renderDpaCalendarElection({
        ...variables,
        clinicLegalName:
          "The Very Long Legal Name Of A Veterinary Practice That Keeps Going On LLC",
        locationName: "The Very Long Name Of The Second Location On The Far Side Of The County",
        signatoryName: "Alexandra Catherine Montgomery-Fitzwilliam Chen-Ramasubramanian",
        signatoryTitle: "Practice Owner and Medical Director of Operations",
      });
      for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    }
  });

  test("amends only a Data Protection Agreement, and refuses what names nobody", () => {
    for (const agreementVersion of ["1.3.0", "1.2.1", "calendar-election/1.0.0"]) {
      expect(
        () => renderDpaCalendarElection({ ...DPA_ELECTION_REVIEW_SAMPLE, agreementVersion }),
        agreementVersion,
      ).toThrow(CalendarTermsError);
    }
    for (const field of ["clinicLegalName", "locationName", "agreementVersion", "signatoryName"]) {
      expect(
        () => renderDpaCalendarElection({ ...DPA_ELECTION_REVIEW_SAMPLE, [field]: "  " }),
        field,
      ).toThrow(CalendarTermsError);
    }
    expect(() =>
      renderDpaCalendarElection({
        ...DPA_ELECTION_REVIEW_SAMPLE,
        calendarAccount: "gmail" as never,
      }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      renderDpaCalendarElection({ ...DPA_ELECTION_REVIEW_SAMPLE, electedOn: "not a date" }),
    ).toThrow(CalendarTermsError);
  });
});

/**
 * A DPA practice records its elections on its own form, released with the
 * DPA, and never on the BAA's (§12.14): whatever records one takes the form
 * from calendarElectionFor (apps/app lib/booking/elections.ts), and the
 * database's election guard holds the form to the agreement's kind
 * (drizzle/0104).
 */
describe("which form an agreement takes", () => {
  test("a DPA takes its own, released with it; a BAA keeps the BAA's", () => {
    expect(calendarElectionFor("dpa/1.0.0")).toBe(currentDpaCalendarElection());
    expect(calendarElectionFor("dpa/1.0.0").approvedByCounsel).toBe(true);
    for (const version of ["1.3.0", "1.2.1", "1.0.0"]) {
      expect(calendarElectionFor(version), version).toBe(currentCalendarElection());
    }
    expect(calendarElectionFor("dpa/1.0.0")).not.toBe(currentCalendarElection());
  });

  test("an election is prepared on the form of the agreement it amends", () => {
    const dpa = prepareCalendarElectionFor(DPA_ELECTION_REVIEW_SAMPLE);
    expect(dpa.version).toBe(DPA_CALENDAR_ELECTION_VERSION);
    expect(dpa.hash).toBe(GOLDEN_SAMPLE);
    const baa = prepareCalendarElectionFor({
      ...DPA_ELECTION_REVIEW_SAMPLE,
      agreementVersion: "1.3.0",
    });
    expect(baa.version).toBe(CALENDAR_ELECTION_VERSION);
    expect(baa.text).toContain("to the healdesk Business Associate Agreement");
  });
});

describe("docs/dpa-v1.0.0.txt, Appendix B", () => {
  test("prints the sample election exactly as it renders, with its hash", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../docs/dpa-v1.0.0.txt", import.meta.url)),
      "utf8",
    );
    expect(doc).toContain(
      "APPENDIX B — THE CALENDAR ELECTION (calendar-election-dpa/1.0.0, RELEASED)",
    );
    expect(doc).toContain(renderDpaCalendarElection(DPA_ELECTION_REVIEW_SAMPLE));
    expect(doc).toContain(GOLDEN_SAMPLE);
  });
});
