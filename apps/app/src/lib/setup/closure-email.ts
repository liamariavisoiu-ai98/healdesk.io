import { eq } from "drizzle-orm";

import { clinics, entitlements } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import type { TenantTx } from "@/lib/tenant";

import { helpContacts } from "./help";

/**
 * The day-30 closure email, keyed on the offboarding reason (contracts §2).
 *
 * Package C closes an account whose 30-day setup window ended with nothing
 * live: its worker cancels the subscription with the comment
 * `hd_setup_closure`, and its `customer.subscription.deleted` handler starts
 * offboarding with the reason `setup_closure` instead of sending its own
 * `canceled` email. This queues the plan's closure email in that same
 * transaction, so a closure that rolls back sends nothing and a redelivered
 * event sends one email (dedupe `setup_closed`, once per clinic).
 *
 * THE SEAM. Neither `startOffboarding` (lib/offboarding/offboarding.ts, being
 * changed in parallel) nor Package C's handler is this build's to edit, and
 * the `"setup_closure"` call is not on main yet. One line in
 * `startOffboarding`, after its update and inside its transaction, connects
 * them:
 *
 *     await queueSetupClosedEmail(tx, reason);
 *
 * Any other reason queues nothing, so the line is safe for every caller of
 * startOffboarding, the ops console's included.
 */

export const SETUP_CLOSURE_REASON = "setup_closure";

export async function queueSetupClosedEmail(
  tx: TenantTx,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (reason !== SETUP_CLOSURE_REASON) return false;
  const [row] = await tx.db
    .select({ timezone: clinics.timezone, deadline: entitlements.setupDeadlineAt })
    .from(clinics)
    .leftJoin(entitlements, eq(entitlements.clinicId, clinics.id))
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!row) return false;
  // The window's last day: the deadline's own date, or today when the account
  // was closed by hand without one.
  const closedOn = clinicLocalDate(row.deadline ?? now, row.timezone);
  return enqueuePlanNotice(tx.db, tx.clinicId, "setup_closed", "setup_closed", {
    closedOn,
    helpPhoneE164: helpContacts().phoneE164,
  });
}
