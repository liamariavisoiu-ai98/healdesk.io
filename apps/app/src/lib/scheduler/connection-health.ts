import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { META_PROVIDERS } from "@/lib/meta/providers";
import { notifyOpsOnce } from "@/lib/ops/notify";

import { JOB_CONNECTION_HEALTH, runJob } from "./jobs";

/**
 * The watchdog: notice a dead connection or a stuck webhook queue before the
 * clinic's report quietly shrinks.
 *
 * Three conditions, read across tenants through app_connection_health()
 * (0034 — status, last good sync, unprocessed and unverified webhook counts,
 * nothing else):
 *
 *   revoked  — status 'revoked' or 'error'
 *   stale    — active/degraded with no ok/partial sync in 48 hours, for a
 *              provider that syncs at all
 *   stuck    — webhooks unprocessed for over an hour, or signature failures
 *              in the last day
 *
 * What reaches ops, since WP5 folded this job's email into the 07:00 ops
 * digest (Annex X6, "Connection health: folded into the ops digest, and sent
 * at once only when critical"):
 *
 *   - every finding, in the digest's connection-health section, once a day
 *     (lib/ops/digest.ts reads findUnhealthyConnections itself, so it shows
 *     them whether or not this job is switched on);
 *   - at once, only a revoked or errored connection: `connection_broken`,
 *     through notifyOpsOnce, once per connection and state. A dead Meta
 *     token is a channel that has stopped answering patients; a stale sync
 *     or a stuck queue is phase two's and can wait for the morning.
 *
 * And a security event per run, so the console can show the last finding
 * without reading mail.
 *
 * Google Calendar connections are left out. They never sync, so every one
 * would read as stale, and their health is the calendar watch's, which
 * alerts the clinic and ops once per breakage (plan §9.3). The Meta
 * platforms' sealed tokens never sync either, so they are never stale; a
 * revoked one is still found.
 */
export type HealthFinding = {
  clinicId: string;
  connectionId: string;
  provider: string;
  condition: "revoked" | "stale" | "stuck";
  detail: string;
};

/** One row of app_connection_health(), as the digest also reads it. */
export type ConnectionHealthRow = {
  clinicId: string;
  connectionId: string;
  provider: string;
  status: string;
  lastOkSyncAt: Date | null;
  unprocessedWebhooks: number;
  invalidSignatures24h: number;
};

const STALE_MS = 48 * 60 * 60 * 1000;

/** Providers whose connection is a sealed token and never syncs. */
const NEVER_SYNCS: ReadonlySet<string> = new Set([
  GOOGLE_CALENDAR_PROVIDER,
  ...Object.values(META_PROVIDERS),
]);

/** Every connection's health across tenants. Status, dates and counts; no credential, no patient. */
export async function readConnectionHealth(): Promise<ConnectionHealthRow[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    connection_id: string;
    provider: string;
    status: string;
    last_ok_sync_at: Date | string | null;
    unprocessed_webhooks: string | number;
    invalid_signatures_24h: string | number;
  }>(sql`select * from app_connection_health()`);
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? [];
  return rows.map((row) => ({
    clinicId: String(row.clinic_id),
    connectionId: String(row.connection_id),
    provider: String(row.provider),
    status: String(row.status),
    lastOkSyncAt: row.last_ok_sync_at ? new Date(row.last_ok_sync_at as string) : null,
    unprocessedWebhooks: Number(row.unprocessed_webhooks ?? 0),
    invalidSignatures24h: Number(row.invalid_signatures_24h ?? 0),
  }));
}

export async function findUnhealthyConnections(now: Date = new Date()): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  for (const row of await readConnectionHealth()) {
    if (row.provider === GOOGLE_CALENDAR_PROVIDER) continue;
    const base = { clinicId: row.clinicId, connectionId: row.connectionId, provider: row.provider };
    if (row.status === "revoked" || row.status === "error") {
      findings.push({ ...base, condition: "revoked", detail: `status ${row.status}` });
    } else if ((row.status === "active" || row.status === "degraded") && !NEVER_SYNCS.has(row.provider)) {
      const last = row.lastOkSyncAt ? row.lastOkSyncAt.getTime() : null;
      if (last === null || now.getTime() - last > STALE_MS) {
        findings.push({
          ...base,
          condition: "stale",
          detail: last ? `last good sync ${Math.round((now.getTime() - last) / 3_600_000)}h ago` : "never synced",
        });
      }
    }
    if (row.unprocessedWebhooks > 0 || row.invalidSignatures24h > 0) {
      findings.push({
        ...base,
        condition: "stuck",
        detail: `${row.unprocessedWebhooks} unprocessed over 1h, ${row.invalidSignatures24h} bad signatures in 24h`,
      });
    }
  }
  return findings;
}

export async function runConnectionHealthJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_CONNECTION_HEALTH,
    async () => {
      const findings = await findUnhealthyConnections(now);
      if (findings.length === 0) return "All connections healthy.";

      // Critical only: the rest wait for the 07:00 digest.
      const broken = findings.filter((f) => f.condition === "revoked");
      for (const finding of broken) {
        await notifyOpsOnce("connection_broken", {
          clinicId: finding.clinicId,
          connectionId: finding.connectionId,
          provider: finding.provider,
          status: "revoked",
        });
      }
      try {
        await recordSecurityEvent(unsafeDb, {
          event: "connection_health_findings",
          actorLabel: "connection-health",
          metadata: { count: findings.length, conditions: findings.map((f) => f.condition).join(",") },
        });
      } catch (error) {
        log.error("could not record health findings", { error: describeError(error) });
      }
      return (
        `${findings.length} finding(s): ${findings.map((f) => f.condition).join(", ")}.` +
        (broken.length > 0 ? ` ${broken.length} broken, raised to ops.` : "") +
        " The rest are in the 07:00 digest."
      );
    },
    now,
  );
}
