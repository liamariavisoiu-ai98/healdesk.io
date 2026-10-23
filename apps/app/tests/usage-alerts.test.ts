import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { setUsageAlertsEnabled } from "@/lib/billing/entitlements";
import { runUsageAlertsJob } from "@/lib/billing/usage-alerts";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The 90% and 100% allowance emails (BD21, R17): hourly behind the job's
 * switch and the clinic's own, once per threshold per meter per window, on
 * the billing clinic, and never for a window that is not open. The first
 * alert was at 80% until the pricing sheet of 13 October 2026; its kind is
 * still `usage_80`.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "usage-alerts-test" } as const;
const NOW = new Date("2026-10-15T15:00:00Z");
const WINDOW_START = new Date("2026-10-01T00:00:00Z");

async function setUsed(clinicId: string, voice: number, chat: number): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `update entitlements set used_voice_minutes = $2, used_chat_conversations = $3 where clinic_id = $1`,
      [clinicId, voice, chat],
    ),
  );
}

async function notices(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      kind: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>(`select kind, dedupe_key, payload from billing_notices order by kind, dedupe_key`);
    return rows;
  });
}

async function switchJob(on: boolean): Promise<void> {
  await getMigratorPool().query(
    `update scheduled_jobs set enabled = $1 where name = 'usage-alerts'`,
    [on],
  );
}

describeDb("usage-alerts", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("switched off, nothing is queued", async () => {
    const c = await seedClinic("alerts-off");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await setUsed(c.clinicId, 1_000, 2_000);
    expect(await runUsageAlertsJob({ now: NOW })).toEqual({ status: "disabled" });
    expect(await notices(c.clinicId)).toEqual([]);
  });

  test("90% and 100% once per meter per window, only usage_100 when first found past it, with a payload the sender accepts", async () => {
    await switchJob(true);
    const c = await seedClinic("alerts-on");
    // AYA Voice + Meta Chat: 1,000 minutes and 1,000 conversations.
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    // 85% is under the alert since 13 October 2026.
    await setUsed(c.clinicId, 850, 850);
    expect(await runUsageAlertsJob({ now: NOW })).toMatchObject({ status: "ok" });
    expect(await notices(c.clinicId)).toEqual([]);

    await setUsed(c.clinicId, 950, 1_100);

    expect(await runUsageAlertsJob({ now: NOW })).toMatchObject({ status: "ok" });
    const queued = await notices(c.clinicId);
    expect(queued).toEqual([
      {
        kind: "usage_100",
        dedupe_key: `chat_conversations:${WINDOW_START.toISOString()}`,
        payload: {
          meter: "chat_conversations",
          used: 1_100,
          included: 1_000,
          windowEndsOn: "2026-11-01",
          overageMode: "allow",
          // A started block of 100 conversations on Meta Chat: $78, never $0.78 a unit.
          blockRateCents: 7_800,
        },
      },
      {
        kind: "usage_80",
        dedupe_key: `voice_minutes:${WINDOW_START.toISOString()}`,
        payload: {
          meter: "voice_minutes",
          used: 950,
          included: 1_000,
          windowEndsOn: "2026-11-01",
          overageMode: "allow",
          blockRateCents: 10_400,
        },
      },
    ]);
    for (const n of queued) assertPayloadAllowed(n.payload, n.kind as "usage_80" | "usage_100");

    // The next hour queues nothing new; crossing 100% later queues its one.
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });
    expect(await notices(c.clinicId)).toHaveLength(2);
    await setUsed(c.clinicId, 1_001, 1_200);
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) });
    expect(
      (await notices(c.clinicId)).map((n) => `${n.kind}:${n.dedupe_key.split(":")[0]}`),
    ).toEqual([
      "usage_100:chat_conversations",
      "usage_100:voice_minutes",
      "usage_80:voice_minutes",
    ]);
  });

  test("the clinic's own switch, a plan not started, and an expired window all send nothing", async () => {
    await switchJob(true);
    const off = await seedClinic("alerts-clinic-off");
    await seedEntitled(off.clinicId, { planStartedAt: WINDOW_START });
    await withTenant({ clinicId: off.clinicId, actor }, (tx) =>
      setUsageAlertsEnabled(tx.db, off.clinicId, false),
    );
    await setUsed(off.clinicId, 1_000, 2_000);

    const notStarted = await seedClinic("alerts-not-started");
    await seedEntitled(notStarted.clinicId, {});
    await setUsed(notStarted.clinicId, 1_000, 2_000);

    const expired = await seedClinic("alerts-expired");
    await seedEntitled(expired.clinicId, { planStartedAt: new Date("2026-09-01T00:00:00Z") });
    await setUsed(expired.clinicId, 1_000, 2_000);

    expect(await runUsageAlertsJob({ now: NOW })).toMatchObject({ status: "ok" });
    for (const c of [off, notStarted, expired]) expect(await notices(c.clinicId)).toEqual([]);
  });

  test("a channel bought but not yet billed is measured against its package's allowance (BD5), and a location's usage alerts its billing clinic", async () => {
    await switchJob(true);
    const billing = await seedClinic("alerts-billing");
    const location = await seedClinic("alerts-location");
    await getMigratorPool().query(`update clinics set billing_clinic_id = $2 where id = $1`, [
      location.clinicId,
      billing.clinicId,
    ]);
    // Bought Voice + Web Chat, billed as AYA Web Chat: voice is 0 on the billed row.
    await seedEntitled(billing.clinicId, {
      planId: "webchat-1000",
      boughtPlanId: "voice-webchat-1000-1000",
      planStartedAt: WINDOW_START,
    });
    await setUsed(billing.clinicId, 100, 0);

    expect(await runUsageAlertsJob({ now: NOW })).toMatchObject({ status: "ok" });
    // 100 of the bought 1,000 minutes is 10%: no alert, where 100 of 0 would have read as past 100%.
    expect(await notices(billing.clinicId)).toEqual([]);
    expect(await notices(location.clinicId)).toEqual([]);

    await setUsed(billing.clinicId, 920, 0);
    await runUsageAlertsJob({ now: NOW });
    expect((await notices(billing.clinicId)).map((n) => n.kind)).toEqual(["usage_80"]);
    expect(await notices(location.clinicId)).toEqual([]);
  });

  /**
   * Ops hears of each mark too (design E2, 23 October 2026): usage_near_cap
   * and usage_cap_reached, once per clinic, meter and window, with the meter
   * and the counts, and whatever the clinic's own switch says.
   */
  test("ops is told once per mark per window, even with the clinic's switch off", async () => {
    await switchJob(true);
    await getMigratorPool().query(`truncate ops_alerts`);
    const c = await seedClinic("alerts-ops");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await withTenant({ clinicId: c.clinicId, actor }, (tx) =>
      setUsageAlertsEnabled(tx.db, c.clinicId, false),
    );
    await setUsed(c.clinicId, 950, 1_100);

    const opsAlerts = async () =>
      (
        await getMigratorPool().query<{ event: string; fields: Record<string, unknown>; repeats: number }>(
          `select event, fields, repeats from ops_alerts order by event`,
        )
      ).rows;

    await runUsageAlertsJob({ now: NOW });
    // The clinic is not emailed: its switch is off.
    expect(await notices(c.clinicId)).toEqual([]);
    expect(await opsAlerts()).toEqual([
      {
        event: "usage_cap_reached",
        fields: {
          clinicId: c.clinicId,
          meter: "chat_conversations",
          windowStart: WINDOW_START.toISOString(),
          used: 1_100,
          included: 1_000,
        },
        repeats: 0,
      },
      {
        event: "usage_near_cap",
        fields: {
          clinicId: c.clinicId,
          meter: "voice_minutes",
          windowStart: WINDOW_START.toISOString(),
          used: 950,
          included: 1_000,
        },
        repeats: 0,
      },
    ]);

    // Later hours, more usage under the same mark: still one alert each.
    await setUsed(c.clinicId, 960, 1_150);
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) });
    expect((await opsAlerts()).map((a) => a.event)).toEqual(["usage_cap_reached", "usage_near_cap"]);

    // Voice crossing 100% is its own alert, once.
    await setUsed(c.clinicId, 1_001, 1_150);
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 3 * 60 * 60 * 1000) });
    await runUsageAlertsJob({ now: new Date(NOW.getTime() + 4 * 60 * 60 * 1000) });
    expect((await opsAlerts()).map((a) => `${a.event}:${String(a.fields.meter)}`).sort()).toEqual([
      "usage_cap_reached:chat_conversations",
      "usage_cap_reached:voice_minutes",
      "usage_near_cap:voice_minutes",
    ]);
  });
});
