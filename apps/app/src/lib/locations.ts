import { getPlan, type PackageId, type Plan } from "@healdesk/catalog";
import { and, asc, eq, inArray } from "drizzle-orm";

import {
  clinicLocations,
  MAIN_LOCATION_POSITION,
  type ClinicLocationRow,
  type Entitlements,
  type LocationStatus,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * The account's locations: one reader for every location of the tenant, and
 * the switch that says which packages may add one.
 *
 * The owner decided on 20 October 2026 that AYA is one central assistant for
 * every location of an account, "like a call center", not an assistant per
 * location. The clinics row stays the one tenant; each location is a row of
 * clinic_locations inside it (drizzle/0108), position 1 the main location,
 * which every open account has.
 *
 * Nothing in the product reads these yet: the main location's facts are still
 * read from clinics and clinic_settings, of which its row is the database's
 * copy, and no location after the first can be added while locationsReady()
 * is false for every package. AYA's engine, the portal and /admin move onto
 * this reader in the plan's steps 9 to 13.
 */

/** A location as the product sees it. */
export type Location = {
  id: string;
  /** 1 is the main location. */
  position: number;
  isMain: boolean;
  /** The location's own name; null on the main location means the account's name. */
  label: string | null;
  status: LocationStatus;
  timezone: string;
  address: string | null;
  publishedPhoneE164: string | null;
  openingHours: ClinicLocationRow["openingHours"];
  directLineE164: string | null;
  transferE164: string | null;
  urgentHelpE164: string | null;
  vetReferralE164: string | null;
  coverageMode: ClinicLocationRow["coverageMode"];
  carrier: string | null;
  phoneSystemType: ClinicLocationRow["phoneSystemType"];
  callRouting: ClinicLocationRow["callRouting"];
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asLocation(row: ClinicLocationRow): Location {
  return {
    id: row.id,
    position: row.position,
    isMain: row.position === MAIN_LOCATION_POSITION,
    label: row.label,
    status: row.status,
    timezone: row.timezone,
    address: row.address,
    publishedPhoneE164: row.publishedPhoneE164,
    openingHours: row.openingHours,
    directLineE164: row.directLineE164,
    transferE164: row.transferE164,
    urgentHelpE164: row.urgentHelpE164,
    vetReferralE164: row.vetReferralE164,
    coverageMode: row.coverageMode,
    carrier: row.carrier,
    phoneSystemType: row.phoneSystemType,
    callRouting: row.callRouting,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
  };
}

/**
 * Every location of the tenant, main first, then in the order they were
 * added. All statuses unless `statuses` narrows them. The tenant's own rows
 * only: RLS, and the filter on the tenant besides.
 */
export async function readLocations(
  tx: TenantTx,
  options: { statuses?: readonly LocationStatus[] } = {},
): Promise<Location[]> {
  const statuses = options.statuses;
  if (statuses && statuses.length === 0) return [];
  const rows = await tx.db
    .select()
    .from(clinicLocations)
    .where(
      and(
        eq(clinicLocations.clinicId, tx.clinicId),
        statuses ? inArray(clinicLocations.status, [...statuses]) : undefined,
      ),
    )
    .orderBy(asc(clinicLocations.position));
  return rows.map(asLocation);
}

/**
 * The tenant's main location. Every open account has exactly one (the trigger
 * that makes it with the clinic, and 0108's backfill); a closed account has
 * none, and this throws for it, as for a clinic that does not exist.
 */
export async function mainLocation(tx: TenantTx): Promise<Location> {
  const [row] = await tx.db
    .select()
    .from(clinicLocations)
    .where(
      and(
        eq(clinicLocations.clinicId, tx.clinicId),
        eq(clinicLocations.position, MAIN_LOCATION_POSITION),
      ),
    )
    .limit(1);
  if (!row) throw new Error("This account has no main location: it is closed, or not a clinic.");
  return asLocation(row);
}

/**
 * One location of the tenant by its id, or null: for an id that is not a
 * UUID, that names no location, or that names another account's location
 * (never read, whatever the caller's tenant: the filter on the tenant holds
 * even where RLS would not).
 */
export async function locationById(tx: TenantTx, id: string): Promise<Location | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx.db
    .select()
    .from(clinicLocations)
    .where(and(eq(clinicLocations.clinicId, tx.clinicId), eq(clinicLocations.id, id)))
    .limit(1);
  return row ? asLocation(row) : null;
}

// -----------------------------------------------------------------------------
// The switch
// -----------------------------------------------------------------------------

/**
 * The packages whose accounts may add a location from Billing, keyed on the
 * package BOUGHT (entitlements.bought_plan_id), never the one billed: a
 * package with phone is billed as its chat half until its phone answers, and
 * a gate on the billed plan would let a Voice + Web Chat account add a
 * location it then pays for twice, with no AYA number of its own.
 *
 * Empty: no package yet. Switch 1 (the plan's step 14) adds the chat
 * packages, `webchat` and `metachat`, in the commit that makes production do
 * it; switch 2 (step 17) the three with phone, once each location has its
 * own AYA number. apps/web's launch tracker test reads this list from this
 * file's source (launch-locations.test.ts), so it stays a plain array of
 * package ids.
 */
export const LOCATIONS_READY_PACKAGES: readonly PackageId[] = [];

/**
 * Whether an account that bought `boughtPlan` (a Plan, or its plan id) may
 * add a location. False for an unknown or missing plan. Replaces the single
 * LOCATION_CLINICS_READY flag, which could not say "the chat packages only".
 */
export function locationsReady(boughtPlan: Plan | string | null | undefined): boolean {
  const plan = typeof boughtPlan === "string" ? getPlan(boughtPlan) : (boughtPlan ?? undefined);
  if (!plan) return false;
  return LOCATIONS_READY_PACKAGES.includes(plan.packageId);
}

/**
 * Whether any package may add a location at all: the refusal addLocation
 * gives before it reads anything, as LOCATION_CLINICS_READY's did. The
 * account's own package is judged after, by locationsReady.
 */
export function anyLocationsReady(): boolean {
  return LOCATIONS_READY_PACKAGES.length > 0;
}

// -----------------------------------------------------------------------------
// Phone, while an account has more than one location
// -----------------------------------------------------------------------------

/**
 * Whether phone may not be priced into this account's plan yet: it has more
 * than one location, or one being added. Phone is per location (each needs
 * its own AYA number and forwarded line), which the extra-locations plan's
 * slice 2 builds; until then a package with phone would be billed once per
 * location for one number that answers for none of the others.
 *
 * One predicate for every door into phone: a plan change (checkPlanChange),
 * the hourly reconcile's step-ups and the billing-requests worker
 * (lib/billing/reconcile.ts, lib/billing/requests.ts), and the console's
 * retry of a step-up (lib/ops/billing.ts).
 */
export function phoneHeldByLocations(
  row: Pick<Entitlements, "locations" | "pendingLocationRequestId">,
): boolean {
  return row.locations > 1 || row.pendingLocationRequestId !== null;
}

/** What a practice is told when a plan change would move it into phone. */
export const PHONE_NEEDS_ONE_LOCATION =
  "A plan with phone can't be chosen while this account has more than one location: each location needs its own AYA number, which isn't available yet.";

/** What an operator is told when a retry would price phone into such an account. */
export const PHONE_STEP_UP_HELD =
  "This step-up would add phone to the plan of an account with more than one location (or one being added), and phone can't be billed per location until each location has its own AYA number. It was not retried and nothing was charged.";
