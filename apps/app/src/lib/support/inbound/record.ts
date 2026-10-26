import { and, desc, eq, gt, ne, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { billingNotices, supportCases, supportMessages, type SupportCase } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { assertPayloadAllowed } from "@/lib/email/lint";
import type { SupportReceivedPayload } from "@/lib/email/templates/support_received";
import { replyByDay } from "@/lib/reply-by";
import { withTenant } from "@/lib/tenant";

import { insertCase } from "../cases";
import { moreUrgent, printRef } from "../case-vocab";
import type { Verdicts } from "./auth";
import type { Classification } from "./classify";
import { attachmentSummary, messageFields, phiSuspected, type MatchedBy, type ScreenCounts } from "./facts";
import type { InboundNotice } from "./notice";
import type { AttachmentClass } from "./parse";

/**
 * An inbound email, written (lane P7g): one support_messages row of kind
 * `email` holding facts only, on a case it opens or joins, and the fixed
 * acknowledgement queued when it may go. Through the same tables and the
 * same insertCase as the chat's hand-off (lib/support/cases.ts), in the
 * matched clinic's tenant, so 0125's guard checks the clinic as it does for
 * a chat case.
 *
 * Which case:
 *   - the case the ref or the thread named, if it is open and the sender
 *     may join it (handle.ts, match.ts): joined;
 *   - else, the fourth or later email within an hour from one sender: the
 *     sender's newest open email case, joined (one case for a flood, and no
 *     acknowledgement);
 *   - else a new case, about the matched clinic or about no clinic.
 *
 * Joining: the case's urgency is the more urgent of the two; a case waiting
 * on the clinic or snoozed comes back to `new` (the clinic needs us again;
 * from waiting_clinic its reply-by day is the new one, since we had
 * replied); the screen's counts are added to an email case (a chat case
 * keeps none, by 0125's CHECK, so on a chat case they stay on the message).
 *
 * The acknowledgement (L38, `support_received`) is queued in the same
 * transaction, only when all hold: the case names a clinic; the sender is
 * that clinic's own sign-in (a stranger quoting a ref gets nothing sent
 * anywhere); the sender is authenticated (auth.ts: an aligned DKIM pass or
 * a DMARC pass); the sender has sent fewer than three emails in the hour
 * before this one; and the case has not had one (its dedupe key is the
 * case's id, and so is the outbox row's id, so the outbox sends it under
 * `hd-support_received-<case id>-1`). It goes through the outbox to the
 * clinic's owners and billing contacts (lib/billing/recipients.ts), never to
 * the email's From.
 *
 * One sender at a time: the transaction first takes an advisory lock on the
 * sender's reference, so emails from one sender arriving together are
 * counted one after another, and the hour's limit cannot be raced.
 *
 * Idempotent by SES's message id (support_messages_inbound_mail_key): a
 * notice SNS delivers twice, or the sweep reading what the webhook took,
 * finds the row and changes nothing.
 */

const HOUR_MS = 60 * 60 * 1000;

/** More than this many emails from one sender in an hour: the next ones get no acknowledgement. */
export const ACKS_PER_SENDER_HOUR = 3;

export type InboundFacts = {
  notice: InboundNotice;
  classification: Classification;
  counts: ScreenCounts;
  attachments: readonly { kind: AttachmentClass; bytes: number }[];
  oversize: boolean;
  messageId: string | null;
  inReplyTo: string | null;
  senderRef: string;
  /** SES's verdicts, the notice's or else its own headers' (auth.ts). */
  verdicts: Verdicts;
  /** An aligned DKIM pass or a DMARC pass (auth.ts). */
  authenticated: boolean;
  /**
   * Leave the raw message in the bucket for the support drafter (lane P7h):
   * its key is written on the row, but only when the case names a clinic,
   * since a case about no clinic is never drafted.
   */
  keepForDrafter?: boolean;
};

export type InboundTarget = {
  /** The case the ref or the thread named, open. */
  caseMatch: { supportCase: SupportCase; matchedBy: "ref" | "thread"; senderMatchesCase: boolean | null } | null;
  /** The clinic the From address matched, or none. */
  clinic: { clinicId: string | null; matchedBy: Extract<MatchedBy, "address" | "closed_account" | "none"> };
};

export type RecordOutcome =
  | { outcome: "already_recorded"; caseId: string }
  | {
      outcome: "opened" | "joined";
      caseId: string;
      ref: string;
      clinicId: string | null;
      acknowledged: boolean;
      ackReason: AckDecision;
      /** The object's key was written on the row: the draft job reads and deletes it. */
      kept: boolean;
    };

type AckDecision = "queued" | "not_matched" | "already" | "rate_limited" | "not_authenticated";

function pgErrorOf(error: unknown): { code?: string; constraint?: string } {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return {};
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

async function alreadyRecorded(db: Transaction | typeof unsafeDb, sesMessageId: string): Promise<string | null> {
  const [row] = await db
    .select({ caseId: supportMessages.caseId })
    .from(supportMessages)
    .where(eq(supportMessages.inboundMailId, sesMessageId))
    .limit(1);
  return row?.caseId ?? null;
}

/** How many emails this sender sent in the hour before `at`. */
async function senderHour(db: Transaction, senderRef: string, at: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.senderRef, senderRef),
        eq(supportMessages.kind, "email"),
        gt(supportMessages.receivedAt, new Date(at.getTime() - HOUR_MS)),
      ),
    );
  return Number(row?.n ?? 0);
}

async function sendersOpenCase(db: Transaction, senderRef: string): Promise<SupportCase | null> {
  const [row] = await db
    .select({ supportCase: supportCases })
    .from(supportMessages)
    .innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId))
    .where(and(eq(supportMessages.senderRef, senderRef), ne(supportCases.state, "closed"), eq(supportCases.source, "email")))
    .orderBy(desc(supportMessages.receivedAt))
    .limit(1);
  return row?.supportCase ?? null;
}

/** Write one inbound email. Throws on a database failure (the webhook answers 5xx and SNS retries). */
export async function recordInboundEmail(
  facts: InboundFacts,
  target: InboundTarget,
  actor: ActorContext,
  now: Date,
): Promise<RecordOutcome> {
  const seen = await alreadyRecorded(unsafeDb, facts.notice.sesMessageId);
  if (seen) return { outcome: "already_recorded", caseId: seen };
  const clinicId = target.caseMatch ? target.caseMatch.supportCase.subjectClinicId : target.clinic.clinicId;
  try {
    return clinicId
      ? await withTenant({ clinicId, actor }, (tx) => recordIn(tx.db, facts, target, clinicId, now))
      : await unsafeDb.transaction((tx) => recordIn(tx, facts, target, null, now));
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg.code === "23505" && pg.constraint === "support_messages_inbound_mail_key") {
      const caseId = await alreadyRecorded(unsafeDb, facts.notice.sesMessageId);
      if (caseId) return { outcome: "already_recorded", caseId };
    }
    throw error;
  }
}

async function recordIn(
  db: Transaction,
  facts: InboundFacts,
  target: InboundTarget,
  clinicId: string | null,
  now: Date,
): Promise<RecordOutcome> {
  // One sender at a time, so the hour's count below is never raced.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${facts.senderRef}))`);
  const seen = await alreadyRecorded(db, facts.notice.sesMessageId);
  if (seen) return { outcome: "already_recorded", caseId: seen };
  const receivedAt = facts.notice.receivedAt;
  const priorInHour = await senderHour(db, facts.senderRef, receivedAt);
  const flooded = priorInHour >= ACKS_PER_SENDER_HOUR;
  const suspected = phiSuspected(facts.counts);
  const { classification } = facts;

  let join: SupportCase | null = null;
  if (target.caseMatch) {
    const [locked] = await db.select().from(supportCases).where(eq(supportCases.id, target.caseMatch.supportCase.id)).limit(1).for("update");
    if (locked && locked.state !== "closed") join = locked;
  }
  if (!join && flooded) {
    const open = await sendersOpenCase(db, facts.senderRef);
    if (open && open.subjectClinicId === clinicId) {
      const [locked] = await db.select().from(supportCases).where(eq(supportCases.id, open.id)).limit(1).for("update");
      if (locked && locked.state !== "closed") join = locked;
    }
  }

  let caseId: string;
  let ref: string;
  let outcome: "opened" | "joined";
  let caseClinic: string | null;
  if (join) {
    const comesBack = join.state === "waiting_clinic" || join.state === "snoozed";
    const addCounts = join.source === "email";
    await db
      .update(supportCases)
      .set({
        urgency: moreUrgent(join.urgency, classification.urgency),
        lastInboundAt: now,
        updatedAt: now,
        ...(comesBack ? { state: "new" as const, snoozedUntil: null } : {}),
        ...(join.state === "waiting_clinic" ? { replyByOn: replyByDay(now) } : {}),
        ...(addCounts && suspected
          ? {
              phiSuspected: true,
              hiddenNumbers: join.hiddenNumbers + facts.counts.numbers,
              hiddenEmails: join.hiddenEmails + facts.counts.emails,
              hiddenTreatments: join.hiddenTreatments + facts.counts.treatments,
              clinicalMatches: join.clinicalMatches + facts.counts.clinical,
            }
          : {}),
      })
      .where(eq(supportCases.id, join.id));
    caseId = join.id;
    ref = join.ref;
    outcome = "joined";
    caseClinic = join.subjectClinicId;
  } else {
    const opened = await insertCase(db, {
      subjectClinicId: clinicId,
      source: "email",
      category: classification.topic,
      symptom: classification.symptom,
      urgency: classification.urgency,
      replyByOn: replyByDay(now),
      now,
    });
    if (suspected) {
      await db
        .update(supportCases)
        .set({
          phiSuspected: true,
          hiddenNumbers: facts.counts.numbers,
          hiddenEmails: facts.counts.emails,
          hiddenTreatments: facts.counts.treatments,
          clinicalMatches: facts.counts.clinical,
        })
        .where(eq(supportCases.id, opened.id));
    }
    caseId = opened.id;
    ref = opened.ref;
    outcome = "opened";
    caseClinic = clinicId;
  }

  // Whether the acknowledgement may go, decided before the message is written so its fields say so.
  const senderIsClinic = target.caseMatch ? target.caseMatch.senderMatchesCase === true : target.clinic.matchedBy === "address";
  let ack: AckDecision;
  if (!caseClinic || !senderIsClinic) ack = "not_matched";
  else if (!facts.authenticated) ack = "not_authenticated";
  else if (flooded) ack = "rate_limited";
  else ack = "queued";

  const matchedBy: MatchedBy = target.caseMatch ? target.caseMatch.matchedBy : target.clinic.matchedBy;
  const summary = attachmentSummary(facts.attachments);

  let acknowledged = false;
  if (ack === "queued" && caseClinic) {
    const payload: SupportReceivedPayload = {
      caseId,
      supportRef: printRef(ref),
      replyByOn: replyByDay(now),
      hasPatientDetails: suspected,
    };
    assertPayloadAllowed(payload, "support_received");
    const inserted = await db
      .insert(billingNotices)
      .values({
        id: caseId,
        clinicId: caseClinic,
        kind: "support_received",
        dedupeKey: `support_received:${caseId}`,
        payload: payload as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: billingNotices.id });
    acknowledged = inserted.length > 0;
    if (!acknowledged) ack = "already";
  }

  const kept = facts.keepForDrafter === true && caseClinic !== null && facts.notice.key === `mail/${facts.notice.sesMessageId}`;
  await db.insert(supportMessages).values({
    caseId,
    direction: "in",
    kind: "email",
    inboundMailId: facts.notice.sesMessageId,
    inboundObjectKey: kept ? facts.notice.key : null,
    senderRef: facts.senderRef,
    messageId: facts.messageId,
    inReplyTo: facts.inReplyTo,
    fieldsJson: messageFields({
      classification,
      matchedBy,
      counts: facts.counts,
      verdicts: facts.verdicts,
      oversize: facts.oversize,
      acknowledged: ack,
      senderMatchesCase: target.caseMatch ? target.caseMatch.senderMatchesCase : null,
      authenticated: facts.authenticated,
      fromClinic: caseClinic !== null && senderIsClinic && facts.authenticated,
    }),
    attachmentsJson: summary,
    receivedAt,
    createdAt: now,
  });

  return { outcome, caseId, ref, clinicId: caseClinic, acknowledged, ackReason: ack, kept };
}

/** Whether an already-recorded email's object still waits for the drafter (its key is on the row). */
export async function objectAwaitsDrafter(sesMessageId: string): Promise<boolean> {
  const [row] = await unsafeDb
    .select({ key: supportMessages.inboundObjectKey })
    .from(supportMessages)
    .where(eq(supportMessages.inboundMailId, sesMessageId))
    .limit(1);
  return Boolean(row?.key);
}
