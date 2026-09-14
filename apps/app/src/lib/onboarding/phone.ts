import { eq } from "drizzle-orm";

import { isCarrier, type CallRouting, type Carrier, type PhoneSystemType } from "@healdesk/catalog";

import { clinics } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { completeStep } from "./steps";

/**
 * The phone facts an onboarding call establishes: line type, carrier, the
 * routing mode, and the Synthflow number the clinic forwards to. Each one
 * stamps its onboarding step. Routing is the one that changes the meaning of
 * the revenue report, so it is confirmed explicitly rather than inherited
 * from the column default.
 */
export type PhoneSettings = {
  phoneSystemType?: PhoneSystemType;
  carrier?: Carrier | null;
  callRouting?: CallRouting;
  synthflowNumberE164?: string | null;
  /** The clinic's own published number; the forwarding test needs it. */
  publishedPhoneE164?: string | null;
};

export async function setPhoneSettings(tx: TenantTx, input: PhoneSettings): Promise<void> {
  const now = new Date();
  const set: Partial<typeof clinics.$inferInsert> = { updatedAt: now };
  if (input.phoneSystemType) set.phoneSystemType = input.phoneSystemType;
  if (input.carrier !== undefined) {
    if (input.carrier !== null && !isCarrier(input.carrier)) throw new Error("Unknown carrier.");
    set.carrier = input.carrier;
  }
  if (input.callRouting) {
    set.callRouting = input.callRouting;
    set.callRoutingConfirmedAt = now;
  }
  if (input.synthflowNumberE164 !== undefined) {
    if (input.synthflowNumberE164 !== null && !/^\+[1-9]\d{6,14}$/.test(input.synthflowNumberE164)) {
      throw new Error("The Synthflow number must be E.164.");
    }
    set.synthflowNumberE164 = input.synthflowNumberE164;
  }
  if (input.publishedPhoneE164 !== undefined) {
    if (input.publishedPhoneE164 !== null && !/^\+[1-9]\d{6,14}$/.test(input.publishedPhoneE164)) {
      throw new Error("The clinic's published number must be E.164.");
    }
    set.publishedPhoneE164 = input.publishedPhoneE164;
  }
  await tx.db.update(clinics).set(set).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({
    action: "update",
    resourceType: "clinic_phone",
    resourceId: tx.clinicId,
    metadata: {
      phoneSystemType: input.phoneSystemType,
      carrier: input.carrier ?? undefined,
      callRouting: input.callRouting,
      synthflowNumberSet: input.synthflowNumberE164 !== undefined,
      publishedNumberSet: input.publishedPhoneE164 !== undefined,
    },
  });
  if (input.phoneSystemType && input.phoneSystemType !== "unknown") {
    await completeStep(tx, "phone_type_confirmed", { at: now });
  }
  if (input.callRouting) await completeStep(tx, "call_routing_chosen", { at: now });
}
