import { getPlan } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicLocations, clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { getEntitlements } from "@/lib/billing/entitlements";
import { canonicalHours, clinicActorOf, recordClinicChange } from "@/lib/clinic/change-events";
import { OpeningHoursError, parseOpeningHours } from "@/lib/clinic/opening-hours";
import { locationById, readLocations, type Location } from "@/lib/locations";
import { formatPhone } from "@/lib/setup/help";
import { toE164 } from "@/lib/setup/settings";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * A later location's details, confirmed by the practice (21 October 2026).
 *
 * When a location is added from Billing (lib/location-add.ts) its row holds
 * the name and street address typed there, and nothing else. The toast after
 * the add and the location_added email both say "confirm its address, hours
 * and phone numbers"; the owner decided to keep those words and build the
 * page they point to, so they tell the truth. That page is Settings, one
 * level down (spec: "nothing nested more than one level deep"):
 * `/c/<slug>/settings/locations/<id>`, and this is its one door, free of
 * Next, as lib/portal/settings.ts is for the rest of Settings.
 *
 * Each field saves the moment it is changed; "Confirm these details" stamps
 * clinic_locations.details_confirmed_at (drizzle/0110), which the database
 * sets once, from its own clock, and only on a later location that has an
 * address, its hours and its own number. Until then Home and Settings show
 * the location as waiting on its details.
 *
 * Where calls go is guarded as Settings guards it (CLAUDE.md, "The clinic
 * portal (v1)": step-up "where calls and money go: the direct line, the
 * transfer number, the clinic's address"). The address, the direct line and
 * the transfer number need a live passkey step-up to change once they hold a
 * value; the first time a number is set needs none, as in setup. A later
 * location's address is always set (the add asks for it), so changing it
 * always needs one. Hours and the location's public number need none.
 *
 * What it does not claim: nothing in the product reads a later location's
 * row yet (lib/locations.ts; AYA's engine moves onto it in the plan's steps
 * 9 to 13), so no toast here says AYA now uses these details.
 *
 * Business contact data only: an address, opening hours and the practice's
 * own numbers. No patient, so no access-log row (that log is for opening a
 * transcript or a booking); each change is an audit row naming the field,
 * never its value.
 */

export const LOCATION_DETAIL_KEYS = [
  "address",
  "opening_hours",
  "published_phone",
  "direct_line",
  "transfer_number",
] as const;
export type LocationDetailKey = (typeof LOCATION_DETAIL_KEYS)[number];

export function isLocationDetailKey(value: unknown): value is LocationDetailKey {
  return typeof value === "string" && (LOCATION_DETAIL_KEYS as readonly string[]).includes(value);
}

/** The fields that change where calls go or where the location is: a step-up once set. */
export const STEP_UP_LOCATION_DETAILS: ReadonlySet<LocationDetailKey> = new Set<LocationDetailKey>([
  "address",
  "direct_line",
  "transfer_number",
]);

export type LocationDetailContext = {
  clinicId: string;
  userId: string;
  /** The device whose passkey is live on this session, or the sign-in's own label. */
  actorLabel: string;
  /** Whether a passkey step-up is live on this session. */
  steppedUp: boolean;
};

export type LocationDetailResult =
  { ok: true; toast: string } | { ok: false; field: string; message: string; needsStepUp?: true };

/** The page a later location's details are confirmed and edited on. */
export function locationDetailsPath(slug: string, locationId: string): string {
  return `/c/${slug}/settings/locations/${locationId}`;
}

const STEP_UP_MESSAGE: Record<"address" | "direct_line" | "transfer_number", string> = {
  address:
    "A location's address is where AYA tells people to come, so changing it needs Face ID or your screen lock on a device you've added.",
  direct_line:
    "A location's direct line is where calls go whenever AYA can't answer, so changing it needs Face ID or your screen lock on a device you've added.",
  transfer_number:
    "A location's transfer number is where AYA puts live calls through, so changing it needs Face ID or your screen lock on a device you've added.",
};

/** setup's own wording for a number it can't read (lib/setup/settings.ts). */
const UNREADABLE_NUMBER =
  "Enter the number with its area code, like (415) 555-0100, or in international format starting with +.";

const NOT_FOUND = "That location isn't one of yours.";

class Refusal extends Error {
  constructor(
    readonly field: string,
    message: string,
    readonly needsStepUp = false,
  ) {
    super(message);
    this.name = "LocationDetailRefusal";
  }
}

function asResult(error: unknown): LocationDetailResult {
  if (error instanceof Refusal) {
    return error.needsStepUp
      ? { ok: false, field: error.field, message: error.message, needsStepUp: true }
      : { ok: false, field: error.field, message: error.message };
  }
  throw error;
}

function actorOf(ctx: LocationDetailContext): ActorContext {
  return { type: "user", userId: ctx.userId, label: ctx.actorLabel };
}

/** The name the screens call a later location by. */
export function locationName(location: Pick<Location, "label">): string {
  return location.label ?? "This location";
}

/**
 * The later location `locationId` names, open to edits: inside the tenant,
 * not the main location, not retired, on an account that has not closed.
 */
async function editableLocation(tx: TenantTx, locationId: unknown): Promise<Location> {
  if (typeof locationId !== "string") throw new Refusal("location", NOT_FOUND);
  const location = await locationById(tx, locationId);
  if (!location) throw new Refusal("location", NOT_FOUND);
  if (location.isMain) {
    throw new Refusal(
      "location",
      "Your main location's address, hours and numbers are changed in Your practice and on this Settings page.",
    );
  }
  if (location.status === "retired") {
    throw new Refusal("location", "This location was removed, so its details can't change.");
  }
  const [clinic] = await tx.db
    .select({ offboardingStartedAt: clinics.offboardingStartedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) throw new Refusal("location", NOT_FOUND);
  if (clinic.offboardingStartedAt) {
    throw new Refusal("location", "This account has closed, so its locations can't change.");
  }
  return location;
}

function requireStepUp(ctx: LocationDetailContext, key: keyof typeof STEP_UP_MESSAGE): void {
  if (!ctx.steppedUp) throw new Refusal(key, STEP_UP_MESSAGE[key], true);
}

/** Whether the account bought phone: then a location needs its direct line before it is confirmed. */
async function boughtPhone(tx: TenantTx): Promise<boolean> {
  const row = await getEntitlements(tx.db, tx.clinicId);
  const plan = row?.boughtPlanId ? getPlan(row.boughtPlanId) : undefined;
  return plan?.channels.voice === true;
}

/** AYA's own number is never a line at the practice: a call sent there comes back to her. */
async function refuseAyaNumber(tx: TenantTx, field: LocationDetailKey, e164: string) {
  const [clinic] = await tx.db
    .select({ assistant: clinics.assistantNumberE164 })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (clinic?.assistant && clinic.assistant === e164) {
    throw new Refusal(field, "That's AYA's own number. Enter a line at the location.");
  }
}

/** A street address as the add takes it: one line, no control characters, 300 at most. */
function readAddress(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw.replace(/[\n\r\t]/g, " "))) {
    throw new Refusal("address", "Give the street address without special characters.");
  }
  const address = raw.replace(/\s+/g, " ").trim();
  if (!address) throw new Refusal("address", "Enter the location's street address.");
  if (address.length > 300) {
    throw new Refusal("address", "That address is too long. Keep it to one line, as on a letter.");
  }
  return address;
}

/**
 * Save one detail of a later location, inside the clinic's tenant, and word
 * what it did. Validates on the server whatever the page sent.
 */
export async function saveLocationDetail(
  ctx: LocationDetailContext,
  locationId: unknown,
  key: unknown,
  value: unknown,
): Promise<LocationDetailResult> {
  if (!isLocationDetailKey(key)) {
    return { ok: false, field: "key", message: "That isn't one of a location's details." };
  }
  try {
    const toast = await withTenant({ clinicId: ctx.clinicId, actor: actorOf(ctx) }, async (tx) => {
      const location = await editableLocation(tx, locationId);
      const name = locationName(location);
      const confirmed = location.detailsConfirmedAt !== null;
      const update = async (patch: Partial<typeof clinicLocations.$inferInsert>) => {
        await tx.db
          .update(clinicLocations)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(clinicLocations.clinicId, tx.clinicId), eq(clinicLocations.id, location.id)),
          );
        tx.audit.record({
          action: "update",
          resourceType: "clinic_location",
          resourceId: location.id,
          metadata: { field: key, steppedUp: ctx.steppedUp },
        });
      };

      switch (key) {
        case "address": {
          const address = readAddress(value);
          if (address === location.address) return `${name}'s address is unchanged.`;
          if (location.address) requireStepUp(ctx, "address");
          await update({ address });
          return `${name}'s address is saved: ${address}.`;
        }

        case "opening_hours": {
          let hours;
          try {
            hours = parseOpeningHours(value);
          } catch (error) {
            if (error instanceof OpeningHoursError)
              throw new Refusal("opening_hours", error.message);
            throw error;
          }
          await update({ openingHours: hours });
          // For ops (lib/clinic/change-events.ts), when the hours differ,
          // compared in one spelling: the stored jsonb's key order is not
          // the parsed hours'.
          if (canonicalHours(location.openingHours) !== canonicalHours(hours)) {
            await recordClinicChange(tx, {
              kind: "location_hours",
              source: "portal",
              actor: clinicActorOf(ctx.actorLabel),
              locationId: location.id,
              summary: { weeklyChanged: true },
            });
          }
          return `${name}'s hours are saved.`;
        }

        case "published_phone": {
          const raw = typeof value === "string" ? value.trim() : "";
          if (!raw) {
            throw new Refusal(
              key,
              confirmed
                ? "A confirmed location keeps its phone number. Enter the new one instead."
                : "Enter the number people call to reach this location.",
            );
          }
          const e164 = toE164(raw);
          if (!e164) throw new Refusal(key, UNREADABLE_NUMBER);
          await refuseAyaNumber(tx, key, e164);
          await update({ publishedPhoneE164: e164 });
          return `${name}'s phone number: ${formatPhone(e164)}.`;
        }

        case "direct_line": {
          const raw = typeof value === "string" ? value.trim() : "";
          const current = location.directLineE164;
          if (!raw) {
            throw new Refusal(
              key,
              current
                ? "A location's direct line can be changed but not removed: calls need somewhere to go whenever AYA can't answer."
                : "Enter a number that reaches the team at this location.",
            );
          }
          // A number that can't be read is refused before any step-up is
          // asked for: the step-up is for a real change, not a typo.
          const e164 = toE164(raw);
          if (!e164) throw new Refusal(key, UNREADABLE_NUMBER);
          await refuseAyaNumber(tx, key, e164);
          if (e164 === current) return `${name}'s direct line is unchanged.`;
          if (current) requireStepUp(ctx, "direct_line");
          await update({ directLineE164: e164 });
          return `${name}'s direct line: ${formatPhone(e164)}.`;
        }

        case "transfer_number": {
          const raw = typeof value === "string" ? value.trim() : "";
          const current = location.transferE164;
          const e164 = raw === "" ? null : toE164(raw);
          if (raw !== "" && !e164) throw new Refusal(key, UNREADABLE_NUMBER);
          if (e164) {
            await refuseAyaNumber(tx, key, e164);
            if (e164 === location.publishedPhoneE164) {
              throw new Refusal(
                key,
                "The transfer number must be a different line from the location's own number.",
              );
            }
          }
          if (e164 === current) return `${name}'s transfer number is unchanged.`;
          if (current) requireStepUp(ctx, "transfer_number");
          await update({ transferE164: e164 });
          return e164
            ? `${name}'s transfer number: ${formatPhone(e164)}.`
            : `${name} has no transfer number. Live transfers there would go to its direct line.`;
        }
      }
    });
    return { ok: true, toast };
  } catch (error) {
    return asResult(error);
  }
}

/**
 * The practice says a later location's details are right. Refused, naming
 * what is missing, until it has an address, its hours and its own number,
 * and its direct line too when the account bought phone. Confirming again is
 * a no-op that says so; the database stamps the time once (drizzle/0110).
 *
 * No step-up of its own: confirming moves nothing. Every gated field was
 * guarded when it was saved.
 */
export async function confirmLocationDetails(
  ctx: LocationDetailContext,
  locationId: unknown,
): Promise<LocationDetailResult> {
  try {
    const toast = await withTenant({ clinicId: ctx.clinicId, actor: actorOf(ctx) }, async (tx) => {
      const location = await editableLocation(tx, locationId);
      const name = locationName(location);
      if (location.detailsConfirmedAt) return `${name}'s details are already confirmed.`;
      const missing: string[] = [];
      if (!location.address) missing.push("its address");
      if (!location.openingHours) missing.push("its hours");
      if (!location.publishedPhoneE164) missing.push("its phone number");
      if (!location.directLineE164 && (await boughtPhone(tx))) missing.push("its direct line");
      if (missing.length > 0) {
        const list =
          missing.length === 1
            ? missing[0]
            : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
        throw new Refusal("confirm", `Save ${list} first, then confirm.`);
      }
      await tx.db
        .update(clinicLocations)
        .set({ detailsConfirmedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(clinicLocations.clinicId, tx.clinicId), eq(clinicLocations.id, location.id)));
      tx.audit.record({
        action: "update",
        resourceType: "clinic_location",
        resourceId: location.id,
        metadata: { detailsConfirmed: true },
      });
      return `${name}'s address, hours and phone numbers are confirmed.`;
    });
    return { ok: true, toast };
  } catch (error) {
    return asResult(error);
  }
}

/**
 * The account's later locations that are not retired, for Settings' Locations
 * card and Home's "Needs attention": each with whether its details wait on
 * the practice.
 */
export async function readLaterLocations(
  tx: TenantTx,
): Promise<
  {
    id: string;
    name: string;
    address: string | null;
    status: Location["status"];
    confirmed: boolean;
  }[]
> {
  const rows = await readLocations(tx, { statuses: ["pending", "active"] });
  return rows
    .filter((l) => !l.isMain)
    .map((l) => ({
      id: l.id,
      name: locationName(l),
      address: l.address,
      status: l.status,
      confirmed: l.detailsConfirmedAt !== null,
    }));
}

/** One later location for its page, or null for one the page must not show. */
export async function readLocationForPage(
  tx: TenantTx,
  locationId: string,
): Promise<{ location: Location; needsDirectLine: boolean } | null> {
  const location = await locationById(tx, locationId);
  if (!location || location.isMain || location.status === "retired") return null;
  return { location, needsDirectLine: await boughtPhone(tx) };
}
