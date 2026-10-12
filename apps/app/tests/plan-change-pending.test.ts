import { randomUUID } from "node:crypto";

import { channelList, getPlan, type Channel } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { invoiceAnnualOverage } from "@/lib/billing/annual-overage";
import { getEntitlements } from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { changePlan, resumePlanChange, STALE_PLAN_CHANGE_MS } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { previewChangePlan } from "@/lib/billing/summary";
import { recordUsage } from "@/lib/billing/usage";
import { reportUsageToMeters } from "@/lib/billing/usage-report";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * Review fixes of 7 October 2026 to changePlan:
 *
 *   - [0]/[2] a plan change is recorded on the billing row before anything
 *     is charged, so a fresh request after a lost answer carries it on and
 *     finds its charge instead of charging the setup-fee difference again, a
 *     different change waits for it, and the hourly reconcile finishes (or,
 *     with nothing charged, drops) one nobody came back for;
 *   - [20] an interval change re-anchors Stripe's billing cycle, and the
 *     allowance window moves with it; leaving annual billing hands the annual
 *     months' overage to the annual overage invoice before the meter reporter
 *     can see it.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "plan-change-pending-test" } as const;
const NOW = new Date("2026-10-21T12:00:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const PERIOD_END = new Date("2026-11-07T00:00:00Z");
const MINUTE = 60_000;
const s = (date: Date) => Math.floor(date.getTime() / 1000);
/** The clock leases are compared on: the reconcile honours a pinned `now` ahead of the wall clock. */
const leaseClock = () => Math.max(NOW.getTime(), Date.now());

let world: StripeWorld;

function install(next: StripeWorld): StripeWorld {
  world = next;
  __setStripeForTests(next.stripe);
  return next;
}

async function rowOf(clinicId: string) {
  const row = await withTenant({ clinicId, actor }, (tx) => getEntitlements(tx.db, clinicId));
  if (!row) throw new Error("no entitlements");
  return row;
}

async function noticesOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      kind: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>(
      `select kind, dedupe_key, payload from billing_notices where clinic_id = $1 order by created_at, dedupe_key`,
      [clinicId],
    );
    return rows;
  });
}

async function notesOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ reason: string; actor: string }>(
      `select reason, actor from billing_transitions where clinic_id = $1 and from_status = to_status order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

/** Move the Stripe mutation lease's expiry, keeping its holder. */
async function setLeaseUntil(clinicId: string, until: Date) {
  await inTenant(clinicId, (c) =>
    c.query(
      `update entitlements set stripe_mutation_lease_until = $2
        where clinic_id = $1 and stripe_mutation_lease_owner is not null`,
      [clinicId, until],
    ),
  );
}

type Seeded = { clinicId: string; customerId: string; subscriptionId: string };

async function seedBilling(
  label: string,
  options: {
    bought: string;
    billed?: string;
    interval?: "month" | "year";
    inService?: Channel[];
    started?: boolean;
    planStartedAt?: Date;
  },
): Promise<Seeded> {
  const clinic = await seedClinic(label);
  const bought = getPlan(options.bought)!;
  const started = options.started !== false;
  const startedAt = options.planStartedAt ?? STARTED;
  const ids = await seedEntitled(clinic.clinicId, {
    planId: options.billed ?? options.bought,
    boughtPlanId: options.bought,
    interval: options.interval ?? "month",
    ...(started ? { planStartedAt: startedAt, planStartAppliedAt: startedAt } : {}),
    channelRows: channelList(bought).map((channel) => ({
      channel,
      readyAt: startedAt,
      liveAt: options.inService?.includes(channel) ? startedAt : null,
      firstAnswerAt: options.inService?.includes(channel) ? startedAt : null,
    })),
  });
  return {
    clinicId: clinic.clinicId,
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
  };
}

/** A started monthly subscription: the billed package and the bought package's metered items. */
function startedWorld(seeded: Seeded, options: { bought: string; billed: string }): StripeWorld {
  const billed = getPlan(options.billed)!;
  return install(
    createStripeWorld({
      customerId: seeded.customerId,
      subscriptionId: seeded.subscriptionId,
      items: [
        { lookupKey: `healdesk_${billed.id}_month_${billed.monthlyUsd * 100}` },
        ...(expectedMeteredKeys(options.bought, "month") ?? []).map((lookupKey) => ({
          lookupKey,
        })),
      ],
      periodStart: s(STARTED),
      periodEnd: s(PERIOD_END),
      customerDefaultPm: "pm_customer",
      subscriptionDefaultPm: null,
      nowSeconds: s(NOW),
    }),
  );
}

const change = (
  clinicId: string,
  requestId: string,
  overrides: { planId?: string; interval?: "month" | "year" } = {},
) => ({
  clinicId,
  planId: overrides.planId ?? "web-voice",
  interval: overrides.interval ?? ("month" as const),
  requestId,
  actorLabel: "owner@clinic.test",
});

const setupInvoices = () =>
  world.state.invoices
    .filter((invoice) => invoice.metadata.hd_kind === "plan_change_setup")
    .map((invoice) => [invoice.metadata.hd_ref, invoice.status]);

describeDb("a plan change in flight", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
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

  test("a lost answer, then a fresh request once the lease has run out: the difference is charged once and the change applied", async () => {
    // Bought and billed as AYA Web Chat, moving to Web + Voice with voice not
    // in service yet: the billed package stays, so the $500 difference goes
    // on a one-off invoice and a second update sets the marker.
    const seeded = await seedBilling("pc-adopt", { bought: "chat-web", inService: ["web"] });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    await inTenant(seeded.clinicId, (c) =>
      c.query(`update entitlements set used_chat_conversations = 42 where clinic_id = $1`, [
        seeded.clinicId,
      ]),
    );
    // The difference is paid, then the marker update fails: the answer is lost.
    world.state.failNextUpdate = true;
    const first = await changePlan(change(seeded.clinicId, "req-a1"), { now: NOW });
    expect(first).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/never charged twice/),
    });
    expect(setupInvoices()).toEqual([["req-a1", "paid"]]);
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "chat-web",
      pendingPlanChangeRequestId: "req-a1",
      pendingPlanChangePlanId: "web-voice",
      pendingPlanChangeInterval: "month",
      stripeMutationLeaseOwner: "change_plan:req-a1",
    });

    // The portal mints a fresh request id per attempt (contracts §2), and
    // this one comes after the first attempt's lease has run out.
    await setLeaseUntil(seeded.clinicId, new Date(Date.now() - MINUTE));
    const second = await changePlan(change(seeded.clinicId, "req-a2"), { now: NOW });
    expect(second).toMatchObject({ status: "changed", droppedChannels: [] });

    // One invoice, paid once, under the first request; the marker is its.
    expect(setupInvoices()).toEqual([["req-a1", "paid"]]);
    expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
    expect(world.fake.callsTo("invoices.pay")).toHaveLength(1);
    expect(world.state.subscription.metadata.hd_plan_change).toBe("req-a1");
    const row = await rowOf(seeded.clinicId);
    expect(row).toMatchObject({
      boughtPlanId: "web-voice",
      planCode: "chat-web",
      channelsEnabled: { web: true, meta: false, voice: true },
      pendingPlanChangeRequestId: null,
      pendingPlanChangePlanId: null,
      pendingPlanChangeInterval: null,
      stripeMutationLeaseOwner: null,
      stripeMutationLeaseUntil: null,
      // The interval did not change, so neither did the cycle or the window.
      currentPeriodStart: STARTED,
      currentPeriodEnd: PERIOD_END,
      usedChatConversations: 42,
    });
    const notices = await noticesOf(seeded.clinicId);
    expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([["plan_changed", "plan:req-a1"]]);
    expect(notices[0]!.payload).toMatchObject({
      setupFeeDeltaCents: 50_000,
      hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
    });
  });

  test("the same after a single update that applied but lost its answer: the marker is found, and nothing is charged again", async () => {
    const seeded = await seedBilling("pc-adopt-update", { bought: "chat-web", inService: ["web"] });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    // Annual billing is a new billed price: one update carries the difference.
    world.state.loseNextUpdateResponse = true;
    const yearly = { interval: "year" as const };
    expect(await changePlan(change(seeded.clinicId, "req-u1", yearly), { now: NOW })).toMatchObject(
      { status: "refused" },
    );
    expect(world.state.subscription.metadata.hd_plan_change).toBe("req-u1");

    await setLeaseUntil(seeded.clinicId, new Date(Date.now() - MINUTE));
    expect(await changePlan(change(seeded.clinicId, "req-u2", yearly), { now: NOW })).toMatchObject(
      { status: "changed" },
    );
    // Only the first update, which carried the difference; no one-off invoice.
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "web-voice",
      billingInterval: "year",
      pendingPlanChangeRequestId: null,
      stripeMutationLeaseOwner: null,
    });
    expect((await noticesOf(seeded.clinicId)).map((n) => n.dedupe_key)).toEqual(["plan:req-u1"]);
  });

  test("while a change is pending a different one is refused, charging nothing, and the previews say so", async () => {
    const seeded = await seedBilling("pc-other", { bought: "chat-web", inService: ["web"] });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    world.state.failNextUpdate = true;
    await changePlan(change(seeded.clinicId, "req-b1"), { now: NOW });

    // While its lease runs, even the same change asked afresh is busy.
    expect(await changePlan(change(seeded.clinicId, "req-b2"), { now: NOW })).toMatchObject({
      status: "busy",
    });

    await setLeaseUntil(seeded.clinicId, new Date(Date.now() - MINUTE));
    const asked = world.fake.calls.length;
    const inProgress = /A change to Web \+ Voice, billed monthly, is still being completed/;
    expect(
      await changePlan(change(seeded.clinicId, "req-b3", { planId: "complete" }), { now: NOW }),
    ).toEqual({ status: "refused", message: expect.stringMatching(inProgress) });
    expect(
      await changePlan(change(seeded.clinicId, "req-b4", { interval: "year" }), { now: NOW }),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(inProgress) });
    expect(world.fake.calls.length).toBe(asked);
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "chat-web",
      pendingPlanChangeRequestId: "req-b1",
    });
    expect(setupInvoices()).toEqual([["req-b1", "paid"]]);

    expect(
      await previewChangePlan(
        { clinicId: seeded.clinicId, planId: "complete", interval: "month" },
        { now: NOW },
      ),
    ).toEqual({ status: "refused", message: expect.stringMatching(inProgress) });
    expect(
      await previewChangePlan(
        { clinicId: seeded.clinicId, planId: "web-voice", interval: "month" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "ok", planId: "web-voice", isInProgress: true });
  });

  test("a decline, or a refusal before anything is charged, ends the change: nothing stays pending to hold up the next", async () => {
    const seeded = await seedBilling("pc-ended", {
      bought: "complete",
      billed: "web-voice",
      inService: ["web", "voice"],
    });
    startedWorld(seeded, { bought: "complete", billed: "web-voice" });
    world.state.declineNextUpdate = true;
    expect(
      await changePlan(change(seeded.clinicId, "req-e1", { planId: "chat-web" }), { now: NOW }),
    ).toMatchObject({ status: "payment_failed" });
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "complete",
      pendingPlanChangeRequestId: null,
      stripeMutationLeaseOwner: null,
    });

    world.state.subscription.status = "trialing";
    expect(
      await changePlan(change(seeded.clinicId, "req-e2", { planId: "chat-web" }), { now: NOW }),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/never puts one in/) });
    expect((await rowOf(seeded.clinicId)).pendingPlanChangeRequestId).toBeNull();

    // A different change goes ahead straight away.
    world.state.subscription.status = "active";
    expect(await changePlan(change(seeded.clinicId, "req-e3"), { now: NOW })).toMatchObject({
      status: "changed",
    });
    expect((await rowOf(seeded.clinicId)).boughtPlanId).toBe("web-voice");
  });

  test("the hourly reconcile finishes a change left pending once it is stale, from its paid difference, charging nothing", async () => {
    const seeded = await seedBilling("pc-reconcile", { bought: "chat-web", inService: ["web"] });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    world.state.failNextUpdate = true;
    await changePlan(change(seeded.clinicId, "req-c1"), { now: NOW });
    const paid = world.state.invoices.find((invoice) => invoice.metadata.hd_ref === "req-c1")!;

    // Its lease ran out a minute ago, so it was touched six minutes ago: not stale yet.
    await setLeaseUntil(seeded.clinicId, new Date(leaseClock() - MINUTE));
    const asked = world.fake.calls.length;
    await reconcileBilling(NOW);
    expect(world.fake.calls.length).toBe(asked);
    expect((await rowOf(seeded.clinicId)).pendingPlanChangeRequestId).toBe("req-c1");

    // Untouched for eleven minutes: the reconcile finishes it.
    await setLeaseUntil(seeded.clinicId, new Date(leaseClock() - 6 * MINUTE));
    expect(STALE_PLAN_CHANGE_MS).toBe(10 * MINUTE);
    await reconcileBilling(NOW);

    expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
    expect(world.fake.callsTo("invoices.pay")).toHaveLength(1);
    const updates = world.fake.callsTo("subscriptions.update");
    expect(updates).toHaveLength(2);
    expect(updates[1]!.args[1]).toEqual({
      items: [
        { id: expect.any(String), deleted: true },
        { price: "price_healdesk_meter_chat_conversations_block100_3000" },
        { price: "price_healdesk_meter_voice_minutes_block100_8000" },
      ],
      proration_behavior: "none",
      off_session: true,
      metadata: { hd_plan_change: "req-c1", hd_plan_change_prorated: "false" },
      expand: ["items.data.price"],
    });
    // A key of the resume's own: a failure Stripe cached under the
    // request's key is never replayed.
    expect((updates[1]!.args[2] as { idempotencyKey: string }).idempotencyKey).toMatch(
      new RegExp(`^hd-plan:${seeded.clinicId}:req-c1:marker:resume_plan:`),
    );
    expect(world.state.subscription.metadata.hd_plan_change).toBe("req-c1");
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "web-voice",
      channelsEnabled: { web: true, meta: false, voice: true },
      meteredPriceKeys: [
        "healdesk_meter_chat_conversations_block100_3000",
        "healdesk_meter_voice_minutes_block100_8000",
      ],
      pendingPlanChangeRequestId: null,
      stripeMutationLeaseOwner: null,
    });
    const notices = await noticesOf(seeded.clinicId);
    expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([["plan_changed", "plan:req-c1"]]);
    expect(notices[0]!.payload).toMatchObject({
      hostedInvoiceUrl: `https://invoice.stripe.com/i/${paid.id}`,
      setupFeeDeltaCents: 50_000,
    });
    expect(await notesOf(seeded.clinicId)).toContainEqual({
      reason: "plan_change",
      actor: "system",
    });

    // A second run finds nothing pending and asks Stripe nothing.
    const after = world.fake.calls.length;
    await reconcileBilling(NOW);
    expect(world.fake.calls.length).toBe(after);
  });

  test("the resume of a prorating change still says it was prorated after the webhook has written the new interval to our row", async () => {
    const seeded = await seedBilling("pc-resume-prorated", {
      bought: "chat-web",
      inService: ["web"],
    });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    world.state.loseNextUpdateResponse = true;
    const yearly = { interval: "year" as const };
    expect(await changePlan(change(seeded.clinicId, "req-r1", yearly), { now: NOW })).toMatchObject(
      { status: "refused" },
    );
    // customer.subscription.updated lands first and applies Stripe's
    // interval, so our row no longer differs from what Stripe bills.
    await inTenant(seeded.clinicId, (c) =>
      c.query(`update entitlements set billing_interval = 'year' where clinic_id = $1`, [
        seeded.clinicId,
      ]),
    );
    await setLeaseUntil(seeded.clinicId, new Date(leaseClock() - 6 * MINUTE));

    expect(
      await resumePlanChange(
        {
          clinicId: seeded.clinicId,
          actorLabel: "billing-reconcile",
          staleAfterMs: STALE_PLAN_CHANGE_MS,
        },
        { now: NOW },
      ),
    ).toMatchObject({ status: "changed" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    const [notice] = await noticesOf(seeded.clinicId);
    expect(notice!.payload).toMatchObject({ interval: "year", isProrated: true });
  });

  test("a pending change Stripe holds no charge for is dropped: what was left open voided, a draft deleted, nothing charged", async () => {
    const seeded = await seedBilling("pc-drop", { bought: "chat-web", inService: ["web"] });
    startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
    // An attempt that died between finalizing its invoice and paying it, and
    // one of its drafts, under the pending request.
    const open = world.addInvoice({
      status: "open",
      metadata: { hd_kind: "plan_change_setup", hd_ref: "req-d0" },
    });
    const draft = world.addInvoice({
      status: "draft",
      metadata: { hd_kind: "plan_change_setup", hd_ref: "req-d0" },
    });
    await inTenant(seeded.clinicId, (c) =>
      c.query(
        `update entitlements set pending_plan_change_request_id = 'req-d0',
           pending_plan_change_plan_id = 'web-voice', pending_plan_change_interval = 'month'
         where clinic_id = $1`,
        [seeded.clinicId],
      ),
    );

    expect(
      await resumePlanChange(
        {
          clinicId: seeded.clinicId,
          actorLabel: "billing-reconcile",
          staleAfterMs: STALE_PLAN_CHANGE_MS,
        },
        { now: NOW },
      ),
    ).toEqual({ status: "cleared" });
    expect(world.fake.callsTo("invoices.voidInvoice").map((call) => call.args[0])).toEqual([
      open.id,
    ]);
    expect(world.fake.callsTo("invoices.del").map((call) => call.args[0])).toEqual([draft.id]);
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    expect(world.fake.callsTo("invoices.pay")).toHaveLength(0);
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "chat-web",
      pendingPlanChangeRequestId: null,
      stripeMutationLeaseOwner: null,
    });
    expect(await noticesOf(seeded.clinicId)).toEqual([]);
    expect(await notesOf(seeded.clinicId)).toContainEqual({
      reason: "plan_change_cleared",
      actor: "system",
    });

    // The clinic can now make a change again.
    expect(
      await resumePlanChange({ clinicId: seeded.clinicId, actorLabel: "billing-reconcile" }),
    ).toEqual({ status: "nothing_pending" });
  });

  test("before the start, a pending change whose difference was paid is finished locally, with no subscription update", async () => {
    const seeded = await seedBilling("pc-pre", { bought: "chat-web", started: false });
    install(
      createStripeWorld({
        customerId: seeded.customerId,
        subscriptionId: seeded.subscriptionId,
        items: [{ lookupKey: "healdesk_plan_start_placeholder_month", quantity: 1 }],
        periodStart: s(new Date("2026-10-01T00:00:00Z")),
        periodEnd: s(new Date("2026-11-01T00:00:00Z")),
        customerDefaultPm: null,
        subscriptionDefaultPm: "pm_from_checkout",
        nowSeconds: s(NOW),
      }),
    );
    const paid = world.addInvoice({
      status: "paid",
      metadata: { hd_kind: "plan_change_setup", hd_ref: "req-pre" },
      amount_paid: 50_000,
    });
    await inTenant(seeded.clinicId, (c) =>
      c.query(
        `update entitlements set pending_plan_change_request_id = 'req-pre',
           pending_plan_change_plan_id = 'web-voice', pending_plan_change_interval = 'year'
         where clinic_id = $1`,
        [seeded.clinicId],
      ),
    );

    expect(
      await resumePlanChange(
        { clinicId: seeded.clinicId, actorLabel: "billing-reconcile" },
        { now: NOW },
      ),
    ).toEqual({ status: "changed", hostedInvoiceUrl: `https://invoice.stripe.com/i/${paid.id}` });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      boughtPlanId: "web-voice",
      planCode: "web-voice",
      billingInterval: "year",
      pendingPlanChangeRequestId: null,
    });
    const [notice] = await noticesOf(seeded.clinicId);
    expect(notice).toMatchObject({
      kind: "plan_changed",
      dedupe_key: "plan:req-pre",
      payload: expect.objectContaining({ isBeforeStart: true, billedPlanId: null }),
    });
  });
});

// -----------------------------------------------------------------------------
// [20] An interval change re-anchors the cycle, and the window follows
// -----------------------------------------------------------------------------

const A_START = new Date("2026-08-01T00:00:00Z");
const W1 = A_START;
const W2 = new Date("2026-09-01T00:00:00Z");
const W3 = new Date("2026-10-01T00:00:00Z");
const W4 = new Date("2026-11-01T00:00:00Z");
/** Day 20 of the annual month W3. */
const A_NOW = NOW;
const MONTH_AFTER = new Date("2026-11-21T12:00:00Z");

async function insertUsage(
  clinicId: string,
  usage: {
    meter: "voice_minutes" | "chat_conversations";
    overAllowance: number;
    windowStart: Date;
    occurredAt: Date;
  },
): Promise<string> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into usage_events
         (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at,
          window_start, included, used_before, over_allowance)
       values ($1, $1, $2, $3, $4, $5, $6, $7, 1000, 1000, $8) returning id`,
      [
        clinicId,
        usage.meter,
        usage.meter === "voice_minutes" ? "voice_call" : "web_chat",
        `ref-${randomUUID()}`,
        Math.max(usage.overAllowance, 1),
        usage.occurredAt,
        usage.windowStart,
        usage.overAllowance,
      ],
    );
    return rows[0]!.id;
  });
}

async function usageRowsOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      stripe_reported_at: Date | null;
      stripe_report_error: string | null;
    }>(
      `select id, stripe_reported_at, stripe_report_error from usage_events where clinic_id = $1`,
      [clinicId],
    );
    return new Map(rows.map((row) => [row.id, row]));
  });
}

async function ledgerOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      window_start: Date;
      window_end: Date;
      status: string;
      voice_units: number;
      chat_units: number;
      voice_rate_cents: number;
      chat_rate_cents: number;
      amount_cents: number;
    }>(
      `select window_start, window_end, status, voice_units, chat_units, voice_rate_cents,
              chat_rate_cents, amount_cents
         from overage_invoices where clinic_id = $1 order by window_start`,
      [clinicId],
    );
    return rows;
  });
}

describeDb("an interval change after the start", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
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

  test("annual to monthly on day 20 of an allowance month: the window re-opens from the new period, and the annual months' overage goes to the annual invoice, never to a meter", async () => {
    const seeded = await seedBilling("iv-leave-annual", {
      bought: "web-voice",
      interval: "year",
      inService: ["web", "voice"],
      planStartedAt: A_START,
    });
    await inTenant(seeded.clinicId, (c) =>
      c.query(
        `update entitlements set current_period_start = $2, current_period_end = $3,
           used_voice_minutes = 1200, used_chat_conversations = 900
         where clinic_id = $1`,
        [seeded.clinicId, W3, W4],
      ),
    );
    // W1 was invoiced by the annual job; W2 closed and is not invoiced yet;
    // W3 is the month in progress. Every row over the allowance is unreported:
    // an annual clinic's rows never go to a meter.
    const w1Row = await insertUsage(seeded.clinicId, {
      meter: "voice_minutes",
      overAllowance: 50,
      windowStart: W1,
      occurredAt: new Date("2026-08-04T10:00:00Z"),
    });
    const w2Row = await insertUsage(seeded.clinicId, {
      meter: "voice_minutes",
      overAllowance: 80,
      windowStart: W2,
      occurredAt: new Date("2026-09-26T10:00:00Z"),
    });
    const w3Row = await insertUsage(seeded.clinicId, {
      meter: "chat_conversations",
      overAllowance: 30,
      windowStart: W3,
      occurredAt: new Date("2026-10-20T10:00:00Z"),
    });
    const w3Under = await insertUsage(seeded.clinicId, {
      meter: "voice_minutes",
      overAllowance: 0,
      windowStart: W3,
      occurredAt: new Date("2026-10-03T10:00:00Z"),
    });
    await inTenant(seeded.clinicId, (c) =>
      c.query(
        `insert into overage_invoices (clinic_id, window_start, window_end, voice_units,
           voice_rate_cents, chat_rate_cents, amount_cents, status, invoiced_at)
         values ($1, $2, $3, 50, 8000, 3000, 8000, 'invoiced', $3)`,
        [seeded.clinicId, W1, W2],
      ),
    );
    install(
      createStripeWorld({
        customerId: seeded.customerId,
        subscriptionId: seeded.subscriptionId,
        items: [{ lookupKey: "healdesk_web-voice_year_860400", quantity: 1 }],
        periodStart: s(A_START),
        periodEnd: s(new Date("2027-08-01T00:00:00Z")),
        customerDefaultPm: "pm_customer",
        nowSeconds: s(A_NOW),
      }),
    );

    const result = await changePlan(
      {
        clinicId: seeded.clinicId,
        planId: "web-voice",
        interval: "month",
        requestId: "req-leave-annual",
        actorLabel: "owner@clinic.test",
      },
      { now: A_NOW },
    );
    expect(result).toMatchObject({ status: "changed" });
    const [update] = world.fake.callsTo("subscriptions.update");
    expect(update!.args[1]).toMatchObject({
      items: [
        { price: "price_healdesk_web-voice_month_89700", quantity: 1 },
        { price: "price_healdesk_meter_chat_conversations_block100_3000" },
        { price: "price_healdesk_meter_voice_minutes_block100_8000" },
      ],
      proration_behavior: "always_invoice",
    });

    // The window is the new monthly period Stripe re-anchored at the switch,
    // with the counters from zero.
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      billingInterval: "month",
      planCode: "web-voice",
      currentPeriodStart: A_NOW,
      currentPeriodEnd: MONTH_AFTER,
      usedVoiceMinutes: "0.00",
      usedChatConversations: 0,
    });

    // The annual months not invoiced yet are claimed as they stand, at the
    // bought package's block prices; the one in progress ends at the switch.
    expect(await ledgerOf(seeded.clinicId)).toEqual([
      expect.objectContaining({ window_start: W1, status: "invoiced" }),
      expect.objectContaining({
        window_start: W2,
        window_end: W3,
        status: "pending",
        voice_units: 80,
        chat_units: 0,
        voice_rate_cents: 8_000,
        amount_cents: 8_000,
      }),
      expect.objectContaining({
        window_start: W3,
        window_end: A_NOW,
        status: "pending",
        voice_units: 0,
        chat_units: 30,
        chat_rate_cents: 3_000,
        amount_cents: 3_000,
      }),
    ]);
    // Every row over the allowance from before the switch is handed over,
    // the invoiced month's too; a row under the allowance is left alone.
    const rows = await usageRowsOf(seeded.clinicId);
    for (const id of [w1Row, w2Row, w3Row]) {
      expect(rows.get(id)).toMatchObject({
        stripe_reported_at: expect.any(Date),
        stripe_report_error: "annual_invoice",
      });
    }
    expect(rows.get(w3Under)).toMatchObject({ stripe_reported_at: null });

    // Usage on day 35 of the old month counts against the new window, from zero.
    const counted = await recordUsage({
      locationClinicId: seeded.clinicId,
      meter: "voice_minutes",
      quantity: 5,
      source: "voice_call",
      sourceRef: `v1:${"a".repeat(64)}`,
      occurredAt: new Date("2026-11-04T10:00:00Z"),
      actor,
    });
    expect(counted).toMatchObject({
      recorded: true,
      windowStart: A_NOW,
      usedBefore: 0,
      usedAfter: 5,
      overAllowance: 0,
    });

    // The meter reporter, which now reports this clinic, sends none of them.
    world.fake.on("billing.meterEvents.create", () => ({}));
    await reportUsageToMeters({ now: new Date("2026-10-21T13:00:00Z"), stripe: world.stripe });
    expect(world.fake.callsTo("billing.meterEvents.create")).toHaveLength(0);

    // The annual job invoices the claimed months although the clinic is monthly now.
    expect(await invoiceAnnualOverage({ now: new Date("2026-10-22T05:00:00Z") })).toEqual({
      clinics: 1,
      invoiced: 2,
      skipped: 0,
      failed: 0,
    });
    const overage = world.state.invoices.filter((i) => i.metadata.hd_kind === "annual_overage");
    expect(overage.map((i) => [i.metadata.hd_ref, i.status, i.total]).sort()).toEqual(
      [
        [`${seeded.clinicId}:${W2.toISOString()}`, "paid", 8_000],
        [`${seeded.clinicId}:${W3.toISOString()}`, "paid", 3_000],
      ].sort(),
    );
    expect((await ledgerOf(seeded.clinicId)).map((l) => l.status)).toEqual([
      "invoiced",
      "invoiced",
      "invoiced",
    ]);
    const invoiced = (await noticesOf(seeded.clinicId)).filter(
      (n) => n.kind === "overage_invoiced",
    );
    expect(invoiced.map((n) => n.dedupe_key)).toEqual([W2.toISOString(), W3.toISOString()]);
    // The month in progress is billed up to the switch, as it was claimed.
    expect(invoiced[1]!.payload).toMatchObject({
      windowStart: W3.toISOString(),
      windowEnd: A_NOW.toISOString(),
      chatConversationsCount: 30,
      chatBlocksCount: 1,
      amountCents: 3_000,
    });
  });

  test("monthly to annual mid-period: the window re-opens as the first month of the new year, and nothing is handed over", async () => {
    const seeded = await seedBilling("iv-join-annual", {
      bought: "web-voice",
      inService: ["web", "voice"],
    });
    startedWorld(seeded, { bought: "web-voice", billed: "web-voice" });
    await inTenant(seeded.clinicId, (c) =>
      c.query(
        `update entitlements set used_voice_minutes = 300, used_chat_conversations = 200 where clinic_id = $1`,
        [seeded.clinicId],
      ),
    );
    const monthlyRow = await insertUsage(seeded.clinicId, {
      meter: "voice_minutes",
      overAllowance: 4,
      windowStart: STARTED,
      occurredAt: new Date("2026-10-15T10:00:00Z"),
    });

    expect(
      await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "web-voice",
          interval: "year",
          requestId: "req-join-annual",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      ),
    ).toMatchObject({ status: "changed" });
    expect(await rowOf(seeded.clinicId)).toMatchObject({
      billingInterval: "year",
      currentPeriodStart: NOW,
      currentPeriodEnd: MONTH_AFTER,
      usedVoiceMinutes: "0.00",
      usedChatConversations: 0,
      meteredPriceKeys: [],
    });
    expect(await ledgerOf(seeded.clinicId)).toEqual([]);
    expect((await usageRowsOf(seeded.clinicId)).get(monthlyRow)).toMatchObject({
      stripe_reported_at: null,
      stripe_report_error: null,
    });
  });
});
