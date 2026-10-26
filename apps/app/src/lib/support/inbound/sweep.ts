import { describeError, log } from "@/lib/log";
import { getJob, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";

import { and, isNotNull, lt, eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportMessages } from "@/db/schema";

import { inboundMailBucket, INBOUND_PREFIX, isInboundKey, KEEP_FOR_DRAFTER_MS } from "./config";
import { handleInboundNotice, type HandleDeps } from "./handle";
import type { InboundNotice } from "./notice";
import { s3MailStore, type MailStore } from "./store";

/**
 * The hourly support-inbound-sweep job (lane P7g; design E5 §2.3), seeded
 * OFF by drizzle/0130 and switched on by the owner at System > Jobs.
 *
 * The webhook handles each email within seconds of SES's notice and deletes
 * its object. What it could not (a database blip that outlasted SNS's
 * retries, a notice SNS gave up on, a subscription not made yet) stays in
 * the bucket under mail/. Each hour this reads what is there:
 *
 *   - an object younger than KEEP_FOR_DRAFTER_MS (six hours) is handled
 *     exactly as the webhook would (handleInboundNotice, idempotent by SES's
 *     id, which is the object's key after the prefix), so an email the
 *     webhook already recorded is only deleted, unless its row says it
 *     still waits for the drafter (lane P7h), when it is left alone;
 *   - an object older than that is deleted unread, kept for the drafter or
 *     not, and any row naming it has its key cleared. The bucket's one-day
 *     lifecycle rule is only the backstop behind this: S3 applies it
 *     asynchronously, up to about two days after an object is written.
 *   - and every row still naming an object after six hours (one the
 *     lifecycle rule took first, or a delete that failed) has its object
 *     deleted again (a delete of nothing is not an error) and its key
 *     cleared, so no row ever says a message is waiting that is not.
 *
 * A swept message has no notice, so its verdicts are read from the headers
 * SES wrote at the top of the message (auth.ts: X-SES-Spam-Verdict,
 * X-SES-Virus-Verdict and SES's own Authentication-Results, never one a
 * sender wrote below them): spam and viruses are dropped as the webhook
 * would drop them, and the sender is matched to a clinic, joined to a
 * clinic's case or acknowledged only on an aligned DKIM or DMARC pass. The
 * note counts what happened; nothing names a message.
 */

export const JOB_SUPPORT_INBOUND_SWEEP = "support-inbound-sweep";

/** Objects per run: an hour's mail, many times over. */
export const SWEEP_LIMIT = 200;

export type SweepCounts = {
  handled: number;
  already: number;
  dropped: number;
  deletedOld: number;
  left: number;
  failed: number;
  /** Rows whose waiting object was deleted and key cleared (lane P7h). */
  cleared: number;
};

/** Clear the key of the row naming this object, once the object is gone. */
export async function clearObjectKey(key: string): Promise<void> {
  await unsafeDb.update(supportMessages).set({ inboundObjectKey: null }).where(eq(supportMessages.inboundObjectKey, key));
}

export async function sweepInboundMail(deps: HandleDeps & { store?: MailStore; now?: Date } = {}): Promise<SweepCounts> {
  const counts: SweepCounts = { handled: 0, already: 0, dropped: 0, deletedOld: 0, left: 0, failed: 0, cleared: 0 };
  const bucket = inboundMailBucket();
  if (!bucket) return counts;
  const store = deps.store ?? s3MailStore;
  const now = deps.now ?? new Date();
  const objects = await store.list(bucket, INBOUND_PREFIX, SWEEP_LIMIT);
  for (const object of objects) {
    if (!isInboundKey(object.key)) {
      counts.left += 1;
      continue;
    }
    if (now.getTime() - object.lastModified.getTime() > KEEP_FOR_DRAFTER_MS) {
      try {
        await store.delete(bucket, object.key);
        await clearObjectKey(object.key);
        counts.deletedOld += 1;
      } catch (error) {
        counts.failed += 1;
        log.warn("support inbound sweep: old object not deleted", { error: describeError(error) });
      }
      continue;
    }
    const notice: InboundNotice = {
      sesMessageId: object.key.slice(INBOUND_PREFIX.length),
      bucket,
      key: object.key,
      receivedAt: object.lastModified,
      verdicts: { spam: "UNKNOWN", virus: "UNKNOWN", spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" },
    };
    try {
      const outcome = await handleInboundNotice(notice, { ...deps, store, now });
      if (outcome.outcome === "recorded") counts.handled += 1;
      else if (outcome.outcome === "already_recorded") counts.already += 1;
      else if (outcome.outcome === "dropped") counts.dropped += 1;
      else counts.left += 1;
    } catch (error) {
      counts.failed += 1;
      log.warn("support inbound sweep: a message was not handled", { eventId: notice.sesMessageId, error: describeError(error) });
    }
  }
  // Rows still naming an object past the window: delete it (again) and clear the key.
  const stale = await unsafeDb
    .select({ key: supportMessages.inboundObjectKey })
    .from(supportMessages)
    .where(and(isNotNull(supportMessages.inboundObjectKey), lt(supportMessages.receivedAt, new Date(now.getTime() - KEEP_FOR_DRAFTER_MS))))
    .limit(SWEEP_LIMIT);
  for (const row of stale) {
    if (!row.key || !isInboundKey(row.key)) continue;
    try {
      await store.delete(bucket, row.key);
      await clearObjectKey(row.key);
      counts.cleared += 1;
    } catch (error) {
      counts.failed += 1;
      log.warn("support inbound sweep: a waiting object was not deleted", { error: describeError(error) });
    }
  }
  return counts;
}

/** The job, behind its switch. Never throws: a failure is the job's note. */
export async function runSupportInboundSweepJob(deps: HandleDeps & { store?: MailStore; now?: Date } = {}): Promise<JobOutcome> {
  const now = deps.now ?? new Date();
  try {
    if (!(await getJob(JOB_SUPPORT_INBOUND_SWEEP))) {
      log.warn("support-inbound-sweep: no job row yet; nothing read", { job: JOB_SUPPORT_INBOUND_SWEEP });
      return { status: "disabled" };
    }
    return await runSwitchedJob(
      JOB_SUPPORT_INBOUND_SWEEP,
      async () => {
        const c = await sweepInboundMail({ ...deps, now });
        return `${c.handled} handled, ${c.already} already recorded, ${c.dropped} dropped, ${c.deletedOld} older than six hours deleted, ${c.cleared} left waiting for the drafter deleted, ${c.left} left, ${c.failed} failed`;
      },
      now,
    );
  } catch (error) {
    log.error("support-inbound-sweep: the run failed", { job: JOB_SUPPORT_INBOUND_SWEEP, error: describeError(error) });
    return { status: "failed", note: error instanceof Error ? error.name : "unknown" };
  }
}
