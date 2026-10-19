import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, count, eq, gte, inArray, isNull, lt, min, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingNotices,
  billingRequests,
  bookingRequests,
  checkoutIntents,
  opsAlerts,
  reportDeliveries,
  stripeConnectEvents,
  transcriptEmails,
} from "@/db/schema";
import { MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { dailyEmailCount, quotaDay } from "@/lib/email/quota";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { OPS_REASON } from "@/lib/email/templates/context";
import {
  BOUNCE_TARGET_PERCENT,
  COMPLAINT_TARGET_PERCENT,
  DIGEST_QUOTA_WARNING_AT,
  renderOpsDigest,
  type DigestCalendarRow,
  type DigestConnectionRow,
  type DigestEmailRow,
  type DigestQueueRow,
  type OpsDigestPayload,
} from "@/lib/email/templates/ops_digest";
import { describeError, log } from "@/lib/log";
import { findUnhealthyConnections, readConnectionHealth } from "@/lib/scheduler/connection-health";
import { JOB_OPS_DIGEST, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { listSupportRequests } from "./support-replies";

/**
 * I2, the 07:00 ops digest (Annex X5; WP5).
 *
 * Once a UTC day, from the hourly tick at 07 UTC or the first tick after it,
 * to HEALDESK_OPS_EMAIL (falling back to HEALDESK_ADMIN_EMAIL, as notifyOps
 * does), carrying ids and counts only:
 *
 *   - every queue, with the age of its oldest item: pg-boss's own queues,
 *     the outbox, the transcript outbox, billing requests, billing and
 *     Connect events retrying or parked, booking requests waiting on a
 *     clinic, paid orders without an account, support replies owed, and ops
 *     alerts that could not be emailed;
 *   - email health per kind over the last 24 hours: sent, failed, bounced,
 *     complaints and suppressed from the ledger and the webhook's events,
 *     and the outbox's dead letters over seven days; I1's own sends from the
 *     ops log;
 *   - connection health: every finding of the connection-health watchdog
 *     (lib/scheduler/connection-health.ts), whose own email this replaced,
 *     and Google Calendar connections counted by state;
 *   - Resend's daily count from email_daily_quota (dailyEmailCount): the UTC
 *     day that just ended and today so far, with a warning at 70.
 *
 * Its state is a row in the ops log (ops_alerts, event `ops_digest`, key
 * `day=<UTC date>`), as Annex X3 keeps a kind with no clinic on its own row:
 * claimed under an advisory lock so two processes send one digest, keyed
 * `hd-ops_digest-<row id>-<attempt>`, and retried by the next tick until it
 * goes, at most DIGEST_MAX_ATTEMPTS times a day. Each attempt counts afresh,
 * so the key carries the attempt.
 *
 * Every tenant read runs in that clinic's own transaction; booking requests
 * are counted with an audit row, because they are a patient's. A clinic or a
 * source that cannot be read is logged, left out and counted, and the digest
 * still goes.
 */

export const DIGEST_HOUR_UTC = 7;
export const DIGEST_MAX_ATTEMPTS = 5;
const DIGEST_EVENT = "ops_digest";
const MAX_CONNECTION_ROWS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEAD_LETTER_DAYS = 7;
const ACTOR = { type: "service", serviceName: "ops-digest" } as const;

type QueueTotal = { count: number; oldest: Date | null };
type EmailTotal = Omit<DigestEmailRow, "kind">;

function emptyEmail(): EmailTotal {
  return {
    sentCount: 0,
    failedCount: 0,
    bouncedCount: 0,
    complainedCount: 0,
    suppressedCount: 0,
    deadCount: 0,
  };
}

class Tally {
  readonly queues = new Map<string, QueueTotal>();
  readonly emails = new Map<string, EmailTotal>();
  unread = 0;

  queue(kind: string, n: number, oldest: Date | string | null | undefined): void {
    const at = oldest ? new Date(oldest) : null;
    const seen = this.queues.get(kind) ?? { count: 0, oldest: null };
    seen.count += n;
    if (at && n > 0 && (!seen.oldest || at < seen.oldest)) seen.oldest = at;
    this.queues.set(kind, seen);
  }

  email(kind: string, add: Partial<EmailTotal>): void {
    const seen = this.emails.get(kind) ?? emptyEmail();
    for (const [key, value] of Object.entries(add) as [keyof EmailTotal, number][]) {
      seen[key] += Number(value ?? 0);
    }
    this.emails.set(kind, seen);
  }

  /** Read one source; a failure is logged, counted and left out. */
  async read(source: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.unread += 1;
      log.error("ops digest source unreadable", { resource: source, error: describeError(error) });
    }
  }
}

/** The queues every digest names, empty or not, in this order. pg-boss's follow. */
const QUEUES = [
  "outbox",
  "transcript_emails",
  "billing_requests",
  "billing_events_retrying",
  "billing_events_parked",
  "connect_events_retrying",
  "connect_events_parked",
  "booking_requests",
  "orders_without_account",
  "support_replies",
  "ops_alerts_unsent",
] as const;

/** Everything the digest says at `now`. Never throws on a source that cannot be read. */
export async function collectDigest(now: Date = new Date()): Promise<OpsDigestPayload> {
  const since = new Date(now.getTime() - DAY_MS);
  const tally = new Tally();
  for (const kind of QUEUES) tally.queue(kind, 0, null);

  await tally.read("pgboss", async () => {
    const result = await unsafeDb.execute<{
      name: string;
      n: number | string;
      oldest: Date | string;
    }>(
      sql`select name, count(*) as n, min(created_on) as oldest
            from pgboss.job
           where state in ('created', 'retry') and start_after <= ${now}
           group by name order by name`,
    );
    for (const row of (result as unknown as { rows: Record<string, unknown>[] }).rows) {
      tally.queue(`pgboss:${String(row.name)}`, Number(row.n), row.oldest as string);
    }
  });

  // The identity-plane ledgers: no tenant.
  await tally.read("billing_events", async () => {
    for (const [kind, outcome] of [
      ["billing_events_retrying", "failed"],
      ["billing_events_parked", "dead_letter"],
    ] as const) {
      const [row] = await unsafeDb
        .select({ n: count(), oldest: min(billingEvents.receivedAt) })
        .from(billingEvents)
        .where(eq(billingEvents.outcome, outcome));
      tally.queue(kind, row?.n ?? 0, row?.oldest);
    }
  });
  await tally.read("stripe_connect_events", async () => {
    for (const [kind, outcome] of [
      ["connect_events_retrying", "failed"],
      ["connect_events_parked", "dead_letter"],
    ] as const) {
      const [row] = await unsafeDb
        .select({ n: count(), oldest: min(stripeConnectEvents.receivedAt) })
        .from(stripeConnectEvents)
        .where(eq(stripeConnectEvents.outcome, outcome));
      tally.queue(kind, row?.n ?? 0, row?.oldest);
    }
  });
  await tally.read("checkout_intents", async () => {
    const [row] = await unsafeDb
      .select({ n: count(), oldest: min(checkoutIntents.paidSeenAt) })
      .from(checkoutIntents)
      .where(
        and(sql`${checkoutIntents.paidSeenAt} is not null`, isNull(checkoutIntents.consumedAt)),
      );
    tally.queue("orders_without_account", row?.n ?? 0, row?.oldest);
  });
  await tally.read("ops_alerts", async () => {
    const [unsent] = await unsafeDb
      .select({ n: count(), oldest: min(opsAlerts.raisedAt) })
      .from(opsAlerts)
      .where(
        and(
          ne(opsAlerts.event, DIGEST_EVENT),
          isNull(opsAlerts.sentAt),
          sql`${opsAlerts.lastError} is not null`,
          gte(opsAlerts.raisedAt, new Date(now.getTime() - DEAD_LETTER_DAYS * DAY_MS)),
        ),
      );
    tally.queue("ops_alerts_unsent", unsent?.n ?? 0, unsent?.oldest);
    // I1's own sends, which have no ledger row: its state is the ops log.
    const [sent] = await unsafeDb
      .select({ n: count() })
      .from(opsAlerts)
      .where(and(ne(opsAlerts.event, DIGEST_EVENT), gte(opsAlerts.sentAt, since)));
    const [failed] = await unsafeDb
      .select({ n: count() })
      .from(opsAlerts)
      .where(
        and(
          ne(opsAlerts.event, DIGEST_EVENT),
          isNull(opsAlerts.sentAt),
          sql`${opsAlerts.lastError} is not null`,
          gte(opsAlerts.raisedAt, since),
        ),
      );
    if ((sent?.n ?? 0) + (failed?.n ?? 0) > 0) {
      tally.email("ops_alert", { sentCount: sent?.n ?? 0, failedCount: failed?.n ?? 0 });
    }
  });

  await tally.read("support_replies", async () => {
    const { rows, failures } = await listSupportRequests(now);
    const owed = rows.filter((r) => r.repliedAt === null);
    tally.queue(
      "support_replies",
      owed.length,
      owed.reduce<Date | null>((o, r) => (!o || r.askedAt < o ? r.askedAt : o), null),
    );
    tally.unread += failures;
  });

  // Each clinic's own rows, in its own tenant.
  const clinics = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where destroyed_at is null`,
  );
  for (const { id } of (clinics as unknown as { rows: { id: string }[] }).rows) {
    await tally.read(`clinic ${String(id)}`, () =>
      withTenant({ clinicId: String(id), actor: ACTOR }, (tx) => readClinic(tx, tally, now, since)),
    );
  }

  // Connection health: the watchdog's findings, and the calendar by state.
  let connectionRows: DigestConnectionRow[] = [];
  let moreConnectionsCount = 0;
  const calendarRows: DigestCalendarRow[] = [];
  await tally.read("connections", async () => {
    const findings = await findUnhealthyConnections(now);
    connectionRows = findings.slice(0, MAX_CONNECTION_ROWS).map((f) => ({
      clinicId: f.clinicId,
      connectionId: f.connectionId,
      provider: f.provider,
      status: f.condition,
    }));
    moreConnectionsCount = Math.max(0, findings.length - MAX_CONNECTION_ROWS);
    const byStatus = new Map<string, number>();
    for (const row of await readConnectionHealth()) {
      if (row.provider !== GOOGLE_CALENDAR_PROVIDER) continue;
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    }
    for (const [status, n] of [...byStatus].sort(([a], [b]) => a.localeCompare(b))) {
      calendarRows.push({ status, count: n });
    }
  });

  let emailsYesterdayCount: number | null = null;
  let emailsTodayCount: number | null = null;
  await tally.read("email_daily_quota", async () => {
    emailsYesterdayCount = await dailyEmailCount(quotaDay(new Date(now.getTime() - DAY_MS)));
    emailsTodayCount = await dailyEmailCount(quotaDay(now));
  });

  const queueRows: DigestQueueRow[] = [...tally.queues].map(([kind, q]) => ({
    kind,
    count: q.count,
    oldestMinutes: q.oldest
      ? Math.max(0, Math.round((now.getTime() - q.oldest.getTime()) / 60_000))
      : null,
  }));
  const emailRows: DigestEmailRow[] = [...tally.emails]
    .filter(([, e]) => Object.values(e).some((n) => n > 0))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, e]) => ({ kind, ...e }));

  const sent = emailRows.reduce((n, e) => n + e.sentCount, 0);
  const bounced = emailRows.reduce((n, e) => n + e.bouncedCount, 0);
  const complained = emailRows.reduce((n, e) => n + e.complainedCount, 0);
  const bouncePercent = sent > 0 ? round2((bounced / sent) * 100) : null;
  const complaintPercent = sent > 0 ? round2((complained / sent) * 100) : null;
  const quotaSeen = Math.max(emailsYesterdayCount ?? 0, emailsTodayCount ?? 0);

  return {
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    queueRows,
    emailRows,
    connectionRows,
    moreConnectionsCount,
    calendarRows,
    emailsYesterdayCount,
    emailsTodayCount,
    hasQuotaWarning: quotaSeen >= DIGEST_QUOTA_WARNING_AT,
    bouncePercent,
    complaintPercent,
    hasRateWarning:
      (bouncePercent ?? 0) >= BOUNCE_TARGET_PERCENT ||
      (complaintPercent ?? 0) >= COMPLAINT_TARGET_PERCENT,
    unreadCount: tally.unread,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One clinic's queues and email, counted inside its tenant. */
async function readClinic(tx: TenantTx, tally: Tally, now: Date, since: Date): Promise<void> {
  const c = tx.clinicId;

  const [outbox] = await tx.db
    .select({ n: count(), oldest: min(billingNotices.createdAt) })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, c),
        isNull(billingNotices.sentAt),
        lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
      ),
    );
  tally.queue("outbox", outbox?.n ?? 0, outbox?.oldest);

  const dead = await tx.db
    .select({ kind: billingNotices.kind, n: count() })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, c),
        isNull(billingNotices.sentAt),
        gte(billingNotices.attempts, MAX_NOTICE_ATTEMPTS),
        gte(billingNotices.createdAt, new Date(now.getTime() - DEAD_LETTER_DAYS * DAY_MS)),
      ),
    )
    .groupBy(billingNotices.kind);
  for (const row of dead) tally.email(row.kind, { deadCount: row.n });

  const [transcripts] = await tx.db
    .select({ n: count(), oldest: min(transcriptEmails.createdAt) })
    .from(transcriptEmails)
    .where(
      and(
        eq(transcriptEmails.clinicId, c),
        inArray(transcriptEmails.status, ["pending", "sent", "bounced"]),
      ),
    );
  tally.queue("transcript_emails", transcripts?.n ?? 0, transcripts?.oldest);

  const [requests] = await tx.db
    .select({ n: count(), oldest: min(billingRequests.requestedAt) })
    .from(billingRequests)
    .where(and(eq(billingRequests.clinicId, c), isNull(billingRequests.doneAt)));
  tally.queue("billing_requests", requests?.n ?? 0, requests?.oldest);

  const [bookings] = await tx.db
    .select({ n: count(), oldest: min(bookingRequests.createdAt) })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, c), eq(bookingRequests.status, "requested")));
  tally.queue("booking_requests", bookings?.n ?? 0, bookings?.oldest);
  tx.audit.record({
    action: "read",
    resourceType: "booking_request",
    resultCount: bookings?.n ?? 0,
    metadata: { purpose: "ops_digest" },
  });

  const ledger = await tx.db
    .select({
      kind: reportDeliveries.kind,
      sentCount: sql<number>`count(*) filter (where ${reportDeliveries.status} = 'sent' and ${reportDeliveries.attemptedAt} >= ${since})`,
      failedCount: sql<number>`count(*) filter (where ${reportDeliveries.status} = 'failed' and ${reportDeliveries.attemptedAt} >= ${since})`,
      bouncedCount: sql<number>`count(*) filter (where ${reportDeliveries.deliveryStatus} = 'bounced' and ${reportDeliveries.deliveryAt} >= ${since})`,
      complainedCount: sql<number>`count(*) filter (where ${reportDeliveries.deliveryStatus} = 'complained' and ${reportDeliveries.deliveryAt} >= ${since})`,
      suppressedCount: sql<number>`count(*) filter (where ${reportDeliveries.deliveryStatus} = 'suppressed' and ${reportDeliveries.deliveryAt} >= ${since})`,
    })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.clinicId, c),
        sql`(${reportDeliveries.attemptedAt} >= ${since} or ${reportDeliveries.deliveryAt} >= ${since})`,
      ),
    )
    .groupBy(reportDeliveries.kind);
  for (const row of ledger) {
    tally.email(row.kind, {
      sentCount: Number(row.sentCount),
      failedCount: Number(row.failedCount),
      bouncedCount: Number(row.bouncedCount),
      complainedCount: Number(row.complainedCount),
      suppressedCount: Number(row.suppressedCount),
    });
  }
}

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

/** Where the digest goes: ops, as notifyOps sends. Never a clinic's address. */
function opsAddress(): string | null {
  const configured =
    process.env.HEALDESK_OPS_EMAIL?.trim() || process.env.HEALDESK_ADMIN_EMAIL?.trim();
  return configured ? configured : null;
}

type Claim = { id: string; attempt: number } | "sent" | "spent";

/** Today's digest row: claimed for one more attempt, or already sent, or out of attempts. */
async function claimDigest(day: string, now: Date): Promise<Claim> {
  const key = `day=${day}`;
  return unsafeDb.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ops_alert|${DIGEST_EVENT}|${key}`}, 0))`,
    );
    const [row] = await tx
      .select({ id: opsAlerts.id, sentAt: opsAlerts.sentAt, repeats: opsAlerts.repeats })
      .from(opsAlerts)
      .where(and(eq(opsAlerts.event, DIGEST_EVENT), eq(opsAlerts.dedupeKey, key)))
      .limit(1);
    if (row?.sentAt) return "sent";
    if (row) {
      const attempt = row.repeats + 2;
      if (attempt > DIGEST_MAX_ATTEMPTS) return "spent";
      await tx
        .update(opsAlerts)
        .set({ repeats: sql`${opsAlerts.repeats} + 1`, lastRaisedAt: now })
        .where(eq(opsAlerts.id, row.id));
      return { id: row.id, attempt };
    }
    const [inserted] = await tx
      .insert(opsAlerts)
      .values({
        event: DIGEST_EVENT,
        dedupeKey: key,
        fields: { windowStart: day },
        raisedAt: now,
        lastRaisedAt: now,
      })
      .returning({ id: opsAlerts.id });
    return { id: inserted!.id, attempt: 1 };
  });
}

export type DigestOutcome =
  | { status: "not_due" }
  | { status: "no_address" }
  | { status: "already_sent" }
  | { status: "out_of_attempts" }
  | { status: "sent"; attempt: number }
  | { status: "failed"; attempt: number; reason: string };

/**
 * Send today's digest if it is due and unsent: at DIGEST_HOUR_UTC or later,
 * once per UTC day. Throws only when the database does.
 */
export async function sendOpsDigest(
  now: Date = new Date(),
  options: SendEmailOptions = {},
): Promise<DigestOutcome> {
  if (now.getUTCHours() < DIGEST_HOUR_UTC) return { status: "not_due" };
  const to = opsAddress();
  if (!to) return { status: "no_address" };

  const claim = await claimDigest(quotaDay(now), now);
  if (claim === "sent") return { status: "already_sent" };
  if (claim === "spent") return { status: "out_of_attempts" };

  let outcome: DigestOutcome;
  try {
    const payload = await collectDigest(now);
    // The allowlist runs on every send, as the outbox's does: ids, counts,
    // dates and categories, or nothing goes.
    assertPayloadAllowed(payload, "ops_digest");
    const rendered = renderOpsDigest(payload, {
      clinicName: null,
      audience: "patients",
      reason: OPS_REASON,
      raisedAt: now,
      timeZone: "UTC",
    });
    const result = await sendEmail(
      {
        to,
        kind: "ops_digest",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        deliveryId: claim.id,
        idempotencyKey: `hd-ops_digest-${claim.id}-${claim.attempt}`,
      },
      { now, ...options },
    );
    if (result.status === "failed") {
      outcome = { status: "failed", attempt: claim.attempt, reason: result.reason.slice(0, 300) };
    } else {
      outcome = { status: "sent", attempt: claim.attempt };
      await unsafeDb
        .update(opsAlerts)
        // The ops log's row is written once and then only stamped: the
        // runtime role may not rewrite its fields (0046).
        .set({
          sentAt: new Date(),
          messageId: result.status === "sent" ? result.messageId : null,
          lastError: null,
        })
        .where(eq(opsAlerts.id, claim.id));
      return outcome;
    }
  } catch (error) {
    outcome = { status: "failed", attempt: claim.attempt, reason: describeError(error) };
  }
  log.warn("ops digest not sent", { attempt: claim.attempt, reason: outcome.reason });
  await unsafeDb
    .update(opsAlerts)
    .set({ lastError: outcome.reason })
    .where(eq(opsAlerts.id, claim.id));
  return outcome;
}

/** The tick's run, behind the `ops-digest` switch. */
export async function runOpsDigestJob(
  options: { now?: Date; email?: SendEmailOptions } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_OPS_DIGEST,
    async () => {
      const outcome = await sendOpsDigest(now, options.email);
      switch (outcome.status) {
        case "not_due":
          return `Not due before ${DIGEST_HOUR_UTC}:00 UTC.`;
        case "no_address":
          return "No HEALDESK_OPS_EMAIL or HEALDESK_ADMIN_EMAIL; not mailed.";
        case "already_sent":
          return "Today's digest has gone.";
        case "out_of_attempts":
          return `Today's digest failed ${DIGEST_MAX_ATTEMPTS} times; tomorrow's will try again.`;
        case "sent":
          return `Digest sent (attempt ${outcome.attempt}).`;
        case "failed":
          throw new Error(`Digest not sent (attempt ${outcome.attempt}): ${outcome.reason}`);
      }
    },
    now,
  );
}
