import { createHash } from "node:crypto";

import { wrap } from "./wrap";

/**
 * The Direct booking addendum — the practice's election that the telephone
 * assistant may book a caller straight into the calendar it connected.
 *
 * It is a standalone, versioned document rather than a clause the practice
 * ticks inside the BAA, for one reason: the BAA revision that carries the
 * same text (1.1.0-draft, clause `direct-booking`) is under counsel review
 * and cannot be put in front of a clinic, while a practice that signed 1.0.0
 * may still want to elect direct booking once this text is approved. So the
 * clause body lives HERE, once, and baa.ts imports it: the two documents
 * cannot drift, and the election is evidenced by this addendum's own hash —
 * never by hashing a clause out of the unapproved draft (design of
 * 23 September 2026, decision (g) and §E.6).
 *
 * How it is used:
 *
 *   - The setup page renders the Direct booking section only while
 *     `currentDirectBookingAddendum().approvedByCounsel` is true. Until then
 *     the section is absent. The console's switch that read this flag,
 *     `setBookingMode`, was removed in C17: the booking mode is derived
 *     (apps/app/src/lib/booking/mode.ts) from the location's calendar terms,
 *     its Google Calendar, Auto-confirm and the owner's kill switch, and
 *     reads neither this flag nor the election.
 *   - On acceptance the server renders the text again with the name and
 *     title the person typed, and stores `direct_booking_clause_version =
 *     addendum.version` and `direct_booking_clause_hash = sha256(text)`.
 *     `direct_booking_elected_at` is the timestamp; the row's CHECK makes
 *     `booking_mode = 'direct'` unrepresentable without those columns.
 *   - The golden test in apps/app/tests/baa-golden.test.ts freezes the
 *     rendered bytes, so an edit to the text is a failing test rather than a
 *     silent change to a document a practice may have accepted.
 *
 * To revise: add a new entry at DIRECT_BOOKING_ADDENDUMS[0] with a new
 * version. Never edit an existing one — a clinic's stored hash points at it.
 *
 * v1 note: the v1 spec has the assistant book straight into the clinic's
 * Google Calendar on every channel, with "Auto-confirm bookings" on by
 * default, and says nothing of an addendum. The Cal.com write this text was
 * drafted around was removed. Whether the Google Calendar path needs this
 * election at all is a question for counsel. The booking mode does not ask
 * for it: the location's calendar terms decide
 * (apps/app/src/lib/booking/mode.ts). The text below is unchanged.
 */

export type DirectBookingAddendum = {
  /** e.g. "direct-booking-addendum/1.0.0"; stored on the clinic row. */
  version: string;
  /** When this text was published. Not when anyone accepted it. */
  publishedOn: string;
  /**
   * True once counsel has approved this text. The setup page hides the
   * section, and refuses an acceptance, while it is false. The booking mode
   * never reads it (apps/app/src/lib/booking/mode.ts).
   */
  approvedByCounsel: boolean;
  heading: string;
  /** The operative clause. Identical to the BAA's `direct-booking` clause. */
  body: string;
  /** The sentence that makes ticking it an acceptance. */
  acceptance: string;
};

export type DirectBookingAddendumVariables = {
  /** The practice's legal name, as on its BAA. */
  clinicLegalName: string;
  /** Typed by the person accepting. This is the signature. */
  signatoryName: string;
  signatoryTitle?: string;
  /** ISO date. The day they accepted, not the day the text was published. */
  acceptedOn: string;
};

export class DirectBookingAddendumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectBookingAddendumError";
  }
}

export const DIRECT_BOOKING_CLAUSE_HEADING = "Direct booking, by Practice's election";

/**
 * ⚖️ The clause, verbatim from the design of 23 September 2026 (§I.2). Not
 * counsel-approved. Rendered in two places from this one string: the BAA
 * 1.1.0-draft clause `direct-booking` (when `bookingMode` is "direct") and
 * this addendum.
 */
export const DIRECT_BOOKING_CLAUSE_BODY =
  "Practice has elected that healdesk's telephone assistant may, on telephone calls only, " +
  "read availability from and create appointments in the calendar Practice connected for " +
  "that purpose, at a time the assistant read as free from that calendar, and may state the " +
  "booked time to the caller. Practice is responsible for those appointments as for any " +
  "booked by its own staff, including the availability it publishes to that calendar and any " +
  "deposit it requires; healdesk's responsibility is limited to booking only into that " +
  "calendar, only at a time it showed as free, and only the details permitted by this " +
  "agreement's minimum-necessary clause, and healdesk remains responsible for safeguarding " +
  "the PHI involved under this agreement. Practice may withdraw the election at any time by " +
  "notice, after which the assistant reverts to handing requests to Practice's front desk.";

/** §E.6: the sentence that turns the clause into something a person accepts. */
export const DIRECT_BOOKING_ACCEPTANCE =
  "This addendum amends the Business Associate Agreement between Practice and healdesk and " +
  "is accepted by the person named below, who confirms authority to bind Practice.";

export const DIRECT_BOOKING_ADDENDUM_VERSION = "direct-booking-addendum/1.0.0";

export const DIRECT_BOOKING_ADDENDUMS: readonly DirectBookingAddendum[] = [
  // Newest first; currentDirectBookingAddendum() reads [0].
  {
    version: DIRECT_BOOKING_ADDENDUM_VERSION,
    publishedOn: "2026-09-29",
    approvedByCounsel: false,
    heading: DIRECT_BOOKING_CLAUSE_HEADING,
    body: DIRECT_BOOKING_CLAUSE_BODY,
    acceptance: DIRECT_BOOKING_ACCEPTANCE,
  },
] as const;

export function currentDirectBookingAddendum(): DirectBookingAddendum {
  return DIRECT_BOOKING_ADDENDUMS[0]!;
}

export function getDirectBookingAddendum(version: string): DirectBookingAddendum | undefined {
  return DIRECT_BOOKING_ADDENDUMS.find((a) => a.version === version);
}

/**
 * The exact text a practice accepts.
 *
 * Strict about its inputs for the same reason renderBaa is: an addendum that
 * names nobody looks complete and binds no one. The layout mirrors the BAA —
 * numbered, upper-case headings, 78-column wrap — so the two read as one
 * instrument when printed together.
 */
export function renderDirectBookingAddendum(
  variables: DirectBookingAddendumVariables,
  addendum: DirectBookingAddendum = currentDirectBookingAddendum(),
): string {
  requireField(variables.clinicLegalName, "clinicLegalName");
  requireField(variables.signatoryName, "signatoryName");
  const title = variables.signatoryTitle?.trim() ? `, ${variables.signatoryTitle.trim()}` : "";

  const text = [
    `DIRECT BOOKING ADDENDUM`,
    `to the healdesk Business Associate Agreement`,
    `Version ${addendum.version}`,
    ``,
    `PRACTICE`,
    `  ${variables.clinicLegalName.trim()} ("Practice")`,
    ``,
    `1. ${addendum.heading.toUpperCase()}`,
    ``,
    wrap(addendum.body),
    ``,
    `2. ACCEPTANCE`,
    ``,
    wrap(addendum.acceptance),
    ``,
    `ACCEPTED FOR PRACTICE BY`,
    `  ${variables.signatoryName.trim()}${title}`,
    ``,
    `ACCEPTED ${formatDate(variables.acceptedOn)}`,
  ].join("\n");

  if (/\{\{/.test(text)) {
    throw new DirectBookingAddendumError("Unsubstituted placeholder in the addendum text.");
  }
  return text;
}

/**
 * SHA-256 hex of the exact rendered text — the same digest `hashBaaText`
 * produces, computed here rather than imported so this module does not
 * depend on baa.ts (which depends on it).
 */
export function hashDirectBookingAddendum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Render, hash and name the version in one step, as prepareBaa does. */
export function prepareDirectBookingAddendum(
  variables: DirectBookingAddendumVariables,
  addendum: DirectBookingAddendum = currentDirectBookingAddendum(),
): { text: string; hash: string; version: string } {
  const text = renderDirectBookingAddendum(variables, addendum);
  return { text, hash: hashDirectBookingAddendum(text), version: addendum.version };
}

function requireField(value: string | undefined, field: string): void {
  if (!value?.trim()) {
    throw new DirectBookingAddendumError(`${field} is required to render the addendum.`);
  }
}

/** "2026-09-29" → "29 September 2026". Mirrors baa.ts's formatDate. */
function formatDate(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new DirectBookingAddendumError(`Invalid acceptance date: ${iso}`);
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
