import { createHash } from "node:crypto";

import {
  bookingSyncFor,
  bookingSystemName,
  getBookingSystem,
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
 *              Q3, re-confirmed on 6 October 2026 as an owner-accepted risk:
 *              "If the practice decides to do it itself, it's their
 *              problem"): there is no covered-entity predicate.
 *   not_used   the booking system does not read Google Calendar, or nobody
 *              has confirmed it does. healdesk does not connect at all.
 *
 * "The calendar" is each calendar healdesk uses for the location: the one the
 * practice chooses or, where it books by provider, one for each provider (v1
 * spec, provider-specific booking; plan addendum of 6 October 2026). Every
 * rule in a clause applies to each of them.
 *
 * The clause bodies live here, once. BAA 1.3.0 renders them with the location
 * paragraph appended (baa.ts); the election document renders them without it;
 * the funnel's data protection agreement is to pick its calendar clause
 * through `selectCalendarClause`. Every promise in them is kept by code: the
 * event body (packages/connectors/src/google/event.ts) and the reads (the
 * Google adapter); the token erasure on disconnect, on revocation at Google
 * and at destruction, use stopping when the Services end, and the account
 * checks at connect, by the connect flow and the watch (plan §4.11, §4.12,
 * §9); and the covered clause's organisation check, at choice and before
 * every write and for every provider calendar, by plan C8's guardrail (owner,
 * 6 October 2026: "Yes, guardrail it"; agreement-changes.md §12.14). The
 * assistant's own bookings write through the same checks (apps/app
 * lib/booking/writer.ts, plan C13). docs/counsel/agreement-changes.md §12.4
 * keeps the list, and the release audit checked it against the code
 * (§12.15).
 *
 * Frozen since their release with BAA 1.3.0 and calendar-election/1.0.0 on
 * 2026-10-13 (plan C19; agreement-changes.md §12.15). The 1.3.0 golden hashes
 * and the election golden hash (apps/app/tests/baa-golden.test.ts) both
 * reproduce through these sentences, so a later wording is a new set of
 * sentences beside these, selected by version, never an edit to them. The
 * pre-release audit's edits (agreement-changes.md §12.14) were the last made
 * in place.
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

/**
 * All three kinds share it, so the clause a practice is under never changes
 * its name. "Google Calendar", so that "the Google Calendar clause" — as the
 * BAA's other clauses and the election's first section call it — names the
 * heading exactly (pre-release audit, ICD-22). 1.2.1's clause keeps its own
 * heading, "Practice's Google Calendar".
 */
export const CALENDAR_CLAUSE_HEADING = "Google Calendar";

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
 * 2026), so the practice may choose any calendar on which the connected
 * account has owner access, or one per provider where it books by provider
 * (PT-06); the connection defaults to the main one (`primary`).
 * `calendar.events.owned` can write only to such a calendar. Google lists a
 * calendar another account has shared in with "make changes and manage
 * sharing" as `owner` too, which is why the sentence says so and the covered
 * clause checks the calendar's organisation (HRC-04).
 */
const WHICH_CALENDAR =
  "Practice connects a Google account it controls by OAuth, under Practice's own agreement " +
  "with Google. healdesk uses a calendar on which that account has owner access: one of its own " +
  "calendars, or one another account has shared with it with permission to make changes and " +
  "manage sharing. Practice chooses the calendar or, where it books by provider, one such " +
  "calendar for each provider. Until Practice chooses, healdesk uses that account's main " +
  'calendar. In this clause "the calendar" means each calendar healdesk uses, and every term of ' +
  "this clause applies to each of them.";

/**
 * What healdesk reads, holds and deletes. It says what healdesk reads, and
 * then, separately, the three further things Google's permissions reach, in
 * the words of Google's scope page (read 6 October 2026):
 * `calendar.calendarlist.readonly` "See the list of Google calendars you're
 * subscribed to", `calendar.events.owned` "See, create, change, and delete
 * events on Google calendars you own", and `calendar.events.freebusy` "See
 * the availability on Google calendars you have access to" (PT-20). healdesk
 * reads free/busy for the calendars it uses, its own events, and the names of
 * the calendars the account has owner access to (the list is asked for with
 * `minAccessRole=owner`); verify() lists events with a filter no event
 * matches and asks for no event fields. Deletion is promised in exactly the
 * three cases the code erases the token; revocation at Google is not
 * promised, because revoking ends every grant that Google user has given the
 * project, including one another location may still use. Use stops when the
 * Services end, which is the day the agreement ends (its Term clause), and
 * the token goes with the rest of the practice's data (ICD-32).
 */
const READS =
  "healdesk reads the names of the calendars on which that account has owner access, so that " +
  "Practice can choose; when the calendar is free or busy; and the appointments healdesk itself " +
  "added to it. Google's permissions also reach three further things: the list of every " +
  "calendar that account is subscribed to, the other events on the calendars it owns, and the " +
  "availability of the other calendars it has access to. healdesk does not read or store any of " +
  "them. healdesk holds the OAuth token encrypted and uses it for nothing else. It stops using " +
  "the token when the Services end. It deletes the token when Practice disconnects the calendar " +
  "through healdesk, or when healdesk finds that Practice has removed healdesk's access in its " +
  "Google Account. In any case it deletes the token when healdesk destroys Practice's data " +
  "after the Services end.";

/**
 * The word an event carries in place of a first name that cannot be used:
 * `FALLBACK_FIRST_NAME` in packages/connectors/src/google/event.ts, which the
 * catalog cannot import, for every practice. The clause quotes it, and the
 * funnel's DPA keeps the quotation word for word although it calls nobody a
 * patient, because it describes the event healdesk actually writes.
 */
export const CALENDAR_EVENT_FALLBACK_NAME = "Patient";

/**
 * What an event carries: packages/connectors/src/google/event.ts builds
 * exactly this. The first name is the one the person booking gave
 * (`sanitizeFirstName`, else FALLBACK_FIRST_NAME); the service is the
 * practice's own list's name for it (`eventServiceLabel`, else
 * FALLBACK_SERVICE), screened only for clinical vocabulary, contact details
 * and control characters, so the clause says "nothing clinical beyond the
 * name of the service" (ICD-28, PT-30).
 */
const WRITES =
  "Each appointment carries a first name, the service and the time, and no other information " +
  "about the patient or the person booking. It never carries a telephone number, an email " +
  "address, or anything clinical beyond the name of the service. The first name is the one " +
  "given by the person booking, who may not be the patient; where that name cannot be used, it " +
  `is the word "${CALENDAR_EVENT_FALLBACK_NAME}". The service is named as in Practice's own ` +
  "service list; where none was given or its name cannot be used, the appointment says " +
  '"Appointment". healdesk marks each appointment private, invites no one to it and sets no ' +
  "reminders on it. It moves, edits or cancels nothing it did not create. Google keeps a " +
  "deleted event in the calendar's trash for up to 30 days under Google's own terms.";

/**
 * The practice's statement, which healdesk cannot check, and the check it
 * can make: the connected account is managed, and each calendar belongs to
 * its organisation, at choice and again before every write (owner's decision
 * 4 of 6 October 2026, HRC-04, PT-20; plan C8's guardrail, a release gate).
 */
const COVERED_STATEMENT =
  "Practice has told healdesk that this account belongs to Practice's Google Workspace " +
  "organisation and that its administrator has accepted Google's business associate agreement. " +
  "Practice will record a calendar election promptly if either stops being true. healdesk cannot " +
  "see whether Google's agreement was accepted, and relies on Practice's statement. When " +
  "Practice chooses a calendar, and again before adding each appointment, healdesk checks that " +
  "the connected account belongs to a Google Workspace or Cloud Identity organisation and that " +
  "the calendar belongs to that same organisation. It adds nothing to a calendar that fails " +
  "either check.";

const COVERED_WRITES =
  "healdesk adds an appointment to the calendar when the assistant books one, and when " +
  "Practice's staff confirm a booking request through healdesk.";

const COVERED_ACKNOWLEDGEMENT =
  "Practice acknowledges that Google's business associate agreement is between Practice and " +
  "Google and does not extend to applications Practice authorises, and that healdesk's access " +
  "to the calendar is governed by this agreement.";

/**
 * What Practice told healdesk about an account no Google BAA is known to
 * cover. A personal account cannot have one. A Workspace account whose
 * administrator has not accepted it, or where Practice does not know, is
 * treated as uncovered because nobody has confirmed it is covered, which is
 * the accurate statement (ICD-17, PT-21; an accuracy edit the owner's
 * decision 1 allows).
 */
const UNCOVERED_ACCOUNT: Record<Exclude<CalendarAccount, "workspace_baa">, string> = {
  personal:
    "Practice has told healdesk that this account is a personal Google account, for which Google " +
    "offers no business associate agreement, so no business associate agreement between Practice " +
    "and Google covers the calendar.",
  workspace_no_baa:
    "Practice has told healdesk that this account is in a Google Workspace organisation whose " +
    "administrator has not accepted Google's business associate agreement, or that Practice does " +
    "not know whether the administrator has. Because Practice has not confirmed that Google's " +
    "agreement covers the calendar, the parties treat it as one that no business associate " +
    "agreement between Practice and Google covers.",
};

/**
 * Owner decision 2 of 5 October 2026, kept by the owner on 6 October against
 * the pre-release audit's HRC-01 as an owner-accepted risk: the practice
 * directs the write and answers for the disclosure to Google, including any
 * notification it triggers; healdesk's responsibility is limited to what it
 * sends, where, and safeguarding it until it is sent. Google "will" hold the
 * appointment outside any BAA on a personal account, and "may" on a Workspace
 * account nobody has confirmed (PT-21). "Through an account Practice
 * controls": a calendar shared in to that account may belong to another.
 */
function uncoveredDirection(account: Exclude<CalendarAccount, "workspace_baa">): string {
  const holds = account === "personal" ? "will" : "may";
  return (
    "Practice nonetheless directs healdesk to add an appointment to the calendar when the " +
    "assistant books one, and when Practice's staff confirm a booking request through healdesk. " +
    `Practice gives this direction knowing that Google ${holds} hold each appointment outside ` +
    "any business associate agreement. That disclosure is made at Practice's direction, through " +
    "an account Practice controls under Practice's own agreement with Google. Practice is " +
    "responsible for it, including for any notification or other obligation that arises from " +
    "Google's handling of what it holds. healdesk's responsibility for it is limited to sending " +
    "only the details below, only to the calendar, only as this clause describes, and to " +
    "safeguarding them under this agreement until they are sent."
  );
}

const UNCOVERED_WITHDRAWAL =
  "Practice may withdraw this direction at any time, by disconnecting the calendar or by " +
  "telling healdesk. healdesk then adds nothing further to the calendar, and the assistant takes " +
  "booking requests for Practice's staff to confirm instead.";

const UNCOVERED_ACKNOWLEDGEMENT =
  "Practice acknowledges that healdesk's access to the calendar is governed by this agreement.";

/**
 * The not-used clause's opening, crediting the classification to healdesk's
 * list of booking systems, not to the practice (PT-07, ICD-25): "no" and
 * "unverified" are healdesk's records, and "Something else" names no system
 * at all, so the practice is never made to have said something it did not.
 */
function notUsedStatement(system: { name: string | null; reads: "no" | "unverified" }): string {
  if (!system.name) {
    return (
      "Practice has told healdesk that its booking system is one that healdesk's list of booking " +
      "systems does not name, so healdesk has not confirmed that it reads a Google Calendar for " +
      "conflicts."
    );
  }
  return system.reads === "no"
    ? `Practice has told healdesk that its booking system is ${system.name}, which healdesk's ` +
        `list of booking systems records as not reading a Google Calendar for conflicts.`
    : `Practice has told healdesk that its booking system is ${system.name}, which healdesk's ` +
        `list of booking systems records as not yet confirmed to read a Google Calendar for ` +
        `conflicts.`;
}

const NOT_USED_EFFECT =
  "healdesk therefore does not connect to Practice's Google Calendar, reads nothing from it and " +
  "writes nothing to it. The assistant does not book appointments itself: it takes each booking " +
  "as a request, which Practice's staff confirm in Practice's own system.";

/**
 * v1 runs a one-way or unconfirmed system in request mode only, so the only
 * route to booking live is a calendar election for a system that reads Google
 * Calendar (PT-07).
 */
const NOT_USED_CHANGE =
  "If Practice changes the location's booking system to one that reads a Google Calendar for " +
  "conflicts, Practice first records a calendar election for the location. The assistant books " +
  "into a Google Calendar only under the clause that election carries.";

/**
 * The BAA's last paragraph of every calendar clause, never the election's: in
 * the agreement the clause governs Practice's first location, the one set up
 * under the first order Practice placed for the Services (provisioning waits
 * for the first paid invoice), and every other location, or that one after a
 * change of booking system or account kind, is governed by its election. The
 * first order, not one placed on acceptance: a practice that accepts this
 * version in place of 1.2.1 places no order when it does (verification of the
 * redraft, 7 October 2026). The three kinds of account are listed, so losing
 * Google's agreement is a change of kind (ICD-26). What a calendar election
 * is, and that an accepted one is part of the agreement, is the Definitions
 * clause's.
 */
export const CALENDAR_LOCATION_PARAGRAPH =
  "This clause governs the calendar of Practice's first location, the one set up under the first " +
  "order Practice placed for the Services. The calendar of any other location is governed by the " +
  "calendar election Practice records for it. Practice also records a calendar election for the " +
  "first location when it changes that location's booking system or the kind of Google account " +
  "it uses there, and that election then governs in place of this clause. The kinds of Google " +
  "account are a Google Workspace account whose administrator has accepted Google's business " +
  "associate agreement, any other Google Workspace account, and a personal Google account.";

/**
 * The clause for one kind, wrapped at 78 columns, without the location
 * paragraph. Strict: a kind the answers contradict (covered on a personal
 * account, uncovered on a Workspace account with Google's BAA, a connected
 * kind for a manual booking system or not-used for a live one) throws rather
 * than rendering a clause whose first paragraph says something the practice
 * did not tell us. The not-used clause names the booking system and says how
 * healdesk's list classes it, so it takes the system itself.
 */
export function calendarClauseBody(input: {
  kind: CalendarTermsKind;
  account: CalendarAccount;
  bookingSystem: BookingSystemId;
}): string {
  const { kind, account, bookingSystem } = input;
  if (!isCalendarAccount(account)) {
    throw new CalendarTermsError(`Unknown calendar account: ${String(account)}`);
  }
  const system = getBookingSystem(bookingSystem);
  if (!system) {
    throw new CalendarTermsError(`Unknown booking system: ${String(bookingSystem)}`);
  }
  const live = bookingSyncFor(system.id) === "live";
  if (live !== (kind !== "not_used")) {
    throw new CalendarTermsError(
      `A ${String(kind)} calendar clause cannot describe ${system.id}, whose sync is ${live ? "live" : "manual"}.`,
    );
  }
  switch (kind) {
    case "covered":
      if (account !== "workspace_baa") {
        throw new CalendarTermsError(
          `A covered calendar clause needs a Workspace account with Google's BAA, not ${account}.`,
        );
      }
      return paragraphs(
        WHICH_CALENDAR,
        COVERED_STATEMENT,
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
        WHICH_CALENDAR,
        UNCOVERED_ACCOUNT[account],
        READS,
        `${uncoveredDirection(account)} ${WRITES}`,
        UNCOVERED_WITHDRAWAL,
        UNCOVERED_ACKNOWLEDGEMENT,
      );
    case "not_used":
      return paragraphs(
        `${notUsedStatement({
          name: bookingSystemName(system.id),
          reads: system.readsGoogleCalendar === "no" ? "no" : "unverified",
        })} ${NOT_USED_EFFECT}`,
        NOT_USED_CHANGE,
      );
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
      bookingSystem: input.bookingSystem,
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
 * a contract: the server renders it again with what the person typed, hashes
 * the exact bytes and stores version, hash and text on the election row,
 * never accepting a hash from the browser (the setup-link precedent,
 * apps/app/src/lib/onboarding/requirements.ts; apps/app
 * lib/booking/elections.ts and `calendar_elections`, drizzle/0057).
 *
 * `approvedByCounsel` keeps the BAA's name for the same thing: released for
 * use by the owner. An election under a version where it is false counts
 * only for a demo clinic (plan A10), and the database refuses one for anyone
 * else (plan §11.6): app_calendar_election_released() lists the released
 * versions, written out, and tests/database-audit.test.ts holds the two
 * lists together. calendar-election/1.0.0 was released with BAA 1.3.0 on
 * 2026-10-13 (plan C19), and the migration of that day added it there.
 *
 * To revise: add a new entry at CALENDAR_ELECTIONS[0] with a new version.
 * Never edit an existing one; an election row's stored hash points at it.
 */
export type CalendarElection = {
  /** e.g. "calendar-election/1.0.0"; stored on each election row. */
  version: string;
  /** When this text was published. Not when anyone accepted it. */
  publishedOn: string;
  /** Released for use by the owner; app_calendar_election_released() in the database agrees. */
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
    publishedOn: "2026-10-13",
    // Approved for release by the OWNER on 2026-10-13, with BAA 1.3.0, on the
    // owner's own review and without external counsel (plan C19; owner
    // answer Q2; agreement-changes.md §12.15). Drafted on 2026-10-06.
    approvedByCounsel: true,
    // The clause it carries says "this agreement" throughout, as it does in
    // the BAA; the last sentence says which agreement that is, so nobody can
    // read it as the election itself. Its section 2 is the shared clause body,
    // so the pre-release audit's calendar edits of 6 October 2026
    // (agreement-changes.md §12.14) moved this version's bytes in place while
    // it was unreleased. From its release, a new wording is a new version.
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
