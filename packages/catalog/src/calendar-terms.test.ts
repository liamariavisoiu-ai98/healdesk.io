import { describe, expect, test } from "vitest";

import { hashBaaText } from "./baa";
import {
  BOOKING_SYSTEMS,
  bookingSyncFor,
  bookingSystemName,
  type BookingSystemId,
} from "./booking-systems";
import {
  CALENDAR_ACCOUNT_OPTIONS,
  CALENDAR_ACCOUNTS,
  CALENDAR_CLAUSE_IDS,
  CALENDAR_ELECTIONS,
  CALENDAR_LOCATION_PARAGRAPH,
  calendarClauseBody,
  calendarTermsKind,
  CalendarTermsError,
  currentCalendarElection,
  electionWidens,
  getCalendarElection,
  hashCalendarElection,
  isCalendarAccount,
  prepareCalendarElection,
  renderCalendarElection,
  selectCalendarClause,
  type CalendarAccount,
  type CalendarElectionVariables,
  type CalendarTermsKind,
} from "./calendar-terms";

/** The 78-column wrap may break any phrase across lines. */
const unwrap = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every (kind, account) pair the selector can produce, with a platform name where one exists. */
const EVERY_BODY: {
  label: string;
  kind: CalendarTermsKind;
  account: CalendarAccount;
  connectedPlatform: string | null;
}[] = [
  { label: "covered", kind: "covered", account: "workspace_baa", connectedPlatform: null },
  {
    label: "covered, named",
    kind: "covered",
    account: "workspace_baa",
    connectedPlatform: "Cal.com",
  },
  {
    label: "uncovered, no BAA",
    kind: "uncovered",
    account: "workspace_no_baa",
    connectedPlatform: null,
  },
  {
    label: "uncovered, personal",
    kind: "uncovered",
    account: "personal",
    connectedPlatform: "HighLevel",
  },
  ...CALENDAR_ACCOUNTS.map((account) => ({
    label: `not used, ${account}`,
    kind: "not_used" as const,
    account,
    connectedPlatform: "Mindbody",
  })),
  { label: "not used, unnamed", kind: "not_used", account: "personal", connectedPlatform: null },
];

describe("the kinds of calendar terms", () => {
  test("manual is never connected; live splits on Google's BAA", () => {
    const table = CALENDAR_ACCOUNTS.flatMap((account) =>
      (["live", "manual"] as const).map((sync) => [
        sync,
        account,
        calendarTermsKind(sync, account),
      ]),
    );
    expect(table).toEqual([
      ["live", "workspace_baa", "covered"],
      ["manual", "workspace_baa", "not_used"],
      ["live", "workspace_no_baa", "uncovered"],
      ["manual", "workspace_no_baa", "not_used"],
      ["live", "personal", "uncovered"],
      ["manual", "personal", "not_used"],
    ]);
  });

  test("an account it does not know never yields a kind that writes", () => {
    // "uncovered" writes and says the practice directed it; a missing or
    // misspelt answer must never land there, nor anywhere else.
    for (const account of [undefined, null, "", "gmail", "Personal", "workspace", 3]) {
      for (const sync of ["live", "manual"] as const) {
        expect(
          () => calendarTermsKind(sync, account as unknown as CalendarAccount),
          `${sync}/${String(account)}`,
        ).toThrow(CalendarTermsError);
      }
    }
    // A sync it does not know is not live.
    expect(calendarTermsKind("sometimes" as never, "workspace_baa")).toBe("not_used");
  });

  test("each kind has its own clause id", () => {
    expect(CALENDAR_CLAUSE_IDS).toEqual({
      covered: "google-calendar-covered",
      uncovered: "google-calendar-uncovered",
      not_used: "google-calendar-not-used",
    });
  });

  test("the account question offers the three kinds, titled as the plan words them", () => {
    expect(CALENDAR_ACCOUNT_OPTIONS.map((o) => o.id)).toEqual([...CALENDAR_ACCOUNTS]);
    expect(CALENDAR_ACCOUNT_OPTIONS.map((o) => o.title)).toEqual([
      "Google Workspace, and our administrator has accepted Google's business associate agreement",
      "Google Workspace without that agreement, or we're not sure",
      "A personal Google account (@gmail.com)",
    ]);
    for (const option of CALENDAR_ACCOUNT_OPTIONS) {
      // Shown for a manual system too, where nothing is booked anywhere.
      expect(option.description, option.id).not.toMatch(/bookings (go|will go) into/i);
    }
    for (const id of CALENDAR_ACCOUNTS) expect(isCalendarAccount(id)).toBe(true);
    for (const id of ["workspace", "gmail", "", null, undefined, 3])
      expect(isCalendarAccount(id)).toBe(false);
  });
});

describe("whether an election widens what healdesk may disclose", () => {
  test("the truth table", () => {
    const previous = ["none", "not_used", "covered", "uncovered"] as const;
    const next = ["covered", "uncovered", "not_used"] as const;
    const table = Object.fromEntries(
      previous.map((p) => [p, Object.fromEntries(next.map((n) => [n, electionWidens(p, n)]))]),
    );
    expect(table).toEqual({
      // Starting to write where nothing was written widens.
      none: { covered: true, uncovered: true, not_used: false },
      not_used: { covered: true, uncovered: true, not_used: false },
      // Moving a calendar out from under Google's BAA widens.
      covered: { covered: false, uncovered: true, not_used: false },
      // Narrowing, or the same again, never needs the owner.
      uncovered: { covered: false, uncovered: false, not_used: false },
    });
  });

  test("an unrecognised previous kind fails closed", () => {
    expect(electionWidens("something" as never, "covered")).toBe(true);
    expect(electionWidens("something" as never, "uncovered")).toBe(true);
    expect(electionWidens("something" as never, "not_used")).toBe(false);
  });
});

describe("the clause bodies", () => {
  const body = (i: (typeof EVERY_BODY)[number]) => calendarClauseBody(i);

  test("the READS paragraph promises deletion in exactly the cases the code erases the token", () => {
    for (const kind of ["covered", "uncovered"] as const) {
      const text = unwrap(body(EVERY_BODY.find((b) => b.kind === kind)!));
      expect(text, kind).toContain(
        "healdesk holds the OAuth token encrypted and uses it for nothing else. It stops using the " +
          "token when this agreement ends, and deletes it when Practice disconnects the calendar " +
          "through healdesk, when healdesk finds that Practice has removed healdesk's access in its " +
          "Google Account, and in any case when healdesk destroys Practice's data at the end of this " +
          "agreement.",
      );
      // What it reads, not what Google's permission reaches.
      expect(text, kind).toContain(
        "healdesk reads the names of the calendars that account owns, so that Practice can choose " +
          "one; when that calendar is free or busy; and the appointments healdesk itself added to it.",
      );
      // And, separately, what Google's permissions reach, as Google words
      // the scopes: every event on every calendar the account owns, and the
      // availability of every calendar it can see.
      expect(text, kind).toContain(
        "Google's permission model also gives healdesk access to the other events on the calendars " +
          "that account owns, and to when the other calendars it can see are free or busy; " +
          "healdesk does not read or store them.",
      );
    }
  });

  test("no body promises a revocation at Google", () => {
    // Google's revoke ends every grant that Google user gave the project, so
    // healdesk revokes only when no other location uses the account; the
    // clause promises deletion of the stored token, which it always does.
    for (const each of EVERY_BODY) expect(body(each), each.label).not.toMatch(/revok/i);
  });

  test("the calendar is the one the practice chooses, or the main one", () => {
    for (const each of EVERY_BODY.filter((b) => b.kind !== "not_used")) {
      expect(unwrap(body(each)), each.label).toContain(
        "healdesk uses one calendar of the Google account Practice connects, which is that " +
          "account's main calendar unless Practice chooses another calendar the account owns.",
      );
    }
  });

  test("what an event carries is the upper bound event.ts enforces", () => {
    for (const each of EVERY_BODY.filter((b) => b.kind !== "not_used")) {
      const text = unwrap(body(each));
      expect(text, each.label).toContain(
        "Each appointment carries the patient's first name, the service asked about as Practice's " +
          "own service list names it, and the time, and no other information about the patient: " +
          "never a telephone number, an email address or anything clinical.",
      );
      expect(text, each.label).toContain(
        "healdesk marks each appointment private, invites no one to it and sets no reminders on it",
      );
      expect(text, each.label).toContain("it moves, edits or cancels nothing it did not create");
      expect(text, each.label).toContain("trash for up to 30 days under Google's own terms");
    }
  });

  test("covered: the practice's statement about Google's BAA, which healdesk cannot check", () => {
    const text = unwrap(body(EVERY_BODY[0]!));
    expect(text).toContain(
      "Practice has told healdesk that this account belongs to Practice's Google Workspace " +
        "organisation and that its administrator has accepted Google's business associate agreement",
    );
    expect(text).toContain(
      "healdesk cannot see whether Google's agreement was accepted and relies on Practice's statement",
    );
    expect(text).toContain(
      "it adds nothing to a calendar whose Google account does not belong to a Google Workspace or " +
        "Cloud Identity organisation",
    );
    expect(text).toContain(
      "Google's business associate agreement is between Practice and Google and does not extend " +
        "to applications Practice authorises",
    );
    expect(text).not.toMatch(/directs healdesk|responsible for it/);
  });

  test("uncovered: the practice directs the write and answers for it, and may withdraw", () => {
    for (const each of EVERY_BODY.filter((b) => b.kind === "uncovered")) {
      const text = unwrap(body(each));
      expect(text, each.label).toContain(
        "so no business associate agreement between Practice and Google covers that calendar",
      );
      expect(text, each.label).toContain(
        "Practice nonetheless directs healdesk to add an appointment",
      );
      expect(text, each.label).toContain(
        "That disclosure is made at Practice's direction, into an account Practice controls under " +
          "Practice's own agreement with Google, and Practice is responsible for it, including for " +
          "any notification or other obligation that arises from Google's handling of what it holds.",
      );
      expect(text, each.label).toContain(
        "healdesk's responsibility for it is limited to sending only the details below, only to " +
          "that calendar, only as this clause describes, and to safeguarding them under this " +
          "agreement until they are sent.",
      );
      expect(text, each.label).toContain(
        "Practice may withdraw this direction at any time by disconnecting the calendar or by " +
          "telling healdesk",
      );
    }
    expect(
      unwrap(body(EVERY_BODY.find((b) => b.account === "personal" && b.kind === "uncovered")!)),
    ).toContain(
      "this account is a personal Google account, for which Google offers no business associate agreement",
    );
    expect(unwrap(body(EVERY_BODY.find((b) => b.account === "workspace_no_baa")!))).toContain(
      "this account is in a Google Workspace organisation whose administrator has not accepted " +
        "Google's business associate agreement, or that Practice does not know whether it has",
    );
  });

  test("not used: nothing is connected, read or written, and the system is named when it has a name", () => {
    const named = unwrap(body(EVERY_BODY.find((b) => b.kind === "not_used")!));
    expect(named).toContain(
      "Practice has told healdesk that its booking system, Mindbody, does not read a Google " +
        "Calendar for conflicts, or has not been confirmed to.",
    );
    expect(named).toContain(
      "healdesk therefore does not connect to Practice's Google Calendar, reads nothing from it and " +
        "writes nothing to it",
    );
    expect(named).toContain("Practice first records a calendar election for that location");
    expect(unwrap(body(EVERY_BODY.at(-1)!))).toContain(
      "Practice has told healdesk that its booking system does not read a Google Calendar",
    );
    // The account is kept in case the system changes; it changes nothing here.
    const forAccount = CALENDAR_ACCOUNTS.map((account) =>
      calendarClauseBody({ kind: "not_used", account, connectedPlatform: "Mindbody" }),
    );
    expect(new Set(forAccount).size).toBe(1);
    expect(named).not.toMatch(/OAuth|token|first name/);
  });

  test("bodies carry no location paragraph — that belongs to the BAA alone", () => {
    for (const each of EVERY_BODY) {
      expect(unwrap(body(each)), each.label).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
    }
    expect(unwrap(CALENDAR_LOCATION_PARAGRAPH)).toBe(
      "This clause governs the calendar of the location Practice sets up when it signs this " +
        "agreement. For any other location, and for that location once Practice changes the kind " +
        "of Google account it uses or its booking system, the calendar election Practice records " +
        "for that location takes the place of this clause for that location.",
    );
  });

  test("every body fits in 78 columns", () => {
    for (const each of EVERY_BODY) {
      for (const line of body(each).split("\n"))
        expect(line.length, `${each.label}: ${line}`).toBeLessThanOrEqual(78);
    }
  });

  test("a kind the account contradicts is refused, not rendered", () => {
    expect(() =>
      calendarClauseBody({ kind: "covered", account: "personal", connectedPlatform: null }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "uncovered", account: "workspace_baa", connectedPlatform: null }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "covered", account: "gmail" as never, connectedPlatform: null }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({
        kind: "partial" as never,
        account: "personal",
        connectedPlatform: null,
      }),
    ).toThrow(CalendarTermsError);
  });
});

describe("selecting the clause from the two answers", () => {
  test("every booking system and account gets the kind its sync and account give, and the matching body", () => {
    for (const system of BOOKING_SYSTEMS) {
      for (const account of CALENDAR_ACCOUNTS) {
        const selected = selectCalendarClause({
          bookingSystem: system.id,
          calendarAccount: account,
        });
        const kind = calendarTermsKind(bookingSyncFor(system.id), account);
        expect(selected.kind, `${system.id}/${account}`).toBe(kind);
        expect(selected.clauseId).toBe(CALENDAR_CLAUSE_IDS[kind]);
        expect(selected.body).toBe(
          calendarClauseBody({ kind, account, connectedPlatform: bookingSystemName(system.id) }),
        );
      }
    }
  });

  test("a one-way system is never live, whatever account the practice named", () => {
    for (const account of CALENDAR_ACCOUNTS) {
      expect(
        selectCalendarClause({ bookingSystem: "mindbody", calendarAccount: account }).kind,
      ).toBe("not_used");
      expect(selectCalendarClause({ bookingSystem: "other", calendarAccount: account }).kind).toBe(
        "not_used",
      );
    }
    expect(
      selectCalendarClause({ bookingSystem: "gohighlevel", calendarAccount: "personal" }).kind,
    ).toBe("uncovered");
  });

  test("an unknown answer is refused", () => {
    expect(() =>
      selectCalendarClause({
        bookingSystem: "zenoti" as BookingSystemId,
        calendarAccount: "personal",
      }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      selectCalendarClause({
        bookingSystem: "none",
        calendarAccount: "unknown" as CalendarAccount,
      }),
    ).toThrow(CalendarTermsError);
  });
});

describe("the calendar election document", () => {
  const VARS: CalendarElectionVariables = {
    clinicLegalName: "Golden Clinic LLC",
    locationName: "Golden Clinic, Main Street",
    agreementVersion: "1.3.0",
    agreementEffectiveDate: "2026-10-06",
    bookingSystem: "none",
    calendarAccount: "personal",
    signatoryName: "Alex Chen",
    signatoryTitle: "Owner",
    electedOn: "2026-10-07",
  };

  test("is versioned like a document and not released until the owner releases it", () => {
    const current = currentCalendarElection();
    expect(current.version).toBe("calendar-election/1.0.0");
    expect(CALENDAR_ELECTIONS[0]).toBe(current);
    expect(getCalendarElection(current.version)).toBe(current);
    expect(getCalendarElection("calendar-election/0.0.0")).toBeUndefined();
    // Released with BAA 1.3.0 (plan C19); until then only a demo clinic's
    // election may count (plan A10, enforced from C6 and C7).
    expect(current.approvedByCounsel).toBe(false);
  });

  test("names the practice, the location and the agreement, and carries the clause without the location paragraph", () => {
    const text = renderCalendarElection(VARS);
    const flat = unwrap(text);
    expect(
      text.startsWith("CALENDAR ELECTION\nto the healdesk Business Associate Agreement\n"),
    ).toBe(true);
    expect(text).toContain("Version calendar-election/1.0.0 — executed electronically");
    expect(text).toContain('PRACTICE\n  Golden Clinic LLC ("Practice")');
    expect(text).toContain("LOCATION\n  Golden Clinic, Main Street");
    expect(text).toContain("AGREEMENT\n  version 1.3.0, effective 6 October 2026");
    expect(text).toContain("1. WHAT THIS ELECTION DOES");
    expect(text).toContain("2. PRACTICE'S GOOGLE CALENDAR");
    expect(text).toContain("3. ACCEPTANCE");
    expect(flat).toContain(
      "this election takes the place of the Google Calendar clause of the Business Associate " +
        "Agreement between Practice and healdesk",
    );
    expect(flat).toContain("the parties agree that this election supplements it");
    expect(flat).toContain(
      'In the clause below, "this agreement" means that Business Associate Agreement.',
    );
    expect(text).toContain(selectCalendarClause(VARS).body);
    expect(flat).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
    expect(flat).toContain("who confirms authority to bind Practice");
    expect(text).toContain("ACCEPTED FOR PRACTICE BY\n  Alex Chen, Owner");
    expect(text.endsWith("ACCEPTED 7 October 2026")).toBe(true);
    expect(text).not.toMatch(/\{|undefined|\[object|null/);
  });

  test("every line fits in 78 columns, however long the names", () => {
    const text = renderCalendarElection({
      ...VARS,
      clinicLegalName:
        "The Very Long Legal Name Of A Practice That Keeps Going And Going Holdings LLC",
      locationName:
        "The Second Location, Suite 1200, On The Avenue That Has A Remarkably Long Name",
      bookingSystem: "boulevard",
    });
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
  });

  test("strict about its inputs; the title alone is optional", () => {
    expect(renderCalendarElection({ ...VARS, signatoryTitle: undefined })).toContain(
      "ACCEPTED FOR PRACTICE BY\n  Alex Chen\n",
    );
    expect(renderCalendarElection({ ...VARS, signatoryTitle: "  " })).toContain(
      "ACCEPTED FOR PRACTICE BY\n  Alex Chen\n",
    );
    for (const field of [
      "clinicLegalName",
      "locationName",
      "agreementVersion",
      "signatoryName",
    ] as const) {
      expect(() => renderCalendarElection({ ...VARS, [field]: " " }), field).toThrow(
        CalendarTermsError,
      );
    }
    expect(() => renderCalendarElection({ ...VARS, electedOn: "not-a-date" })).toThrow(
      /Invalid date/,
    );
    expect(() => renderCalendarElection({ ...VARS, agreementEffectiveDate: "" })).toThrow(
      /Invalid date/,
    );
    expect(() =>
      renderCalendarElection({ ...VARS, bookingSystem: "zenoti" as BookingSystemId }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      renderCalendarElection({ ...VARS, calendarAccount: "gmail" as CalendarAccount }),
    ).toThrow(CalendarTermsError);
  });

  test("hashes the exact bytes, names the version and the variant", () => {
    const prepared = prepareCalendarElection(VARS);
    expect(prepared.text).toBe(renderCalendarElection(VARS));
    expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.hash).toBe(hashBaaText(prepared.text));
    expect(prepared.hash).toBe(hashCalendarElection(prepared.text));
    expect(prepared.version).toBe(currentCalendarElection().version);
    expect(prepared.kind).toBe("uncovered");
    expect(prepared.clauseId).toBe("google-calendar-uncovered");
    // A different person, a different location or a different answer is a different record.
    for (const changed of [
      { signatoryName: "Sam Lee" },
      { locationName: "Golden Clinic, Harbour Road" },
      { calendarAccount: "workspace_no_baa" as const },
      { bookingSystem: "mindbody" as const },
    ]) {
      expect(
        prepareCalendarElection({ ...VARS, ...changed }).hash,
        JSON.stringify(changed),
      ).not.toBe(prepared.hash);
    }
  });
});
