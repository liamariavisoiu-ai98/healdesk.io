import {
  bookingSyncFor,
  isBookingSystemId,
  isCalendarAccount,
  isSpecialtyId,
  parseClinicProfile,
  screenClinicProfile,
  cleanWebsite,
  type BookingSystemId,
  type CalendarAccount,
  type ClinicProfile,
} from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { agentConfigs, clinics, clinicSettings, type CheckoutIntentPayload } from "@/db/schema";
import { parseOpeningHours } from "@/lib/clinic/opening-hours";
import { MAX_AGENT_SERVICES } from "@/lib/onboarding/agent-config";
import { completeStep } from "@/lib/onboarding/steps";
import type { TenantTx } from "@/lib/tenant";

import { neverSayWithDefaults, serviceFromProfile } from "./knowledge";
import { toE164 } from "./settings";

/**
 * What provisioning seeds for the setup wizard (plan Part C2), so the clinic
 * arrives at a form already filled with its own words ("never ask twice"):
 *
 * - settings from the funnel's answers: where bookings live, and from it
 *   Auto-confirm, off for a system that does not read Google Calendar (the
 *   one-way and unverified ones, which run manual booking); the kind of
 *   Google account;
 * - the practice from the website read: the address, the main number, the
 *   website and the weekly hours of the location the read found first (the
 *   wizard asks which location when there are several);
 * - knowledge from the read: services with their price kinds, policies and
 *   the site's own questions and answers as quick answers, all screened again
 *   under the specialty the clinic bought; and the never-say list's clinical
 *   defaults for every clinic;
 * - the read itself, as the drift check's baseline;
 * - the booking-requirement set from the specialty's defaults, the setup
 *   link's old question, which the wizard no longer asks.
 *
 * The time zone is decided before the clinic row is written
 * (provisionRequestFromIntent): the address's, then the browser's, then New
 * York. Everything here runs in provisioning's own transaction, after the
 * agent's default words are seeded, and nothing here is confirmed: each answer
 * waits for the clinic in the wizard.
 */

export type SetupSeed = {
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
  /** The website the funnel took, or null for a practice with none. */
  website?: string | null;
  /** The website read, as the intent stored it; validated and screened again here. */
  profile?: unknown;
};

/** The seed a stored checkout intent carries. */
export function setupSeedFromIntent(intent: { payload: unknown; profile: unknown }): SetupSeed {
  const payload = (intent.payload ?? {}) as Partial<CheckoutIntentPayload>;
  return {
    ...(isBookingSystemId(payload.bookingSystem) ? { bookingSystem: payload.bookingSystem } : {}),
    ...(isCalendarAccount(payload.calendarAccount)
      ? { calendarAccount: payload.calendarAccount }
      : {}),
    ...(payload.website !== undefined ? { website: payload.website } : {}),
    ...(intent.profile ? { profile: intent.profile } : {}),
  };
}

/**
 * The read profile a seed carries, re-parsed and re-screened under the
 * specialty bought, or null. A profile that no longer parses is dropped, not
 * repaired: the wizard then asks its three questions.
 */
export function seededProfile(seed: SetupSeed, specialty: string): ClinicProfile | null {
  if (!seed.profile) return null;
  const parsed = parseClinicProfile(seed.profile);
  if (!parsed) return null;
  return screenClinicProfile(parsed, isSpecialtyId(specialty) ? specialty : null);
}

export async function seedSetup(
  tx: TenantTx,
  input: { specialty: string; seed: SetupSeed; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const { seed } = input;
  const profile = seededProfile(seed, input.specialty);
  const location = profile?.locations[0] ?? null;

  // The practice, from the read.
  let hours = null;
  if (location?.hours) {
    try {
      hours = parseOpeningHours(location.hours);
    } catch {
      hours = null;
    }
  }
  const website =
    seed.website === null ? null : (cleanWebsite(seed.website ?? profile?.website ?? null) ?? null);
  await tx.db
    .update(clinics)
    .set({
      address: location?.address ?? null,
      website,
      siteProfile: profile,
      ...(hours ? { openingHours: hours } : {}),
      ...(location?.phone && toE164(location.phone)
        ? { publishedPhoneE164: toE164(location.phone) }
        : {}),
      // The booking requirement set: the specialty's defaults (NULL means
      // the defaults), settled now rather than by an emailed setup link.
      bookingRequirements: null,
      bookingRequirementsConfirmedAt: now,
      bookingRequirementsSource: "defaults",
      updatedAt: now,
    })
    .where(eq(clinics.id, tx.clinicId));
  await completeStep(tx, "booking_requirements_confirmed", {
    at: now,
    note: "specialty defaults, at provisioning",
  });

  // Settings, from the funnel's answers.
  const system = seed.bookingSystem ?? null;
  await tx.db
    .insert(clinicSettings)
    .values({
      clinicId: tx.clinicId,
      ...(system
        ? { bookingSystem: system, autoConfirmBookings: bookingSyncFor(system) === "live" }
        : {}),
      ...(seed.calendarAccount ? { calendarAccount: seed.calendarAccount } : {}),
      updatedAt: now,
    })
    .onConflictDoNothing({ target: clinicSettings.clinicId });

  // Knowledge, from the read; the never-say defaults for everyone.
  const services = (profile?.services ?? []).slice(0, MAX_AGENT_SERVICES).map(serviceFromProfile);
  await tx.db
    .update(agentConfigs)
    .set({
      ...(services.length > 0 ? { services } : {}),
      policies: profile?.policies ?? [],
      quickAnswers: (profile?.faqs ?? []).map((f) => ({ question: f.question, answer: f.answer })),
      neverSay: neverSayWithDefaults(),
      updatedAt: now,
    })
    .where(eq(agentConfigs.clinicId, tx.clinicId));

  tx.audit.record({
    action: "update",
    resourceType: "clinic_setup_seed",
    resourceId: tx.clinicId,
    metadata: {
      read: profile !== null,
      services: services.length,
      hoursRead: hours !== null,
      bookingSystem: system ?? "unknown",
    },
  });
}
