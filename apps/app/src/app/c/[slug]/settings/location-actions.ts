"use server";

import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import {
  confirmLocationDetails,
  isLocationDetailKey,
  locationDetailsPath,
  saveLocationDetail,
  STEP_UP_LOCATION_DETAILS,
} from "@/lib/portal/location-details";
import { stepUpPath, touchStepUp } from "@/lib/portal/step-up";

/**
 * A later location's page (Settings, one level down): save one detail, or
 * confirm them all. Each calls requirePortal(slug) itself; the location is
 * looked up inside the signed-in clinic's tenant, so another account's id
 * finds nothing. lib/portal/location-details.ts validates, writes and words
 * the result.
 *
 * As on Settings, a change that needs a passkey step-up and has none answers
 * with the step-up page's address, which comes back to this location's page.
 */

export type LocationActionResult =
  { ok: true; toast: string } | { ok: false; message: string; stepUpHref?: string };

export async function saveLocationDetailAction(
  slug: string,
  locationId: string,
  key: string,
  value: unknown,
): Promise<LocationActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const result = await saveLocationDetail(
    {
      clinicId: portal.clinicId,
      userId: portal.userId,
      actorLabel: actor.label,
      steppedUp: actor.steppedUp,
    },
    locationId,
    key,
    value,
  );
  if (result.ok) {
    if (actor.steppedUp && isLocationDetailKey(key) && STEP_UP_LOCATION_DETAILS.has(key)) {
      await touchStepUp(portal);
    }
    return { ok: true, toast: result.toast };
  }
  return result.needsStepUp
    ? {
        ok: false,
        message: result.message,
        stepUpHref: stepUpPath(
          portal.clinicSlug,
          locationDetailsPath(portal.clinicSlug, String(locationId)),
        ),
      }
    : { ok: false, message: result.message };
}

export async function confirmLocationDetailsAction(
  slug: string,
  locationId: string,
): Promise<LocationActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const result = await confirmLocationDetails(
    {
      clinicId: portal.clinicId,
      userId: portal.userId,
      actorLabel: actor.label,
      steppedUp: actor.steppedUp,
    },
    locationId,
  );
  return result.ok ? { ok: true, toast: result.toast } : { ok: false, message: result.message };
}
