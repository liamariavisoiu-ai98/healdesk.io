import { eq } from "drizzle-orm";

import { unsafeDb, type Queryable, type Transaction } from "@/db";
import { scheduledJobs } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem } from "@/lib/public-url";
import { JOB_BILLING_NOTICES } from "@/lib/scheduler/jobs";

/**
 * Whether an urgent alert (L12) queued now reaches the clinic: the fixed
 * urgent reply says "I've told the team" (@healdesk/catalog,
 * fixedUrgentReply), and the wizard "tells your team at once", only while it
 * does, so neither promises an alert nobody sends.
 *
 * Three things, all read at the moment of asking:
 *
 *   - the outbox's sender is switched on: the `billing-notices` job row,
 *     seeded off (drizzle/0043) and turned on by an operator, is the one
 *     switch for every outbox email (lib/email/outbox.ts);
 *   - this deployment sends through Resend, with a key and a sender address
 *     (lib/email/send.ts, platformTransport): the console stub that stands in
 *     elsewhere sends nothing;
 *   - a link into the portal can be built (BETTER_AUTH_URL).
 *
 * The adapter then decides per message: a reply says the team was told only
 * when this is true AND notifyBookingAlert queued that conversation's alert.
 * Never throws: a question it cannot answer is a no. Inside a transaction,
 * pass it (the facts readers do): the read runs in a savepoint there, so a
 * failure rolls back only itself and never the caller's work.
 *
 * Its own module, not booking-alerts.ts, because the tests of the booking
 * engine and of deposits replace that module wholesale.
 */
export async function urgentAlertLive(tx?: Transaction): Promise<boolean> {
  try {
    if (publicOriginProblem()) return false;
    if (process.env.HEALDESK_EMAIL_TRANSPORT !== "resend") return false;
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.HEALDESK_EMAIL_FROM?.trim()) return false;
    const read = async (db: Queryable) =>
      (
        await db
          .select({ enabled: scheduledJobs.enabled })
          .from(scheduledJobs)
          .where(eq(scheduledJobs.name, JOB_BILLING_NOTICES))
          .limit(1)
      )[0];
    const job = tx ? await tx.transaction((savepoint) => read(savepoint)) : await read(unsafeDb);
    return job?.enabled === true;
  } catch (error) {
    try {
      log.error("urgent alert state not read", { error: describeError(error) });
    } catch {
      // A no, as above.
    }
    return false;
  }
}
