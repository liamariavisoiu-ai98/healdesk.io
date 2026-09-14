import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { listClinics } from "@/lib/ops/clinics";
import { enqueue, QUEUE_RECONCILE_CLINIC, QUEUE_SYNC_CONNECTION } from "@/lib/queue/boss";

import { JOB_NIGHTLY_SYNC, runJob } from "./jobs";

/**
 * Put work on the queues the worker already drains.
 *
 * Nightly: one sync per active connection, staggered a few seconds apart so
 * a hundred clinics do not hit their platforms in the same minute (PatientNow
 * allows 1,000 requests a day per account), with a singletonKey so a
 * webhook-triggered sync and the nightly one collapse into one run. On the
 * 1st of the month: a reconcile per verified clinic, before the report job
 * reads a settled month.
 */
export async function enqueueNightlySync(now: Date): Promise<{ syncs: number; reconciles: number }> {
  const result = await unsafeDb.execute<{ clinic_id: string; connection_id: string; provider: string }>(
    sql`select clinic_id, connection_id, provider from app_active_connections()`,
  );
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? result) as {
    clinic_id: string;
    connection_id: string;
    provider: string;
  }[];

  let syncs = 0;
  for (const [index, row] of rows.entries()) {
    await enqueue(
      QUEUE_SYNC_CONNECTION,
      { clinicId: row.clinic_id, connectionId: row.connection_id },
      { singletonKey: `sync:${row.connection_id}`, startAfter: index * 20 },
    );
    syncs += 1;
  }

  let reconciles = 0;
  if (now.getUTCDate() === 1) {
    for (const clinic of await listClinics()) {
      if (clinic.attributionMode !== "verified" || clinic.dataClassification !== "production") continue;
      await enqueue(
        QUEUE_RECONCILE_CLINIC,
        { clinicId: clinic.id },
        { singletonKey: `reconcile:${clinic.id}:${now.toISOString().slice(0, 7)}`, startAfter: 3600 },
      );
      reconciles += 1;
    }
  }
  return { syncs, reconciles };
}

export async function runNightlySyncJob(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_NIGHTLY_SYNC,
    async () => {
      const r = await enqueueNightlySync(now);
      return `Enqueued ${r.syncs} sync(s)` + (r.reconciles ? ` and ${r.reconciles} reconcile(s)` : "") + ".";
    },
    now,
  );
}
