import { describeError, log } from "@/lib/log";
import { getJob, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";

import { inboundMailBucket, INBOUND_PREFIX, isInboundKey } from "./config";
import { handleInboundNotice, type HandleDeps } from "./handle";
import type { InboundNotice } from "./notice";
import { s3MailStore, type MailStore } from "./store";

/**
 * The hourly support-inbound-sweep job (lane P7g; design E5 §2.3), seeded
 * OFF by drizzle/0129 and switched on by the owner at System > Jobs.
 *
 * The webhook handles each email within seconds of SES's notice and deletes
 * its object. What it could not (a database blip that outlasted SNS's
 * retries, a notice SNS gave up on, a subscription not made yet) stays in
 * the bucket under mail/. Each hour this reads what is there:
 *
 *   - an object younger than a day is handled exactly as the webhook would
 *     (handleInboundNotice, idempotent by SES's id, which is the object's
 *     key after the prefix), so an email the webhook already recorded is
 *     only deleted;
 *   - an object older than a day is deleted unread (the bucket's lifecycle
 *     does the same; this makes it hourly, not "by the next midnight").
 *
 * SES's verdicts are in the notice, not the object, so a swept message is
 * read with them UNKNOWN: it is never dropped as spam it was not, and it
 * gets an acknowledgement only if every other rule allows (DKIM "unknown"
 * is not "failed"). The note counts what happened; nothing names a message.
 */

export const JOB_SUPPORT_INBOUND_SWEEP = "support-inbound-sweep";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Objects per run: an hour's mail, many times over. */
export const SWEEP_LIMIT = 200;

export type SweepCounts = { handled: number; already: number; dropped: number; deletedOld: number; left: number; failed: number };

export async function sweepInboundMail(deps: HandleDeps & { store?: MailStore; now?: Date } = {}): Promise<SweepCounts> {
  const counts: SweepCounts = { handled: 0, already: 0, dropped: 0, deletedOld: 0, left: 0, failed: 0 };
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
    if (now.getTime() - object.lastModified.getTime() > DAY_MS) {
      try {
        await store.delete(bucket, object.key);
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
        return `${c.handled} handled, ${c.already} already recorded, ${c.dropped} dropped, ${c.deletedOld} older than a day deleted, ${c.left} left, ${c.failed} failed`;
      },
      now,
    );
  } catch (error) {
    log.error("support-inbound-sweep: the run failed", { job: JOB_SUPPORT_INBOUND_SWEEP, error: describeError(error) });
    return { status: "failed", note: error instanceof Error ? error.name : "unknown" };
  }
}
