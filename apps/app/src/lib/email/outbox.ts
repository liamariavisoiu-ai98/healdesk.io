import { and, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { billingNotices, clinics, type BillingNotice } from "@/db/schema";
import { billingRecipients } from "@/lib/billing/recipients";
import { describeError, log, scrub } from "@/lib/log";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import { MailFormatError, type DeliveryResult, type EmailTransport } from "@/lib/reporting/deliver";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { PhiRoutingError } from "@/lib/reporting/resend-transport";
import { getJob, JOB_BILLING_NOTICES, runSwitchedJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { carriesUnsubscribe, CRITICAL_NOTICE_KINDS, optionalSwitchOf } from "./kind-rules";
import { NOTICE_KIND_REGISTRY, NOTICE_KINDS, type NoticeKind } from "./kinds";
import { assertPayloadAllowed, LinkNotAllowedError, PayloadNotAllowedError } from "./lint";
import { optionalEmailAllowed } from "./stop";
import { supersededReason } from "./superseded";
import { EmailEnvelopeError, sendEmail } from "./send";
import { EmailCompositionError } from "./templates/compose";
import { audienceFor, clinicReason } from "./templates/context";
import { templatedNoticeKinds, templateFor, type TemplateEntry } from "./templates/registry";
import type { RenderedEmail, TemplateContext } from "./templates/types";
import { unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe";

/**
 * The outbox sender: F0's `billing_notices`, delivered (Annex X3).
 *
 * One outbox and one ledger. Every email about a clinic's account is a row in
 * billing_notices, written in the same transaction as the state change it
 * describes, so a transaction that rolls back sends nothing; and every
 * recipient of every send is a row in report_deliveries, claimed before the
 * send so its id can travel as the `delivery` tag and Resend's webhook can
 * find it again. Nothing here holds a transaction open across a send.
 *
 * ## How a notice goes
 *
 *   - CLAIMED by one conditional UPDATE that moves send_after two minutes out
 *     (the lease) and counts the attempt. A second worker's UPDATE finds
 *     send_after in the future and claims nothing, so two workers never send
 *     one row twice, and a worker that dies mid-send releases the row two
 *     minutes later instead of the 60 minutes runJob's lock would hold it.
 *   - Recipients are resolved at send time: billingRecipients(), the clinic's
 *     one address.
 *   - RENDERED only from the stored payload, after the payload allowlist has
 *     passed it, and sent under `hd-<kind>-<notice id>-<recipient n>`. A retry
 *     within Resend's 24 hours therefore repeats the request exactly, and
 *     Resend answers it with the first send's result instead of a second
 *     email; a 409 invalid_idempotent_request means the key was already used,
 *     and is recorded as sent.
 *   - RETRIED at 1, 5, 30, 120 and 360 minutes after a 429, a 5xx or no answer,
 *     under the same key. Any other 4xx, and anything this side refuses to
 *     send (a payload off the allowlist, a link to the wrong origin), is final.
 *     Resend's daily_quota_exceeded waits until 00:05 UTC without spending an
 *     attempt: the quota resets at midnight and nothing else is wrong.
 *   - DEAD after its sixth attempt, or at once when final: attempts is set to
 *     the maximum, which takes it out of every query here, and notifyOps fires.
 *   - HELD, untouched, while its kind has no template (Package C and later
 *     milestones add them): logged once, counted in the job's note, and never
 *     claimed, so no attempt is spent on an email that cannot be rendered.
 *
 * ## When a notice goes
 *
 *   - Critical kinds (the registry's priority) go in-process, right after the
 *     writer's transaction commits: deliverCriticalAfterCommit().
 *   - Everything else, and every retry, goes from the `notices` queue, every
 *     minute (runBillingNoticesJob). The `billing-notices` job row is the
 *     switch for both: off, nothing is sent.
 *   - A `daytime` kind waits for 07:00–20:00 in the clinic's time zone;
 *     `any_hour` goes at once. Either way, a kind whose subject can be over
 *     before it goes (O10's step) is re-read when it would be sent, and
 *     closed unsent when it is (lib/email/superseded.ts).
 *   - A critical notice still unsent ten minutes after it was due turns
 *     /api/health red and raises notifyOps once (lateCriticalNotices), so a
 *     mail outage cannot hide behind a mail alert.
 */

export const NOTICE_LEASE_MS = 2 * 60_000;
/** Minutes after the 1st, 2nd, … 5th failed attempt before the next. */
export const RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360] as const;
/** The first attempt and five retries. A notice with this many attempts is dead. */
export const MAX_NOTICE_ATTEMPTS = RETRY_DELAYS_MINUTES.length + 1;
/** How long a critical notice may stay unsent after it was due. */
export const LATE_CRITICAL_MS = 10 * 60_000;
/** Quiet hours: a `daytime` kind goes between these local hours. */
export const DAYTIME_FROM_HOUR = 7;
export const DAYTIME_UNTIL_HOUR = 20;

const ACTOR = { type: "service", serviceName: "notices-sender" } as const;
const DEFAULT_LIMIT = 200;

export type NoticeOutcome =
  /** Every recipient has it (or had it: an earlier attempt's send, or a 409 on the key). */
  | "sent"
  /** A 429, a 5xx or no answer: send_after moved to the next retry. */
  | "retrying"
  /** Used every attempt, or refused for good. notifyOps has been told. */
  | "dead"
  /** No template for its kind yet: left pending and untouched. */
  | "held"
  /** Quiet hours or Resend's daily quota: send_after moved, no attempt spent. */
  | "waiting"
  /** Its optional email switch is off: closed without sending. */
  | "switched_off"
  /** What it was about is over (lib/email/superseded.ts): closed without sending. */
  | "superseded"
  /** Not claimable now: already sent, leased by another worker, dead, or not yet due. */
  | "not_due";

export type TemplateLookup = (kind: string) => TemplateEntry | undefined;

export type DeliverOptions = {
  now?: Date;
  /** A fake in tests. Otherwise sendEmail's transport for the environment. */
  transport?: EmailTransport;
  /** Tests only: templates for kinds that have none yet. */
  templates?: TemplateLookup;
};

export type SendPendingNoticesOptions = DeliverOptions & {
  /** Only this billing clinic's notices (the immediate send after an event). */
  clinicId?: string;
  /** Only these kinds. Every kind by default. */
  kinds?: readonly NoticeKind[];
  limit?: number;
};

export type NoticeRunSummary = { sent: number; failed: number; skipped: number; held: number };

// -----------------------------------------------------------------------------
// Delivering one notice
// -----------------------------------------------------------------------------

type Slot = { n: number; email: string; deliveryId: string | null };

type Claimed = {
  notice: BillingNotice & { kind: NoticeKind };
  entry: TemplateEntry;
  clinic: { name: string; timezone: string; specialty: string };
  slots: Slot[];
};

type Verdict = "sent" | "skipped" | "quota" | "retry" | "permanent";

type SlotResult = { slot: Slot; verdict: Verdict; result: DeliveryResult | null };

/**
 * Deliver one notice, if it is due and unclaimed. Returns what happened.
 * Throws only when the database does: every send failure is recorded on the
 * notice and its ledger rows instead.
 */
export async function deliverNotice(
  clinicId: string,
  noticeId: string,
  options: DeliverOptions = {},
): Promise<NoticeOutcome> {
  const now = options.now ?? new Date();
  const lookup = options.templates ?? templateFor;

  const claim = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    claimNotice(tx, noticeId, now, lookup),
  );
  if (typeof claim === "string") return claim;

  const results = await sendToRecipients(claim, now, options.transport);

  const outcome = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    recordOutcome(tx, claim, results, now),
  );

  // After commit, and outside the transaction: notifyOps sends an email of its own.
  if (outcome.outcome === "dead") {
    await notifyOps("critical_notice_undelivered", {
      clinicId,
      noticeId,
      kind: claim.notice.kind,
      status: "dead",
      attempts: claim.notice.attempts,
    });
  }
  return outcome.outcome;
}

async function claimNotice(
  tx: TenantTx,
  noticeId: string,
  now: Date,
  lookup: TemplateLookup,
): Promise<Claimed | NoticeOutcome> {
  const [row] = await tx.db
    .select()
    .from(billingNotices)
    .where(eq(billingNotices.id, noticeId))
    .limit(1);
  if (
    !row ||
    row.sentAt ||
    row.attempts >= MAX_NOTICE_ATTEMPTS ||
    row.sendAfter.getTime() > now.getTime()
  ) {
    return "not_due";
  }
  const kind = row.kind as NoticeKind;

  const entry = lookup(kind);
  if (!entry) {
    logHeldOnce(tx.clinicId, row.id, kind);
    return "held";
  }

  const [clinic] = await tx.db
    .select({ name: clinics.name, timezone: clinics.timezone, specialty: clinics.specialty })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return "not_due";

  const notDue = and(
    eq(billingNotices.id, row.id),
    isNull(billingNotices.sentAt),
    lte(billingNotices.sendAfter, now),
    lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
  );

  // Quiet hours: a reminder at 03:00 waits for 07:00 the clinic's time. No
  // attempt is spent; the row simply becomes due later.
  if (NOTICE_KIND_REGISTRY[kind].quietHours === "daytime") {
    const opens = nextDaytime(now, clinic.timezone);
    if (opens.getTime() > now.getTime()) {
      await tx.db.update(billingNotices).set({ sendAfter: opens }).where(notDue);
      return "waiting";
    }
  }

  const optional = optionalSwitchOf(kind);
  if (optional && !(await optionalEmailAllowed(tx, optional))) {
    await tx.db
      .update(billingNotices)
      .set({
        sentAt: now,
        recipientsCount: 0,
        lastError: `not sent: the ${optional} switch is off`,
      })
      .where(notDue);
    return "switched_off";
  }

  // Re-read at send time, after quiet hours: an O10 held until morning is not
  // sent about a step the clinic finished overnight.
  const superseded = await supersededReason(tx, kind, row.payload);
  if (superseded) {
    await tx.db
      .update(billingNotices)
      .set({ sentAt: now, recipientsCount: 0, lastError: `not sent: ${superseded}` })
      .where(notDue);
    return "superseded";
  }

  // The claim: lease the row for two minutes and count the attempt, in one
  // conditional UPDATE. Whoever's UPDATE matches owns the send.
  const [claimed] = await tx.db
    .update(billingNotices)
    .set({
      sendAfter: new Date(now.getTime() + NOTICE_LEASE_MS),
      attempts: sql`${billingNotices.attempts} + 1`,
    })
    .where(notDue)
    .returning();
  if (!claimed) return "not_due";

  // The ledger rows, one per recipient, claimed before the send so each id
  // can ride on the email as its `delivery` tag. A recipient whose row is
  // already 'sent' (an earlier attempt reached it) comes back null and is
  // not sent again.
  const recipients = await billingRecipients(tx);
  const slots: Slot[] = [];
  for (const [index, recipient] of recipients.entries()) {
    const deliveryId = await claimDelivery(tx, {
      kind,
      periodKey: claimed.id,
      recipient: recipient.email,
    });
    slots.push({ n: index + 1, email: recipient.email, deliveryId });
  }

  return { notice: { ...claimed, kind }, entry, clinic, slots };
}

/**
 * Render once, from the stored payload, and send to each recipient not yet
 * sent. Nothing here touches the database except through sendEmail's quota
 * bookkeeping.
 */
async function sendToRecipients(
  claim: Claimed,
  now: Date,
  transport: EmailTransport | undefined,
): Promise<SlotResult[]> {
  const { notice, entry, clinic, slots } = claim;
  if (slots.length === 0) return [];

  let rendered: RenderedEmail;
  let headers: Record<string, string> | undefined;
  try {
    assertPayloadAllowed(notice.payload, notice.kind);
    const scope = carriesUnsubscribe(notice.kind)
      ? (optionalSwitchOf(notice.kind) ?? "commercial")
      : null;
    const ctx: TemplateContext = {
      clinicName: clinic.name,
      audience: audienceFor(clinic.specialty),
      reason: clinicReason(clinic.name),
      ...(scope ? { unsubscribeUrl: unsubscribeUrl(notice.clinicId, scope) } : {}),
      // The notice's own time, never the clock: a retry renders the same bytes.
      raisedAt: notice.createdAt,
      timeZone: clinic.timezone,
    };
    rendered = entry.render(notice.payload, ctx);
    headers = ctx.unsubscribeUrl ? unsubscribeHeaders(ctx.unsubscribeUrl) : undefined;
  } catch (error) {
    const verdict = isFinal(error) ? "permanent" : "retry";
    return slots.map((slot) => ({
      slot,
      verdict: slot.deliveryId ? verdict : "sent",
      result: slot.deliveryId ? { status: "failed" as const, reason: describeError(error) } : null,
    }));
  }

  const results: SlotResult[] = [];
  for (const slot of slots) {
    if (!slot.deliveryId) {
      results.push({ slot, verdict: "sent", result: null });
      continue;
    }
    try {
      const result = await sendEmail(
        {
          to: slot.email,
          kind: notice.kind,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          phiClass: "none",
          clinicId: notice.clinicId,
          clinicName: clinic.name,
          deliveryId: slot.deliveryId,
          idempotencyKey: `hd-${notice.kind}-${notice.id}-${slot.n}`,
          ...(headers ? { headers } : {}),
        },
        { transport, now },
      );
      results.push({ slot, verdict: verdictOf(result), result });
    } catch (error) {
      results.push({
        slot,
        verdict: isFinal(error) ? "permanent" : "retry",
        result: { status: "failed", reason: describeError(error) },
      });
    }
  }
  return results;
}

/** How the outbox reads one result. */
export function verdictOf(result: DeliveryResult): Verdict {
  if (result.status === "sent") return "sent";
  if (result.status === "skipped") return "skipped";
  const { statusCode, errorName } = result;
  // The key was used already, with this body or another: Resend sent it then.
  if (statusCode === 409 && errorName === "invalid_idempotent_request") return "sent";
  if (errorName === "daily_quota_exceeded") return "quota";
  if (errorName === "invalid_message") return "permanent";
  // No answer at all (a timeout, a network failure, a response we could not read).
  if (statusCode === undefined || statusCode === null) return "retry";
  if (statusCode === 429 || statusCode >= 500) return "retry";
  // Another request with this key is in flight: ask again later, same key.
  if (statusCode === 409 && errorName === "concurrent_idempotent_requests") return "retry";
  if (statusCode >= 400) return "permanent";
  return "retry";
}

/** A refusal on this side that sending again cannot cure. */
function isFinal(error: unknown): boolean {
  return (
    error instanceof PhiRoutingError ||
    error instanceof PayloadNotAllowedError ||
    error instanceof LinkNotAllowedError ||
    error instanceof EmailCompositionError ||
    error instanceof EmailEnvelopeError ||
    error instanceof MailFormatError
  );
}

async function recordOutcome(
  tx: TenantTx,
  claim: Claimed,
  results: SlotResult[],
  now: Date,
): Promise<{ outcome: NoticeOutcome }> {
  const { notice } = claim;
  for (const { slot, verdict, result } of results) {
    if (!slot.deliveryId || !result) continue;
    if (result.status === "sent") {
      await recordDelivery(tx, slot.deliveryId, { status: "sent", messageId: result.messageId });
    } else if (verdict === "sent") {
      // A 409 on the key: the first request under it went out.
      await recordDelivery(tx, slot.deliveryId, {
        status: "sent",
        messageId: "unknown: sent under this idempotency key before",
      });
    } else {
      await recordDelivery(tx, slot.deliveryId, {
        status: result.status === "skipped" ? "skipped" : "failed",
        reason: scrub(result.reason),
      });
    }
  }

  const unsent = and(eq(billingNotices.id, notice.id), isNull(billingNotices.sentAt));
  const firstProblem = (verdicts: Verdict[]) =>
    results.find((r) => verdicts.includes(r.verdict))?.result;
  const reasonOf = (result: DeliveryResult | null | undefined) =>
    scrub(result && result.status !== "sent" ? result.reason : "unknown").slice(0, 280);

  if (results.length === 0) {
    // No recipient at all: the clinic has no address to send to. Nothing a
    // retry can change, and with one address per clinic, ops calls them.
    await tx.db
      .update(billingNotices)
      .set({
        attempts: MAX_NOTICE_ATTEMPTS,
        lastError: "dead: the clinic has no address to send to",
      })
      .where(unsent);
    return { outcome: "dead" };
  }

  if (results.some((r) => r.verdict === "permanent")) {
    await tx.db
      .update(billingNotices)
      .set({
        attempts: MAX_NOTICE_ATTEMPTS,
        lastError: `dead: ${reasonOf(firstProblem(["permanent"]))}`,
      })
      .where(unsent);
    return { outcome: "dead" };
  }

  if (results.some((r) => r.verdict === "quota")) {
    // Resend's day is over for us. Wait for the reset, and give the attempt back.
    await tx.db
      .update(billingNotices)
      .set({
        sendAfter: nextQuotaReset(now),
        attempts: sql`greatest(${billingNotices.attempts} - 1, 0)`,
        lastError: "waiting: Resend's daily quota is used up until 00:00 UTC",
      })
      .where(unsent);
    return { outcome: "waiting" };
  }

  if (results.some((r) => r.verdict === "retry")) {
    const reason = reasonOf(firstProblem(["retry"]));
    if (notice.attempts >= MAX_NOTICE_ATTEMPTS) {
      await tx.db
        .update(billingNotices)
        .set({ lastError: `dead: ${reason}` })
        .where(unsent);
      return { outcome: "dead" };
    }
    const delay = RETRY_DELAYS_MINUTES[notice.attempts - 1] ?? RETRY_DELAYS_MINUTES.at(-1)!;
    await tx.db
      .update(billingNotices)
      .set({ sendAfter: new Date(now.getTime() + delay * 60_000), lastError: reason })
      .where(unsent);
    return { outcome: "retrying" };
  }

  const sent = results.filter((r) => r.verdict === "sent").length;
  const skipped = results.find((r) => r.verdict === "skipped");
  await tx.db
    .update(billingNotices)
    .set({
      sentAt: now,
      recipientsCount: sent,
      lastError: skipped ? `skipped: ${reasonOf(skipped.result)}` : null,
    })
    .where(unsent);
  return { outcome: "sent" };
}


// -----------------------------------------------------------------------------
// Time
// -----------------------------------------------------------------------------

/** The clinic's local minute of the day. Intl, not offsets, so daylight saving is right. */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Now, if it is daytime at the clinic (07:00–20:00 local); otherwise the next
 * 07:00 there. An unknown time zone means no quiet hours: a reminder late is
 * better than a reminder never.
 */
export function nextDaytime(now: Date, timeZone: string): Date {
  const from = DAYTIME_FROM_HOUR * 60;
  const until = DAYTIME_UNTIL_HOUR * 60;
  let minutes: number;
  try {
    minutes = localMinutes(now, timeZone);
  } catch {
    return now;
  }
  if (minutes >= from && minutes < until) return now;

  const wait = minutes < from ? from - minutes : 24 * 60 - minutes + from;
  const start = new Date(now.getTime() + wait * 60_000);
  let candidate = new Date(start.getTime() - (start.getTime() % 60_000));
  // A daylight-saving change in between moves the local clock by an hour;
  // correct for it once, then once more in case the correction crossed it.
  for (let i = 0; i < 2; i += 1) {
    const drift = from - localMinutes(candidate, timeZone);
    if (drift === 0 || Math.abs(drift) > 120) break;
    candidate = new Date(candidate.getTime() + drift * 60_000);
  }
  return candidate;
}

/** 00:05 UTC after now: Resend's quota resets at midnight UTC, and five minutes is slack. */
export function nextQuotaReset(now: Date): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5);
  return new Date(today > now.getTime() ? today : today + 24 * 60 * 60_000);
}

// -----------------------------------------------------------------------------
// Finding notices
// -----------------------------------------------------------------------------

export type PendingNotice = {
  clinicId: string;
  id: string;
  kind: NoticeKind;
  createdAt: Date;
  sendAfter: Date;
  attempts: number;
  /** An attempt spent, or a wait recorded (the daily quota): its send_after has moved since it was due. */
  tried: boolean;
};

/**
 * Unsent, not-dead notices of these kinds, across every clinic, through the
 * tenant walk in drizzle/0046 (billing_notices forces row-level security, and
 * the sender has no tenant until it has chosen a notice). Ids and kinds only.
 */
export async function pendingNotices(
  kinds: readonly NoticeKind[],
  limit: number = DEFAULT_LIMIT,
): Promise<PendingNotice[]> {
  if (kinds.length === 0) return [];
  const result = await unsafeDb.execute<{
    clinic_id: string;
    id: string;
    kind: string;
    created_at: Date | string;
    send_after: Date | string;
    attempts: number;
    tried: boolean;
  }>(
    sql`select clinic_id, id, kind, created_at, send_after, attempts, tried
          from app_pending_notices(${sqlTextArray(kinds)}, ${MAX_NOTICE_ATTEMPTS}, ${limit})`,
  );
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows
    .map((row) => ({
      clinicId: String(row.clinic_id),
      id: String(row.id),
      kind: String(row.kind) as NoticeKind,
      createdAt: new Date(row.created_at as string),
      sendAfter: new Date(row.send_after as string),
      attempts: Number(row.attempts),
      tried: row.tried === true,
    }))
    .sort((a, b) => a.sendAfter.getTime() - b.sendAfter.getTime())
    .slice(0, limit);
}

/** A text[] parameter. The kinds are registry names, checked by the CHECK's own rule. */
function sqlTextArray(values: readonly string[]) {
  for (const value of values) {
    if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Not a kind name: ${value}`);
  }
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** One clinic's due notices of these kinds, inside its tenant. */
async function dueNoticesOf(
  clinicId: string,
  kinds: readonly NoticeKind[],
  now: Date,
  limit: number,
): Promise<PendingNotice[]> {
  if (kinds.length === 0) return [];
  const rows = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    tx.db
      .select({
        id: billingNotices.id,
        kind: billingNotices.kind,
        createdAt: billingNotices.createdAt,
        sendAfter: billingNotices.sendAfter,
        attempts: billingNotices.attempts,
        tried: sql<boolean>`(${billingNotices.attempts} > 0 or ${billingNotices.lastError} is not null)`,
      })
      .from(billingNotices)
      .where(
        and(
          eq(billingNotices.clinicId, clinicId),
          isNull(billingNotices.sentAt),
          lte(billingNotices.sendAfter, now),
          lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
          inArray(billingNotices.kind, [...kinds]),
        ),
      )
      .orderBy(billingNotices.sendAfter)
      .limit(limit),
  );
  return rows.map((row) => ({ clinicId, ...row, kind: row.kind as NoticeKind }));
}

/** When a notice was due: its send_after until it is tried, then when it was queued. */
function dueAt(notice: PendingNotice): Date {
  return notice.tried ? notice.createdAt : notice.sendAfter;
}

/**
 * Critical notices still unsent ten minutes after they were due. A tried
 * notice's send_after moves forward with each retry, and to 00:05 UTC when the
 * daily quota is used up, so once tried it is measured from when it was
 * queued: critical kinds are due at once, and a quota that has run out is a
 * mail outage like any other. Dead letters are not counted: they have already
 * been escalated, and a health check that stays red forever is one people
 * learn to ignore.
 */
export async function lateCriticalNotices(now: Date = new Date()): Promise<PendingNotice[]> {
  const cutoff = now.getTime() - LATE_CRITICAL_MS;
  return (await pendingNotices(CRITICAL_NOTICE_KINDS, 500)).filter(
    (notice) => dueAt(notice).getTime() <= cutoff,
  );
}

/** Tell ops about each late critical notice, once per notice. Never throws. */
export async function alertLateCriticalNotices(late: readonly PendingNotice[]): Promise<void> {
  for (const notice of late) {
    await notifyOpsOnce("critical_notice_undelivered", {
      clinicId: notice.clinicId,
      noticeId: notice.id,
      kind: notice.kind,
      status: "late",
      attempts: notice.attempts,
    });
  }
}

// -----------------------------------------------------------------------------
// Running the sender
// -----------------------------------------------------------------------------

/** Notice ids already logged as held by this process, so each is logged once. */
const heldLogged = new Set<string>();

function logHeldOnce(clinicId: string, noticeId: string, kind: NoticeKind): void {
  if (heldLogged.has(noticeId)) return;
  if (heldLogged.size > 10_000) heldLogged.clear();
  heldLogged.add(noticeId);
  log.info("notice held: its kind has no template yet", { clinicId, noticeId, kind });
}

async function isSwitchedOn(): Promise<boolean> {
  return (await getJob(JOB_BILLING_NOTICES))?.enabled === true;
}

/** The sender itself, without the switch: the job and the helpers below read it first. */
async function runSender(options: SendPendingNoticesOptions): Promise<NoticeRunSummary> {
  const summary: NoticeRunSummary = { sent: 0, failed: 0, skipped: 0, held: 0 };
  const now = options.now ?? new Date();
  const lookup = options.templates ?? templateFor;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const kinds = options.kinds ?? NOTICE_KINDS;
  const sendable = templatedNoticeKinds(kinds, lookup);
  const unsendable = kinds.filter((kind) => !sendable.includes(kind));

  const find = (which: readonly NoticeKind[]) =>
    options.clinicId
      ? dueNoticesOf(options.clinicId, which, now, limit)
      : pendingNotices(which, limit).then((rows) =>
          rows.filter((row) => row.sendAfter.getTime() <= now.getTime()),
        );

  for (const notice of await find(unsendable)) {
    summary.held += 1;
    logHeldOnce(notice.clinicId, notice.id, notice.kind);
  }

  for (const notice of await find(sendable)) {
    try {
      const outcome = await deliverNotice(notice.clinicId, notice.id, {
        now,
        transport: options.transport,
        templates: lookup,
      });
      if (outcome === "sent") summary.sent += 1;
      else if (outcome === "retrying" || outcome === "dead") summary.failed += 1;
      else if (outcome === "held") summary.held += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      log.error("notice delivery failed", {
        clinicId: notice.clinicId,
        noticeId: notice.id,
        error: describeError(error),
      });
    }
  }
  return summary;
}

/**
 * Deliver due notices now, behind the sender's switch. F0's signature, kept:
 * Package C may call it with `clinicId` after a Stripe event. Never throws;
 * returns counts, with `held` for notices whose kind has no template yet.
 */
export async function sendPendingNotices(
  options: SendPendingNoticesOptions = {},
): Promise<NoticeRunSummary> {
  try {
    if (!(await isSwitchedOn())) return { sent: 0, failed: 0, skipped: 0, held: 0 };
    return await runSender(options);
  } catch (error) {
    log.error("notices sender failed", { error: describeError(error) });
    return { sent: 0, failed: 0, skipped: 0, held: 0 };
  }
}

/** One clinic's due CRITICAL notices, now. Never throws. */
export async function sendCriticalNotices(
  clinicId: string,
  options: DeliverOptions = {},
): Promise<NoticeRunSummary> {
  return sendPendingNotices({ ...options, clinicId, kinds: CRITICAL_NOTICE_KINDS });
}

/**
 * The call a writer makes once its transaction has committed, for a clinic
 * that may have a critical notice queued (pass the BILLING clinic, which is
 * where enqueueNotice put it):
 *
 *     // in a route handler, so the response does not wait for Resend:
 *     import { after } from "next/server";
 *     deliverCriticalAfterCommit(clinicId, { after });
 *
 *     // anywhere else (the worker, the voice process), a plain promise:
 *     await deliverCriticalAfterCommit(clinicId);
 *
 * Never call it inside the transaction: a notice sent before commit is a
 * notice about something that may yet roll back. Whatever it misses, the
 * minute queue sends. Never rejects.
 */
export function deliverCriticalAfterCommit(
  clinicId: string,
  options: DeliverOptions & { after?: (task: () => Promise<void>) => void } = {},
): Promise<void> {
  const { after, ...deliver } = options;
  const task = async (): Promise<void> => {
    await sendCriticalNotices(clinicId, deliver);
  };
  if (after) {
    try {
      after(task);
      return Promise.resolve();
    } catch {
      // Outside a request scope after() throws; send now instead.
    }
  }
  return task();
}

/**
 * The `notices` queue's job, every minute: the switch, every due notice, and
 * the late-critical check. Replaces F0's hourly backstop.
 */
export async function runBillingNoticesJob(options: DeliverOptions = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_BILLING_NOTICES,
    async () => {
      const summary = await runSender({ ...options, now });
      const late = await lateCriticalNotices(now);
      await alertLateCriticalNotices(late);
      return (
        `${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} waiting or skipped` +
        (summary.held ? `, ${summary.held} held (no template yet)` : "") +
        (late.length ? `, ${late.length} critical late` : "") +
        "."
      );
    },
    now,
  );
}
