import { describe, expect, test } from "vitest";

import { hashBaaText } from "./baa";
import { BOOKING_SYSTEMS, bookingSyncFor, type BookingSystemId } from "./booking-systems";
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

/** Every (kind, account) pair the selector can produce, with booking systems that are named and unnamed. */
const EVERY_BODY: {
  label: string;
  kind: CalendarTermsKind;
  account: CalendarAccount;
  bookingSystem: BookingSystemId;
}[] = [
  { label: "covered", kind: "covered", account: "workspace_baa", bookingSystem: "none" },
  { label: "covered, named", kind: "covered", account: "workspace_baa", bookingSystem: "calcom" },
  {
    label: "uncovered, no BAA",
    kind: "uncovered",
    account: "workspace_no_baa",
    bookingSystem: "none",
  },
  {
    label: "uncovered, personal",
    kind: "uncovered",
    account: "personal",
    bookingSystem: "gohighlevel",
  },
  ...CALENDAR_ACCOUNTS.map((account) => ({
    label: `not used, ${account}`,
    kind: "not_used" as const,
    account,
    bookingSystem: "mindbody" as const,
  })),
  {
    label: "not used, unconfirmed",
    kind: "not_used",
    account: "personal",
    bookingSystem: "boulevard",
  },
  { label: "not used, unnamed", kind: "not_used", account: "personal", bookingSystem: "other" },
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
      // Use stops when the Services end, which is the day the agreement ends.
      expect(text, kind).toContain(
        "healdesk holds the OAuth token encrypted and uses it for nothing else. It stops using the " +
          "token when the Services end. It deletes the token when Practice disconnects the calendar " +
          "through healdesk, or when healdesk finds that Practice has removed healdesk's access in " +
          "its Google Account. In any case it deletes the token when healdesk destroys Practice's " +
          "data after the Services end.",
      );
      // What it reads, not what Google's permission reaches.
      expect(text, kind).toContain(
        "healdesk reads the names of the calendars on which that account has owner access, so that " +
          "Practice can choose; when the calendar is free or busy; and the appointments healdesk " +
          "itself added to it.",
      );
      // And, separately, the three further things Google's permissions
      // reach, as Google words the scopes: the subscribed-calendar list,
      // every event on every calendar the account owns, and the availability
      // of every calendar it has access to (PT-20).
      expect(text, kind).toContain(
        "Google's permissions also reach three further things: the list of every calendar that " +
          "account is subscribed to, the other events on the calendars it owns, and the " +
          "availability of the other calendars it has access to. healdesk does not read or store " +
          "any of them.",
      );
    }
  });

  test("no body promises a revocation at Google", () => {
    // Google's revoke ends every grant that Google user gave the project, so
    // healdesk revokes only when no other location uses the account; the
    // clause promises deletion of the stored token, which it always does.
    for (const each of EVERY_BODY) expect(body(each), each.label).not.toMatch(/revok/i);
  });

  test("the calendar is one the practice chooses, one per provider, or the main one, and every term applies to each", () => {
    for (const each of EVERY_BODY.filter((b) => b.kind !== "not_used")) {
      const text = unwrap(body(each));
      expect(text, each.label).toContain(
        "Practice connects a Google account it controls by OAuth, under Practice's own agreement " +
          "with Google. healdesk uses a calendar on which that account has owner access: one of its " +
          "own calendars, or one another account has shared with it with permission to make " +
          "changes and manage sharing.",
      );
      expect(text, each.label).toContain(
        "Practice chooses the calendar or, where it books by provider, one such calendar for each " +
          "provider. Until Practice chooses, healdesk uses that account's main calendar.",
      );
      expect(text, each.label).toContain(
        'In this clause "the calendar" means each calendar healdesk uses, and every term of this ' +
          "clause applies to each of them.",
      );
    }
  });

  test("what an event carries is the upper bound event.ts enforces", () => {
    for (const each of EVERY_BODY.filter((b) => b.kind !== "not_used")) {
      const text = unwrap(body(each));
      expect(text, each.label).toContain(
        "Each appointment carries a first name, the service and the time, and no other information " +
          "about the patient or the person booking. It never carries a telephone number, an email " +
          "address, or anything clinical beyond the name of the service.",
      );
      // FALLBACK_FIRST_NAME and FALLBACK_SERVICE in packages/connectors/src/google/event.ts.
      expect(text, each.label).toContain(
        "The first name is the one given by the person booking, who may not be the patient; where " +
          'that name cannot be used, it is the word "Patient".',
      );
      expect(text, each.label).toContain(
        "The service is named as in Practice's own service list; where none was given or its name " +
          'cannot be used, the appointment says "Appointment".',
      );
      expect(text, each.label).toContain(
        "healdesk marks each appointment private, invites no one to it and sets no reminders on it.",
      );
      expect(text, each.label).toContain("It moves, edits or cancels nothing it did not create.");
      expect(text, each.label).toContain("trash for up to 30 days under Google's own terms");
    }
  });

  test("covered: the practice's statement about Google's BAA, and the organisation check healdesk can make", () => {
    const text = unwrap(body(EVERY_BODY[0]!));
    expect(text).toContain(
      "Practice has told healdesk that this account belongs to Practice's Google Workspace " +
        "organisation and that its administrator has accepted Google's business associate agreement.",
    );
    expect(text).toContain(
      "healdesk cannot see whether Google's agreement was accepted, and relies on Practice's statement.",
    );
    // The owner's guardrail (decision 4 of 6 October 2026; plan C8).
    expect(text).toContain(
      "When Practice chooses a calendar, and again before adding each appointment, healdesk checks " +
        "that the connected account belongs to a Google Workspace or Cloud Identity organisation " +
        "and that the calendar belongs to that same organisation. It adds nothing to a calendar " +
        "that fails either check.",
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
        "Practice nonetheless directs healdesk to add an appointment to the calendar when the " +
          "assistant books one, and when Practice's staff confirm a booking request through healdesk.",
      );
      expect(text, each.label).toContain(
        "That disclosure is made at Practice's direction, through an account Practice controls " +
          "under Practice's own agreement with Google. Practice is responsible for it, including " +
          "for any notification or other obligation that arises from Google's handling of what it " +
          "holds.",
      );
      expect(text, each.label).toContain(
        "healdesk's responsibility for it is limited to sending only the details below, only to " +
          "the calendar, only as this clause describes, and to safeguarding them under this " +
          "agreement until they are sent.",
      );
      expect(text, each.label).toContain(
        "Practice may withdraw this direction at any time, by disconnecting the calendar or by " +
          "telling healdesk. healdesk then adds nothing further to the calendar",
      );
    }
    const personal = unwrap(
      body(EVERY_BODY.find((b) => b.account === "personal" && b.kind === "uncovered")!),
    );
    expect(personal).toContain(
      "Practice has told healdesk that this account is a personal Google account, for which " +
        "Google offers no business associate agreement, so no business associate agreement " +
        "between Practice and Google covers the calendar.",
    );
    expect(personal).toContain(
      "knowing that Google will hold each appointment outside any business associate agreement",
    );
    // Not sure is not known to lack Google's agreement: treated as uncovered,
    // and Google "may" hold the appointment outside one (ICD-17, PT-21).
    const notSure = unwrap(body(EVERY_BODY.find((b) => b.account === "workspace_no_baa")!));
    expect(notSure).toContain(
      "this account is in a Google Workspace organisation whose administrator has not accepted " +
        "Google's business associate agreement, or that Practice does not know whether the " +
        "administrator has. Because Practice has not confirmed that Google's agreement covers the " +
        "calendar, the parties treat it as one that no business associate agreement between " +
        "Practice and Google covers.",
    );
    expect(notSure).toContain(
      "knowing that Google may hold each appointment outside any business associate agreement",
    );
  });

  test("not used: nothing is connected, read or written, and healdesk's list, not the practice, classes the system", () => {
    const named = unwrap(body(EVERY_BODY.find((b) => b.kind === "not_used")!));
    expect(named).toContain(
      "Practice has told healdesk that its booking system is Mindbody, which healdesk's list of " +
        "booking systems records as not reading a Google Calendar for conflicts.",
    );
    expect(named).toContain(
      "healdesk therefore does not connect to Practice's Google Calendar, reads nothing from it and " +
        "writes nothing to it. The assistant does not book appointments itself: it takes each " +
        "booking as a request, which Practice's staff confirm in Practice's own system.",
    );
    // The only route that exists: an election for a system that reads Google Calendar.
    expect(named).toContain(
      "If Practice changes the location's booking system to one that reads a Google Calendar for " +
        "conflicts, Practice first records a calendar election for the location. The assistant " +
        "books into a Google Calendar only under the clause that election carries.",
    );
    expect(unwrap(body(EVERY_BODY.find((b) => b.bookingSystem === "boulevard")!))).toContain(
      "Practice has told healdesk that its booking system is Boulevard, which healdesk's list of " +
        "booking systems records as not yet confirmed to read a Google Calendar for conflicts.",
    );
    expect(unwrap(body(EVERY_BODY.at(-1)!))).toContain(
      "Practice has told healdesk that its booking system is one that healdesk's list of booking " +
        "systems does not name, so healdesk has not confirmed that it reads a Google Calendar for " +
        "conflicts.",
    );
    // The account is kept in case the system changes; it changes nothing here.
    const forAccount = CALENDAR_ACCOUNTS.map((account) =>
      calendarClauseBody({ kind: "not_used", account, bookingSystem: "mindbody" }),
    );
    expect(new Set(forAccount).size).toBe(1);
    expect(named).not.toMatch(/OAuth|token|first name/);
  });

  test("bodies carry no location paragraph — that belongs to the BAA alone", () => {
    for (const each of EVERY_BODY) {
      expect(unwrap(body(each)), each.label).not.toContain(unwrap(CALENDAR_LOCATION_PARAGRAPH));
    }
    expect(unwrap(CALENDAR_LOCATION_PARAGRAPH)).toBe(
      "This clause governs the calendar of Practice's first location, the one set up under the " +
        "first order Practice placed for the Services. The calendar of any other location is " +
        "governed by the calendar election Practice records for it. Practice also records a calendar " +
        "election for the first location when it changes that location's booking system or the " +
        "kind of Google account it uses there, and that election then governs in place of this " +
        "clause. The kinds of Google account are a Google Workspace account whose administrator " +
        "has accepted Google's business associate agreement, any other Google Workspace account, " +
        "and a personal Google account.",
    );
  });

  test("every body fits in 78 columns", () => {
    for (const each of EVERY_BODY) {
      for (const line of body(each).split("\n"))
        expect(line.length, `${each.label}: ${line}`).toBeLessThanOrEqual(78);
    }
  });

  test("a kind the answers contradict is refused, not rendered", () => {
    expect(() =>
      calendarClauseBody({ kind: "covered", account: "personal", bookingSystem: "none" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "uncovered", account: "workspace_baa", bookingSystem: "none" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "covered", account: "gmail" as never, bookingSystem: "none" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({
        kind: "partial" as never,
        account: "personal",
        bookingSystem: "none",
      }),
    ).toThrow(CalendarTermsError);
    // The sync must agree too: a connected kind for a manual system, or
    // not-used for a live one, would describe a connection that is not so.
    expect(() =>
      calendarClauseBody({ kind: "covered", account: "workspace_baa", bookingSystem: "mindbody" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "uncovered", account: "personal", bookingSystem: "other" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({ kind: "not_used", account: "personal", bookingSystem: "calendly" }),
    ).toThrow(CalendarTermsError);
    expect(() =>
      calendarClauseBody({
        kind: "not_used",
        account: "personal",
        bookingSystem: "zenoti" as BookingSystemId,
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
        expect(selected.body).toBe(calendarClauseBody({ kind, account, bookingSystem: system.id }));
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

  test("is versioned like a document and released by the owner with BAA 1.3.0", () => {
    const current = currentCalendarElection();
    expect(current.version).toBe("calendar-election/1.0.0");
    expect(CALENDAR_ELECTIONS[0]).toBe(current);
    expect(getCalendarElection(current.version)).toBe(current);
    expect(getCalendarElection("calendar-election/0.0.0")).toBeUndefined();
    // Released with BAA 1.3.0 on 2026-10-13 (plan C19), so an election under
    // it counts for every clinic, not only a demo clinic (plan A10); the
    // database's app_calendar_election_released() says the same.
    expect(current.approvedByCounsel).toBe(true);
    expect(current.publishedOn).toBe("2026-10-13");
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
    expect(text).toContain("2. GOOGLE CALENDAR");
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
