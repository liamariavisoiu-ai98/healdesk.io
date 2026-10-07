import { cleanWebsite, isKnownTimeZone } from "@healdesk/catalog";
import { and, asc, eq, gte } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinicClosures, clinics, clinicSettings } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import {
  OpeningHoursError,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import { completeStep } from "@/lib/onboarding/steps";
import type { TenantTx } from "@/lib/tenant";

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

// -----------------------------------------------------------------------------
// Hours and closures
// -----------------------------------------------------------------------------

export type Closure = { closedOn: string; label: string | null };

/** The clinic's closed days from today on, in its own time zone. */
export async function readUpcomingClosures(
  db: Transaction,
  clinicId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<Closure[]> {
  const today = clinicLocalDate(now, timeZone);
  const rows = await db
    .select({ closedOn: clinicClosures.closedOn, label: clinicClosures.label })
    .from(clinicClosures)
    .where(and(eq(clinicClosures.clinicId, clinicId), gte(clinicClosures.closedOn, today)))
    .orderBy(asc(clinicClosures.closedOn))
    .limit(100);
  return rows;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 1.2: the weekly hours, and the closed days from today on, replaced as the
 * form sends them. Past closures are history and are left alone.
 */
export async function saveHours(
  tx: TenantTx,
  input: { hours: unknown; closures: unknown },
  timeZone: string,
  now: Date = new Date(),
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
    closures.push({ closedOn, label: cleanText(row.label, 80) || null });
  }
  if (closures.length > 60)
    throw new PracticeError("closures", "Add at most 60 closed days at a time.");

  await tx.db
    .update(clinics)
    .set({ openingHours: hours, updatedAt: now })
    .where(eq(clinics.id, tx.clinicId));
  await tx.db
    .delete(clinicClosures)
    .where(and(eq(clinicClosures.clinicId, tx.clinicId), gte(clinicClosures.closedOn, today)));
  if (closures.length > 0) {
    await tx.db
      .insert(clinicClosures)
      .values(
        closures.map((c) => ({ clinicId: tx.clinicId, closedOn: c.closedOn, label: c.label })),
      );
  }
  await completeStep(tx, "hours_confirmed", { at: now });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_hours",
    resourceId: tx.clinicId,
    metadata: { closures: closures.length },
  });
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
