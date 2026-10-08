import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { enqueueNightlySync } from "@/lib/scheduler/nightly-sync";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The nightly sync puts work on the queues the worker already drains. The
 * queue itself is pg-boss and is tested in queue.test.ts; here it is a spy,
 * and the assertions are about which connections get a job and how.
 */

const enqueue = vi.fn(async () => "job-id");

vi.mock("@/lib/queue/boss", () => ({
  QUEUE_SYNC_CONNECTION: "sync-connection",
  QUEUE_RECONCILE_CLINIC: "reconcile-clinic",
  enqueue: (...args: unknown[]) => enqueue(...(args as [])),
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("nightly sync", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => enqueue.mockClear());

  afterAll(async () => {
    await closePools();
  });

  test("one staggered, deduplicated sync per active connection; nothing for a revoked one", async () => {
    const a = await seedClinic("sync-a");
    const b = await seedClinic("sync-b");
    const connect = (clinicId: string, status: string, provider = "fixture") =>
      inTenant(clinicId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into provider_connections
             (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
           values ($1, $3, $2, 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
          [clinicId, status, provider],
        );
        return rows[0]!.id;
      });
    const activeA = await connect(a.clinicId, "active");
    const degradedB = await connect(b.clinicId, "degraded");
    await connect(b.clinicId, "revoked", "fixture-old");

    const result = await enqueueNightlySync(new Date("2026-09-15T02:00:00Z"));
    expect(result).toEqual({ syncs: 2, reconciles: 0 });

    const calls = enqueue.mock.calls as unknown as [string, { clinicId: string; connectionId: string }, { singletonKey: string; startAfter: number }][];
    expect(calls.map((c) => c[1].connectionId).sort()).toEqual([activeA, degradedB].sort());
    for (const [queue, payload, options] of calls) {
      expect(queue).toBe("sync-connection");
      expect(options.singletonKey).toBe(`sync:${payload.connectionId}`);
    }
    // Staggered, not simultaneous.
    expect(new Set(calls.map((c) => c[2].startAfter)).size).toBe(2);
  });

  test("never a sync for a Google Calendar connection: it is the write target, not a system to read back", async () => {
    const clinic = await seedClinic("sync-google");
    await inTenant(clinic.clinicId, async (client) => {
      await client.query(
        `insert into provider_connections
           (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'google_calendar', 'active', 'x', 'x', 'x', 'x', 'v1', 1)`,
        [clinic.clinicId],
      );
    });
    await enqueueNightlySync(new Date("2026-09-15T02:00:00Z"));
    const calls = enqueue.mock.calls as unknown as [string, { clinicId: string }][];
    expect(calls.filter(([, payload]) => payload.clinicId === clinic.clinicId)).toEqual([]);
  });

  test("on the first of the month, a reconcile per verified production clinic", async () => {
    const verified = await seedClinic("sync-verified");
    await seedClinic("sync-estimated");
    await getMigratorPool().query(
      `update clinics set attribution_mode = 'verified', data_classification = 'production' where id = $1`,
      [verified.clinicId],
    );

    const result = await enqueueNightlySync(new Date("2026-10-01T02:00:00Z"));
    expect(result.reconciles).toBe(1);
    const reconcile = (enqueue.mock.calls as unknown as [string, { clinicId: string }, { singletonKey: string }][]).find(
      (c) => c[0] === "reconcile-clinic",
    );
    expect(reconcile?.[1].clinicId).toBe(verified.clinicId);
    expect(reconcile?.[2].singletonKey).toBe(`reconcile:${verified.clinicId}:2026-10`);
  });
});
