import type { ActorContext } from "./audit";

/**
 * An extra location for a clinic that already buys from us (plan Stage 0:
 * "extra locations from Billing at the package price plus setup fee, with
 * pooled allowances").
 *
 * Package C's `addLocation` charges Stripe (quantity +1, plus the setup fee
 * once), sets `entitlements.locations`, and then calls this to create the
 * location's clinic: in the billing clinic's organisation, with
 * `clinics.billing_clinic_id` pointing at it and no entitlements row of its
 * own, set up exactly as provisioning sets up a bought clinic (settings
 * defaults, channels, knowledge, the terms record, the retention clock). It
 * lives beside provisioning so there is one way to make a clinic.
 *
 * A stub until the provisioning rewrite in M2 lands it, so Package C can be
 * written against the signature now and nothing can create half a clinic.
 *
 * Idempotent on (billingClinicId, locationNumber), so `addLocation` can
 * resume from here if a step after the charge failed: the same call returns
 * the clinic the first one made.
 */
export type CreateLocationClinicInput = {
  billingClinicId: string;
  /** The billing clinic's location count after this add: 2 for the first extra location. */
  locationNumber: number;
  name?: string;
  actor: ActorContext;
};

/**
 * Whether createLocationClinic can make a clinic yet. `addLocation` refuses
 * with "not_available" while this is false, so no clinic is charged for a
 * location the stub below would then fail to create. Flipped in the same
 * commit as the real body.
 */
export const LOCATION_CLINICS_READY = false;

export async function createLocationClinic(
  input: CreateLocationClinicInput,
): Promise<{ clinicId: string; slug: string }> {
  void input;
  throw new Error("createLocationClinic lands with the provisioning rewrite (M2)");
}
