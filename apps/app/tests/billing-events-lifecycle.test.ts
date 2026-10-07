import { randomUUID } from "node:crypto";

import {
  FIRST_PERIOD_REFUND_DAYS,
  FORWARDING_PASS_THROUGH_DAYS,
  getPlan,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  planMeteredPrices,
  stripeLookupKey,
} from "@healdesk/catalog";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { GRACE_DAYS, handleStripeEvent, MAX_FAILURES } from "@/lib/billing/events";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import type { NoticeKind } from "@/lib/email/kinds";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendRenewalReminders } from "@/lib/scheduler/annual-renewal-reminder";
import { sweepBilling } from "@/lib/scheduler/billing-sweep";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeedEntitledOptions } from "./setup/factories";
import { createStripeFake, stripeError, type StripeFake } from "./setup/stripe-fake";

/**
 * The Stripe lifecycle for clinics bought under the deferred start (build
 * spec BD7, BD8, BD10, BD11, R9 to R12, R21, R22, R31, R34, R37). The legacy
 * rows' behaviour (BD31) is billing-events.test.ts's.
 *
 * Every event is a hand-built payload in the shape the current API version
 * sends (prices as ids, parents typed), every invoice has its own id, and
 * every id is letters only (the audit guard refuses digit runs). Stripe is a
 * recording fake holding the "live" objects the handler re-reads before it
 * applies an event (R11): the test sets what Stripe holds now, which is how
 * a stale or out-of-order delivery is staged. Time is pinned: the handler's
 * `now` is NOW, never the wall clock.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const DAY = 24 * 60 * 60;
const DAY_MS = DAY * 1000;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

const complete = getPlan("complete")!;
const chatWeb = getPlan("chat-web")!;
const webVoice = getPlan("web-voice")!;

function letters(): string {
  return randomUUID().replace(/-/g, "").replace(/\d/g, "x");
}

function ref(prefix: string): string {
  return `${prefix}_${letters()}`;
}

function event(type: string, object: Record<string, unknown>, created = T): Stripe.Event {
  return {
    id: ref("evt"),
    object: "event",
    api_version: "2026-08-26.dahlia",
    created,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

type Ids = { customer: string; subscription: string };
type Line = Record<string, unknown> & { amount: number };

/** A subscription item's line: the package, the placeholder, or a metered item. */
function subscriptionLine(
  amount: number,
  start: number,
  end: number,
  options: { proration?: boolean; price?: string } = {},
): Line {
  return {
    id: ref("il"),
    object: "line_item",
    amount,
    period: { start, end },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: {
        proration: options.proration ?? false,
        subscription_item: ref("si"),
      },
    },
    pricing: { type: "price_details", price_details: { price: options.price ?? ref("price") } },
  };
}

function setupLine(amount: number): Line {
  return {
    id: ref("il"),
    object: "line_item",
    amount,
    period: { start: T, end: T },
    parent: { type: "invoice_item_details", invoice_item_details: { proration: false } },
    pricing: { type: "price_details", price_details: { price: ref("price") } },
  };
}

function invoice(
  ids: Ids,
  reason: string,
  lines: Line[],
  extra: { amountPaid?: number; amountDue?: number; hdKind?: string; hdRef?: string } = {},
): Record<string, unknown> {
  const id = ref("in");
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const metadata: Record<string, string> = {};
  if (extra.hdKind) metadata.hd_kind = extra.hdKind;
  if (extra.hdRef) metadata.hd_ref = extra.hdRef;
  return {
    id,
    object: "invoice",
    customer: ids.customer,
    billing_reason: reason,
    amount_paid: extra.amountPaid ?? total,
    amount_due: extra.amountDue ?? total,
    hosted_invoice_url: `https://invoice.stripe.com/i/acct_fixture/${id}`,
    status_transitions: { paid_at: T },
    metadata,
    period_start: T,
    period_end: T,
    parent:
      reason === "manual"
        ? null
        : {
            type: "subscription_details",
            subscription_details: { subscription: ids.subscription, metadata: { app: "healdesk" } },
          },
    lines: { object: "list", data: lines },
  };
}

type ItemFx = { lookupKey: string; quantity?: number; metered?: boolean; periodEnd?: number };

function subscription(
  ids: Ids,
  items: ItemFx[],
  options: { cancelAtPeriodEnd?: boolean; cancelAt?: number | null; status?: string } = {},
): Record<string, unknown> {
  return {
    id: ids.subscription,
    object: "subscription",
    customer: ids.customer,
    status: options.status ?? "active",
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    cancel_at: options.cancelAt ?? null,
    pause_collection: null,
    metadata: { app: "healdesk" },
    items: {
      object: "list",
      data: items.map((item) => ({
        id: ref("si"),
        quantity: item.metered ? undefined : (item.quantity ?? 1),
        current_period_start: T - 10 * DAY,
        current_period_end: item.periodEnd ?? T + 20 * DAY,
        price: {
          id: ref("price"),
          lookup_key: item.lookupKey,
          recurring: { usage_type: item.metered ? "metered" : "licensed" },
        },
      })),
    },
  };
}

/** What the fake Stripe holds now. */
type World = {
  invoices: Map<string, Record<string, unknown>>;
  subscriptions: Map<string, Record<string, unknown>>;
  refunds: Map<string, Record<string, unknown>[]>;
  prices: Map<string, string | null>;
};

let world: World;
let fake: StripeFake;

function missing(): never {
  throw stripeError("invalid_request", { code: "resource_missing", statusCode: 404 });
}

/** An unpaid invoice Stripe holds open after an attempt to collect it, and the event saying so. */
function unpaidEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  world.invoices.set(object.id as string, { ...object, status: "open", attempted: true });
  return event(type, object);
}

/** A paid invoice, paid in Stripe too, and the event that says so. */
function paidEvent(object: Record<string, unknown>): Stripe.Event {
  world.invoices.set(object.id as string, { ...object, status: "paid", attempted: true });
  return event("invoice.paid", object);
}

async function boughtClinic(
  label: string,
  options: SeedEntitledOptions = {},
): Promise<{ clinicId: string; ids: Ids }> {
  const { clinicId } = await seedClinic(label);
  const ids = { customer: ref("cus"), subscription: ref("sub") };
  await seedEntitled(clinicId, {
    stripe: { customerId: ids.customer, subscriptionId: ids.subscription },
    ...options,
  });
  return { clinicId, ids };
}

type Row = {
  status: string;
  plan_code: string;
  bought_plan_id: string | null;
  billing_interval: string;
  channels_enabled: { web: boolean; meta: boolean; voice: boolean };
  included_voice_minutes: number;
  included_chat_conversations: number;
  used_voice_minutes: string;
  used_chat_conversations: number;
  current_period_start: Date | null;
  current_period_end: Date | null;
  grace_ends_at: Date | null;
  setup_fee_paid_usd: string;
  first_paid_at: Date | null;
  paid_through: Date | null;
  last_paid_invoice_id: string | null;
  open_invoice_id: string | null;
  open_invoice_url: string | null;
  open_invoice_amount_cents: number | null;
  metered_price_keys: string[];
  locations: number;
  cancel_at: Date | null;
  plan_started_at: Date | null;
  plan_start_applied_at: Date | null;
  first_plan_invoice_id: string | null;
};

async function entitlementsOf(clinicId: string): Promise<Row> {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query(`select * from entitlements where clinic_id = $1`, [clinicId]),
  );
  return rows[0] as Row;
}

type Notice = { kind: NoticeKind; dedupe_key: string; payload: Record<string, unknown> };

async function noticesOf(clinicId: string, kind?: NoticeKind): Promise<Notice[]> {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<Notice>(
      `select kind, dedupe_key, payload from billing_notices
        where clinic_id = $1 and ($2::text is null or kind = $2)
        order by created_at, kind`,
      [clinicId, kind ?? null],
    ),
  );
  return rows;
}

async function reasonsOf(clinicId: string): Promise<string[]> {
  const { rows } = await inTenant(clinicId, (client) =>
    client.query<{ reason: string }>(
      `select reason from billing_transitions where clinic_id = $1 order by created_at`,
      [clinicId],
    ),
  );
  return rows.map((row) => row.reason);
}

async function ledger(
  eventId: string,
): Promise<{ outcome: string | null; error: string | null; failures: number }> {
  const { rows } = await getMigratorPool().query(
    `select outcome, error, failures from billing_events where stripe_event_id = $1`,
    [eventId],
  );
  return rows[0];
}

async function setUsage(clinicId: string, voice: number, chat: number): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `update entitlements set used_voice_minutes = $2, used_chat_conversations = $3 where clinic_id = $1`,
      [clinicId, voice, chat],
    ),
  );
}

/** Every stored payload passes the email platform's allowlist, as the sender will check it. */
function expectLintClean(notices: Notice[]): void {
  for (const notice of notices) {
    expect(() => assertPayloadAllowed(notice.payload, notice.kind), notice.kind).not.toThrow();
  }
}

describeDb("the deferred start's billing lifecycle", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    world = {
      invoices: new Map(),
      subscriptions: new Map(),
      refunds: new Map(),
      prices: new Map(),
    };
    fake = createStripeFake({
      "invoices.retrieve": (id) => world.invoices.get(id as string) ?? missing(),
      // Newest first, as Stripe lists.
      "invoices.list": (params) => {
        const { customer, status } = params as { customer?: string; status?: string };
        const data = [...world.invoices.values()].filter(
          (invoice) =>
            (!customer || invoice.customer === customer) && (!status || invoice.status === status),
        );
        return { object: "list", has_more: false, data: data.reverse() };
      },
      "subscriptions.retrieve": (id) => world.subscriptions.get(id as string) ?? missing(),
      "refunds.list": (params) => ({
        object: "list",
        has_more: false,
        data: world.refunds.get((params as { charge: string }).charge) ?? [],
      }),
      "prices.retrieve": (id) => {
        if (!world.prices.has(id as string)) missing();
        return { id, object: "price", lookup_key: world.prices.get(id as string) };
      },
    });
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  describe("invoice.paid (BD7)", () => {
    test("the $0 checkout invoice and the placeholder's $0 months open nothing and email nobody (R37)", async () => {
      const { clinicId, ids } = await boughtClinic("zero", {
        interval: "year",
        status: "provisioning",
        firstInvoice: false,
      });

      // The setup fee with the cohort credit: the line is gross and the
      // credit sits in the invoice's discounts, so nothing is charged.
      const create = invoice(
        ids,
        "subscription_create",
        [setupLine(complete.setupFeeUsd * 100), subscriptionLine(0, T, T + 30 * DAY)],
        { amountPaid: 0, amountDue: 0 },
      );
      const first = await handleStripeEvent(event("invoice.paid", create), { now: NOW });
      expect(first).toEqual({ outcome: "processed", duplicate: false, clinicId });

      let row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.setup_fee_paid_usd).toBe(`${complete.setupFeeUsd}.00`);
      expect(row.first_paid_at?.getTime()).toBe(NOW.getTime());
      expect(row.last_paid_invoice_id).toBe(create.id);
      expect(row.current_period_start).toBeNull();
      expect(row.current_period_end).toBeNull();
      expect(row.paid_through).toBeNull();
      expect(row.plan_started_at).toBeNull();
      expect(row.first_plan_invoice_id).toBeNull();

      // The placeholder's month rolls over before the plan starts.
      for (const month of [1, 2]) {
        const cycle = invoice(
          ids,
          "subscription_cycle",
          [subscriptionLine(0, T + month * 30 * DAY, T + (month + 1) * 30 * DAY)],
          { amountPaid: 0, amountDue: 0 },
        );
        expect(await handleStripeEvent(event("invoice.paid", cycle), { now: NOW })).toEqual({
          outcome: "processed",
          duplicate: false,
          clinicId,
        });
        row = await entitlementsOf(clinicId);
        expect(row.last_paid_invoice_id).toBe(cycle.id);
      }
      expect(row.status).toBe("active");
      expect(row.current_period_start).toBeNull();
      expect(row.paid_through).toBeNull();
      expect(row.plan_started_at).toBeNull();
      expect(await noticesOf(clinicId)).toEqual([]);
      // A $0 line names no package worth looking up.
      expect(fake.calls).toEqual([]);

      // Nor does the renewal reminder find anything to announce, at any point
      // of the year the placeholder might be mistaken for.
      for (const days of [0, 10, 30, 335, 364]) {
        await sendRenewalReminders(new Date(NOW.getTime() + days * DAY_MS));
      }
      expect(await noticesOf(clinicId)).toEqual([]);
    });

    test("the first plan invoice starts the plan, opens the window and sends plan_started (R9)", async () => {
      const { clinicId, ids } = await boughtClinic("start", {
        channelRows: [
          {
            channel: "web",
            liveAt: new Date(NOW.getTime() - 2 * DAY_MS),
            firstAnswerAt: new Date(NOW.getTime() - 60_000),
          },
          { channel: "meta" },
          { channel: "voice" },
        ],
      });
      // Usage before the start is never counted against the first window.
      await setUsage(clinicId, 12.5, 7);

      const price = ref("price");
      world.prices.set(price, stripeLookupKey(chatWeb, "month"));
      const end = T + 30 * DAY;
      const swap = invoice(ids, "subscription_update", [
        subscriptionLine(chatWeb.monthlyUsd * 100, T, end, { price }),
        // The bought package's metered items, added in the same update, bill
        // in arrears and are $0 on this invoice.
        subscriptionLine(0, T, T, { price: ref("price") }),
      ]);
      const e = event("invoice.paid", swap);
      const result = await handleStripeEvent(e, { now: NOW });
      expect(result).toEqual({
        outcome: "processed",
        duplicate: false,
        clinicId,
        criticalNotice: true,
      });

      const row = await entitlementsOf(clinicId);
      expect(row.plan_started_at?.getTime()).toBe(T * 1000);
      expect(row.current_period_start?.getTime()).toBe(T * 1000);
      expect(row.current_period_end?.getTime()).toBe(end * 1000);
      expect(Number(row.used_voice_minutes)).toBe(0);
      expect(row.used_chat_conversations).toBe(0);
      expect(row.paid_through?.getTime()).toBe(end * 1000);
      expect(row.first_plan_invoice_id).toBe(swap.id);
      expect(row.last_paid_invoice_id).toBe(swap.id);

      // The package named is the one Stripe billed (the price's lookup key),
      // not plan_code, which the worker may not have written yet.
      expect(row.plan_code).toBe("complete");
      expect(fake.callsTo("prices.retrieve").map((call) => call.args[0])).toEqual([price]);

      const notices = await noticesOf(clinicId);
      expect(notices).toEqual([
        {
          kind: "plan_started",
          dedupe_key: "plan_started",
          payload: {
            planName: chatWeb.name,
            boughtPlanId: "complete",
            channel: "web",
            amountCents: chatWeb.monthlyUsd * 100,
            interval: "month",
            periodEndsOn: new Date(end * 1000).toISOString().slice(0, 10),
            receiptUrl: swap.hosted_invoice_url,
            isBilledByChannelsInService: true,
          },
        },
      ]);
      expectLintClean(notices);

      // Delivered again: the ledger answers, nothing is queued twice.
      expect(await handleStripeEvent(e, { now: NOW })).toEqual({
        outcome: "processed",
        duplicate: true,
        clinicId,
      });

      // The first renewal after it is a renewal: a receipt, the window moves,
      // and Stripe is not asked about the price again.
      await setUsage(clinicId, 30, 40);
      const renewal = invoice(ids, "subscription_cycle", [
        subscriptionLine(chatWeb.monthlyUsd * 100, end, end + 31 * DAY),
      ]);
      expect(await handleStripeEvent(event("invoice.paid", renewal), { now: NOW })).toEqual({
        outcome: "processed",
        duplicate: false,
        clinicId,
      });
      const renewed = await entitlementsOf(clinicId);
      expect(renewed.current_period_start?.getTime()).toBe(end * 1000);
      expect(renewed.paid_through?.getTime()).toBe((end + 31 * DAY) * 1000);
      expect(renewed.used_chat_conversations).toBe(0);
      expect(renewed.plan_started_at?.getTime()).toBe(T * 1000);
      expect(renewed.first_plan_invoice_id).toBe(swap.id);
      expect(fake.callsTo("prices.retrieve")).toHaveLength(1);
      const receipts = await noticesOf(clinicId, "receipt");
      expect(receipts).toEqual([
        {
          kind: "receipt",
          dedupe_key: renewal.id,
          payload: {
            amountCents: chatWeb.monthlyUsd * 100,
            hostedInvoiceUrl: renewal.hosted_invoice_url,
            periodStartsOn: new Date(end * 1000).toISOString().slice(0, 10),
            periodEndsOn: new Date((end + 31 * DAY) * 1000).toISOString().slice(0, 10),
          },
        },
      ]);
      expectLintClean(receipts);
      expect(await noticesOf(clinicId, "plan_started")).toHaveLength(1);
    });

    test("an old-checkout purchase starts its plan on the checkout invoice, without plan_started (R34)", async () => {
      const { clinicId, ids } = await boughtClinic("oldcheckout", {
        planId: "web-voice",
        status: "provisioning",
        firstInvoice: false,
      });
      const end = T + 30 * DAY;
      const create = invoice(ids, "subscription_create", [
        subscriptionLine(webVoice.monthlyUsd * 100, T, end),
        subscriptionLine(0, T, T),
        setupLine(webVoice.setupFeeUsd * 100),
      ]);
      expect(await handleStripeEvent(event("invoice.paid", create), { now: NOW })).toEqual({
        outcome: "processed",
        duplicate: false,
        clinicId,
      });

      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.setup_fee_paid_usd).toBe(`${webVoice.setupFeeUsd}.00`);
      expect(row.plan_started_at?.getTime()).toBe(T * 1000);
      expect(row.plan_start_applied_at?.getTime()).toBe(T * 1000);
      expect(row.first_plan_invoice_id).toBe(create.id);
      expect(row.current_period_start?.getTime()).toBe(T * 1000);
      expect(row.current_period_end?.getTime()).toBe(end * 1000);
      expect(row.paid_through?.getTime()).toBe(end * 1000);
      // The welcome covers it.
      expect(await noticesOf(clinicId)).toEqual([]);
      expect(fake.calls).toEqual([]);
    });

    test("an action invoice after the start pushes paid_through, resets nothing and sends no receipt", async () => {
      const start = new Date(NOW.getTime() - 30 * DAY_MS);
      const { clinicId, ids } = await boughtClinic("action", {
        interval: "year",
        planStartedAt: start,
      });
      const before = await entitlementsOf(clinicId);
      await setUsage(clinicId, 55, 66);

      // An annual step-up: always_invoice, prorations only, to the year's end.
      const yearEnd = Math.floor(before.paid_through!.getTime() / 1000);
      const stepUp = invoice(ids, "subscription_update", [
        subscriptionLine(-20_000, T, yearEnd, { proration: true }),
        subscriptionLine(50_000, T, yearEnd, { proration: true }),
      ]);
      // It failed first, so the clinic is past due on it.
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", stepUp), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("past_due");

      await handleStripeEvent(event("invoice.paid", stepUp), { now: NOW });
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
      expect(row.paid_through?.getTime()).toBe(before.paid_through!.getTime());
      expect(row.current_period_start?.getTime()).toBe(before.current_period_start!.getTime());
      expect(Number(row.used_voice_minutes)).toBe(55);
      expect(row.used_chat_conversations).toBe(66);
      expect(await noticesOf(clinicId, "receipt")).toEqual([]);
      expect(await noticesOf(clinicId, "restored")).toEqual([]);

      // paid_through only ever moves forward.
      const earlier = invoice(ids, "subscription_update", [
        subscriptionLine(1_000, T, T + 5 * DAY, { proration: true }),
      ]);
      await handleStripeEvent(event("invoice.paid", earlier), { now: NOW });
      expect((await entitlementsOf(clinicId)).paid_through?.getTime()).toBe(
        before.paid_through!.getTime(),
      );
    });

    test("one-off invoices: the annual overage row is marked, setup charges get no receipt, others do", async () => {
      const start = new Date(NOW.getTime() - 60 * DAY_MS);
      const { clinicId, ids } = await boughtClinic("oneoff", {
        interval: "year",
        planStartedAt: start,
      });
      const windowStart = new Date("2026-09-03T10:00:00.000Z");
      await inTenant(clinicId, (client) =>
        client.query(
          `insert into overage_invoices (clinic_id, window_start, window_end, voice_units, amount_cents, status)
           values ($1, $2, $3, 25, 2000, 'pending')`,
          [clinicId, windowStart, new Date("2026-10-03T10:00:00.000Z")],
        ),
      );

      const overage = invoice(ids, "manual", [setupLine(2000)], {
        hdKind: "annual_overage",
        hdRef: `${clinicId}:${windowStart.toISOString()}`,
      });
      await handleStripeEvent(event("invoice.paid", overage), { now: NOW });
      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{ status: string; stripe_invoice_id: string; invoiced_at: Date }>(
          `select status, stripe_invoice_id, invoiced_at from overage_invoices where clinic_id = $1`,
          [clinicId],
        ),
      );
      expect(rows).toEqual([
        { status: "invoiced", stripe_invoice_id: overage.id, invoiced_at: NOW },
      ]);

      for (const hdKind of ["plan_change_setup", "location_setup"]) {
        await handleStripeEvent(
          event("invoice.paid", invoice(ids, "manual", [setupLine(50_000)], { hdKind })),
          {
            now: NOW,
          },
        );
      }
      expect(await noticesOf(clinicId, "receipt")).toEqual([]);

      const other = invoice(ids, "manual", [setupLine(12_345)]);
      await handleStripeEvent(event("invoice.paid", other), { now: NOW });
      const receipts = await noticesOf(clinicId, "receipt");
      expect(receipts).toEqual([
        {
          kind: "receipt",
          dedupe_key: other.id,
          payload: {
            amountCents: 12_345,
            hostedInvoiceUrl: other.hosted_invoice_url,
            periodStartsOn: null,
            periodEndsOn: null,
          },
        },
      ]);
      expect((await entitlementsOf(clinicId)).last_paid_invoice_id).toBe(other.id);
    });

    test("a one-off invoice settles the clinic only when it is the invoice owed (R10)", async () => {
      const { clinicId, ids } = await boughtClinic("owed", {
        interval: "year",
        planStartedAt: new Date(NOW.getTime() - 60 * DAY_MS),
      });
      const overage = invoice(ids, "manual", [setupLine(3000)], { hdKind: "annual_overage" });
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", overage), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("past_due");

      // Some other one-off invoice paid meanwhile settles nothing.
      await handleStripeEvent(event("invoice.paid", invoice(ids, "manual", [setupLine(500)])), {
        now: NOW,
      });
      expect((await entitlementsOf(clinicId)).status).toBe("past_due");

      await handleStripeEvent(event("invoice.paid", overage), { now: NOW });
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
    });
  });

  describe("R10: what a payment lifts", () => {
    async function suspendedForGrace(label: string, options: SeedEntitledOptions = {}) {
      const start = new Date(NOW.getTime() - 40 * DAY_MS);
      const clinic = await boughtClinic(label, { planStartedAt: start, ...options });
      const renewal = invoice(clinic.ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), { now: NOW });
      await sweepBilling(new Date(NOW.getTime() + (GRACE_DAYS + 1) * DAY_MS));
      expect((await entitlementsOf(clinic.clinicId)).status).toBe("suspended");
      return { ...clinic, renewal };
    }

    test("paying the invoice owed lifts a suspension for non-payment, with restored and no receipt", async () => {
      const { clinicId, renewal } = await suspendedForGrace("lift");
      await handleStripeEvent(event("invoice.paid", renewal), { now: NOW });

      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
      const restored = await noticesOf(clinicId, "restored");
      expect(restored).toEqual([
        {
          kind: "restored",
          dedupe_key: `restored:${renewal.id}`,
          payload: { receiptUrl: renewal.hosted_invoice_url },
        },
      ]);
      expectLintClean(restored);
      expect(await noticesOf(clinicId, "receipt")).toEqual([]);
    });

    test("a dispute's suspension is not lifted by a payment, nor one disputed since", async () => {
      const { clinicId, ids } = await boughtClinic("disputed", {
        planStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
      });
      const dispute = event("charge.dispute.created", {
        id: ref("dp"),
        object: "dispute",
        charge: { id: ref("ch"), customer: ids.customer, metadata: {} },
        payment_intent: null,
      });
      expect(await handleStripeEvent(dispute, { now: NOW })).toEqual({
        outcome: "processed",
        duplicate: false,
        clinicId,
        criticalNotice: true,
      });
      const suspended = await noticesOf(clinicId, "suspended");
      expect(suspended.map((n) => n.dedupe_key)).toEqual([`dispute:${dispute.id}`]);
      expectLintClean(suspended);

      const renewal = invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      await handleStripeEvent(event("invoice.paid", renewal), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("suspended");
      expect(await noticesOf(clinicId, "restored")).toEqual([]);
      // Money moved and no other email covers it.
      expect((await noticesOf(clinicId, "receipt")).map((n) => n.dedupe_key)).toEqual([renewal.id]);

      // Suspended for non-payment, then disputed: the dispute is a note, and
      // it still stands in the way.
      const second = await suspendedForGrace("disputedlater");
      await handleStripeEvent(
        event("charge.dispute.created", {
          id: ref("dp"),
          object: "dispute",
          charge: { id: ref("ch"), customer: second.ids.customer, metadata: {} },
          payment_intent: null,
        }),
        { now: NOW },
      );
      expect(await reasonsOf(second.clinicId)).toContain("dispute");
      await handleStripeEvent(event("invoice.paid", second.renewal), { now: NOW });
      expect((await entitlementsOf(second.clinicId)).status).toBe("suspended");
    });

    test("a $0 invoice lifts nothing; money moved with no invoice on record does", async () => {
      // Suspended by Stripe giving up (`unpaid`), with no invoice recorded as
      // owed, so only the amount stands between a payment and a restore.
      const { clinicId, ids } = await boughtClinic("zeropaid", {
        planStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
      });
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [{ lookupKey: stripeLookupKey(complete, "month") }], {
          status: "unpaid",
        }),
      );
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
        { now: NOW },
      );
      const suspended = await entitlementsOf(clinicId);
      expect(suspended.status).toBe("suspended");
      expect(suspended.open_invoice_id).toBeNull();

      const credited = invoice(
        ids,
        "subscription_cycle",
        [subscriptionLine(complete.monthlyUsd * 100, T + 30 * DAY, T + 61 * DAY)],
        { amountPaid: 0 },
      );
      await handleStripeEvent(event("invoice.paid", credited), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("suspended");
      expect(await noticesOf(clinicId, "restored")).toEqual([]);
      // Nothing was charged, so there is no receipt either.
      expect(await noticesOf(clinicId, "receipt")).toEqual([]);

      const paid = invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T + 61 * DAY, T + 91 * DAY),
      ]);
      await handleStripeEvent(event("invoice.paid", paid), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("active");
      expect((await noticesOf(clinicId, "restored")).map((n) => n.dedupe_key)).toEqual([
        `restored:${paid.id}`,
      ]);
    });

    test("a payment of a different invoice from the one owed lifts nothing", async () => {
      const { clinicId, ids } = await suspendedForGrace("otherpaid");
      const other = invoice(ids, "subscription_update", [
        subscriptionLine(10_000, T, T + 30 * DAY, { proration: true }),
      ]);
      await handleStripeEvent(event("invoice.paid", other), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("suspended");
      expect(await noticesOf(clinicId, "restored")).toEqual([]);
    });

    test("a cancelling clinic suspended for grace goes back to cancelling when it pays (R21)", async () => {
      const { clinicId, ids } = await boughtClinic("cancelpay", {
        planStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
      });
      world.subscriptions.set(
        ids.subscription,
        subscription(
          ids,
          [{ lookupKey: stripeLookupKey(complete, "month"), periodEnd: T + 20 * DAY }],
          {
            cancelAtPeriodEnd: true,
          },
        ),
      );
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
        {
          now: NOW,
        },
      );
      expect((await entitlementsOf(clinicId)).status).toBe("canceling");

      const stepUp = invoice(ids, "subscription_update", [
        subscriptionLine(30_000, T, T + 20 * DAY, { proration: true }),
      ]);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", stepUp), { now: NOW });
      const failing = await entitlementsOf(clinicId);
      expect(failing.status).toBe("canceling");
      expect(failing.grace_ends_at?.getTime()).toBe(NOW.getTime() + GRACE_DAYS * DAY_MS);
      // Grace runs on a cancelling clinic too, so the email names the date.
      expect((await noticesOf(clinicId, "payment_failed"))[0]!.payload.graceEndsAt).toBe(
        new Date(NOW.getTime() + GRACE_DAYS * DAY_MS).toISOString(),
      );

      const result = await sweepBilling(new Date(NOW.getTime() + (GRACE_DAYS + 1) * DAY_MS));
      expect(result.suspended).toContain(clinicId);
      expect((await noticesOf(clinicId, "suspended")).map((n) => n.dedupe_key)).toEqual([
        `grace_expired:${failing.grace_ends_at!.toISOString()}`,
      ]);

      await handleStripeEvent(event("invoice.paid", stepUp), { now: NOW });
      expect((await entitlementsOf(clinicId)).status).toBe("canceling");
      expect(await noticesOf(clinicId, "restored")).toHaveLength(1);
      expect(await reasonsOf(clinicId)).toEqual(
        expect.arrayContaining(["grace_expired", "invoice.paid", "cancel_at_period_end"]),
      );
    });
  });

  describe("unpaid invoices (R11)", () => {
    test("a failed payment records the invoice owed, opens grace once and emails once per invoice", async () => {
      const { clinicId, ids } = await boughtClinic("failed", {
        planStartedAt: new Date(NOW.getTime() - 25 * DAY_MS),
      });
      const renewal = invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      const first = await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), {
        now: NOW,
      });
      expect(first).toEqual({
        outcome: "processed",
        duplicate: false,
        clinicId,
        criticalNotice: true,
      });
      expect(fake.callsTo("invoices.retrieve").map((call) => call.args[0])).toEqual([renewal.id]);

      const graceEnds = new Date(NOW.getTime() + GRACE_DAYS * DAY_MS);
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("past_due");
      expect(row.grace_ends_at?.getTime()).toBe(graceEnds.getTime());
      expect(row.open_invoice_id).toBe(renewal.id);
      expect(row.open_invoice_url).toBe(renewal.hosted_invoice_url);
      expect(row.open_invoice_amount_cents).toBe(complete.monthlyUsd * 100);

      const notices = await noticesOf(clinicId, "payment_failed");
      expect(notices).toEqual([
        {
          kind: "payment_failed",
          dedupe_key: renewal.id,
          payload: {
            amountDueCents: complete.monthlyUsd * 100,
            hostedInvoiceUrl: renewal.hosted_invoice_url,
            graceEndsAt: graceEnds.toISOString(),
            isFirstPlanCharge: false,
          },
        },
      ]);
      expectLintClean(notices);

      // Stripe's retry a day later: the same invoice, a new event.
      const retry = await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), {
        now: new Date(NOW.getTime() + DAY_MS),
      });
      expect(retry.criticalNotice).toBeUndefined();
      expect(await noticesOf(clinicId, "payment_failed")).toHaveLength(1);
      expect((await entitlementsOf(clinicId)).grace_ends_at?.getTime()).toBe(graceEnds.getTime());
    });

    test("a failure for an invoice that is void or paid by now is ignored before any write", async () => {
      const { clinicId, ids } = await boughtClinic("stale", {
        planStartedAt: new Date(NOW.getTime() - 25 * DAY_MS),
      });
      for (const status of ["void", "paid"]) {
        const stale = invoice(ids, "subscription_update", [
          subscriptionLine(40_000, T, T + 30 * DAY, { proration: true }),
        ]);
        world.invoices.set(stale.id as string, { ...stale, status });
        const e = event("invoice.payment_failed", stale);
        expect(await handleStripeEvent(e, { now: NOW })).toEqual({
          outcome: "ignored",
          duplicate: false,
          clinicId,
        });
        expect(await ledger(e.id)).toMatchObject({
          outcome: "ignored",
          error: `invoice is ${status} now`,
        });
      }
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.open_invoice_id).toBeNull();
      expect(row.grace_ends_at).toBeNull();
      expect(await noticesOf(clinicId)).toEqual([]);
    });

    test("a failure for the invoice last paid is stale, and a setup charge's failure is a note only", async () => {
      const { clinicId, ids } = await boughtClinic("lastpaid", {
        planStartedAt: new Date(NOW.getTime() - 25 * DAY_MS),
      });
      const renewal = invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      await handleStripeEvent(event("invoice.paid", renewal), { now: NOW });
      // Stripe still says open (its retry raced the payment), but we recorded it paid.
      const late = unpaidEvent("invoice.payment_failed", renewal);
      expect(await handleStripeEvent(late, { now: NOW })).toMatchObject({ outcome: "ignored" });
      expect(await ledger(late.id)).toMatchObject({ error: "invoice already paid" });

      const setup = invoice(ids, "manual", [setupLine(50_000)], { hdKind: "plan_change_setup" });
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", setup), { now: NOW });
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.open_invoice_id).toBeNull();
      expect(row.grace_ends_at).toBeNull();
      expect(await noticesOf(clinicId, "payment_failed")).toEqual([]);
      expect(await reasonsOf(clinicId)).toContain("invoice.payment_failed");
    });

    test("the first plan charge failing says so, even once the worker marked the plan applied", async () => {
      const { clinicId, ids } = await boughtClinic("firstfail", { planStartAppliedAt: NOW });
      const swap = invoice(ids, "subscription_update", [
        subscriptionLine(chatWeb.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", swap), { now: NOW });
      const [notice] = await noticesOf(clinicId, "payment_failed");
      expect(notice!.payload.isFirstPlanCharge).toBe(true);
      expect((await entitlementsOf(clinicId)).plan_started_at).toBeNull();
    });

    test("a payment the bank wants confirmed records the invoice and emails without moving the status", async () => {
      const { clinicId, ids } = await boughtClinic("sca", {
        planStartedAt: new Date(NOW.getTime() - 25 * DAY_MS),
      });
      const renewal = invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.monthlyUsd * 100, T, T + 30 * DAY),
      ]);
      const result = await handleStripeEvent(
        unpaidEvent("invoice.payment_action_required", renewal),
        {
          now: NOW,
        },
      );
      expect(result.criticalNotice).toBe(true);
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBe(renewal.id);
      const notices = await noticesOf(clinicId, "payment_action_required");
      expect(notices).toEqual([
        {
          kind: "payment_action_required",
          dedupe_key: renewal.id,
          payload: {
            amountDueCents: complete.monthlyUsd * 100,
            hostedInvoiceUrl: renewal.hosted_invoice_url,
          },
        },
      ]);
      expectLintClean(notices);
      expect(await reasonsOf(clinicId)).toContain("authentication_required");
    });
  });

  describe("two unpaid invoices at once (review fix)", () => {
    /** Annual and started: its renewal and the annual overage invoice can both fail on its card. */
    async function annualClinic(label: string) {
      return boughtClinic(label, {
        interval: "year",
        planStartedAt: new Date(NOW.getTime() - 60 * DAY_MS),
      });
    }
    const renewalOf = (ids: Ids) =>
      invoice(ids, "subscription_cycle", [
        subscriptionLine(complete.annualMonthlyUsd * 12 * 100, T, T + 365 * DAY),
      ]);
    const overageOf = (ids: Ids) =>
      invoice(ids, "manual", [setupLine(8_000)], { hdKind: "annual_overage" });

    test("the renewal fails, then the overage: paying the overage leaves the clinic past due, still owing the renewal", async () => {
      const { clinicId, ids } = await annualClinic("renewalfirst");
      const renewal = renewalOf(ids);
      const overage = overageOf(ids);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), { now: NOW });
      const graceEnds = (await entitlementsOf(clinicId)).grace_ends_at!;
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", overage), { now: NOW });

      // The first debt stays recorded; the second's own email links its page.
      let row = await entitlementsOf(clinicId);
      expect(row.open_invoice_id).toBe(renewal.id);
      expect(row.open_invoice_url).toBe(renewal.hosted_invoice_url);
      expect(
        (await noticesOf(clinicId, "payment_failed")).map((n) => [
          n.dedupe_key,
          n.payload.hostedInvoiceUrl,
        ]),
      ).toEqual([
        [renewal.id, renewal.hosted_invoice_url],
        [overage.id, overage.hosted_invoice_url],
      ]);

      await handleStripeEvent(paidEvent(overage), { now: NOW });
      row = await entitlementsOf(clinicId);
      expect(row.status).toBe("past_due");
      expect(row.grace_ends_at?.getTime()).toBe(graceEnds.getTime());
      expect(row.open_invoice_id).toBe(renewal.id);
      expect(row.open_invoice_amount_cents).toBe(renewal.amount_due);

      await handleStripeEvent(paidEvent(renewal), { now: NOW });
      row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
    });

    test("the overage fails, then the renewal: paying the renewal leaves the clinic past due, still owing the overage", async () => {
      const { clinicId, ids } = await annualClinic("overagefirst");
      const renewal = renewalOf(ids);
      const overage = overageOf(ids);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", overage), { now: NOW });
      const graceEnds = (await entitlementsOf(clinicId)).grace_ends_at!;
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), { now: NOW });
      expect((await entitlementsOf(clinicId)).open_invoice_id).toBe(overage.id);

      await handleStripeEvent(paidEvent(renewal), { now: NOW });
      let row = await entitlementsOf(clinicId);
      expect(row.status).toBe("past_due");
      expect(row.grace_ends_at?.getTime()).toBe(graceEnds.getTime());
      expect(row.open_invoice_id).toBe(overage.id);
      expect(row.open_invoice_url).toBe(overage.hosted_invoice_url);
      expect(row.open_invoice_amount_cents).toBe(8_000);

      await handleStripeEvent(paidEvent(overage), { now: NOW });
      row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
    });

    test("paying the invoice recorded moves the slot on to the next one still owed, never to nothing", async () => {
      const { clinicId, ids } = await annualClinic("moveson");
      const renewal = renewalOf(ids);
      const overage = overageOf(ids);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), { now: NOW });
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", overage), { now: NOW });

      await handleStripeEvent(paidEvent(renewal), { now: NOW });
      let row = await entitlementsOf(clinicId);
      expect(row.status).toBe("past_due");
      expect(row.grace_ends_at).not.toBeNull();
      expect(row.open_invoice_id).toBe(overage.id);
      expect(row.open_invoice_url).toBe(overage.hosted_invoice_url);
      expect(row.open_invoice_amount_cents).toBe(8_000);
      expect(fake.callsTo("invoices.list").at(-1)!.args[0]).toEqual({
        customer: ids.customer,
        status: "open",
        limit: 100,
      });

      await handleStripeEvent(paidEvent(overage), { now: NOW });
      row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.open_invoice_id).toBeNull();
    });

    test("an invoice recorded as owed that Stripe no longer holds open gives way when another is paid", async () => {
      const { clinicId, ids } = await annualClinic("voided");
      const renewal = renewalOf(ids);
      await handleStripeEvent(unpaidEvent("invoice.payment_failed", renewal), { now: NOW });
      // Voided in Stripe's Dashboard: no event of ours says so.
      world.invoices.set(renewal.id as string, { ...renewal, status: "void", attempted: true });

      const stepUp = invoice(ids, "subscription_update", [
        subscriptionLine(30_000, T, T + 300 * DAY, { proration: true }),
      ]);
      await handleStripeEvent(paidEvent(stepUp), { now: NOW });
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.grace_ends_at).toBeNull();
      expect(row.open_invoice_id).toBeNull();
    });

    test("a paid invoice asks Stripe nothing while nothing is recorded as owed", async () => {
      const { clinicId, ids } = await annualClinic("nothingowed");
      await handleStripeEvent(paidEvent(renewalOf(ids)), { now: NOW });
      expect(fake.callsTo("invoices.list")).toEqual([]);
      expect((await entitlementsOf(clinicId)).status).toBe("active");
    });
  });

  describe("customer.subscription.updated, applied from the live subscription (R11, BD8, BD10)", () => {
    test("what Stripe holds now wins over the payload, so delivery order stops mattering", async () => {
      const { clinicId, ids } = await boughtClinic("order", {
        planStartedAt: new Date(NOW.getTime() - 30 * DAY_MS),
      });
      const periodEnd = T + 20 * DAY;
      const item = { lookupKey: stripeLookupKey(complete, "month"), periodEnd };

      // Auto-renew went off, and then back on. The event for the change that
      // was undone arrives last, still saying "scheduled".
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [item], { cancelAtPeriodEnd: true }),
      );
      const off = event(
        "customer.subscription.updated",
        subscription(ids, [item], { cancelAtPeriodEnd: false }),
        T - 50,
      );
      await handleStripeEvent(off, { now: NOW });
      let row = await entitlementsOf(clinicId);
      expect(row.status).toBe("canceling");
      expect(row.cancel_at?.getTime()).toBe(periodEnd * 1000);

      world.subscriptions.set(ids.subscription, subscription(ids, [item]));
      const on = event(
        "customer.subscription.updated",
        subscription(ids, [item], { cancelAtPeriodEnd: true }),
        T - 10,
      );
      await handleStripeEvent(on, { now: NOW });
      row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.cancel_at).toBeNull();

      const notices = await noticesOf(clinicId);
      expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
        ["cancel_scheduled", off.id],
        ["cancel_reversed", on.id],
      ]);
      expect(notices[0]!.payload).toEqual({
        endsAt: new Date(periodEnd * 1000).toISOString(),
        isBeforeStart: false,
        refundWindowEndsOn: null,
      });
      expect(notices[1]!.payload).toEqual({ isBeforeStart: false });
      expectLintClean(notices);
      expect(fake.callsTo("subscriptions.retrieve")).toHaveLength(2);
    });

    test("a read taken before one already applied is skipped under the row lock, even before that one's ledger says processed (review fix)", async () => {
      const { clinicId, ids } = await boughtClinic("interleaved", {
        planStartedAt: new Date(NOW.getTime() - 30 * DAY_MS),
      });
      const item = { lookupKey: stripeLookupKey(complete, "month"), periodEnd: T + 20 * DAY };
      // Auto-renew turned off, then straight back on. The "off" delivery reads
      // the subscription while the cancellation is still scheduled, then stalls
      // before its transaction; the "on" delivery reads it reversed, commits,
      // and is held just before its ledger row is marked processed.
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [item], { cancelAtPeriodEnd: true }),
      );
      const off = event(
        "customer.subscription.updated",
        subscription(ids, [item], { cancelAtPeriodEnd: true }),
        T - 50,
      );
      const on = event("customer.subscription.updated", subscription(ids, [item]), T - 10);

      let releaseOff!: () => void;
      const offResumes = new Promise<void>((resolve) => (releaseOff = resolve));
      let markOffRead!: () => void;
      const offHasRead = new Promise<void>((resolve) => (markOffRead = resolve));
      let markLedgerHeld!: (xid: string) => void;
      const ledgerHeld = new Promise<string>((resolve) => (markLedgerHeld = resolve));
      const ledgerHolder = await getMigratorPool().connect();
      let reads = 0;
      fake.on("subscriptions.retrieve", async (id) => {
        const live = structuredClone(world.subscriptions.get(id as string)) ?? missing();
        reads += 1;
        if (reads === 1) {
          markOffRead();
          await offResumes;
          return live;
        }
        // The "on" delivery: hold its ledger row, so its finish() waits.
        await ledgerHolder.query("begin");
        await ledgerHolder.query(
          `select 1 from billing_events where stripe_event_id = $1 for update`,
          [on.id],
        );
        const { rows } = await ledgerHolder.query<{ xid: string }>(
          `select (pg_current_xact_id()::text::bigint & 4294967295)::text as xid`,
        );
        markLedgerHeld(rows[0]!.xid);
        return live;
      });

      try {
        const offDone = handleStripeEvent(off, { now: NOW });
        await offHasRead;
        world.subscriptions.set(ids.subscription, subscription(ids, [item]));
        const onDone = handleStripeEvent(on, { now: NOW });

        // Wait for the "on" delivery's finish() to queue behind the held row:
        // its tenant transaction, with what it applied, has committed by then.
        const xid = await ledgerHeld;
        const deadline = Date.now() + 45_000;
        for (;;) {
          const { rows: waiting } = await getMigratorPool().query<{ n: number }>(
            `select count(*)::int as n from pg_locks
              where locktype = 'transactionid' and not granted and transactionid::text = $1`,
            [xid],
          );
          if (waiting[0]!.n > 0) break;
          if (Date.now() > deadline) throw new Error("the newer delivery never reached its ledger");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await ledger(on.id)).toMatchObject({ outcome: null });

        releaseOff();
        expect(await offDone).toEqual({ outcome: "ignored", duplicate: false, clinicId });
        await ledgerHolder.query("commit");
        expect(await onDone).toEqual({ outcome: "processed", duplicate: false, clinicId });
      } finally {
        releaseOff();
        await ledgerHolder.query("rollback").catch(() => undefined);
        ledgerHolder.release();
      }

      expect(await ledger(off.id)).toMatchObject({
        outcome: "ignored",
        error: "a later read of the subscription was already applied",
      });
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("active");
      expect(row.cancel_at).toBeNull();
      expect(await noticesOf(clinicId, "cancel_scheduled")).toEqual([]);
    }, 60_000);

    test("before the start, E1 closes at the earlier of the period end and the setup deadline", async () => {
      const deadline = new Date(NOW.getTime() + 10 * DAY_MS);
      const { clinicId, ids } = await boughtClinic("beforestart", { setupDeadlineAt: deadline });
      const placeholder = { lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY, periodEnd: T + 25 * DAY };
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [placeholder], { cancelAtPeriodEnd: true }),
      );
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
        {
          now: NOW,
        },
      );
      const row = await entitlementsOf(clinicId);
      expect(row.status).toBe("canceling");
      expect(row.cancel_at?.getTime()).toBe((T + 25 * DAY) * 1000);
      const [scheduled] = await noticesOf(clinicId, "cancel_scheduled");
      expect(scheduled!.payload).toEqual({
        endsAt: deadline.toISOString(),
        isBeforeStart: true,
        refundWindowEndsOn: null,
      });

      world.subscriptions.set(ids.subscription, subscription(ids, [placeholder]));
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
        {
          now: NOW,
        },
      );
      expect((await entitlementsOf(clinicId)).status).toBe("active");
      const [reversed] = await noticesOf(clinicId, "cancel_reversed");
      expect(reversed!.payload).toEqual({ isBeforeStart: true });
    });

    test("inside the first-period refund window, E1 carries the window's last day (R15, R31)", async () => {
      const started = new Date(NOW.getTime() - 3 * DAY_MS);
      const inside = await boughtClinic("refundwindow", { planStartedAt: started });
      const outside = await boughtClinic("pastwindow", {
        planStartedAt: new Date(NOW.getTime() - (FIRST_PERIOD_REFUND_DAYS + 1) * DAY_MS),
      });
      for (const { ids } of [inside, outside]) {
        world.subscriptions.set(
          ids.subscription,
          subscription(ids, [{ lookupKey: stripeLookupKey(complete, "month") }], {
            cancelAtPeriodEnd: true,
          }),
        );
        await handleStripeEvent(
          event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
          {
            now: NOW,
          },
        );
      }
      const [due] = await noticesOf(inside.clinicId, "cancel_scheduled");
      expect(due!.payload.refundWindowEndsOn).toBe(
        new Date(started.getTime() + FIRST_PERIOD_REFUND_DAYS * DAY_MS).toISOString().slice(0, 10),
      );
      const [late] = await noticesOf(outside.clinicId, "cancel_scheduled");
      expect(late!.payload.refundWindowEndsOn).toBeNull();
    });

    test("the billed package, the locations and the metered keys follow Stripe; channels follow what was bought (BD8)", async () => {
      const { clinicId, ids } = await boughtClinic("snapshot", {
        planStartedAt: new Date(NOW.getTime() - 5 * DAY_MS),
        locations: 2,
      });
      const meteredKeys = planMeteredPrices(complete).map((price) => price.lookupKey);
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [
          ...meteredKeys.map((lookupKey) => ({ lookupKey, metered: true })),
          { lookupKey: stripeLookupKey(chatWeb, "month"), quantity: 3 },
        ]),
      );
      const e = event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!);
      await handleStripeEvent(e, { now: NOW });

      const row = await entitlementsOf(clinicId);
      expect(row.plan_code).toBe("chat-web");
      expect(row.included_chat_conversations).toBe(chatWeb.includedChatConversations);
      expect(row.bought_plan_id).toBe("complete");
      expect(row.channels_enabled).toEqual({ web: true, meta: true, voice: true });
      expect(row.locations).toBe(3);
      expect(row.metered_price_keys).toEqual([...meteredKeys].sort());
      // Only our own actions tell the clinic about a plan change or a location.
      expect(await noticesOf(clinicId)).toEqual([]);
      expect(await reasonsOf(clinicId)).toContain("plan_change");

      // Before a plan starts the subscription carries only the placeholder,
      // whose quantity is never taken for the locations.
      const pre = await boughtClinic("placeholderqty", { locations: 2 });
      world.subscriptions.set(
        pre.ids.subscription,
        subscription(pre.ids, [{ lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY, quantity: 1 }]),
      );
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(pre.ids.subscription)!),
        {
          now: NOW,
        },
      );
      const preRow = await entitlementsOf(pre.clinicId);
      expect(preRow.locations).toBe(2);
      expect(preRow.plan_code).toBe("complete");
      expect(preRow.metered_price_keys).toEqual([]);
    });

    test("unpaid suspends a cancelling clinic too, and tells it with the forwarding facts (R21, R31)", async () => {
      const { clinicId, ids } = await boughtClinic("unpaid", {
        planStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
      });
      await getMigratorPool().query(
        `update clinics set carrier = 'tmobile', phone_system_type = 'landline', call_routing = 'always' where id = $1`,
        [clinicId],
      );
      const item = { lookupKey: stripeLookupKey(complete, "month") };
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [item], { cancelAtPeriodEnd: true }),
      );
      await handleStripeEvent(
        event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!),
        {
          now: NOW,
        },
      );
      expect((await entitlementsOf(clinicId)).status).toBe("canceling");

      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [item], { cancelAtPeriodEnd: true, status: "unpaid" }),
      );
      const e = event("customer.subscription.updated", world.subscriptions.get(ids.subscription)!);
      expect(await handleStripeEvent(e, { now: NOW })).toMatchObject({ criticalNotice: true });
      expect((await entitlementsOf(clinicId)).status).toBe("suspended");
      const suspended = await noticesOf(clinicId, "suspended");
      expect(suspended).toEqual([
        {
          kind: "suspended",
          dedupe_key: `unpaid:${e.id}`,
          payload: {
            hostedInvoiceUrl: null,
            amountDueCents: null,
            carrier: "tmobile",
            phoneSystem: "landline",
            routing: "all_calls",
          },
        },
      ]);
      expectLintClean(suspended);
    });

    test("a trialing subscription is an error: it retries, parks and tells ops (R37)", async () => {
      const { clinicId, ids } = await boughtClinic("trialing");
      world.subscriptions.set(
        ids.subscription,
        subscription(ids, [{ lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY }], {
          status: "trialing",
        }),
      );
      const e = event(
        "customer.subscription.updated",
        subscription(ids, [{ lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY }]),
      );
      for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
        await expect(handleStripeEvent(e, { now: NOW })).rejects.toMatchObject({
          name: "TrialingSubscriptionError",
        });
      }
      expect(await handleStripeEvent(e, { now: NOW })).toEqual({
        outcome: "dead_letter",
        duplicate: false,
        clinicId,
      });
      expect(await ledger(e.id)).toMatchObject({
        outcome: "dead_letter",
        error: expect.stringContaining("TrialingSubscriptionError"),
      });
      // Nothing of it was applied.
      expect((await entitlementsOf(clinicId)).status).toBe("active");

      const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
        `select fields from ops_alerts where event = 'billing_event_dead_lettered' and fields->>'eventId' = $1`,
        [e.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fields).toMatchObject({
        eventId: e.id,
        type: "customer.subscription.updated",
        clinicId,
        failures: MAX_FAILURES,
      });
    });
  });

  describe("customer.subscription.deleted (R11, R12)", () => {
    test("our setup-window closure ends the account without the canceled email", async () => {
      const { clinicId, ids } = await boughtClinic("closure");
      const deleted = {
        ...subscription(ids, [{ lookupKey: PLAN_START_PLACEHOLDER_LOOKUP_KEY }], {
          status: "canceled",
        }),
        ended_at: T,
        cancellation_details: {
          comment: "hd_setup_closure",
          feedback: null,
          reason: "cancellation_requested",
        },
      };
      await handleStripeEvent(event("customer.subscription.deleted", deleted), { now: NOW });

      expect((await entitlementsOf(clinicId)).status).toBe("canceled");
      expect(await noticesOf(clinicId)).toEqual([]);
      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_offboarding'`,
          [clinicId],
        ),
      );
      expect(rows.map((r) => r.metadata)).toEqual([{ started: true, reason: "setup_closure" }]);
    });

    test("any other end sends canceled once, with the pass-through, forwarding and data dates (R31)", async () => {
      const { clinicId, ids } = await boughtClinic("ended", {
        planStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
      });
      await getMigratorPool().query(
        `update clinics set carrier = 'verizon', phone_system_type = 'voip', call_routing = 'conditional' where id = $1`,
        [clinicId],
      );
      const deleted = {
        ...subscription(ids, [{ lookupKey: stripeLookupKey(complete, "month") }], {
          status: "canceled",
        }),
        ended_at: T - 3600,
        cancellation_details: { comment: null, feedback: null, reason: "cancellation_requested" },
      };
      await handleStripeEvent(event("customer.subscription.deleted", deleted), { now: NOW });
      await handleStripeEvent(event("customer.subscription.deleted", deleted), { now: NOW });

      expect((await entitlementsOf(clinicId)).status).toBe("canceled");
      const notices = await noticesOf(clinicId, "canceled");
      expect(notices).toEqual([
        {
          kind: "canceled",
          dedupe_key: ids.subscription,
          payload: {
            passThroughDays: FORWARDING_PASS_THROUGH_DAYS,
            endedAt: new Date((T - 3600) * 1000).toISOString(),
            isBeforeStart: false,
            channels: ["web", "meta", "voice"],
            exportByOn: new Date(NOW.getTime() + 30 * DAY_MS).toISOString().slice(0, 10),
            destroyByOn: new Date(NOW.getTime() + 90 * DAY_MS).toISOString().slice(0, 10),
            carrier: "verizon",
            phoneSystem: "voip",
            routing: "overflow_after_hours",
          },
        },
      ]);
      expectLintClean(notices);
    });
  });

  describe("charge.refunded (R11)", () => {
    test("every refund that went through emails once, with the kind our action stamped", async () => {
      const { clinicId, ids } = await boughtClinic("refunded", {
        planStartedAt: new Date(NOW.getTime() - 5 * DAY_MS),
      });
      const charge = ref("ch");
      const [first, second, failed] = [ref("re"), ref("re"), ref("re")];
      world.refunds.set(charge, [
        {
          id: first,
          object: "refund",
          amount: 119_700,
          status: "succeeded",
          created: T - 60,
          metadata: { hd_kind: "first_period_cancel" },
        },
        {
          id: second,
          object: "refund",
          amount: 500,
          status: "pending",
          created: T - 30,
          metadata: {},
        },
        {
          id: failed,
          object: "refund",
          amount: 700,
          status: "failed",
          created: T - 10,
          metadata: {},
        },
      ]);
      const object = {
        id: charge,
        object: "charge",
        customer: ids.customer,
        amount_refunded: 120_200,
        metadata: {},
      };

      const result = await handleStripeEvent(event("charge.refunded", object), { now: NOW });
      expect(result).toEqual({ outcome: "processed", duplicate: false, clinicId });
      expect(fake.callsTo("refunds.list").map((call) => call.args[0])).toEqual([
        { charge, limit: 100 },
      ]);

      // A later partial refund's event lists the earlier ones again.
      await handleStripeEvent(event("charge.refunded", object), { now: NOW });

      const notices = await noticesOf(clinicId, "refund_issued");
      expect(notices.map((n) => [n.dedupe_key, n.payload])).toEqual(
        expect.arrayContaining([
          [
            `refund:${first}`,
            {
              amountCents: 119_700,
              kind: "first_period_cancel",
              refundedAt: new Date((T - 60) * 1000).toISOString(),
            },
          ],
          [
            `refund:${second}`,
            {
              amountCents: 500,
              kind: "other",
              refundedAt: new Date((T - 30) * 1000).toISOString(),
            },
          ],
        ]),
      );
      expect(notices).toHaveLength(2);
      expectLintClean(notices);
      expect(await reasonsOf(clinicId)).toContain("charge_refunded");
    });

    test("a refund for a customer no clinic has is ignored, never retried, and Stripe is not asked", async () => {
      const e = event("charge.refunded", {
        id: ref("ch"),
        object: "charge",
        customer: ref("cus"),
        metadata: { app: "healdesk" },
      });
      expect(await handleStripeEvent(e, { now: NOW })).toEqual({
        outcome: "ignored",
        duplicate: false,
        clinicId: null,
      });
      expect(await ledger(e.id)).toMatchObject({ outcome: "ignored", failures: 0 });
      expect(fake.calls).toEqual([]);
    });
  });
});
