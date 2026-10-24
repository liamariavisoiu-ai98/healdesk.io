import { cleanWebsite, isKnownTimeZone } from "@healdesk/catalog";
import { and, eq, gte, notInArray, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinicClosures, clinics, clinicSettings, entitlements } from "@/db/schema";
import { setSetupDeadline } from "@/lib/billing/entitlements";
import {
  clinicLocalDate,
  closureLabelProblem,
  closuresFrom,
  type Closure,
} from "@/lib/clinic/closures";
import { canonicalHours, recordClinicChange, type ChangeOrigin } from "@/lib/clinic/change-events";
import { moveSetupDeadline } from "@/lib/clinic/setup-window";
import { releaseLiveHolds } from "@/lib/booking/holds";
import {
  OpeningHoursError,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import { completeStep } from "@/lib/onboarding/steps";
import type { TenantTx } from "@/lib/tenant";
import { requestSiteReread } from "@/lib/website/queue";

import { cleanText } from "./knowledge";
import { toE164 } from "./settings";

/**
 * The practice as the clinic confirms it in the wizard's first step (plan
 * Part E, 1.1, 1.2 and 1.5): its name, address, main phone, website and time
 * zone; its weekly hours and the days it is closed; and, when the buyer
 * answered "Not sure" at checkout, whether it bills insurance electronically.
 *
 * Business data about the practice, never about a patient. Written inside the
 * clinic's tenant; each answer stamps the onboarding step it settles.
 */

export class PracticeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "PracticeError";
  }
}

export type Practice = {
  name: string;
  address: string | null;
  publishedPhoneE164: string | null;
  website: string | null;
  timezone: string;
  timezoneConfirmed: boolean;
  openingHours: OpeningHours | null;
  isCoveredEntity: boolean | null;
};

export async function readPractice(db: Transaction, clinicId: string): Promise<Practice | null> {
  const [row] = await db
    .select({
      name: clinics.name,
      address: clinics.address,
      publishedPhoneE164: clinics.publishedPhoneE164,
      website: clinics.website,
      timezone: clinics.timezone,
      timezoneConfirmedAt: clinics.timezoneConfirmedAt,
      openingHours: clinics.openingHours,
      isCoveredEntity: clinics.isCoveredEntity,
    })
    .from(clinics)
    .where(eq(clinics.id, clinicId))
    .limit(1);
  if (!row) return null;
  return {
    name: row.name,
    address: row.address,
    publishedPhoneE164: row.publishedPhoneE164,
    website: row.website,
    timezone: row.timezone,
    timezoneConfirmed: row.timezoneConfirmedAt !== null,
    openingHours: row.openingHours,
    isCoveredEntity: row.isCoveredEntity,
  };
}

export type BasicsInput = {
  name: unknown;
  address: unknown;
  phone: unknown;
  /** The website, or "" / null for none. */
  website: unknown;
  timezone: unknown;
};

/**
 * 1.1: name, address, main phone, website and time zone. The main phone may
 * not be the direct line: once the main line forwards to AYA, a fallback to
 * it would loop (CLAUDE.md, "Failure").
 */
export async function saveBasics(
  tx: TenantTx,
  input: BasicsInput,
  now: Date = new Date(),
): Promise<void> {
  const name = cleanText(input.name, 120);
  if (!name) throw new PracticeError("name", "Enter the practice's name.");
  const address = cleanText(input.address, 300) || null;
  const rawPhone = typeof input.phone === "string" ? input.phone.trim() : "";
  const phone = rawPhone ? toE164(rawPhone) : null;
  if (rawPhone && !phone) {
    throw new PracticeError(
      "phone",
      "Enter the main number with its area code, like (415) 555-0100.",
    );
  }
  const rawWebsite = typeof input.website === "string" ? input.website.trim() : "";
  const website = rawWebsite ? cleanWebsite(rawWebsite) : null;
  if (rawWebsite && !website) {
    throw new PracticeError("website", "Enter the website's address, like glowmedspa.com.");
  }
  if (!isKnownTimeZone(input.timezone)) {
    throw new PracticeError("timezone", "Choose the practice's time zone.");
  }
  const timezone = input.timezone;

  if (phone) {
    const [settings] = await tx.db
      .select({ directLine: clinicSettings.directLineE164 })
      .from(clinicSettings)
      .where(eq(clinicSettings.clinicId, tx.clinicId))
      .limit(1);
    if (settings?.directLine && settings.directLine === phone) {
      throw new PracticeError(
        "phone",
        "That's the number you gave as your direct line. Calls to your main number forward to AYA, so the two must be different lines.",
      );
    }
  }

  const [before] = await tx.db
    .select({ timezone: clinics.timezone, website: clinics.website })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await tx.db
    .update(clinics)
    .set({
      name,
      address,
      publishedPhoneE164: phone,
      website,
      timezone,
      timezoneConfirmedAt: now,
      updatedAt: now,
    })
    .where(eq(clinics.id, tx.clinicId));
  if (before) await moveSetupDeadlineToZone(tx, before.timezone, timezone, now);
  // A corrected website is read again, on apps/web, so setup and Knowledge
  // start from what the right website says (lib/website).
  if (website && before && website !== before.website) {
    await requestSiteReread(tx, { reason: "corrected", website, now });
  }
  tx.audit.record({
    action: "update",
    resourceType: "clinic_practice",
    resourceId: tx.clinicId,
    metadata: {
      addressSet: address !== null,
      phoneSet: phone !== null,
      websiteSet: website !== null,
    },
  });
}

/**
 * Keep the setup window on the clinic's own calendar when its time zone is
 * corrected (here, from 1.1, and from the ops console).
 *
 * Provisioning set the deadline to the end of the 30th day in the zone it
 * guessed: the address's, then the buyer's browser's, then New York. The
 * reminders, the closure email and the welcome email name that day in the
 * clinic's zone, so after a correction the named day and the instant the
 * account closes would no longer agree: an eastward correction promised a
 * day the account does not live to the end of, a westward one closed it hours
 * before the end of the named day. The deadline moves to the end of the same
 * day in the corrected zone: the day stays the one already named (the welcome
 * email names it at once), and "by the end of that day" becomes true where
 * the clinic is.
 *
 * Never into the past: a correction in the window's last hours that would
 * close it at once keeps the later deadline. A location (no billing row of
 * its own) and a clinic with no deadline have nothing to move. Returns
 * whether the deadline moved.
 */
export async function moveSetupDeadlineToZone(
  tx: TenantTx,
  fromZone: string,
  toZone: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (fromZone === toZone || !isKnownTimeZone(fromZone) || !isKnownTimeZone(toZone)) return false;
  const [row] = await tx.db
    .select({ deadline: entitlements.setupDeadlineAt })
    .from(entitlements)
    .where(eq(entitlements.clinicId, tx.clinicId))
    .limit(1);
  if (!row?.deadline || row.deadline.getTime() <= now.getTime()) return false;
  const moved = moveSetupDeadline(row.deadline, fromZone, toZone);
  if (moved.getTime() === row.deadline.getTime() || moved.getTime() <= now.getTime()) return false;
  await setSetupDeadline(tx.db, tx.clinicId, moved);
  tx.audit.record({
    action: "update",
    resourceType: "setup_deadline",
    resourceId: tx.clinicId,
    metadata: { reason: "time_zone_corrected", fromZone, toZone },
  });
  return true;
}

// -----------------------------------------------------------------------------
// Hours and closures
// -----------------------------------------------------------------------------

export type { Closure };

/** The clinic's closed days from today on, in its own time zone. */
export async function readUpcomingClosures(
  db: Transaction,
  clinicId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<Closure[]> {
  return closuresFrom(db, clinicId, clinicLocalDate(now, timeZone));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 1.2: the weekly hours, and the closed days from today on, replaced as the
 * form sends them. Past closures are history and are left alone.
 *
 * What changed is recorded for ops in the same transaction
 * (lib/clinic/change-events.ts): one row for the weekly hours when they
 * differ, one for the closed days when any were added or taken off, with
 * the dates and counts and nothing else. `origin` says who saved it; a
 * writer that does not say is recorded as the portal's, where Knowledge and
 * its website changes save from. A caller's held minute on a day this save
 * newly closed is let go (`closure_added`), so a time held a moment before
 * the save is never booked onto a closed day; a hold that belongs to a
 * booking request stays, for the clinic to decide in Bookings.
 */
export async function saveHours(
  tx: TenantTx,
  input: { hours: unknown; closures: unknown },
  timeZone: string,
  now: Date = new Date(),
  origin: ChangeOrigin = { source: "portal", actor: "clinic_signin" },
): Promise<void> {
  let hours: OpeningHours;
  try {
    hours = parseOpeningHours(input.hours);
  } catch (error) {
    if (error instanceof OpeningHoursError) throw new PracticeError("hours", error.message);
    throw error;
  }
  if (Object.values(hours).every((ranges) => ranges.length === 0)) {
    throw new PracticeError("hours", "Add the hours you're open on at least one day.");
  }

  const today = clinicLocalDate(now, timeZone);
  const closures: Closure[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(input.closures) ? input.closures : []) {
    const row = (raw ?? {}) as { closedOn?: unknown; label?: unknown };
    const closedOn = typeof row.closedOn === "string" ? row.closedOn : "";
    if (!ISO_DATE.test(closedOn) || Number.isNaN(Date.parse(`${closedOn}T12:00:00Z`))) {
      throw new PracticeError("closures", "Choose each closed day from the calendar.");
    }
    if (closedOn < today) {
      throw new PracticeError("closures", "A closed day has to be today or later.");
    }
    if (seen.has(closedOn)) continue;
    seen.add(closedOn);
    const label = cleanText(row.label, 80) || null;
    const problem = label ? closureLabelProblem(label) : null;
    if (problem) throw new PracticeError("closures", problem);
    closures.push({ closedOn, label });
  }
  if (closures.length > 60)
    throw new PracticeError("closures", "Add at most 60 closed days at a time.");

  // Before the write, for the change record: the hours as they were and the
  // closed days from today on.
  const [previous] = await tx.db
    .select({ openingHours: clinics.openingHours })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const closedBefore = new Set((await closuresFrom(tx.db, tx.clinicId, today)).map((c) => c.closedOn));

  await tx.db
    .update(clinics)
    .set({ openingHours: hours, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
  // A day that stays closed keeps its row, and with it its created_at: the
  // moment that day was closed, which tells one closing of a day from the
  // next (the closed-day email's dedupe key, lib/portal/knowledge.ts). Only
  // the days no longer listed are deleted; a listed day is inserted, or
  // keeps its row with the label it is sent with now.
  await tx.db
    .delete(clinicClosures)
    .where(
      and(
        eq(clinicClosures.clinicId, tx.clinicId),
        gte(clinicClosures.closedOn, today),
        closures.length > 0
          ? notInArray(
              clinicClosures.closedOn,
              closures.map((c) => c.closedOn),
            )
          : undefined,
      ),
    );
  if (closures.length > 0) {
    await tx.db
      .insert(clinicClosures)
      .values(
        closures.map((c) => ({ clinicId: tx.clinicId, closedOn: c.closedOn, label: c.label })),
      )
      .onConflictDoUpdate({
        target: [clinicClosures.clinicId, clinicClosures.closedOn],
        set: { label: sql`excluded.label` },
      });
  }
  await completeStep(tx, "hours_confirmed", { at: now });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_hours",
    resourceId: tx.clinicId,
    metadata: { closures: closures.length },
  });

  const listed = new Set(closures.map((c) => c.closedOn));
  const added = [...listed].filter((day) => !closedBefore.has(day)).sort();
  const removed = [...closedBefore].filter((day) => !listed.has(day)).sort();
  const holdsReleased =
    added.length > 0 ? await releaseLiveHolds(tx, "closure_added", { dates: added, timeZone, heldOnly: true }) : 0;
  if (canonicalHours(previous?.openingHours) !== canonicalHours(hours)) {
    await recordClinicChange(tx, { kind: "hours", ...origin, summary: { weeklyChanged: true } }, now);
  }
  if (added.length > 0 || removed.length > 0) {
    await recordClinicChange(
      tx,
      {
        kind: "closures",
        ...origin,
        summary: {
          closuresAdded: added,
          closuresRemoved: removed,
          closuresUpcoming: listed.size,
          holdsReleased,
        },
      },
      now,
    );
  }
}

/**
 * The read hours of the location the clinic chose in 1.1, as the hours
 * screen's starting point. Not a confirmation: hours_confirmed waits for 1.2.
 */
export async function adoptReadHours(
  tx: TenantTx,
  raw: unknown,
  now: Date = new Date(),
): Promise<void> {
  let hours: OpeningHours;
  try {
    hours = parseOpeningHours(raw);
  } catch {
    return;
  }
  await tx.db
    .update(clinics)
    .set({ openingHours: hours, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
}

// -----------------------------------------------------------------------------
// The insurance question (1.5)
// -----------------------------------------------------------------------------

/**
 * Whether the practice bills any health insurance electronically, asked again
 * when the buyer was not sure at checkout (spec, "Stage 2"), and recorded as
 * the practice's notice. The signed BAA stays in force either way: a BAA
 * covers a practice HIPAA can reach whatever it answered (drizzle/0051), so
 * this changes what the practice told us, never which paper it is under.
 */
export async function recordInsuranceAnswer(
  tx: TenantTx,
  billsInsurance: boolean,
  now: Date = new Date(),
): Promise<void> {
  await tx.db
    .update(clinics)
    .set({ isCoveredEntity: billsInsurance, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
  await completeStep(tx, "covered_entity_confirmed", {
    at: now,
    note: "the practice's notice, from setup",
  });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_covered_entity",
    resourceId: tx.clinicId,
    metadata: { coveredEntity: billsInsurance, source: "setup" },
  });
}
