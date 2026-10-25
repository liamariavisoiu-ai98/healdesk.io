import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, supportCases, supportMessages, type SupportCase, type SupportMessage } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { draftHash } from "@/lib/approvals/kinds";
import { serialiseDraft } from "@/lib/approvals/drafts";
import { printableClinicName } from "@/lib/email/lint";
import { RETRY_DELAYS_MINUTES } from "@/lib/email/outbox";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor } from "@/lib/email/templates/context";
import { renderSupportReplyWith, SUPPORT_REPLY_REASON, type SupportReplyPayload } from "@/lib/email/templates/support_reply";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import { canMove, printRef } from "./case-vocab";
import { runSupportReplyChecks, type ReplyCheckResult } from "./send-checks";
import { SUPPORT_SEND_MAX_ATTEMPTS, supportReplySubject, type SupportSendStoppedReason } from "./send-vocab";

/**
 * A support reply's draft and its send (ops automation Phase 7, lane P7c;
 * design E5 §2.1-§2.3; owner decision D12). The owner approves, edits and
 * sends every composed reply himself, through the approval inbox
 * (lib/approvals/support-reply.ts, kind `support_reply_send`): this file is
 * the support side of it.
 *
 * ## One row per reply
 *
 * A reply is one `support_messages` row, direction `out`, kind `reply`. Its
 * draft (`draft_text`, `draft_version`, `checks_json`, `facts_json`) is
 * rewritten in place, each new draft one version up, until it is approved;
 * once approved the row is fixed by trigger (drizzle/0126) and the next
 * reply on the case is a new row. Lane P7b's drafter writes its drafts with
 * `saveReplyDraft` too, so the version rule is one rule.
 *
 * ## The send
 *
 * The approval's executor freezes the approved text on the row with its
 * subject (fixed per topic and ref), the SHA-256 of both and the label it
 * was approved under (`freezeApproval`), then sends it once at once
 * (`deliverReply`): through sendEmail, the one door; on the ledger
 * (report_deliveries, kind support_reply, period = the row's id) so the
 * webhook relay marks delivery; under the idempotency key
 * `hd-support_reply-<message id>-1`, the same on every try because the text
 * is frozen, so a retry Resend has seen sends nothing new. A failed try is
 * tried again by `retrySupportReplies` on the outbox's rule (one try, then
 * after 1, 5, 30, 120 and 360 minutes: RETRY_DELAYS_MINUTES), and after the
 * sixth the sending stops as `dead` and ops is told (`support_reply_dead`).
 * A case closed meanwhile, or a clinic with no address left, stops it
 * without sending. Every try sends the frozen text only if its hash is the
 * one approved.
 *
 * Sent, the case moves to `waiting_clinic` and records `last_outbound_at`.
 * The text is kept 12 months as the record of what we told the clinic, then
 * `sweepSentReplyText` deletes it; the row stays, without the words.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A try that started this long ago and never answered is tried again. */
export const SEND_LEASE_MS = 10 * MINUTE_MS;

/** How long an approved reply's text is kept after it was sent: 12 months. */
export const REPLY_TEXT_KEPT_DAYS = 365;

/** The longest draft an operator may save, in characters. */
export const MAX_DRAFT_CHARS = 1500;

const SERVICE: ActorContext = { type: "service", serviceName: "support-send" };

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

/** The case and the clinic's printable name, or null when there is no such case. */
export async function readCaseForReply(
  caseId: string,
  actor: ActorContext = SERVICE,
): Promise<{ supportCase: SupportCase; clinicName: string | null } | null> {
  const [c] = await unsafeDb.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1);
  if (!c) return null;
  let clinicName: string | null = null;
  if (c.subjectClinicId) {
    clinicName = await withTenant({ clinicId: c.subjectClinicId, actor }, async (tx) => {
      const [row] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
      return printableClinicName(row?.name);
    });
  }
  return { supportCase: c, clinicName };
}

/** The case's reply still being drafted (unapproved), newest first, or null. */
export async function openReplyDraft(caseId: string): Promise<SupportMessage | null> {
  const [row] = await unsafeDb
    .select()
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "reply"), isNull(supportMessages.approvedAt)))
    .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
    .limit(1);
  return row ?? null;
}

/** Whether the clinic wrote first: a reply goes only on a case with something inbound (a chat escalation counts). */
export async function clinicWroteFirst(caseId: string): Promise<boolean> {
  const [row] = await unsafeDb
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.direction, "in")))
    .limit(1);
  return row !== undefined;
}

/** The SHA-256 a reply is approved and sent under: its subject and text, as the approval inbox hashes a draft. */
export function replyHash(subject: string, text: string): string {
  return draftHash(serialiseDraft({ subject, body: text }));
}

/** The subject a reply on this case goes under. */
export function subjectForCase(c: Pick<SupportCase, "category" | "ref">): string {
  return supportReplySubject(c.category, printRef(c.ref));
}

/** The reply checks on one text, for this case. */
export async function checkReplyText(
  text: string,
  context: { supportCase: SupportCase; clinicName: string | null; facts?: readonly unknown[] },
  mode: "draft" | "send",
): Promise<ReplyCheckResult> {
  return runSupportReplyChecks({
    text,
    clinicName: context.clinicName,
    ...(context.facts ? { facts: context.facts } : {}),
    ...(context.clinicName ? { allowNames: [context.clinicName] } : {}),
    ownCaseRef: printRef(context.supportCase.ref),
    mode,
  });
}

/** A typed draft as it is kept: line breaks normalised, trimmed, nothing invisible. */
export function normaliseDraftText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || [...text].length > MAX_DRAFT_CHARS) return null;
  return text;
}

// -----------------------------------------------------------------------------
// The draft
// -----------------------------------------------------------------------------

export type SavedDraft = { messageId: string; draftVersion: number };

/**
 * Write a new draft version of the case's reply: the open draft's row one
 * version up, or a new reply row at version 1 when there is none (the last
 * reply was approved, or nothing was drafted yet). For the operator's edit
 * (lib/ops/support-reply-ops.ts saveSupportDraft) and lane P7b's drafter.
 * The checks' results are kept as rule names and ids, never words.
 */
export async function saveReplyDraft(input: {
  caseId: string;
  text: string;
  checks: ReplyCheckResult;
  facts?: unknown;
  now: Date;
}): Promise<SavedDraft> {
  return unsafeDb.transaction(async (tx) => {
    const [open] = await tx
      .select({ id: supportMessages.id, version: supportMessages.draftVersion })
      .from(supportMessages)
      .where(
        and(eq(supportMessages.caseId, input.caseId), eq(supportMessages.kind, "reply"), isNull(supportMessages.approvedAt)),
      )
      .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
      .limit(1)
      .for("update");
    const checksJson = input.checks.results.map((c) => ({ id: c.id, ok: c.ok, rule: c.rule }));
    if (open) {
      const version = (open.version ?? 0) + 1;
      await tx
        .update(supportMessages)
        .set({ draftText: input.text, draftVersion: version, checksJson, factsJson: input.facts ?? null })
        .where(and(eq(supportMessages.id, open.id), isNull(supportMessages.approvedAt)));
      return { messageId: open.id, draftVersion: version };
    }
    const [row] = await tx
      .insert(supportMessages)
      .values({
        caseId: input.caseId,
        direction: "out",
        kind: "reply",
        draftText: input.text,
        draftVersion: 1,
        checksJson,
        factsJson: input.facts ?? null,
        createdAt: input.now,
      })
      .returning({ id: supportMessages.id });
    return { messageId: row!.id, draftVersion: 1 };
  });
}

// -----------------------------------------------------------------------------
// The approval, frozen
// -----------------------------------------------------------------------------

export type FreezeOutcome = "frozen" | "stale" | "already_approved" | "case_closed";

/**
 * Freeze the approved text on the reply row, once: only while the row is
 * still the draft version the approval was proposed for and unapproved, and
 * the case still open. Sets the text, the subject, the hash, the label and
 * the time, and makes the first send due now. The trigger then holds them.
 */
export async function freezeApproval(input: {
  caseId: string;
  messageId: string;
  draftVersion: number;
  subject: string;
  text: string;
  approvedByLabel: string;
  now: Date;
}): Promise<FreezeOutcome> {
  return unsafeDb.transaction(async (tx) => {
    const [c] = await tx
      .select({ state: supportCases.state })
      .from(supportCases)
      .where(eq(supportCases.id, input.caseId))
      .limit(1)
      .for("share");
    if (!c || c.state === "closed") return "case_closed";
    const [row] = await tx
      .select({ approvedAt: supportMessages.approvedAt, version: supportMessages.draftVersion })
      .from(supportMessages)
      .where(and(eq(supportMessages.id, input.messageId), eq(supportMessages.caseId, input.caseId)))
      .limit(1)
      .for("update");
    if (!row) return "stale";
    if (row.approvedAt) return "already_approved";
    if (row.version !== input.draftVersion) return "stale";
    await tx
      .update(supportMessages)
      .set({
        text: input.text,
        replySubject: input.subject,
        approvedHash: replyHash(input.subject, input.text),
        approvedByLabel: input.approvedByLabel,
        approvedAt: input.now,
        nextSendAt: input.now,
      })
      .where(and(eq(supportMessages.id, input.messageId), isNull(supportMessages.approvedAt)));
    return "frozen";
  });
}

// -----------------------------------------------------------------------------
// One try
// -----------------------------------------------------------------------------

export type DeliverOutcome =
  | { status: "sent"; hash: string }
  | { status: "retrying"; attempts: number }
  | { status: "stopped"; reason: SupportSendStoppedReason }
  | { status: "not_due" };

async function stop(messageId: string, reason: SupportSendStoppedReason, now: Date): Promise<void> {
  await unsafeDb
    .update(supportMessages)
    .set({ sendStoppedAt: now, sendStoppedReason: reason, nextSendAt: null })
    .where(and(eq(supportMessages.id, messageId), isNull(supportMessages.sentAt), isNull(supportMessages.sendStoppedAt)));
}

/** Take the row's next try: due, unsent and not stopped. Pushes the next try out by the lease, so a second caller finds it taken. */
async function lease(messageId: string, now: Date): Promise<boolean> {
  const taken = await unsafeDb
    .update(supportMessages)
    .set({ nextSendAt: new Date(now.getTime() + SEND_LEASE_MS) })
    .where(
      and(
        eq(supportMessages.id, messageId),
        isNotNull(supportMessages.approvedAt),
        isNull(supportMessages.sentAt),
        isNull(supportMessages.sendStoppedAt),
        lte(supportMessages.nextSendAt, now),
      ),
    )
    .returning({ id: supportMessages.id });
  return taken.length > 0;
}

/**
 * One try of an approved reply, if one is due. Never throws for a delivery
 * fact: a failure counts a try and sets the next, or stops the sending.
 */
export async function deliverReply(
  messageId: string,
  now: Date,
  options: SendEmailOptions = {},
): Promise<DeliverOutcome> {
  if (!(await lease(messageId, now))) return { status: "not_due" };
  const [row] = await unsafeDb
    .select({ message: supportMessages, supportCase: supportCases })
    .from(supportMessages)
    .innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId))
    .where(eq(supportMessages.id, messageId))
    .limit(1);
  if (!row) return { status: "not_due" };
  const { message, supportCase } = row;
  if (supportCase.state === "closed") {
    await stop(messageId, "case_closed", now);
    return { status: "stopped", reason: "case_closed" };
  }
  const clinicId = supportCase.subjectClinicId;
  const text = message.text;
  const subject = message.replySubject;
  if (
    !clinicId ||
    text === null ||
    subject === null ||
    !message.approvedAt ||
    !message.approvedByLabel ||
    message.approvedHash !== replyHash(subject, text)
  ) {
    // Not what was approved: never sent. The trigger makes this unreachable short of a bug.
    log.error("support reply not as approved; not sent", { clinicId });
    await stop(messageId, "dead", now);
    await notifyOps("support_reply_dead", { clinicId: clinicId ?? null, count: message.sendAttempts });
    return { status: "stopped", reason: "dead" };
  }

  const claim = await withTenant({ clinicId, actor: SERVICE }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        name: clinics.name,
        specialty: clinics.specialty,
        timezone: clinics.timezone,
        closed: clinics.accountClosedAt,
        destroyed: clinics.destroyedAt,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic || clinic.closed || clinic.destroyed) return null;
    const signIn = await clinicSignIn(tx);
    if (!signIn) return null;
    const deliveryId = await claimDelivery(tx, { kind: "support_reply", periodKey: messageId, recipient: signIn.email });
    return { clinic, to: signIn.email, deliveryId };
  });
  if (!claim) {
    await stop(messageId, "clinic_left", now);
    return { status: "stopped", reason: "clinic_left" };
  }
  const hash = message.approvedHash;
  if (!claim.deliveryId) {
    // The ledger says this reply was sent already (a try that sent and died before recording it here).
    await recordSent(message, supportCase, null, null, now);
    return { status: "sent", hash };
  }

  const clinicName = printableClinicName(claim.clinic.name);
  const payload: SupportReplyPayload = {
    caseId: supportCase.id,
    messageId,
    supportRef: printRef(supportCase.ref),
    topic: supportCase.category,
    approvedReplyText: text,
    approvedAt: message.approvedAt.toISOString(),
    approvedByLabel: message.approvedByLabel,
  };
  const attempts = message.sendAttempts + 1;
  let failure: string;
  try {
    const rendered = renderSupportReplyWith(subject)(payload, {
      clinicName,
      audience: audienceFor(claim.clinic.specialty),
      reason: SUPPORT_REPLY_REASON,
      raisedAt: message.approvedAt,
      timeZone: claim.clinic.timezone,
    });
    const result = await sendEmail(
      {
        to: claim.to,
        kind: "support_reply",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        clinicName,
        clinicId,
        deliveryId: claim.deliveryId,
        // The same on every try: the text is frozen, so a try Resend has seen is not sent twice.
        idempotencyKey: `hd-support_reply-${messageId}-1`,
      },
      { ...options, now },
    );
    await withTenant({ clinicId, actor: SERVICE }, (tx) =>
      recordDelivery(
        tx,
        claim.deliveryId!,
        result.status === "sent" ? { status: "sent", messageId: result.messageId } : { status: result.status, reason: result.reason },
      ),
    );
    if (result.status === "sent") {
      await recordSent(message, supportCase, claim.deliveryId, result.messageId, now, attempts);
      return { status: "sent", hash };
    }
    failure = result.status;
  } catch (error) {
    failure = "threw";
    log.error("support reply not sent", { clinicId, error: describeError(error) });
    await withTenant({ clinicId, actor: SERVICE }, (tx) =>
      recordDelivery(tx, claim.deliveryId!, { status: "failed", reason: describeError(error) }),
    ).catch(() => undefined);
  }
  return afterFailure(message.id, clinicId, attempts, failure, now);
}

async function afterFailure(
  messageId: string,
  clinicId: string,
  attempts: number,
  failure: string,
  now: Date,
): Promise<DeliverOutcome> {
  if (attempts >= SUPPORT_SEND_MAX_ATTEMPTS) {
    await unsafeDb
      .update(supportMessages)
      .set({ sendAttempts: attempts, sendStoppedAt: now, sendStoppedReason: "dead", nextSendAt: null })
      .where(and(eq(supportMessages.id, messageId), isNull(supportMessages.sentAt), isNull(supportMessages.sendStoppedAt)));
    log.error("support reply dead", { clinicId, count: attempts, outcome: failure });
    await notifyOps("support_reply_dead", { clinicId, count: attempts });
    return { status: "stopped", reason: "dead" };
  }
  const delay = RETRY_DELAYS_MINUTES[attempts - 1] ?? RETRY_DELAYS_MINUTES.at(-1)!;
  await unsafeDb
    .update(supportMessages)
    .set({ sendAttempts: attempts, nextSendAt: new Date(now.getTime() + delay * MINUTE_MS) })
    .where(and(eq(supportMessages.id, messageId), isNull(supportMessages.sentAt), isNull(supportMessages.sendStoppedAt)));
  return { status: "retrying", attempts };
}

/** The reply went: record it on the row, and move the case to waiting on the clinic. */
async function recordSent(
  message: SupportMessage,
  supportCase: SupportCase,
  deliveryId: string | null,
  mailId: string | null,
  now: Date,
  attempts: number = message.sendAttempts,
): Promise<void> {
  await unsafeDb
    .update(supportMessages)
    .set({
      sentAt: now,
      nextSendAt: null,
      sendAttempts: Math.max(attempts, message.sendAttempts),
      textDeleteAfter: new Date(now.getTime() + REPLY_TEXT_KEPT_DAYS * DAY_MS),
      ...(deliveryId ? { deliveryId } : {}),
      ...(mailId && !message.messageId ? { messageId: mailId.slice(0, 998) } : {}),
    })
    .where(and(eq(supportMessages.id, message.id), isNull(supportMessages.sentAt)));
  await unsafeDb.transaction(async (tx) => {
    const [c] = await tx.select().from(supportCases).where(eq(supportCases.id, supportCase.id)).limit(1).for("update");
    if (!c || c.state === "closed") return;
    await tx
      .update(supportCases)
      .set({
        lastOutboundAt: now,
        updatedAt: now,
        ...(c.state !== "waiting_clinic" && canMove(c.state, "waiting_clinic")
          ? { state: "waiting_clinic" as const, snoozedUntil: null }
          : {}),
      })
      .where(and(eq(supportCases.id, c.id), eq(supportCases.state, c.state)));
  });
}

// -----------------------------------------------------------------------------
// Retries and retention
// -----------------------------------------------------------------------------

/**
 * Every approved reply whose next try is due, tried once each: the retry
 * half of the send (one try, then the outbox's delays, dead after six).
 * Returns what happened, counted.
 */
export async function retrySupportReplies(
  now: Date,
  options: SendEmailOptions = {},
): Promise<{ sent: number; retrying: number; stopped: number }> {
  const due = await unsafeDb
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.kind, "reply"),
        isNotNull(supportMessages.approvedAt),
        isNull(supportMessages.sentAt),
        isNull(supportMessages.sendStoppedAt),
        lte(supportMessages.nextSendAt, now),
      ),
    )
    .orderBy(asc(supportMessages.nextSendAt))
    .limit(50);
  const counts = { sent: 0, retrying: 0, stopped: 0 };
  for (const { id } of due) {
    try {
      const outcome = await deliverReply(id, now, options);
      if (outcome.status === "sent") counts.sent += 1;
      else if (outcome.status === "retrying") counts.retrying += 1;
      else if (outcome.status === "stopped") counts.stopped += 1;
    } catch (error) {
      log.error("support reply retry failed", { error: describeError(error) });
    }
  }
  return counts;
}

/**
 * Delete the text of every reply sent more than 12 months ago (design E5
 * §2.2): the row stays, with its subject, hash, approval and delivery, as the
 * record that a reply went and what it was approved as. Returns how many.
 */
export async function sweepSentReplyText(now: Date): Promise<number> {
  const swept = await unsafeDb
    .update(supportMessages)
    .set({ text: null })
    .where(
      and(
        eq(supportMessages.kind, "reply"),
        isNotNull(supportMessages.text),
        isNotNull(supportMessages.sentAt),
        lte(supportMessages.textDeleteAfter, now),
      ),
    )
    .returning({ id: supportMessages.id });
  return swept.length;
}

/** For the console: how many approved replies are still trying, and how many stopped dead (never a word). */
export async function sendCounts(): Promise<{ trying: number; dead: number }> {
  const [row] = await unsafeDb
    .select({
      trying: sql<number>`count(*) filter (where ${supportMessages.sentAt} is null and ${supportMessages.sendStoppedAt} is null)`.mapWith(Number),
      dead: sql<number>`count(*) filter (where ${supportMessages.sendStoppedReason} = 'dead')`.mapWith(Number),
    })
    .from(supportMessages)
    .where(and(eq(supportMessages.kind, "reply"), isNotNull(supportMessages.approvedAt)));
  return { trying: row?.trying ?? 0, dead: row?.dead ?? 0 };
}
