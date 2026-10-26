import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";

import type { ScreenAllow } from "../screen";
import { classifyEmail, type Classification } from "./classify";
import { inboundMailBucket, isInboundKey, MAX_INBOUND_BYTES } from "./config";
import { screenCounts, senderRef, type ScreenCounts } from "./facts";
import { dropReason, isProviderConfirmation, type DropReason } from "./guards";
import { matchCase, matchClinic, senderIsCaseClinic } from "./match";
import type { InboundNotice } from "./notice";
import { MailParseError, messageIds, parseMail, type ParsedMail } from "./parse";
import { recordInboundEmail, type InboundTarget } from "./record";
import { s3MailStore, type MailStore } from "./store";

/**
 * One inbound email, from SES's notice to a case (lane P7g; design E5 §2.1).
 * The webhook (app/api/webhooks/inbound-mail) and the hourly sweep
 * (sweep.ts) both call this, and it is idempotent by SES's message id, so
 * the two never make two cases of one email.
 *
 *   1. The object must be in the configured bucket, under mail/.
 *   2. Read it. Over MAX_INBOUND_BYTES only the header block is read: the
 *      message is kept as a case with no facts from its body (`oversize`).
 *   3. Parse it in memory (parse.ts); a message that cannot be parsed is a
 *      case with no facts at all, about no clinic, so ops sees something
 *      arrived.
 *   4. Loop guards (guards.ts): an auto-reply, a list, a bounce, our own
 *      mail, spam or a virus is dropped with a log line and no case. A
 *      provider's forwarding confirmation is left for the owner.
 *   5. Match (match.ts), screen and classify in memory (facts.ts,
 *      classify.ts), and write facts only (record.ts).
 *   6. Delete the object, on every path but a transient failure, which
 *      leaves it for SNS's retry, the sweep, or the bucket's one-day expiry.
 *
 * Throws InboundTransientError when storage or the database failed, so the
 * webhook answers 5xx and SNS tries again. Everything else is an outcome.
 * Logs carry SES's id, outcomes and counts; never a header, a subject, an
 * address or a word of the message.
 */

export class InboundTransientError extends Error {
  constructor(phase: string, cause: unknown) {
    super(`inbound mail: ${phase} failed`, { cause });
    this.name = "InboundTransientError";
  }
}

export type HandleOutcome =
  | { outcome: "recorded"; caseId: string; opened: boolean; acknowledged: boolean }
  | { outcome: "already_recorded"; caseId: string }
  | { outcome: "dropped"; reason: DropReason }
  | { outcome: "provider_confirmation" }
  | { outcome: "gone" }
  | { outcome: "refused"; reason: "wrong_bucket" | "bad_key" | "not_set_up" };

export type HandleDeps = {
  store?: MailStore;
  now?: Date;
  actor?: ActorContext;
  /** The screen's allow list for a matched clinic (its own numbers and service names). */
  allowFor?: (clinicId: string, now: Date) => Promise<ScreenAllow | null>;
};

const ACTOR: ActorContext = { type: "service", serviceName: "support-inbound" };
const HEAD_BYTES = 256 * 1024;

async function defaultAllowFor(clinicId: string, now: Date): Promise<ScreenAllow | null> {
  const { readReplyCheckContext } = await import("../draft/run");
  const context = await readReplyCheckContext({ clinicId, actor: ACTOR, now });
  return context ? { numbers: context.allowNumbers, emails: [], serviceNames: context.serviceNames } : null;
}

/** The header block of an oversize message, as a message with an empty body. */
function headBlock(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const head = end === -1 ? text : text.slice(0, end);
  return new Uint8Array(Buffer.from(`${head}\r\n\r\n`, "latin1"));
}

const NO_COUNTS: ScreenCounts = { numbers: 0, emails: 0, treatments: 0, clinical: 0 };
const UNREAD: Classification = { topic: "other", symptom: "other", urgency: "this_week", security: false };

async function remove(store: MailStore, notice: InboundNotice): Promise<void> {
  try {
    await store.delete(notice.bucket, notice.key);
  } catch (error) {
    // The case is written; the sweep or the one-day expiry takes the object.
    log.warn("support inbound: object not deleted", { eventId: notice.sesMessageId, error: describeError(error) });
  }
}

export async function handleInboundNotice(notice: InboundNotice, deps: HandleDeps = {}): Promise<HandleOutcome> {
  const store = deps.store ?? s3MailStore;
  const now = deps.now ?? new Date();
  const actor = deps.actor ?? ACTOR;
  const bucket = inboundMailBucket();
  if (!bucket) return { outcome: "refused", reason: "not_set_up" };
  if (notice.bucket !== bucket) return { outcome: "refused", reason: "wrong_bucket" };
  if (!isInboundKey(notice.key)) return { outcome: "refused", reason: "bad_key" };

  // Read.
  let stored;
  try {
    stored = await store.get(bucket, notice.key);
  } catch (error) {
    throw new InboundTransientError("read", error);
  }
  if (!stored) return { outcome: "gone" };

  let raw: Uint8Array;
  const oversize = stored.size > MAX_INBOUND_BYTES;
  try {
    if (oversize) {
      raw = headBlock(await stored.readHead(HEAD_BYTES));
    } else {
      raw = await stored.read();
    }
  } catch (error) {
    throw new InboundTransientError("read", error);
  }

  // Parse, in memory.
  let mail: ParsedMail | null;
  try {
    mail = await parseMail(raw);
  } catch (error) {
    if (!(error instanceof MailParseError)) throw error;
    mail = null;
  }

  if (mail) {
    const dropped = dropReason(mail, notice);
    if (dropped) {
      log.info("support inbound dropped", { eventId: notice.sesMessageId, outcome: "dropped", reason: dropped });
      await remove(store, notice);
      return { outcome: "dropped", reason: dropped };
    }
    if (isProviderConfirmation(mail)) {
      // Left for the owner to read once in the bucket; it expires within a day.
      log.info("support inbound: provider forwarding confirmation left in the bucket", { eventId: notice.sesMessageId, outcome: "kept" });
      return { outcome: "provider_confirmation" };
    }
  }

  // Match, screen, classify, write.
  let recorded;
  try {
    const from = mail?.from ?? null;
    const threadIds = mail ? [...(mail.inReplyTo ? [mail.inReplyTo] : []), ...mail.references] : [];
    const found = mail ? await matchCase({ subject: mail.subject, threadIds }) : null;
    const target: InboundTarget = {
      caseMatch: found
        ? { ...found, senderMatchesCase: from ? await senderIsCaseClinic(found.supportCase, from, actor) : false }
        : null,
      clinic: !found && from ? await matchClinic(from, actor) : { clinicId: null, matchedBy: "none" },
    };
    const clinicId = target.caseMatch?.supportCase.subjectClinicId ?? target.clinic.clinicId;

    let counts = NO_COUNTS;
    let classification = UNREAD;
    if (mail) {
      const allow =
        (clinicId ? await (deps.allowFor ?? defaultAllowFor)(clinicId, now).catch(() => null) : null) ??
        ({ numbers: [], emails: [] } satisfies ScreenAllow);
      // The sender's own address is not a stranger's.
      const withSender: ScreenAllow = { ...allow, emails: [...allow.emails, from] };
      counts = oversize ? screenCounts(mail.subject, "", withSender) : screenCounts(mail.subject, mail.body, withSender);
      classification = classifyEmail(mail.subject, oversize ? "" : mail.body);
    }

    recorded = await recordInboundEmail(
      {
        notice,
        classification,
        counts,
        attachments: mail && !oversize ? mail.attachments : [],
        oversize,
        messageId: mail?.messageId ?? null,
        inReplyTo: mail ? (messageIds(mail.inReplyTo)[0] ?? null) : null,
        senderRef: senderRef(from ?? `unknown@${notice.sesMessageId.toLowerCase()}.invalid`),
      },
      target,
      actor,
      now,
    );
  } catch (error) {
    throw new InboundTransientError("record", error);
  } finally {
    // Let go of every word as soon as the facts are taken.
    mail = null;
  }

  await remove(store, notice);
  if (recorded.outcome === "already_recorded") {
    log.info("support inbound", { eventId: notice.sesMessageId, outcome: "already_recorded" });
    return { outcome: "already_recorded", caseId: recorded.caseId };
  }
  log.info("support inbound", {
    eventId: notice.sesMessageId,
    clinicId: recorded.clinicId,
    outcome: recorded.outcome,
    decision: recorded.ackReason,
  });
  return { outcome: "recorded", caseId: recorded.caseId, opened: recorded.outcome === "opened", acknowledged: recorded.acknowledged };
}
