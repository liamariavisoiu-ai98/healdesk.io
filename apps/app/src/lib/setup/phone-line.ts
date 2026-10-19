import { isCarrier } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { TenantTx } from "@/lib/tenant";

import { isPhoneSystem } from "./forwarding-steps";

/**
 * The forwarding screen's pickers, saved as the clinic picks (wizard step 4
 * and Settings → Channels): what runs the main line
 * (clinics.phone_system_type) and, on a phone company's line, who provides
 * it (clinics.carrier). Saved, so the steps emailed on to the office manager
 * (O11) and the undo steps in Safety net are the ones on the screen; before
 * this the carrier picker changed only what the browser showed, and the
 * phone system could be set only by an operator.
 *
 * Business data about the clinic's own line. No step-up: it moves no calls.
 */

export type PhoneLineResult = { ok: true } | { ok: false; message: string };

export async function savePhoneLine(
  tx: TenantTx,
  input: { phoneSystem: unknown; carrier: unknown },
): Promise<PhoneLineResult> {
  if (!isPhoneSystem(input.phoneSystem)) {
    return { ok: false, message: "Choose what runs your main line." };
  }
  if (input.carrier !== undefined && input.carrier !== null && !isCarrier(input.carrier)) {
    return { ok: false, message: "Choose who provides your main line." };
  }
  const [clinic] = await tx.db
    .select({ offboardingStartedAt: clinics.offboardingStartedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || clinic.offboardingStartedAt) {
    return { ok: false, message: "This account has closed, so nothing can be changed." };
  }
  // A cloud phone system's steps read no carrier, so the one named stays.
  await setPhoneSettings(tx, {
    phoneSystemType: input.phoneSystem,
    ...(isCarrier(input.carrier) ? { carrier: input.carrier } : {}),
  });
  return { ok: true };
}
