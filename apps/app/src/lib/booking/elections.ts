import { isIP } from "node:net";

import {
  bookingSyncFor,
  CALENDAR_CLAUSE_IDS_1_3,
  currentCalendarElection,
  electionWidens,
  hashCalendarElection,
  isBookingSystemId,
  isCalendarAccount,
  prepareCalendarElection,
  renderCalendarElection,
  selectCalendarClause,
  type BookingSync,
  type BookingSystemId,
  type CalendarAccount,
  type CalendarClauseId,
  type CalendarElection,
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
import type { RequestContext } from "@/lib/audit";
import {
  eraseGoogleCalendarWithin,
  googleCalendarConnection,
  type GoogleGrant,
} from "@/lib/connections/google-calendar";
import type { TenantTx } from "@/lib/tenant";

import { releaseLiveHolds } from "./holds";

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
 * (app_calendar_election_guard, drizzle/0053) anchors the row to the
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
 *     owner's. With one sign-in per clinic in v1, that sign-in is the owner.
 *   - Confirming is recording through that confirm link: the document must
 *     still render to the version and hash the link carries, or nothing is
 *     recorded and the answer is `changed` ("This election has changed;
 *     start again").
 *
 * After every election, in the same transaction (plan §2.6): the location's
 * booking system is the one elected; a Google connection the new terms no
 * longer cover (`not_used`, or an account kind other than the connected
 * one) is erased and the holds released; and the link it came through is
 * spent. What has to happen after commit is the connect flow's (C8), from
 * what this returns: revoking the erased grant at Google (`erased.grant`,
 * the token read before the erasure sealed over it), the practice's copy of
 * the election and a rotated continuation link.
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
  /** A confirm link whose pending election no longer renders the same: nothing recorded. */
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
 * The signature the owner has not given yet: an owner confirm link's hash is
 * of the document rendered with this in the signature block and the
 * agreement's own date as the day, so it changes when anything the owner is
 * asked to accept changes (the practice, the location, the agreement, the
 * clause, the document's version or wording) and not with who signs or when.
 */
const PENDING_SIGNATORY = "The practice owner, on confirming";

function pendingElectionFor(
  context: ElectionContext & { agreement: NonNullable<ElectionContext["agreement"]> },
  choice: ElectionChoice,
  election: CalendarElection,
): PendingCalendarElection {
  const text = renderCalendarElection(
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
    bookingSystem: choice.bookingSystem,
    calendarAccount: choice.calendarAccount,
    documentVersion: election.version,
    documentHash: hashCalendarElection(text),
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
  const election = currentCalendarElection();
  if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
  if (!election.approvedByCounsel && !context.demo) {
    return { status: "unavailable", reason: "draft_terms" };
  }
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
    request?: RequestContext;
    /** The day of acceptance is today in UTC, as the agreement's is; injectable for tests. */
    now?: Date;
  },
): Promise<RecordElectionOutcome> {
  checkChoice(input.choice);
  const label = signatureLabel(input.signatory);

  const context = await electionContext(tx);
  const election = currentCalendarElection();
  if (!context.agreement) return { status: "unavailable", reason: "no_agreement" };
  if (!election.approvedByCounsel && !context.demo) {
    return { status: "unavailable", reason: "draft_terms" };
  }
  const agreement = context.agreement;

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

  const prepared = prepareCalendarElection(
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
  // watch's next run: `not_used` reads nothing and writes nothing, and a
  // calendar of another account kind than the terms name is not theirs.
  // An unknown kind is not a match.
  let erased: RecordedElection["erased"] = null;
  let releasedHolds = 0;
  const connection = await googleCalendarConnection(tx, { forUpdate: true });
  if (
    connection &&
    connection.status !== "revoked" &&
    (prepared.kind === "not_used" ||
      connection.managed !== (input.choice.calendarAccount !== "personal"))
  ) {
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
 * Record the `agreement` row: the calendar terms the practice signed, as the
 * first terms of the location set up at signing (plan §2.6, §3.4(c)).
 * Provisioning calls it once, after the clinic insert, inside its own
 * transaction (C15). Null when the signed document holds no 1.3.0 calendar
 * clause: an agreement before 1.3.0 leaves the location to its first
 * election (plan §2.8).
 *
 * Every value is the signed row's own: its version and hash, its account kind
 * and booking system, and the clause it applied, which must be the one those
 * answers select. The guard checks each against the bound acceptance again,
 * and refuses the row for any location but the one set up at signing.
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

  const variables = signed.variables ?? {};
  const applied = Array.isArray(variables.appliedClauses) ? variables.appliedClauses : [];
  const clauseId = CALENDAR_CLAUSE_IDS_1_3.find((id) => applied.includes(id));
  if (!clauseId) return null;

  const { bookingSystem, calendarAccount } = variables;
  if (!isBookingSystemId(bookingSystem) || !isCalendarAccount(calendarAccount)) {
    throw new CalendarElectionError(
      "The signed agreement does not record its booking system and kind of Google account.",
      "agreementId",
    );
  }
  const selected = selectCalendarClause({ bookingSystem, calendarAccount });
  if (selected.clauseId !== clauseId) {
    throw new CalendarElectionError(
      "The signed calendar clause is not the one the signed answers select.",
      "agreementId",
    );
  }

  const row = await insertElection(tx, {
    clinicId: tx.clinicId,
    agreementId,
    source: "agreement",
    termsKind: selected.kind,
    clauseId: selected.clauseId,
    calendarAccount,
    bookingSync: bookingSyncFor(bookingSystem),
    bookingSystem,
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
    metadata: { sequence: row.sequence, source: "agreement", termsKind: selected.kind },
  });
  return { electionId: row.id, sequence: row.sequence, kind: selected.kind };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

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
