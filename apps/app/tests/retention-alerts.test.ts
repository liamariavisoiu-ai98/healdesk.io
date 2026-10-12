import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { runRetentionPurgeJob, sweepRetention } from "@/lib/scheduler/retention-purge";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * A failed retention purge reaches a person (the calendar session's
 * pre-release audit of 1.3.0, §1 item 3; second review, 12 October 2026).
 *
 * The nightly purge reported "ok … N failed" in the job's note and nothing
 * else, so a clinic whose purge threw every night kept its records past the
 * agreement's periods with no one told. It now raises the
 * retention_purge_failed ops alert, with the clinic's id and the step, never
 * the error's text.
 */

const failing = new Set<string>();
const sweepFails = { on: false };
const alerts: { event: string; fields: Record<string, unknown> }[] = [];

vi.mock("@/lib/retention/purge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/retention/purge")>();
  return {
    ...actual,
    purgeClinic: async (...args: Parameters<typeof actual.purgeClinic>) => {
      if (failing.has(args[0].clinicId)) throw new Error("synthetic failure naming +15550199999");
      return actual.purgeClinic(...args);
    },
    purgeIsPromised: (version: string | null) => {
      if (sweepFails.on) throw new Error("synthetic failure of the whole run");
      return actual.purgeIsPromised(version);
    },
  };
});

vi.mock("@/lib/ops/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/notify")>();
  return {
    ...actual,
    notifyOps: async (event: string, fields: Record<string, unknown>) => {
      alerts.push({ event, fields });
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("a failed retention purge alerts ops", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    failing.clear();
    sweepFails.on = false;
    alerts.length = 0;
  });

  afterAll(async () => {
    await closePools();
  });

  test("a clinic whose purge throws raises the alert with its id and the step, and the rest are purged", async () => {
    const broken = await seedClinic("purge-alert-broken");
    const fine = await seedClinic("purge-alert-fine");
    failing.add(broken.clinicId);
    const sweep = await sweepRetention(new Date());
    expect(sweep.failures.map((f) => f.clinicId)).toEqual([broken.clinicId]);
    expect(sweep.results.map((r) => r.clinicId)).toContain(fine.clinicId);
    expect(alerts).toEqual([
      { event: "retention_purge_failed", fields: { clinicId: broken.clinicId, phase: "clinic" } },
    ]);
    expect(JSON.stringify(alerts)).not.toMatch(/15550199999|synthetic/);
  });

  test("a run that cannot purge at all raises it once, and the job records the failure", async () => {
    sweepFails.on = true;
    const outcome = await runRetentionPurgeJob({ now: new Date() });
    expect(outcome.status).toBe("failed");
    expect(alerts).toEqual([{ event: "retention_purge_failed", fields: { phase: "run" } }]);
  });
});
