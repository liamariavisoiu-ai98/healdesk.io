import { and, isNotNull, isNull, lt } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  chatThreads,
  checkoutIntents,
  metaInboundMessages,
  stripeConnectStates,
} from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { JOB_BILLING_HOUSEKEEPING, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

/**
 * Daily purge of the short-lived rows the Stripe launch keeps (drizzle/0043).
 *
 *   - checkout intents that expired unconsumed: a buyer who never paid. Their
 *     name and work email have no reason to outlive the 14-day intent;
 *   - checkout intents consumed more than 90 days ago: the clinic, the
 *     organisation and the owner's user row now hold everything provisioning
 *     needed, and the intent is only kept that long so a late Stripe retry of
 *     the first invoice still finds it and answers with the replay;
 *   - Meta message refs older than 7 days: Meta redelivers for hours, not
 *     weeks, so a ref older than that dedupes nothing;
 *   - chat threads with no message for 30 days. A thread only decides
 *     whether a message starts a new conversation, after 24 hours of silence
 *     (lib/chat/threads.ts), and nothing reads its count. But it holds an
 *     HMAC of the sender's id (a WhatsApp number among them) made with a key
 *     we hold, so beside the clinic messaged and when, it identifies a
 *     patient, and must not outlive its use. Thirty days is far past the
 *     silence and past WhatsApp's seven days of redelivery, so a purge
 *     changes no count: the next message starts a new conversation, as it
 *     would have anyway;
 *   - Connect OAuth states older than a day: they expire in 15 minutes.
 *
 * sign_in_links are deliberately NOT purged: the runtime role has no DELETE
 * on them, so a redeemed link stays as the record of a sign-in. They expire.
 *
 * The identity-plane tables are deleted through unsafeDb (no tenant to scope
 * by). meta_inbound_messages and chat_threads FORCE row-level security, so
 * they are purged one clinic at a time inside that clinic's tenant (a
 * location's threads sit in its own); one clinic failing does not stop the
 * others, and is reported.
 *
 * Every cut-off comes from the pinned `now`, never the database clock, so a
 * test can drive it and a delayed run purges exactly what it would have.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const CONSUMED_INTENT_RETENTION_DAYS = 90;
export const META_MESSAGE_REF_RETENTION_DAYS = 7;
export const CHAT_THREAD_IDLE_RETENTION_DAYS = 30;
export const CONNECT_STATE_RETENTION_DAYS = 1;

export type HousekeepingResult = {
  expiredIntents: number;
  consumedIntents: number;
  metaMessageRefs: number;
  chatThreads: number;
  connectStates: number;
  clinicsFailed: number;
};

export async function purgeBillingHousekeeping(now: Date): Promise<HousekeepingResult> {
  const result: HousekeepingResult = {
    expiredIntents: 0,
    consumedIntents: 0,
    metaMessageRefs: 0,
    chatThreads: 0,
    connectStates: 0,
    clinicsFailed: 0,
  };

  const expired = await unsafeDb
    .delete(checkoutIntents)
    .where(and(isNull(checkoutIntents.consumedAt), lt(checkoutIntents.expiresAt, now)))
    .returning({ ref: checkoutIntents.ref });
  result.expiredIntents = expired.length;

  const consumed = await unsafeDb
    .delete(checkoutIntents)
    .where(
      and(
        isNotNull(checkoutIntents.consumedAt),
        lt(
          checkoutIntents.consumedAt,
          new Date(now.getTime() - CONSUMED_INTENT_RETENTION_DAYS * DAY_MS),
        ),
      ),
    )
    .returning({ ref: checkoutIntents.ref });
  result.consumedIntents = consumed.length;

  const states = await unsafeDb
    .delete(stripeConnectStates)
    .where(
      lt(
        stripeConnectStates.createdAt,
        new Date(now.getTime() - CONNECT_STATE_RETENTION_DAYS * DAY_MS),
      ),
    )
    .returning({ clinicId: stripeConnectStates.clinicId });
  result.connectStates = states.length;

  const metaCutoff = new Date(now.getTime() - META_MESSAGE_REF_RETENTION_DAYS * DAY_MS);
  const threadCutoff = new Date(now.getTime() - CHAT_THREAD_IDLE_RETENTION_DAYS * DAY_MS);
  const actor = { type: "service", serviceName: "billing-housekeeping" } as const;
  for (const clinic of await listClinics()) {
    try {
      const deleted = await withTenant({ clinicId: clinic.id, actor }, async (tx) => ({
        refs: await tx.db
          .delete(metaInboundMessages)
          .where(lt(metaInboundMessages.receivedAt, metaCutoff))
          .returning({ platform: metaInboundMessages.platform }),
        threads: await tx.db
          .delete(chatThreads)
          .where(lt(chatThreads.lastInboundAt, threadCutoff))
          .returning({ channel: chatThreads.channel }),
      }));
      result.metaMessageRefs += deleted.refs.length;
      result.chatThreads += deleted.threads.length;
    } catch (error) {
      result.clinicsFailed += 1;
      log.error("billing housekeeping failed for a clinic", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }

  log.info("billing housekeeping", {
    count: result.expiredIntents + result.consumedIntents,
    deleted: result.metaMessageRefs + result.chatThreads + result.connectStates,
    failures: result.clinicsFailed,
  });
  return result;
}

export async function runBillingHousekeepingJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_BILLING_HOUSEKEEPING,
    async () => {
      const r = await purgeBillingHousekeeping(now);
      const note =
        `Purged ${r.expiredIntents} expired and ${r.consumedIntents} consumed checkout intents, ` +
        `${r.metaMessageRefs} Meta message refs, ${r.chatThreads} idle chat threads, ` +
        `${r.connectStates} Connect states`;
      // A clinic that could not be purged shows red on the console rather
      // than hiding inside an "ok" (map_email-jobs §17 item 10).
      if (r.clinicsFailed > 0) throw new Error(`${note}; ${r.clinicsFailed} clinics failed.`);
      return `${note}.`;
    },
    now,
  );
}
