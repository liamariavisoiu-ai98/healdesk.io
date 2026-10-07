import { eq } from "drizzle-orm";

import { clinics, entitlements } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupLastDay } from "@/lib/clinic/setup-window";
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
 * THE SEAM. `startOffboarding` (lib/offboarding/offboarding.ts) makes the
 * call, right after app_start_offboarding() stamps the dates and inside its
 * transaction, with the reason it was given:
 *
 *     await queueSetupClosedEmail(tx, reason);
 *
 * and Package C's handler passes `setup_closure` (lib/billing/events.ts,
 * onSubscriptionDeleted). Any other reason queues nothing. The reason is
 * that handler's alone: the ops console's start-offboarding, whose reason is
 * free text an operator types, refuses it (lib/ops/api.ts), so no one can
 * tell a clinic its account has closed when nothing was cancelled, or use up
 * the dedupe the real closure needs. An operator closes an unfinished setup
 * through Billing's closeUnfinishedSetup, which cancels in Stripe.
 * tests/setup-wizard.test.ts drives it through startOffboarding and the ops
 * console, and tests/billing-events-lifecycle.test.ts through the deletion
 * event.
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
  // The window's last day, as the reminders named it (setupLastDay), or today
  // when the account was closed by hand without a deadline.
  const closedOn = row.deadline
    ? setupLastDay(row.deadline, row.timezone)
    : clinicLocalDate(now, row.timezone);
  return enqueuePlanNotice(tx.db, tx.clinicId, "setup_closed", "setup_closed", {
    closedOn,
    helpPhoneE164: helpContacts().phoneE164,
  });
}
