import {
  BaaRenderError,
  templateReadsCalendarAccount,
  type BaaSelections,
  type BaaTemplate,
} from "./baa";
import { bookingSystemName, getBookingSystem, type BookingSystemId } from "./booking-systems";
import { isCalendarAccount, type CalendarAccount } from "./calendar-terms";
import { getPlatform, NO_PLATFORM_ID } from "./platforms";
import { specialties } from "./specialties";

/**
 * The agreement's selections, built from what the buyer answered.
 *
 * The browser renders the agreement for the buyer to read and hashes what it
 * showed; the server renders it again, and refuses the signature if the two
 * hashes differ (apps/app/src/lib/agreements.ts). Both sides are to build the
 * selections through this one function — signAgreement in apps/app from plan
 * C3, and the funnel's AgreementStep — so that the two renders cannot drift:
 * a display name looked up differently on one side, or a field one side
 * forgot, would otherwise surface as a signature refused at the last step.
 * Neither calls it yet; until both do, each still builds its own.
 *
 * What it decides, so neither caller does:
 *
 *   - the specialty's display name, from the catalogue;
 *   - the values v1 never asks about: no outbound messaging, desk-confirmed
 *     booking mode and no `calendarWrite` (no clause of 1.2.x or 1.3.0 reads
 *     them, and both signing paths have always passed exactly these);
 *   - the platform the agreement names. Versions before 1.3.0 name a
 *     phase-two platform, as they always have, so what they render is byte
 *     for byte what their signers saw: the one in `platformId` when the
 *     caller has it, otherwise the booking system's `phaseTwoPlatformId`.
 *     1.3.0 names the booking system itself (`bookingSystemName`), which is
 *     what its render guard requires;
 *   - only for a template that reads them (`templateReadsCalendarAccount`),
 *     the booking system and the Google account kind. The sync is not a
 *     selection at all: the agreement derives it from the booking system, so
 *     the browser can never choose "live" for a one-way system.
 *
 * Strict, like renderBaa: an unknown specialty, booking system, platform or
 * account kind throws rather than building a document nobody answered for,
 * and so does a document with nothing to name the practice's system by.
 */
export type BaaSelectionInput = {
  specialtyId: string;
  attributionMode: "estimated" | "verified";
  /**
   * The answer to "Where do bookings live today?". Required by a template
   * that reads it (1.3.0 on). For an earlier template it names the phase-two
   * platform when there is no `platformId`.
   */
  bookingSystem: BookingSystemId | null;
  /**
   * The phase-two platform id today's checkout picker sends (`platforms`,
   * "none" included), which signAgreement receives as `platform`. Read only
   * for a template before 1.3.0, and preferred there to `bookingSystem`: the
   * picker offers Zenoti, PatientNow, Acuity and Vagaro, which no booking
   * system maps to, and their 1.2.1 documents name them. Ignored by 1.3.0,
   * which names the booking system.
   */
  platformId?: string | null;
  /** true, false, or null for "not sure", exactly as the buyer answered. */
  isCoveredEntity: boolean | null;
  /** Required when the template reads it; ignored, and may be null, when it does not. */
  calendarAccount: CalendarAccount | null;
  template: BaaTemplate;
};

export function buildBaaSelections(input: BaaSelectionInput): BaaSelections {
  const specialty = specialties.find((s) => s.id === input.specialtyId);
  if (!specialty) {
    throw new BaaRenderError(`Unknown specialty: ${JSON.stringify(input.specialtyId)}`);
  }
  const system = input.bookingSystem == null ? undefined : getBookingSystem(input.bookingSystem);
  if (input.bookingSystem != null && !system) {
    throw new BaaRenderError(`Unknown booking system: ${JSON.stringify(input.bookingSystem)}`);
  }
  const platform = input.platformId == null ? undefined : getPlatform(input.platformId);
  if (input.platformId != null && !platform) {
    throw new BaaRenderError(`Unknown platform: ${JSON.stringify(input.platformId)}`);
  }

  const selections: BaaSelections = {
    specialty: specialty.name,
    attributionMode: input.attributionMode,
    connectedPlatform: null,
    isCoveredEntity: input.isCoveredEntity,
    outboundMessaging: false,
    bookingMode: "desk_confirms",
    calendarWrite: null,
  };

  if (!templateReadsCalendarAccount(input.template)) {
    if (!platform && !system) {
      throw new BaaRenderError(
        `Version ${input.template.version} needs the practice's platform or booking system.`,
      );
    }
    // Exactly what signAgreement and AgreementStep pass today: the platform's
    // name, or null for "none" and for a system with no phase-two platform.
    const named =
      platform ?? (system?.phaseTwoPlatformId ? getPlatform(system.phaseTwoPlatformId) : undefined);
    return {
      ...selections,
      connectedPlatform: named && named.id !== NO_PLATFORM_ID ? named.name : null,
    };
  }

  if (!system) {
    throw new BaaRenderError(
      `Version ${input.template.version} needs the practice's booking system; got ${JSON.stringify(input.bookingSystem)}.`,
    );
  }
  if (!isCalendarAccount(input.calendarAccount)) {
    throw new BaaRenderError(
      `Version ${input.template.version} needs the kind of Google account that holds the calendar; got ${JSON.stringify(input.calendarAccount)}.`,
    );
  }
  return {
    ...selections,
    connectedPlatform: bookingSystemName(system.id),
    bookingSystem: system.id,
    calendarAccount: input.calendarAccount,
  };
}
