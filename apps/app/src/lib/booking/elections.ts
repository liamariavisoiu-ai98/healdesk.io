import { isIP } from "node:net";

import {
  agreementKindOfVersion,
  bookingSyncFor,
  CALENDAR_CLAUSE_IDS,
  calendarElectionFor,
  calendarTermsKind,
  electionWidens,
  hashCalendarElection,
  isBookingSystemId,
  isCalendarAccount,
  renderCalendarElection,
  renderDpaCalendarElection,
  selectCalendarClause,
  type BookingSync,
  type BookingSystemId,
  type CalendarAccount,
  type CalendarClauseId,
  type CalendarElection,
  type CalendarElectionVariables,
  type CalendarTermsKind,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  baaAcceptances,
  calendarElections,
  clinicMemberships,
  clinics,
  connectionLinks,
  type CalendarElectionSource,
  type PendingCalendarElection,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import {
  eraseGoogleCalendarWithin,
  googleCalendarConnection,
  revokeGoogleGrantIfUnused,
  type CalendarCallOptions,
  type GoogleCalendarConnection,
  type GoogleGrant,
} from "@/lib/connections/google-calendar";
import { calendarRecipients, ownerRecipients } from "@/lib/connections/recipients";
import { mailCalendarElectionCopy, type CalendarMailClinic } from "@/lib/email/calendar-link";
import { log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { releaseLiveHolds } from "./holds";
import { calendarTermsFor, type CalendarTermsNeedsElectionReason } from "./terms";

/**
 * Calendar elections: how a location's calendar terms change after the
 * agreement (plan §2.6, owner decision 3).
 *
 * The signed agreement gives the location set up at signing its first terms
 * (`recordAgreementTerms`, which provisioning calls). Every later change, and
 * every other location's first terms, is an election: a short versioned
 * document the practice accepts (`calendar-election/1.0.0`, in the catalogue),
 * stored whole, append-only, the newest under the agreement in effect
 * deciding (lib/booking/terms.ts). An election amends the practice's
 * contract, so only the practice records one, never ops.
 *
 * What the database already refuses is not re-implemented here as a rule,
 * only asked first so the answer is a status rather than a 42501: the guard
 * (app_calendar_election_guard, drizzle/0057) anchors the row to the
 * agreement in effect, numbers it, holds `document_released` and
 * `booking_sync` to its own copies of the catalogue, accepts a draft
 * document only for a demo clinic, checks the hash against the stored text,
 * and requires the practice owner for an election that WIDENS what reaches
 * Google (electionWidens: starting to write where nothing was written, or
 * moving a calendar out from under Google's BAA). The owner speaks through
 * an owner-audience calendar link or their own portal sign-in.
 *
 *   - Narrowing (to `not_used`, from uncovered to covered, or the same kind
 *     again) is recorded by whoever holds a recipients link.
 *   - Widening through a recipients link records nothing: it answers
 *     `owner_confirmation_required` with the pending election, which the
 *     caller puts on an owner confirm link mailed only to the owner (C8).
 *   - In the portal, elections are the owner's alone, narrowing included
 *     (plan §4.1): another member's answer is `owner_only`. The guard would
 *     take a member's narrowing election; the plan keeps the setting the
 *     owner's. With one sign-in per clinic in v1, that sign-in is the owner,
 *     whose own acceptance confirms a widening election (`owner_confirmed`,
 *     `elected_by_user_id`). The Settings card's functions are at the end
 *     (C18): getCalendarTerms, previewCalendarElection, recordPortalElection.
 *   - Confirming is recording through that confirm link: the document must
 *     still render to the version and hash the link carries, or nothing is
 *     recorded and the answer is `changed` ("This election has changed;
 *     start again").
 *
 * The document is the form for the agreement the location is under
 * (calendarElectionFor): the BAA's `calendar-election/…`, or the DPA's own
 * `calendar-election-dpa/…` for a `dpa/…` agreement, never the BAA's form
 * handed to a DPA practice. Each form counts only once released, or on a
 * demo clinic, so a DPA practice records no election until its form is
 * released (docs/counsel/dpa.md, gap 6).
 *
 * After every election, in the same transaction (plan §2.6): the location's
 * booking system is the one elected; a Google connection the new terms no
 * longer cover (`not_used`, or an account kind other than the connected
 * one) is erased and the holds released; and the link it came through is
 * spent. What has to happen after commit is the caller's, from what this
 * returns: revoking the erased grant at Google (`erased.grant`, the token
 * read before the erasure sealed over it), the practice's copy of the
 * election and, on a link, a rotated continuation link (C8's
 * submitCalendarElection; recordPortalElection for the portal).
 */

export class CalendarElectionError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CalendarElectionError";
  }
}

/** The two answers an election records. The sync, kind and clause follow from them. */
export type ElectionChoice = {
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
};

/** Who is accepting: a calendar link of this location, or the owner's own portal sign-in (C18). */
export type ElectionVia =
  { source: "calendar_link"; linkId: string } | { source: "portal"; userId: string };

/** What the person typed: the signature on the election. */
export type ElectionSignatory = { name: string; title?: string | null };

export type ElectionUnavailableReason =
  /** The location's organisation has no agreement in effect to elect under. */
  | "no_agreement"
  /** The election document is not released, and the location is not a demo clinic. */
  | "draft_terms";

export type ElectionPlan =
  | { status: "unavailable"; reason: ElectionUnavailableReason }
  | {
      status: "ready";
      kind: CalendarTermsKind;
      clauseId: CalendarClauseId;
      sync: BookingSync;
      previousKind: CalendarTermsKind | "none";
      widens: boolean;
      documentVersion: string;
      documentReleased: boolean;
      demo: boolean;
      /** What an owner confirm link carries for this choice. */
      pending: PendingCalendarElection;
    };

export type RecordedElection = {
  electionId: string;
  sequence: number;
  source: Exclude<CalendarElectionSource, "agreement">;
  kind: CalendarTermsKind;
  clauseId: CalendarClauseId;
  documentVersion: string;
  documentHash: string;
  documentReleased: boolean;
  widened: boolean;
  ownerConfirmed: boolean;
  /** The practice's copy: the document exactly as stored. */
  renderedText: string;
  /**
   * The Google connection the new terms no longer cover, erased in this
   * transaction, with its grant to revoke at Google after commit (null when
   * its bag held no token that could be read).
   */
  erased: { connectionId: string; accountRef: string | null; grant: GoogleGrant | null } | null;
  releasedHolds: number;
  /** The link spent by this election, for the rotated continuation link (C8). */
  consumedLink: {
    linkId: string;
    audience: "recipients" | "owner";
    allowsAccountChange: boolean;
    sentTo: string[] | null;
  } | null;
};

export type RecordElectionOutcome =
  | { status: "recorded"; election: RecordedElection }
  | { status: "unavailable"; reason: ElectionUnavailableReason }
  /** A widening election from someone who is not the owner: nothing recorded. */
  | {
      status: "owner_confirmation_required";
      kind: CalendarTermsKind;
      previousKind: CalendarTermsKind | "none";
      pending: PendingCalendarElection;
    }
  /**
   * The document the person was asked to accept (a confirm link's pending
   * election, or the portal card's preview) no longer renders the same:
   * nothing recorded.
   */
  | { status: "changed" }
  /** Not one of this location's calendar links, or spent, or expired: nothing recorded. */
  | { status: "link_not_usable" }
  /** The portal user holds no active membership of this location: nothing recorded. */
  | { status: "not_member" }
  /** A portal member who is not the owner: the Calendar setting is the owner's. Nothing recorded. */
  | { status: "owner_only" };

// -----------------------------------------------------------------------------
// What the location elects under
// -----------------------------------------------------------------------------

type ElectionContext = {
  clinicLegalName: string;
  locationName: string;
  agreement: { id: string; version: string; effectiveDate: string } | null;
  previousKind: CalendarTermsKind | "none";
  demo: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agreement in effect (app_agreement_in_effect, 0048), the newest row
 * under it, as the guard reads them, and the names the document prints, from
 * one snapshot.
 */
async function electionContext(tx: TenantTx): Promise<ElectionContext> {
  const result = await tx.db.execute<{
    clinic_name: string;
    demo: boolean;
    agreement_id: string | null;
    agreement_version: string | null;
    accepted_at: Date | string | null;
    variables: Record<string, unknown> | null;
    previous_kind: CalendarTermsKind | null;
  }>(sql`
    select c.name as clinic_name, app_clinic_is_demo(c.id) as demo,
           a.agreement_id, a.document_version as agreement_version, a.accepted_at, b.variables,
           e.terms_kind as previous_kind
      from clinics c
      left join lateral app_agreement_in_effect(c.organization_id) a on true
      left join baa_acceptances b on b.id = a.agreement_id
      left join lateral (
             select el.terms_kind
               from calendar_elections el
              where el.clinic_id = c.id
                and el.agreement_id = a.agreement_id
              order by el.sequence desc
              limit 1) e on true
     where c.id = ${tx.clinicId}`);
  const row = result.rows[0];
  if (!row) throw new CalendarElectionError("No such location.");

  const variables = row.variables ?? {};
  const legalName =
    typeof variables.clinicLegalName === "string" ? variables.clinicLegalName.trim() : "";
  const effective =
    typeof variables.effectiveDate === "string" && ISO_DATE.test(variables.effectiveDate)
      ? variables.effectiveDate
      : row.accepted_at
        ? new Date(row.accepted_at).toISOString().slice(0, 10)
        : "";
  return {
    // The practice as its agreement names it; the location as the practice names it.
    clinicLegalName: legalName || row.clinic_name,
    locationName: row.clinic_name,
    agreement:
      row.agreement_id && row.agreement_version
        ? { id: row.agreement_id, version: row.agreement_version, effectiveDate: effective }
        : null,
    previousKind: row.previous_kind ?? "none",
    demo: row.demo === true,
  };
}

function checkChoice(choice: ElectionChoice): void {
  if (!isBookingSystemId(choice?.bookingSystem)) {
    throw new CalendarElectionError("Choose where the practice's bookings live.", "bookingSystem");
  }
  if (!isCalendarAccount(choice.calendarAccount)) {
    throw new CalendarElectionError(
      "Choose which kind of Google account holds the calendar.",
      "calendarAccount",
    );
  }
}

/**
 * The signature the owner has not given yet: an owner confirm link's hash,
 * and the portal preview's fingerprint, are of the document rendered with
 * this in the signature block and the agreement's own date as the day, so
 * they change when anything the owner is asked to accept changes (the
 * practice, the location, the agreement, the clause, the document's version
 * or wording) and not with who signs or when.
 */
const PENDING_SIGNATORY = "The practice owner, on confirming";

function pendingElectionFor(
  context: ElectionContext & { agreement: NonNullable<ElectionContext["agreement"]> },
  choice: ElectionChoice,
  election: CalendarElection,
): PendingCalendarElection {
  return pendingDocumentFor(context, choice, election).pending;
}

/**
 * The election form for the agreement a location is under, by that
 * agreement's kind (calendarElectionFor): the one way this file picks a form.
 */
function electionFormFor(agreement: NonNullable<ElectionContext["agreement"]>): CalendarElection {
  return calendarElectionFor(agreement.version);
}

/**
 * The text of an election in its agreement's form: the DPA's own wording
 * for a `dpa/…` agreement, the BAA's otherwise. Either way the hash is the
 * SHA-256 of the UTF-8 text (hashCalendarElection), the digest the guard
 * checks against `rendered_text`.
 */
function renderElection(variables: CalendarElectionVariables, election: CalendarElection): string {
  return agreementKindOfVersion(variables.agreementVersion.trim()) === "dpa"
    ? renderDpaCalendarElection(variables, election)
    : renderCalendarElection(variables, election);
}

/** Whether the form counts for this location: released, or the demo clinic's draft (plan A10). */
function electionCounts(election: CalendarElection, demo: boolean): boolean {
  return election.approvedByCounsel || demo;
}

/**
 * Whether a location under the agreement of this version can record an
 * election now: that agreement's own form is released (a DPA's form for a
 * `dpa/…` agreement, the BAA's otherwise), or the location is the demo
 * clinic. The rule recordCalendarElection applies, for whatever offers an
 * election (the calendar link's page and its mailings, Settings → Calendar),
 * so nothing offers a form whose submission could only answer `draft_terms`.
 */
export function electionPossibleUnder(agreementVersion: string, demo: boolean): boolean {
  return electionCounts(calendarElectionFor(agreementVersion), demo);
}

/** The document an owner is asked to accept, as pendingElectionFor hashes it, and that hash. */
function pendingDocumentFor(
  context: ElectionContext & { agreement: NonNullable<ElectionContext["agreement"]> },
  choice: ElectionChoice,
  election: CalendarElection,
): { text: string; pending: PendingCalendarElection } {
  const text = renderElection(
    {
      clinicLegalName: context.clinicLegalName,
      locationName: context.locationName,
      agreementVersion: context.agreement.version,
      agreementEffectiveDate: context.agreement.effectiveDate,
      bookingSystem: choice.bookingSystem,
      calendarAccount: choice.calendarAccount,
      signatoryName: PENDING_SIGNATORY,
      electedOn: context.agreement.effectiveDate,
    },
    election,
  );
  return {
    text,
    pending: {
      bookingSystem: choice.bookingSystem,
      calendarAccount: choice.calendarAccount,
      documentVersion: election.version,
      documentHash: hashCalendarElection(text),
    },
  };
}

/**
 * Whether this location can record an election now, and what this one
 * would be: its kind, whether it widens, and the pending election an owner
 * confirm link would carry. Reads; records nothing.
 */
export async function planCalendarElection(
  tx: TenantTx,
  choice: ElectionChoice,
): Promise<ElectionPlan> {
  checkChoice(choice);
  const context = await electionContext(tx);
  if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
  const election = electionFormFor(context.agreement);
  if (!electionCounts(election, context.demo))
    return { status: "unavailable", reason: "draft_terms" };
  const { kind, clauseId } = selectCalendarClause(choice);
  return {
    status: "ready",
    kind,
    clauseId,
    sync: bookingSyncFor(choice.bookingSystem),
    previousKind: context.previousKind,
    widens: electionWidens(context.previousKind, kind),
    documentVersion: election.version,
    documentReleased: election.approvedByCounsel,
    demo: context.demo,
    pending: pendingElectionFor({ ...context, agreement: context.agreement }, choice, election),
  };
}

/**
 * What an owner confirm link asks the owner to accept, as it renders now
 * (the confirm page, plan §4.1): the election document with the owner's
 * signature still to come, and whether it is still the one the link was
 * minted for. `current` is false when anything the owner would accept has
 * changed since (the agreement, the location, the document's version or
 * wording), and the page then says "This election has changed; start
 * again" rather than showing a document the link does not carry. Reads;
 * records nothing.
 */
export async function previewPendingElection(
  tx: TenantTx,
  asked: PendingCalendarElection,
): Promise<
  | { status: "unavailable"; reason: ElectionUnavailableReason }
  | {
      status: "ready";
      text: string;
      current: boolean;
      widens: boolean;
    }
> {
  const choice = { bookingSystem: asked.bookingSystem, calendarAccount: asked.calendarAccount };
  checkChoice(choice);
  const context = await electionContext(tx);
  if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
  const election = electionFormFor(context.agreement);
  if (!electionCounts(election, context.demo))
    return { status: "unavailable", reason: "draft_terms" };
  const { text, pending } = pendingDocumentFor(
    { ...context, agreement: context.agreement },
    choice,
    election,
  );
  const { kind } = selectCalendarClause(choice);
  return {
    status: "ready",
    text,
    current:
      pending.documentVersion === asked.documentVersion &&
      pending.documentHash === asked.documentHash,
    widens: electionWidens(context.previousKind, kind),
  };
}

// -----------------------------------------------------------------------------
// Recording an election
// -----------------------------------------------------------------------------

/**
 * Record a location's calendar election in the caller's transaction, and do
 * what every election does after it (see the header). Statuses other than
 * `recorded` write nothing. A database refusal the checks here did not
 * foresee (the agreement terminated a moment ago, another election that won
 * a race and changed what this one means) is thrown, and rolls the caller's
 * transaction back with everything else.
 */
export async function recordCalendarElection(
  tx: TenantTx,
  input: {
    choice: ElectionChoice;
    signatory: ElectionSignatory;
    via: ElectionVia;
    /**
     * The document the person was shown before accepting, as
     * previewCalendarElection fingerprinted it (its version, and the hash
     * pendingElectionFor computes): recorded only if it still renders the
     * same, `changed` otherwise. The portal's card sends it; a confirm link
     * carries its own.
     */
    previewed?: { documentVersion: string; documentHash: string };
    request?: RequestContext;
    /** The day of acceptance is today in UTC, as the agreement's is; injectable for tests. */
    now?: Date;
  },
): Promise<RecordElectionOutcome> {
  checkChoice(input.choice);
  const label = signatureLabel(input.signatory);

  const context = await electionContext(tx);
  if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
  const agreement = context.agreement;
  const election = electionFormFor(agreement);
  if (!electionCounts(election, context.demo))
    return { status: "unavailable", reason: "draft_terms" };

  // Who is speaking, and whether they speak for the owner.
  let ownerBasis: boolean;
  let link: {
    id: string;
    audience: "recipients" | "owner";
    sentTo: string[] | null;
    allowsAccountChange: boolean;
    pendingElection: PendingCalendarElection | null;
  } | null = null;
  if (input.via.source === "calendar_link") {
    // A malformed id is no link at all, answered as one rather than as a
    // database error.
    if (!UUID.test(input.via.linkId)) return { status: "link_not_usable" };
    const [row] = await tx.db
      .select({
        id: connectionLinks.id,
        audience: connectionLinks.audience,
        sentTo: connectionLinks.sentTo,
        allowsAccountChange: connectionLinks.allowsAccountChange,
        pendingElection: connectionLinks.pendingElection,
        // By the clock link resolution and the guard use.
        live: sql<boolean>`${connectionLinks.usedAt} is null and ${connectionLinks.expiresAt} > now()`,
      })
      .from(connectionLinks)
      .where(
        and(
          eq(connectionLinks.id, input.via.linkId),
          eq(connectionLinks.clinicId, tx.clinicId),
          eq(connectionLinks.purpose, "calendar"),
        ),
      )
      .limit(1)
      // A second tab waits here for the first, then finds the link spent.
      .for("update");
    if (!row || !row.live) return { status: "link_not_usable" };
    link = row;
    ownerBasis = row.audience === "owner";
  } else {
    const [member] = await tx.db
      .select({ role: clinicMemberships.role })
      .from(clinicMemberships)
      .where(
        and(
          eq(clinicMemberships.clinicId, tx.clinicId),
          eq(clinicMemberships.userId, input.via.userId),
          isNull(clinicMemberships.revokedAt),
        ),
      )
      .limit(1);
    if (!member) return { status: "not_member" };
    if (member.role !== "owner") return { status: "owner_only" };
    ownerBasis = true;
  }

  const pending = pendingElectionFor({ ...context, agreement }, input.choice, election);
  // A confirm link records the election it asked the owner about, as it
  // still renders, or nothing.
  if (link?.pendingElection) {
    const asked = link.pendingElection;
    if (
      asked.bookingSystem !== pending.bookingSystem ||
      asked.calendarAccount !== pending.calendarAccount ||
      asked.documentVersion !== pending.documentVersion ||
      asked.documentHash !== pending.documentHash
    ) {
      return { status: "changed" };
    }
  }
  // So does the portal's card, with the document its owner previewed: the
  // agreement in effect, the location's name or the form's version may have
  // changed between the preview and the tick, and the signature is never
  // put on a document nobody was shown.
  if (
    input.previewed &&
    (input.previewed.documentVersion !== pending.documentVersion ||
      input.previewed.documentHash !== pending.documentHash)
  ) {
    return { status: "changed" };
  }

  const { kind } = selectCalendarClause(input.choice);
  const widens = electionWidens(context.previousKind, kind);
  if (widens && !ownerBasis) {
    return {
      status: "owner_confirmation_required",
      kind,
      previousKind: context.previousKind,
      pending,
    };
  }

  const prepared = prepareElection(
    {
      clinicLegalName: context.clinicLegalName,
      locationName: context.locationName,
      agreementVersion: agreement.version,
      agreementEffectiveDate: agreement.effectiveDate,
      bookingSystem: input.choice.bookingSystem,
      calendarAccount: input.choice.calendarAccount,
      signatoryName: input.signatory.name.trim(),
      signatoryTitle: input.signatory.title?.trim() || undefined,
      electedOn: (input.now ?? new Date()).toISOString().slice(0, 10),
    },
    election,
  );

  const row = await insertElection(tx, {
    clinicId: tx.clinicId,
    agreementId: agreement.id,
    source: input.via.source,
    termsKind: prepared.kind,
    clauseId: prepared.clauseId,
    calendarAccount: input.choice.calendarAccount,
    bookingSync: bookingSyncFor(input.choice.bookingSystem),
    bookingSystem: input.choice.bookingSystem,
    documentVersion: prepared.version,
    documentHash: prepared.hash,
    documentReleased: election.approvedByCounsel,
    ownerConfirmed: ownerBasis,
    renderedText: prepared.text,
    electedByLabel: label,
    electedByUserId: input.via.source === "portal" ? input.via.userId : null,
    linkId: link?.id ?? null,
    linkSentTo: link ? link.sentTo : null,
    ipAddress: normaliseIp(input.request?.ipAddress),
    userAgent: input.request?.userAgent?.slice(0, 500) ?? null,
  });

  // The booking system the location now runs, which the console and the
  // phase-two read-back both read from the clinic row.
  await tx.db
    .update(clinics)
    .set({ bookingProvider: input.choice.bookingSystem, updatedAt: new Date() })
    .where(eq(clinics.id, tx.clinicId));

  // A connection the new terms do not cover is taken away now, not at the
  // watch's next run (takesConnectionAway).
  let erased: RecordedElection["erased"] = null;
  let releasedHolds = 0;
  const connection = await googleCalendarConnection(tx, { forUpdate: true });
  if (connection && takesConnectionAway(connection, prepared.kind, input.choice.calendarAccount)) {
    const taken = await eraseGoogleCalendarWithin(tx, {
      connectionId: connection.id,
      reason: "election_changed",
    });
    if (taken) {
      erased = {
        connectionId: taken.connectionId,
        accountRef: taken.accountRef,
        grant: taken.grant,
      };
      releasedHolds = taken.releasedHolds;
    }
  } else if (prepared.kind === "not_used") {
    releasedHolds = await releaseLiveHolds(tx, "election_changed");
  }

  let consumedLink: RecordedElection["consumedLink"] = null;
  if (link) {
    const [spent] = await tx.db
      .update(connectionLinks)
      .set({ usedAt: sql`now()`, consumedIp: normaliseIp(input.request?.ipAddress) })
      .where(
        and(
          eq(connectionLinks.id, link.id),
          eq(connectionLinks.purpose, "calendar"),
          isNull(connectionLinks.usedAt),
        ),
      )
      .returning({ id: connectionLinks.id });
    if (!spent) {
      // Unreachable while the row lock above holds; refused rather than
      // recorded if it ever is not.
      throw new CalendarElectionError("That link has already been used.");
    }
    tx.audit.record({
      action: "update",
      resourceType: "connection_link",
      resourceId: link.id,
      metadata: { outcome: "consumed", purpose: "calendar" },
    });
    consumedLink = {
      linkId: link.id,
      audience: link.audience,
      allowsAccountChange: link.allowsAccountChange,
      sentTo: link.sentTo,
    };
  }

  tx.audit.record({
    action: "create",
    resourceType: "calendar_election",
    resourceId: row.id,
    metadata: {
      sequence: row.sequence,
      source: input.via.source,
      termsKind: prepared.kind,
      widened: widens,
      ownerConfirmed: ownerBasis,
      documentReleased: election.approvedByCounsel,
      erasedConnection: erased !== null,
    },
  });

  return {
    status: "recorded",
    election: {
      electionId: row.id,
      sequence: row.sequence,
      source: input.via.source,
      kind: prepared.kind,
      clauseId: prepared.clauseId,
      documentVersion: prepared.version,
      documentHash: prepared.hash,
      documentReleased: election.approvedByCounsel,
      widened: widens,
      ownerConfirmed: ownerBasis,
      renderedText: prepared.text,
      erased,
      releasedHolds,
      consumedLink,
    },
  };
}

// -----------------------------------------------------------------------------
// The location's first terms, from the signed agreement
// -----------------------------------------------------------------------------

/**
 * The calendar terms a signed acceptance carries, read off its stored
 * variables as they were signed (plan §2.6: the agreement row copies the
 * signed acceptance's version, hash, account and sync). Pure, so provisioning
 * asks it before anything is written and recordAgreementTerms again when it
 * writes, and the two cannot disagree.
 *
 * The clause is the one the document applied, and the sync is the one that
 * clause means (not used is manual, covered and uncovered are live), never
 * what the catalogue would select from the same two answers today. A booking
 * system reclassified between signing and provisioning (a vendor's written
 * confirmation landing, plan Q4) does not change what the practice signed,
 * and a refusal at provisioning comes after payment. `catalogueKind` is what
 * the catalogue selects now, for the recorder to log when it differs.
 *
 * `none`: the document applied no 1.3.0 calendar clause, as no version
 * before 1.3.0 does. `malformed`: a row no signing path writes, from which no
 * one set of terms can be recorded as signed: more than one calendar clause;
 * no booking system or account kind the catalogue knows; an account its
 * clause contradicts (covered is only for a Workspace account with Google's
 * BAA, uncovered only for any other), which calendar_elections_kind_consistent
 * refuses; or a sync stored beside it that its clause contradicts, which the
 * election guard (app_calendar_election_guard) refuses.
 */
export type SignedCalendarTerms =
  | { status: "none" }
  | { status: "malformed"; problem: string }
  | {
      status: "signed";
      kind: CalendarTermsKind;
      clauseId: CalendarClauseId;
      sync: BookingSync;
      bookingSystem: BookingSystemId;
      calendarAccount: CalendarAccount;
      /** The kind the catalogue selects from the same answers today. */
      catalogueKind: CalendarTermsKind;
    };

export function signedCalendarTerms(variables: unknown): SignedCalendarTerms {
  const signed = (variables ?? {}) as Record<string, unknown>;
  const applied: unknown[] = Array.isArray(signed.appliedClauses) ? signed.appliedClauses : [];
  // The three calendar clauses are 1.3.0's (CALENDAR_CLAUSE_IDS_1_3), and the
  // DPA's, which takes the same ones.
  const kinds = (Object.keys(CALENDAR_CLAUSE_IDS) as CalendarTermsKind[]).filter((kind) =>
    applied.includes(CALENDAR_CLAUSE_IDS[kind]),
  );
  if (kinds.length === 0) return { status: "none" };
  if (kinds.length > 1) {
    return {
      status: "malformed",
      problem: "The signed agreement applies more than one calendar clause.",
    };
  }

  const { bookingSystem, calendarAccount } = signed;
  if (!isBookingSystemId(bookingSystem) || !isCalendarAccount(calendarAccount)) {
    return {
      status: "malformed",
      problem:
        "The signed agreement does not record its booking system and kind of Google account.",
    };
  }
  const kind = kinds[0]!;
  const sync: BookingSync = kind === "not_used" ? "manual" : "live";
  // The kind the clause's own sync gives with the signed account is the
  // clause itself, unless the account contradicts it.
  if (calendarTermsKind(sync, calendarAccount) !== kind) {
    return {
      status: "malformed",
      problem:
        "The signed calendar clause is not one for the kind of Google account signed with it.",
    };
  }
  if (Object.hasOwn(signed, "bookingSync") && signed.bookingSync !== sync) {
    return {
      status: "malformed",
      problem: "The booking sync stored with the signed agreement contradicts its calendar clause.",
    };
  }
  return {
    status: "signed",
    kind,
    clauseId: CALENDAR_CLAUSE_IDS[kind],
    sync,
    bookingSystem,
    calendarAccount,
    catalogueKind: selectCalendarClause({ bookingSystem, calendarAccount }).kind,
  };
}

/**
 * Record the `agreement` row: the calendar terms the practice signed, as the
 * first terms of the location set up at signing (plan §2.6, §3.4(c)).
 * Provisioning calls it once, after the clinic insert, inside its own
 * transaction (C15). Null when the signed document holds no 1.3.0 calendar
 * clause: an agreement before 1.3.0 leaves the location to its first
 * election (plan §2.8).
 *
 * Every value is the signed row's own (signedCalendarTerms): its version and
 * hash, its account kind and booking system, the clause it applied and the
 * sync that clause means. A clause the catalogue would no longer select for
 * those answers is recorded as signed all the same, and logged; the location
 * changes its terms by an election. The guard checks each value against the
 * bound acceptance again, and refuses the row for any location but the one
 * set up at signing.
 */
export async function recordAgreementTerms(
  tx: TenantTx,
  agreementId: string,
): Promise<{ electionId: string; sequence: number; kind: CalendarTermsKind } | null> {
  const [signed] = await tx.db
    .select({
      version: baaAcceptances.documentVersion,
      hash: baaAcceptances.documentHash,
      variables: baaAcceptances.variables,
      acceptedByName: baaAcceptances.acceptedByName,
      acceptedByTitle: baaAcceptances.acceptedByTitle,
    })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, agreementId))
    .limit(1);
  if (!signed) throw new CalendarElectionError("That agreement was not found.", "agreementId");

  const terms = signedCalendarTerms(signed.variables);
  if (terms.status === "none") return null;
  if (terms.status === "malformed") throw new CalendarElectionError(terms.problem, "agreementId");

  const row = await insertElection(tx, {
    clinicId: tx.clinicId,
    agreementId,
    source: "agreement",
    termsKind: terms.kind,
    clauseId: terms.clauseId,
    calendarAccount: terms.calendarAccount,
    bookingSync: terms.sync,
    bookingSystem: terms.bookingSystem,
    documentVersion: signed.version,
    documentHash: signed.hash,
    // The signed document is the released agreement itself; the agreement's
    // own release is provisioning's gate.
    documentReleased: true,
    ownerConfirmed: false,
    renderedText: null,
    electedByLabel: agreementSignatureLabel(signed.acceptedByName, signed.acceptedByTitle),
  });
  tx.audit.record({
    action: "create",
    resourceType: "calendar_election",
    resourceId: row.id,
    metadata: { sequence: row.sequence, source: "agreement", termsKind: terms.kind },
  });
  if (terms.catalogueKind !== terms.kind) {
    log.warn("calendar terms recorded as signed; the catalogue now selects another clause", {
      clinicId: tx.clinicId,
      agreementId,
      kind: terms.kind,
      provider: terms.bookingSystem,
      reason: `the catalogue now selects ${terms.catalogueKind}`,
    });
  }
  return { electionId: row.id, sequence: row.sequence, kind: terms.kind };
}

// -----------------------------------------------------------------------------
// The portal's Settings → Calendar card (C18)
// -----------------------------------------------------------------------------

/**
 * The portal user recording an election: requirePortal's user
 * (lib/portal/access.ts), labelled as every portal change is
 * (lib/portal/actor.ts: the device whose passkey is live on the session, or
 * the clinic's sign-in). Only the caller can build it. The election stores
 * the user as `elected_by_user_id`, the database's guard asks after that
 * user's membership, and the audit rows name them.
 */
export type PortalElectionActor = Extract<ActorContext, { type: "user" }>;

/** Who a read is made as when the caller names nobody. A read writes no audit row. */
const ELECTIONS_ACTOR: ActorContext = { type: "service", serviceName: "calendar-elections" };

/** A location's calendar terms as Settings → Calendar shows them, and whether they can change now. */
export type CalendarTermsView = {
  terms:
    /** No agreement in effect: there is nothing to elect under. */
    | { kind: "none" }
    /** The agreement gives this location no calendar terms that count: an election does. */
    | { kind: "needs_election"; reason: CalendarTermsNeedsElectionReason }
    | {
        kind: CalendarTermsKind;
        /** The card's two answers, as the terms in effect have them. */
        bookingSystem: BookingSystemId;
        calendarAccount: CalendarAccount;
        /** The signed agreement, a calendar link, or the portal. */
        source: CalendarElectionSource;
        electedAt: Date;
      };
  /** Whether the owner can record an election now, and why not when not. */
  election: { status: "ready" } | { status: "unavailable"; reason: ElectionUnavailableReason };
};

/**
 * Settings → Calendar's terms: what governs the location's calendar now
 * (calendarTermsFor), with the booking system and the kind of Google account
 * the card pre-fills its two answers from, and whether an election can be
 * recorded now (an agreement in effect, and its election form released, or
 * the demo clinic). Reads; records nothing.
 */
export async function getCalendarTerms(
  clinicId: string,
  options: CalendarCallOptions = {},
): Promise<CalendarTermsView> {
  return withTenant(
    { clinicId, actor: options.actor ?? ELECTIONS_ACTOR, request: options.request },
    async (tx) => {
      const terms = await calendarTermsFor(tx);
      const context = await electionContext(tx);
      const election: CalendarTermsView["election"] = !context.agreement
        ? { status: "unavailable", reason: "no_agreement" }
        : electionPossibleUnder(context.agreement.version, context.demo)
          ? { status: "ready" }
          : { status: "unavailable", reason: "draft_terms" };
      if (terms.kind === "none") return { terms: { kind: "none" }, election };
      if (terms.kind === "needs_election") {
        return { terms: { kind: "needs_election", reason: terms.reason }, election };
      }
      return {
        terms: {
          kind: terms.kind,
          bookingSystem: terms.bookingSystem,
          calendarAccount: terms.account,
          source: terms.source,
          electedAt: terms.electedAt,
        },
        election,
      };
    },
  );
}

export type CalendarElectionPreview =
  | { status: "unavailable"; reason: ElectionUnavailableReason }
  | { status: "invalid"; field: string; message: string }
  | {
      status: "ready";
      kind: CalendarTermsKind;
      previousKind: CalendarTermsKind | "none";
      /**
       * It lets more reach Google (electionWidens). In the portal the owner's
       * own acceptance is the owner's confirmation the guard requires.
       */
      widens: boolean;
      /**
       * Recording it takes the location's Google connection away
       * (takesConnectionAway): the card says so, and the clinic connects the
       * right account after.
       */
      disconnects: boolean;
      documentVersion: string;
      /**
       * The document's fingerprint, which the card sends back with the
       * acceptance (with `documentVersion`), so that recordPortalElection
       * records this document or nothing: the hash pendingElectionFor
       * computes, of the text with the signature still to come and the
       * agreement's own date, so neither the name typed nor the day it is
       * accepted changes it.
       */
      documentHash: string;
      /** The document as it will be stored, with today's date and the signature still to come. */
      text: string;
    };

/**
 * What an election would be, for the card to show before the owner accepts
 * it: its kind, whether it widens what reaches Google, whether it takes the
 * connected calendar away, and the document itself in the agreement's own
 * form, with the fingerprint the acceptance must carry back. The signature
 * block reads "The practice owner, on confirming" until the owner types a
 * name, which recordPortalElection puts there. The two answers are the
 * card's, as sent, and are checked here. Reads; records nothing.
 */
export async function previewCalendarElection(
  clinicId: string,
  answers: { bookingSystem: unknown; calendarAccount: unknown },
  options: CalendarCallOptions & { now?: Date } = {},
): Promise<CalendarElectionPreview> {
  const choice = {
    bookingSystem: answers?.bookingSystem,
    calendarAccount: answers?.calendarAccount,
  } as ElectionChoice;
  try {
    checkChoice(choice);
  } catch (error) {
    if (error instanceof CalendarElectionError) {
      return { status: "invalid", field: error.field ?? "election", message: error.message };
    }
    throw error;
  }
  return withTenant(
    { clinicId, actor: options.actor ?? ELECTIONS_ACTOR, request: options.request },
    async (tx): Promise<CalendarElectionPreview> => {
      const context = await electionContext(tx);
      if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
      const election = electionFormFor(context.agreement);
      if (!electionCounts(election, context.demo)) {
        return { status: "unavailable", reason: "draft_terms" };
      }
      const prepared = prepareElection(
        {
          clinicLegalName: context.clinicLegalName,
          locationName: context.locationName,
          agreementVersion: context.agreement.version,
          agreementEffectiveDate: context.agreement.effectiveDate,
          bookingSystem: choice.bookingSystem,
          calendarAccount: choice.calendarAccount,
          signatoryName: PENDING_SIGNATORY,
          electedOn: (options.now ?? new Date()).toISOString().slice(0, 10),
        },
        election,
      );
      const pending = pendingElectionFor(
        { ...context, agreement: context.agreement },
        choice,
        election,
      );
      const connection = await googleCalendarConnection(tx);
      return {
        status: "ready",
        kind: prepared.kind,
        previousKind: context.previousKind,
        widens: electionWidens(context.previousKind, prepared.kind),
        disconnects:
          connection !== null &&
          takesConnectionAway(connection, prepared.kind, choice.calendarAccount),
        documentVersion: pending.documentVersion,
        documentHash: pending.documentHash,
        text: prepared.text,
      };
    },
  );
}

/**
 * What the card sends: its two answers, the fingerprint of the document it
 * showed for them (previewCalendarElection), the signature, and the tick.
 */
export type PortalElectionSubmission = {
  bookingSystem: unknown;
  calendarAccount: unknown;
  /** The preview's `documentVersion` and `documentHash`, as it gave them. */
  documentVersion: unknown;
  documentHash: unknown;
  /** The name typed: the signature on the election. */
  name: unknown;
  title?: unknown;
  /** The tick: "I accept this calendar election for {location}". */
  accepted: boolean;
};

export type PortalElectionOutcome =
  | {
      status: "recorded";
      electionId: string;
      sequence: number;
      kind: CalendarTermsKind;
      widened: boolean;
      /** The location's Google connection was taken away: the new terms do not cover it. */
      disconnected: boolean;
    }
  | { status: "unavailable"; reason: ElectionUnavailableReason }
  /**
   * The document no longer renders as the card previewed it (or the card
   * sent no fingerprint): nothing recorded. The card previews again ("This
   * election has changed; start again").
   */
  | { status: "changed" }
  /** The portal user holds no active membership of this location: nothing recorded. */
  | { status: "not_member" }
  /** A member who is not the owner: the calendar terms are the owner's. Nothing recorded. */
  | { status: "owner_only" }
  | { status: "invalid"; field: string; message: string };

/**
 * Record an election from Settings → Calendar (plan §2.6's `portal` row):
 * the owner's own sign-in, so `source` is `portal`, `elected_by_user_id` is
 * the user, and the owner's acceptance confirms an election that widens
 * what reaches Google (`owner_confirmed`), which the guard checks against
 * the user's `owner` membership again. Any other member's answer is
 * `owner_only`, narrowing included; with one sign-in per clinic in v1, that
 * sign-in is the owner.
 *
 * Both of the card's answers are an election: where the location's bookings
 * live, and which kind of Google account holds its calendar. The card sends
 * both, the one not being changed as getCalendarTerms gave it, so a change
 * of the kind of account alone is this call with the same booking system.
 * It is also how the owner answers `?calendar=election_needed`, when a
 * Google account of another kind or Workspace domain is to replace the
 * connected one: once the election is recorded, the same sign-in goes
 * through (lib/connections/google-oauth.ts).
 *
 * What is recorded is the document the card previewed for these answers,
 * or nothing: the server renders and hashes the text it stores, and the
 * fingerprint the card sends back (previewCalendarElection's
 * `documentVersion` and `documentHash`) must still be that document's, or
 * the answer is `changed`, as on an owner's confirm link (plan §4.1).
 *
 * In one transaction, recordCalendarElection's whole work: the row, the
 * location's booking system, and the connection the new terms no longer
 * cover erased with its holds. After commit, that connection's grant is
 * revoked at Google unless another location holds the account live, and the
 * practice's copy is mailed to the practice's address. Statuses other than
 * `recorded` write nothing.
 */
export async function recordPortalElection(
  clinicId: string,
  submission: PortalElectionSubmission,
  options: { actor: PortalElectionActor; request?: RequestContext; now?: Date },
): Promise<PortalElectionOutcome> {
  const actor = options?.actor;
  if (actor?.type !== "user" || typeof actor.userId !== "string" || !actor.userId) {
    // A caller's mistake, not the owner's: thrown, never answered as a form problem.
    throw new Error("A portal election names the portal user who made it.");
  }
  if (submission?.accepted !== true) {
    return {
      status: "invalid",
      field: "accepted",
      message: "Tick the box to accept the calendar election.",
    };
  }
  // No fingerprint, no document the owner can be shown to have seen: an
  // empty one never matches, so the answer is `changed`, after the answers,
  // the terms and the membership have each had their say.
  const previewed = {
    documentVersion:
      typeof submission.documentVersion === "string" ? submission.documentVersion : "",
    documentHash: typeof submission.documentHash === "string" ? submission.documentHash : "",
  };
  const choice = {
    bookingSystem: submission.bookingSystem,
    calendarAccount: submission.calendarAccount,
  } as ElectionChoice;
  const now = options.now ?? new Date();

  let done: {
    outcome: RecordElectionOutcome;
    copy: Awaited<ReturnType<typeof electionCopyFacts>> | null;
  };
  try {
    done = await withTenant({ clinicId, actor, request: options.request }, async (tx) => {
      const outcome = await recordCalendarElection(tx, {
        choice,
        signatory: {
          name: typeof submission.name === "string" ? submission.name : "",
          title: typeof submission.title === "string" ? submission.title : null,
        },
        via: { source: "portal", userId: actor.userId },
        previewed,
        request: options.request,
        now,
      });
      return {
        outcome,
        copy: outcome.status === "recorded" ? await electionCopyFacts(tx) : null,
      };
    });
  } catch (error) {
    if (error instanceof CalendarElectionError) {
      return { status: "invalid", field: error.field ?? "election", message: error.message };
    }
    throw error;
  }

  const { outcome } = done;
  switch (outcome.status) {
    case "recorded": {
      const election = outcome.election;
      if (election.erased?.grant) {
        await revokeGoogleGrantIfUnused(election.erased.grant, {
          clinicId,
          reason: "election_changed",
        });
      }
      await mailCalendarElectionCopy({
        ...done.copy!.clinic,
        recipients: done.copy!.recipients,
        electionId: election.electionId,
        kind: election.kind,
        calendarAccount: choice.calendarAccount,
        bookingSystem: choice.bookingSystem,
        electedAt: now,
      });
      return {
        status: "recorded",
        electionId: election.electionId,
        sequence: election.sequence,
        kind: election.kind,
        widened: election.widened,
        disconnected: election.erased !== null,
      };
    }
    case "unavailable":
      return { status: "unavailable", reason: outcome.reason };
    case "changed":
    case "not_member":
    case "owner_only":
      return { status: outcome.status };
    case "owner_confirmation_required":
    case "link_not_usable":
      // Only a calendar link answers these: the owner's own sign-in confirms
      // its own election, and the portal has no link to spend.
      throw new Error(`A portal election cannot end ${outcome.status}.`);
  }
}

/** The clinic and the practice's address, for its copy of an election, read in its tenant. */
async function electionCopyFacts(
  tx: TenantTx,
): Promise<{ clinic: CalendarMailClinic; recipients: string[] }> {
  const [row] = await tx.db
    .select({ name: clinics.name, specialty: clinics.specialty, timezone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) throw new CalendarElectionError("No such location.");
  // In v1 both are the clinic's one address (lib/connections/recipients.ts).
  const recipients = [
    ...new Set([...(await ownerRecipients(tx)), ...(await calendarRecipients(tx))]),
  ];
  return {
    clinic: {
      clinicId: tx.clinicId,
      clinicName: row.name,
      specialty: row.specialty,
      timeZone: row.timezone,
    },
    recipients,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** Render, hash and name the clause, in the agreement's own form (renderElection). */
function prepareElection(
  variables: CalendarElectionVariables,
  election: CalendarElection,
): {
  text: string;
  hash: string;
  version: string;
  kind: CalendarTermsKind;
  clauseId: CalendarClauseId;
} {
  const text = renderElection(variables, election);
  const { kind, clauseId } = selectCalendarClause({
    bookingSystem: variables.bookingSystem,
    calendarAccount: variables.calendarAccount,
  });
  return { text, hash: hashCalendarElection(text), version: election.version, kind, clauseId };
}

/**
 * Whether terms of this kind, for this kind of Google account, take the
 * location's live connection away when they are recorded: `not_used` reads
 * nothing and writes nothing, and a calendar of another account kind than
 * the terms name is not theirs (a Workspace account for the two Workspace
 * kinds, a personal one for `personal`). An unknown kind is not a match.
 */
function takesConnectionAway(
  connection: GoogleCalendarConnection,
  kind: CalendarTermsKind,
  account: CalendarAccount,
): boolean {
  return (
    connection.status !== "revoked" &&
    (kind === "not_used" || connection.managed !== (account !== "personal"))
  );
}

type ElectionInsert = typeof calendarElections.$inferInsert;

/**
 * Insert one row; the guard numbers it. Two elections racing for one number
 * meet the unique index, and the loser tries once more inside its own
 * savepoint, where READ COMMITTED lets the guard see the winner, number past
 * it and judge this election again against it (plan §11.6).
 */
async function insertElection(
  tx: TenantTx,
  values: ElectionInsert,
): Promise<{ id: string; sequence: number }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tx.db.transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(calendarElections)
          .values(values)
          .returning({ id: calendarElections.id, sequence: calendarElections.sequence });
        if (!row) throw new CalendarElectionError("The election was not recorded.");
        return row;
      });
    } catch (error) {
      if (attempt === 0 && isSequenceRace(error)) continue;
      throw error;
    }
  }
}

function isSequenceRace(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown };
    if (e.code === "23505") return e.constraint === "calendar_elections_clinic_sequence_idx";
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** "Name, Title", as the signature block prints it and elected_by_label stores it (2 to 200 characters). */
function signatureLabel(signatory: ElectionSignatory): string {
  const name = typeof signatory?.name === "string" ? signatory.name.trim() : "";
  const title = typeof signatory?.title === "string" ? signatory.title.trim() : "";
  if (name.length < 2) {
    throw new CalendarElectionError("Type your name to accept the election.", "name");
  }
  const label = title ? `${name}, ${title}` : name;
  if (label.length > 200) {
    throw new CalendarElectionError("That name and title are too long.", "name");
  }
  return label;
}

/**
 * The agreement row's label: the signature as signed, "Name, Title", when it
 * fits elected_by_label's 200 characters, and otherwise the name alone. The
 * refusal above is for a name someone is typing now and can shorten; this
 * signature was accepted when it was signed (signing caps the name at 120
 * characters and the title not at all), and provisioning records it inside
 * its own transaction (C15), where a refusal would leave a paid purchase
 * unprovisioned on every retry. The full signature stays on the agreement.
 */
function agreementSignatureLabel(name: string, title: string | null): string {
  const signedName = name.trim();
  const signedTitle = title?.trim() ?? "";
  const label = signedTitle ? `${signedName}, ${signedTitle}` : signedName;
  if (label.length <= 200) return label;
  return signedName.length <= 200 ? signedName : signedName.slice(0, 200).trimEnd();
}

/** An address `inet` takes, or null: a proxy header is attacker-influenced text (links.ts). */
function normaliseIp(ip: string | null | undefined): string | null {
  const first = ip?.split(",")[0]?.trim();
  return first && isIP(first) !== 0 ? first : null;
}
