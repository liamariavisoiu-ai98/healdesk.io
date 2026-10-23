import { sql } from "drizzle-orm";

import type { LifecycleStage, LifecycleTarget } from "@/db/schema";
import { MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { SLACK_MAX_ATTEMPTS } from "@/lib/ops/slack";
import type { TenantTx } from "@/lib/tenant";

import type { ClinicWave, WaveOutcome } from "./waves";

/**
 * The reminder ledger as the admin reads it: each wave with its outcome read
 * from where it was sent, never copied. A clinic reminder's from its notice
 * and the notice's delivery row (report_deliveries, period_key = the
 * notice's id), as Resend's webhook stamped it; an ops wave's from its alert
 * (ops_alerts): the email's send for the ops address, the Slack post for
 * Slack. Only `skipped` is stored on the wave itself.
 */

export type LedgerWave = {
  id: string;
  stage: LifecycleStage;
  wave: string;
  target: LifecycleTarget;
  noticeId: string | null;
  opsAlertId: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  outcome: WaveOutcome;
  /** Resend's message id for an email; null for Slack (a webhook gives none). */
  providerId: string | null;
  escalated: boolean;
  manualBy: string | null;
  /** Ours only: why a wave was skipped. Never a provider's error text. */
  error: string | null;
};

type Row = {
  id: string;
  stage: LifecycleStage;
  wave: string;
  target: LifecycleTarget;
  notice_id: string | null;
  ops_alert_id: string | null;
  queued_at: Date | string;
  escalated: boolean;
  manual_by: string | null;
  error: string | null;
  delivery: string | null;
  notice_sent_at: Date | string | null;
  notice_attempts: number | null;
  rd_status: string | null;
  rd_message_id: string | null;
  rd_delivery_status: string | null;
  alert_sent_at: Date | string | null;
  alert_message_id: string | null;
  alert_error: string | null;
  slack_posted_at: Date | string | null;
  slack_attempts: number | null;
};

/** The provider's statuses that mean the reminder will not arrive. */
const BOUNCED: ReadonlySet<string> = new Set(["bounced", "complained", "suppressed"]);

function at(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function outcomeOf(row: Row): {
  outcome: WaveOutcome;
  sentAt: Date | null;
  providerId: string | null;
} {
  if (row.delivery === "skipped") return { outcome: "skipped", sentAt: null, providerId: null };
  if (row.target === "clinic_email") {
    const sentAt = at(row.notice_sent_at);
    const providerId = row.rd_message_id;
    // Resend's later word (report_deliveries.delivery_status): delivered;
    // a permanent failure (bounced, complained, suppressed); or only that
    // it was sent or delayed, which is not a failure.
    const said = row.rd_delivery_status;
    if (said === "delivered") return { outcome: "delivered", sentAt, providerId };
    if (said !== null && BOUNCED.has(said)) return { outcome: "bounced", sentAt, providerId };
    if (
      row.rd_status === "failed" ||
      (!sentAt && (row.notice_attempts ?? 0) >= MAX_NOTICE_ATTEMPTS)
    ) {
      return { outcome: "failed", sentAt, providerId };
    }
    return { outcome: sentAt ? "sent" : "pending", sentAt, providerId };
  }
  if (row.target === "slack") {
    const posted = at(row.slack_posted_at);
    if (posted) return { outcome: "delivered", sentAt: posted, providerId: null };
    if ((row.slack_attempts ?? 0) >= SLACK_MAX_ATTEMPTS)
      return { outcome: "failed", sentAt: null, providerId: null };
    return { outcome: "pending", sentAt: null, providerId: null };
  }
  const sent = at(row.alert_sent_at);
  if (sent) return { outcome: "sent", sentAt: sent, providerId: row.alert_message_id };
  if (row.alert_error) return { outcome: "failed", sentAt: null, providerId: null };
  return { outcome: "pending", sentAt: null, providerId: null };
}

/** One clinic's ledger, oldest first, inside its tenant. */
export async function readLedger(tx: TenantTx): Promise<LedgerWave[]> {
  const result = await tx.db.execute<Row>(sql`
    select w.id, w.stage, w.wave, w.target, w.notice_id, w.ops_alert_id, w.queued_at,
           w.escalated, w.manual_by, w.error, w.delivery,
           n.sent_at as notice_sent_at, n.attempts as notice_attempts,
           d.status as rd_status, d.message_id as rd_message_id,
           d.delivery_status as rd_delivery_status,
           a.sent_at as alert_sent_at, a.message_id as alert_message_id,
           a.last_error as alert_error, a.slack_posted_at, a.slack_attempts
      from lifecycle_waves w
      left join billing_notices n on n.id = w.notice_id and n.clinic_id = w.clinic_id
      left join lateral (
        select r.status, r.message_id, r.delivery_status
          from report_deliveries r
         where r.clinic_id = w.clinic_id and r.kind = n.kind and r.period_key = n.id::text
         order by r.attempted_at desc
         limit 1
      ) d on true
      left join ops_alerts a on a.id = w.ops_alert_id
     where w.clinic_id = ${tx.clinicId}
     order by w.queued_at, w.id
  `);
  return result.rows.map((row) => {
    const { outcome, sentAt, providerId } = outcomeOf(row);
    return {
      id: row.id,
      stage: row.stage,
      wave: row.wave,
      target: row.target,
      noticeId: row.notice_id,
      opsAlertId: row.ops_alert_id,
      queuedAt: new Date(row.queued_at),
      sentAt,
      outcome,
      providerId,
      escalated: row.escalated,
      manualBy: row.manual_by,
      error: row.error,
    };
  });
}

/** The clinic's reminders in the ledger, oldest first, as the waves read them. */
export function clinicWavesOf(ledger: readonly LedgerWave[]): ClinicWave[] {
  return ledger
    .filter((w) => w.target === "clinic_email" && w.noticeId !== null)
    .map((w) => ({
      wave: w.wave,
      noticeId: w.noticeId!,
      numbered: /^setup_reminder:\d+$/.test(w.wave),
      sentAt: w.sentAt,
      queuedAt: w.queuedAt,
      stage: w.stage,
      outcome: w.outcome,
    }));
}
