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
 * FOR SHARE: app_start_offboarding updates this row, so it waits for the
 * write this read guards to commit, or this read waits for it and sees the
 * offboarding (the branch review's R11). For a production clinic the
 * database refuses the new row anyway (app_clinic_accepts_phi).
 */
export async function clinicHasLeft(
  tx: TenantTx,
  options: { lock?: boolean } = {},
): Promise<boolean> {
  const query = tx.db
    .select({ started: clinics.offboardingStartedAt, destroyed: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  // `lock: false` reads without holding the row: for a check made before
  // something slow (the Meta front door's model call), which takes the lock
  // again, right before it writes. A lock held across the slow part would
  // make every portal save and app_start_offboarding's FOR UPDATE wait for it.
  const [row] = options.lock === false ? await query : await query.for("share");
  return row !== undefined && (row.started !== null || row.destroyed !== null);
}
