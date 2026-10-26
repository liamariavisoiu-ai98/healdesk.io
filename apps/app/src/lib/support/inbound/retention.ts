import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportCases } from "@/db/schema";
import { describeError, log } from "@/lib/log";

import { closeSupportCase } from "../cases";

/**
 * How long an email case about NO clinic is kept (lane P7g, review of 26
 * October 2026): a prospect's question, a stranger's mail, a closed
 * account's, an unauthenticated sender's. A case about a clinic goes with the
 * clinic at its destruction (app_destroy_support_cases); one about no clinic
 * has no clinic to go with, so it has its own clock:
 *
 *   - open, with nothing on it for 30 days (no email in, no reply out, no
 *     move by ops): closed, silently, as `no_further_reply`. No mail to
 *     anyone, no alert: closing is all it does;
 *   - closed for 30 days: deleted with its messages, by the database's own
 *     app_delete_unmatched_email_cases() (0129), which the runtime role may
 *     call but cannot widen (it has no DELETE on either table).
 *
 * Only cases that came by email and name no clinic: a chat case always
 * names one, and a case ops matched to a clinic is that clinic's.
 *
 * Nightly, from the support retention step (lib/scheduler/support-send.ts).
 * Never throws: a failure is logged, and the rest of the retention runs.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const UNMATCHED_EMAIL_IDLE_DAYS = 30;
export const UNMATCHED_EMAIL_KEEP_CLOSED_DAYS = 30;
/** Cases closed per night at most; the rest are closed the next night. */
const CLOSE_LIMIT = 500;

export type UnmatchedRetention = { closed: number; deleted: number };

export async function runUnmatchedEmailRetention(now: Date): Promise<UnmatchedRetention> {
  const out: UnmatchedRetention = { closed: 0, deleted: 0 };
  try {
    const idleSince = new Date(now.getTime() - UNMATCHED_EMAIL_IDLE_DAYS * DAY_MS);
    const stale = await unsafeDb
      .select({ id: supportCases.id })
      .from(supportCases)
      .where(
        and(
          eq(supportCases.source, "email"),
          isNull(supportCases.subjectClinicId),
          ne(supportCases.state, "closed"),
          sql`greatest(${supportCases.openedAt}, ${supportCases.updatedAt}, ${supportCases.lastInboundAt},
                coalesce(${supportCases.lastOutboundAt}, ${supportCases.openedAt})) < ${idleSince}`,
        ),
      )
      .limit(CLOSE_LIMIT);
    for (const c of stale) {
      const moved = await closeSupportCase(c.id, "no_further_reply", now);
      if (moved.outcome === "done") out.closed += 1;
    }
    const result = await unsafeDb.execute<{ n: number | string }>(
      sql`select app_delete_unmatched_email_cases(${now.toISOString()}::timestamptz) as n`,
    );
    out.deleted = Number((result as unknown as { rows: { n: number | string }[] }).rows[0]?.n ?? 0);
    log.info("support retention: email cases about no clinic", { count: out.closed, outcome: "closed" });
    log.info("support retention: email cases about no clinic", { count: out.deleted, outcome: "deleted" });
  } catch (error) {
    log.error("support retention: email cases about no clinic failed", { error: describeError(error) });
  }
  return out;
}
