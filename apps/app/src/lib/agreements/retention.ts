import { and, sql, type SQL } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances } from "@/db/schema";

/**
 * What we are holding, and for how long: a read-only report on the retention
 * clock for signed business associate agreements.
 *
 * 45 CFR 164.530(j)(2) requires the documentation to be kept six years "from
 * the date of its creation or the date when it last was in effect, whichever is
 * later"; 164.316(b)(2)(i) says the same for the security rule's. For a BAA,
 * "last in effect" is TERMINATION — so the clock is
 * greatest(accepted_at, terminated_at) + 6 years, and a clinic that stays three
 * years owes nine years from the day they signed.
 *
 * Computing it from acceptedAt alone is the classic error, and it is the
 * expensive direction to be wrong in: it marks agreements that are still in
 * force as expired, and an "expired" record is the first thing anyone destroys.
 * So the date is not computed here at all. `retentionEligibleAt` is a GENERATED
 * column (drizzle/0025) — Postgres derives it, no INSERT or UPDATE can write
 * it, and two readers cannot get two answers.
 *
 * ## This module reads. It does not write, and it does not delete
 *
 * Six years is a FLOOR, not a schedule. Nothing here destroys anything, and
 * nothing here asks anything else to. That is deliberate at three levels, and
 * all three have to be true for the guarantee to mean anything:
 *
 *   - `healdesk_app` holds no DELETE on the table (drizzle/0006, re-asserted in
 *     0025), so this code physically cannot purge a row even if it tried.
 *   - Eligibility is not permission. A row past its floor may still be under
 *     litigation hold, may belong to a state whose own retention period is
 *     longer than six years, or may simply be one nobody has looked at. The
 *     regulation sets a minimum; it does not ask us to delete on the
 *     anniversary.
 *   - A background job that destroys legal records on a timer fails silently and
 *     in the wrong direction. Purging is a deliberate act by a person holding
 *     the migrator role, on a row this module can show is eligible — a decision
 *     with a name attached, not a cron entry.
 *
 * ## One writer per column, and none of them is in this file
 *
 * Each of the three recorded facts is write-once in the database (drizzle/0025
 * refuses to change one, for every role including the table owner), so a wrong
 * value is uncorrectable without the migrator role. A second writer for a
 * column like that is not redundancy, it is a coin toss: whichever one happens
 * to be called decides a fact nobody can edit afterwards. So there is exactly
 * one writer for each, and it is somewhere else:
 *
 *   - `terminated_at` — `markAgreementTerminated`, the ops API operation in
 *     lib/ops/api.ts that the admin console at healdesk.io/admin calls. It
 *     takes a calendar date and stores the LAST instant of that day, because an
 *     agreement that ended on the 7th was in effect for all of the 7th; storing
 *     midnight would leave every retention floor in the system twenty-four
 *     hours short of the statute. That writer is also where the two limits on
 *     the date live, and they live nowhere else: it refuses a date earlier than
 *     the signature (which the table's own CHECK refuses as well) and a date
 *     that has not happened yet, because a prediction stamped into a write-once
 *     column is a termination that may never occur, and it would pull the floor
 *     years earlier than the truth. Nothing in THIS file enforces either one:
 *     this file reads, and a reader that described a guard it does not perform
 *     would be documenting a safeguard nobody has. This module briefly carried
 *     a second implementation of the same write, under the same name, that took
 *     a bare Date and did NOT normalise it — so the two disagreed by up to a day
 *     on a column that cannot be corrected afterwards. It has been removed
 *     rather than left exported for someone to find and call.
 *   - `copy_sent_at` and `copy_document_sha256` — `deliverSignedCopy` in
 *     lib/agreements.ts, on the same code path that produced the file and
 *     handed it to the transport, because the digest recorded has to be of the
 *     bytes that actually went out. A writer here could only take a date and a
 *     digest on trust — stamping, permanently and with no proof, that a
 *     counterparty received a document nobody in this call stack ever built.
 *
 * ## ⚠️ Nothing in the application imports this module yet
 *
 * Stated at the top rather than discovered by grep. The retention state an
 * operator actually sees is computed by `searchAgreements` in
 * lib/agreements/search.ts and rendered by the register at
 * /admin/agreements in apps/web, from the same generated column and to the
 * same rule: a live agreement gets no date. What is
 * below is that rule for a caller that wants it as a query rather than as a
 * screen — an ops report, a compliance export — and it is unused until somebody
 * writes one. It reads; there is nothing here for an unwary caller to break.
 *
 * ## Why the status is computed rather than read straight off the column
 *
 * While `terminatedAt` is null, the generated column is signature + 6 years —
 * computed from creation alone, because the end of a live agreement's clock is
 * not yet knowable. Reading it as an eligibility date is precisely the error
 * this file exists to prevent: a seven-year-old agreement that is still in
 * force is not eligible for anything. So a live row reports `eligibleAt: null`
 * — an honest absence rather than a date that would be a guess dressed as a
 * fact — and its floor is reported separately, under a name that says what it
 * is.
 *
 * ## Why this is not `withTenant`
 *
 * Same reason as lib/agreements.ts: the table has no clinic_id, it is written
 * before an organization exists, and ops reads it across all of them. This is
 * the identity plane.
 */

/** Thrown when the database answers with something this module cannot honour. */
export class RetentionError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "RetentionError";
  }
}

export type RetentionStatus =
  /** No termination recorded. In force, and never eligible however old it is. */
  | "in_effect"
  /** Terminated, and inside the six-year floor. Keep. */
  | "terminated_retained"
  /** Terminated, and past the floor. Eligible for REVIEW by a person. */
  | "eligible_for_review";

export type RetentionRow = {
  id: string;
  /** Null for an agreement signed but never paid for — still a live record. */
  organizationId: string | null;
  /**
   * From the signed variables. Null when the stored document carried no clinic
   * name, which is a fact about that row, not a reason to invent a label.
   */
  clinicLegalName: string | null;
  signerEmail: string;
  documentVersion: string;
  acceptedAt: Date;
  boundAt: Date | null;
  terminatedAt: Date | null;
  /** Null when the counterparty has never been sent their copy. */
  copySentAt: Date | null;
  copyDocumentSha256: string | null;
  /**
   * The earliest date this row could EVER become eligible, straight from the
   * generated column. For a live agreement this is signature + 6 years and is
   * a lower bound only — the clock restarts from termination whenever that
   * happens. It is never a deletion date.
   */
  retentionFloorAt: Date;
  /**
   * When the row became (or becomes) eligible for review — null while the
   * agreement is in effect, because that date is not knowable yet.
   */
  eligibleAt: Date | null;
  status: RetentionStatus;
};

export type RetentionQuery = {
  status?: RetentionStatus;
  organizationId?: string;
  /** Default 200, as in unboundAgreements. Clamped to 1000. */
  limit?: number;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * The one definition of the three states, in SQL.
 *
 * Written once and used twice — for the projection and for the filter — so a
 * row can never be listed under a status the filter disagrees with. `now()` is
 * the transaction timestamp, so both uses see the same instant.
 */
const STATUS_EXPRESSION: SQL = sql`case
      when ${baaAcceptances.terminatedAt} is null then 'in_effect'
      when ${baaAcceptances.retentionEligibleAt} > now() then 'terminated_retained'
      else 'eligible_for_review'
    end`;

/**
 * What we are holding, and what a person should look at.
 *
 * A report, not a sweep. Terminated rows come first, earliest floor first,
 * because those are the only ones that can ever need a decision; live
 * agreements follow and are never marked eligible, whatever their age.
 */
export async function listRetentionStatus(
  opts: RetentionQuery = {},
): Promise<RetentionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const filters: SQL[] = [];
  if (opts.status) {
    filters.push(sql`${STATUS_EXPRESSION} = ${opts.status}`);
  }
  if (opts.organizationId) {
    filters.push(sql`${baaAcceptances.organizationId} = ${opts.organizationId}`);
  }

  const rows = await unsafeDb
    .select({
      id: baaAcceptances.id,
      organizationId: baaAcceptances.organizationId,
      variables: baaAcceptances.variables,
      signerEmail: baaAcceptances.acceptedByEmail,
      documentVersion: baaAcceptances.documentVersion,
      acceptedAt: baaAcceptances.acceptedAt,
      boundAt: baaAcceptances.boundAt,
      terminatedAt: baaAcceptances.terminatedAt,
      copySentAt: baaAcceptances.copySentAt,
      copyDocumentSha256: baaAcceptances.copyDocumentSha256,
      retentionFloorAt: baaAcceptances.retentionEligibleAt,
      status: STATUS_EXPRESSION,
    })
    .from(baaAcceptances)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(
      sql`(${baaAcceptances.terminatedAt} is null) asc, ${baaAcceptances.retentionEligibleAt} asc`,
    )
    .limit(limit);

  return rows.map((row) => {
    const status = toRetentionStatus(row.status);
    return {
      id: row.id,
      organizationId: row.organizationId,
      clinicLegalName: clinicNameFrom(row.variables),
      signerEmail: row.signerEmail,
      documentVersion: row.documentVersion,
      acceptedAt: row.acceptedAt,
      boundAt: row.boundAt,
      terminatedAt: row.terminatedAt,
      copySentAt: row.copySentAt,
      copyDocumentSha256: row.copyDocumentSha256,
      retentionFloorAt: row.retentionFloorAt,
      // The floor is only an eligibility date once the agreement has actually
      // stopped being in effect. Until then we do not know, and say so.
      eligibleAt: status === "in_effect" ? null : row.retentionFloorAt,
      status,
    };
  });
}

/**
 * Narrow the database's answer instead of asserting it.
 *
 * `as RetentionStatus` on a string from a CASE expression would be a lie the
 * type system could not catch if someone edited STATUS_EXPRESSION and forgot
 * this union. Throwing means such an edit fails immediately and visibly.
 */
function toRetentionStatus(value: unknown): RetentionStatus {
  if (
    value === "in_effect" ||
    value === "terminated_retained" ||
    value === "eligible_for_review"
  ) {
    return value;
  }
  throw new RetentionError(
    `Unrecognised retention status from the database: ${String(value)}`,
  );
}

function clinicNameFrom(variables: Record<string, unknown>): string | null {
  const name = variables?.clinicLegalName;
  return typeof name === "string" && name.trim() ? name : null;
}
