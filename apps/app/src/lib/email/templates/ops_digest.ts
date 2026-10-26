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
 *
 * Email health covers both apps since 19 October 2026: the ledgers, the ops
 * log, the direct kinds no ledger holds, and apps/web's mail under
 * `web:<kind>`, from the events its webhook relays. The rates are over all
 * of it, because Resend pauses the account, not one app. What apps/app still
 * cannot see is said under the table, every day, so a quiet row is never
 * read as a healthy one.
 */

/**
 * What the email-health table cannot see: apps/web's sends that never reached
 * Resend (a refusal raises no event), and any event relayed while apps/app
 * could not be reached, which apps/web does not retry.
 */
export const DIGEST_EMAIL_BLIND_SPOTS =
  "Kinds starting web: are the marketing site's mail, counted from the events Resend reports and its webhook relays here. Not counted: a marketing-site send Resend refused, which raises no event, and any event relayed while this app could not be reached.";

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

/** Production billing clinics in one lifecycle stage (`status`), and the longest stay in it. */
export type DigestLifecycleRow = { status: string; count: number; oldestDays: number };

/** Lifecycle waves queued in the window, by target (`type`) and outcome. */
export type DigestWaveRow = { type: string; outcome: string; count: number };

/** Clinics at 90% or more of an allowance, and at all of it, per meter. */
export type DigestUsageRow = { meter: string; nearCapCount: number; atCapCount: number };

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
  /**
   * /sign-in/help requests in the window for an address with no account,
   * which alert no one (lib/sign-in/help.ts): the security log has each.
   * Absent from a digest collected before 19 October 2026's follow-ups.
   */
  signInHelpNoAccountCount?: number;
  /**
   * The Lifecycle block (design E2, step 7; lib/ops/digest.ts): counts only,
   * every billing clinic but healdesk's demo one. Absent from a digest collected before 23
   * October 2026.
   */
  lifecycleRows?: DigestLifecycleRow[];
  lifecycleWaveRows?: DigestWaveRow[];
  usageRows?: DigestUsageRow[];
  decisionsOwedCount?: number;
  waitingOnUsCount?: number;
  /** Ops alerts Slack never took in the window; null while Slack is off. */
  slackUnpostedCount?: number | null;
  /**
   * The support cases (lane P7e; design E5 S7): those that need us, those of
   * them past their reply-by day, and those waiting on a clinic. Absent from
   * a digest collected before 25 October 2026.
   */
  supportNeedYouCount?: number;
  supportPastDueCount?: number;
  supportWaitingClinicCount?: number;
  /**
   * Items waiting for the owner's yes in the approval inbox, support replies
   * apart (the support line counts those). Absent from a digest collected
   * before 26 October 2026.
   */
  approvalsWaitingCount?: number;
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

const STAGE_WORDS: Readonly<Record<string, string>> = {
  not_started: "Not started",
  in_setup: "In setup",
  waiting_on_us: "Waiting on us",
  partly_live: "Partly live",
  live: "Live",
};

const TARGET_WORDS: Readonly<Record<string, string>> = {
  clinic_email: "Setup reminders to clinics",
  slack: "Slack",
  ops_email: "Ops email",
};

const METER_WORDS: Readonly<Record<string, string>> = {
  voice_minutes: "Voice minutes",
  chat_conversations: "Chat conversations",
};

/** The Lifecycle block: what needs a person, then where clinics stand, then what went out. */
function lifecycleBlocks(payload: OpsDigestPayload): Block[] {
  if (payload.lifecycleRows === undefined) return [];
  const owed = payload.decisionsOwedCount ?? 0;
  const waiting = payload.waitingOnUsCount ?? 0;
  const blocks: Block[] = [
    {
      type: "paragraph",
      text: `Lifecycle of paying clinics: ${plural(owed, "decision")} owed, ${waiting} waiting on us.`,
    },
  ];
  if (payload.lifecycleRows.length > 0) {
    blocks.push({
      type: "facts",
      rows: payload.lifecycleRows.map(
        (r) =>
          [
            STAGE_WORDS[r.status] ?? r.status,
            `${plural(r.count, "clinic")}, longest ${plural(r.oldestDays, "day")}`,
          ] as const,
      ),
    });
  }
  const waves = payload.lifecycleWaveRows ?? [];
  blocks.push({
    type: "paragraph",
    text: waves.length > 0 ? "Reminders and alerts in the last 24 hours:" : "No reminders or alerts went out in the last 24 hours.",
  });
  if (waves.length > 0) {
    blocks.push({
      type: "facts",
      rows: waves.map((w) => [`${TARGET_WORDS[w.type] ?? w.type}, ${w.outcome}`, String(w.count)] as const),
    });
  }
  const usage = payload.usageRows ?? [];
  if (usage.length > 0) {
    blocks.push({
      type: "facts",
      rows: usage.map(
        (u) =>
          [
            METER_WORDS[u.meter] ?? u.meter,
            `${plural(u.nearCapCount, "clinic")} at 90% or more, ${u.atCapCount} used up`,
          ] as const,
      ),
    });
  }
  if (payload.slackUnpostedCount === null) {
    blocks.push({ type: "paragraph", text: "Slack is off: alerts went by email only." });
  } else if ((payload.slackUnpostedCount ?? 0) > 0) {
    blocks.push({
      type: "paragraph",
      text: `${plural(payload.slackUnpostedCount ?? 0, "alert")} could not be posted to Slack after every try. Each is in the ops log.`,
    });
  }
  return blocks;
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
    ...lifecycleBlocks(payload),
    ...(payload.supportNeedYouCount === undefined
      ? []
      : [
          {
            type: "paragraph" as const,
            text: `Support: ${payload.supportNeedYouCount} need you, ${payload.supportPastDueCount ?? 0} past their day, ${payload.supportWaitingClinicCount ?? 0} waiting on a clinic.`,
          },
        ]),
    ...((payload.approvalsWaitingCount ?? 0) > 0
      ? [
          {
            type: "paragraph" as const,
            text: `Approvals: ${plural(payload.approvalsWaitingCount ?? 0, "item")} waiting for your yes. Home lists them.`,
          },
        ]
      : []),
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
    { type: "paragraph", text: DIGEST_EMAIL_BLIND_SPOTS },
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
    ...((payload.signInHelpNoAccountCount ?? 0) > 0
      ? [
          {
            type: "paragraph" as const,
            text: `Sign-in help: ${plural(payload.signInHelpNoAccountCount ?? 0, "request")} in the last 24 hours named an address with no account. Nothing was mailed for them; the security log's sign_in_help_unmatched rows have each, and many from one place are worth a look.`,
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

  const attention =
    waiting.length +
    payload.connectionRows.length +
    warnings.length +
    (payload.decisionsOwedCount ?? 0) +
    ((payload.approvalsWaitingCount ?? 0) > 0 ? 1 : 0);
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
    {
      kind: "sign_in_link",
      sentCount: 2,
      failedCount: 0,
      bouncedCount: 0,
      complainedCount: 0,
      suppressedCount: 0,
      deadCount: 0,
    },
    {
      kind: "web:nurture_1",
      sentCount: 5,
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
  bouncePercent: 7.14,
  complaintPercent: 0,
  hasRateWarning: true,
  unreadCount: 0,
  signInHelpNoAccountCount: 3,
  lifecycleRows: [
    { status: "in_setup", count: 2, oldestDays: 12 },
    { status: "waiting_on_us", count: 1, oldestDays: 1 },
    { status: "live", count: 4, oldestDays: 40 },
  ],
  lifecycleWaveRows: [
    { type: "clinic_email", outcome: "delivered", count: 1 },
    { type: "slack", outcome: "delivered", count: 2 },
  ],
  usageRows: [{ meter: "voice_minutes", nearCapCount: 1, atCapCount: 0 }],
  decisionsOwedCount: 1,
  waitingOnUsCount: 1,
  slackUnpostedCount: 0,
};

export const OPS_DIGEST_ENTRY: TemplateEntry<OpsDigestPayload> = {
  render: renderOpsDigest,
  fixture: OPS_DIGEST_FIXTURE,
};
