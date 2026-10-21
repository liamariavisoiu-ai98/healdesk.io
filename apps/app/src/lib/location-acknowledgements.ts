import { createHash } from "node:crypto";

import { locationAcknowledgements } from "@/db/schema";
import type { StepUp } from "@/lib/portal/step-up";
import type { TenantTx } from "@/lib/tenant";

/**
 * The client's acceptance of one central AYA for an added location (the
 * extra-locations plan, section 3), recorded before the charge.
 *
 * The add (the plan's step 8) renders the acknowledgement on the server, has
 * a person with authority tick it and pass the passkey step-up, and then, in
 * ONE transaction, before anything is charged:
 *
 *   1. picks the new location's id (randomUUID);
 *   2. records the acceptance here, for that id;
 *   3. inserts the pending clinic_locations row with that id, the add's
 *      request id and `acknowledgementId` set to what this returns.
 *
 * In that order: the location row's foreign key (clinic_id, id,
 * acknowledgement_id) needs the acceptance to exist already, and binds the
 * two, so a location can never name another location's acceptance or another
 * account's, and no location after the first exists without one (the CHECK
 * clinic_locations_added_check). app_activate_location() makes it active once
 * the charge is recorded.
 *
 * The database holds the rest (app_location_acknowledgement_guard): the row is
 * append-only for every role, `acceptedAt` is its clock, the hash must be the
 * text's, and the step-up must be a live passkey step-up of the person named,
 * on the device it names, by someone with a live grant on the account.
 */

export type LocationAcknowledgementInput = {
  /** The id the pending location row will be written with. */
  locationId: string;
  /** `<document>/<semver>`, the acknowledgement's version. */
  documentVersion: string;
  /** The acknowledgement exactly as shown, rendered by the server. */
  renderedText: string;
  acceptedBy: {
    /** The portal user. */
    userId: string;
    /** The name (and title) they typed as someone with authority to bind the practice. */
    label: string;
    /** The passkey step-up they passed (requireStepUp), as the access log names it. */
    stepUp: Pick<StepUp, "stepUpId" | "passkeyId" | "deviceLabel">;
  };
  request?: { ipAddress?: string; userAgent?: string };
};

export type RecordedLocationAcknowledgement = {
  id: string;
  documentHash: string;
  acceptedAt: Date;
};

/** SHA-256 hex of the text, as the database checks it (UTF-8). */
export function acknowledgementHash(renderedText: string): string {
  return createHash("sha256").update(renderedText, "utf8").digest("hex");
}

/**
 * Record the acceptance in the tenant's transaction and return its id, for
 * the pending location row's `acknowledgementId`. Throws when the database
 * refuses it (an ended step-up, another person's, a hash that is not the
 * text's), and the transaction, with the pending row, goes with it.
 */
export async function recordLocationAcknowledgement(
  tx: TenantTx,
  input: LocationAcknowledgementInput,
): Promise<RecordedLocationAcknowledgement> {
  const documentHash = acknowledgementHash(input.renderedText);
  const [row] = await tx.db
    .insert(locationAcknowledgements)
    .values({
      clinicId: tx.clinicId,
      locationId: input.locationId,
      documentVersion: input.documentVersion,
      documentHash,
      renderedText: input.renderedText,
      acceptedByLabel: input.acceptedBy.label.trim(),
      acceptedByUserId: input.acceptedBy.userId,
      stepUpId: input.acceptedBy.stepUp.stepUpId,
      passkeyId: input.acceptedBy.stepUp.passkeyId,
      deviceLabel: input.acceptedBy.stepUp.deviceLabel,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent?.slice(0, 512) ?? null,
    })
    .returning({
      id: locationAcknowledgements.id,
      documentHash: locationAcknowledgements.documentHash,
      acceptedAt: locationAcknowledgements.acceptedAt,
    });
  if (!row) throw new Error("The acknowledgement was not recorded.");
  tx.audit.record({
    action: "create",
    resourceType: "location_acknowledgement",
    resourceId: row.id,
    metadata: {
      locationId: input.locationId,
      documentVersion: input.documentVersion,
      passkeyId: input.acceptedBy.stepUp.passkeyId,
      stepUpId: input.acceptedBy.stepUp.stepUpId,
    },
  });
  return row;
}
