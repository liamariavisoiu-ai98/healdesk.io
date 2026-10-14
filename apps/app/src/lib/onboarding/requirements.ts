import {
  bookingFieldsFor,
  currentDirectBookingAddendum,
  isBookingFieldId,
  NO_PLATFORM_ID,
  prepareDirectBookingAddendum,
  type BookingFieldId,
  BOOKING_FIELDS,
} from "@healdesk/catalog";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { clinics, connectionLinks } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { consumeConnectionLinkWithin } from "@/lib/connections/links";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { completeStep } from "./steps";

/**
 * The booking requirement set: who settled it, and the fallback when nobody
 * did (design of 23 September 2026, §H.4–H.5).
 *
 * Three sources, one column. `practice` — the setup link was opened and
 * submitted (app/setup/[token]/actions.ts). `operator` — confirmed on the
 * onboarding call through the ops op `setBookingRequirements`. `defaults` —
 * nobody answered, and the specialty defaults are the automatic outcome,
 * stamped here with `booking_requirements = NULL` (the resolver already
 * returns the defaults for NULL, so nothing is copied that could go stale).
 *
 * ## When the defaults apply
 *
 * A clinic is eligible when its `booking_requirements_confirmed` step is
 * open, no setup link is outstanding (unspent and unexpired), and either a
 * setup link expired unspent or no setup link was ever issued and the clinic
 * is older than the link's own fourteen-day window. The last clause covers a
 * clinic provisioned before 0040, or one whose link failed to issue: the
 * practice was never asked, and it gets the same fourteen days it would have
 * had. A clinic that is younger than that with no link at all is left alone,
 * so a provisioning that has not yet mailed its link does not have its
 * decision made for it an hour later.
 *
 * ## Where it runs
 *
 * Once an hour from the scheduler tick (`applyBookingRequirementDefaults`),
 * and once more for one clinic at the moment an operator attempts go-live
 * (`applyBookingRequirementDefaultsFor`, from the ops op) — "whichever comes
 * first". Both are the same rule over the same rows; the go-live call exists
 * only so a link that expired ten minutes ago does not block the call the
 * operator is on. An operator who wants the practice to answer after all
 * issues a new link, which makes one outstanding again.
 *
 * Idempotent: a stamped step is skipped, and `completeStep` keeps its first
 * timestamp regardless.
 */

const DEFAULTS_ACTOR: ActorContext = { type: "service", serviceName: "booking-requirements-defaults" };

/** The grace a clinic with no link at all gets: the link's own TTL. */
export const NO_LINK_GRACE_DAYS = 14;

export type DefaultsOutcome = "applied" | "already_confirmed" | "link_outstanding" | "not_yet";

/**
 * Apply the defaults to one clinic if it is eligible. Runs inside the
 * caller's tenant transaction so the go-live path and the sweep share it.
 */
export async function applyDefaultsWithin(tx: TenantTx, now: Date = new Date()): Promise<DefaultsOutcome> {
  const [clinic] = await tx.db
    .select({
      createdAt: clinics.createdAt,
      confirmedAt: clinics.bookingRequirementsConfirmedAt,
      step: sql<string | null>`${clinics.onboarding} ->> 'booking_requirements_confirmed'`,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return "not_yet";
  if (clinic.step !== null || clinic.confirmedAt !== null) return "already_confirmed";

  const [outstanding] = await tx.db
    .select({ id: connectionLinks.id })
    .from(connectionLinks)
    .where(and(eq(connectionLinks.purpose, "setup"), isNull(connectionLinks.usedAt), gt(connectionLinks.expiresAt, now)))
    .limit(1);
  if (outstanding) return "link_outstanding";

  const [expired] = await tx.db
    .select({ id: connectionLinks.id })
    .from(connectionLinks)
    .where(and(eq(connectionLinks.purpose, "setup"), isNull(connectionLinks.usedAt), lte(connectionLinks.expiresAt, now)))
    .limit(1);
  const [anyLink] = await tx.db
    .select({ id: connectionLinks.id })
    .from(connectionLinks)
    .where(eq(connectionLinks.purpose, "setup"))
    .limit(1);
  const graceOver = clinic.createdAt.getTime() + NO_LINK_GRACE_DAYS * 86_400_000 <= now.getTime();
  if (!expired && (anyLink || !graceOver)) return "not_yet";

  await tx.db
    .update(clinics)
    .set({
      bookingRequirements: null,
      bookingRequirementsConfirmedAt: now,
      bookingRequirementsSource: "defaults",
      updatedAt: now,
    })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_booking_requirements",
    resourceId: tx.clinicId,
    metadata: { source: "defaults", reason: expired ? "setup_link_expired" : "no_setup_link" },
  });
  await completeStep(tx, "booking_requirements_confirmed", {
    at: now,
    note: expired ? "specialty defaults: the setup link expired unspent" : "specialty defaults: no setup link was issued",
  });
  return "applied";
}

/** The go-live path: one clinic, its own transaction. */
export async function applyBookingRequirementDefaultsFor(clinicId: string, now: Date = new Date()): Promise<DefaultsOutcome> {
  return withTenant({ clinicId, actor: DEFAULTS_ACTOR }, (tx) => applyDefaultsWithin(tx, now));
}

/**
 * The hourly sweep: every clinic whose step is open, through the overview
 * (the runtime role cannot enumerate clinics any other way), then the same
 * per-clinic rule under the ordinary tenant policy. Returns how many were
 * stamped. Never throws for one clinic's sake: the others still get theirs.
 */
export async function applyBookingRequirementDefaults(now: Date = new Date()): Promise<number> {
  let applied = 0;
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    if (clinic.onboarding.booking_requirements_confirmed) continue;
    try {
      if ((await applyBookingRequirementDefaultsFor(clinic.id, now)) === "applied") applied += 1;
    } catch {
      // Logged by the transaction's own path; the sweep moves on.
    }
  }
  return applied;
}

/** The ids this clinic's specialty may collect: the animal fields only at a practice that cares for animals. */
async function offeredFieldIds(tx: TenantTx): Promise<Set<string>> {
  const [clinic] = await tx.db.select({ specialty: clinics.specialty }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  return new Set(bookingFieldsFor(clinic?.specialty ?? null).map((f) => f.id));
}

/**
 * The operator's override (§H.5): a validated list of catalogue ids, locked
 * ones always kept, `source = 'operator'`, and the step stamped. Unknown ids
 * are refused rather than dropped — the operator typed them and should hear —
 * and so is a field the practice's specialty does not collect (an animal's
 * name at a med spa).
 */
export async function setBookingRequirementsWithin(
  tx: TenantTx,
  fields: readonly unknown[],
  now: Date = new Date(),
): Promise<BookingFieldId[]> {
  const offered = await offeredFieldIds(tx);
  const chosen = new Set<BookingFieldId>();
  for (const field of fields) {
    if (!isBookingFieldId(field)) throw new Error(`Unknown booking field: ${String(field).slice(0, 40)}`);
    if (!offered.has(field)) throw new Error(`Booking field not offered to this practice: ${field}`);
    chosen.add(field);
  }
  for (const field of BOOKING_FIELDS) if (field.locked) chosen.add(field.id);
  const ordered = BOOKING_FIELDS.filter((f) => chosen.has(f.id)).map((f) => f.id);
  await tx.db
    .update(clinics)
    .set({
      bookingRequirements: ordered,
      bookingRequirementsConfirmedAt: now,
      bookingRequirementsSource: "operator",
      updatedAt: now,
    })
    .where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_booking_requirements",
    resourceId: tx.clinicId,
    metadata: { source: "operator", fields: ordered },
  });
  await completeStep(tx, "booking_requirements_confirmed", { at: now, note: "confirmed by the operator" });
  return ordered;
}

/**
 * Whether the setup page may offer the Direct booking section (§H.3): the
 * addendum is counsel-approved, and the practice's own system is one that
 * reads the Google Calendar the assistant writes into for conflicts (Cal.com,
 * or no booking system at all), so a booking there cannot be double-booked by
 * its own software. healdesk writes nothing into Cal.com itself (v1 spec,
 * "Where bookings are written"). Never shown for a one-way or unverified
 * system such as Mindbody or Boulevard: those run manual booking mode.
 * TODO(v1, launch plan steps 1.5 and 1.7): Calendly and plain Google Calendar
 * belong in this set too once the Google adapter and the per-clinic record of
 * the clinic's system exist.
 */
export function directBookingOffered(platformId: string): boolean {
  if (!currentDirectBookingAddendum().approvedByCounsel) return false;
  return platformId === "calcom" || platformId === NO_PLATFORM_ID;
}

export type SetupSubmission = {
  token: string;
  ip: string | null;
  /** Catalogue ids the practice ticked. Locked ones are added whatever was sent. */
  fields: readonly unknown[];
  /** The election, or null. Refused unless the section was offered. */
  election: { signatoryName: string; signatoryTitle: string | null } | null;
  clinicName: string;
  platformId: string;
};

export class SetupLinkSpentError extends Error {
  constructor() {
    super("Setup link was consumed by another submission.");
    this.name = "SetupLinkSpentError";
  }
}

export class SetupSubmissionError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = "SetupSubmissionError";
  }
}

/**
 * §H.4, the whole submission in the caller's tenant transaction: burn the
 * link (purpose-filtered, so a connect token cannot confirm a requirement
 * set), write the set with `source = 'practice'`, evidence the election if
 * made, stamp the step, audit. A lost burn throws so everything rolls back
 * with it — the same shape as app/connect/[token]/actions.ts, and the reason
 * tests/setup-links.test.ts can drive it without a request.
 *
 * The election is evidenced by hashing the addendum rendered again HERE with
 * the name and title typed, never by a hash the browser sent, so the stored
 * hash reproduces from the catalogue text and the stored label alone.
 */
export async function confirmBookingRequirementsWithin(
  tx: TenantTx,
  input: SetupSubmission,
  now: Date = new Date(),
): Promise<{ fields: BookingFieldId[]; directBookingElected: boolean }> {
  const burned = await consumeConnectionLinkWithin(tx, input.token, input.ip, "setup");
  if (!burned) throw new SetupLinkSpentError();

  const offered = await offeredFieldIds(tx);
  const chosen = new Set<BookingFieldId>();
  for (const field of input.fields) {
    // Unknown ids from a form are dropped, not thrown on: the catalogue is
    // the only source of the checkboxes, so an unknown id is a stale tab.
    // So is one the page did not offer this practice (an animal field).
    if (isBookingFieldId(field) && offered.has(field)) chosen.add(field);
  }
  for (const field of BOOKING_FIELDS) if (field.locked) chosen.add(field.id);
  const ordered = BOOKING_FIELDS.filter((f) => chosen.has(f.id)).map((f) => f.id);

  const set: Partial<typeof clinics.$inferInsert> = {
    bookingRequirements: ordered,
    bookingRequirementsConfirmedAt: now,
    bookingRequirementsSource: "practice",
    updatedAt: now,
  };

  let elected = false;
  if (input.election) {
    if (!directBookingOffered(input.platformId)) {
      throw new SetupSubmissionError("Direct booking is not offered for this practice.", "directBooking");
    }
    const name = input.election.signatoryName.trim();
    if (!name || name.length > 200) throw new SetupSubmissionError("Your name is needed to accept the addendum.", "signatoryName");
    const title = input.election.signatoryTitle?.trim() || null;
    if (title && title.length > 200) throw new SetupSubmissionError("That title is too long.", "signatoryTitle");
    const prepared = prepareDirectBookingAddendum({
      clinicLegalName: input.clinicName,
      signatoryName: name,
      signatoryTitle: title ?? undefined,
      acceptedOn: now.toISOString().slice(0, 10),
    });
    set.directBookingElectedAt = now;
    set.directBookingElectedByLabel = title ? `${name}, ${title}` : name;
    set.directBookingClauseVersion = prepared.version;
    set.directBookingClauseHash = Buffer.from(prepared.hash, "hex");
    set.directBookingWithdrawnAt = null;
    elected = true;
  }

  await tx.db.update(clinics).set(set).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_booking_requirements",
    resourceId: tx.clinicId,
    metadata: { source: "practice", fields: ordered, directBookingElected: elected },
  });
  await completeStep(tx, "booking_requirements_confirmed", { at: now, note: "confirmed by the practice on its setup link" });
  return { fields: ordered, directBookingElected: elected };
}
