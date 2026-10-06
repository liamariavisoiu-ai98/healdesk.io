import type { Transaction } from "@/db";
import { log } from "@/lib/log";

/**
 * The calendar email to the clinic: O13 in Annex X5 of the funnel and portal
 * plan. A signature until M3, so the calendar session's backend is written
 * against it now.
 */

/**
 * Tell the clinic its calendar connection stopped working ("Bookings arrive
 * as requests until you reconnect"), or was reconnected after setup.
 * Connecting during setup sends nothing, so it is not called then.
 *
 * Called inside the caller's transaction, with the connections store's
 * convention of a `Transaction` and a clinic id (from a withTenant() block,
 * pass `tx.db`). In M3 it queues the notice in that same transaction, once
 * per `dedupeKey`, and the email goes after commit, so a state change that
 * rolls back sends nothing and a repeated event sends one email.
 *
 * Until M3 it records and sends nothing and writes one info line. It never
 * throws, so no calendar event fails because of its email.
 */
export async function notifyCalendarState(
  tx: Transaction,
  clinicId: string,
  state: "stopped" | "reconnected",
  opts: { dedupeKey: string },
): Promise<void> {
  void tx;
  void opts;
  try {
    log.info("calendar email not sent: O13 lands in M3", { clinicId, status: state });
  } catch {
    // Nothing reaches the caller; see above.
  }
}
