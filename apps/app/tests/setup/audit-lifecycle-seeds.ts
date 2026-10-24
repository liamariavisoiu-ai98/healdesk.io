import { getMigratorPool } from "./db";
import { inTenant } from "./factories";

/**
 * Rows the audits lane and the lifecycle watch write, seeded directly in the
 * clinic's tenant for the strip's and Home's tests (lane A4): a change, a
 * stored audit, the watch's row and a ledger wave. Synthetic values only.
 */

export async function seedChange(
  clinicId: string,
  options: { auditStatus?: string | null; changedAt?: Date; seenAt?: Date | null } = {},
): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into clinic_change_events
         (clinic_id, kind, source, actor_kind, changed_at, audit_status, ops_acknowledged_at, ops_acknowledged_by)
       values ($1, 'hours', 'portal', 'clinic_signin', $2, $3, $4, case when $4::timestamptz is null then null else 'ops@healdesk.test' end)
       returning id`,
      [clinicId, options.changedAt ?? new Date(), options.auditStatus ?? null, options.seenAt ?? null],
    );
    return rows[0]!.id;
  });
}

export async function seedAudit(
  clinicId: string,
  pack: "availability" | "roster" | "golive" | "transcripts",
  result: "pass" | "warn" | "fail" | "error",
  startedAt: Date = new Date(),
): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into clinic_audits (clinic_id, pack, trigger, result, checks, requested_by, started_at)
       values ($1, $2, 'scheduled', $3, $4::jsonb, 'clinic-audits', $5)`,
      [clinicId, pack, result, JSON.stringify([{ id: `${pack}_check`, result, hint: null, counts: {} }]), startedAt],
    ),
  );
}

export async function seedLifecycleRow(
  clinicId: string,
  row: {
    stage?: string;
    stageSince?: Date;
    stepsLeft?: number;
    channelsWaiting?: number;
    lastProgressAt?: Date | null;
    deadlineAt?: Date | null;
    decision?: string;
    snoozedUntil?: Date | null;
  } = {},
): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into clinic_lifecycle (clinic_id, stage, stage_since, steps_left, channels_waiting, last_progress_at, deadline_at, decision, snoozed_until, snoozed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $9::timestamptz is null then null else 'ops@healdesk.test' end)`,
      [
        clinicId,
        row.stage ?? "in_setup",
        row.stageSince ?? new Date(),
        row.stepsLeft ?? 0,
        row.channelsWaiting ?? 0,
        row.lastProgressAt ?? null,
        row.deadlineAt ?? null,
        row.decision ?? "none",
        row.snoozedUntil ?? null,
      ],
    ),
  );
}

export async function seedWave(
  clinicId: string,
  wave: string,
  options: { target?: "clinic_email" | "ops_email" | "slack"; queuedAt?: Date; opsAlertId?: string | null; escalated?: boolean } = {},
): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into lifecycle_waves (clinic_id, stage, wave, target, queued_at, ops_alert_id, escalated)
       values ($1, 'in_setup', $2, $3, $4, $5, $6)`,
      [clinicId, wave, options.target ?? "clinic_email", options.queuedAt ?? new Date(), options.opsAlertId ?? null, options.escalated ?? false],
    ),
  );
}

export async function setClinicAudits(enabled: boolean): Promise<void> {
  await getMigratorPool().query(`update scheduled_jobs set enabled = $1 where name = 'clinic-audits'`, [enabled]);
}

/** A setup reminder in the outbox, as the setup-reminders job queues it (dedupe `setup_reminder:<n>`). */
export async function seedReminder(clinicId: string, dedupeKey: string, createdAt: Date): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at) values ($1, 'setup_reminder', $2, '{}'::jsonb, $3)`,
      [clinicId, dedupeKey, createdAt],
    ),
  );
}
