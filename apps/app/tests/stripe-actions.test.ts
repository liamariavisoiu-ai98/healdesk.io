import { channelList, getPlan, type Channel } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getEntitlements, claimStripeMutationLease } from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { startPlan } from "@/lib/billing/requests";
import {
  __clearPortalConfigurationForTests,
  changePlan,
  commitRefund,
  createPortalSession,
  previewRefund,
  setAutoRenew,
} from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeWorld, everyParam, type StripeWorld } from "./setup/stripe-world";

/**
 * The billing actions (BD10, BD12, BD14, BD15; R5, R7, R13, R13a, R15)
 * against a stateful Stripe fake that applies what it is asked, so a retry
 * sees what the first attempt left there. Every assertion that matters is on
 * the parameters and idempotency keys Stripe received.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "stripe-actions-test" } as const;
const NOW = new Date("2026-10-10T12:00:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const PERIOD_END = new Date("2026-11-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

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
      `select kind, dedupe_key, payload from billing_notices where clinic_id = $1 order by created_at, kind`,
      [clinicId],
    );
    return rows;
  });
}

async function channelRowsOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ channel: string }>(
      `select channel from clinic_channels where clinic_id = $1 order by channel`,
      [clinicId],
    );
    return rows.map((r) => r.channel);
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

type Seeded = {
  clinicId: string;
  organizationId: string;
  customerId: string;
  subscriptionId: string;
};

/**
 * A billing clinic bought as `bought`, billed as `billed` and, unless
 * `started: false`, started on STARTED; its bought channels have rows, and
 * those in `inService` have answered.
 */
async function seedBilling(
  label: string,
  options: {
    bought: string;
    billed?: string;
    interval?: "month" | "year";
    locations?: number;
    inService?: Channel[];
    started?: boolean;
    firstPlanInvoiceId?: string;
    setupDeadlineAt?: Date;
  },
): Promise<Seeded> {
  const clinic = await seedClinic(label);
  const bought = getPlan(options.bought)!;
  const started = options.started !== false;
  const ids = await seedEntitled(clinic.clinicId, {
    planId: options.billed ?? options.bought,
    boughtPlanId: options.bought,
    interval: options.interval ?? "month",
    ...(options.locations ? { locations: options.locations } : {}),
    ...(started ? { planStartedAt: STARTED, planStartAppliedAt: STARTED } : {}),
    ...(options.firstPlanInvoiceId ? { firstPlanInvoiceId: options.firstPlanInvoiceId } : {}),
    ...(options.setupDeadlineAt ? { setupDeadlineAt: options.setupDeadlineAt } : {}),
    channelRows: channelList(bought).map((channel) => ({
      channel,
      readyAt: STARTED,
      liveAt: options.inService?.includes(channel) ? STARTED : null,
      firstAnswerAt: options.inService?.includes(channel) ? STARTED : null,
    })),
  });
  return {
    clinicId: clinic.clinicId,
    organizationId: clinic.organizationId,
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
  };
}

/** A started subscription: the billed package at quantity `locations`, and the bought package's metered items. */
function startedWorld(
  seeded: Seeded,
  options: { bought: string; billed: string; interval?: "month" | "year"; locations?: number },
): StripeWorld {
  const interval = options.interval ?? "month";
  const billed = getPlan(options.billed)!;
  const priceKey = `healdesk_${billed.id}_${interval}_${(interval === "year" ? billed.annualMonthlyUsd * 12 : billed.monthlyUsd) * 100}`;
  return install(
    createStripeWorld({
      customerId: seeded.customerId,
      subscriptionId: seeded.subscriptionId,
      items: [
        { lookupKey: priceKey, quantity: options.locations ?? 1 },
        ...(expectedMeteredKeys(options.bought, interval) ?? []).map((lookupKey) => ({
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

function unstartedWorld(seeded: Seeded): StripeWorld {
  return install(
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
}

const itemId = (lookupKey: string) =>
  (world.state.subscription.items.data.find(
    (i) => (i.price as { lookup_key: string }).lookup_key === lookupKey,
  )?.id ?? null) as string | null;

describeDb("billing actions", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    notifyOps.mockClear();
    __clearPriceCacheForTests();
    __clearPortalConfigurationForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // changePlan
  // ---------------------------------------------------------------------------

  describe("changePlan after the start", () => {
    test("a new billed price or interval is ONE update: package at quantity = locations, metered swap, the setup difference, the marker", async () => {
      const seeded = await seedBilling("cp-interval", {
        bought: "chat-web",
        locations: 2,
        inService: ["web"],
      });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web", locations: 2 });
      const packageItem = itemId("healdesk_chat-web_month_39700")!;
      const meteredItem = itemId("healdesk_meter_chat_conversations_block100_4000")!;

      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "web-voice",
          interval: "year",
          requestId: "req-interval-1",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );

      expect(result).toEqual({
        status: "changed",
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
        droppedChannels: [],
      });
      const updates = world.fake.callsTo("subscriptions.update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.args[0]).toBe(seeded.subscriptionId);
      expect(updates[0]!.args[1]).toEqual({
        items: [
          // The voice channel is bought but not in service: billing stays on
          // the web package, now at the annual price, for both locations.
          { id: packageItem, price: "price_healdesk_chat-web_year_380400", quantity: 2 },
          // Annual plans carry no metered items: overage is invoiced monthly.
          { id: meteredItem, deleted: true },
        ],
        add_invoice_items: [
          {
            price_data: { currency: "usd", product: "prod_web-voice", unit_amount: 50_000 },
            quantity: 2,
          },
        ],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        off_session: true,
        metadata: { hd_plan_change: "req-interval-1" },
        expand: ["items.data.price", "latest_invoice"],
      });
      expect(updates[0]!.args[2]).toMatchObject({
        idempotencyKey: `hd-plan:${seeded.clinicId}:req-interval-1`,
        timeout: 20_000,
        maxNetworkRetries: 1,
      });

      const row = await rowOf(seeded.clinicId);
      expect(row).toMatchObject({
        boughtPlanId: "web-voice",
        planCode: "chat-web",
        billingInterval: "year",
        meteredPriceKeys: [],
        channelsEnabled: { web: true, meta: false, voice: true },
        stripeMutationLeaseOwner: null,
        stripeMutationLeaseUntil: null,
      });
      expect(await channelRowsOf(seeded.clinicId)).toEqual(["voice", "web"]);

      const notices = await noticesOf(seeded.clinicId);
      expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
        ["plan_changed", "plan:req-interval-1"],
      ]);
      expect(notices[0]!.payload).toEqual({
        planName: "Web + Voice",
        interval: "year",
        locations: 2,
        setupFeeDeltaCents: 100_000,
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
        hasDroppedChannels: false,
        isBeforeStart: false,
        billedPlanId: "chat-web",
        isProrated: true,
      });
      assertPayloadAllowed(notices[0]!.payload, "plan_changed");
      expect(await notesOf(seeded.clinicId)).toContainEqual({
        reason: "plan_change",
        actor: "client",
      });
    });

    test("a downgrade drops a channel in service from the price, and the email carries the forwarding facts", async () => {
      const seeded = await seedBilling("cp-downgrade", {
        bought: "complete",
        billed: "web-voice",
        inService: ["web", "voice"],
      });
      startedWorld(seeded, { bought: "complete", billed: "web-voice" });
      const packageItem = itemId("healdesk_web-voice_month_89700")!;
      const voiceItem = itemId("healdesk_meter_voice_minutes_block100_8000")!;
      const chatItem = itemId("healdesk_meter_chat_conversations_block100_3000")!;

      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "chat-web",
          interval: "month",
          requestId: "req-down-1",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );

      expect(result).toMatchObject({ status: "changed", droppedChannels: ["voice"] });
      const [update] = world.fake.callsTo("subscriptions.update");
      expect(update!.args[1]).toMatchObject({
        items: [
          { id: packageItem, price: "price_healdesk_chat-web_month_39700", quantity: 1 },
          { id: chatItem, deleted: true },
          { id: voiceItem, deleted: true },
          { price: "price_healdesk_meter_chat_conversations_block100_4000" },
        ],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
      });
      // A downgrade never refunds a setup fee, and charges none.
      expect(update!.args[1]).not.toHaveProperty("add_invoice_items");

      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "chat-web",
        planCode: "chat-web",
        meteredPriceKeys: ["healdesk_meter_chat_conversations_block100_4000"],
        channelsEnabled: { web: true, meta: false, voice: false },
      });
      const [notice] = await noticesOf(seeded.clinicId);
      expect(notice!.payload).toMatchObject({
        hasDroppedChannels: true,
        setupFeeDeltaCents: 0,
        billedPlanId: "chat-web",
        isProrated: true,
        carrier: null,
        phoneSystem: expect.any(String),
        routing: "overflow_after_hours",
      });
      assertPayloadAllowed(notice!.payload, "plan_changed");
    });

    test("blocker 0: when the billed price stays, the difference goes on a draft-first one-off invoice, then the metered swap and the marker", async () => {
      const seeded = await seedBilling("cp-blocker0", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      const meteredItem = itemId("healdesk_meter_chat_conversations_block100_4000")!;

      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "web-voice",
          interval: "month",
          requestId: "req-b0-1",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "changed", droppedChannels: [] });

      const prefix = `hd-plan:${seeded.clinicId}:req-b0-1`;
      const [create] = world.fake.callsTo("invoices.create");
      expect(create!.args[0]).toEqual({
        customer: seeded.customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        default_payment_method: "pm_customer",
        description: "Setup fee difference",
        metadata: { hd_kind: "plan_change_setup", hd_ref: "req-b0-1" },
      });
      expect(create!.args[1]).toMatchObject({ idempotencyKey: `${prefix}:invoice` });
      const draftId = world.state.invoices.find((i) => i.metadata.hd_ref === "req-b0-1")!.id;
      const [item] = world.fake.callsTo("invoiceItems.create");
      expect(item!.args[0]).toEqual({
        customer: seeded.customerId,
        invoice: draftId,
        price_data: { currency: "usd", product: "prod_web-voice", unit_amount: 50_000 },
        quantity: 1,
        description: "Setup fee difference",
        metadata: { hd_kind: "plan_change_setup", hd_ref: "req-b0-1", hd_item: "1" },
      });
      expect(item!.args[1]).toMatchObject({ idempotencyKey: `${prefix}:item:1` });
      expect(world.fake.callsTo("invoices.finalizeInvoice")[0]!.args.slice(0, 2)).toEqual([
        draftId,
        { auto_advance: false },
      ]);
      const [pay] = world.fake.callsTo("invoices.pay");
      expect(pay!.args.slice(0, 2)).toEqual([draftId, { off_session: true }]);
      expect(pay!.args[2]).toMatchObject({ idempotencyKey: `${prefix}:pay` });

      const updates = world.fake.callsTo("subscriptions.update");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.args[1]).toEqual({
        items: [
          { id: meteredItem, deleted: true },
          { price: "price_healdesk_meter_chat_conversations_block100_3000" },
          { price: "price_healdesk_meter_voice_minutes_block100_8000" },
        ],
        proration_behavior: "none",
        off_session: true,
        metadata: { hd_plan_change: "req-b0-1" },
        expand: ["items.data.price"],
      });
      expect(updates[0]!.args[2]).toMatchObject({ idempotencyKey: `${prefix}:marker` });
      // Never the recipe that sweeps pending items onto whatever invoice comes next.
      expect(everyParam(world.fake)).not.toContain('"pending_invoice_items_behavior":"include"');

      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "web-voice",
        planCode: "chat-web",
        meteredPriceKeys: [
          "healdesk_meter_chat_conversations_block100_3000",
          "healdesk_meter_voice_minutes_block100_8000",
        ],
      });
      const [notice] = await noticesOf(seeded.clinicId);
      expect(notice!.payload).toMatchObject({
        setupFeeDeltaCents: 50_000,
        hostedInvoiceUrl: `https://invoice.stripe.com/i/${draftId}`,
        isProrated: false,
      });
    });

    test("a retry after a lost response is recognised by the marker and charges nothing again, and the lease keeps other requests out meanwhile", async () => {
      const seeded = await seedBilling("cp-lost", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      world.state.loseNextUpdateResponse = true;
      const input = {
        clinicId: seeded.clinicId,
        planId: "web-voice",
        interval: "month" as const,
        requestId: "req-lost-1",
        actorLabel: "owner@clinic.test",
      };

      const first = await changePlan(input, { now: NOW });
      expect(first).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/never charged twice/),
      });
      expect((await rowOf(seeded.clinicId)).stripeMutationLeaseOwner).toBe(
        "change_plan:req-lost-1",
      );
      expect((await rowOf(seeded.clinicId)).boughtPlanId).toBe("chat-web");

      // A fresh request cannot act while we can't tell what the first did.
      expect(await changePlan({ ...input, requestId: "req-lost-2" }, { now: NOW })).toMatchObject({
        status: "busy",
      });

      const retry = await changePlan(input, { now: NOW });
      expect(retry).toMatchObject({ status: "changed" });
      expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
      expect(world.fake.callsTo("invoices.pay")).toHaveLength(1);
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "web-voice",
        stripeMutationLeaseOwner: null,
      });
      expect((await noticesOf(seeded.clinicId)).map((n) => n.dedupe_key)).toEqual([
        "plan:req-lost-1",
      ]);
      // The first attempt took the setup-only branch: nothing was prorated.
      expect((await noticesOf(seeded.clinicId))[0]!.payload).toMatchObject({ isProrated: false });
    });

    test("a retry after a lost response to a prorating change still says it was prorated", async () => {
      const seeded = await seedBilling("cp-lost-year", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      world.state.loseNextUpdateResponse = true;
      const input = {
        clinicId: seeded.clinicId,
        planId: "web-voice",
        interval: "year" as const,
        requestId: "req-lost-year-1",
        actorLabel: "owner@clinic.test",
      };
      expect(await changePlan(input, { now: NOW })).toMatchObject({ status: "refused" });
      expect(await changePlan(input, { now: NOW })).toMatchObject({ status: "changed" });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
      // Found by the marker, the interval Stripe bills now differs from the
      // one our row held: the earlier attempt prorated.
      const [notice] = await noticesOf(seeded.clinicId);
      expect(notice!.payload).toMatchObject({
        interval: "year",
        billedPlanId: "chat-web",
        isProrated: true,
      });
    });

    test("a retry after the marker update failed resumes the paid one-off invoice by hd_ref instead of charging again", async () => {
      const seeded = await seedBilling("cp-resume", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      world.state.failNextUpdate = true;
      const input = {
        clinicId: seeded.clinicId,
        planId: "web-voice",
        interval: "month" as const,
        requestId: "req-resume-1",
        actorLabel: "owner@clinic.test",
      };
      expect(await changePlan(input, { now: NOW })).toMatchObject({ status: "refused" });
      expect(world.state.subscription.metadata.hd_plan_change).toBeUndefined();

      expect(await changePlan(input, { now: NOW })).toMatchObject({ status: "changed" });
      expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
      expect(world.fake.callsTo("invoices.pay")).toHaveLength(1);
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(2);
      expect(world.state.subscription.metadata.hd_plan_change).toBe("req-resume-1");
    });

    test("a decline under error_if_incomplete changes nothing and frees the lease", async () => {
      const seeded = await seedBilling("cp-decline", {
        bought: "complete",
        billed: "web-voice",
        inService: ["web", "voice"],
      });
      startedWorld(seeded, { bought: "complete", billed: "web-voice" });
      world.state.declineNextUpdate = true;
      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "chat-web",
          interval: "month",
          requestId: "req-decline-1",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "payment_failed" });
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "complete",
        planCode: "web-voice",
        stripeMutationLeaseOwner: null,
      });
      expect(await noticesOf(seeded.clinicId)).toEqual([]);
    });
  });

  describe("changePlan before the start", () => {
    test("charges a setup difference on its own invoice and changes nothing in Stripe's subscription", async () => {
      const seeded = await seedBilling("cp-pre", { bought: "chat-web", started: false });
      unstartedWorld(seeded);
      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "web-voice",
          interval: "year",
          requestId: "req-pre-1",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "changed", droppedChannels: [] });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
      // The customer has no default card yet: the subscription's (from
      // Checkout) is the one charged (R16).
      expect(world.fake.callsTo("invoices.create")[0]!.args[0]).toMatchObject({
        default_payment_method: "pm_from_checkout",
        metadata: { hd_kind: "plan_change_setup", hd_ref: "req-pre-1" },
      });
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "web-voice",
        planCode: "web-voice",
        billingInterval: "year",
        channelsEnabled: { web: true, meta: false, voice: true },
      });
      expect(await channelRowsOf(seeded.clinicId)).toEqual(["voice", "web"]);
      const [notice] = await noticesOf(seeded.clinicId);
      expect(notice!.payload).toMatchObject({ isBeforeStart: true, billedPlanId: null });
      assertPayloadAllowed(notice!.payload, "plan_changed");
    });

    test("a declined difference is voided and refused, and nothing changes", async () => {
      const seeded = await seedBilling("cp-pre-decline", { bought: "chat-web", started: false });
      unstartedWorld(seeded);
      world.state.declineNextPay = true;
      const result = await changePlan(
        {
          clinicId: seeded.clinicId,
          planId: "web-voice",
          interval: "month",
          requestId: "req-pre-decline",
          actorLabel: "owner@clinic.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "payment_failed" });
      expect(world.fake.callsTo("invoices.voidInvoice")).toHaveLength(1);
      expect(world.state.invoices[0]!.status).toBe("void");
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "chat-web",
        stripeMutationLeaseOwner: null,
      });
      // The same request again finds its voided invoice and refuses the same way.
      expect(
        await changePlan(
          {
            clinicId: seeded.clinicId,
            planId: "web-voice",
            interval: "month",
            requestId: "req-pre-decline",
            actorLabel: "owner@clinic.test",
          },
          { now: NOW },
        ),
      ).toMatchObject({ status: "payment_failed" });
      expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
    });
  });

  describe("changePlan refusals", () => {
    const base = { interval: "month" as const, actorLabel: "owner@clinic.test" };

    test("a legacy row, an unchanged plan, an unknown plan and a bad request id", async () => {
      const legacy = await seedClinic("cp-legacy");
      await seedEntitled(legacy.clinicId, { planId: "chat-web", legacy: true });
      expect(
        await changePlan(
          { ...base, clinicId: legacy.clinicId, planId: "web-voice", requestId: "r1" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/before plan changes/) });

      const seeded = await seedBilling("cp-same", { bought: "chat-web", inService: ["web"] });
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "chat-web", requestId: "r2" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: "That's already your plan." });
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "enterprise", requestId: "r3" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused" });
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "web-voice", requestId: "not a token!" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused" });
    });

    test("a change that would drop every channel in service", async () => {
      const seeded = await seedBilling("cp-dropall", { bought: "web-voice", inService: ["voice"] });
      startedWorld(seeded, { bought: "web-voice", billed: "voice" });
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "chat-web", requestId: "r4" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/drop every channel/) });
      expect(world.fake.calls).toHaveLength(0);
    });

    test("an account past due beyond grace, or set to close", async () => {
      const seeded = await seedBilling("cp-standing", { bought: "chat-web", inService: ["web"] });
      await inTenant(seeded.clinicId, (c) =>
        c.query(
          `update entitlements set status = 'past_due', grace_ends_at = $2 where clinic_id = $1`,
          [seeded.clinicId, new Date("2026-10-09T00:00:00Z")],
        ),
      );
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "web-voice", requestId: "r5" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/good standing/) });

      await inTenant(seeded.clinicId, (c) =>
        c.query(
          `update entitlements set status = 'active', grace_ends_at = null, cancel_at = $2 where clinic_id = $1`,
          [seeded.clinicId, PERIOD_END],
        ),
      );
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "web-voice", requestId: "r6" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/auto-renew back on/) });
    });

    test("a trialing subscription is a fault: refused, with nothing charged or changed", async () => {
      const seeded = await seedBilling("cp-trialing", {
        bought: "complete",
        billed: "web-voice",
        inService: ["web", "voice"],
      });
      startedWorld(seeded, { bought: "complete", billed: "web-voice" });
      world.state.subscription.status = "trialing";
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "chat-web", requestId: "r-trial" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/never puts one in/) });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        boughtPlanId: "complete",
        stripeMutationLeaseOwner: null,
      });
      expect(
        await setAutoRenew(
          { clinicId: seeded.clinicId, on: false, actorLabel: "owner" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused" });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    });

    test("busy while another holder has the lease", async () => {
      const seeded = await seedBilling("cp-busy", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      await withTenant({ clinicId: seeded.clinicId, actor }, (tx) =>
        claimStripeMutationLease(tx.db, seeded.clinicId, "billing_request:x:1"),
      );
      expect(
        await changePlan(
          { ...base, clinicId: seeded.clinicId, planId: "web-voice", requestId: "r7" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "busy" });
      expect(world.fake.calls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // setAutoRenew
  // ---------------------------------------------------------------------------

  describe("setAutoRenew", () => {
    test("off sets cancel_at_period_end, stamps cancel_at at once, and tells ops a first-period refund is due", async () => {
      const seeded = await seedBilling("ar-off", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      const result = await setAutoRenew(
        { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
        { now: NOW },
      );
      expect(result).toEqual({ status: "ok", closesOn: "2026-11-07" });
      const [update] = world.fake.callsTo("subscriptions.update");
      // The last day of the refund window rides on the subscription, for the
      // webhook's cancel_scheduled email (R15).
      expect(update!.args[1]).toEqual({
        cancel_at_period_end: true,
        metadata: { hd_refund_eligible_until: "2026-10-21" },
        expand: ["items.data.price"],
      });
      expect(world.state.subscription.metadata).toEqual({ hd_refund_eligible_until: "2026-10-21" });
      expect(await rowOf(seeded.clinicId)).toMatchObject({
        cancelAt: PERIOD_END,
        stripeMutationLeaseOwner: null,
      });
      expect(await notesOf(seeded.clinicId)).toContainEqual({
        reason: "auto_renew_off",
        actor: "client",
      });
      expect(notifyOps).toHaveBeenCalledWith("first_period_refund_due", {
        clinicId: seeded.clinicId,
      });

      // On again: the flag cleared and the stamp gone, and no refund alert.
      notifyOps.mockClear();
      expect(
        await setAutoRenew(
          { clinicId: seeded.clinicId, on: true, actorLabel: "owner@clinic.test" },
          { now: NOW },
        ),
      ).toEqual({ status: "ok", closesOn: null });
      expect(world.fake.callsTo("subscriptions.update")[1]!.args[1]).toEqual({
        cancel_at_period_end: false,
        metadata: { hd_refund_eligible_until: "" },
        expand: ["items.data.price"],
      });
      expect(world.state.subscription.metadata).toEqual({});
      expect((await rowOf(seeded.clinicId)).cancelAt).toBeNull();
      expect(notifyOps).not.toHaveBeenCalled();
    });

    test("no refund alert while the first plan invoice is unpaid: nothing was paid to refund", async () => {
      const seeded = await seedBilling("ar-unpaid", {
        bought: "chat-web",
        inService: ["web"],
        started: false,
      });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      // The plan-start update went through; its first charge did not.
      await inTenant(seeded.clinicId, (c) =>
        c.query(`update entitlements set plan_start_applied_at = $2 where clinic_id = $1`, [
          seeded.clinicId,
          STARTED,
        ]),
      );
      expect(
        await setAutoRenew(
          { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "ok" });
      expect(notifyOps).not.toHaveBeenCalledWith("first_period_refund_due", expect.anything());
    });

    test("no refund alert once the 14 days have passed", async () => {
      const seeded = await seedBilling("ar-late", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      await setAutoRenew(
        { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
        { now: new Date("2026-10-25T00:00:00Z") },
      );
      expect(notifyOps).not.toHaveBeenCalled();
      expect(world.fake.callsTo("subscriptions.update")[0]!.args[1]).not.toHaveProperty("metadata");
    });

    test("busy while the plan-start worker holds the lease, and Stripe is never called", async () => {
      const seeded = await seedBilling("ar-busy", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      await withTenant({ clinicId: seeded.clinicId, actor }, (tx) =>
        claimStripeMutationLease(tx.db, seeded.clinicId, "billing_request:plan:1"),
      );
      expect(
        await setAutoRenew(
          { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "busy" });
      expect(world.fake.calls).toHaveLength(0);
      expect((await rowOf(seeded.clinicId)).cancelAt).toBeNull();
    });

    test("before the start, off skips the pending plan start and closes at the earlier of cancel_at and the setup deadline; on re-arms it", async () => {
      const deadline = new Date("2026-10-20T23:59:59Z");
      const seeded = await seedBilling("ar-pre", {
        bought: "chat-web",
        started: false,
        inService: ["web"],
        setupDeadlineAt: deadline,
      });
      unstartedWorld(seeded);
      await withTenant({ clinicId: seeded.clinicId, actor }, (tx) =>
        startPlan(tx, seeded.clinicId),
      );

      const off = await setAutoRenew(
        { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
        { now: NOW },
      );
      expect(off).toEqual({ status: "ok", closesOn: "2026-10-20" });
      const request = async () =>
        inTenant(seeded.clinicId, async (c) => {
          const { rows } = await c.query<{
            outcome: string | null;
            outcome_reason: string | null;
            done_at: Date | null;
          }>(
            `select outcome, outcome_reason, done_at from billing_requests where clinic_id = $1 and kind = 'plan_start'`,
            [seeded.clinicId],
          );
          return rows[0]!;
        });
      expect(await request()).toMatchObject({
        outcome: "skipped",
        outcome_reason: "cancel_pending",
      });
      expect(notifyOps).not.toHaveBeenCalled();

      await setAutoRenew(
        { clinicId: seeded.clinicId, on: true, actorLabel: "owner@clinic.test" },
        { now: NOW },
      );
      expect(await request()).toMatchObject({ outcome: null, outcome_reason: null, done_at: null });
    });

    test("when Stripe fails, auto-renew is unchanged and a plan start skipped on the way in is re-armed", async () => {
      const seeded = await seedBilling("ar-fail", {
        bought: "chat-web",
        started: false,
        inService: ["web"],
      });
      unstartedWorld(seeded);
      await withTenant({ clinicId: seeded.clinicId, actor }, (tx) =>
        startPlan(tx, seeded.clinicId),
      );
      world.state.failNextUpdate = true;
      expect(
        await setAutoRenew(
          { clinicId: seeded.clinicId, on: false, actorLabel: "owner@clinic.test" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused" });
      const row = await rowOf(seeded.clinicId);
      expect(row).toMatchObject({ cancelAt: null, stripeMutationLeaseOwner: null });
      const pending = await inTenant(
        seeded.clinicId,
        async (c) =>
          (
            await c.query(`select done_at from billing_requests where clinic_id = $1`, [
              seeded.clinicId,
            ])
          ).rows,
      );
      expect(pending).toEqual([{ done_at: null }]);
    });
  });

  // ---------------------------------------------------------------------------
  // createPortalSession
  // ---------------------------------------------------------------------------

  describe("createPortalSession", () => {
    const savedOrigin = process.env.BETTER_AUTH_URL;
    beforeEach(() => {
      process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    });
    afterEach(() => {
      if (savedOrigin === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = savedOrigin;
    });

    test("uses healdesk's own configuration, found by metadata.healdesk = customer-portal, and caches it", async () => {
      const seeded = await seedBilling("portal", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      world.state.portalConfigurations.push(
        { id: "bpc_scalabid", metadata: {} },
        { id: "bpc_other", metadata: { healdesk: "something-else" } },
        { id: "bpc_healdesk", metadata: { healdesk: "customer-portal" } },
      );
      const returnUrl = "https://app.healdesk.test/c/portal/billing";
      const result = await createPortalSession({
        clinicId: seeded.clinicId,
        returnUrl,
        flow: "payment_method_update",
      });
      expect(result).toEqual({ url: "https://billing.stripe.com/p/session/test_w" });
      const [create] = world.fake.callsTo("billingPortal.sessions.create");
      expect(create!.args[0]).toEqual({
        customer: seeded.customerId,
        configuration: "bpc_healdesk",
        return_url: returnUrl,
        flow_data: {
          type: "payment_method_update",
          after_completion: { type: "redirect", redirect: { return_url: returnUrl } },
        },
      });

      await createPortalSession({ clinicId: seeded.clinicId, returnUrl });
      expect(world.fake.callsTo("billingPortal.configurations.list")).toHaveLength(1);
      expect(world.fake.callsTo("billingPortal.sessions.create")[1]!.args[0]).not.toHaveProperty(
        "flow_data",
      );
    });

    test("is unavailable without our configuration, off our origin, or with no customer", async () => {
      const seeded = await seedBilling("portal-none", { bought: "chat-web", inService: ["web"] });
      startedWorld(seeded, { bought: "chat-web", billed: "chat-web" });
      world.state.portalConfigurations.push({ id: "bpc_scalabid", metadata: {} });
      expect(
        await createPortalSession({
          clinicId: seeded.clinicId,
          returnUrl: "https://app.healdesk.test/c/x/billing",
        }),
      ).toEqual({ status: "unavailable" });
      expect(
        await createPortalSession({
          clinicId: seeded.clinicId,
          returnUrl: "https://evil.example/x",
        }),
      ).toEqual({ status: "unavailable" });

      const bare = await seedClinic("portal-bare");
      await seedEntitled(bare.clinicId, { stripe: false });
      expect(
        await createPortalSession({
          clinicId: bare.clinicId,
          returnUrl: "https://app.healdesk.test/x",
        }),
      ).toEqual({ status: "unavailable" });
    });
  });

  // ---------------------------------------------------------------------------
  // previewRefund and commitRefund
  // ---------------------------------------------------------------------------

  describe("refunds", () => {
    /** A started monthly clinic with its first plan invoice (and the setup invoice before it) in Stripe. */
    async function seedRefundable(label: string, interval: "month" | "year" = "month") {
      const seeded = await seedBilling(label, {
        bought: "web-voice",
        interval,
        inService: ["web", "voice"],
        firstPlanInvoiceId: undefined,
      });
      startedWorld(seeded, { bought: "web-voice", billed: "web-voice", interval });
      const yearEnd = new Date("2027-10-07T00:00:00Z");
      const end = interval === "year" ? yearEnd : PERIOD_END;
      // The checkout invoice: the setup fee and the $0 placeholder. Never refunded.
      world.addPaidSubscriptionInvoice({
        created: s(new Date("2026-10-01T00:00:00Z")),
        billingReason: "subscription_create",
        lines: [
          {
            amount: 99_700,
            periodStart: s(new Date("2026-10-01T00:00:00Z")),
            periodEnd: s(new Date("2026-10-01T00:00:00Z")),
            oneOff: true,
          },
          {
            lookupKey: "healdesk_plan_start_placeholder_month",
            amount: 0,
            periodStart: s(new Date("2026-10-01T00:00:00Z")),
            periodEnd: s(new Date("2026-11-01T00:00:00Z")),
          },
        ],
      });
      const packageKey =
        interval === "year" ? "healdesk_web-voice_year_860400" : "healdesk_web-voice_month_89700";
      const packageAmount = interval === "year" ? 860_400 : 89_700;
      const first = world.addPaidSubscriptionInvoice({
        created: s(STARTED),
        lines: [
          {
            lookupKey: packageKey,
            amount: packageAmount,
            periodStart: s(STARTED),
            periodEnd: s(end),
          },
          // A metered line in arrears: overage, never refunded here.
          {
            lookupKey: "healdesk_meter_voice_minutes_block100_8000",
            amount: 0,
            periodStart: s(STARTED),
            periodEnd: s(end),
          },
        ],
      });
      await inTenant(seeded.clinicId, (c) =>
        c.query(`update entitlements set first_plan_invoice_id = $2 where clinic_id = $1`, [
          seeded.clinicId,
          first.id,
        ]),
      );
      return { seeded, first, end };
    }

    test("the first-period refund is every subscription-fee line in the first period, never setup or overage", async () => {
      const { seeded, end } = await seedRefundable("refund-preview", "year");
      // A step-up made inside the first year, invoiced at once on an annual plan.
      world.addPaidSubscriptionInvoice({
        created: s(new Date("2026-10-09T00:00:00Z")),
        lines: [
          {
            lookupKey: "healdesk_web-voice_year_860400",
            amount: -850_000,
            periodStart: s(new Date("2026-10-09T00:00:00Z")),
            periodEnd: s(end),
            proration: true,
          },
          {
            lookupKey: "healdesk_complete_year_1148400",
            amount: 1_134_000,
            periodStart: s(new Date("2026-10-09T00:00:00Z")),
            periodEnd: s(end),
            proration: true,
          },
        ],
      });
      const preview = await previewRefund(
        { clinicId: seeded.clinicId, kind: "first_period_cancel" },
        { now: NOW },
      );
      expect(preview).toEqual({
        status: "ok",
        kind: "first_period_cancel",
        amountCents: 860_400 + 284_000,
        cancelsPlan: true,
        planStartedOn: "2026-10-07",
        windowEndsOn: "2026-10-21",
      });
    });

    test("committing refunds each invoice to its card, stamps the account, records cancel_now and enqueues refund_issued; the two refunds never stack", async () => {
      const { seeded, first } = await seedRefundable("refund-commit");
      const preview = await previewRefund(
        { clinicId: seeded.clinicId, kind: "first_period_cancel" },
        { now: NOW },
      );
      expect(preview).toMatchObject({ status: "ok", amountCents: 89_700 });

      const result = await commitRefund(
        {
          clinicId: seeded.clinicId,
          kind: "first_period_cancel",
          confirmAmountCents: 89_700,
          reason: "Asked to cancel in the first week",
          actorLabel: "ops@healdesk.test",
        },
        { now: NOW },
      );
      expect(result).toEqual({
        status: "refunded",
        amountCents: 89_700,
        refundedAt: NOW.toISOString(),
        isCancelRequested: true,
      });
      const [create] = world.fake.callsTo("refunds.create");
      expect(create!.args[0]).toEqual({
        payment_intent: `pi_${first.id}`,
        amount: 89_700,
        reason: "requested_by_customer",
        metadata: { hd_kind: "first_period_cancel", hd_invoice: first.id },
      });
      expect(create!.args[1]).toMatchObject({
        idempotencyKey: `hd-refund:first_period_cancel:${seeded.clinicId}:${first.id}`,
      });

      const row = await rowOf(seeded.clinicId);
      expect(row.firstPeriodRefundedAt).toEqual(NOW);
      expect(row.stripeMutationLeaseOwner).toBeNull();
      const requests = await inTenant(
        seeded.clinicId,
        async (c) =>
          (
            await c.query(`select kind, reason from billing_requests where clinic_id = $1`, [
              seeded.clinicId,
            ])
          ).rows,
      );
      expect(requests).toEqual([{ kind: "cancel_now", reason: "ops" }]);
      const notices = await noticesOf(seeded.clinicId);
      const refundId = world.state.refunds[0]!.id as string;
      expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
        ["refund_issued", `refund:${refundId}`],
      ]);
      expect(notices[0]!.payload).toEqual({
        amountCents: 89_700,
        kind: "first_period_cancel",
        refundedAt: NOW.toISOString(),
      });
      assertPayloadAllowed(notices[0]!.payload, "refund_issued");
      expect(await notesOf(seeded.clinicId)).toContainEqual({
        reason: "refund_first_period_cancel",
        actor: "support",
      });

      for (const kind of ["guarantee", "first_period_cancel"] as const) {
        expect(
          await previewRefund({ clinicId: seeded.clinicId, kind }, { now: NOW }),
        ).toMatchObject({
          status: "refused",
          message: expect.stringMatching(/don't stack/),
        });
      }
    });

    test("a first-period refund spread across two invoices is one email, for the whole amount", async () => {
      const { seeded, end } = await seedRefundable("refund-two-parts", "year");
      // A step-up inside the first year, invoiced at once on an annual plan:
      // a second paid invoice, refunded as its own part.
      world.addPaidSubscriptionInvoice({
        created: s(new Date("2026-10-09T00:00:00Z")),
        lines: [
          {
            lookupKey: "healdesk_web-voice_year_860400",
            amount: -850_000,
            periodStart: s(new Date("2026-10-09T00:00:00Z")),
            periodEnd: s(end),
            proration: true,
          },
          {
            lookupKey: "healdesk_complete_year_1148400",
            amount: 1_134_000,
            periodStart: s(new Date("2026-10-09T00:00:00Z")),
            periodEnd: s(end),
            proration: true,
          },
        ],
      });
      const result = await commitRefund(
        {
          clinicId: seeded.clinicId,
          kind: "first_period_cancel",
          confirmAmountCents: 860_400 + 284_000,
          reason: "Asked to cancel in the first week",
          actorLabel: "ops@healdesk.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "refunded", amountCents: 860_400 + 284_000 });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(2);
      const notices = await noticesOf(seeded.clinicId);
      expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
        ["refund_issued", `refund:${world.state.refunds[0]!.id as string}`],
      ]);
      expect(notices[0]!.payload).toEqual({
        amountCents: 860_400 + 284_000,
        kind: "first_period_cancel",
        refundedAt: NOW.toISOString(),
      });
    });

    test("an amount other than the preview's is refused, and nothing is refunded", async () => {
      const { seeded } = await seedRefundable("refund-mismatch");
      expect(
        await commitRefund(
          {
            clinicId: seeded.clinicId,
            kind: "first_period_cancel",
            confirmAmountCents: 50_000,
            reason: "Asked to cancel",
            actorLabel: "ops@healdesk.test",
          },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/Preview it again/) });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(0);
      expect((await rowOf(seeded.clinicId)).firstPeriodRefundedAt).toBeNull();
    });

    test("a refund of this kind already on the payment intent is reused, never made twice", async () => {
      const { seeded, first } = await seedRefundable("refund-reuse");
      world.state.refunds.push({
        id: "re_earlier",
        payment_intent: `pi_${first.id}`,
        amount: 89_700,
        status: "succeeded",
        metadata: { hd_kind: "first_period_cancel" },
      });
      const result = await commitRefund(
        {
          clinicId: seeded.clinicId,
          kind: "first_period_cancel",
          confirmAmountCents: 89_700,
          reason: "Retried after a timeout",
          actorLabel: "ops@healdesk.test",
        },
        { now: NOW },
      );
      expect(result).toMatchObject({ status: "refunded" });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(0);
      expect((await noticesOf(seeded.clinicId)).map((n) => n.dedupe_key)).toEqual([
        "refund:re_earlier",
      ]);
    });

    test("the guarantee is one month's fee, a twelfth of the first annual invoice, and keeps the plan", async () => {
      const { seeded } = await seedRefundable("refund-guarantee", "year");
      const preview = await previewRefund(
        { clinicId: seeded.clinicId, kind: "guarantee" },
        { now: NOW },
      );
      expect(preview).toEqual({
        status: "ok",
        kind: "guarantee",
        amountCents: 71_700,
        cancelsPlan: false,
        planStartedOn: "2026-10-07",
        windowEndsOn: "2026-11-07",
      });
      const result = await commitRefund(
        {
          clinicId: seeded.clinicId,
          kind: "guarantee",
          confirmAmountCents: 71_700,
          reason: "Guarantee honoured",
          actorLabel: "ops@healdesk.test",
        },
        { now: new Date("2026-12-01T00:00:00Z") },
      );
      expect(result).toMatchObject({
        status: "refunded",
        amountCents: 71_700,
        isCancelRequested: false,
      });
      const requests = await inTenant(
        seeded.clinicId,
        async (c) =>
          (
            await c.query(`select kind from billing_requests where clinic_id = $1`, [
              seeded.clinicId,
            ])
          ).rows,
      );
      expect(requests).toEqual([]);
    });

    test("refused outside the 14 days, before the first plan invoice is paid, and with a reason that carries a number", async () => {
      const { seeded } = await seedRefundable("refund-late");
      expect(
        await previewRefund(
          { clinicId: seeded.clinicId, kind: "first_period_cancel" },
          { now: new Date("2026-10-22T00:00:00Z") },
        ),
      ).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/closed on 2026-10-21/),
      });

      const unpaid = await seedBilling("refund-unpaid", { bought: "chat-web", started: false });
      expect(
        await previewRefund(
          { clinicId: unpaid.clinicId, kind: "first_period_cancel" },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused" });

      expect(
        await commitRefund(
          {
            clinicId: seeded.clinicId,
            kind: "guarantee",
            confirmAmountCents: 1,
            reason: "Call them back on 415 555 0100",
            actorLabel: "ops@healdesk.test",
          },
          { now: NOW },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/phone number/) });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(0);
    });
  });
});
