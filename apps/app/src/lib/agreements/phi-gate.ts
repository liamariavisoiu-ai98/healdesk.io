import { sql } from "drizzle-orm";

import type { Queryable } from "@/db";

/**
 * May a new patient row be written for this clinic? The database's own
 * answer, app_clinic_accepts_phi() (drizzle/0051, 0066), asked the one way
 * every fallback asks it before it would write: a synthetic clinic, or a
 * production one with an agreement in effect that covers it (its kind
 * sufficient for its regime and covered-entity answer) and no offboarding
 * started.
 *
 * The trigger app_enforce_baa_gate refuses the write anyway. Asking first is
 * for the paths that keep what a person leaves while AYA is not answering
 * (the website's contact form, a Meta message), so a practice whose re-sign
 * to the BAA is unsigned, or whose agreement no longer covers it, is told
 * "call the practice" or left to its team, instead of erroring and having
 * the write retried. Not a second definition: the function is the rule, and
 * healdesk-io-58's `agreementCovers` (lib/billing/answering.ts) asks the same.
 *
 * SECURITY DEFINER, so it answers inside or outside a tenant.
 */
export async function clinicAcceptsPhi(db: Queryable, clinicId: string): Promise<boolean> {
  const result = await db.execute<{ ok: boolean }>(
    sql`select app_clinic_accepts_phi(${clinicId}::uuid) as ok`,
  );
  return result.rows[0]?.ok === true;
}
