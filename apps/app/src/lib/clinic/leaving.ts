import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Whether the tenant's clinic has left: its offboarding has started (its
 * service ended) or its data has been destroyed.
 *
 * Nothing new about a patient is stored for a clinic that has left (the C19
 * audit's edge row; BAA 1.3.0 clause 17: after termination healdesk uses and
 * discloses PHI only to return or destroy it). A vendor's late webhook is
 * answered 200, so it is not retried for ever, and nothing it carried is
 * kept: the voice webhook stores no raw body and ingests no call, and the
 * Meta webhook claims no message and opens no thread. The destruction job
 * never revisits a destroyed clinic, so a row written after it would outlive
 * every promise to destroy it. Read inside the transaction that would write,
 * so an offboarding that starts meanwhile is seen.
 */
export async function clinicHasLeft(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ started: clinics.offboardingStartedAt, destroyed: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row !== undefined && (row.started !== null || row.destroyed !== null);
}
