import { afterEach, describe, expect, test, vi } from "vitest";

import { QUEUE_BILLING_MINUTE, QUEUES, startGuardedClock, type ClockBoss } from "@/lib/queue/boss";

/**
 * The `billing-minute` queue (build spec BD1, R17): installed with the rest,
 * and registered so that a worker started before `queue:install` was re-run
 * logs the fix and keeps running, instead of taking the hourly tick down with
 * it.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the billing-minute queue", () => {
  test("is one of the queues queue:install creates", () => {
    expect(QUEUE_BILLING_MINUTE).toBe("billing-minute");
    expect(QUEUES).toContain("billing-minute");
  });

  test("a clock whose queue was never installed logs loudly and returns false, without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boss: ClockBoss = {
      schedule: vi.fn(async () => {
        throw new Error("Queue billing-minute not found");
      }),
      work: vi.fn(async () => "worker"),
    };

    await expect(
      startGuardedClock(boss, QUEUE_BILLING_MINUTE, "* * * * *", async () => {}),
    ).resolves.toBe(false);
    expect(boss.work).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/queue:install/);
    expect(String(error.mock.calls[0]![0])).toMatch(/billing-minute/);
  });

  test("a clock registers its cron in UTC and one job at a time, and each fire runs the handler", async () => {
    const handler = vi.fn(async () => {});
    let registered: ((jobs: unknown[]) => Promise<void>) | undefined;
    const boss: ClockBoss = {
      schedule: vi.fn(async () => {}),
      work: vi.fn(async (_name, _options, fn) => {
        registered = fn as unknown as (jobs: unknown[]) => Promise<void>;
        return "worker";
      }),
    };

    expect(await startGuardedClock(boss, QUEUE_BILLING_MINUTE, "* * * * *", handler)).toBe(true);
    expect(boss.schedule).toHaveBeenCalledWith("billing-minute", "* * * * *", {}, { tz: "UTC" });
    expect(boss.work).toHaveBeenCalledWith(
      "billing-minute",
      { batchSize: 1 },
      expect.any(Function),
    );
    await registered!([{ id: "job" }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
