import { eq } from "drizzle-orm";

import { isCarrier, type CallRouting, type Carrier, type PhoneSystemType } from "@healdesk/catalog";

import { clinics } from "@/db/schema";
import { keepCoverageModeInStep } from "@/lib/setup/settings";
import type { TenantTx } from "@/lib/tenant";

import { completeStep } from "./steps";

/**
 * The phone facts an onboarding call establishes: line type, carrier, the
 * routing mode, and the assistant's number the clinic forwards to. Each one
 * stamps its onboarding step. Routing is the one that changes the meaning of
 * the revenue report, so it is confirmed explicitly rather than inherited
 * from the column default.
 */
export type PhoneSettings = {
  phoneSystemType?: PhoneSystemType;
  carrier?: Carrier | null;
  callRouting?: CallRouting;
  assistantNumberE164?: string | null;
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
    // clinic_settings.coverage_mode is the single source of which calls
    // reach AYA (0056): the wizard shows it back and its forwarding codes
    // follow it, and Package B's coverageModeOf moves onto it. An operator's
    // routing answer moves it in this same transaction, or the two columns
    // would disagree for good.
    await keepCoverageModeInStep(tx, input.callRouting, now);
  }
  if (input.assistantNumberE164 !== undefined) {
    if (input.assistantNumberE164 !== null && !/^\+[1-9]\d{6,14}$/.test(input.assistantNumberE164)) {
      throw new Error("The assistant's number must be E.164.");
    }
    set.assistantNumberE164 = input.assistantNumberE164;
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
      assistantNumberSet: input.assistantNumberE164 !== undefined,
      publishedNumberSet: input.publishedPhoneE164 !== undefined,
    },
  });
  if (input.phoneSystemType && input.phoneSystemType !== "unknown") {
    await completeStep(tx, "phone_type_confirmed", { at: now });
  }
  if (input.callRouting) await completeStep(tx, "call_routing_chosen", { at: now });
}
