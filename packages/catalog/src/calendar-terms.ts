import { createHash } from "node:crypto";

import {
  bookingSyncFor,
  bookingSystemName,
  isBookingSystemId,
  type BookingSystemId,
} from "./booking-systems";
import type { BookingSync } from "./platforms";
import { wrap } from "./wrap";

/**
 * The calendar terms: which Google Calendar clause governs a location, and
 * the calendar election that changes it.
 *
 * Two answers decide the clause, and the browser chooses neither outcome
 * directly:
 *
 *   - the booking system (booking-systems.ts), which gives the sync: "live"
 *     only when that system reads Google Calendar for conflicts;
 *   - the kind of Google account that holds the calendar, which only the
 *     practice can tell us. `hd` in Google's ID token proves a managed
 *     account, never that its administrator accepted Google's business
 *     associate agreement, so that half is always the practice's statement.
 *
 * Three kinds follow (owner decisions of 5 October 2026, plan §2.3):
 *
 *   covered    live, and a Workspace account whose administrator accepted
 *              Google's BAA. healdesk adds bookings to the calendar.
 *   uncovered  live, on a personal account or a Workspace account without
 *              Google's BAA. The practice directs healdesk to add bookings
 *              anyway and answers for that disclosure (decision 2). Open to
 *              every practice, a declared covered entity included (owner,
 *              Q3): there is no covered-entity predicate.
 *   not_used   the booking system does not read Google Calendar, or nobody
 *              has confirmed it does. healdesk does not connect at all.
 *
 * The clause bodies live here, once. BAA 1.3.0 renders them with the location
 * paragraph appended (baa.ts); the election document renders them without it;
 * the funnel's data protection agreement is to pick its calendar clause
 * through `selectCalendarClause`. Every promise in them has to be kept by
 * code before they are released: the event body (packages/connectors/src/
 * google/event.ts) and the reads (the Google adapter) already are; the token
 * erasure on disconnect, on revocation at Google and at destruction, and the
 * account checks at connect, arrive with the connect flow and the watch
 * (plan §4.11, §4.12, §9). The covered clause also needs the chosen
 * calendar's organisation checked, which nothing plans yet
 * (agreement-changes.md §12.11, item 7). docs/counsel/agreement-changes.md
 * §12.4 keeps the list, and the release audit checks it against the code.
 *
 * Frozen once released. The 1.3.0 golden hashes and the election golden hash
 * (apps/app/tests/baa-golden.test.ts) both reproduce through these sentences,
 * so a later wording is a new set of sentences beside these, selected by
 * version, never an edit to them.
 */

export type CalendarAccount = "workspace_baa" | "workspace_no_baa" | "personal";

export const CALENDAR_ACCOUNTS: readonly CalendarAccount[] = [
  "workspace_baa",
  "workspace_no_baa",
  "personal",
];

export function isCalendarAccount(x: unknown): x is CalendarAccount {
  return typeof x === "string" && (CALENDAR_ACCOUNTS as readonly string[]).includes(x);
}

/**
 * The question "Which Google account will bookings go into?", in plain
 * words. The descriptions hold for a manual booking system too, where the
 * answer is only kept in case that changes, so none of them says bookings
 * will go anywhere.
 */
export const CALENDAR_ACCOUNT_OPTIONS: readonly {
  id: CalendarAccount;
  title: string;
  description: string;
}[] = [
  {
    id: "workspace_baa",
    title:
      "Google Workspace, and our administrator has accepted Google's business associate agreement",
    description:
      "Google's agreement with your practice covers that calendar. healdesk can't see whether " +
      "your administrator accepted it, so your agreement with healdesk records that you told us so.",
  },
  {
    id: "workspace_no_baa",
    title: "Google Workspace without that agreement, or we're not sure",
    description:
      "We treat that calendar as one no agreement with Google covers. If your assistant books " +
      "into it, it does so at your practice's direction and on your practice's responsibility, " +
      "as your agreement with healdesk sets out.",
  },
  {
    id: "personal",
    title: "A personal Google account (@gmail.com)",
    description:
      "Google offers no business associate agreement for a personal account. If your assistant " +
      "books into it, it does so at your practice's direction and on your practice's " +
      "responsibility, as your agreement with healdesk sets out.",
  },
];

export type CalendarTermsKind = "covered" | "uncovered" | "not_used";

/**
 * manual → not_used; live with Google's BAA → covered; live without it →
 * uncovered. Anything but "live" is not_used.
 *
 * Strict about the account, as calendarClauseBody is: an account it does not
 * know (undefined, "", "gmail") throws rather than falling through to
 * "uncovered", a kind that writes and says the practice directed it. The
 * BAA's clause predicates stay total because they pass `calendarAccountOf`,
 * which never returns an unknown account.
 */
export function calendarTermsKind(sync: BookingSync, account: CalendarAccount): CalendarTermsKind {
  if (!isCalendarAccount(account)) {
    throw new CalendarTermsError(`Unknown calendar account: ${String(account)}`);
  }
  if (sync !== "live") return "not_used";
  return account === "workspace_baa" ? "covered" : "uncovered";
}

/** The clause id each kind renders as, in the BAA, the election and the stored rows. */
export const CALENDAR_CLAUSE_IDS = {
  covered: "google-calendar-covered",
  uncovered: "google-calendar-uncovered",
  not_used: "google-calendar-not-used",
} as const satisfies Record<CalendarTermsKind, string>;

export type CalendarClauseId = (typeof CALENDAR_CLAUSE_IDS)[CalendarTermsKind];

/** All three kinds share it, so the clause a practice is under never changes its name. */
export const CALENDAR_CLAUSE_HEADING = "Practice's Google Calendar";

export class CalendarTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarTermsError";
  }
}

// -----------------------------------------------------------------------------
// The clause bodies
// -----------------------------------------------------------------------------

/**
 * Which calendar. The calendar-list permission is included (owner, 6 October
 * 2026), so the practice may choose any calendar the account owns; the
 * connection defaults to the main one (`primary`). `calendar.events.owned`
 * can write only to a calendar the account owns, which is why the choice is
 * limited to those.
 */
const WHICH_CALENDAR =
  "Practice connects its own Google Calendar by OAuth, under Practice's own agreement with " +
  "Google; healdesk uses one calendar of the Google account Practice connects, which is that " +
  "account's main calendar unless Practice chooses another calendar the account owns.";

/**
 * What healdesk reads, holds and deletes. It says what healdesk reads, and
 * then, separately, what Google's permissions reach, as Google's scope page
 * words them (read 6 October 2026): `calendar.events.owned` reaches "events
 * on Google calendars you own", every one of them, and
 * `calendar.events.freebusy` "the availability on Google calendars you have
 * access to". healdesk reads free/busy for the one calendar, its own events,
 * and the names of the calendars the account owns (the list is asked for
 * with `minAccessRole=owner`, so Google returns no other names); verify()
 * lists events with a filter no event matches and asks for no event fields.
 * Deletion is promised in exactly the three cases the code erases the token;
 * revocation at Google is not promised, because revoking ends every grant
 * that Google user has given the project, including one another location may
 * still use.
 */
const READS =
  "healdesk reads the names of the calendars that account owns, so that Practice can choose " +
  "one; when that calendar is free or busy; and the appointments healdesk itself added to it. " +
  "Google's permission model also gives healdesk access to the other events on the calendars " +
  "that account owns, and to when the other calendars it can see are free or busy; healdesk " +
  "does not read or store them. healdesk holds the OAuth token encrypted and uses it for " +
  "nothing else. It stops using the token when this agreement ends, and deletes it when " +
  "Practice disconnects the calendar through healdesk, when healdesk finds that Practice has " +
  "removed healdesk's access in its Google Account, and in any case when healdesk destroys " +
  "Practice's data at the end of this agreement.";

/** What an event carries: packages/connectors/src/google/event.ts builds exactly this. */
const WRITES =
  "Each appointment carries the patient's first name, the service asked about as Practice's own " +
  "service list names it, and the time, and no other information about the patient: never a " +
  "telephone number, an email address or anything clinical. healdesk marks each appointment " +
  "private, invites no one to it and sets no reminders on it, and it moves, edits or cancels " +
  "nothing it did not create. Google keeps a deleted event in that calendar's trash for up to " +
  "30 days under Google's own terms.";

const COVERED_STATEMENT =
  "Practice has told healdesk that this account belongs to Practice's Google Workspace " +
  "organisation and that its administrator has accepted Google's business associate agreement, " +
  "and Practice will record a calendar election promptly if that stops being true. healdesk " +
  "cannot see whether Google's agreement was accepted and relies on Practice's statement; it " +
  "adds nothing to a calendar whose Google account does not belong to a Google Workspace or " +
  "Cloud Identity organisation.";

const COVERED_WRITES =
  "healdesk adds an appointment to that calendar when the assistant books one, and when " +
  "Practice's staff confirm a booking request through healdesk.";

const COVERED_ACKNOWLEDGEMENT =
  "Practice acknowledges that Google's business associate agreement is between Practice and " +
  "Google and does not extend to applications Practice authorises, and that healdesk's access " +
  "to the calendar is governed by this agreement.";

const UNCOVERED_ACCOUNT: Record<Exclude<CalendarAccount, "workspace_baa">, string> = {
  personal: "a personal Google account, for which Google offers no business associate agreement",
  workspace_no_baa:
    "in a Google Workspace organisation whose administrator has not accepted Google's business " +
    "associate agreement, or that Practice does not know whether it has",
};

/**
 * Owner decision 2: the practice directs the write and answers for the
 * disclosure to Google, including any notification it triggers; healdesk's
 * responsibility is limited to what it sends, where, and safeguarding it
 * until it is sent.
 */
const UNCOVERED_DIRECTION =
  "Practice nonetheless directs healdesk to add an appointment to that calendar when the " +
  "assistant books one, and when Practice's staff confirm a booking request through healdesk, " +
  "knowing that Google will hold it outside any business associate agreement. That disclosure " +
  "is made at Practice's direction, into an account Practice controls under Practice's own " +
  "agreement with Google, and Practice is responsible for it, including for any notification " +
  "or other obligation that arises from Google's handling of what it holds. healdesk's " +
  "responsibility for it is limited to sending only the details below, only to that calendar, " +
  "only as this clause describes, and to safeguarding them under this agreement until they are " +
  "sent.";

const UNCOVERED_WITHDRAWAL =
  "Practice may withdraw this direction at any time by disconnecting the calendar or by telling " +
  "healdesk; healdesk then adds nothing further to it, and the assistant takes booking requests " +
  "for Practice's staff to confirm instead.";

const UNCOVERED_ACKNOWLEDGEMENT =
  "Practice acknowledges that healdesk's access to the calendar is governed by this agreement.";

const NOT_USED_CHANGE =
  "If Practice changes its booking system, or wants the assistant to book into a Google " +
  "Calendar, Practice first records a calendar election for that location.";

/**
 * The BAA's last paragraph of every calendar clause, never the election's: in
 * the agreement the clause governs the location set up at signing, and every
 * other location, or that one after a change, is governed by its election.
 */
export const CALENDAR_LOCATION_PARAGRAPH =
  "This clause governs the calendar of the location Practice sets up when it signs this " +
  "agreement. For any other location, and for that location once Practice changes the kind of " +
  "Google account it uses or its booking system, the calendar election Practice records for " +
  "that location takes the place of this clause for that location.";

/**
 * The clause for one kind, wrapped at 78 columns, without the location
 * paragraph. Strict: a kind the account contradicts (covered on a personal
 * account, uncovered on a Workspace account with Google's BAA) throws rather
 * than rendering a clause whose first paragraph says something the practice
 * did not tell us.
 */
export function calendarClauseBody(input: {
  kind: CalendarTermsKind;
  account: CalendarAccount;
  connectedPlatform: string | null;
}): string {
  const { kind, account } = input;
  if (!isCalendarAccount(account)) {
    throw new CalendarTermsError(`Unknown calendar account: ${String(account)}`);
  }
  switch (kind) {
    case "covered":
      if (account !== "workspace_baa") {
        throw new CalendarTermsError(
          `A covered calendar clause needs a Workspace account with Google's BAA, not ${account}.`,
        );
      }
      return paragraphs(
        `${WHICH_CALENDAR} ${COVERED_STATEMENT}`,
        READS,
        `${COVERED_WRITES} ${WRITES}`,
        COVERED_ACKNOWLEDGEMENT,
      );
    case "uncovered":
      if (account === "workspace_baa") {
        throw new CalendarTermsError(
          "An uncovered calendar clause cannot name a Workspace account with Google's BAA.",
        );
      }
      return paragraphs(
        `${WHICH_CALENDAR} Practice has told healdesk that this account is ${UNCOVERED_ACCOUNT[account]}, ` +
          `so no business associate agreement between Practice and Google covers that calendar.`,
        READS,
        `${UNCOVERED_DIRECTION} ${WRITES}`,
        UNCOVERED_WITHDRAWAL,
        UNCOVERED_ACKNOWLEDGEMENT,
      );
    case "not_used": {
      const named = input.connectedPlatform?.trim();
      return paragraphs(
        `Practice has told healdesk that its booking system${named ? `, ${named},` : ""} does not ` +
          `read a Google Calendar for conflicts, or has not been confirmed to. healdesk therefore ` +
          `does not connect to Practice's Google Calendar, reads nothing from it and writes ` +
          `nothing to it, and the assistant does not book appointments itself: it takes each ` +
          `booking as a request, which Practice's staff confirm in Practice's own system.`,
        NOT_USED_CHANGE,
      );
    }
    default:
      throw new CalendarTermsError(`Unknown calendar terms kind: ${String(kind)}`);
  }
}

function paragraphs(...texts: string[]): string {
  return texts.map((text) => wrap(text)).join("\n\n");
}

/**
 * Whether moving a location from one kind to another widens what healdesk
 * may disclose, which is what decides whether the practice's owner has to
 * confirm the election (plan §2.6): starting to write where nothing was
 * written, or moving a calendar out from under Google's BAA. Fails closed: a
 * previous kind it does not recognise counts as nothing written before.
 */
export function electionWidens(
  previous: CalendarTermsKind | "none",
  next: CalendarTermsKind,
): boolean {
  if (next !== "covered" && next !== "uncovered") return false;
  if (previous === "covered") return next === "uncovered";
  if (previous === "uncovered") return false;
  return true;
}

/**
 * The one selector: the election document and the tests pick a calendar
 * clause through it, and so are the funnel's data protection agreement and
 * the election form, so no caller derives the sync or the kind on its own.
 * The body has no location paragraph; that paragraph belongs to the BAA
 * alone.
 */
export function selectCalendarClause(input: {
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
}): { kind: CalendarTermsKind; clauseId: CalendarClauseId; body: string } {
  if (!isBookingSystemId(input.bookingSystem)) {
    throw new CalendarTermsError(`Unknown booking system: ${String(input.bookingSystem)}`);
  }
  if (!isCalendarAccount(input.calendarAccount)) {
    throw new CalendarTermsError(`Unknown calendar account: ${String(input.calendarAccount)}`);
  }
  const kind = calendarTermsKind(bookingSyncFor(input.bookingSystem), input.calendarAccount);
  return {
    kind,
    clauseId: CALENDAR_CLAUSE_IDS[kind],
    body: calendarClauseBody({
      kind,
      account: input.calendarAccount,
      connectedPlatform: bookingSystemName(input.bookingSystem),
    }),
  };
}

// -----------------------------------------------------------------------------
// The calendar election
// -----------------------------------------------------------------------------

/**
 * One location's calendar terms, accepted after the agreement: for a second
 * location, for a change of booking system or Google account kind, and for
 * anyone who signed an agreement before 1.3.0 (plan §2.6, decision 3).
 *
 * A versioned document, like the direct-booking addendum, because it amends
 * a contract: the server is to render it again with what the person typed,
 * hash the exact bytes and store version, hash and text on the election row,
 * never accepting a hash from the browser (the setup-link precedent,
 * apps/app/src/lib/onboarding/requirements.ts). That server side, and the
 * table it writes, arrive with plan C6 and C7.
 *
 * `approvedByCounsel` keeps the BAA's name for the same thing: released for
 * use by the owner. While it is false an election is to count only for a
 * demo clinic (plan A10), and the database is to refuse a draft row for
 * anyone else (plan §11.6, from C6 and C7).
 *
 * To revise: add a new entry at CALENDAR_ELECTIONS[0] with a new version.
 * Never edit an existing one; an election row's stored hash points at it.
 */
export type CalendarElection = {
  /** e.g. "calendar-election/1.0.0"; stored on each election row. */
  version: string;
  /** When this text was published. Not when anyone accepted it. */
  publishedOn: string;
  /** Released for use. False until the owner releases it with BAA 1.3.0 (plan C19). */
  approvedByCounsel: boolean;
  /** Section 1: what recording the election does to the agreement. */
  purpose: string;
  /** Section 3: the sentence that makes ticking it an acceptance. */
  acceptance: string;
};

export const CALENDAR_ELECTION_VERSION = "calendar-election/1.0.0";

export const CALENDAR_ELECTIONS: readonly CalendarElection[] = [
  // Newest first; currentCalendarElection() reads [0].
  {
    version: CALENDAR_ELECTION_VERSION,
    publishedOn: "2026-10-06",
    approvedByCounsel: false,
    // The clause it carries says "this agreement" throughout, as it does in
    // the BAA; the last sentence says which agreement that is, so nobody can
    // read it as the election itself.
    purpose:
      "For the location named above, this election takes the place of the Google Calendar " +
      "clause of the Business Associate Agreement between Practice and healdesk, from the date " +
      "below until Practice records another election for the location. Everything else in that " +
      "agreement is unchanged. Where that agreement does not itself provide for calendar " +
      "elections, the parties agree that this election supplements it. In the clause below, " +
      '"this agreement" means that Business Associate Agreement.',
    acceptance:
      "Accepted for Practice by the person named below, who confirms authority to bind Practice.",
  },
] as const;

export function currentCalendarElection(): CalendarElection {
  return CALENDAR_ELECTIONS[0]!;
}

export function getCalendarElection(version: string): CalendarElection | undefined {
  return CALENDAR_ELECTIONS.find((e) => e.version === version);
}

export type CalendarElectionVariables = {
  /** The practice's legal name, as on its agreement. */
  clinicLegalName: string;
  /** The location this election is for, as the practice names it. */
  locationName: string;
  /** The agreement it changes: the bound acceptance's version and effective date. */
  agreementVersion: string;
  agreementEffectiveDate: string;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  /** Typed by the person accepting. This is the signature. */
  signatoryName: string;
  signatoryTitle?: string;
  /** ISO date. The day it was accepted, not the day the text was published. */
  electedOn: string;
};

/**
 * The exact text a practice accepts.
 *
 * Strict for the reason renderBaa is: an election that names nobody looks
 * complete and binds no one. Laid out like the BAA (numbered upper-case
 * headings, every line through the 78-column wrap) so the two read as one
 * instrument when printed together, and so the plain-text copy reads the same
 * everywhere, however long a name is.
 */
export function renderCalendarElection(
  variables: CalendarElectionVariables,
  election: CalendarElection = currentCalendarElection(),
): string {
  requireField(variables.clinicLegalName, "clinicLegalName");
  requireField(variables.locationName, "locationName");
  requireField(variables.agreementVersion, "agreementVersion");
  requireField(variables.signatoryName, "signatoryName");
  const clause = selectCalendarClause({
    bookingSystem: variables.bookingSystem,
    calendarAccount: variables.calendarAccount,
  });
  const title = variables.signatoryTitle?.trim() ? `, ${variables.signatoryTitle.trim()}` : "";

  const text = [
    `CALENDAR ELECTION`,
    `to the healdesk Business Associate Agreement`,
    `Version ${election.version} — executed electronically`,
    ``,
    `PRACTICE`,
    wrap(`${variables.clinicLegalName.trim()} ("Practice")`),
    ``,
    `LOCATION`,
    wrap(variables.locationName.trim()),
    ``,
    `AGREEMENT`,
    wrap(
      `version ${variables.agreementVersion.trim()}, effective ${formatDate(variables.agreementEffectiveDate)}`,
    ),
    ``,
    `1. WHAT THIS ELECTION DOES`,
    ``,
    wrap(election.purpose),
    ``,
    `2. ${CALENDAR_CLAUSE_HEADING.toUpperCase()}`,
    ``,
    clause.body,
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

/**
 * SHA-256 hex of the exact rendered text: the digest `hashBaaText` produces,
 * computed here so this module does not depend on baa.ts, which depends on it.
 */
export function hashCalendarElection(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render, hash and name the version and the variant in one step, as prepareBaa does. */
export function prepareCalendarElection(
  variables: CalendarElectionVariables,
  election: CalendarElection = currentCalendarElection(),
): {
  text: string;
  hash: string;
  version: string;
  kind: CalendarTermsKind;
  clauseId: CalendarClauseId;
} {
  const text = renderCalendarElection(variables, election);
  const { kind, clauseId } = selectCalendarClause({
    bookingSystem: variables.bookingSystem,
    calendarAccount: variables.calendarAccount,
  });
  return { text, hash: hashCalendarElection(text), version: election.version, kind, clauseId };
}

function requireField(value: string | undefined, field: string): void {
  if (!value?.trim()) {
    throw new CalendarTermsError(`${field} is required to render the calendar election.`);
  }
}

/** "2026-10-06" → "6 October 2026". Mirrors baa.ts's formatDate. */
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
