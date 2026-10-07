import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { recordOpenInvoice, setCancelAt } from "@/lib/billing/entitlements";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { getBillingSummary, previewChangePlan, previewNextInvoice } from "@/lib/billing/summary";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";
import { createStripeWorld } from "./setup/stripe-world";

/**
 * The Billing screen's reads (R30): the summary from the database alone,
 * across a billing group's locations, and the previews that ask Stripe what
 * an action would charge before the clinic confirms it.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "billing-summary-test" } as const;
const NOW = new Date("2026-10-10T12:00:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

async function seedLocation(billingClinicId: string, organizationId: string): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [organizationId, `sum-${randomUUID().slice(0, 6)}`, billingClinicId],
  );
  return rows[0]!.id;
}

describeDb("billing summary and previews", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    __clearPriceCacheForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("the summary reads the database alone and pools the billing group's locations", async () => {
    // Any Stripe call at all would fail loudly.
    const fake = createStripeFake();
    __setStripeForTests(fake.stripe);
    const billing = await seedClinic("summary-group");
    await seedEntitled(billing.clinicId, {
      planId: "chat-web",
      boughtPlanId: "web-voice",
      locations: 2,
      planStartedAt: STARTED,
      channelRows: [
        { channel: "web", firstAnswerAt: STARTED, liveAt: STARTED },
        { channel: "voice" },
      ],
    });
    const location = await seedLocation(billing.clinicId, billing.organizationId);
    await seedChannels(location, [
      { channel: "web" },
      { channel: "voice", liveAt: STARTED, firstAnswerAt: new Date("2026-10-08T00:00:00Z") },
    ]);
    await withTenant({ clinicId: billing.clinicId, actor }, (tx) =>
      recordOpenInvoice(tx.db, billing.clinicId, {
        invoiceId: "in_open_summary",
        url: "https://invoice.stripe.com/i/open",
        amountDueCents: 79_400,
      }),
    );

    // Asked from the location, answered for the billing clinic.
    const summary = await getBillingSummary(location, { now: NOW });
    expect(summary).toEqual({
      billingClinicId: billing.clinicId,
      status: "active",
      boughtPlanId: "web-voice",
      billedPlanId: "chat-web",
      interval: "month",
      locations: 2,
      isPlanStarted: true,
      planStartedAt: STARTED.toISOString(),
      firstPeriodEndsAt: "2026-11-07T00:00:00.000Z",
      paidThrough: "2026-11-07T00:00:00.000Z",
      setupDeadlineAt: null,
      isAutoRenewOn: true,
      closesOn: null,
      channelsInService: ["web", "voice"],
      channelsNotYetPriced: ["voice"],
      overageMode: "allow",
      usageAlertsEnabled: true,
      openInvoice: { url: "https://invoice.stripe.com/i/open", amountDueCents: 79_400 },
      graceEndsAt: null,
      usage: [
        {
          meter: "voice_minutes",
          used: 0,
          // Billed as Web Chatbot, bought with voice: the bought package's
          // minutes, pooled over both locations (BD5).
          included: 2_000,
          overUnits: 0,
          overageCents: 0,
          windowStart: STARTED.toISOString(),
          windowEnd: "2026-11-07T00:00:00.000Z",
          isWindowOpen: true,
        },
        {
          meter: "chat_conversations",
          used: 0,
          included: 2_000,
          overUnits: 0,
          overageCents: 0,
          windowStart: STARTED.toISOString(),
          windowEnd: "2026-11-07T00:00:00.000Z",
          isWindowOpen: true,
        },
      ],
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("the meters carry the overage as it will be billed: started blocks at the BOUGHT package's rate, and nothing under the hard cap", async () => {
    const clinic = await seedClinic("summary-overage");
    await seedEntitled(clinic.clinicId, {
      planId: "chat-web",
      boughtPlanId: "web-voice",
      planStartedAt: STARTED,
      channelRows: [
        { channel: "web", firstAnswerAt: STARTED, liveAt: STARTED },
        { channel: "voice" },
      ],
    });
    await inTenant(clinic.clinicId, (c) =>
      c.query(
        `update entitlements set used_voice_minutes = 1250, used_chat_conversations = 1101
          where clinic_id = $1`,
        [clinic.clinicId],
      ),
    );
    const window = {
      windowStart: STARTED.toISOString(),
      windowEnd: "2026-11-07T00:00:00.000Z",
      isWindowOpen: true,
    };
    expect((await getBillingSummary(clinic.clinicId, { now: NOW }))!.usage).toEqual([
      {
        meter: "voice_minutes",
        used: 1_250,
        included: 1_000,
        overUnits: 250,
        // Three started blocks of 100 at $80: $240, where units times the
        // $0.80 rate would show $200.
        overageCents: 24_000,
        ...window,
      },
      {
        meter: "chat_conversations",
        used: 1_101,
        included: 1_000,
        overUnits: 101,
        // Two blocks at Web + Voice's $30, the package bought, not the $40 of
        // the Web Chatbot it is billed as.
        overageCents: 6_000,
        ...window,
      },
    ]);

    // "Stop and fall back" bills no overage (R19); the units still show.
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update entitlements set overage_mode = 'hard_cap' where clinic_id = $1`, [
        clinic.clinicId,
      ]),
    );
    const capped = await getBillingSummary(clinic.clinicId, { now: NOW });
    expect(capped!.usage.map((m) => [m.meter, m.overUnits, m.overageCents])).toEqual([
      ["voice_minutes", 250, 0],
      ["chat_conversations", 101, 0],
    ]);
    // Past the window's end, before the renewal moves it (R20).
    const lapsed = await getBillingSummary(clinic.clinicId, {
      now: new Date("2026-11-08T00:00:00Z"),
    });
    expect(lapsed!.usage.map((m) => m.isWindowOpen)).toEqual([false, false]);
  });

  test("before the start nothing is billed, and an account set to close shows the earlier of cancel_at and the setup deadline", async () => {
    const clinic = await seedClinic("summary-pre");
    const deadline = new Date("2026-10-30T23:59:59Z");
    await seedEntitled(clinic.clinicId, { planId: "complete", setupDeadlineAt: deadline });
    await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      setCancelAt(tx.db, clinic.clinicId, new Date("2026-11-01T00:00:00Z")),
    );
    const summary = await getBillingSummary(clinic.clinicId);
    expect(summary).toMatchObject({
      isPlanStarted: false,
      billedPlanId: null,
      firstPeriodEndsAt: null,
      isAutoRenewOn: false,
      closesOn: deadline.toISOString(),
      channelsInService: [],
      channelsNotYetPriced: [],
    });
    expect(summary!.usage.every((meter) => meter.windowStart === null)).toBe(true);
  });

  test("a clinic with no entitlements row has no summary", async () => {
    const clinic = await seedClinic("summary-none");
    expect(await getBillingSummary(clinic.clinicId)).toBeNull();
  });

  test("the next invoice is Stripe's own preview; before the start there is none to show", async () => {
    const clinic = await seedClinic("next-invoice");
    const ids = await seedEntitled(clinic.clinicId, { planId: "chat-web", planStartedAt: STARTED });
    const fake = createStripeFake({
      "invoices.createPreview": () => ({
        amount_due: 39_700,
        next_payment_attempt: null,
        period_end: s(new Date("2026-11-07T00:00:00Z")),
        lines: {
          data: [
            {
              amount: 39_700,
              period: {
                start: s(new Date("2026-11-07T00:00:00Z")),
                end: s(new Date("2026-12-07T00:00:00Z")),
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      }),
    });
    __setStripeForTests(fake.stripe);
    expect(await previewNextInvoice(clinic.clinicId, { now: NOW })).toEqual({
      status: "ok",
      amountDueCents: 39_700,
      nextPaymentOn: "2026-11-07",
      periodStartsOn: "2026-11-07",
      periodEndsOn: "2026-12-07",
    });
    expect(fake.callsTo("invoices.createPreview")[0]!.args[0]).toEqual({
      customer: ids.stripeCustomerId,
      subscription: ids.stripeSubscriptionId,
    });

    const pre = await seedClinic("next-invoice-pre");
    await seedEntitled(pre.clinicId, { planId: "chat-web" });
    expect(await previewNextInvoice(pre.clinicId, { now: NOW })).toMatchObject({
      status: "not_available",
    });
  });

  test("a plan change preview prices the setup difference, Stripe's proration and the recurring price afterwards", async () => {
    const clinic = await seedClinic("preview-change");
    const ids = await seedEntitled(clinic.clinicId, {
      planId: "web-voice",
      boughtPlanId: "complete",
      locations: 2,
      planStartedAt: STARTED,
      channelRows: [
        { channel: "web", firstAnswerAt: STARTED },
        { channel: "meta" },
        { channel: "voice", firstAnswerAt: STARTED },
      ],
    });
    const world = createStripeWorld({
      customerId: ids.stripeCustomerId!,
      subscriptionId: ids.stripeSubscriptionId!,
      items: [
        { lookupKey: "healdesk_web-voice_month_89700", quantity: 2 },
        { lookupKey: "healdesk_meter_chat_conversations_block100_3000" },
        { lookupKey: "healdesk_meter_voice_minutes_block100_8000" },
      ],
      periodStart: s(STARTED),
      periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    });
    world.fake.on("invoices.createPreview", () => ({
      lines: {
        data: [
          { amount: -120_000, parent: { subscription_item_details: { proration: true } } },
          { amount: 52_000, parent: { subscription_item_details: { proration: true } } },
          { amount: 79_400, parent: { subscription_item_details: { proration: false } } },
        ],
      },
    }));
    __setStripeForTests(world.stripe);
    const packageItem = world.state.subscription.items.data[0]!.id;

    const preview = await previewChangePlan(
      { clinicId: clinic.clinicId, planId: "chat-web", interval: "month" },
      { now: NOW },
    );
    expect(preview).toEqual({
      status: "ok",
      planId: "chat-web",
      interval: "month",
      setupFeeDeltaCents: 0,
      prorationCents: -68_000,
      recurringCents: 39_700 * 2,
      droppedChannels: ["voice"],
      isInProgress: false,
    });
    const [call] = world.fake.callsTo("invoices.createPreview");
    expect(call!.args[0]).toMatchObject({
      customer: ids.stripeCustomerId,
      subscription: ids.stripeSubscriptionId,
      subscription_details: {
        items: [
          { id: packageItem, price: "price_healdesk_chat-web_month_39700", quantity: 2 },
          { id: world.state.subscription.items.data[1]!.id, deleted: true },
          { id: world.state.subscription.items.data[2]!.id, deleted: true },
          { price: "price_healdesk_meter_chat_conversations_block100_4000" },
        ],
        proration_behavior: "always_invoice",
      },
    });
    // A preview changes nothing.
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);

    // Moving to annual billing keeps the package billed (Meta is still not in
    // service) at its annual price, for both locations.
    const annual = await previewChangePlan(
      { clinicId: clinic.clinicId, planId: "complete", interval: "year" },
      { now: NOW },
    );
    expect(annual).toMatchObject({
      status: "ok",
      setupFeeDeltaCents: 0,
      interval: "year",
      recurringCents: 717 * 12 * 100 * 2,
      droppedChannels: [],
    });
  });

  test("a plan change preview before the start asks Stripe nothing", async () => {
    const clinic = await seedClinic("preview-change-pre");
    await seedEntitled(clinic.clinicId, { planId: "chat-web" });
    const fake = createStripeFake();
    __setStripeForTests(fake.stripe);
    expect(
      await previewChangePlan(
        { clinicId: clinic.clinicId, planId: "web-voice", interval: "month" },
        { now: NOW },
      ),
    ).toEqual({
      status: "ok",
      planId: "web-voice",
      interval: "month",
      setupFeeDeltaCents: 50_000,
      prorationCents: 0,
      recurringCents: 89_700,
      droppedChannels: [],
      isInProgress: false,
    });
    expect(fake.calls).toHaveLength(0);
  });
});
