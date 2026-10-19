import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * I2, the 07:00 ops digest (Annex X5), to HEALDESK_OPS_EMAIL.
 *
 * What ops reads each morning, ids and counts only: every queue with the age
 * of its oldest item, email health per kind over the last 24 hours, connection
 * health, and Resend's daily count with the free plan's limit beside it. It
 * links nowhere, like I1: the console is on the marketing site's origin, and
 * an email from apps/app links only to apps/app's own (X1.6).
 *
 * Nothing in it is about a patient. A queue is a count and an age; a
 * connection is a clinic's id, the connection's id, the provider and a
 * condition; the targets are Resend's (X8).
 */

export type DigestQueueRow = {
  /** The queue's name: a fixed word, or `pgboss:<queue>`. */
  kind: string;
  count: number;
  /** Minutes since the oldest item was queued, or null when the queue is empty. */
  oldestMinutes: number | null;
};

export type DigestEmailRow = {
  kind: string;
  sentCount: number;
  failedCount: number;
  bouncedCount: number;
  complainedCount: number;
  suppressedCount: number;
  /** Outbox notices that used every attempt, queued in the last seven days. */
  deadCount: number;
};

export type DigestConnectionRow = {
  clinicId: string;
  connectionId: string;
  provider: string;
  /** revoked, stale or stuck (lib/scheduler/connection-health.ts). */
  status: string;
};

export type DigestCalendarRow = { status: string; count: number };

export type OpsDigestPayload = {
  windowStart: string;
  windowEnd: string;
  queueRows: DigestQueueRow[];
  emailRows: DigestEmailRow[];
  connectionRows: DigestConnectionRow[];
  /** Findings past the rows shown. */
  moreConnectionsCount: number;
  calendarRows: DigestCalendarRow[];
  /** Resend's count for the UTC day that ended at midnight, and for today so far. */
  emailsYesterdayCount: number | null;
  emailsTodayCount: number | null;
  hasQuotaWarning: boolean;
  /** Permanent bounces and complaints as a share of the window's sends, or null with none sent. */
  bouncePercent: number | null;
  complaintPercent: number | null;
  hasRateWarning: boolean;
  /** Sources or clinics that could not be read; the digest went without them. */
  unreadCount: number;
};

/** Resend's free plan stops at 100 a day; the alarm is at 70 (Annex X2). */
export const DIGEST_QUOTA_WARNING_AT = 70;
/** Targets shown in the digest (Annex X8): Resend pauses a team at 0.08% complaints. */
export const COMPLAINT_TARGET_PERCENT = 0.05;
export const BOUNCE_TARGET_PERCENT = 2;

function age(minutes: number | null): string {
  if (minutes === null) return "empty";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (24 * 60))} days`;
}

function count(value: number | null): string {
  return value === null ? "not reported" : String(value);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function percent(value: number | null): string {
  return value === null ? "nothing sent" : `${value.toFixed(2)}%`;
}

export const renderOpsDigest: EmailTemplate<OpsDigestPayload> = (payload, ctx) => {
  const waiting = payload.queueRows.filter((q) => q.count > 0);
  const day = payload.windowEnd.slice(0, 10);
  const warnings: string[] = [];
  if (payload.hasQuotaWarning) {
    warnings.push(
      `Resend's daily count reached ${DIGEST_QUOTA_WARNING_AT}. The free plan stops every email at 100 until midnight UTC, sign-in links and urgent alerts included: move the account to Pro.`,
    );
  }
  if (payload.hasRateWarning) {
    warnings.push(
      `Bounces or complaints are over target (hard bounces under ${BOUNCE_TARGET_PERCENT}%, complaints under ${COMPLAINT_TARGET_PERCENT}%; Resend pauses a team at 0.08%). Look at the kinds below.`,
    );
  }
  if (payload.unreadCount > 0) {
    warnings.push(
      `${payload.unreadCount} source(s) could not be read, so this digest is missing them. apps/app's error lines for the ops digest name each.`,
    );
  }

  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `The morning's view of healdesk's queues, email and connections, for the 24 hours to ${payload.windowEnd.replace("T", " ").slice(0, 16)} UTC. Ids and counts only: look them up in the ops console.`,
    },
    ...(warnings.length > 0 ? [{ type: "list" as const, items: warnings }] : []),
    { type: "paragraph", text: "Email sent through Resend, the whole account (both apps):" },
    {
      type: "facts",
      rows: [
        ["Yesterday (UTC)", count(payload.emailsYesterdayCount)],
        ["Today so far", count(payload.emailsTodayCount)],
        [
          "Hard bounces",
          `${percent(payload.bouncePercent)} (target under ${BOUNCE_TARGET_PERCENT}%)`,
        ],
        [
          "Complaints",
          `${percent(payload.complaintPercent)} (target under ${COMPLAINT_TARGET_PERCENT}%)`,
        ],
      ],
    },
    {
      type: "paragraph",
      text:
        waiting.length > 0
          ? "Queues with something waiting, and the age of the oldest item:"
          : "Every queue is empty.",
    },
    ...(waiting.length > 0
      ? [
          {
            type: "facts" as const,
            rows: waiting.map(
              (q) => [q.kind, `${q.count} waiting, oldest ${age(q.oldestMinutes)}`] as const,
            ),
          },
        ]
      : []),
    {
      type: "paragraph",
      text:
        payload.emailRows.length > 0
          ? "Email by kind, last 24 hours (sent, failed, bounced, complaints, suppressed; dead letters over seven days):"
          : "No email was sent in the last 24 hours.",
    },
    ...(payload.emailRows.length > 0
      ? [
          {
            type: "facts" as const,
            rows: payload.emailRows.map(
              (e) =>
                [
                  e.kind,
                  `${e.sentCount} sent, ${e.failedCount} failed, ${e.bouncedCount} bounced, ${e.complainedCount} complaints, ${e.suppressedCount} suppressed, ${e.deadCount} dead`,
                ] as const,
            ),
          },
        ]
      : []),
    {
      type: "paragraph",
      text:
        payload.connectionRows.length > 0
          ? "Connections that need a look (revoked ones were alerted at once):"
          : "Every stored connection is healthy.",
    },
    ...(payload.connectionRows.length > 0
      ? [
          {
            type: "list" as const,
            items: [
              ...payload.connectionRows.map(
                (c) =>
                  `Clinic ${c.clinicId}, connection ${c.connectionId}: ${c.provider}, ${c.status}`,
              ),
              ...(payload.moreConnectionsCount > 0
                ? [`and ${payload.moreConnectionsCount} more in the console`]
                : []),
            ],
          },
        ]
      : []),
    ...(payload.calendarRows.length > 0
      ? [
          { type: "paragraph" as const, text: "Google Calendar connections, by state:" },
          {
            type: "facts" as const,
            rows: payload.calendarRows.map((c) => [c.status, String(c.count)] as const),
          },
        ]
      : []),
  ];

  const attention = waiting.length + payload.connectionRows.length + warnings.length;
  return compose(
    {
      subject: `healdesk ops digest, ${day}${attention > 0 ? `: ${attention} to look at` : ""}`,
      preheader:
        attention > 0
          ? `${plural(waiting.length, "queue")} waiting, ${plural(payload.connectionRows.length, "connection")} to check.`
          : "Queues empty, connections healthy.",
      blocks,
    },
    ctx,
  );
};

export const OPS_DIGEST_FIXTURE: OpsDigestPayload = {
  windowStart: "2026-10-05T07:00:00.000Z",
  windowEnd: "2026-10-06T07:00:00.000Z",
  queueRows: [
    { kind: "outbox", count: 2, oldestMinutes: 14 },
    { kind: "booking_requests", count: 1, oldestMinutes: 190 },
    { kind: "support_replies", count: 0, oldestMinutes: null },
    { kind: "pgboss:notices", count: 1, oldestMinutes: 1 },
  ],
  emailRows: [
    {
      kind: "payment_failed",
      sentCount: 3,
      failedCount: 0,
      bouncedCount: 1,
      complainedCount: 0,
      suppressedCount: 0,
      deadCount: 0,
    },
    {
      kind: "ops_alert",
      sentCount: 4,
      failedCount: 0,
      bouncedCount: 0,
      complainedCount: 0,
      suppressedCount: 0,
      deadCount: 0,
    },
  ],
  connectionRows: [
    {
      clinicId: "0c1d2e3f-0000-4000-8000-000000000000",
      connectionId: "9a8b7c6d-5e4f-4321-8765-0fedcba98765",
      provider: "meta-whatsapp",
      status: "revoked",
    },
  ],
  moreConnectionsCount: 0,
  calendarRows: [
    { status: "active", count: 3 },
    { status: "degraded", count: 1 },
  ],
  emailsYesterdayCount: 42,
  emailsTodayCount: 5,
  hasQuotaWarning: false,
  bouncePercent: 14.29,
  complaintPercent: 0,
  hasRateWarning: true,
  unreadCount: 0,
};

export const OPS_DIGEST_ENTRY: TemplateEntry<OpsDigestPayload> = {
  render: renderOpsDigest,
  fixture: OPS_DIGEST_FIXTURE,
};
