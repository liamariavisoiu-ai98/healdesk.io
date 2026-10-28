import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, supportCases, supportMessages, type SupportCase, type SupportMessage } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { draftHash } from "@/lib/approvals/kinds";
import { serialiseDraft } from "@/lib/approvals/drafts";
import { LinkNotAllowedError, PayloadNotAllowedError, printableClinicName } from "@/lib/email/lint";
import { RETRY_DELAYS_MINUTES, verdictOf } from "@/lib/email/outbox";
import { EmailEnvelopeError, sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor } from "@/lib/email/templates/context";
import { renderSupportReplyWith, SUPPORT_REPLY_REASON, type SupportReplyPayload } from "@/lib/email/templates/support_reply";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import { actionOfFacts, DROPPED_BY_OPERATOR, type SupportAction } from "./actions/tiers";
import { canMove, printRef } from "./case-vocab";
import type { FactsUsed } from "./draft/checks";
import { readReplyCheckContext } from "./draft/run";
import { threadingHeadersFor } from "./inbound/threading";
import { runSupportReplyChecks, type ReplyCheckResult } from "./send-checks";
import { SUPPORT_SEND_MAX_ATTEMPTS, supportReplySubject, type SupportSendStoppedReason } from "./send-vocab";

/**
 * A support reply's draft and its send (ops automation Phase 7, lane P7c;
 * design E5 §2.1-§2.3; owner decision D12). The owner approves, edits and
 * sends every composed reply himself, through the approval inbox
 * (lib/approvals/support-reply.ts, kind `support_reply_send`): this file is
 * the support side of it.
 *
 * ## One row per draft version
 *
 * A draft is a `support_messages` row, direction `out`, kind `reply`, as
 * lane P7b's drafter writes them (lib/support/draft/store.ts): each new
 * draft a new row one version above the case's highest, the drafter's runs
 * and the operator's saved edits alike (`saveReplyDraft`). The current draft
 * is the row with the highest version; only it can be approved. Once
 * approved its row is fixed by trigger (drizzle/0126).
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
 * is frozen, so a retry Resend has seen sends nothing new, for the 24 hours Resend
 * keeps a key (a retry later than SUPPORT_RETRY_WINDOW_MS after the approval is
 * stopped as `dead` rather than risk a second email). A failed try is
 * tried again by `retrySupportReplies` on the outbox's rule (one try, then
 * after 1, 5, 30, 120 and 360 minutes: RETRY_DELAYS_MINUTES), and after the
 * sixth the sending stops as `dead` and ops is told (`support_reply_dead`).
 * A retry Resend refuses because the key was used already (409
 * invalid_idempotent_request, as when the clinic's sign-in address changed
 * after a try it had taken) is recorded as sent, not counted as a failure.
 * A case closed meanwhile, or a clinic with no address left, stops it
 * without sending. Every try sends the frozen text only if its hash is the
 * one approved.
 *
 * Sent, the case moves to `waiting_clinic` and records `last_outbound_at`.
 * The text is kept 12 months as the record of what we told the clinic, then
 * `sweepSentReplyText` deletes it; the row stays, without the words. A reply
 * that stopped without going (dead, its case closed, its clinic left) keeps
 * its text on the same 12 months, counted from the stop.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Resend honours an idempotency key for 24 hours. A retry older than this
 * after the approval could send a reply twice if an earlier try reached
 * Resend and its answer was lost, so it is stopped instead (`dead`, ops told).
 */
export const SUPPORT_RETRY_WINDOW_MS = 23 * 60 * MINUTE_MS;

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

/** The case's current draft: the reply row with the highest version, or null when there is none. */
export async function currentReplyDraft(caseId: string, db: Pick<typeof unsafeDb, "select"> = unsafeDb): Promise<SupportMessage | null> {
  const [row] = await db
    .select()
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "reply"), isNotNull(supportMessages.draftVersion)))
    .orderBy(desc(supportMessages.draftVersion), desc(supportMessages.createdAt))
    .limit(1);
  return row ?? null;
}

/** The current draft while it is still a draft (not approved), or null. */
export async function openReplyDraft(caseId: string): Promise<SupportMessage | null> {
  const row = await currentReplyDraft(caseId);
  return row && row.approvedAt === null ? row : null;
}

/** The facts a draft relied on (lane P7b's facts_json.factsUsed), for check 5's billing facts. */
export function factsOfDraft(row: Pick<SupportMessage, "factsJson">): FactsUsed[] {
  const used = (row.factsJson as { factsUsed?: unknown } | null)?.factsUsed;
  if (!Array.isArray(used)) return [];
  return used.flatMap((f) => {
    const { tool, field, value } = (f ?? {}) as Record<string, unknown>;
    return typeof tool === "string" && typeof field === "string" && typeof value === "string" ? [{ tool, field, value }] : [];
  });
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

/**
 * The reply checks on one text, for this case, as Send runs them: lane P7b's
 * eight less check 1 (facts, which needs the model's run), with the
 * practice's own context, and the send path's floor. An operator's text and
 * the owner's edit are checked this way; a drafter's draft also passed check
 * 1 when it was written (its checks_json).
 */
export async function checkReplyText(
  text: string,
  context: {
    supportCase: SupportCase;
    clinicName: string | null;
    facts?: readonly FactsUsed[];
    /** The change the text is held to instead of the current draft's (an edit that drops it); null for none. */
    action?: SupportAction | null;
  },
  actor: ActorContext = SERVICE,
): Promise<ReplyCheckResult> {
  const clinicId = context.supportCase.subjectClinicId;
  // Lane D: a reply on a case whose current draft carries a proposed change
  // may say it was made only as that change stands (draft/checks.ts action_claim).
  let action: SupportAction | null;
  if (context.action !== undefined) {
    action = context.action;
  } else {
    const current = await currentReplyDraft(context.supportCase.id);
    action = current ? actionOfFacts(current.factsJson) : null;
  }
  const practice = clinicId ? await readReplyCheckContext({ clinicId, actor }).catch(() => null) : null;
  // Without the practice's context, check 8 cannot see the other practices' names: fail closed.
  if (clinicId && !practice) {
    return { ok: false, results: [{ id: "reply_checks", ok: false, rule: PRACTICE_UNREAD }] };
  }
  return runSupportReplyChecks({
    text,
    clinicName: practice?.clinicName ?? context.clinicName,
    ...(context.facts ? { facts: context.facts } : {}),
    ownCaseRef: printRef(context.supportCase.ref),
    mode: "send",
    ...(action ? { action } : {}),
    ...(practice
      ? {
          context: {
            allowNumbers: practice.allowNumbers,
            serviceNames: practice.serviceNames,
            clinicId: practice.clinicId,
            otherClinicNames: practice.otherClinicNames,
            agreementKind: practice.agreementKind,
            portalOrigin: practice.portalOrigin,
          },
        }
      : {}),
  });
}

/** Shown when the practice's account could not be read for the checks: nothing passes then. */
export const PRACTICE_UNREAD = "The practice's account could not be read for the checks, so the reply cannot pass them now";

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

/** Who wrote a draft, in its facts_json: lane P7b's drafter marks its own "drafter". */
export const OPERATOR_MARK = "operator";

/**
 * Save the operator's own text as the case's next draft: a new reply row one
 * version above the case's highest (counting the drafter's failed runs, as
 * lane P7b's store does, so the two never take the same version), marked
 * `facts_json.by = "operator"` so it costs none of the drafter's five
 * attempts. Under the case's row lock, so a drafter run racing it finds the
 * version taken and writes nothing. Its checks are kept as ids and rules,
 * never words. Null when the case is closed.
 */
export async function saveReplyDraft(input: {
  caseId: string;
  text: string;
  checks: ReplyCheckResult;
  now: Date;
  /**
   * Drop the current draft's pending change from this edit: kept as
   * `not_run` with DROPPED_BY_OPERATOR, so approving the edit makes no
   * change and the claim check holds the text to that. Ignored unless the
   * change is pending.
   */
  dropAction?: boolean;
}): Promise<SavedDraft | null> {
  return unsafeDb.transaction(async (tx) => {
    const [c] = await tx.select({ state: supportCases.state }).from(supportCases).where(eq(supportCases.id, input.caseId)).limit(1).for("update");
    if (!c || c.state === "closed") return null;
    const [top] = await tx
      .select({
        top: sql<number>`coalesce(max(coalesce(${supportMessages.draftVersion}, (${supportMessages.factsJson}->>'attempt')::int)), 0)::int`,
      })
      .from(supportMessages)
      .where(and(eq(supportMessages.caseId, input.caseId), eq(supportMessages.kind, "reply"), eq(supportMessages.direction, "out")));
    const version = Number(top?.top ?? 0) + 1;
    // Lane D: an edit of a draft that proposed a change keeps the change as it
    // stands: a pending one still runs when the edited reply is approved, and
    // a settled one (done, refused, not run) keeps the claim check holding the
    // operator's text to what happened. Only a change that runs inside the
    // approval and fails there stops the send (approvals/support-reply.ts).
    const current = await currentReplyDraft(input.caseId, tx);
    const kept = current ? actionOfFacts(current.factsJson) : null;
    const action: SupportAction | null =
      kept && input.dropAction && kept.status === "pending"
        ? { ...kept, status: "not_run", reason: DROPPED_BY_OPERATOR, at: input.now.toISOString() }
        : kept;
    const [row] = await tx
      .insert(supportMessages)
      .values({
        caseId: input.caseId,
        direction: "out",
        kind: "reply",
        draftText: input.text,
        draftVersion: version,
        checksJson: { ok: input.checks.ok, results: input.checks.results.map((r) => ({ id: r.id, ok: r.ok, rule: r.rule })) },
        factsJson: { by: OPERATOR_MARK, attempt: version, ...(action ? { action } : {}) },
        createdAt: input.now,
      })
      .returning({ id: supportMessages.id });
    return { messageId: row!.id, draftVersion: version };
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
      .where(and(eq(supportMessages.id, input.messageId), eq(supportMessages.caseId, input.caseId), eq(supportMessages.kind, "reply")))
      .limit(1)
      .for("update");
    if (!row) return "stale";
    if (row.approvedAt) return "already_approved";
    if (row.version !== input.draftVersion) return "stale";
    // Only the case's current draft: a newer version written since replaces this one.
    const current = await currentReplyDraft(input.caseId, tx);
    if (!current || current.id !== input.messageId) return "stale";
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
    .set({
      sendStoppedAt: now,
      sendStoppedReason: reason,
      nextSendAt: null,
      // The words of a reply that never went are forgotten on the same 12-month rule, counted from the stop (0129).
      textDeleteAfter: new Date(now.getTime() + REPLY_TEXT_KEPT_DAYS * DAY_MS),
    })
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
  if (message.approvedAt && now.getTime() - message.approvedAt.getTime() > SUPPORT_RETRY_WINDOW_MS) {
    // A try may have reached Resend and lost its answer; its key no longer protects a repeat. Never sent twice.
    log.error("support reply retry past the idempotency window; not sent", { clinicId: clinicId ?? null });
    await stop(messageId, "dead", now);
    await notifyOps("support_reply_dead", { clinicId: clinicId ?? null, count: message.sendAttempts });
    return { status: "stopped", reason: "dead" };
  }
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
    // Lane P7g: on a case that came by email, the reply threads under the newest one before the approval.
    const headers = await threadingHeadersFor(supportCase.id, message.approvedAt);
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
        ...(headers ? { headers } : {}),
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
    // Resend has seen this key already, with this body or another: the reply
    // went on an earlier try whose answer was lost, possibly to the address
    // the clinic signed in with then, since the key repeats the request and
    // the address is read afresh. Reconcile it as sent, as the email outbox
    // does (verdictOf), rather than count refusals up to a false dead.
    if (result.status === "failed" && verdictOf(result) === "sent") {
      await withTenant({ clinicId, actor: SERVICE }, (tx) =>
        recordDelivery(tx, claim.deliveryId!, {
          status: "skipped",
          reason: "Resend already had this reply from an earlier try; it went then.",
        }),
      );
      await recordSent(message, supportCase, null, null, now, attempts);
      return { status: "sent", hash };
    }
    failure = result.status;
  } catch (error) {
    failure = "threw";
    log.error("support reply not sent", { clinicId, error: describeError(error) });
    await withTenant({ clinicId, actor: SERVICE }, (tx) =>
      recordDelivery(tx, claim.deliveryId!, { status: "failed", reason: describeError(error) }),
    ).catch(() => undefined);
    // A refusal by the sender's own rules cannot pass on a later try: stop now, dead.
    if (error instanceof PayloadNotAllowedError || error instanceof LinkNotAllowedError || error instanceof EmailEnvelopeError) {
      return afterFailure(message.id, clinicId, SUPPORT_SEND_MAX_ATTEMPTS, "refused", now, attempts);
    }
  }
  return afterFailure(message.id, clinicId, attempts, failure, now);
}

async function afterFailure(
  messageId: string,
  clinicId: string,
  attempts: number,
  failure: string,
  now: Date,
  /** The tries actually made, when the sending stops before its sixth (a refusal). */
  tried: number = attempts,
): Promise<DeliverOutcome> {
  if (attempts >= SUPPORT_SEND_MAX_ATTEMPTS) {
    await unsafeDb
      .update(supportMessages)
      .set({
        sendAttempts: tried,
        sendStoppedAt: now,
        sendStoppedReason: "dead",
        nextSendAt: null,
        textDeleteAfter: new Date(now.getTime() + REPLY_TEXT_KEPT_DAYS * DAY_MS),
      })
      .where(and(eq(supportMessages.id, messageId), isNull(supportMessages.sentAt), isNull(supportMessages.sendStoppedAt)));
    log.error("support reply dead", { clinicId, count: tried, outcome: failure });
    await notifyOps("support_reply_dead", { clinicId, count: tried });
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
 * Delete the text of every reply sent, or stopped without going (dead, its
 * case closed, its clinic left), more than 12 months ago (design E5 §2.2; the
 * stopped ones since lane P7f, 0129): the row stays, with its subject, hash,
 * approval and delivery or stop, as the record that a reply went, or did not,
 * and what it was approved as. Returns how many.
 */
export async function sweepSentReplyText(now: Date): Promise<number> {
  const swept = await unsafeDb
    .update(supportMessages)
    .set({ text: null })
    .where(
      and(
        eq(supportMessages.kind, "reply"),
        isNotNull(supportMessages.text),
        // Sent, or stopped without going: the date is set only by one of the two (the table's CHECK).
        or(isNotNull(supportMessages.sentAt), isNotNull(supportMessages.sendStoppedAt)),
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
