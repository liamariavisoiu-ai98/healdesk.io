import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";

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
 *   stale    — active/degraded with no ok/partial sync in 48 hours
 *   stuck    — webhooks unprocessed for over an hour, or signature failures
 *              in the last day
 *
 * One digest email to ops per run when anything is wrong, never one message
 * per condition per clinic; and a security event per run so the console can
 * show the last finding without reading mail.
 */
export type HealthFinding = {
  clinicId: string;
  connectionId: string;
  provider: string;
  condition: "revoked" | "stale" | "stuck";
  detail: string;
};

const STALE_MS = 48 * 60 * 60 * 1000;

export async function findUnhealthyConnections(now: Date = new Date()): Promise<HealthFinding[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    connection_id: string;
    provider: string;
    status: string;
    last_ok_sync_at: Date | null;
    unprocessed_webhooks: string | number;
    invalid_signatures_24h: string | number;
  }>(sql`select * from app_connection_health()`);
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? result) as (typeof result extends { rows: infer R } ? R : never)[number][];

  const findings: HealthFinding[] = [];
  for (const row of rows) {
    const base = { clinicId: row.clinic_id, connectionId: row.connection_id, provider: row.provider };
    if (row.status === "revoked" || row.status === "error") {
      findings.push({ ...base, condition: "revoked", detail: `status ${row.status}` });
    } else if (row.status === "active" || row.status === "degraded") {
      const last = row.last_ok_sync_at ? new Date(row.last_ok_sync_at).getTime() : null;
      if (last === null || now.getTime() - last > STALE_MS) {
        findings.push({ ...base, condition: "stale", detail: last ? `last good sync ${Math.round((now.getTime() - last) / 3_600_000)}h ago` : "never synced" });
      }
    }
    const unprocessed = Number(row.unprocessed_webhooks ?? 0);
    const invalid = Number(row.invalid_signatures_24h ?? 0);
    if (unprocessed > 0 || invalid > 0) {
      findings.push({ ...base, condition: "stuck", detail: `${unprocessed} unprocessed over 1h, ${invalid} bad signatures in 24h` });
    }
  }
  return findings;
}

export async function runConnectionHealthJob(
  options: { now?: Date; transport?: EmailTransport } = {},
) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_CONNECTION_HEALTH,
    async () => {
      const findings = await findUnhealthyConnections(now);
      if (findings.length === 0) return "All connections healthy.";

      const ops = process.env.HEALDESK_OPS_EMAIL ?? process.env.HEALDESK_ADMIN_EMAIL;
      const lines = findings.map(
        (f) => `- clinic ${f.clinicId} · ${f.provider} · ${f.condition}: ${f.detail}`,
      );
      if (ops) {
        const transport = options.transport ?? getTransport("none");
        const sent = await transport.send(
          { to: ops, clinicId: "00000000-0000-0000-0000-000000000000", clinicName: "healdesk ops" },
          {
            subject: `[healdesk] ${findings.length} connection finding${findings.length === 1 ? "" : "s"}`,
            text: `Connection health at ${now.toISOString()}:\n\n${lines.join("\n")}\n\nIds only; open the console for the clinic.\n`,
            html: "",
            phiClass: "none",
          },
        );
        if (sent.status === "failed") log.error("ops digest not sent", { reason: sent.reason });
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
      return `${findings.length} finding(s): ${findings.map((f) => f.condition).join(", ")}.` + (ops ? " Digest sent." : " No HEALDESK_OPS_EMAIL; not mailed.");
    },
    now,
  );
}
