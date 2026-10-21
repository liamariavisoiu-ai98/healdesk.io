import { randomUUID } from "node:crypto";

import {
  CentralAssistantAcknowledgementError,
  currentCentralAssistantAcknowledgement,
  prepareCentralAssistantAcknowledgement,
  type Plan,
} from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import { clinicLocations, clinics } from "@/db/schema";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import { recordLocationAcknowledgement } from "@/lib/location-acknowledgements";
import type { StepUp } from "@/lib/portal/step-up";
import type { TenantTx } from "@/lib/tenant";

/**
 * The add of a further location, on the account's own tenant (the
 * extra-locations plan's step 8; the owner's central model of 20 October
 * 2026: one AYA answers for every location of an account).
 *
 * It replaces createLocationClinic, which made a clinic per location joined
 * by clinics.billing_clinic_id and was never more than a stub. A location is
 * now a row of clinic_locations (drizzle/0108), written in three moves that
 * addLocation (lib/billing/stripe-actions.ts) makes around Stripe:
 *
 *   1. before any charge, in the transaction that marks the add pending on
 *      entitlements: the acknowledgement, rendered here from the server's own
 *      variables and recorded under the person's passkey step-up, then the
 *      pending location naming it (`writePendingLocation`);
 *   2. after the charge is recorded on entitlements: `activatePendingLocation`,
 *      which only app_activate_location() can do, and which refuses a
 *      location whose charge is not on record;
 *   3. when the add is cleared without a charge (a decline, a refusal, or the
 *      resume finding nothing in Stripe): `retireUnpaidLocation`, which only
 *      app_retire_unpaid_location() can do, and which refuses while the add is
 *      still pending.
 *
 * Refusals, before anything is written:
 *
 *   - a practice under a data processing agreement. The DPA released on
 *     20 October 2026 (1.0.0) has no sentence that defines a further location,
 *     so in this release a location is added only under a BAA, whatever the
 *     DPA in force says (the plan's review of 20 October);
 *   - an acknowledgement version the owner has not released. 1.0.0 is not
 *     released until its wording audit passes, so even with the package
 *     switch on (locationsReady) nothing is recorded for a real practice
 *     until it is;
 *   - a name or address the acknowledgement cannot print (empty, too long, a
 *     control character or a brace).
 *
 * A location after the first keeps the account's time zone in this release:
 * the row is written with it, and the database refuses any other
 * (app_clinic_location_guard). No address is geocoded here; the address is
 * business data the practice types.
 */

export type LocationAcceptance = {
  /** The portal user who ticks the acknowledgement. */
  userId: string;
  /** The name (and title) they typed as someone with authority to bind the practice. */
  acceptedByLabel: string;
  /** Their live passkey step-up (requireStepUp / touchStepUp). */
  stepUp: Pick<StepUp, "stepUpId" | "passkeyId" | "deviceLabel">;
  /** The tick itself. Never assumed. */
  accepted: boolean;
  request?: { ipAddress?: string; userAgent?: string };
};

export type NewLocation = {
  /** The location's own name, as the practice gives it. */
  name: string;
  /** Its street address, as the practice gives it. */
  address: string;
};

export type PendingLocationRefusal = {
  ok: false;
  code: "dpa" | "not_released" | "no_agreement" | "invalid" | "not_accepted";
  message: string;
};

export type PendingLocationWritten = { ok: true; locationId: string; acknowledgementId: string };

// Lower case only: app_activate_location() compares the row's uuid, as text,
// with entitlements.pending_location_request_id, which keeps the id as sent.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LOCATION_ADD_MESSAGES = {
  dpa: "A location can't be added under a data processing agreement yet. Nothing was changed and nothing was charged.",
  notReleased:
    "Adding a location isn't available yet. Nothing was changed and nothing was charged.",
  noAgreement:
    "This account has no signed agreement in effect, so a location can't be added. Nothing was charged.",
  notAccepted:
    "Tick the acknowledgement that AYA answers for every location as one assistant, then try again.",
  invalid:
    "Give the location's name and street address, without special characters. Nothing was charged.",
} as const;

/** Whether `id` can be an add's request id: the pending location keys on it as a uuid. */
export function isLocationRequestId(id: string): boolean {
  return UUID.test(id);
}

/** The practice's legal name as its agreement names it, else the account's name. */
async function practiceLegalName(
  tx: TenantTx,
  variables: Record<string, unknown>,
): Promise<string> {
  const signed =
    typeof variables.clinicLegalName === "string" ? variables.clinicLegalName.trim() : "";
  if (signed) return signed;
  const [row] = await tx.db
    .select({ name: clinics.name })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row?.name ?? "";
}

/**
 * Step 1: record the acceptance and the pending location, in the caller's
 * transaction (the one that marks the add pending on entitlements), before
 * any charge. Returns a refusal, writing nothing, for the cases above; throws
 * when the database refuses the acceptance (an ended step-up, another
 * person's), which rolls the whole transaction back, the pending marker with
 * it.
 *
 * Idempotent on the request: a pending location already written for it is
 * returned as it is.
 */
export async function writePendingLocation(
  tx: TenantTx,
  input: {
    requestId: string;
    boughtPlan: Plan;
    location: NewLocation;
    acceptance: LocationAcceptance;
  },
): Promise<PendingLocationWritten | PendingLocationRefusal> {
  if (!isLocationRequestId(input.requestId)) {
    return { ok: false, code: "invalid", message: LOCATION_ADD_MESSAGES.invalid };
  }
  const [existing] = await tx.db
    .select({ id: clinicLocations.id, acknowledgementId: clinicLocations.acknowledgementId })
    .from(clinicLocations)
    .where(
      and(
        eq(clinicLocations.clinicId, tx.clinicId),
        eq(clinicLocations.addRequestId, input.requestId),
      ),
    )
    .limit(1);
  if (existing?.acknowledgementId) {
    return { ok: true, locationId: existing.id, acknowledgementId: existing.acknowledgementId };
  }

  if (input.acceptance.accepted !== true) {
    return { ok: false, code: "not_accepted", message: LOCATION_ADD_MESSAGES.notAccepted };
  }
  const document = currentCentralAssistantAcknowledgement();
  if (!document.released) {
    return { ok: false, code: "not_released", message: LOCATION_ADD_MESSAGES.notReleased };
  }
  const agreement = await agreementInEffect(tx);
  if (!agreement) {
    return { ok: false, code: "no_agreement", message: LOCATION_ADD_MESSAGES.noAgreement };
  }
  if (agreement.agreementKind !== "baa") {
    return { ok: false, code: "dpa", message: LOCATION_ADD_MESSAGES.dpa };
  }

  let prepared: ReturnType<typeof prepareCentralAssistantAcknowledgement>;
  try {
    prepared = prepareCentralAssistantAcknowledgement(
      {
        practiceLegalName: await practiceLegalName(tx, agreement.variables),
        locationName: input.location.name,
        locationAddress: input.location.address,
        packageHasPhone: input.boughtPlan.channels.voice,
      },
      document,
    );
  } catch (error) {
    if (error instanceof CentralAssistantAcknowledgementError) {
      return { ok: false, code: "invalid", message: LOCATION_ADD_MESSAGES.invalid };
    }
    throw error;
  }

  const name = input.location.name.replace(/\s+/g, " ").trim();
  const address = input.location.address.replace(/\s+/g, " ").trim();
  const locationId = randomUUID();
  const recorded = await recordLocationAcknowledgement(tx, {
    locationId,
    documentVersion: prepared.version,
    renderedText: prepared.text,
    acceptedBy: {
      userId: input.acceptance.userId,
      label: input.acceptance.acceptedByLabel,
      stepUp: input.acceptance.stepUp,
    },
    ...(input.acceptance.request ? { request: input.acceptance.request } : {}),
  });

  // The next place after every location the account has had, retired ones
  // included: a declined add keeps its place, so a retry takes the next.
  const zoneAndPlace = await tx.db.execute<{ timezone: string; next: number }>(sql`
    select c.timezone,
           (select coalesce(max(l.position), 1) + 1
              from clinic_locations l where l.clinic_id = c.id) as next
      from clinics c where c.id = ${tx.clinicId}`);
  const place = zoneAndPlace.rows[0];
  if (!place) throw new Error("The account was not found while adding a location.");

  await tx.db.insert(clinicLocations).values({
    id: locationId,
    clinicId: tx.clinicId,
    position: Number(place.next),
    label: name,
    addRequestId: input.requestId,
    acknowledgementId: recorded.id,
    timezone: place.timezone,
    address,
  });
  tx.audit.record({
    action: "create",
    resourceType: "clinic_location",
    resourceId: locationId,
    metadata: { status: "pending", position: Number(place.next), acknowledgementId: recorded.id },
  });
  return { ok: true, locationId, acknowledgementId: recorded.id };
}

/**
 * Step 2: make the add's pending location active, once its charge is
 * recorded on entitlements. Returns null when the add has no location row
 * (an add marked pending before this release, which wrote none); throws when
 * the database refuses (the charge not recorded, a retired location).
 * Repeating it for an active location returns the same time.
 */
export async function activatePendingLocation(
  tx: TenantTx,
  requestId: string,
): Promise<{ locationId: string; activatedAt: Date } | null> {
  if (!isLocationRequestId(requestId)) return null;
  const [row] = await tx.db
    .select({ id: clinicLocations.id })
    .from(clinicLocations)
    .where(
      and(eq(clinicLocations.clinicId, tx.clinicId), eq(clinicLocations.addRequestId, requestId)),
    )
    .limit(1);
  if (!row) return null;
  const result = await tx.db.execute<{ at: Date | string }>(
    sql`select app_activate_location(${row.id}::uuid) as at`,
  );
  const at = result.rows[0]?.at;
  if (!at) throw new Error("The location was not activated.");
  tx.audit.record({
    action: "update",
    resourceType: "clinic_location",
    resourceId: row.id,
    metadata: { status: "active" },
  });
  return { locationId: row.id, activatedAt: new Date(at) };
}

/**
 * Step 3: retire the add's pending location once the add has been cleared
 * without a charge. Call it after clearing the pending marker, in the same
 * transaction; it is refused while the add is still pending. Returns whether
 * it retired one (false for an add with no row, or one already retired).
 */
export async function retireUnpaidLocation(tx: TenantTx, requestId: string): Promise<boolean> {
  if (!isLocationRequestId(requestId)) return false;
  const result = await tx.db.execute<{ retired: boolean }>(
    sql`select app_retire_unpaid_location(${requestId}::uuid) as retired`,
  );
  const retired = result.rows[0]?.retired === true;
  if (retired) {
    tx.audit.record({
      action: "update",
      resourceType: "clinic_location",
      resourceId: requestId,
      metadata: { status: "retired", reason: "add_not_charged" },
    });
  }
  return retired;
}

/**
 * The acknowledgement as Billing shows it above the tick, from the same
 * document the add renders and records: the statements for the package
 * bought, and the sentence ticked with the practice's legal name filled in
 * and `{{location}}` and `{{address}}` left for the screen to fill as the
 * person types. The stored text is always the server's own render
 * (writePendingLocation), never anything the browser sends back.
 */
export async function acknowledgementShown(
  tx: TenantTx,
  boughtPlan: Plan,
): Promise<{ version: string; statements: string[]; acceptance: string }> {
  const document = currentCentralAssistantAcknowledgement();
  const agreement = await agreementInEffect(tx);
  const practice = await practiceLegalName(tx, agreement?.variables ?? {});
  return {
    version: document.version,
    statements: document.statements
      .filter((s) => boughtPlan.channels.voice || !s.phoneOnly)
      .map((s) => s.text),
    acceptance: document.acceptance.replaceAll("{{practice}}", () => practice),
  };
}
