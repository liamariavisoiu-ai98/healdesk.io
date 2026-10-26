import { USAGE_ALERT_PERCENT } from "@healdesk/catalog";
import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, count, eq, gte, isNull, min, ne, notInArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingNotices,
  bookingRequests,
  opsAlerts,
  reportDeliveries,
  securityEvents,
} from "@/db/schema";
import { effectiveIncluded, getEntitlements } from "@/lib/billing/entitlements";
import { openWindowAt, usedOf } from "@/lib/billing/usage";
import { emailEventCounts, pruneEmailEvents } from "@/lib/email/health";
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
  type DigestLifecycleRow,
  type DigestQueueRow,
  type DigestUsageRow,
  type DigestWaveRow,
  type OpsDigestPayload,
} from "@/lib/email/templates/ops_digest";
import { readLedger } from "@/lib/lifecycle/ledger";
import { lifecycleView } from "@/lib/lifecycle/view";
import { readLifecycleRow } from "@/lib/lifecycle/watch";
import { describeError, log } from "@/lib/log";
import { findUnhealthyConnections, readConnectionHealth } from "@/lib/scheduler/connection-health";
import { JOB_OPS_DIGEST, runJob, type JobOutcome } from "@/lib/scheduler/jobs";

import { waitingItems } from "@/lib/approvals/store";

import { listClinics } from "./clinics";
import { readMachineQueues } from "./inbox/queues";
import { FLAG_ALERT_EVENT } from "./flag-alert";
import { raiseOpsAlertKeyed } from "./notify";
import { SLACK_MAX_ATTEMPTS, slackWebhookUrl } from "./slack";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { requestIdsOnCases, supportCaseCounts } from "@/lib/support/watch";

import { listSupportRequests } from "./support-replies";

/**
 * I2, the 07:00 ops digest (Annex X5; WP5).
 *
 * Once a UTC day, from the hourly tick at 07 UTC or the first tick after it,
 * to HEALDESK_OPS_EMAIL (falling back to HEALDESK_ADMIN_EMAIL, as notifyOps
 * does), carrying ids and counts only:
 *
 *   - every queue, with the age of its oldest item: the machine queues Home
 *     and the System page show, read by the same function and so the same
 *     counts and ages (lib/ops/inbox/queues.ts readMachineQueues: pg-boss's
 *     waiting and recently failed jobs, the outbox once its notices are due,
 *     the transcript outbox, billing requests, billing and Connect events
 *     retrying or parked, paid orders without an account, accounts below the
 *     agreement floor, ops alerts that could not be emailed), plus booking
 *     requests waiting on a clinic and support replies owed, which Home does
 *     not read; the approval inbox as one line (items waiting for the owner's
 *     yes, apart from support replies, which the support line counts);
 *   - email health per kind over the last 24 hours: sent, failed, bounced,
 *     complaints and suppressed from the ledger and the webhook's events,
 *     and the outbox's dead letters over seven days; I1's own sends from the
 *     ops log; and, since 19 October 2026, the mail no ledger holds, from
 *     email_events (lib/email/health.ts): the direct kinds with no ledger
 *     row, and apps/web's mail as its webhook relays Resend's events, under
 *     `web:<kind>`. The bounce and complaint rates are over all of it, the
 *     whole Resend account's, which is what Resend pauses; what still cannot
 *     be seen (an apps/web send Resend refused, events while this app was
 *     unreachable) the email says;
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
  "agreements_below_floor",
  "ops_alerts_unsent",
] as const;

/** Everything the digest says at `now`. Never throws on a source that cannot be read. */
export async function collectDigest(now: Date = new Date()): Promise<OpsDigestPayload> {
  const since = new Date(now.getTime() - DAY_MS);
  const tally = new Tally();
  for (const kind of QUEUES) tally.queue(kind, 0, null);

  // The machine queues are read by the one function Home and the System
  // page read (lib/ops/inbox/queues.ts readMachineQueues), so a count here is
  // the count they show: a notice held for later (quiet hours, a retry, a
  // reminder for tomorrow) is not waiting until it is due, a job waits from
  // when it became due, and a recently failed job is a queue of its own.
  // Dead letters and bounces stay in the email table below, by kind, so
  // they are not told twice. A part it could not read counts as unread.
  await tally.read("machine queues", async () => {
    const read = await readMachineQueues({ now, actor: ACTOR, request: {} });
    for (const [kind, q] of read.queues) {
      if (kind === "outbox_dead" || kind === "emails_undeliverable") continue;
      tally.queue(kind, q.count, q.oldest);
    }
    tally.unread += read.unread.length;
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
    // I1's own sends, and I4's (a flag's ticket), which have no ledger row:
    // their state is the ops log, each under its own kind.
    const sends = async (events: { only: string } | { except: readonly string[] }) => {
      const which =
        "only" in events
          ? eq(opsAlerts.event, events.only)
          : notInArray(opsAlerts.event, [...events.except]);
      const [sent] = await unsafeDb
        .select({ n: count() })
        .from(opsAlerts)
        .where(and(which, gte(opsAlerts.sentAt, since)));
      const [failed] = await unsafeDb
        .select({ n: count() })
        .from(opsAlerts)
        .where(
          and(
            which,
            isNull(opsAlerts.sentAt),
            sql`${opsAlerts.lastError} is not null`,
            gte(opsAlerts.raisedAt, since),
          ),
        );
      return { sentCount: sent?.n ?? 0, failedCount: failed?.n ?? 0 };
    };
    for (const [kind, events] of [
      ["ops_alert", { except: [DIGEST_EVENT, FLAG_ALERT_EVENT] }],
      ["flag_alert", { only: FLAG_ALERT_EVENT }],
    ] as const) {
      const totals = await sends(events);
      if (totals.sentCount + totals.failedCount > 0) tally.email(kind, totals);
    }
  });

  // The mail no ledger holds: the direct kinds with no ledger row, and
  // apps/web's, as its webhook relayed Resend's events (lib/email/health.ts).
  await tally.read("email_events", async () => {
    for (const { app, kind, ...counts } of await emailEventCounts(since)) {
      tally.email(app === "web" ? `web:${kind}` : kind, counts);
    }
  });

  await tally.read("support_replies", async () => {
    const { rows, failures } = await listSupportRequests(now);
    // Lane P7e: a request recorded on a support case is counted on the support line below, once.
    const onCases = await requestIdsOnCases(rows.map((r) => r.requestId));
    const owed = rows.filter((r) => r.repliedAt === null && !onCases.has(r.requestId));
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

  // /sign-in/help's requests for an address with no account, which alert no
  // one: the security log holds each (lib/sign-in/help.ts).
  let signInHelpNoAccountCount = 0;
  await tally.read("security_events", async () => {
    const [row] = await unsafeDb
      .select({ n: count() })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.event, "sign_in_help_unmatched"),
          sql`${securityEvents.metadata}->>'code' = 'no_account'`,
          gte(securityEvents.occurredAt, since),
        ),
      );
    signInHelpNoAccountCount = row?.n ?? 0;
  });

  let emailsYesterdayCount: number | null = null;
  let emailsTodayCount: number | null = null;
  await tally.read("email_daily_quota", async () => {
    emailsYesterdayCount = await dailyEmailCount(quotaDay(new Date(now.getTime() - DAY_MS)));
    emailsTodayCount = await dailyEmailCount(quotaDay(now));
  });

  const lifecycle = await collectLifecycle(tally, now, since);

  // The support cases (lane P7e; design E5 S7): "Support: N need you, M past their day, K waiting on a clinic".
  let support: Pick<OpsDigestPayload, "supportNeedYouCount" | "supportPastDueCount" | "supportWaitingClinicCount"> = {};
  await tally.read("support_cases", async () => {
    const counts = await supportCaseCounts(now);
    support = {
      supportNeedYouCount: counts.needYou,
      supportPastDueCount: counts.pastDue,
      supportWaitingClinicCount: counts.waitingClinic,
    };
  });

  // The approval inbox (Phase 6): what waits for the owner's yes, as one
  // number. A support reply waits beside its case and is counted on the
  // support line above, once.
  let approvalsWaitingCount: number | undefined;
  await tally.read("approvals", async () => {
    approvalsWaitingCount = (await waitingItems()).filter((item) => item.kind !== "support_reply_send").length;
  });

  // Ops alerts Slack never took (lib/ops/slack.ts gives up after its tries);
  // null while Slack is off, when none is posted at all.
  let slackUnpostedCount: number | null = null;
  if (slackWebhookUrl()) {
    await tally.read("ops_alerts_slack", async () => {
      const [row] = await unsafeDb
        .select({ n: count() })
        .from(opsAlerts)
        .where(
          and(
            isNull(opsAlerts.slackPostedAt),
            gte(opsAlerts.slackAttempts, SLACK_MAX_ATTEMPTS),
            gte(opsAlerts.raisedAt, since),
          ),
        );
      slackUnpostedCount = row?.n ?? 0;
    });
  }

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
    signInHelpNoAccountCount,
    ...lifecycle,
    slackUnpostedCount,
    ...support,
    ...(approvalsWaitingCount === undefined ? {} : { approvalsWaitingCount }),
  };
}

const DIGEST_LIFECYCLE_STAGES = ["not_started", "in_setup", "waiting_on_us", "partly_live", "live"] as const;
const DIGEST_METERS = ["voice_minutes", "chat_conversations"] as const;
/** Billing statuses whose clinics are served, so their usage can still grow (as lib/billing/usage-alerts.ts). */
const SERVED = new Set(["active", "past_due", "canceling"]);

type LifecycleTotals = {
  lifecycleRows: DigestLifecycleRow[];
  lifecycleWaveRows: DigestWaveRow[];
  usageRows: DigestUsageRow[];
  decisionsOwedCount: number;
  waitingOnUsCount: number;
};

/**
 * The Lifecycle block (design E2, step 7): billing clinics by
 * stage with the longest stay, the waves of the last 24 hours by target and
 * outcome, the decisions owed, and the clinics at 90% or all of an
 * allowance, per meter. Counts only, never a name. healdesk's demo clinic
 * has no lifecycle row (the watch never observes a `demo` billing row) and
 * is not served, so it is in neither count; a paying clinic still classed
 * synthetic before it goes live is counted.
 */
async function collectLifecycle(tally: Tally, now: Date, since: Date): Promise<LifecycleTotals> {
  const stages = new Map<string, { count: number; oldest: Date | null }>();
  const waves = new Map<string, number>();
  const usage = new Map<string, { near: number; at: number }>();
  let decisionsOwedCount = 0;
  let waitingOnUsCount = 0;

  let clinics: Awaited<ReturnType<typeof listClinics>> = [];
  await tally.read("lifecycle clinics", async () => {
    clinics = await listClinics();
  });
  for (const clinic of clinics) {
    if (clinic.billingClinicId || clinic.destroyedAt) continue;
    await tally.read(`lifecycle ${clinic.id}`, () =>
      withTenant({ clinicId: clinic.id, actor: ACTOR }, async (tx) => {
        const row = await readLifecycleRow(tx);
        if (row && row.stage !== "closed") {
          const ledger = await readLedger(tx);
          const view = lifecycleView(row, ledger, clinic.timezone, now);
          const seen = stages.get(row.stage) ?? { count: 0, oldest: null };
          seen.count += 1;
          if (!seen.oldest || row.stageSince < seen.oldest) seen.oldest = row.stageSince;
          stages.set(row.stage, seen);
          if (view.decisionOwed) decisionsOwedCount += 1;
          if (row.stage === "waiting_on_us") waitingOnUsCount += 1;
          for (const wave of ledger) {
            if (wave.queuedAt < since) continue;
            const key = `${wave.target}|${wave.outcome}`;
            waves.set(key, (waves.get(key) ?? 0) + 1);
          }
        }
        const entitlement = await getEntitlements(tx.db, clinic.id);
        const window = entitlement && SERVED.has(entitlement.status) ? openWindowAt(entitlement, now) : null;
        if (entitlement && window) {
          for (const meter of DIGEST_METERS) {
            const included = effectiveIncluded(entitlement, meter);
            if (included <= 0) continue;
            const used = usedOf(entitlement, meter);
            const seen = usage.get(meter) ?? { near: 0, at: 0 };
            if (used >= included) seen.at += 1;
            else if (used * 100 >= USAGE_ALERT_PERCENT * included) seen.near += 1;
            usage.set(meter, seen);
          }
        }
      }),
    );
  }

  return {
    lifecycleRows: DIGEST_LIFECYCLE_STAGES.flatMap((stage) => {
      const seen = stages.get(stage);
      if (!seen) return [];
      return [
        {
          status: stage,
          count: seen.count,
          oldestDays: seen.oldest ? Math.floor((now.getTime() - seen.oldest.getTime()) / DAY_MS) : 0,
        },
      ];
    }),
    lifecycleWaveRows: [...waves]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, n]) => {
        const [type, outcome] = key.split("|") as [string, string];
        return { type, outcome, count: n };
      }),
    usageRows: DIGEST_METERS.flatMap((meter) => {
      const seen = usage.get(meter);
      return seen && seen.near + seen.at > 0
        ? [{ meter, nearCapCount: seen.near, atCapCount: seen.at }]
        : [];
    }),
    decisionsOwedCount,
    waitingOnUsCount,
  };
}

/**
 * The digest's one line in Slack (design E2, step 7): what needs a person
 * today, as counts, once a UTC day, from the payload the email carries. Slack
 * alone: the digest itself is the email.
 */
async function postDigestSummary(day: string, payload: OpsDigestPayload): Promise<void> {
  const near = (payload.usageRows ?? []).reduce((n, r) => n + r.nearCapCount, 0);
  const at = (payload.usageRows ?? []).reduce((n, r) => n + r.atCapCount, 0);
  await raiseOpsAlertKeyed(
    "ops_digest_summary",
    {
      decisionsOwedCount: payload.decisionsOwedCount ?? 0,
      waitingOnUsCount: payload.waitingOnUsCount ?? 0,
      nearCapCount: near,
      atCapCount: at,
      // Only when some are owed (lane N3): "0 alerts Slack could not take" is noise.
      ...(payload.slackUnpostedCount != null && payload.slackUnpostedCount > 0
        ? { slackUnpostedCount: payload.slackUnpostedCount }
        : {}),
    },
    { key: `day=${day}`, email: false },
  );
}

/**
 * The day's Slack line, if the digest went and its line was not recorded:
 * counted afresh, which can differ from the morning's by what changed since.
 * Nothing is posted when the line is already in the ops log.
 */
async function ensureDigestSummary(day: string, now: Date): Promise<void> {
  try {
    const [row] = await unsafeDb
      .select({ id: opsAlerts.id })
      .from(opsAlerts)
      .where(and(eq(opsAlerts.event, "ops_digest_summary"), eq(opsAlerts.dedupeKey, `key:day=${day}`)))
      .limit(1);
    if (row) return;
    await postDigestSummary(day, await collectDigest(now));
  } catch (error) {
    log.warn("ops digest Slack line not recorded", { error: describeError(error) });
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One clinic's booking requests (a patient's, so counted with an audit row),
 * dead letters and email, inside its tenant. Its outbox, transcript copies and
 * billing requests are the shared machine-queue read's above.
 */
async function readClinic(tx: TenantTx, tally: Tally, now: Date, since: Date): Promise<void> {
  const c = tx.clinicId;

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
        // Its Slack copy is the one-line summary (ops_digest_summary), not
        // this row, which would post as a bare event name.
        slackError: "posted as ops_digest_summary",
        slackNextAt: sql`'infinity'::timestamptz`,
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
  if (claim === "sent") {
    // The email went; its Slack line may not have (the ops log was out of
    // reach then). Raised once per day by its key, so this never posts twice.
    await ensureDigestSummary(quotaDay(now), now);
    return { status: "already_sent" };
  }
  if (claim === "spent") return { status: "out_of_attempts" };

  let outcome: DigestOutcome;
  try {
    // Email health keeps a month; nothing reads further back than a day.
    await pruneEmailEvents(now);
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
        payload,
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
      // Slack's one line only once the email it summarises has gone.
      await postDigestSummary(quotaDay(now), payload);
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
