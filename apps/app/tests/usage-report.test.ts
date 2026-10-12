import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  claimStripeMutationLease,
  getEntitlements,
  setMeteredPriceKeys,
} from "@/lib/billing/entitlements";
import { expectedMeteredKeys, reconcileMeteredItems } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { reportUsageToMeters, runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake, stripeError } from "./setup/stripe-fake";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * Overage reported to Stripe's meters (BD19, R17) and the metered-item
 * reconcile it relies on: a row is marked only after Stripe accepts it, a
 * 429 is "later" and never a failure, one reporter runs at a time, and a
 * clinic whose metered items do not match its bought package is reconciled
 * before any of its usage is sent.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "usage-report-test" } as const;
const NOW = new Date("2026-10-20T12:30:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

type Usage = {
  meter?: "voice_minutes" | "chat_conversations";
  overAllowance: number;
  occurredAt?: Date;
  attempts?: number;
  windowStart?: Date | null;
};

async function insertUsage(clinicId: string, usage: Usage): Promise<string> {
  return inTenant(clinicId, async (c) => {
    const meter = usage.meter ?? "voice_minutes";
    const { rows } = await c.query<{ id: string }>(
      `insert into usage_events
         (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at,
          window_start, included, used_before, over_allowance, stripe_report_attempts)
       values ($1, $1, $2, $3, $4, $5, $6, $7, 1000, 1000, $8, $9)
       returning id`,
      [
        clinicId,
        meter,
        meter === "voice_minutes" ? "voice_call" : "web_chat",
        `ref-${randomUUID()}`,
        Math.max(usage.overAllowance, 1),
        usage.occurredAt ?? new Date("2026-10-19T09:00:00Z"),
        usage.windowStart === undefined ? STARTED : usage.windowStart,
        usage.overAllowance,
        usage.attempts ?? 0,
      ],
    );
    return rows[0]!.id;
  });
}

async function usageRow(clinicId: string, id: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      stripe_reported_at: Date | null;
      stripe_report_attempts: number;
      stripe_report_error: string | null;
    }>(
      `select stripe_reported_at, stripe_report_attempts, stripe_report_error from usage_events where id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

/** A started monthly clinic bought as `bought`, its metered snapshot in step unless told otherwise. */
async function seedMonthly(
  label: string,
  options: {
    bought?: string;
    interval?: "month" | "year";
    started?: boolean;
    snapshot?: boolean;
  } = {},
) {
  const clinic = await seedClinic(label);
  const bought = options.bought ?? "web-voice";
  const interval = options.interval ?? "month";
  const ids = await seedEntitled(clinic.clinicId, {
    planId: bought,
    interval,
    ...(options.started === false ? {} : { planStartedAt: STARTED, planStartAppliedAt: STARTED }),
  });
  if (options.snapshot !== false) {
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      setMeteredPriceKeys(tx.db, clinic.clinicId, expectedMeteredKeys(bought, interval) ?? []),
    );
  }
  return {
    clinicId: clinic.clinicId,
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
  };
}

describeDb("usage reported to Stripe's meters", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    // Every test starts from no clinics: the reporter walks them all.
    await truncateAll();
    notifyOps.mockClear();
    __clearPriceCacheForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("a clinic with a plan change in flight is skipped until the change finishes or is dropped", async () => {
    // After a lost answer to an annual to monthly change the webhook already
    // says "month", but the annual months are not claimed yet (review fix).
    const clinic = await seedMonthly("meter-pending-change");
    const row = await insertUsage(clinic.clinicId, { overAllowance: 4 });
    const setPending = (requestId: string | null) =>
      inTenant(clinic.clinicId, (c) =>
        c.query(
          `update entitlements
              set pending_plan_change_request_id = $2,
                  pending_plan_change_plan_id = case when $2::text is null then null else 'web-voice' end,
                  pending_plan_change_interval = case when $2::text is null then null else 'month' end
            where clinic_id = $1`,
          [clinic.clinicId, requestId],
        ),
      );
    await setPending("req-pending-1");
    const fake = createStripeFake({ "billing.meterEvents.create": () => ({ identifier: "x" }) });

    expect(await reportUsageToMeters({ now: NOW, stripe: fake.stripe })).toMatchObject({
      clinics: 0,
      reported: 0,
      deferred: 1,
    });
    expect(fake.calls).toEqual([]);
    expect((await usageRow(clinic.clinicId, row)).stripe_reported_at).toBeNull();

    await setPending(null);
    expect(await reportUsageToMeters({ now: NOW, stripe: fake.stripe })).toMatchObject({
      clinics: 1,
      reported: 1,
      deferred: 0,
    });
  });

  test("each row over the allowance becomes one meter event, marked reported only after Stripe accepts it", async () => {
    const clinic = await seedMonthly("meter-basic");
    const accepted = await insertUsage(clinic.clinicId, { overAllowance: 3 });
    const refused = await insertUsage(clinic.clinicId, {
      meter: "chat_conversations",
      overAllowance: 1,
      occurredAt: new Date("2026-10-19T10:00:00Z"),
    });
    const within = await insertUsage(clinic.clinicId, { overAllowance: 0 });
    const tooOld = await insertUsage(clinic.clinicId, {
      overAllowance: 2,
      occurredAt: new Date("2026-09-10T00:00:00Z"),
    });
    let call = 0;
    const fake = createStripeFake({
      "billing.meterEvents.create": () => {
        call += 1;
        if (call === 2) throw stripeError("api", { statusCode: 500 });
        return { identifier: "x" };
      },
    });

    const summary = await reportUsageToMeters({ now: NOW, stripe: fake.stripe });
    expect(summary).toEqual({
      ran: true,
      clinics: 1,
      reported: 1,
      failed: 1,
      deferred: 0,
      rateLimited: false,
    });
    const calls = fake.callsTo("billing.meterEvents.create");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0]).toEqual({
      event_name: "healdesk_voice_minutes",
      payload: { stripe_customer_id: clinic.customerId, value: "3" },
      identifier: `hd_${accepted}`,
      timestamp: s(new Date("2026-10-19T09:00:00Z")),
    });
    expect(calls[0]!.args[1]).toMatchObject({ idempotencyKey: `hd-meter:${accepted}` });
    expect(calls[1]!.args[0]).toMatchObject({
      event_name: "healdesk_chat_conversations",
      identifier: `hd_${refused}`,
    });

    expect(await usageRow(clinic.clinicId, accepted)).toEqual({
      stripe_reported_at: NOW,
      stripe_report_attempts: 1,
      stripe_report_error: null,
    });
    expect(await usageRow(clinic.clinicId, refused)).toEqual({
      stripe_reported_at: null,
      stripe_report_attempts: 1,
      stripe_report_error: "api_error:500",
    });
    expect(await usageRow(clinic.clinicId, within)).toMatchObject({ stripe_report_attempts: 0 });
    expect(await usageRow(clinic.clinicId, tooOld)).toMatchObject({ stripe_report_attempts: 0 });
    expect(notifyOps).not.toHaveBeenCalled();

    // A reported row is never sent again.
    const again = createStripeFake({ "billing.meterEvents.create": () => ({}) });
    await reportUsageToMeters({ now: NOW, stripe: again.stripe });
    expect(
      again
        .callsTo("billing.meterEvents.create")
        .map((c) => (c.args[0] as { identifier: string }).identifier),
    ).toEqual([`hd_${refused}`]);
  });

  test("a 429 stops the run where it is and counts nothing against the row", async () => {
    const clinic = await seedMonthly("meter-429");
    const first = await insertUsage(clinic.clinicId, { overAllowance: 1 });
    await insertUsage(clinic.clinicId, {
      overAllowance: 1,
      occurredAt: new Date("2026-10-19T11:00:00Z"),
    });
    const fake = createStripeFake({
      "billing.meterEvents.create": () => {
        throw stripeError("rate_limit");
      },
    });
    const summary = await reportUsageToMeters({ now: NOW, stripe: fake.stripe });
    expect(summary).toMatchObject({ reported: 0, failed: 0, rateLimited: true });
    expect(fake.callsTo("billing.meterEvents.create")).toHaveLength(1);
    expect(await usageRow(clinic.clinicId, first)).toEqual({
      stripe_reported_at: null,
      stripe_report_attempts: 0,
      stripe_report_error: null,
    });
  });

  test("repeated failures tell ops", async () => {
    const clinic = await seedMonthly("meter-failing");
    await insertUsage(clinic.clinicId, { overAllowance: 1, attempts: 2 });
    const fake = createStripeFake({
      "billing.meterEvents.create": () => {
        throw stripeError("invalid_request", { code: "resource_missing" });
      },
    });
    await reportUsageToMeters({ now: NOW, stripe: fake.stripe });
    expect(notifyOps).toHaveBeenCalledWith("meter_report_failing", {
      clinicId: clinic.clinicId,
      count: 1,
    });
  });

  test("annual, unstarted and cancelled clinics are left alone", async () => {
    const annual = await seedMonthly("meter-annual", { interval: "year" });
    await insertUsage(annual.clinicId, { overAllowance: 4 });
    const unstarted = await seedMonthly("meter-unstarted", { started: false });
    await insertUsage(unstarted.clinicId, { overAllowance: 4, windowStart: null });
    const canceled = await seedMonthly("meter-canceled");
    await insertUsage(canceled.clinicId, { overAllowance: 4 });
    await inTenant(canceled.clinicId, (c) =>
      c.query(`update entitlements set status = 'canceled' where clinic_id = $1`, [
        canceled.clinicId,
      ]),
    );
    const fake = createStripeFake();
    expect(await reportUsageToMeters({ now: NOW, stripe: fake.stripe })).toMatchObject({
      clinics: 0,
      reported: 0,
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("metered items out of step are reconciled first, and a clinic that cannot be reconciled is deferred, not reported", async () => {
    const clinic = await seedMonthly("meter-reconcile", { bought: "web-voice", snapshot: false });
    const id = await insertUsage(clinic.clinicId, { overAllowance: 2 });
    const world: StripeWorld = createStripeWorld({
      customerId: clinic.customerId,
      subscriptionId: clinic.subscriptionId,
      // Sold as AYA Web Chat's rate, which the bought Web + Voice package is not.
      items: [
        { lookupKey: "healdesk_web-voice_month_89700" },
        { lookupKey: "healdesk_meter_chat_conversations_block100_4000" },
      ],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    world.fake.on("billing.meterEvents.create", () => ({}));
    const chatItem = world.state.subscription.items.data[1]!.id;

    expect(await reportUsageToMeters({ now: NOW, stripe: world.stripe })).toMatchObject({
      reported: 1,
      deferred: 0,
    });
    const [update] = world.fake.callsTo("subscriptions.update");
    expect(update!.args[1]).toEqual({
      items: [
        { id: chatItem, deleted: true },
        { price: "price_healdesk_meter_chat_conversations_block100_3000" },
        { price: "price_healdesk_meter_voice_minutes_block100_8000" },
      ],
      proration_behavior: "none",
      off_session: true,
      expand: ["items.data.price"],
    });
    expect(update!.args[2]).toMatchObject({
      idempotencyKey: expect.stringMatching(/^hd-metered:/),
    });
    const row = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      getEntitlements(tx.db, clinic.clinicId),
    );
    expect(row!.meteredPriceKeys).toEqual([
      "healdesk_meter_chat_conversations_block100_3000",
      "healdesk_meter_voice_minutes_block100_8000",
    ]);
    expect((await usageRow(clinic.clinicId, id)).stripe_reported_at).toEqual(NOW);

    // Another clinic whose subscription is mid-change elsewhere: deferred.
    const busy = await seedMonthly("meter-busy", { snapshot: false });
    await insertUsage(busy.clinicId, { overAllowance: 1 });
    await withTenant({ clinicId: busy.clinicId, actor }, (tx) =>
      claimStripeMutationLease(tx.db, busy.clinicId, "change_plan:other"),
    );
    const quiet = createStripeFake();
    expect(await reportUsageToMeters({ now: NOW, stripe: quiet.stripe })).toMatchObject({
      deferred: 1,
      reported: 0,
    });
    expect(quiet.calls.map((c) => c.method)).toEqual([]);
  });

  test("one reporter at a time: a second run while the lock is held does nothing", async () => {
    const clinic = await seedMonthly("meter-lock");
    await insertUsage(clinic.clinicId, { overAllowance: 1 });
    const holder = await getAppPool().connect();
    try {
      await holder.query(
        `select pg_advisory_lock(hashtextextended('healdesk:usage-meter-report', 0))`,
      );
      const fake = createStripeFake();
      expect(await reportUsageToMeters({ now: NOW, stripe: fake.stripe })).toMatchObject({
        ran: false,
      });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await holder.query(
        `select pg_advisory_unlock(hashtextextended('healdesk:usage-meter-report', 0))`,
      );
      holder.release();
    }
  });

  test("the job reads its own switch, records the run, and takes no 60-minute lock", async () => {
    await seedMonthly("meter-job");
    const fake = createStripeFake();
    expect(await runUsageMeterReportJob({ now: NOW, stripe: fake.stripe })).toEqual({
      status: "disabled",
    });
    await getMigratorPool().query(
      `update scheduled_jobs set enabled = true where name = 'usage-meter-report'`,
    );
    const outcome = await runUsageMeterReportJob({ now: NOW, stripe: fake.stripe });
    expect(outcome).toEqual({
      status: "ok",
      note: "Reported 0 overage events for 0 clinics; 0 failed, 0 clinics deferred.",
    });
    const { rows } = await getMigratorPool().query<{
      running_since: Date | null;
      last_run_status: string;
    }>(
      `select running_since, last_run_status from scheduled_jobs where name = 'usage-meter-report'`,
    );
    expect(rows[0]).toEqual({ running_since: null, last_run_status: "ok" });
  });
});

describeDb("reconcileMeteredItems", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    __clearPriceCacheForTests();
  });

  afterAll(async () => {
    await closePools();
  });

  test("ok when the items already match, writing the snapshot from what Stripe holds", async () => {
    const clinic = await seedMonthly("reconcile-ok", { bought: "chat-web", snapshot: false });
    const world = createStripeWorld({
      customerId: clinic.customerId,
      subscriptionId: clinic.subscriptionId,
      items: [
        { lookupKey: "healdesk_chat-web_month_39700" },
        { lookupKey: "healdesk_meter_chat_conversations_block100_4000" },
      ],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    expect(await reconcileMeteredItems(clinic.clinicId, { stripe: world.stripe })).toEqual({
      status: "ok",
    });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    const row = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      getEntitlements(tx.db, clinic.clinicId),
    );
    expect(row).toMatchObject({
      meteredPriceKeys: ["healdesk_meter_chat_conversations_block100_4000"],
      stripeMutationLeaseOwner: null,
    });
  });

  test("never adds metered items before the plan starts, and never touches an item that is not ours", async () => {
    const pre = await seedMonthly("reconcile-pre", { started: false, snapshot: false });
    const fake = createStripeFake();
    expect(await reconcileMeteredItems(pre.clinicId, { stripe: fake.stripe })).toEqual({
      status: "skipped",
      reason: "not_started",
    });
    expect(fake.calls).toHaveLength(0);

    const foreign = await seedMonthly("reconcile-foreign", { bought: "chat-web", snapshot: false });
    const world = createStripeWorld({
      customerId: foreign.customerId,
      subscriptionId: foreign.subscriptionId,
      items: [
        { lookupKey: "healdesk_chat-web_month_39700" },
        { lookupKey: "healdesk_meter_chat_conversations_block100_4000" },
      ],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    // A metered item another product on the shared account added by hand.
    world.state.subscription.items.data.push({
      id: "si_foreign",
      price: {
        id: "price_other",
        lookup_key: "scalabid_meter_x",
        recurring: { usage_type: "metered" },
      },
    });
    expect(await reconcileMeteredItems(foreign.clinicId, { stripe: world.stripe })).toEqual({
      status: "ok",
    });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
  });

  test("a subscription still on the per-unit prices of 5 October is moved onto the block prices", async () => {
    // What a monthly checkout attached before overage was billed per started
    // block of 100 (6 October 2026). stripe-setup archives those prices, which
    // stops them being sold but not billed: only this swap moves the clinic.
    const clinic = await seedMonthly("reconcile-per-unit", {
      bought: "web-voice",
      snapshot: false,
    });
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      setMeteredPriceKeys(tx.db, clinic.clinicId, [
        "healdesk_meter_chat_conversations_30",
        "healdesk_meter_voice_minutes_80",
      ]),
    );
    const world = createStripeWorld({
      customerId: clinic.customerId,
      subscriptionId: clinic.subscriptionId,
      items: [
        { lookupKey: "healdesk_web-voice_month_89700" },
        { lookupKey: "healdesk_meter_voice_minutes_80" },
        { lookupKey: "healdesk_meter_chat_conversations_30" },
      ],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    const [packageItem, voiceItem, chatItem] = world.state.subscription.items.data.map(
      (item) => item.id as string,
    );

    expect(await reconcileMeteredItems(clinic.clinicId, { stripe: world.stripe })).toEqual({
      status: "fixed",
    });
    const updates = world.fake.callsTo("subscriptions.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[1]).toEqual({
      items: [
        { id: voiceItem, deleted: true },
        { id: chatItem, deleted: true },
        { price: "price_healdesk_meter_chat_conversations_block100_3000" },
        { price: "price_healdesk_meter_voice_minutes_block100_8000" },
      ],
      proration_behavior: "none",
      off_session: true,
      expand: ["items.data.price"],
    });
    // The package item is untouched; the metered items now bill $30 and $80 a
    // started block of 100, the period's total divided by 100 and rounded up.
    const items = world.state.subscription.items.data as {
      id: string;
      price: { lookup_key: string; unit_amount: number; transform_quantity: unknown };
    }[];
    expect(items.map((item) => item.id)).toContain(packageItem);
    expect(
      items
        .filter((item) => item.id !== packageItem)
        .map((item) => [
          item.price.lookup_key,
          item.price.unit_amount,
          item.price.transform_quantity,
        ]),
    ).toEqual([
      ["healdesk_meter_chat_conversations_block100_3000", 3_000, { divide_by: 100, round: "up" }],
      ["healdesk_meter_voice_minutes_block100_8000", 8_000, { divide_by: 100, round: "up" }],
    ]);
    const row = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      getEntitlements(tx.db, clinic.clinicId),
    );
    expect(row).toMatchObject({
      meteredPriceKeys: [
        "healdesk_meter_chat_conversations_block100_3000",
        "healdesk_meter_voice_minutes_block100_8000",
      ],
      stripeMutationLeaseOwner: null,
    });

    // Moved once: the next pass finds the items right and changes nothing.
    expect(await reconcileMeteredItems(clinic.clinicId, { stripe: world.stripe })).toEqual({
      status: "ok",
    });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
  });

  test("a trialing subscription is reported as a fault, never built on", async () => {
    const clinic = await seedMonthly("reconcile-trialing", { bought: "chat-web", snapshot: false });
    const world = createStripeWorld({
      customerId: clinic.customerId,
      subscriptionId: clinic.subscriptionId,
      items: [{ lookupKey: "healdesk_chat-web_month_39700" }],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    world.state.subscription.status = "trialing";
    expect(await reconcileMeteredItems(clinic.clinicId, { stripe: world.stripe })).toEqual({
      status: "failed",
      reason: "trialing",
    });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
  });

  test("failed with a closed code when Stripe refuses, and the lease is released", async () => {
    const clinic = await seedMonthly("reconcile-fail", { snapshot: false });
    const fake = createStripeFake({
      "subscriptions.retrieve": () => {
        throw stripeError("api", { statusCode: 503 });
      },
    });
    expect(await reconcileMeteredItems(clinic.clinicId, { stripe: fake.stripe })).toEqual({
      status: "failed",
      reason: "api_error:503",
    });
    const row = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      getEntitlements(tx.db, clinic.clinicId),
    );
    expect(row!.stripeMutationLeaseOwner).toBeNull();
  });
});
