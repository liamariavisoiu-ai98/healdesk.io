import {
  CALENDAR_CLAUSE_IDS_1_3,
  type BookingSync,
  type BookingSystemId,
  type CalendarAccount,
  type CalendarClauseId,
  type CalendarTermsKind,
} from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import type { CalendarElectionSource } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * A location's calendar terms in effect (plan §2.7 to §2.9): which of the
 * three Google Calendar clauses governs it now, and so whether healdesk may
 * write to its calendar at all.
 *
 * Read fresh on every call and never cached, in the transaction the caller
 * already has open. The rule is the database's, applied once here and once
 * in app_calendar_write_permitted() (drizzle/0057), so the two cannot
 * disagree:
 *
 *   1. No agreement in effect (app_agreement_in_effect, 0048): `none`. A
 *      terminated agreement voids every location of its organisation.
 *   2. Otherwise the location's NEWEST calendar_elections row anchored to
 *      that agreement decides, and nothing ever falls back to an older one.
 *      No row: `needs_election`, `legacy_agreement` when the agreement holds
 *      no 1.3.0 calendar clause (every signature before 1.3.0), `location`
 *      when it does but this location has no row (a location added later,
 *      whose terms the signed clause does not govern). A superseded
 *      agreement leaves the location set up at signing a row: the new
 *      signature's own terms, recorded as its `agreement` row in the
 *      transaction that binds it (recordSupersedingTerms, 19 October 2026).
 *      Any other location's elections stay under the old agreement, so it
 *      reads `location` until it records one.
 *   3. The newest row counts when it came from the agreement itself, its
 *      election document was released when it was recorded, or the location
 *      is a demo clinic (app_clinic_is_demo). A draft row on any other
 *      location is `needs_election` / `draft_terms`: a document flag the
 *      catalogue flips later never upgrades a row recorded as a draft.
 *
 * Nothing here reads Stripe, the browser, the current template or
 * billing_clinic_id: the terms come from the signed acceptance and the
 * location's own elections, and from nothing anyone can change in passing.
 * Offboarding, the connection's health and Auto-confirm are the booking
 * mode's to weigh (plan §8.1); `allowsWrite` says only what the terms allow.
 */

export type CalendarTermsNeedsElectionReason = "legacy_agreement" | "location" | "draft_terms";

/** Terms a location is under: covered, uncovered or not used. */
export type CalendarTermsInEffect = {
  kind: CalendarTermsKind;
  account: CalendarAccount;
  sync: BookingSync;
  bookingSystem: BookingSystemId;
  clauseId: CalendarClauseId;
  source: CalendarElectionSource;
  electionId: string;
  sequence: number;
  electedAt: Date;
  /** The agreement's version for an `agreement` row; the election document's otherwise. */
  documentVersion: string;
  documentReleased: boolean;
  ownerConfirmed: boolean;
  agreementId: string;
  agreementVersion: string;
  /** Covered and uncovered: healdesk may add bookings to the calendar, its connection allowing. */
  allowsWrite: boolean;
  demo: boolean;
};

export type CalendarTerms =
  | { kind: "none"; reason: "no_agreement"; allowsWrite: false; demo: boolean }
  | {
      kind: "needs_election";
      reason: CalendarTermsNeedsElectionReason;
      allowsWrite: false;
      agreementId: string;
      agreementVersion: string;
      /** The newest row, when it is a draft that does not count here. */
      electionId: string | null;
      demo: boolean;
    }
  | CalendarTermsInEffect;

type TermsRow = {
  demo: boolean;
  agreement_id: string | null;
  agreement_version: string | null;
  applied_clauses: unknown;
  election_id: string | null;
  sequence: number | null;
  source: CalendarElectionSource | null;
  terms_kind: CalendarTermsKind | null;
  clause_id: CalendarClauseId | null;
  calendar_account: CalendarAccount | null;
  booking_sync: BookingSync | null;
  booking_system: BookingSystemId | null;
  document_version: string | null;
  document_released: boolean | null;
  owner_confirmed: boolean | null;
  elected_at: Date | string | null;
  acceptable: boolean | null;
};

/** The calendar terms the tenant's own location is under now. */
export async function calendarTermsFor(tx: TenantTx): Promise<CalendarTerms> {
  // One statement, so the agreement, the newest row and whether it counts are
  // read from the same snapshot. `acceptable` is computed here, as
  // app_calendar_write_permitted() computes it, rather than re-derived in
  // TypeScript from the catalogue.
  const result = await tx.db.execute<TermsRow>(sql`
    select app_clinic_is_demo(c.id) as demo,
           a.agreement_id, a.document_version as agreement_version,
           b.variables -> 'appliedClauses' as applied_clauses,
           e.id as election_id, e.sequence, e.source, e.terms_kind, e.clause_id,
           e.calendar_account, e.booking_sync, e.booking_system, e.document_version,
           e.document_released, e.owner_confirmed, e.elected_at,
           (e.source = 'agreement' or e.document_released or app_clinic_is_demo(c.id)) as acceptable
      from clinics c
      left join lateral app_agreement_in_effect(c.organization_id) a on true
      left join baa_acceptances b on b.id = a.agreement_id
      left join lateral (
             select el.id, el.sequence, el.source, el.terms_kind, el.clause_id, el.calendar_account,
                    el.booking_sync, el.booking_system, el.document_version, el.document_released,
                    el.owner_confirmed, el.elected_at
               from calendar_elections el
              where el.clinic_id = c.id
                and el.agreement_id = a.agreement_id
              order by el.sequence desc
              limit 1) e on true
     where c.id = ${tx.clinicId}`);
  const row = result.rows[0];
  const demo = row?.demo === true;

  if (!row?.agreement_id || !row.agreement_version) {
    return { kind: "none", reason: "no_agreement", allowsWrite: false, demo };
  }
  const needsElection = (reason: CalendarTermsNeedsElectionReason, electionId: string | null) =>
    ({
      kind: "needs_election",
      reason,
      allowsWrite: false,
      agreementId: row.agreement_id!,
      agreementVersion: row.agreement_version!,
      electionId,
      demo,
    }) as const;

  if (!row.election_id) {
    return needsElection(
      carriesCalendarClause(row.applied_clauses) ? "location" : "legacy_agreement",
      null,
    );
  }
  if (row.acceptable !== true) return needsElection("draft_terms", row.election_id);

  const kind = row.terms_kind!;
  return {
    kind,
    account: row.calendar_account!,
    sync: row.booking_sync!,
    bookingSystem: row.booking_system!,
    clauseId: row.clause_id!,
    source: row.source!,
    electionId: row.election_id,
    sequence: row.sequence!,
    electedAt: new Date(row.elected_at!),
    documentVersion: row.document_version!,
    documentReleased: row.document_released === true,
    ownerConfirmed: row.owner_confirmed === true,
    agreementId: row.agreement_id,
    agreementVersion: row.agreement_version,
    allowsWrite: kind === "covered" || kind === "uncovered",
    demo,
  };
}

/** Whether the signed document held one of 1.3.0's calendar clauses. */
function carriesCalendarClause(applied: unknown): boolean {
  return (
    Array.isArray(applied) &&
    applied.some((id) => (CALENDAR_CLAUSE_IDS_1_3 as readonly unknown[]).includes(id))
  );
}

/**
 * Whether the tenant's location is a demo clinic: healdesk's own fictional
 * practice, made by scripts/demo-clinic.ts (owner decision Q6), on which a
 * draft election document counts. app_clinic_is_demo() decides: entitlements
 * status `demo` with no Stripe ids, and still synthetic. No paying clinic can
 * carry the marker (plan A10), and a demo clinic is never put live (ops
 * goLive refuses one).
 */
export async function isDemoClinic(tx: TenantTx): Promise<boolean> {
  const result = await tx.db.execute<{ demo: boolean }>(
    sql`select app_clinic_is_demo(${tx.clinicId}::uuid) as demo`,
  );
  return result.rows[0]?.demo === true;
}
