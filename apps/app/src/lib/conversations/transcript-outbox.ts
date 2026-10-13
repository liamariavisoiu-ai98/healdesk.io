import { randomUUID } from "node:crypto";

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, transcriptEmails } from "@/db/schema";
import { billingRecipients } from "@/lib/billing/recipients";
import { open, seal, type SealedPayload } from "@/lib/crypto/envelope";
import { clinicLockLabel } from "@/lib/crypto/kms";
import { describeError, log, scrub } from "@/lib/log";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { getJob, JOB_TRANSCRIPT_EMAILS, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";
import type { ActorContext } from "@/lib/audit";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  archiveCopyAddress,
  renderTranscriptEmail,
  sendTranscriptEmail,
  type TranscriptChannel,
  type TranscriptTurn,
} from "./transcript-email";

/**
 * The transcript outbox: how an emailed transcript survives a failed send.
 *
 * The owner's decisions of 13 October 2026: a conversation's transcript is
 * emailed to the clinic when it ends, healdesk keeps no transcript, and a
 * send that fails must still reach the clinic. So the transcript waits here,
 * sealed under the KMS key, until SES has accepted it, and seven days after,
 * and is then deleted (drizzle/0069 holds the seven days on the database's
 * clock, whatever this code does).
 *
 *   queue    the voice endpoint and the chat API, inside the conversation's
 *            tenant transaction: queueTranscriptEmail(). Then, after commit,
 *            sendQueuedTranscriptNow() so the clinic has it in seconds.
 *   send     claim the row (a two-minute lease and an attempt, in one
 *            conditional UPDATE, so two workers never send it twice), open
 *            the copy outside any transaction, send through SES to the
 *            clinic's address, record what SES said.
 *   retry    a failed send waits 1, 2, 5, 10 and 30 minutes, then an hour
 *            between tries, until the copy's seven days are up. Ops hears on
 *            the third failure (once), and again if a copy is deleted unsent.
 *   bounce   SES's events (api/webhooks/ses): a delivery is recorded; a
 *            bounce, a rejection or a complaint marks it bounced, which the
 *            job sends again an hour later, and tells ops once.
 *   delete   the job deletes every row past its destroy_after, sent or not.
 *
 * Nothing here logs or alerts with anything but ids, statuses and SES's own
 * reason, scrubbed.
 */

/** The lock label's login for a sealed transcript: a fixed word (lib/crypto/kms.ts). */
export const TRANSCRIPT_LOCK_LOGIN = "transcript";

/** How long one send may take before another worker may try the row. */
const LEASE_MS = 2 * 60 * 1000;

/** Minutes to wait after the nth failed send (1-based), then RETRY_EVERY_MINUTES. */
const RETRY_AFTER_MINUTES = [1, 2, 5, 10, 30] as const;
const RETRY_EVERY_MINUTES = 60;
/** A bounce is sent again after this long: the address has to change first. */
const BOUNCE_RETRY_MINUTES = 60;
/** Ops hears once a transcript has failed this many times. */
const ALERT_AFTER_FAILURES = 3;

/** What the sealed copy holds. The clinic's name and zone are read at each send. */
type SealedTranscript = {
  channel: TranscriptChannel;
  startedAt: string;
  turns: TranscriptTurn[];
};

export type QueueTranscriptInput = {
  conversationId: string;
  channel: TranscriptChannel;
  startedAt: Date;
  turns: readonly TranscriptTurn[];
};

/** Minutes until the next try after `failures` failed sends. */
export function retryDelayMinutes(failures: number): number {
  if (failures < 1) return RETRY_AFTER_MINUTES[0];
  return RETRY_AFTER_MINUTES[failures - 1] ?? RETRY_EVERY_MINUTES;
}

function label(clientNumber: number) {
  return clinicLockLabel(clientNumber, TRANSCRIPT_LOCK_LOGIN);
}

/**
 * Seal and queue a conversation's transcript, inside the conversation's own
 * tenant transaction. Returns the row's id, or null when there is nothing to
 * send (no turn with words) or the conversation already has one queued.
 * The BAA gate refuses the insert for a production clinic without an
 * agreement in effect, as it refuses the conversation itself.
 */
export async function queueTranscriptEmail(
  tx: TenantTx,
  input: QueueTranscriptInput,
): Promise<string | null> {
  if (input.channel !== "voice" && input.channel !== "web_chat") {
    throw new Error(`No transcript is queued for channel ${String(input.channel)}: only calls and web chats.`);
  }
  const turns = input.turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({ speaker: turn.speaker, text: turn.text }));
  if (turns.length === 0) return null;

  const [clinic] = await tx.db
    .select({ clientNumber: clinics.clientNumber })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId));
  if (!clinic) throw new Error("queueTranscriptEmail: no clinic in this tenant.");

  const id = randomUUID();
  const payload: SealedTranscript = {
    channel: input.channel,
    startedAt: input.startedAt.toISOString(),
    turns,
  };
  const sealed = await seal(
    JSON.stringify(payload),
    { clinicId: tx.clinicId, credentialId: id },
    label(clinic.clientNumber),
  );

  const inserted = await tx.db
    .insert(transcriptEmails)
    .values({
      id,
      clinicId: tx.clinicId,
      conversationId: input.conversationId,
      sealed,
      // The database sets both clocks (drizzle/0069); these are placeholders.
      destroyAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .onConflictDoNothing({ target: transcriptEmails.conversationId })
    .returning({ id: transcriptEmails.id });
  if (inserted.length === 0) return null;

  tx.audit.record({
    action: "create",
    resourceType: "transcript_email",
    resourceId: id,
    metadata: { conversationId: input.conversationId, channel: input.channel, turns: turns.length },
  });
  return id;
}

export type TranscriptSendOptions = {
  transport?: EmailTransport;
  notify?: typeof notifyOps;
  notifyOnce?: typeof notifyOpsOnce;
  now?: Date;
};

export type TranscriptSendOutcome = "sent" | "failed" | "not_due" | "gone";

type Claimed = {
  id: string;
  conversationId: string;
  sealed: SealedPayload;
  attempts: number;
  clientNumber: number;
  clinicName: string;
  timeZone: string;
  recipients: string[];
};

/**
 * Try to send one queued transcript now. Never throws: every outcome is
 * recorded on the row and returned.
 */
export async function deliverTranscriptEmail(
  clinicId: string,
  id: string,
  options: TranscriptSendOptions = {},
): Promise<TranscriptSendOutcome> {
  const now = options.now ?? new Date();
  const notifyOnce = options.notifyOnce ?? notifyOpsOnce;
  const actor = { type: "service", serviceName: "transcript-outbox" } as const;

  let claimed: Claimed | null;
  try {
    claimed = await withTenant({ clinicId, actor }, async (tx) => {
      const [row] = await tx.db
        .update(transcriptEmails)
        .set({
          nextAttemptAt: new Date(now.getTime() + LEASE_MS),
          attempts: sql`${transcriptEmails.attempts} + 1`,
        })
        .where(
          and(
            eq(transcriptEmails.id, id),
            inArray(transcriptEmails.status, ["pending", "bounced"]),
            lte(transcriptEmails.nextAttemptAt, now),
          ),
        )
        .returning();
      if (!row) return null;
      const [clinic] = await tx.db
        .select({ clientNumber: clinics.clientNumber, name: clinics.name, timeZone: clinics.timezone })
        .from(clinics)
        .where(eq(clinics.id, clinicId));
      if (!clinic) return null;
      const recipients = (await billingRecipients(tx)).map((r) => r.email);
      tx.audit.record({
        action: "decrypt",
        resourceType: "transcript_email",
        resourceId: row.id,
        metadata: { conversationId: row.conversationId, attempt: row.attempts },
      });
      return {
        id: row.id,
        conversationId: row.conversationId,
        sealed: row.sealed,
        attempts: row.attempts,
        clientNumber: clinic.clientNumber,
        clinicName: clinic.name,
        timeZone: clinic.timeZone,
        recipients,
      };
    });
  } catch (error) {
    log.error("transcript claim failed", { clinicId, jobId: id, error: describeError(error) });
    return "failed";
  }
  if (!claimed) return "not_due";

  const ids = { conversationId: claimed.conversationId, clinicId };

  // Outside any transaction: KMS, then SES.
  let reason: string | null = null;
  let messageId: string | null = null;
  try {
    const payload = JSON.parse(
      await open(claimed.sealed, { clinicId, credentialId: claimed.id }, label(claimed.clientNumber)),
    ) as SealedTranscript;
    const rendered = renderTranscriptEmail({
      conversationId: claimed.conversationId,
      clinic: { id: clinicId, name: claimed.clinicName, timeZone: claimed.timeZone },
      channel: payload.channel,
      startedAt: new Date(payload.startedAt),
      turns: payload.turns,
    });
    if (claimed.recipients.length === 0) {
      reason = "the clinic has no address to send to";
    } else {
      // In v1 there is one address; any second gets its own send, and the
      // first message id is the one recorded for SES's events.
      const bcc = archiveCopyAddress();
      for (const [index, to] of claimed.recipients.entries()) {
        const result = await sendTranscriptEmail(
          rendered,
          { to, clinicId, clinicName: claimed.clinicName },
          { transport: options.transport, bcc: index === 0 ? bcc : null },
        );
        if (result.status === "sent") {
          messageId ??= result.messageId;
        } else {
          reason = result.reason;
        }
      }
      if (messageId) reason = null;
    }
  } catch (error) {
    reason = describeError(error);
  }

  try {
    await withTenant({ clinicId, actor }, async (tx) => {
      if (messageId) {
        await tx.db
          .update(transcriptEmails)
          .set({ status: "sent", sentAt: now, sesMessageId: messageId, lastError: null })
          .where(eq(transcriptEmails.id, claimed!.id));
      } else {
        await tx.db
          .update(transcriptEmails)
          .set({
            nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(claimed!.attempts) * 60_000),
            lastError: scrub(reason ?? "not sent").slice(0, 500),
          })
          .where(eq(transcriptEmails.id, claimed!.id));
      }
    });
  } catch (error) {
    // The lease runs out in two minutes and the row is tried again.
    log.error("transcript outcome not recorded", { ...ids, error: describeError(error) });
  }

  if (messageId) {
    log.info("transcript emailed", { ...ids, status: "sent", attempt: claimed.attempts });
    return "sent";
  }
  const safeReason = scrub(reason ?? "not sent").slice(0, 300);
  log.error("transcript email failed", { ...ids, status: "retrying", attempt: claimed.attempts, reason: safeReason });
  if (claimed.attempts === ALERT_AFTER_FAILURES) {
    await notifyOnce("transcript_undelivered", { ...ids, status: "retrying", reason: safeReason });
  }
  return "failed";
}

/**
 * Delete a copy whose seven days are up. Tells ops when it never went: that
 * transcript is now lost, and the clinic should hear so from a person.
 */
export async function destroyTranscriptEmail(
  clinicId: string,
  id: string,
  options: Pick<TranscriptSendOptions, "notify" | "now"> = {},
): Promise<boolean> {
  const notify = options.notify ?? notifyOps;
  const now = options.now ?? new Date();
  const actor = { type: "service", serviceName: "transcript-outbox" } as const;
  const deleted = await withTenant({ clinicId, actor }, async (tx) => {
    const rows = await tx.db
      .delete(transcriptEmails)
      .where(and(eq(transcriptEmails.id, id), lte(transcriptEmails.destroyAfter, now)))
      .returning({
        id: transcriptEmails.id,
        conversationId: transcriptEmails.conversationId,
        status: transcriptEmails.status,
      });
    for (const row of rows) {
      tx.audit.record({
        action: "delete",
        resourceType: "transcript_email",
        resourceId: row.id,
        metadata: { conversationId: row.conversationId, outcome: row.status },
      });
    }
    return rows;
  });
  for (const row of deleted) {
    if (row.status === "pending" || row.status === "bounced") {
      await notify("transcript_undelivered", { conversationId: row.conversationId, clinicId, status: "expired" });
    }
  }
  return deleted.length > 0;
}

/**
 * Send a queued transcript straight after the conversation's transaction
 * commits, so the clinic has it in seconds rather than at the next minute.
 * Never throws; behind the job's switch like the job itself.
 */
export async function sendQueuedTranscriptNow(
  clinicId: string,
  id: string | null,
  options: TranscriptSendOptions = {},
): Promise<TranscriptSendOutcome | "disabled" | null> {
  if (!id) return null;
  try {
    const job = await getJob(JOB_TRANSCRIPT_EMAILS);
    if (!job?.enabled) return "disabled";
    return await deliverTranscriptEmail(clinicId, id, options);
  } catch (error) {
    log.error("transcript send-now failed", { clinicId, jobId: id, error: describeError(error) });
    return "failed";
  }
}

/** Ids of what is due, across clinics (drizzle/0069's tenant walk). */
export async function transcriptWork(limit = 200): Promise<{ clinicId: string; id: string; due: "send" | "destroy" }[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string; due: string }>(
    sql`select clinic_id, id, due from app_transcript_email_work(${limit})`,
  );
  const rows = (result as unknown as { rows: { clinic_id: string; id: string; due: string }[] }).rows;
  return rows.map((row) => ({
    clinicId: String(row.clinic_id),
    id: String(row.id),
    due: row.due === "destroy" ? "destroy" : "send",
  }));
}

/** The job: every minute, from the billing-minute clock (src/workers/index.ts). */
export async function runTranscriptEmailsJob(options: TranscriptSendOptions = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_TRANSCRIPT_EMAILS,
    async () => {
      let sent = 0;
      let failed = 0;
      let destroyed = 0;
      for (const item of await transcriptWork()) {
        if (item.due === "destroy") {
          if (await destroyTranscriptEmail(item.clinicId, item.id, options)) destroyed += 1;
          continue;
        }
        const outcome = await deliverTranscriptEmail(item.clinicId, item.id, options);
        if (outcome === "sent") sent += 1;
        else if (outcome === "failed") failed += 1;
      }
      return `${sent} sent, ${failed} failed and waiting, ${destroyed} copies deleted.`;
    },
    now,
  );
}

/** What an SES event says about a sent transcript (api/webhooks/ses). */
export type SesTranscriptEvent = {
  messageId: string;
  type: "delivery" | "bounce" | "reject" | "complaint" | "delay" | "rendering_failure";
  /** For a bounce: Permanent or Transient. */
  bounceType?: string;
  /** SES's own words, scrubbed before they are kept. */
  reason?: string;
};

/**
 * Record what SES says happened to a sent transcript. A delivery is noted; a
 * permanent bounce, a rejection, a rendering failure or a complaint marks it
 * bounced, which the job sends again in an hour while its copy lasts, and
 * tells ops once. A transient bounce or a delay is SES still trying: noted
 * only. Returns false when no transcript has that message id (another email,
 * or one whose copy is already gone).
 */
export async function recordSesTranscriptEvent(
  event: SesTranscriptEvent,
  options: Pick<TranscriptSendOptions, "notifyOnce" | "now"> = {},
): Promise<boolean> {
  const notifyOnce = options.notifyOnce ?? notifyOpsOnce;
  const now = options.now ?? new Date();
  const found = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_transcript_email_by_message(${event.messageId})`,
  );
  const row = (found as unknown as { rows: { clinic_id: string; id: string }[] }).rows[0];
  if (!row) return false;
  const clinicId = String(row.clinic_id);
  const id = String(row.id);
  const actor = { type: "service", serviceName: "ses-events" } as const;

  const failed =
    event.type === "reject" ||
    event.type === "rendering_failure" ||
    event.type === "complaint" ||
    (event.type === "bounce" && event.bounceType !== "Transient");

  const conversationId = await withTenant({ clinicId, actor }, async (tx) => {
    const [current] = await tx.db
      .select({ conversationId: transcriptEmails.conversationId })
      .from(transcriptEmails)
      .where(eq(transcriptEmails.id, id));
    if (!current) return null;
    if (event.type === "delivery") {
      await tx.db
        .update(transcriptEmails)
        .set({ status: "delivered", deliveredAt: now, lastError: null })
        .where(and(eq(transcriptEmails.id, id), eq(transcriptEmails.sesMessageId, event.messageId)));
    } else if (failed) {
      await tx.db
        .update(transcriptEmails)
        .set({
          status: "bounced",
          nextAttemptAt: new Date(now.getTime() + BOUNCE_RETRY_MINUTES * 60_000),
          lastError: scrub(`${event.type}${event.bounceType ? ` (${event.bounceType})` : ""}: ${event.reason ?? ""}`).slice(0, 500),
        })
        .where(and(eq(transcriptEmails.id, id), eq(transcriptEmails.sesMessageId, event.messageId)));
    }
    return current.conversationId;
  });
  if (conversationId === null) return false;
  if (failed) {
    await notifyOnce("transcript_undelivered", {
      conversationId,
      clinicId,
      status: event.type,
      reason: scrub(event.reason ?? event.bounceType ?? event.type).slice(0, 300),
    });
  }
  log.info("ses transcript event", { conversationId, clinicId, type: event.type, status: failed ? "bounced" : "noted" });
  return true;
}

/**
 * Send a transcript again on a person's word (the clinic lost the email), for
 * as long as its sealed copy exists. Returns false when it is gone.
 */
export async function resendTranscript(
  clinicId: string,
  conversationId: string,
  actor: ActorContext = { type: "service", serviceName: "transcript-outbox" },
): Promise<boolean> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const rows = await tx.db
      .update(transcriptEmails)
      .set({ status: "pending", nextAttemptAt: new Date() })
      .where(and(eq(transcriptEmails.conversationId, conversationId), eq(transcriptEmails.clinicId, clinicId)))
      .returning({ id: transcriptEmails.id });
    for (const row of rows) {
      tx.audit.record({ action: "update", resourceType: "transcript_email", resourceId: row.id, metadata: { outcome: "resend" } });
    }
    return rows.length > 0;
  });
}
