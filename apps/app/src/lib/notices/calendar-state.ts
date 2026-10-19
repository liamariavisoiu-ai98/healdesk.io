import { eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinics } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { sectionPath } from "@/lib/portal/nav";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { helpContacts } from "@/lib/setup/help";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * The calendar email to the clinic: O13 in Annex X5 of the funnel and portal
 * plan, queued since M3.
 *
 * Tell the clinic its calendar connection stopped working ("Bookings arrive
 * as requests until you reconnect"), or was reconnected after setup.
 * Connecting during setup sends nothing, so it is not called then.
 *
 * Both link to Settings → Calendar, never the wizard's calendar step: a
 * connect started from the wizard returns to it as a setup connect, which
 * sends no "reconnected" (lib/connections/google-oauth.ts), so a clinic
 * that followed a "stopped" email there after setup would never hear that
 * it worked. Settings' reconnect returns to the portal, which sends it.
 *
 * Called inside the caller's transaction, with the connections store's
 * convention of a `Transaction` and a clinic id (from a withTenant() block,
 * pass `tx.db`). It queues the notice in that same transaction, once per
 * `dedupeKey`, and the email goes after commit, so a state change that rolls
 * back sends nothing and a repeated event sends one email.
 *
 * It never throws, and it never breaks the caller's transaction: the insert
 * runs inside a savepoint, so a failure here rolls back only itself and the
 * calendar event it reports on is still recorded.
 */
export async function notifyCalendarState(
  tx: Transaction,
  clinicId: string,
  state: "stopped" | "reconnected",
  opts: { dedupeKey: string },
): Promise<void> {
  try {
    if (publicOriginProblem()) {
      log.error("calendar email not queued: no public origin", { clinicId, status: state });
      return;
    }
    await tx.transaction(async (savepoint) => {
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, clinicId))
        .limit(1);
      if (!clinic) return;
      await enqueuePlanNotice(
        savepoint,
        clinicId,
        state === "stopped" ? "calendar_stopped" : "calendar_reconnected",
        opts.dedupeKey,
        {
          changedAt: new Date().toISOString(),
          calendarUrl: publicUrl(calendarSettingsPath(clinic.slug)),
          helpPhoneE164: helpContacts().phoneE164,
        },
      );
    });
  } catch (error) {
    try {
      log.error("calendar email not queued", {
        clinicId,
        status: state,
        error: describeError(error),
      });
    } catch {
      // Nothing reaches the caller; see above.
    }
  }
}

/** Settings → Calendar, where a reconnect returns to the portal and so tells the clinic it worked. */
export function calendarSettingsPath(slug: string): string {
  return `${sectionPath(slug, "settings")}#calendar`;
}
