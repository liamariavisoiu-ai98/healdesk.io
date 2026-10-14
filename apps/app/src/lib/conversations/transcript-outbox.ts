import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  clinics,
  TRANSCRIPT_EMAIL_FINAL_STATUSES,
  TRANSCRIPT_EMAIL_STATUSES,
  transcriptEmails,
  type TranscriptEmailStatus,
} from "@/db/schema";
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
  renderTranscriptEmail,
  sendTranscriptEmail,
  type TranscriptChannel,
  type TranscriptTurn,
} from "./transcript-email";

/**
 * The transcript outbox: how an emailed transcript survives a failed send,
 * and how its copy goes the moment the clinic has it.
 *
 * The owner's decisions of 13 and 14 October 2026: a conversation's
 * transcript is emailed to the clinic when it ends, healdesk keeps no
 * transcript, a send that fails must still reach the clinic, and the sealed
 * copy that makes that possible is deleted as soon as delivery is confirmed.
 * So the transcript waits here, sealed under the KMS key, until SES reports
 * that the clinic's mail server took it, and no longer; if it never does, no
 * longer than 30 days after it was queued, or 72 hours after a send nothing
 * answered. drizzle/0072 holds both clocks to the database's, whatever this
 * code does. The row stays as a receipt without the words.
 *
 *   queue    a call, when it ends, inside the post-call ingest's tenant
 *            transaction (lib/voice/ingest.ts): queueTranscriptEmail(). Then,
 *            after commit, sendQueuedTranscriptNow() so the clinic has it in
 *            seconds.
 *   open     a web chat while it lasts (lib/chat/web-chat.ts): its row is
 *            `open`, its sealed copy rewritten at each message, and it is due
 *            once the visitor has been quiet for WEB_CHAT_QUIET_MS, or at once
 *            when they end it; the claim turns it `pending` for good
 *            (drizzle/0071).
 *   send     claim the row (a two-minute lease and an attempt, in one
 *            conditional UPDATE, so two workers never send it twice), open
 *            the copy outside any transaction, send through SES to the
 *            clinic's address, record what SES said: `sent`, with its message
 *            id and the database's time.
 *   retry    a failed send waits 1, 2, 5, 10 and 30 minutes, then an hour
 *            between tries. Ops hears on the third failure (once).
 *   events   SES's events (api/webhooks/ses), for the message id the row
 *            records: a delivery deletes the copy, in the same transaction,
 *            and the row is `delivered`; a bounce, a rejection, a complaint
 *            or a rendering failure marks it `bounced`, which the job sends
 *            again an hour later, and tells ops once. A transient bounce or a
 *            delay is SES still trying, and answers nothing.
 *   expire   a copy not delivered 30 days after it was queued is deleted and
 *            the row `expired`; ops hears, so the clinic can be told by a
 *            person that a transcript is lost.
 *   unconfirmed  a copy SES accepted with no answer 72 hours after the send
 *            is deleted and the row `unconfirmed`; ops hears once, since SES's
 *            events are probably not reaching the app.
 *
 * The two deletions run whatever the job's switch says (runTranscriptEmailsJob).
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
/**
 * How long a copy may wait, from its queueing, before it is deleted
 * undelivered, and how long after an accepted send with no answer. Both are
 * drizzle/0072's, on the database's clock; these say so for the code.
 */
export const TRANSCRIPT_COPY_MAX_DAYS = 30;
export const TRANSCRIPT_UNCONFIRMED_HOURS = 72;
/** The statuses that still hold a copy and are waiting on a send or on SES. */
const HOLDING: TranscriptEmailStatus[] = ["pending", "sent", "bounced"];
/** A receipt: no copy, and nothing left to do (drizzle/0072). */
const FINAL: readonly TranscriptEmailStatus[] = TRANSCRIPT_EMAIL_FINAL_STATUSES;
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
      // The database sets both clocks (drizzle/0072); this is a placeholder.
      destroyAfter: new Date(Date.now() + TRANSCRIPT_COPY_MAX_DAYS * 24 * 60 * 60 * 1000),
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
          // An open web chat whose quiet time is up has ended: it goes to the
          // send, and its copy can no longer change (drizzle/0071).
          status: sql`case when ${transcriptEmails.status} = 'open' then 'pending' else ${transcriptEmails.status} end`,
        })
        .where(
          and(
            eq(transcriptEmails.id, id),
            inArray(transcriptEmails.status, ["open", "pending", "bounced"]),
            lte(transcriptEmails.nextAttemptAt, now),
            // Past its 30 days the copy is the job's to delete, not to send.
            gt(transcriptEmails.destroyAfter, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!row || !row.sealed) return null;
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
      for (const to of claimed.recipients) {
        const result = await sendTranscriptEmail(
          rendered,
          { to, clinicId, clinicName: claimed.clinicName },
          { transport: options.transport },
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
      // Only while the row still holds its copy: an event or the job may have
      // made it a receipt during the send, and a receipt never changes.
      const stillHeld = and(
        eq(transcriptEmails.id, claimed!.id),
        inArray(transcriptEmails.status, ["pending", "bounced"]),
      );
      if (messageId) {
        await tx.db
          .update(transcriptEmails)
          // sent_at is the database's clock (drizzle/0072); the 72 hours run from it.
          .set({ status: "sent", sentAt: now, sesMessageId: messageId, lastError: null })
          .where(stillHeld);
      } else {
        await tx.db
          .update(transcriptEmails)
          .set({
            nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(claimed!.attempts) * 60_000),
            lastError: scrub(reason ?? "not sent").slice(0, 500),
          })
          .where(stillHeld);
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

export type CopyEnd = "expired" | "unconfirmed";

/**
 * Delete a copy that will not be delivered, keeping its row as a receipt:
 * `expired` once its 30 days from queueing are up, `unconfirmed` once a send
 * SES accepted has had no answer for 72 hours. Both conditions are the
 * database's clock, in the UPDATE and again in drizzle/0072's trigger, so a
 * caller can neither end a copy early nor keep it. Returns whether this call
 * ended it. Ops hears: an expired transcript is lost, and the clinic should
 * hear so from a person; an unconfirmed one means SES's events are probably
 * not reaching this app, said once per transcript.
 */
export async function endTranscriptCopy(
  clinicId: string,
  id: string,
  end: CopyEnd,
  options: Pick<TranscriptSendOptions, "notify" | "notifyOnce"> = {},
): Promise<boolean> {
  const notify = options.notify ?? notifyOps;
  const notifyOnce = options.notifyOnce ?? notifyOpsOnce;
  const actor = { type: "service", serviceName: "transcript-outbox" } as const;
  const due =
    end === "expired"
      ? and(
          inArray(transcriptEmails.status, ["open", ...HOLDING]),
          lte(transcriptEmails.destroyAfter, sql`clock_timestamp()`),
        )
      : and(
          eq(transcriptEmails.status, "sent"),
          lte(
            transcriptEmails.sentAt,
            sql`clock_timestamp() - make_interval(hours => ${TRANSCRIPT_UNCONFIRMED_HOURS})`,
          ),
        );
  const ended = await withTenant({ clinicId, actor }, async (tx) => {
    const rows = await tx.db
      .update(transcriptEmails)
      .set({
        sealed: null,
        status: end,
        ...(end === "unconfirmed"
          ? { lastError: `no delivery or bounce reported by SES within ${TRANSCRIPT_UNCONFIRMED_HOURS} hours of the send` }
          : {}),
      })
      .where(and(eq(transcriptEmails.id, id), due))
      .returning({ id: transcriptEmails.id, conversationId: transcriptEmails.conversationId });
    for (const row of rows) {
      tx.audit.record({
        action: "delete",
        resourceType: "transcript_email",
        resourceId: row.id,
        metadata: { conversationId: row.conversationId, outcome: end },
      });
    }
    return rows;
  });
  for (const row of ended) {
    const fields = { conversationId: row.conversationId, clinicId, status: end };
    log.warn("transcript copy deleted undelivered", fields);
    if (end === "expired") await notify("transcript_undelivered", fields);
    else await notifyOnce("transcript_undelivered", fields);
  }
  return ended.length > 0;
}

// -----------------------------------------------------------------------------
// An open web chat (drizzle/0071)
// -----------------------------------------------------------------------------

/** How long a web chat waits for the visitor before it is over and its transcript goes. */
export const WEB_CHAT_QUIET_MS = 30 * 60 * 1000;

/** What an open web chat's row holds, sealed: the transcript so far and the chat's own state. */
export type OpenChatState<Extra extends object = Record<string, unknown>> = SealedTranscript & { state: Extra };

/**
 * Open a web chat's row with its first turns, inside the conversation's
 * transaction. The BAA gate refuses it for a production clinic without an
 * agreement in effect.
 */
export async function openChatTranscript<Extra extends object>(
  tx: TenantTx,
  input: { conversationId: string; startedAt: Date; turns: readonly TranscriptTurn[]; state: Extra; now?: Date },
): Promise<string> {
  const clientNumber = await clientNumberOf(tx);
  const id = randomUUID();
  const now = input.now ?? new Date();
  const payload: OpenChatState<Extra> = {
    channel: "web_chat",
    startedAt: input.startedAt.toISOString(),
    turns: input.turns.map((t) => ({ speaker: t.speaker, text: t.text })),
    state: input.state,
  };
  const sealed = await seal(JSON.stringify(payload), { clinicId: tx.clinicId, credentialId: id }, label(clientNumber));
  await tx.db.insert(transcriptEmails).values({
    id,
    clinicId: tx.clinicId,
    conversationId: input.conversationId,
    sealed,
    status: "open",
    nextAttemptAt: new Date(now.getTime() + WEB_CHAT_QUIET_MS),
    // The database sets the 30 days (drizzle/0072); this is a placeholder.
    destroyAfter: new Date(now.getTime() + TRANSCRIPT_COPY_MAX_DAYS * 24 * 60 * 60 * 1000),
  });
  tx.audit.record({ action: "create", resourceType: "transcript_email", resourceId: id, metadata: { conversationId: input.conversationId, channel: "web_chat", status: "open" } });
  return id;
}

/**
 * The open chat for a conversation, still inside its quiet time, or null: a
 * chat that has gone to the send, or whose quiet time is up, takes no more
 * messages (the visitor's next message starts a new conversation).
 */
export async function readOpenChat<Extra extends object>(
  tx: TenantTx,
  conversationId: string,
  now: Date = new Date(),
): Promise<{ id: string; payload: OpenChatState<Extra> } | null> {
  const [row] = await tx.db
    .select({ id: transcriptEmails.id, sealed: transcriptEmails.sealed, status: transcriptEmails.status, nextAttemptAt: transcriptEmails.nextAttemptAt })
    .from(transcriptEmails)
    .where(and(eq(transcriptEmails.conversationId, conversationId), eq(transcriptEmails.clinicId, tx.clinicId)))
    .limit(1);
  if (!row || row.status !== "open" || !row.sealed || row.nextAttemptAt.getTime() <= now.getTime()) return null;
  const clientNumber = await clientNumberOf(tx);
  const payload = JSON.parse(await open(row.sealed, { clinicId: tx.clinicId, credentialId: row.id }, label(clientNumber))) as OpenChatState<Extra>;
  return { id: row.id, payload };
}

/**
 * Write an open chat's new state and push its quiet time back. Returns false
 * when the chat is no longer open (the job took it between the read and
 * this write): the caller starts a new conversation.
 */
export async function updateOpenChat<Extra extends object>(
  tx: TenantTx,
  id: string,
  payload: OpenChatState<Extra>,
  options: { now?: Date; end?: boolean } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const clientNumber = await clientNumberOf(tx);
  const sealed = await seal(JSON.stringify(payload), { clinicId: tx.clinicId, credentialId: id }, label(clientNumber));
  const rows = await tx.db
    .update(transcriptEmails)
    .set({
      sealed,
      // Ended by the visitor: due now. Otherwise, quiet time from now.
      nextAttemptAt: options.end ? now : new Date(now.getTime() + WEB_CHAT_QUIET_MS),
    })
    .where(and(eq(transcriptEmails.id, id), eq(transcriptEmails.status, "open")))
    .returning({ id: transcriptEmails.id });
  return rows.length > 0;
}

async function clientNumberOf(tx: TenantTx): Promise<number> {
  const [clinic] = await tx.db.select({ clientNumber: clinics.clientNumber }).from(clinics).where(eq(clinics.id, tx.clinicId));
  if (!clinic) throw new Error("No clinic in this tenant.");
  return clinic.clientNumber;
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

export type TranscriptWork = { clinicId: string; id: string; due: "send" | CopyEnd };

/** Ids of what is due, across clinics (drizzle/0072's tenant walk), deletions first. */
export async function transcriptWork(limit = 200): Promise<TranscriptWork[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string; due: string }>(
    sql`select clinic_id, id, due from app_transcript_email_work(${limit})`,
  );
  const rows = (result as unknown as { rows: { clinic_id: string; id: string; due: string }[] }).rows;
  return rows.map((row) => ({
    clinicId: String(row.clinic_id),
    id: String(row.id),
    due: row.due === "expire" ? "expired" : row.due === "unconfirmed" ? "unconfirmed" : "send",
  }));
}

/**
 * The job: every minute, from the billing-minute clock (src/workers/index.ts),
 * and hourly from the tick as its backstop.
 *
 * The deletions run whatever the switch says. The agreements promise that a
 * copy is held no longer than 30 days, or 72 hours after a send nothing
 * answered, and a promise in a signed agreement does not wait for an
 * operator's toggle, as the retention purge and destruction do not
 * (runWideningJob). The switch decides only whether transcripts are sent.
 * Deletion is outside runSwitchedJob's run so a switched-off job still
 * deletes; each deletion is its own short transaction and a failure is
 * logged and tried again the next minute. A delivered copy is not the job's:
 * SES's event deletes it (recordSesTranscriptEvent).
 */
export async function runTranscriptEmailsJob(options: TranscriptSendOptions = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  const work = await transcriptWork();
  const ended = { expired: 0, unconfirmed: 0 };
  let endFailures = 0;
  for (const item of work) {
    if (item.due === "send") continue;
    try {
      if (await endTranscriptCopy(item.clinicId, item.id, item.due, options)) ended[item.due] += 1;
    } catch (error) {
      endFailures += 1;
      log.error("transcript copy not deleted", { clinicId: item.clinicId, jobId: item.id, error: describeError(error) });
    }
  }
  const deletions =
    `${ended.expired} expired and ${ended.unconfirmed} unconfirmed copies deleted` +
    (endFailures ? `, ${endFailures} not deleted` : "");
  const outcome = await runSwitchedJob(
    JOB_TRANSCRIPT_EMAILS,
    async () => {
      let sent = 0;
      let failed = 0;
      for (const item of work) {
        if (item.due !== "send") continue;
        const result = await deliverTranscriptEmail(item.clinicId, item.id, options);
        if (result === "sent") sent += 1;
        else if (result === "failed") failed += 1;
      }
      return `${sent} sent, ${failed} failed and waiting, ${deletions}.`;
    },
    now,
  );
  if (outcome.status !== "ok" && (ended.expired + ended.unconfirmed > 0 || endFailures > 0)) {
    log.info("transcript copies deleted with sending off", {
      status: outcome.status,
      deleted: ended.expired + ended.unconfirmed,
      count: endFailures,
    });
  }
  return outcome;
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
 * Record what SES says happened to a sent transcript, for the message id the
 * row records.
 *
 * A delivery is the clinic's mail server accepting the email: in this one
 * transaction the copy is deleted and the row becomes a `delivered` receipt,
 * with the database's delivered_at (drizzle/0072). A permanent bounce, a
 * rejection, a rendering failure or a complaint against a `sent` row marks it
 * bounced, which the job sends again in an hour while its 30 days last, and
 * tells ops once. A transient bounce or a delay is SES still trying: noted
 * only, and not an answer, so the 72 hours still run. An event for a row
 * already a receipt changes nothing. Returns false when no transcript records
 * that message id: another email, or an earlier send of one sent again since,
 * whose events no longer count.
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

  const result = await withTenant({ clinicId, actor }, async (tx) => {
    const [current] = await tx.db
      .select({ conversationId: transcriptEmails.conversationId, status: transcriptEmails.status })
      .from(transcriptEmails)
      .where(eq(transcriptEmails.id, id));
    if (!current) return null;
    const ours = and(eq(transcriptEmails.id, id), eq(transcriptEmails.sesMessageId, event.messageId));
    let changed = false;
    if (event.type === "delivery") {
      const rows = await tx.db
        .update(transcriptEmails)
        // delivered_at is the database's clock (drizzle/0072).
        .set({ sealed: null, status: "delivered", deliveredAt: now, lastError: null })
        .where(and(ours, inArray(transcriptEmails.status, HOLDING)))
        .returning({ id: transcriptEmails.id });
      changed = rows.length > 0;
      if (changed) {
        tx.audit.record({
          action: "delete",
          resourceType: "transcript_email",
          resourceId: id,
          metadata: { conversationId: current.conversationId, outcome: "delivered" },
        });
      }
    } else if (failed) {
      const rows = await tx.db
        .update(transcriptEmails)
        .set({
          status: "bounced",
          nextAttemptAt: new Date(now.getTime() + BOUNCE_RETRY_MINUTES * 60_000),
          lastError: scrub(`${event.type}${event.bounceType ? ` (${event.bounceType})` : ""}: ${event.reason ?? ""}`).slice(0, 500),
        })
        .where(and(ours, eq(transcriptEmails.status, "sent")))
        .returning({ id: transcriptEmails.id });
      changed = rows.length > 0;
    }
    return { conversationId: current.conversationId, wasFinal: FINAL.includes(current.status), changed };
  });
  if (result === null) return false;
  const { conversationId } = result;
  if (failed && !result.wasFinal) {
    await notifyOnce("transcript_undelivered", {
      conversationId,
      clinicId,
      status: event.type,
      reason: scrub(event.reason ?? event.bounceType ?? event.type).slice(0, 300),
    });
  }
  const status =
    event.type === "delivery" && result.changed
      ? "delivered"
      : failed && result.changed
        ? "bounced"
        : result.wasFinal
          ? "late"
          : "noted";
  log.info("ses transcript event", { conversationId, clinicId, type: event.type, status });
  return true;
}

export type ResendOutcome = "queued" | "gone" | "open";

/**
 * Send a transcript again on a person's word (the clinic lost the email), for
 * as long as its sealed copy exists: pending, bounced, or sent and awaiting
 * SES's answer. "gone" once it is a receipt (delivered, expired or
 * unconfirmed) or there is no row: healdesk has nothing left to send. "open"
 * for a web chat still going, whose transcript goes when it ends.
 */
export async function resendTranscript(
  clinicId: string,
  conversationId: string,
  actor: ActorContext = { type: "service", serviceName: "transcript-outbox" },
): Promise<ResendOutcome> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const ofConversation = and(eq(transcriptEmails.conversationId, conversationId), eq(transcriptEmails.clinicId, clinicId));
    const rows = await tx.db
      .update(transcriptEmails)
      .set({ status: "pending", nextAttemptAt: new Date() })
      .where(and(ofConversation, inArray(transcriptEmails.status, HOLDING)))
      .returning({ id: transcriptEmails.id });
    for (const row of rows) {
      tx.audit.record({ action: "update", resourceType: "transcript_email", resourceId: row.id, metadata: { outcome: "resend" } });
    }
    if (rows.length > 0) return "queued";
    const [open] = await tx.db
      .select({ id: transcriptEmails.id })
      .from(transcriptEmails)
      .where(and(ofConversation, eq(transcriptEmails.status, "open")));
    return open ? "open" : "gone";
  });
}

// -----------------------------------------------------------------------------
// The receipts (the owner's decision of 14 October 2026)
// -----------------------------------------------------------------------------

/** One transcript's delivery, without its words or its address. */
export type TranscriptReceipt = {
  conversationId: string;
  status: TranscriptEmailStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  attempts: number;
};

export type TranscriptDeliveries = {
  sinceDays: number;
  /** Every status, counted, zero included, over the rows queued in the window. */
  counts: Record<TranscriptEmailStatus, number>;
  /** The newest receipts in the window, newest first. */
  receipts: TranscriptReceipt[];
};

/** How far back the delivery view looks by default, and at most. */
export const TRANSCRIPT_DELIVERIES_DEFAULT_DAYS = 30;
export const TRANSCRIPT_DELIVERIES_MAX_DAYS = 366;
/** How many receipts the view lists. */
export const TRANSCRIPT_DELIVERIES_LIMIT = 50;

/**
 * Whether each of a clinic's transcripts reached it: counts by status and the
 * newest receipts, for the rows queued in the last `sinceDays` days by the
 * database's clock. Never the copy, never an address, never SES's reason.
 */
export async function listTranscriptDeliveries(
  tx: TenantTx,
  sinceDays: number = TRANSCRIPT_DELIVERIES_DEFAULT_DAYS,
  limit: number = TRANSCRIPT_DELIVERIES_LIMIT,
): Promise<TranscriptDeliveries> {
  const since = sql`clock_timestamp() - make_interval(days => ${sinceDays})`;
  const inWindow = and(eq(transcriptEmails.clinicId, tx.clinicId), gte(transcriptEmails.createdAt, since));
  const grouped = await tx.db
    .select({ status: transcriptEmails.status, n: sql<number>`count(*)::int` })
    .from(transcriptEmails)
    .where(inWindow)
    .groupBy(transcriptEmails.status);
  const counts = Object.fromEntries(TRANSCRIPT_EMAIL_STATUSES.map((status) => [status, 0])) as Record<
    TranscriptEmailStatus,
    number
  >;
  for (const row of grouped) {
    if ((TRANSCRIPT_EMAIL_STATUSES as readonly string[]).includes(row.status)) counts[row.status] = Number(row.n);
  }
  const rows = await tx.db
    .select({
      conversationId: transcriptEmails.conversationId,
      status: transcriptEmails.status,
      sentAt: transcriptEmails.sentAt,
      deliveredAt: transcriptEmails.deliveredAt,
      attempts: transcriptEmails.attempts,
    })
    .from(transcriptEmails)
    .where(inWindow)
    .orderBy(desc(transcriptEmails.createdAt), desc(transcriptEmails.id))
    .limit(limit);
  return {
    sinceDays,
    counts,
    receipts: rows.map((row) => ({
      conversationId: row.conversationId,
      status: row.status,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      attempts: row.attempts,
    })),
  };
}
