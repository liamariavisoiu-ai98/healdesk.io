import {
  and,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";

/**
 * The register: find a signed business associate agreement.
 *
 * The question this exists to answer is the one asked under pressure — by a
 * clinic's counsel, by an auditor, by whoever picks up a breach notification
 * at 6pm: *did this practice sign, which version, when, and can we produce the
 * document?* Today that is answered by scrolling the ops console's list of
 * every acceptance ever recorded. That works at fifty agreements and fails
 * silently at five hundred, because the failure mode of "scroll until you see
 * it" is concluding that a signature does not exist when it does.
 *
 * ## What a row deliberately does NOT carry
 *
 * `rendered_text`. It is the entire contract, several kilobytes per row, and a
 * list of two hundred of them is not the place to hand it out — it would turn
 * a search into a bulk export of every agreement the company has ever signed,
 * over whatever surface the register is rendered on. The document has its own
 * route (`/api/agreements/[id]/pdf`), which fetches one agreement, by id,
 * deliberately. So the projection below names its columns one by one rather
 * than selecting the table: an explicit list cannot grow a text column by
 * accident when somebody adds `.select()` shorthand.
 *
 * ## Why every pattern is escaped, and why that is not a theoretical concern
 *
 * All user text reaches Postgres as a bound parameter through drizzle, so a
 * hand-built `like '%' || userInput || '%'` — the classic form — is not written
 * here and there is no string concatenation into SQL anywhere in this file.
 * But parameterisation alone does not make LIKE safe, and this is the part
 * that gets missed: the pattern *metacharacters* still live inside the bound
 * value. Measured against the dev database, not assumed:
 *
 *   - `%` and `_` in a search box are wildcards, so searching for the clinic
 *     "Half Price 50% Clinic" also returns "Half Price 50 Dollars Clinic". The
 *     operator reads that as "we have two agreements with this practice".
 *   - a backslash is LIKE's default escape character, so `Back\Slash Clinic`
 *     searched literally matches NOTHING — the pattern means "BackSlash".
 *   - a query ending in a single backslash is not a wrong answer but a hard
 *     error: `LIKE pattern must not end with escape character`. A search box
 *     that 500s on one keystroke.
 *
 * `escapeLikePattern` escapes all three, so what the operator typed is what is
 * matched. The default escape character (backslash) is left as it is rather
 * than overridden with `ESCAPE '!'`, because an explicit escape clause has to
 * be spelled as a SQL string literal and its meaning then depends on
 * `standard_conforming_strings`; the default needs no literal at all.
 *
 * ## Why keyset pagination, and why the cursor carries microseconds as text
 *
 * `OFFSET` skips rows. Agreements are inserted at the newest end of a
 * `accepted_at DESC` ordering, so a signature landing while an operator pages
 * shifts every later row down by one and page 2 begins one row after page 1
 * ended — the missed row is invisible, and this is a register whose whole
 * purpose is "we can find every one". So the cursor encodes the sort key
 * itself, `(accepted_at, id)`, and the next page asks for rows strictly after
 * it. A row inserted mid-walk is simply not in the walk.
 *
 * The cursor carries `accepted_at` as a UTC text literal with MICROSECONDS,
 * not as a JS `Date`. Postgres stores `timestamptz` to the microsecond and
 * node-postgres parses it into a `Date`, which has millisecond resolution: two
 * signatures 400 microseconds apart collapse to the same instant on the way
 * out. Round-tripping through a `Date` would emit a cursor 400 microseconds
 * EARLIER than the last row shown, and `(accepted_at, id) < cursor` would then
 * drop every row inside that millisecond — silently, and precisely under the
 * load (bulk import, load test, two tabs) that produces near-simultaneous
 * rows. `to_char(... at time zone 'UTC', ...)` keeps all six digits.
 *
 * ## Why UTC is spelled out everywhere
 *
 * `retention_eligible_at` is a generated column computed `at time zone 'UTC'`
 * (drizzle/0025), so a register that filtered on a session-local day boundary
 * would put a row on one calendar day for the date filter and a different one
 * for the retention clock. Date-only filters here are UTC days, full instants
 * must carry an explicit offset, and nothing depends on the session TimeZone.
 *
 * ## Why there is no tenant scope
 *
 * `baa_acceptances` has no `clinic_id` and no row-level security, for the
 * reasons drizzle/0025 sets out at length: acceptance happens before an
 * organization exists, so a policy could only reference a tenant decoratively.
 * `lib/agreements.ts` and `lib/agreements/retention.ts` both read it through
 * `unsafeDb`, and so does this. That is the honest state of the table, not a
 * scope invented here — every caller of this module is therefore reading the
 * whole register, and authorising the reader is the caller's job.
 */

/** Thrown for input this module refuses rather than silently reinterprets. */
export class AgreementSearchError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "AgreementSearchError";
  }
}

/**
 * The three states, and they PARTITION: every agreement is in exactly one.
 *
 * Same three as `lib/agreements/retention.ts`, under the shorter labels the
 * register renders, and deliberately the same rule — two modules reading one
 * table must not disagree about what "terminated" means:
 *
 *   in_effect        = retention.ts "in_effect"           (terminated_at null)
 *   terminated       = retention.ts "terminated_retained" (inside the floor)
 *   retention_review = retention.ts "eligible_for_review" (past the floor)
 *
 * Note what `terminated` therefore does NOT mean: it is not "every agreement
 * that has ended", it is the ones that have ended and are still inside the
 * six-year retention floor. A caller that wants all of them reads
 * `terminatedAt`, which every row carries. Overlapping statuses would make the
 * `status` on a row a coin toss between two true answers.
 */
export type AgreementStatus = "in_effect" | "terminated" | "retention_review";

export type AgreementFilter = {
  /**
   * Free text over clinic legal name, signatory name, signatory email and the
   * document hash. Case-insensitive; blank or whitespace-only is not a filter.
   */
  query?: string;
  /**
   * Inclusive lower bound on `accepted_at`: a UTC calendar day (YYYY-MM-DD),
   * or an ISO instant that carries an explicit offset. An instant bound is
   * precise to the millisecond, since that is as far as a JavaScript Date
   * goes; a day bound is exact, because its edges are whole days.
   */
  signedFrom?: string;
  /** Inclusive upper bound: a bare date includes the whole of that UTC day. */
  signedTo?: string;
  /** Exact template version, e.g. "0.0.0-draft". */
  version?: string;
  status?: AgreementStatus;
  /** true: a copy has been delivered. false: it has not. */
  copySent?: boolean;
  /** Default 50, clamped to 200. Non-integers are refused, not rounded. */
  limit?: number;
  /** Opaque, from a previous result's `nextCursor`. */
  cursor?: string;
};

export type AgreementRow = {
  id: string;
  /**
   * From the signed variables, where the clinic's legal name actually lives —
   * the table has no column for it. Null when the stored document carried
   * none, which is a fact about that row and not a reason to invent a label.
   */
  clinicLegalName: string | null;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
  /** Template version accepted. */
  version: string;
  /** SHA-256 of the document as rendered and stored. 64 lowercase hex. */
  documentHash: string;
  acceptedAt: Date;
  /**
   * Whether the counterparty has been sent their copy. Derived here rather
   * than left to the caller so the badge on the row and the `copySent` filter
   * cannot drift apart: one definition, used twice.
   */
  copySent: boolean;
  copySentAt: Date | null;
  /** Null while the agreement is in effect. */
  terminatedAt: Date | null;
  /**
   * The generated column, straight from the database: the earliest date this
   * row could EVER become eligible for review. For a live agreement that is
   * signature + 6 years and a LOWER BOUND only, since the clock restarts at
   * termination. It is never a deletion date; nothing in this system deletes.
   */
  retentionFloorAt: Date;
  /**
   * When the row became (or becomes) eligible for review, and null while the
   * agreement is still in effect — an honest absence rather than a date that
   * would be a guess dressed as a fact. Same rule as retention.ts.
   */
  eligibleAt: Date | null;
  status: AgreementStatus;
};

export type AgreementSearchResult = {
  rows: AgreementRow[];
  /** Null when this page is the last one. */
  nextCursor: string | null;
  /**
   * How many agreements match the FILTERS, ignoring the cursor: the count is
   * the answer to "how many are there", which must not shrink as the operator
   * pages through them.
   */
  total: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Milliseconds in a UTC day. UTC has no DST, so this is exact. */
const DAY_MS = 86_400_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** An instant is only unambiguous with an explicit offset. See parseInstant. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const HEX = /^[0-9a-f]+$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What to_char emits below, and the only thing decodeCursor will accept. */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * The clinic's legal name lives in the signed variables, not in a column.
 *
 * `->>` yields NULL for a missing key rather than raising, so an older row
 * written before a variable existed is still findable by signer and by hash
 * instead of failing the whole query.
 */
const CLINIC_LEGAL_NAME: SQL = sql`(${baaAcceptances.variables} ->> 'clinicLegalName')`;

/**
 * One definition of the three states, used for BOTH the projection and the
 * filter, so a row can never be listed under a status the filter disagrees
 * with. `now()` is the transaction timestamp, so every use within one
 * statement sees the same instant.
 */
const STATUS: SQL = sql`case
      when ${baaAcceptances.terminatedAt} is null then 'in_effect'
      when ${baaAcceptances.retentionEligibleAt} > now() then 'terminated'
      else 'retention_review'
    end`;

/**
 * The sort key, rendered exactly.
 *
 * UTC and microseconds, both load-bearing: see the cursor discussion above.
 */
const CURSOR_AT: SQL<string> = sql<string>`to_char(${baaAcceptances.acceptedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Search the register.
 *
 * Two statements: the page, and the count of everything matching the same
 * filters. They are not in one transaction and they need not be — a row that
 * crossed its six-year floor between them would move the total by one, and a
 * register that reported 41 beside 40 rows is not a failure worth a
 * transaction on a read-only listing.
 */
export async function searchAgreements(
  filter: AgreementFilter = {},
): Promise<AgreementSearchResult> {
  const limit = resolveLimit(filter.limit);
  // A blank cursor is no cursor, the same as every other blank filter here:
  // `?cursor=` in a query string means the first page, not a broken request.
  // Anything non-blank that does not decode is still refused. Trimmed like
  // every other filter, so a cursor that picked up whitespace crossing the
  // signed API boundary is the position it says it is rather than a 500.
  const cursor = isPresent(filter.cursor)
    ? decodeCursor(filter.cursor.trim())
    : null;

  const filters = buildFilters(filter);

  // The cursor narrows the page but must NOT narrow the total; the operator is
  // paging through a fixed answer, not watching it shrink.
  const scan = cursor
    ? [
        ...filters,
        sql`(${baaAcceptances.acceptedAt}, ${baaAcceptances.id}) < (${cursor.acceptedAt}::timestamptz, ${cursor.id}::uuid)`,
      ]
    : filters;

  // One row more than asked for: the only honest way to know whether a next
  // page exists. Returning a cursor because the page came back full hands the
  // caller a "next" that leads to nothing.
  const found = await unsafeDb
    .select({
      id: baaAcceptances.id,
      clinicLegalName: sql<string | null>`${CLINIC_LEGAL_NAME}`,
      signatoryName: baaAcceptances.acceptedByName,
      signatoryEmail: baaAcceptances.acceptedByEmail,
      signatoryTitle: baaAcceptances.acceptedByTitle,
      version: baaAcceptances.documentVersion,
      documentHash: baaAcceptances.documentHash,
      acceptedAt: baaAcceptances.acceptedAt,
      copySentAt: baaAcceptances.copySentAt,
      terminatedAt: baaAcceptances.terminatedAt,
      retentionFloorAt: baaAcceptances.retentionEligibleAt,
      status: sql<string>`${STATUS}`,
      cursorAt: CURSOR_AT,
    })
    .from(baaAcceptances)
    .where(scan.length ? and(...scan) : undefined)
    .orderBy(desc(baaAcceptances.acceptedAt), desc(baaAcceptances.id))
    .limit(limit + 1);

  const [counted] = await unsafeDb
    .select({ total: sql<number>`count(*)::int` })
    .from(baaAcceptances)
    .where(filters.length ? and(...filters) : undefined);

  const page = found.slice(0, limit);
  const last = page[page.length - 1];

  return {
    rows: page.map(toRow),
    nextCursor:
      found.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    total: counted?.total ?? 0,
  };
}

type FoundRow = {
  id: string;
  clinicLegalName: string | null;
  signatoryName: string;
  signatoryEmail: string;
  signatoryTitle: string | null;
  version: string;
  documentHash: string;
  acceptedAt: Date;
  copySentAt: Date | null;
  terminatedAt: Date | null;
  retentionFloorAt: Date;
  status: string;
  cursorAt: string;
};

function toRow(row: FoundRow): AgreementRow {
  const status = toStatus(row.status);
  const name = row.clinicLegalName?.trim();

  return {
    id: row.id,
    clinicLegalName: name ? name : null,
    signatoryName: row.signatoryName,
    signatoryEmail: row.signatoryEmail,
    signatoryTitle: row.signatoryTitle,
    version: row.version,
    documentHash: row.documentHash,
    acceptedAt: row.acceptedAt,
    copySent: row.copySentAt !== null,
    copySentAt: row.copySentAt,
    terminatedAt: row.terminatedAt,
    retentionFloorAt: row.retentionFloorAt,
    // The floor is only an eligibility date once the agreement has actually
    // stopped being in effect. Until then we do not know, and say so.
    eligibleAt: status === "in_effect" ? null : row.retentionFloorAt,
    status,
  };
}

/** The one membership test, used on the way in and on the way out. */
function isStatus(value: string): value is AgreementStatus {
  return (
    value === "in_effect" ||
    value === "terminated" ||
    value === "retention_review"
  );
}

/**
 * Narrow the database's answer instead of asserting it.
 *
 * `as AgreementStatus` on a string from a CASE expression would be a lie the
 * type system could not catch if someone edited STATUS and forgot this union.
 */
function toStatus(value: string): AgreementStatus {
  if (isStatus(value)) return value;
  throw new AgreementSearchError(
    `Unrecognised agreement status from the database: ${value}`,
  );
}

/**
 * Check the status again at runtime, even though the type says it is safe.
 *
 * The register is read across an app boundary: apps/web holds no database
 * driver, so every filter on this page arrives as JSON over the signed HMAC
 * and the union above is a compile-time promise about a value that was parsed
 * at run time. An unrecognised status would otherwise compare equal to nothing
 * and return an empty page — the register answering "no such agreement" when
 * what it means is "I did not understand you", which is the single failure
 * this module exists to prevent.
 */
function assertStatus(value: string): AgreementStatus {
  if (isStatus(value)) return value;
  throw new AgreementSearchError(
    "status must be in_effect, terminated or retention_review.",
    "status",
  );
}

function buildFilters(filter: AgreementFilter): SQL[] {
  const filters: SQL[] = [];

  const text = textFilter(filter.query);
  if (text) filters.push(text);

  if (isPresent(filter.signedFrom)) {
    // Inclusive: a date-only bound starts at 00:00:00.000000 UTC of that day.
    const from = parseInstant(filter.signedFrom, "signedFrom");
    filters.push(gte(baaAcceptances.acceptedAt, from.at));
  }

  if (isPresent(filter.signedTo)) {
    const to = parseInstant(filter.signedTo, "signedTo");
    // A bare date means the WHOLE of that UTC day, so the bound is exclusive
    // on the following midnight. `<= date` would silently exclude every
    // agreement signed after midnight on the day the operator asked for,
    // which is all of them.
    filters.push(
      to.dateOnly
        ? lt(baaAcceptances.acceptedAt, new Date(to.at.getTime() + DAY_MS))
        : lte(baaAcceptances.acceptedAt, to.at),
    );
  }

  if (isPresent(filter.version)) {
    filters.push(eq(baaAcceptances.documentVersion, filter.version.trim()));
  }

  if (filter.status !== undefined) {
    filters.push(sql`${STATUS} = ${assertStatus(filter.status)}`);
  }

  if (filter.copySent !== undefined) {
    filters.push(
      filter.copySent
        ? isNotNull(baaAcceptances.copySentAt)
        : isNull(baaAcceptances.copySentAt),
    );
  }

  return filters;
}

/**
 * Free text: name, signer, email, hash prefix.
 *
 * The hash is matched as a PREFIX because nobody types 64 hex characters, and
 * a fingerprint is how an agreement gets identified in a mail thread or a
 * support ticket. It is only attempted when the query could be a prefix of a
 * digest at all: a non-hex string cannot match one, so testing it is work
 * whose answer is known.
 */
function textFilter(query: string | undefined): SQL | undefined {
  if (!isPresent(query)) return undefined;

  const text = query.trim();
  const escaped = escapeLikePattern(text);
  const contains = `%${escaped}%`;

  const clauses: SQL[] = [
    ilike(CLINIC_LEGAL_NAME, contains),
    ilike(baaAcceptances.acceptedByName, contains),
    ilike(baaAcceptances.acceptedByEmail, contains),
  ];

  if (HEX.test(text)) {
    clauses.push(ilike(baaAcceptances.documentHash, `${escaped}%`));
  }

  return or(...clauses);
}

/**
 * Make user text mean itself.
 *
 * Backslash first — escaping it after `%` and `_` would escape the escapes.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A UTC day, or an instant that says what it is.
 *
 * `new Date("2026-04-01T10:00:00")` — no offset — is parsed in the SERVER's
 * local zone, so the same filter would select different agreements on a laptop
 * and in a container. Rather than guess, an instant without an offset is
 * refused. A calendar date is unambiguous by convention here: UTC, matching
 * the generated retention column.
 */
function parseInstant(
  value: string,
  field: "signedFrom" | "signedTo",
): { at: Date; dateOnly: boolean } {
  const text = value.trim();

  if (DATE_ONLY.test(text)) {
    const at = new Date(`${text}T00:00:00.000Z`);
    // Rejects 2026-02-31 and friends, which some engines roll forward into a
    // real date rather than refusing.
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
      throw new AgreementSearchError(
        `${field} is not a real calendar date.`,
        field,
      );
    }
    return { at, dateOnly: true };
  }

  if (!HAS_OFFSET.test(text)) {
    throw new AgreementSearchError(
      `${field} must be a date (YYYY-MM-DD) or an instant with an explicit UTC offset.`,
      field,
    );
  }

  const at = new Date(text);
  if (Number.isNaN(at.getTime())) {
    throw new AgreementSearchError(`${field} is not a valid date.`, field);
  }
  return { at, dateOnly: false };
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  // Clamped at the top (a caller asking for everything gets a page), refused
  // at the bottom: 0, -1 and NaN are bugs, and a silent default would hide
  // one behind a page of results that looks fine.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgreementSearchError(
      "limit must be a positive whole number.",
      "limit",
    );
  }
  return Math.min(limit, MAX_LIMIT);
}

/**
 * The cursor is opaque to the caller and untrusted by this module.
 *
 * base64url so it survives a query string. Both halves are re-validated on the
 * way back in: the value reaches Postgres as a bound parameter either way, so
 * this is not the injection defence — it is so a mangled or hand-edited cursor
 * fails as a typed error here rather than as a `22007 invalid input syntax`
 * from the driver, which reads like an outage. A cursor carries a position and
 * nothing else: it cannot widen a result beyond the filters it is used with.
 */
function encodeCursor(acceptedAt: string, id: string): string {
  return Buffer.from(`${acceptedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { acceptedAt: string; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const split = decoded.indexOf("|");
  const acceptedAt = split === -1 ? "" : decoded.slice(0, split);
  const id = split === -1 ? "" : decoded.slice(split + 1);

  if (!CURSOR_INSTANT.test(acceptedAt) || !UUID.test(id)) {
    throw new AgreementSearchError("Malformed cursor.", "cursor");
  }

  return { acceptedAt, id };
}
