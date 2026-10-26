import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { SendEmailOptions } from "@/lib/email/send";
import { describeError, log } from "@/lib/log";
import { retrySupportReplies, sweepSentReplyText } from "@/lib/support/send";
import { runUnmatchedEmailRetention } from "@/lib/support/inbound/retention";

import { getJob, JOB_SUPPORT_SEND, runSwitchedJob, type JobOutcome } from "./jobs";

/**
 * The support reply's retries and its retention (ops automation Phase 7, lane
 * P7e; design E5 §2.2-§2.3).
 *
 * `support-send`, every minute from its own `support-send` queue and hourly
 * from the tick as its backstop, behind the job row's switch, which ships
 * off (drizzle/0127): every approved reply whose next try is due is tried
 * once (`retrySupportReplies`, lib/support/send.ts: one try at approval,
 * then after 1, 5, 30, 120 and 360 minutes, the email outbox's schedule,
 * dead after six with `support_reply_dead`). It never sends anything the
 * owner did not approve: it only retries the frozen text of a reply whose
 * approval already went through the fresh-code wrapper. Each reply is
 * leased on its own row, so two fires never send one reply twice, and the
 * idempotency key is the same on every try. It runs without runJob's lock
 * (runSwitchedJob), as the email outbox does.
 *
 * `runSupportRetention`, nightly from the tick at 03 UTC, unswitched because
 * it only deletes (like the redial sweep): the text of every reply sent more
 * than 12 months ago, and the reply's copy in its approval item
 * (`ops_approvals.draft`, support_reply_send only, through the database's
 * own app_forget_support_reply_drafts()), so the prose of a reply that WENT is
 * kept 12 months in both places and no longer. The rows stay, without the
 * words, with their hashes and every approval event. The text of an approved
 * reply that never went (stopped dead, case closed, clinic left) is swept on
 * the same rule, 12 months from the stop (0129, lane P7f); its approval item's
 * copy goes 12 months from the decision, as for any reply.
 *
 * Neither throws into the queue: a failure is the job's note.
 */

export { JOB_SUPPORT_SEND };

export async function runSupportSendJob(input: { now?: Date; send?: SendEmailOptions } = {}): Promise<JobOutcome> {
  const now = input.now ?? new Date();
  try {
    if (!(await getJob(JOB_SUPPORT_SEND))) {
      log.warn("support-send: no job row yet; nothing tried", { job: JOB_SUPPORT_SEND });
      return { status: "disabled" };
    }
    return await runSwitchedJob(
      JOB_SUPPORT_SEND,
      async () => {
        const counts = await retrySupportReplies(now, input.send ?? {});
        return `${counts.sent} sent, ${counts.retrying} to try again, ${counts.stopped} stopped`;
      },
      now,
    );
  } catch (error) {
    log.error("support-send: the run failed", { job: JOB_SUPPORT_SEND, error: describeError(error) });
    return { status: "failed", note: error instanceof Error ? error.name : "unknown" };
  }
}

/** How many approval items' copies of a reply the database forgot: the 12-month rule, by its own clock. */
export async function forgetSupportReplyDrafts(now: Date): Promise<number> {
  const result = await unsafeDb.execute<{ n: number | string }>(
    sql`select app_forget_support_reply_drafts(${now.toISOString()}::timestamptz) as n`,
  );
  return Number((result as unknown as { rows: { n: number | string }[] }).rows[0]?.n ?? 0);
}

/** The nightly retention step: both copies of every reply's words past 12 months. Never throws. */
export async function runSupportRetention(now: Date): Promise<{ status: "ok" | "failed"; note: string }> {
  try {
    const texts = await sweepSentReplyText(now);
    const drafts = await forgetSupportReplyDrafts(now);
    const emails = await runUnmatchedEmailRetention(now); // Lane P7g: email cases about no clinic (never throws).
    return {
      status: "ok",
      note: `${texts} sent replies' text deleted, ${drafts} approval copies deleted, ${emails.closed} idle email cases about no clinic closed, ${emails.deleted} deleted`,
    };
  } catch (error) {
    log.error("support retention failed", { error: describeError(error) });
    return { status: "failed", note: error instanceof Error ? error.name : "unknown" };
  }
}
