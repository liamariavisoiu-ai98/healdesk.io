import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { reconcileBilling } from "@/lib/billing/reconcile";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeededClinic } from "./setup/factories";

/**
 * R12's last step, in the hourly reconcile: healdesk's access to a clinic's
 * Stripe account ends with the service. A day after a billing group was
 * canceled (long enough for every deposit link, which lives at most 24 hours,
 * to have been paid or to have expired) each clinic still connected is
 * disconnected as "offboarding". Never sooner, and never for a group whose
 * service has not ended.
 *
 * disconnectStripeConnect itself (shared accounts, the cascade) is tested with
 * Package D; here it is a spy, so the test is about when the reconcile calls it.
 */

const connect = vi.hoisted(() => ({
  disconnect: vi.fn(async () => ({
    status: "disconnected" as const,
    deauthorized: true,
    shared: false,
    cancelledLinks: 0,
    paidLinks: 0,
  })),
}));

vi.mock("@/lib/billing/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/connect")>()),
  disconnectStripeConnect: connect.disconnect,
}));

vi.setConfig({ testTimeout: 30_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

/** A bought, started clinic in `status`, connected to Stripe unless told otherwise. */
async function seedGroup(
  label: string,
  options: { status: "active" | "canceled"; endedAt?: Date | null; connected?: boolean },
): Promise<SeededClinic> {
  const clinic = await seedClinic(label);
  await seedEntitled(clinic.clinicId, {
    planId: "web-voice",
    boughtPlanId: "web-voice",
    planStartedAt: at(-40 * 24 * HOUR),
  });
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update entitlements set status = $2 where clinic_id = $1`, [
      clinic.clinicId,
      options.status,
    ]),
  );
  // clinics is not forced, so the migrator (its owner) writes these fixture
  // columns directly.
  await getMigratorPool().query(
    `update clinics set stripe_connect_account_id = $2, offboarding_started_at = $3 where id = $1`,
    [
      clinic.clinicId,
      options.connected === false ? null : `acct_${label.replace(/\W/g, "")}`,
      options.endedAt ?? null,
    ],
  );
  return clinic;
}

describeDb("the reconcile disconnects Stripe a day after a group's service ends (R12)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(closePools);
  beforeEach(async () => {
    await truncateAll();
    connect.disconnect.mockClear();
  });

  test("a group canceled more than a day ago is disconnected as offboarding", async () => {
    const ended = await seedGroup("ended", { status: "canceled", endedAt: at(-25 * HOUR) });

    expect(await reconcileBilling(NOW)).toMatchObject({ connectsDisconnected: 1, failures: 0 });

    expect(connect.disconnect).toHaveBeenCalledTimes(1);
    expect(connect.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: ended.clinicId,
        actorLabel: "offboarding",
        source: "ops",
      }),
    );
  });

  test("nothing is disconnected within the day after the end, while links may still be paid", async () => {
    await seedGroup("recent", { status: "canceled", endedAt: at(-2 * HOUR) });

    expect(await reconcileBilling(NOW)).toMatchObject({ connectsDisconnected: 0 });
    expect(connect.disconnect).not.toHaveBeenCalled();
  });

  test("a clinic whose service has not ended keeps its connection", async () => {
    await seedGroup("live", { status: "active", endedAt: null });

    expect(await reconcileBilling(NOW)).toMatchObject({ connectsDisconnected: 0 });
    expect(connect.disconnect).not.toHaveBeenCalled();
  });

  test("an ended group with no connected account has nothing to disconnect", async () => {
    await seedGroup("unconnected", {
      status: "canceled",
      endedAt: at(-30 * HOUR),
      connected: false,
    });

    expect(await reconcileBilling(NOW)).toMatchObject({ connectsDisconnected: 0, failures: 0 });
    expect(connect.disconnect).not.toHaveBeenCalled();
  });
});
