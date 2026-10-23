import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  AUDIT_PACKS,
  clinicChangeEvents,
  type AuditPack,
  type ClinicAuditRow,
  type ClinicChangeKind,
} from "@/db/schema";
import {
  clinicChangeWork,
  JOB_CLINIC_AUDITS,
  runClinicChangeAlerts,
} from "@/lib/clinic/change-events";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { runJob } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { availabilityFingerprint, latestAudit, runAuditPack, worstOf } from "./run";

/**
 * When the ops audits run by themselves (design E3 §2.1, "Triggers"):
 *
 *   - change: two minutes after a clinic's last recorded change (a queued
 *     clinic_change_events row), one audit for however many changes it made
 *     in that time, so six closed days added one by one are one audit. Every
 *     minute from the worker's billing-minute clock, and hourly from the tick
 *     as its backstop. The changes' rows are the queue: no pg-boss queue to
 *     install, and a restart loses nothing.
 *   - change_detected: hourly, a clinic whose availability fingerprint is
 *     not its last audit's, for a change no writer recorded.
 *   - scheduled: at 04 UTC, after the voice drift check at 03, every pack for
 *     every clinic still in service.
 *
 * The first behind the `clinic-audits` job row's switch and lock, at most
 * AUDITS_PER_SWEEP clinics a run; the other two behind `clinic-audits-hourly`,
 * with its own lock. Both seeded off (drizzle/0114). The ops alert for each
 * change is not switched: runClinicChangeAlerts only tells ops, as the Slack
 * sweep does. A change whose audit stopped part-way is claimed again after
 * STALE_AUDIT_MS, and after MAX_AUDIT_ATTEMPTS it is marked `error` rather
 * than left running for ever.
 */

/** The hourly fingerprint check and the 04 UTC run: their own switch and lock. */
export const JOB_CLINIC_AUDITS_HOURLY = "clinic-audits-hourly";
/** At most this many clinics are audited per minute's run; the rest wait a minute. */
export const AUDITS_PER_SWEEP = 3;
export const MAX_AUDIT_ATTEMPTS = 3;
export const STALE_AUDIT_MS = 15 * 60_000;

/** A change waits this long after the clinic's last one before its audit runs. */
export const AUDIT_DEBOUNCE_MS = 2 * 60_000;
/** The minute sweep's lock goes stale after this, not runJob's hour. */
const LOCK_MS = 10 * 60_000;
/** The hour, UTC, of the daily run: after the voice drift check at 03. */
export const SCHEDULED_AUDIT_HOUR = 4;

const SERVICE = "clinic-audits";
const ROSTER_KINDS: ReadonlySet<ClinicChangeKind> = new Set(["providers", "provider_services"]);

type Outcome = { status: string; note?: string };

/**
 * The minute's work: every change not yet told is told to ops (unswitched),
 * then, behind the switch and its lock, each clinic whose last change is two
 * minutes old is audited.
 */
export async function runClinicChangesMinute(now: Date = new Date()): Promise<Outcome> {
  const alerts = await runClinicChangeAlerts(now);
  const audits = await runJob(JOB_CLINIC_AUDITS, () => runQueuedAudits(now), now, { staleLockMs: LOCK_MS });
  const note =
    `${alerts.alerts} alerts` +
    (alerts.failures ? `, ${alerts.failures} clinics failed` : "") +
    `; audits ${audits.status}${"note" in audits ? `: ${audits.note}` : ""}`;
  return { status: alerts.failures > 0 || audits.status === "failed" ? "failed" : "ok", note };
}

/** Each clinic whose recorded changes have waited two minutes since its last one: one audit. */
export async function runQueuedAudits(now: Date = new Date()): Promise<string> {
  const cutoff = now.getTime() - AUDIT_DEBOUNCE_MS;
  const due = (await clinicChangeWork())
    .filter((w) => w.queued > 0 && w.lastQueuedAt !== null && w.lastQueuedAt.getTime() <= cutoff)
    .slice(0, AUDITS_PER_SWEEP);
  let audited = 0;
  let failed = 0;
  for (const { clinicId } of due) {
    try {
      if (await auditQueuedChanges(clinicId, now)) audited += 1;
    } catch (error) {
      failed += 1;
      log.warn("clinic audit after a change failed", { clinicId, error: describeError(error) });
    }
  }
  if (failed > 0 && audited === 0) throw new Error(`${failed} clinic audits failed`);
  return `${due.length} due, ${audited} audited${failed ? `, ${failed} failed` : ""}`;
}

/**
 * Claim the clinic's waiting changes, audit availability (and the roster when
 * a change was to it), and mark each change passed or needing attention.
 * False when another run took them first.
 */
export async function auditQueuedChanges(clinicId: string, now: Date = new Date()): Promise<boolean> {
  const actor = { type: "service", serviceName: SERVICE } as const;
  const claimed = await withTenant({ clinicId, actor }, async (tx) => {
    const rows = await tx.db
      .update(clinicChangeEvents)
      .set({
        auditStatus: "running",
        auditStartedAt: now,
        auditAttempts: sql`${clinicChangeEvents.auditAttempts} + 1`,
      })
      .where(
        and(
          eq(clinicChangeEvents.clinicId, tx.clinicId),
          or(
            eq(clinicChangeEvents.auditStatus, "queued"),
            and(
              eq(clinicChangeEvents.auditStatus, "running"),
              lt(clinicChangeEvents.auditStartedAt, new Date(now.getTime() - STALE_AUDIT_MS)),
            ),
          ),
        ),
      )
      .returning({
        id: clinicChangeEvents.id,
        kind: clinicChangeEvents.kind,
        changedAt: clinicChangeEvents.changedAt,
        attempts: clinicChangeEvents.auditAttempts,
      });
    // Past its attempts: an error for ops to see, never "checking" for ever.
    const spent = rows.filter((r) => r.attempts > MAX_AUDIT_ATTEMPTS).map((r) => r.id);
    if (spent.length > 0) {
      await tx.db
        .update(clinicChangeEvents)
        .set({ auditStatus: "error" })
        .where(and(eq(clinicChangeEvents.clinicId, tx.clinicId), inArray(clinicChangeEvents.id, spent)));
    }
    return rows.filter((r) => r.attempts <= MAX_AUDIT_ATTEMPTS);
  });
  if (claimed.length === 0) return false;
  const newest = [...claimed].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())[0]!;
  const packs: AuditPack[] = ["availability"];
  if (claimed.some((c) => ROSTER_KINDS.has(c.kind))) packs.push("roster");
  const rows: ClinicAuditRow[] = [];
  for (const pack of packs) {
    rows.push(
      await runAuditPack(clinicId, pack, { trigger: "change", changeKind: newest.kind, requestedBy: SERVICE, now }),
    );
  }
  const result = worstOf(rows.map((r) => r.result));
  await withTenant({ clinicId, actor: { type: "service", serviceName: SERVICE } }, (tx) =>
    tx.db
      .update(clinicChangeEvents)
      .set({ auditStatus: result === "pass" ? "passed" : "attention", auditId: rows[0]!.id })
      .where(
        and(
          eq(clinicChangeEvents.clinicId, tx.clinicId),
          inArray(
            clinicChangeEvents.id,
            claimed.map((c) => c.id),
          ),
        ),
      ),
  );
  return true;
}

/** The clinics an audit is for: every one still in service. */
async function clinicsInService(): Promise<string[]> {
  return (await listClinics())
    .filter((c) => c.offboardingStartedAt === null && c.destroyedAt === null)
    .map((c) => c.id);
}

/**
 * The hourly work, behind the switch: at 04 UTC every pack for every clinic
 * in service (`scheduled`); every other hour, each clinic whose availability
 * fingerprint moved since its last availability audit (`change_detected`).
 * A clinic never audited is left to the 04 UTC run, which gives it its first
 * fingerprint. Its own job row, so its lock is not the minute sweep's.
 */
export async function runClinicAuditsHourly(now: Date = new Date()): Promise<Outcome> {
  return runJob(
    JOB_CLINIC_AUDITS_HOURLY,
    async () => {
      const ids = await clinicsInService();
      let audited = 0;
      let failed = 0;
      const scheduled = now.getUTCHours() === SCHEDULED_AUDIT_HOUR;
      for (const clinicId of ids) {
        try {
          if (scheduled) {
            for (const pack of AUDIT_PACKS) {
              await runAuditPack(clinicId, pack, { trigger: "scheduled", requestedBy: SERVICE, now });
            }
            audited += 1;
          } else if (await fingerprintMoved(clinicId)) {
            await runAuditPack(clinicId, "availability", { trigger: "change_detected", requestedBy: SERVICE, now });
            await runAuditPack(clinicId, "roster", { trigger: "change_detected", requestedBy: SERVICE, now });
            audited += 1;
          }
        } catch (error) {
          failed += 1;
          log.warn("hourly clinic audit failed", { clinicId, error: describeError(error) });
        }
      }
      return `${scheduled ? "scheduled" : "fingerprints"}: ${ids.length} clinics, ${audited} audited${failed ? `, ${failed} failed` : ""}`;
    },
    now,
    { staleLockMs: 2 * 60 * 60_000 },
  );
}

/** Whether the clinic's availability fingerprint differs from its last availability audit's. */
export async function fingerprintMoved(clinicId: string): Promise<boolean> {
  return withTenant({ clinicId, actor: { type: "service", serviceName: SERVICE } }, async (tx) => {
    const last = await latestAudit(tx, "availability");
    if (!last?.fingerprint) return false;
    return (await availabilityFingerprint(tx)) !== last.fingerprint;
  });
}
