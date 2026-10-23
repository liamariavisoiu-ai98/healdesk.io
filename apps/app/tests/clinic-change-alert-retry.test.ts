import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { recordClinicChange, runClinicChangeAlerts } from "@/lib/clinic/change-events";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Lane B, review item 6: a change is marked told only after its alert was
 * recorded. When the alert cannot be recorded, the change stays untold and
 * the next sweep tells it. notifyOpsOrThrow is the seam: here it fails once,
 * then works.
 */

const notify = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock("@/lib/ops/notify", async (original) => {
  const real = await original<typeof import("@/lib/ops/notify")>();
  return {
    ...real,
    notifyOpsOrThrow: async (...args: Parameters<typeof real.notifyOpsOrThrow>) => {
      notify.calls += 1;
      if (notify.failNext) {
        notify.failNext = false;
        throw new Error("ops log unreachable");
      }
      return real.notifyOpsOrThrow(...args);
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "alert-retry-test" } as const;

describeDb("a change whose alert could not be recorded", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);
  afterAll(async () => {
    await closePools();
  });

  test("stays untold, and the next sweep tells it once", async () => {
    const c = await seedClinic(`retry${Date.now() % 100000}`);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      recordClinicChange(tx, { kind: "hours", source: "portal", actor: "clinic_signin", summary: { weeklyChanged: true } }),
    );
    const untold = async () =>
      (
        await inTenant(c.clinicId, (q) =>
          q.query<{ n: number }>(`select count(*)::int as n from clinic_change_events where alerted_at is null`),
        )
      ).rows[0]!.n;

    notify.failNext = true;
    expect(await runClinicChangeAlerts()).toEqual({ alerts: 0, failures: 1 });
    expect(await untold()).toBe(1);

    expect(await runClinicChangeAlerts()).toEqual({ alerts: 1, failures: 0 });
    expect(await untold()).toBe(0);
    expect(notify.calls).toBe(2);
  });
});
