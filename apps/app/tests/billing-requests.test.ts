import { randomUUID } from "node:crypto";

import {
  getPlan,
  meteredPriceLookupKey,
  parseLookupKey,
  PLAN_START_PLACEHOLDER_LOOKUP_KEY,
  stripeLookupKey,
  type Channel,
} from "@healdesk/catalog";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { BillingRequestKind } from "@/db/schema";
import { claimStripeMutationLease } from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import {
  BILLING_REQUEST_RETRY_MINUTES,
  closeUnfinishedSetup,
  drainBillingRequests,
  MAX_BILLING_REQUEST_ATTEMPTS,
  rearmBillingRequest,
  requestCancelNow,
  retryDelayMs,
  runBillingRequestsJob,
  startPlan,
  stepUpPackage,
  subscriptionShape,
} from "@/lib/billing/requests";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { getJob, JOB_BILLING_REQUESTS, JOB_SETUP_CLOSURE } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  inTenant,
  seedChannels,
  seedClinic,
  seedEntitled,
  type SeedChannelRow,
  type SeededClinic,
  type SeedEntitledOptions,
} from "./setup/factories";
import { createStripeFake, stripeError } from "./setup/stripe-fake";

/**
 * The billing-request worker (build spec BD1 to BD3, BD11, R2 to R8, R15,
 * R16, R37), against a recording Stripe fake that answers like a small
 * stateful Stripe and refuses any trial parameter: the plan start's swap,
 * quantity, metered items, anchor, proration, off-session flag and card
 * move; the step-up's target, which never drops a billed channel; the setup
 * closure and its live-channel guard; the immediate cancellation; and the
 * ledger's claim, lease, fencing, backoff, dead letter and deferrals.
 */

vi.setConfig({ testTimeout: 30_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const ACTOR = { type: "service", serviceName: "billing-requests-test" } as const;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
// A drain's clock is its pinned `now` moving forward with real time, so a
// lease or a wait is asserted as at least its length and well short of the
// next one's, with room for a slow machine in between.

/** Every worker call carries these (R4), plus a key when it moves money or state. */
const WORKER_OPTIONS = { timeout: 20_000, maxNetworkRetries: 1 };

function plan(id: string) {
  const found = getPlan(id);
  if (!found) throw new Error(`No package ${id}`);
  return found;
}

const packageKey = (id: string, interval: "month" | "year") => stripeLookupKey(plan(id), interval);
const priceId = (lookupKey: string) => `price_${lookupKey}`;
const VOICE_80 = meteredPriceLookupKey("voiceMinutes", 0.8);
const CHAT_30 = meteredPriceLookupKey("chatConversations", 0.3);

// -----------------------------------------------------------------------------
// A small stateful Stripe
// -----------------------------------------------------------------------------

type FakePrice = {
  id: string;
  object: "price";
  lookup_key: string | null;
  product: string;
  unit_amount: number;
  recurring: { interval: "month" | "year"; usage_type: "licensed" | "metered" };
};

function priceFor(lookupKey: string): FakePrice {
  const parsed = parseLookupKey(lookupKey);
  const metered = lookupKey.startsWith("healdesk_meter_");
  return {
    id: priceId(lookupKey),
    object: "price",
    lookup_key: lookupKey,
    product: `prod_${lookupKey.length}`,
    unit_amount: parsed
      ? parsed.cents
      : metered
        ? Number(lookupKey.slice(lookupKey.lastIndexOf("_") + 1))
        : 0,
    recurring: {
      interval: parsed?.kind === "year" ? "year" : "month",
      usage_type: metered ? "metered" : "licensed",
    },
  };
}

/** A $0 licensed price created before the placeholder had its lookup key. */
const KEYLESS_ZERO: FakePrice = {
  id: "price_keyless_zero",
  object: "price",
  lookup_key: null,
  product: "prod_zero",
  unit_amount: 0,
  recurring: { interval: "month", usage_type: "licensed" },
};

type FakeItem = { id: string; object: "subscription_item"; price: FakePrice; quantity?: number };

const item = (id: string, lookupKey: string, quantity?: number): FakeItem => ({
  id,
  object: "subscription_item",
  price: priceFor(lookupKey),
  ...(quantity !== undefined ? { quantity } : {}),
});

type WorldOptions = {
  customerId: string;
  subscriptionId: string;
  items: FakeItem[];
  status?: string;
  cancelAtPeriodEnd?: boolean;
  /** The card Checkout left on the subscription. */
  subscriptionCard?: string | null;
  /** The customer's invoice default. */
  customerCard?: string | null;
  latestInvoice?: unknown;
  pending?: { id: string; subscription: string | null }[];
};

type Handler = (...args: unknown[]) => unknown;

/**
 * One customer and one subscription, held in memory: updates apply to the
 * items, cancels end it, deletes remove pending items. `handlers` are the
 * world's own, for a test that wraps one to fail first or interfere.
 */
function world(options: WorldOptions) {
  const state = {
    sub: {
      id: options.subscriptionId,
      object: "subscription",
      customer: options.customerId,
      status: options.status ?? "active",
      cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
      cancel_at: null as number | null,
      default_payment_method: options.subscriptionCard ?? null,
      metadata: {} as Record<string, string>,
      items: { object: "list", data: options.items },
      latest_invoice: options.latestInvoice ?? null,
      cancellation_details: { comment: null as string | null },
    },
    customerCard: options.customerCard ?? null,
    pending: [...(options.pending ?? [])],
    deleted: [] as string[],
  };
  let nextItem = 0;
  const copy = () => structuredClone(state.sub);
  const handlers: Record<string, Handler> = {
    "prices.list": (params) => ({
      object: "list",
      data: (params as { lookup_keys: string[] }).lookup_keys.map(priceFor),
      has_more: false,
    }),
    "subscriptions.retrieve": () => copy(),
    "subscriptions.update": (_id, params) => {
      const p = params as Stripe.SubscriptionUpdateParams;
      let items = state.sub.items.data;
      for (const change of p.items ?? []) {
        if (change.deleted) {
          // Stripe refuses to delete an item that is gone, which is what
          // stops a retried plan start from charging twice (R4).
          if (!items.some((existing) => existing.id === change.id)) {
            throw stripeError("invalid_request", { code: "resource_missing" });
          }
          items = items.filter((existing) => existing.id !== change.id);
          continue;
        }
        const price = priceFor(String(change.price).replace(/^price_/, ""));
        items = change.id
          ? items.map((existing) =>
              existing.id === change.id
                ? { ...existing, price, quantity: change.quantity ?? 1 }
                : existing,
            )
          : [
              ...items,
              {
                id: `si_new_${++nextItem}`,
                object: "subscription_item" as const,
                price,
                ...(change.quantity !== undefined ? { quantity: change.quantity } : {}),
              },
            ];
      }
      state.sub.items.data = items;
      if (p.default_payment_method === "") state.sub.default_payment_method = null;
      if (p.metadata && typeof p.metadata === "object")
        Object.assign(state.sub.metadata, p.metadata);
      return copy();
    },
    "customers.retrieve": () => ({
      id: options.customerId,
      object: "customer",
      invoice_settings: { default_payment_method: state.customerCard },
    }),
    "customers.update": (_id, params) => {
      state.customerCard = (
        params as { invoice_settings: { default_payment_method: string } }
      ).invoice_settings.default_payment_method;
      return { id: options.customerId, object: "customer" };
    },
    "invoiceItems.list": () => ({
      object: "list",
      data: state.pending.map((pending) => ({
        id: pending.id,
        object: "invoiceitem",
        parent: pending.subscription
          ? {
              type: "subscription_details",
              subscription_details: { subscription: pending.subscription },
            }
          : null,
      })),
      has_more: false,
    }),
    "invoiceItems.del": (id) => {
      state.pending = state.pending.filter((pending) => pending.id !== id);
      state.deleted.push(String(id));
      return { id, object: "invoiceitem", deleted: true };
    },
    "subscriptions.cancel": (_id, params) => {
      state.sub.status = "canceled";
      const comment = (params as Stripe.SubscriptionCancelParams).cancellation_details?.comment;
      state.sub.cancellation_details = { comment: typeof comment === "string" ? comment : null };
      return copy();
    },
  };
  const fake = createStripeFake(handlers);
  return { fake, state, handlers, stripe: fake.stripe };
}

// -----------------------------------------------------------------------------
// The database side
// -----------------------------------------------------------------------------

type RequestRow = {
  id: string;
  kind: string;
  channel_key: string;
  reason: string;
  attempts: number;
  epoch: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  done_at: Date | null;
  outcome: string | null;
  outcome_reason: string | null;
  last_error: string | null;
};

type EntitlementsRow = {
  plan_code: string;
  billing_interval: string;
  bought_plan_id: string | null;
  channels_enabled: Record<string, boolean>;
  metered_price_keys: string[];
  plan_started_at: Date | null;
  plan_start_applied_at: Date | null;
  stripe_mutation_lease_owner: string | null;
  stripe_mutation_lease_until: Date | null;
};

async function requestOf(clinicId: string, kind: BillingRequestKind, channel = "-") {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<RequestRow>(
      `select * from billing_requests where clinic_id = $1 and kind = $2 and channel_key = $3`,
      [clinicId, kind, channel],
    );
    return rows[0]!;
  });
}

async function entitlementsOf(clinicId: string): Promise<EntitlementsRow> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<EntitlementsRow>(
      `select * from entitlements where clinic_id = $1`,
      [clinicId],
    );
    return rows[0]!;
  });
}

async function noticesOf(clinicId: string, kind: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices where clinic_id = $1 and kind = $2`,
      [clinicId, kind],
    );
    return rows;
  });
}

async function notesOf(clinicId: string): Promise<string[]> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ reason: string }>(
      `select reason from billing_transitions where clinic_id = $1 order by created_at`,
      [clinicId],
    );
    return rows.map((row) => row.reason);
  });
}

async function opsAlerts(event: string, clinicId: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1 and fields->>'clinicId' = $2`,
    [event, clinicId],
  );
  return rows.map((row) => row.fields);
}

async function setJob(name: string, enabled: boolean): Promise<void> {
  await getMigratorPool().query(`update scheduled_jobs set enabled = $2 where name = $1`, [
    name,
    enabled,
  ]);
}

/** Record a request through the real recorder, then make it due at a pinned time. */
async function record(
  clinicId: string,
  kind: BillingRequestKind,
  options: { channel?: Channel; dueAt?: Date } = {},
): Promise<RequestRow> {
  await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    if (kind === "plan_start") await startPlan(tx, clinicId);
    else if (kind === "step_up")
      await stepUpPackage(tx, clinicId, options.channel!, "first_answer");
    else if (kind === "close_setup") await closeUnfinishedSetup(tx, clinicId);
    else await requestCancelNow(tx, clinicId);
  });
  const due = options.dueAt ?? at(-MINUTE);
  await inTenant(clinicId, (c) =>
    c.query(
      `update billing_requests set next_attempt_at = $4, requested_at = $4
        where clinic_id = $1 and kind = $2 and channel_key = $3`,
      [clinicId, kind, options.channel ?? "-", due],
    ),
  );
  return requestOf(clinicId, kind, options.channel);
}

/** Change a request as the migrator (owner), inside its tenant. `$1` is the id. */
async function patchRequest(clinicId: string, id: string, set: string, values: unknown[] = []) {
  await inTenant(clinicId, (c) =>
    c.query(`update billing_requests set ${set} where id = $1`, [id, ...values]),
  );
}

/**
 * changePlan's last transaction, held open: `sql` writes the entitlements
 * row (the new package bought, the mutation lease released with it) and the
 * transaction waits, holding the row lock, while `whileHeld` starts the
 * worker. It commits once the worker is queued behind the lock. A worker
 * that read the row before queueing then claims the lease the change just
 * released and acts on the package before it: the interleaving the review
 * found. One that reads under the lock sees the change.
 */
async function commitWhileQueued<T>(
  clinicId: string,
  sql: string,
  whileHeld: () => Promise<T>,
): Promise<T> {
  const holder = await getMigratorPool().connect();
  try {
    await holder.query("begin");
    await holder.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    await holder.query(sql, [clinicId]);
    const { rows } = await holder.query<{ xid: string }>(
      `select (pg_current_xact_id()::text::bigint & 4294967295)::text as xid`,
    );
    const xid = rows[0]!.xid;
    let isSettled = false;
    const running = whileHeld().finally(() => {
      isSettled = true;
    });
    running.catch(() => undefined);
    const deadline = Date.now() + 45_000;
    for (;;) {
      const { rows: waiting } = await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from pg_locks
          where locktype = 'transactionid' and not granted and transactionid::text = $1`,
        [xid],
      );
      // Finished without ever waiting: commit, and let the assertions say why.
      if (waiting[0]!.n > 0 || isSettled) break;
      if (Date.now() > deadline) throw new Error("the worker never queued behind the row lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await holder.query("commit");
    return await running;
  } catch (error) {
    await holder.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
}

/** In service: ready, live and answered. */
const inService = (channel: Channel): SeedChannelRow => ({
  channel,
  readyAt: at(-10 * DAY),
  liveAt: at(-9 * DAY),
  firstAnswerAt: at(-DAY),
});

type Seeded = SeededClinic & { customerId: string; subscriptionId: string };

async function seedBilling(label: string, options: SeedEntitledOptions = {}): Promise<Seeded> {
  const clinic = await seedClinic(label);
  const ids = await seedEntitled(clinic.clinicId, options);
  return {
    ...clinic,
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
  };
}

/** A location billed on `billing`: a clinic of its own pointing at it. */
async function seedLocation(billing: SeededClinic, rows: SeedChannelRow[]): Promise<string> {
  const { rows: inserted } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
  );
  const id = inserted[0]!.id;
  if (rows.length > 0) await seedChannels(id, rows);
  return id;
}

/** Started: the worker's update went through (R8). */
const STARTED = { planStartAppliedAt: at(-20 * DAY) };

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("retry waits (R4)", () => {
  test("1, 5, 30, 120, 360, 720 then 1440 minutes, for at most ten attempts", () => {
    expect(BILLING_REQUEST_RETRY_MINUTES).toEqual([1, 5, 30, 120, 360, 720, 1440]);
    expect(MAX_BILLING_REQUEST_ATTEMPTS).toBe(10);
    expect(Array.from({ length: 9 }, (_, i) => retryDelayMs(i + 1) / MINUTE)).toEqual([
      1, 5, 30, 120, 360, 720, 1440, 1440, 1440,
    ]);
  });
});

describe("subscriptionShape", () => {
  const sub = (items: FakeItem[]) => ({ items: { data: items } }) as unknown as Stripe.Subscription;

  test("finds the placeholder by its lookup key, the package item and the metered keys", () => {
    expect(
      subscriptionShape(
        sub([
          item("si_meter", VOICE_80),
          item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY),
          item("si_package", packageKey("web-voice", "month"), 2),
        ]),
      ),
    ).toMatchObject({
      placeholderItemId: "si_hold",
      packageItem: { id: "si_package", interval: "month", quantity: 2, plan: { id: "web-voice" } },
      meteredKeys: [VOICE_80],
    });
  });

  test("falls back to a licensed $0 item when no item carries the placeholder's key", () => {
    const keyless: FakeItem = { id: "si_zero", object: "subscription_item", price: KEYLESS_ZERO };
    expect(subscriptionShape(sub([keyless]))).toMatchObject({
      placeholderItemId: "si_zero",
      packageItem: null,
    });
  });
});

// -----------------------------------------------------------------------------
// The worker
// -----------------------------------------------------------------------------

describeDb("the billing-request worker", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(closePools);
  beforeEach(async () => {
    // Every drain sees every clinic's due rows, so each test starts clean.
    await truncateAll();
    __clearPriceCacheForTests();
  });

  describe("plan start (BD2, R16)", () => {
    test("swaps the placeholder for the package of the channels in service across the group, moves the card, and stamps the start", async () => {
      // Bought Complete for two locations; web answers at the billing clinic
      // and voice at the second location, so Web + Voice is billed.
      const billing = await seedBilling("start", {
        planId: "complete",
        interval: "month",
        locations: 2,
        channelRows: [inService("web"), { channel: "meta", readyAt: at(-DAY) }],
      });
      await seedLocation(billing, [inService("voice")]);
      const request = await record(billing.clinicId, "plan_start");
      const { fake, state, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        subscriptionCard: "pm_from_checkout",
      });

      expect(await drainBillingRequests({ now: NOW, stripe })).toEqual({
        processed: 1,
        deferred: 0,
        failed: 0,
      });

      expect(fake.calls.map((call) => call.method)).toEqual([
        "subscriptions.retrieve",
        "prices.list",
        "customers.retrieve",
        "customers.update",
        "subscriptions.update",
      ]);
      expect(fake.callsTo("subscriptions.retrieve")[0]!.args).toEqual([
        billing.subscriptionId,
        {},
        WORKER_OPTIONS,
      ]);
      // R16: the customer had no default, so the card is copied to it first.
      expect(fake.callsTo("customers.update")[0]!.args).toEqual([
        billing.customerId,
        { invoice_settings: { default_payment_method: "pm_from_checkout" } },
        { ...WORKER_OPTIONS, idempotencyKey: `hd-pm-sync:${billing.clinicId}:${request.id}:0:1` },
      ]);
      expect(fake.callsTo("subscriptions.update")[0]!.args).toEqual([
        billing.subscriptionId,
        {
          items: [
            { id: "si_hold", deleted: true },
            { price: priceId(packageKey("web-voice", "month")), quantity: 2 },
            // The BOUGHT package's metered rates, on a monthly plan.
            { price: priceId(CHAT_30) },
            { price: priceId(VOICE_80) },
          ],
          billing_cycle_anchor: "now",
          proration_behavior: "none",
          payment_behavior: "allow_incomplete",
          off_session: true,
          metadata: { hd_plan_start: request.id },
          expand: ["latest_invoice"],
          default_payment_method: "",
        },
        {
          ...WORKER_OPTIONS,
          idempotencyKey: `hd-plan-start:${billing.clinicId}:${request.id}:0:1`,
        },
      ]);
      // R37: no call anywhere carried a trial parameter (the fake refuses them).
      expect(JSON.stringify(fake.calls)).not.toMatch(/trial_/);
      // A card replaced in the portal now applies: the subscription carries none.
      expect(state.sub.default_payment_method).toBeNull();
      expect(state.customerCard).toBe("pm_from_checkout");

      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "done",
        outcome_reason: "started",
        attempts: 1,
        lease_until: null,
      });
      const row = await entitlementsOf(billing.clinicId);
      expect(row).toMatchObject({
        plan_code: "web-voice",
        bought_plan_id: "complete",
        billing_interval: "month",
        // Bought decides the channels; being billed for less never turns one off.
        channels_enabled: { web: true, meta: true, voice: true },
        metered_price_keys: [CHAT_30, VOICE_80].sort(),
        // The paid start, the window and L2 come from invoice.paid (BD7).
        plan_started_at: null,
        stripe_mutation_lease_owner: null,
      });
      expect(row.plan_start_applied_at).not.toBeNull();
      expect(await notesOf(billing.clinicId)).toContain("plan_start");
    });

    test("an annual plan carries no metered items, and a keyless $0 item is still the placeholder", async () => {
      const billing = await seedBilling("start-annual", {
        planId: "chat-web",
        interval: "year",
        channelRows: [inService("web")],
      });
      const request = await record(billing.clinicId, "plan_start");
      const { fake, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [{ id: "si_zero", object: "subscription_item", price: KEYLESS_ZERO }],
      });

      await drainBillingRequests({ now: NOW, stripe });

      // No card on the subscription: nothing to move, nothing to clear.
      expect(fake.callsTo("customers.retrieve")).toHaveLength(0);
      const [, params, options] = fake.callsTo("subscriptions.update")[0]!.args as [
        string,
        Stripe.SubscriptionUpdateParams,
        Stripe.RequestOptions,
      ];
      expect(params.items).toEqual([
        { id: "si_zero", deleted: true },
        { price: priceId(packageKey("chat-web", "year")), quantity: 1 },
      ]);
      expect(params).not.toHaveProperty("default_payment_method");
      expect(options.idempotencyKey).toBe(`hd-plan-start:${billing.clinicId}:${request.id}:0:1`);
      expect(await entitlementsOf(billing.clinicId)).toMatchObject({
        plan_code: "chat-web",
        billing_interval: "year",
        metered_price_keys: [],
      });
    });

    test("a customer that already has a default card keeps it; only the subscription's is cleared", async () => {
      const billing = await seedBilling("start-card", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      const { fake, state, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        subscriptionCard: "pm_old",
        customerCard: "pm_portal",
      });

      await drainBillingRequests({ now: NOW, stripe });

      expect(fake.callsTo("customers.update")).toHaveLength(0);
      expect(fake.callsTo("subscriptions.update")[0]!.args[1]).toMatchObject({
        default_payment_method: "",
      });
      expect(state.customerCard).toBe("pm_portal");
      expect(state.sub.default_payment_method).toBeNull();
    });

    test("an update that already went through is recorded from Stripe, with no second update", async () => {
      const billing = await seedBilling("start-again", {
        planId: "complete",
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "plan_start");
      const { fake, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("web-voice", "month")), item("si_meter", VOICE_80)],
        // A cancellation set after the start does not hide that it started.
        cancelAtPeriodEnd: true,
      });

      await drainBillingRequests({ now: NOW, stripe });

      expect(fake.calls.map((call) => call.method)).toEqual(["subscriptions.retrieve"]);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "done",
        outcome_reason: "already_started",
      });
      const row = await entitlementsOf(billing.clinicId);
      expect(row.plan_start_applied_at).not.toBeNull();
      expect(row).toMatchObject({ plan_code: "web-voice", metered_price_keys: [VOICE_80] });
      // Not a fresh start, so no "started while set to cancel" alert.
      expect(await opsAlerts("plan_start_after_cancel", billing.clinicId)).toEqual([]);
    });

    test("the local re-check skips without calling Stripe: already started, cancellation pending, nothing in service", async () => {
      const started = await seedBilling("skip-started", {
        planStartedAt: at(-5 * DAY),
        channelRows: [inService("web")],
      });
      const canceling = await seedBilling("skip-cancel", { channelRows: [inService("web")] });
      await inTenant(canceling.clinicId, (c) =>
        c.query(`update entitlements set cancel_at = $2 where clinic_id = $1`, [
          canceling.clinicId,
          at(20 * DAY),
        ]),
      );
      const idle = await seedBilling("skip-idle", {
        channelRows: [{ channel: "web", readyAt: at(-DAY), liveAt: at(-DAY) }],
      });
      for (const clinic of [started, canceling, idle]) await record(clinic.clinicId, "plan_start");
      const fake = createStripeFake();

      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 3,
        deferred: 0,
        failed: 0,
      });
      expect(fake.calls).toEqual([]);
      expect(await requestOf(started.clinicId, "plan_start")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "already_started",
      });
      expect(await requestOf(canceling.clinicId, "plan_start")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "cancel_pending",
      });
      expect(await requestOf(idle.clinicId, "plan_start")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "no_channel_in_service",
      });
    });

    test("a cancellation scheduled on Stripe skips the start", async () => {
      const billing = await seedBilling("skip-stripe-cancel", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      const { fake, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        cancelAtPeriodEnd: true,
      });

      await drainBillingRequests({ now: NOW, stripe });

      expect(fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "cancel_pending",
      });
    });

    test("a trialing subscription is an error: dead-lettered at once, and ops is told (R37)", async () => {
      const billing = await seedBilling("trial", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      const { fake, stripe } = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        status: "trialing",
      });

      expect(await drainBillingRequests({ now: NOW, stripe })).toMatchObject({ failed: 1 });

      expect(fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "dead_letter",
        outcome_reason: "permanent_error",
        last_error: "subscription_trialing",
        attempts: 1,
      });
      expect(await opsAlerts("billing_request_dead_lettered", billing.clinicId)).toEqual([
        expect.objectContaining({ kind: "plan_start", code: "subscription_trialing" }),
      ]);
    });

    test("reads the row under its lock, so a plan change committing as the lease frees is priced, not the package before it (review fix)", async () => {
      // Bought Complete, web and voice answering: Web + Voice would be billed.
      // The clinic moves to Web Chatbot before the start, and changePlan's last
      // transaction commits while the worker is reading the row. Its lease has
      // run out (slow Stripe calls), so the worker's claim waits on the row
      // lock rather than failing, and succeeds the moment the change commits:
      // a plain read before it would have priced the old package.
      const billing = await seedBilling("start-locked", {
        planId: "complete",
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "plan_start");
      await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
        claimStripeMutationLease(tx.db, billing.clinicId, "change_plan:portal", {
          now: at(-10 * MINUTE),
        }),
      );
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });

      const drained = await commitWhileQueued(
        billing.clinicId,
        `update entitlements
            set bought_plan_id = 'chat-web', plan_code = 'chat-web',
                channels_enabled = '{"web": true, "meta": false, "voice": false}'::jsonb,
                stripe_mutation_lease_owner = null, stripe_mutation_lease_until = null
          where clinic_id = $1`,
        () => drainBillingRequests({ now: NOW, stripe: w.stripe }),
      );

      expect(drained).toEqual({ processed: 1, deferred: 0, failed: 0 });
      const [, params] = w.fake.callsTo("subscriptions.update")[0]!.args as [
        string,
        Stripe.SubscriptionUpdateParams,
      ];
      // The package the clinic now owns, at its own metered rates.
      expect(params.items).toEqual([
        { id: "si_hold", deleted: true },
        { price: priceId(packageKey("chat-web", "month")), quantity: 1 },
        ...expectedMeteredKeys("chat-web", "month")!.map((key) => ({ price: priceId(key) })),
      ]);
      expect(await entitlementsOf(billing.clinicId)).toMatchObject({
        plan_code: "chat-web",
        bought_plan_id: "chat-web",
      });
    }, 60_000);

    test("a plan start or a step-up waits, without spending an attempt, while a plan change is still being completed (review fix)", async () => {
      const starting = await seedBilling("start-change-pending", {
        planId: "complete",
        channelRows: [inService("web")],
      });
      await record(starting.clinicId, "plan_start");
      const stepping = await seedBilling("step-change-pending", {
        planId: "chat-web",
        boughtPlanId: "complete",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(stepping.clinicId, "step_up", { channel: "voice" });
      for (const clinic of [starting, stepping]) {
        await inTenant(clinic.clinicId, (c) =>
          c.query(
            `update entitlements
                set pending_plan_change_request_id = 'chg_1', pending_plan_change_plan_id = 'chat-web',
                    pending_plan_change_interval = 'year'
              where clinic_id = $1`,
            [clinic.clinicId],
          ),
        );
      }
      const fake = createStripeFake();

      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 2,
        failed: 0,
      });
      expect(fake.calls).toEqual([]);
      expect(await requestOf(starting.clinicId, "plan_start")).toMatchObject({
        attempts: 0,
        outcome: null,
      });
      expect(await requestOf(stepping.clinicId, "step_up", "voice")).toMatchObject({
        attempts: 0,
        outcome: null,
      });
      for (const clinic of [starting, stepping]) {
        expect((await entitlementsOf(clinic.clinicId)).stripe_mutation_lease_owner).toBeNull();
      }
    });

    test("a start that lands on a subscription set to cancel alerts ops (R5)", async () => {
      const billing = await seedBilling("start-cancel-race", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      w.fake.on("subscriptions.update", (...args: unknown[]) => {
        // Auto-renew went off while the update was on its way.
        w.state.sub.cancel_at_period_end = true;
        return w.handlers["subscriptions.update"]!(...args);
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect((await requestOf(billing.clinicId, "plan_start")).outcome_reason).toBe("started");
      expect(await opsAlerts("plan_start_after_cancel", billing.clinicId)).toEqual([
        expect.objectContaining({ clinicId: billing.clinicId }),
      ]);
    });
  });

  describe("the ledger: claim, lease, fencing, backoff and dead letter (BD1, R3, R4, R5)", () => {
    test("a Stripe 5xx that changed nothing backs off a minute, and the retry uses a new key", async () => {
      const billing = await seedBilling("backoff", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      let failNext = true;
      w.fake.on("subscriptions.update", (...args: unknown[]) => {
        if (failNext) {
          failNext = false;
          throw stripeError("api", { statusCode: 500 });
        }
        return w.handlers["subscriptions.update"]!(...args);
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 1,
      });
      // R4: the failed mutation is followed by a re-read, which found nothing applied.
      expect(w.fake.callsTo("subscriptions.retrieve")).toHaveLength(2);
      const failed = await requestOf(billing.clinicId, "plan_start");
      expect(failed).toMatchObject({
        attempts: 1,
        outcome: null,
        lease_until: null,
        last_error: "stripe:api_error",
      });
      const wait = failed.next_attempt_at.getTime() - NOW.getTime();
      expect(wait).toBeGreaterThanOrEqual(MINUTE);
      expect(wait).toBeLessThan(2 * MINUTE);
      expect((await entitlementsOf(billing.clinicId)).stripe_mutation_lease_owner).toBeNull();

      // Not due half a minute later.
      expect(await drainBillingRequests({ now: at(30_000), stripe: w.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 0,
      });

      expect(await drainBillingRequests({ now: at(5 * MINUTE), stripe: w.stripe })).toEqual({
        processed: 1,
        deferred: 0,
        failed: 0,
      });
      expect(
        w.fake
          .callsTo("subscriptions.update")
          .map((call) => (call.args[2] as Stripe.RequestOptions).idempotencyKey),
      ).toEqual([
        `hd-plan-start:${billing.clinicId}:${request.id}:0:1`,
        `hd-plan-start:${billing.clinicId}:${request.id}:0:2`,
      ]);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "done",
        outcome_reason: "started",
        attempts: 2,
      });
    });

    test("a re-armed request never replays a failure Stripe cached under an earlier attempt's key (review fix)", async () => {
      const billing = await seedBilling("rearm-keys", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      // Stripe keeps the first answer under an idempotency key for 24 hours,
      // a 500 included, and replays it for the same key without running it.
      const cached = new Map<string, () => unknown>();
      let isIncident = true;
      w.fake.on("subscriptions.update", (...args: unknown[]) => {
        const key = (args[2] as Stripe.RequestOptions).idempotencyKey!;
        let answer = cached.get(key);
        if (!answer) {
          if (isIncident) {
            const error = stripeError("api", { statusCode: 500 });
            answer = () => {
              throw error;
            };
          } else {
            const result = w.handlers["subscriptions.update"]!(...args);
            answer = () => result;
          }
          cached.set(key, answer);
        }
        return answer();
      });

      // Three attempts during an incident, each when its backoff made it due.
      let dueAt = NOW;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(await drainBillingRequests({ now: dueAt, stripe: w.stripe })).toMatchObject({
          failed: 1,
        });
        dueAt = (await requestOf(billing.clinicId, "plan_start")).next_attempt_at;
      }
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        attempts: 3,
        epoch: 0,
        outcome: null,
      });
      const failedKeys = new Set(cached.keys());
      expect(failedKeys.size).toBe(3);

      // Stripe recovers, and an operator presses Retry well before the
      // fourth attempt would have come round.
      isIncident = false;
      const retryAt = new Date(dueAt.getTime() - 20 * MINUTE);
      expect(
        await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
          rearmBillingRequest(tx, request.id, "ops", retryAt),
        ),
      ).toBe(true);
      expect(await drainBillingRequests({ now: retryAt, stripe: w.stripe })).toEqual({
        processed: 1,
        deferred: 0,
        failed: 0,
      });

      const lastKey = (
        w.fake.callsTo("subscriptions.update").at(-1)!.args[2] as Stripe.RequestOptions
      ).idempotencyKey!;
      expect(lastKey).toBe(`hd-plan-start:${billing.clinicId}:${request.id}:1:1`);
      expect(failedKeys.has(lastKey)).toBe(false);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "done",
        outcome_reason: "started",
        attempts: 1,
        epoch: 1,
      });
      expect((await entitlementsOf(billing.clinicId)).plan_start_applied_at).not.toBeNull();
    }, 60_000);

    test("a 5xx after Stripe applied the update is read back as done, not retried", async () => {
      const billing = await seedBilling("applied-5xx", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      w.fake.on("subscriptions.update", (...args: unknown[]) => {
        w.handlers["subscriptions.update"]!(...args);
        throw stripeError("connection");
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toMatchObject({
        processed: 1,
      });
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        outcome: "done",
        outcome_reason: "started",
        last_error: null,
      });
      expect((await entitlementsOf(billing.clinicId)).plan_code).toBe("chat-web");
    });

    test("waits grow with each failed attempt, and the tenth dead-letters the request and tells ops", async () => {
      const billing = await seedBilling("dead", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const fake = createStripeFake({
        "subscriptions.retrieve": () => {
          throw stripeError("api", { statusCode: 503 });
        },
      });

      // The third attempt fails: 30 minutes.
      await patchRequest(billing.clinicId, request.id, "attempts = 2");
      await drainBillingRequests({ now: NOW, stripe: fake.stripe });
      const third = await requestOf(billing.clinicId, "plan_start");
      expect(third.attempts).toBe(3);
      expect(third.next_attempt_at.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(30 * MINUTE);
      expect(third.next_attempt_at.getTime() - NOW.getTime()).toBeLessThan(35 * MINUTE);

      // The tenth fails: dead letter.
      await patchRequest(billing.clinicId, request.id, "attempts = 9, next_attempt_at = $2", [
        at(-MINUTE),
      ]);
      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 1,
      });
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        attempts: 10,
        outcome: "dead_letter",
        outcome_reason: "attempts_exhausted",
        last_error: "stripe:api_error",
        lease_until: null,
      });
      expect(await opsAlerts("billing_request_dead_lettered", billing.clinicId)).toEqual([
        expect.objectContaining({ requestId: request.id, kind: "plan_start", attempts: 10 }),
      ]);
      // Finished: never listed again.
      expect(await drainBillingRequests({ now: at(DAY), stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 0,
      });
    });

    test("a claim leases the row for five minutes and holds the mutation lease, both renewed before each Stripe call", async () => {
      const billing = await seedBilling("lease", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      const seen: { method: string; lease: Date | null; attempts: number; owner: string | null }[] =
        [];
      for (const method of ["subscriptions.retrieve", "prices.list", "subscriptions.update"]) {
        w.fake.on(method, async (...args: unknown[]) => {
          const row = await requestOf(billing.clinicId, "plan_start");
          const entitlements = await entitlementsOf(billing.clinicId);
          seen.push({
            method,
            lease: row.lease_until,
            attempts: row.attempts,
            owner: entitlements.stripe_mutation_lease_owner,
          });
          return w.handlers[method]!(...args);
        });
      }

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(seen.map((s) => s.method)).toEqual([
        "subscriptions.retrieve",
        "prices.list",
        "subscriptions.update",
      ]);
      for (const s of seen) {
        expect(s.attempts).toBe(1);
        expect(s.owner).toBe(`billing_request:${request.id}:0:1`);
        const lease = s.lease!.getTime() - NOW.getTime();
        expect(lease).toBeGreaterThanOrEqual(5 * MINUTE);
        expect(lease).toBeLessThan(6 * MINUTE);
      }
      // Each call renewed it: five minutes from the moment of the call.
      expect(seen[1]!.lease!.getTime()).toBeGreaterThan(seen[0]!.lease!.getTime());
      expect(seen[2]!.lease!.getTime()).toBeGreaterThan(seen[1]!.lease!.getTime());
      const row = await entitlementsOf(billing.clinicId);
      expect(row.stripe_mutation_lease_owner).toBeNull();
      expect(row.stripe_mutation_lease_until).toBeNull();
    });

    test("a row another worker holds is not claimed until its lease runs out", async () => {
      const billing = await seedBilling("held", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      await patchRequest(billing.clinicId, request.id, "attempts = 1, lease_until = $2", [
        at(2 * MINUTE),
      ]);
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 0,
      });
      expect(w.fake.calls).toEqual([]);

      // The holder died: three minutes on, the lease has run out.
      expect(await drainBillingRequests({ now: at(3 * MINUTE), stripe: w.stripe })).toMatchObject({
        processed: 1,
      });
      // A new attempt, under a new key.
      expect(
        (w.fake.callsTo("subscriptions.update")[0]!.args[2] as Stripe.RequestOptions)
          .idempotencyKey,
      ).toBe(`hd-plan-start:${billing.clinicId}:${request.id}:0:2`);
    });

    test("an attempt overtaken mid-flight stops before its next Stripe call and writes nothing", async () => {
      const billing = await seedBilling("overtaken", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      w.fake.on("subscriptions.retrieve", async (...args: unknown[]) => {
        // Another worker claimed the row while this one was reading Stripe.
        await patchRequest(
          billing.clinicId,
          request.id,
          "attempts = attempts + 1, lease_until = $2",
          [at(10 * MINUTE)],
        );
        return w.handlers["subscriptions.retrieve"]!(...args);
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 0,
      });
      expect(w.fake.calls.map((call) => call.method)).toEqual(["subscriptions.retrieve"]);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        attempts: 2,
        outcome: null,
        last_error: null,
      });
      // This attempt let go of the mutation lease it held.
      expect((await entitlementsOf(billing.clinicId)).stripe_mutation_lease_owner).toBeNull();
    });

    test("an outcome is fenced on the claimed attempt: overtaken after Stripe applied, it records nothing, and the next attempt records it from Stripe", async () => {
      const billing = await seedBilling("fenced", { channelRows: [inService("web")] });
      const request = await record(billing.clinicId, "plan_start");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      let overtake = true;
      w.fake.on("subscriptions.update", async (...args: unknown[]) => {
        const result = w.handlers["subscriptions.update"]!(...args);
        if (overtake) {
          overtake = false;
          await patchRequest(
            billing.clinicId,
            request.id,
            "attempts = attempts + 1, lease_until = $2",
            [at(10 * MINUTE)],
          );
        }
        return result;
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        attempts: 2,
        outcome: null,
      });
      const before = await entitlementsOf(billing.clinicId);
      expect(before.plan_start_applied_at).toBeNull();
      expect(before.plan_code).toBe("complete");

      // The overtaking attempt died; the next re-reads Stripe and records the start.
      await drainBillingRequests({ now: at(11 * MINUTE), stripe: w.stripe });
      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(1);
      expect(await requestOf(billing.clinicId, "plan_start")).toMatchObject({
        attempts: 3,
        outcome: "done",
        outcome_reason: "already_started",
      });
      const after = await entitlementsOf(billing.clinicId);
      expect(after.plan_start_applied_at).not.toBeNull();
      expect(after.plan_code).toBe("chat-web");
    });

    test("while another holder has the Stripe mutation lease the request waits a minute without spending an attempt (R5)", async () => {
      const billing = await seedBilling("busy", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start");
      await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
        claimStripeMutationLease(tx.db, billing.clinicId, "change_plan:portal", { now: NOW }),
      );
      const fake = createStripeFake();

      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 1,
        failed: 0,
      });
      expect(fake.calls).toEqual([]);
      const row = await requestOf(billing.clinicId, "plan_start");
      expect(row).toMatchObject({ attempts: 0, outcome: null, lease_until: null });
      const wait = row.next_attempt_at.getTime() - NOW.getTime();
      expect(wait).toBeGreaterThanOrEqual(MINUTE);
      expect(wait).toBeLessThan(2 * MINUTE);
      // The other holder's lease is untouched.
      expect((await entitlementsOf(billing.clinicId)).stripe_mutation_lease_owner).toBe(
        "change_plan:portal",
      );
    });

    test("at most one request per billing clinic per batch, a cancellation first", async () => {
      const billing = await seedBilling("one-each", {
        planId: "chat-web",
        boughtPlanId: "complete",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "step_up", { channel: "voice", dueAt: at(-10 * MINUTE) });
      await record(billing.clinicId, "cancel_now");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("chat-web", "month"))],
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toEqual({
        processed: 1,
        deferred: 0,
        failed: 0,
      });
      expect((await requestOf(billing.clinicId, "cancel_now")).outcome).toBe("done");
      expect((await requestOf(billing.clinicId, "step_up", "voice")).attempts).toBe(0);

      // Next batch: a refunded subscription is never priced up.
      await drainBillingRequests({ now: at(MINUTE), stripe: w.stripe });
      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "cancel_pending",
      });
      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(0);
    });
  });

  describe("step-up (BD3, R6, R7)", () => {
    test("waits five minutes for the plan to start, without spending an attempt or calling Stripe", async () => {
      const billing = await seedBilling("step-wait", { channelRows: [inService("web")] });
      await record(billing.clinicId, "step_up", { channel: "voice" });
      const fake = createStripeFake();

      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 1,
        failed: 0,
      });
      expect(fake.calls).toEqual([]);
      const row = await requestOf(billing.clinicId, "step_up", "voice");
      expect(row).toMatchObject({ attempts: 0, outcome: null, lease_until: null });
      const wait = row.next_attempt_at.getTime() - NOW.getTime();
      expect(wait).toBeGreaterThanOrEqual(5 * MINUTE);
      expect(wait).toBeLessThan(6 * MINUTE);
    });

    test("finishes as plan_never_started when the start was skipped", async () => {
      const billing = await seedBilling("step-never", { channelRows: [inService("web")] });
      const start = await record(billing.clinicId, "plan_start");
      await patchRequest(
        billing.clinicId,
        start.id,
        "done_at = $2, outcome = 'skipped', outcome_reason = 'cancel_pending'",
        [at(-MINUTE)],
      );
      await record(billing.clinicId, "step_up", { channel: "voice" });
      const fake = createStripeFake();

      await drainBillingRequests({ now: NOW, stripe: fake.stripe });

      expect(fake.calls).toEqual([]);
      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "plan_never_started",
      });
    });

    test("prices the channel in from what Stripe bills now, never dropping a billed channel, and sends L3", async () => {
      // Bought Complete. Stripe bills Web + Voice (voice joined while waiting,
      // so it is billed but not in service); our row still says Web Chatbot.
      // Meta's first answer: Complete, not Web + Meta, which would drop voice.
      const billing = await seedBilling("step-target", {
        planId: "chat-web",
        boughtPlanId: "complete",
        ...STARTED,
        channelRows: [
          inService("web"),
          inService("meta"),
          { channel: "voice", readyAt: at(-40 * DAY), waitingOn: "forwarding" },
        ],
      });
      const request = await record(billing.clinicId, "step_up", { channel: "meta" });
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [
          item("si_package", packageKey("web-voice", "month")),
          item("si_meter_voice", VOICE_80),
          item("si_meter_chat", CHAT_30),
        ],
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toMatchObject({
        processed: 1,
      });

      const complete = packageKey("complete", "month");
      expect(w.fake.callsTo("subscriptions.update")[0]!.args).toEqual([
        billing.subscriptionId,
        {
          // The package item only: metered items stay at the bought rates.
          items: [{ id: "si_package", price: priceId(complete), quantity: 1 }],
          proration_behavior: "create_prorations",
          payment_behavior: "allow_incomplete",
          off_session: true,
          metadata: { hd_step_up: request.id },
          expand: ["latest_invoice"],
        },
        { ...WORKER_OPTIONS, idempotencyKey: `hd-step-up:${billing.clinicId}:${request.id}:0:1` },
      ]);
      expect(await requestOf(billing.clinicId, "step_up", "meta")).toMatchObject({
        outcome: "done",
        outcome_reason: "stepped_up",
      });
      expect((await entitlementsOf(billing.clinicId)).plan_code).toBe("complete");
      const notices = await noticesOf(billing.clinicId, "price_stepped_up");
      expect(notices).toEqual([
        {
          dedupe_key: `step_up:meta:${priceId(complete)}`,
          payload: {
            channel: "meta",
            planName: "Complete FrontDesk AI",
            amountCents: 119_700,
            interval: "month",
            isInvoicedNow: false,
            hostedInvoiceUrl: null,
            isPaid: false,
          },
        },
      ]);
      expect(() => assertPayloadAllowed(notices[0]!.payload, "price_stepped_up")).not.toThrow();
    });

    test("an annual step-up is invoiced at once, with the invoice's page in L3", async () => {
      const billing = await seedBilling("step-annual", {
        planId: "chat-web",
        boughtPlanId: "web-voice",
        interval: "year",
        locations: 2,
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "step_up", { channel: "voice" });
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("chat-web", "year"), 2)],
        latestInvoice: {
          id: "in_stepup",
          billing_reason: "subscription_update",
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/test_stepup",
        },
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      const params = w.fake.callsTo("subscriptions.update")[0]!
        .args[1] as Stripe.SubscriptionUpdateParams;
      expect(params).toMatchObject({
        items: [{ id: "si_package", price: priceId(packageKey("web-voice", "year")), quantity: 2 }],
        proration_behavior: "always_invoice",
      });
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            planName: "Web + Voice",
            amountCents: 717 * 12 * 100 * 2,
            interval: "year",
            isInvoicedNow: true,
            hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_test/test_stepup",
            isPaid: true,
          }),
        }),
      ]);
    });

    test("an annual step-up whose card declines is applied, and L3 says its invoice is due, not charged", async () => {
      const billing = await seedBilling("step-annual-declined", {
        planId: "chat-web",
        boughtPlanId: "web-voice",
        interval: "year",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "step_up", { channel: "voice" });
      // allow_incomplete: the update applies and its invoice is left open.
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("chat-web", "year"), 1)],
        latestInvoice: {
          id: "in_stepup_open",
          billing_reason: "subscription_update",
          status: "open",
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/test_stepup_open",
        },
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "done",
        outcome_reason: "stepped_up",
      });
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            isInvoicedNow: true,
            hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_test/test_stepup_open",
            isPaid: false,
          }),
        }),
      ]);
    });

    test("a channel the plan start already priced in changes nothing and sends no L3", async () => {
      const billing = await seedBilling("step-none", {
        planId: "chat-web",
        boughtPlanId: "complete",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "step_up", { channel: "voice" });
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("web-voice", "month"))],
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "done",
        outcome_reason: "no_change",
      });
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toEqual([]);
      // Our row follows what Stripe bills.
      expect((await entitlementsOf(billing.clinicId)).plan_code).toBe("web-voice");
    });

    test("an update that went through with its outcome lost finishes as the step-up it was: L3 with its invoice, once (review fix)", async () => {
      const billing = await seedBilling("step-lost", {
        planId: "chat-web",
        boughtPlanId: "web-voice",
        interval: "year",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      const request = await record(billing.clinicId, "step_up", { channel: "voice" });
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("chat-web", "year"))],
      });
      // The update applies and invoices the difference at once; then its
      // answer is lost, and so is the re-read, so the attempt can only fail.
      let isLosing = true;
      let isRereadLost = false;
      w.fake.on("subscriptions.update", (...args: unknown[]) => {
        const result = w.handlers["subscriptions.update"]!(...args);
        if (!isLosing) return result;
        isLosing = false;
        isRereadLost = true;
        w.state.sub.latest_invoice = {
          id: "in_stepup_lost",
          billing_reason: "subscription_update",
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_test/test_lost",
        };
        throw stripeError("connection");
      });
      w.fake.on("subscriptions.retrieve", (...args: unknown[]) => {
        if (isRereadLost) {
          isRereadLost = false;
          throw stripeError("connection");
        }
        return w.handlers["subscriptions.retrieve"]!(...args);
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toMatchObject({
        failed: 1,
      });
      // Charged on Stripe, and nothing recorded here.
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toEqual([]);
      expect((await entitlementsOf(billing.clinicId)).plan_code).toBe("chat-web");

      expect(await drainBillingRequests({ now: at(2 * MINUTE), stripe: w.stripe })).toMatchObject({
        processed: 1,
      });
      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(1);
      expect(w.fake.callsTo("subscriptions.retrieve").at(-1)!.args).toEqual([
        billing.subscriptionId,
        { expand: ["latest_invoice"] },
        WORKER_OPTIONS,
      ]);
      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "done",
        outcome_reason: "stepped_up",
        attempts: 2,
      });
      const webVoice = packageKey("web-voice", "year");
      const notices = await noticesOf(billing.clinicId, "price_stepped_up");
      expect(notices).toEqual([
        {
          dedupe_key: `step_up:voice:${priceId(webVoice)}`,
          payload: {
            channel: "voice",
            planName: "Web + Voice",
            amountCents: 717 * 12 * 100,
            interval: "year",
            isInvoicedNow: true,
            hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_test/test_lost",
            // The recovered path re-reads with the invoice expanded, so it
            // knows the charge went through, as the normal path does.
            isPaid: true,
          },
        },
      ]);
      expect(() => assertPayloadAllowed(notices[0]!.payload, "price_stepped_up")).not.toThrow();
      expect((await entitlementsOf(billing.clinicId)).plan_code).toBe("web-voice");
      const stepUpNotes = async () =>
        (await notesOf(billing.clinicId)).filter((reason) => reason === "step_up");
      expect(await stepUpNotes()).toHaveLength(1);

      // Re-armed later, the marker is still there: no second L3, no second note.
      await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
        rearmBillingRequest(tx, request.id, "reconcile", at(3 * MINUTE)),
      );
      await drainBillingRequests({ now: at(3 * MINUTE), stripe: w.stripe });
      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(1);
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toHaveLength(1);
      expect(await stepUpNotes()).toHaveLength(1);
    });

    test("reads the row under its lock, so a downgrade committing as the lease frees never prices a dropped channel back in (review fix)", async () => {
      // Bought Complete, billed Web Chatbot; voice answers and its step-up is
      // due. The clinic downgrades to Web Chatbot as the worker reads the row
      // (changePlan's lease has run out, as in the plan start's test).
      const billing = await seedBilling("step-locked", {
        planId: "chat-web",
        boughtPlanId: "complete",
        ...STARTED,
        channelRows: [inService("web"), inService("voice")],
      });
      await record(billing.clinicId, "step_up", { channel: "voice" });
      await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
        claimStripeMutationLease(tx.db, billing.clinicId, "change_plan:portal", {
          now: at(-10 * MINUTE),
        }),
      );
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("chat-web", "month"))],
      });

      await commitWhileQueued(
        billing.clinicId,
        `update entitlements
            set bought_plan_id = 'chat-web',
                channels_enabled = '{"web": true, "meta": false, "voice": false}'::jsonb,
                stripe_mutation_lease_owner = null, stripe_mutation_lease_until = null
          where clinic_id = $1`,
        () => drainBillingRequests({ now: NOW, stripe: w.stripe }),
      );

      expect(w.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "step_up", "voice")).toMatchObject({
        outcome: "done",
        outcome_reason: "no_change",
      });
      expect(await noticesOf(billing.clinicId, "price_stepped_up")).toEqual([]);
    }, 60_000);
  });

  describe("setup closure (BD11, R12)", () => {
    async function closable(label: string, rows: SeedChannelRow[] = []) {
      const billing = await seedBilling(label, {
        setupDeadlineAt: at(-DAY),
        channelRows: rows,
      });
      await record(billing.clinicId, "close_setup");
      return billing;
    }

    test("is not even listed while the setup-closure switch is off", async () => {
      const billing = await closable("close-off");
      const fake = createStripeFake();

      expect(await drainBillingRequests({ now: NOW, stripe: fake.stripe })).toEqual({
        processed: 0,
        deferred: 0,
        failed: 0,
      });
      expect(await requestOf(billing.clinicId, "close_setup")).toMatchObject({
        attempts: 0,
        outcome: null,
      });
    });

    test("a live channel anywhere in the group skips it and tells ops, with no Stripe call", async () => {
      await setJob(JOB_SETUP_CLOSURE, true);
      const billing = await closable("close-live");
      await seedLocation(billing, [{ channel: "web", readyAt: at(-2 * DAY), liveAt: at(-DAY) }]);
      const fake = createStripeFake();

      await drainBillingRequests({ now: NOW, stripe: fake.stripe });

      expect(fake.calls).toEqual([]);
      expect(await requestOf(billing.clinicId, "close_setup")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "live_channel",
      });
      expect(await opsAlerts("setup_closure_skipped_live_channel", billing.clinicId)).toHaveLength(
        1,
      );
    });

    test("deletes this subscription's pending items, then cancels with no proration and the closure comment", async () => {
      await setJob(JOB_SETUP_CLOSURE, true);
      const billing = await closable("close", [{ channel: "web", readyAt: at(-2 * DAY) }]);
      const request = await requestOf(billing.clinicId, "close_setup");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        pending: [
          { id: "ii_ours", subscription: billing.subscriptionId },
          { id: "ii_other", subscription: "sub_someone_else" },
        ],
      });

      expect(await drainBillingRequests({ now: NOW, stripe: w.stripe })).toMatchObject({
        processed: 1,
      });

      expect(w.state.deleted).toEqual(["ii_ours"]);
      expect(w.fake.callsTo("invoiceItems.list")[0]!.args[0]).toEqual({
        customer: billing.customerId,
        pending: true,
        limit: 100,
      });
      expect(w.fake.callsTo("subscriptions.cancel")[0]!.args).toEqual([
        billing.subscriptionId,
        {
          prorate: false,
          invoice_now: false,
          cancellation_details: { comment: "hd_setup_closure" },
        },
        {
          ...WORKER_OPTIONS,
          idempotencyKey: `hd-close-setup:${billing.clinicId}:${request.id}:0:1`,
        },
      ]);
      expect(await requestOf(billing.clinicId, "close_setup")).toMatchObject({
        outcome: "done",
        outcome_reason: "closed",
      });
    });

    test("re-checks the channels immediately before the cancel: one gone live meanwhile stops it", async () => {
      await setJob(JOB_SETUP_CLOSURE, true);
      const billing = await closable("close-race", [{ channel: "web", readyAt: at(-2 * DAY) }]);
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });
      w.fake.on("subscriptions.retrieve", async (...args: unknown[]) => {
        // The clinic's website goes live while the worker is reading Stripe.
        await inTenant(billing.clinicId, (c) =>
          c.query(
            `update clinic_channels set live_at = $2 where clinic_id = $1 and channel = 'web'`,
            [billing.clinicId, NOW],
          ),
        );
        return w.handlers["subscriptions.retrieve"]!(...args);
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(w.fake.callsTo("subscriptions.cancel")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "close_setup")).toMatchObject({
        outcome: "skipped",
        outcome_reason: "live_channel",
      });
    });

    test("an already-canceled subscription is done, with no second cancel", async () => {
      await setJob(JOB_SETUP_CLOSURE, true);
      const billing = await closable("close-done");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
        status: "canceled",
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(w.fake.callsTo("subscriptions.cancel")).toHaveLength(0);
      expect(await requestOf(billing.clinicId, "close_setup")).toMatchObject({
        outcome: "done",
        outcome_reason: "already_canceled",
      });
    });
  });

  describe("cancel now (R15)", () => {
    test("retrieves, deletes pending items and cancels with the refund comment and no proration", async () => {
      const billing = await seedBilling("cancel-now", {
        ...STARTED,
        channelRows: [inService("web")],
      });
      const request = await record(billing.clinicId, "cancel_now");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("complete", "month"))],
        pending: [{ id: "ii_proration", subscription: billing.subscriptionId }],
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(w.fake.calls.map((call) => call.method)).toEqual([
        "subscriptions.retrieve",
        "invoiceItems.list",
        "invoiceItems.del",
        "subscriptions.cancel",
      ]);
      expect(w.fake.callsTo("subscriptions.cancel")[0]!.args).toEqual([
        billing.subscriptionId,
        {
          prorate: false,
          invoice_now: false,
          cancellation_details: { comment: "hd_first_period_refund" },
        },
        {
          ...WORKER_OPTIONS,
          idempotencyKey: `hd-cancel-now:${billing.clinicId}:${request.id}:0:1`,
        },
      ]);
      expect(await requestOf(billing.clinicId, "cancel_now")).toMatchObject({
        outcome: "done",
        outcome_reason: "canceled",
      });
    });

    test("a subscription already canceled is left alone: cancel is a DELETE, so the state check is the guard", async () => {
      const billing = await seedBilling("cancel-done", { ...STARTED });
      await record(billing.clinicId, "cancel_now");
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_package", packageKey("complete", "month"))],
        status: "canceled",
      });

      await drainBillingRequests({ now: NOW, stripe: w.stripe });

      expect(w.fake.calls.map((call) => call.method)).toEqual(["subscriptions.retrieve"]);
      expect((await requestOf(billing.clinicId, "cancel_now")).outcome_reason).toBe(
        "already_canceled",
      );
    });
  });

  describe("the job (R17)", () => {
    test("reads its own switch, records every run, and is never blocked by a stale running lock", async () => {
      expect(await runBillingRequestsJob({ now: NOW })).toEqual({ status: "disabled" });

      await setJob(JOB_BILLING_REQUESTS, true);
      await getMigratorPool().query(
        `update scheduled_jobs set running_since = $2 where name = $1`,
        [JOB_BILLING_REQUESTS, at(-MINUTE)],
      );
      // Due long ago, so it is due on any clock the job drains with.
      const billing = await seedBilling("job", { channelRows: [inService("web")] });
      await record(billing.clinicId, "plan_start", { dueAt: new Date("2020-01-01T00:00:00Z") });
      await withTenant({ clinicId: billing.clinicId, actor: ACTOR }, (tx) =>
        closeUnfinishedSetup(tx, billing.clinicId),
      );
      await inTenant(billing.clinicId, (c) =>
        c.query(
          `update billing_requests set next_attempt_at = $2 where clinic_id = $1 and kind = 'close_setup'`,
          [billing.clinicId, new Date("2020-01-01T00:00:00Z")],
        ),
      );
      const w = world({
        customerId: billing.customerId,
        subscriptionId: billing.subscriptionId,
        items: [item("si_hold", PLAN_START_PLACEHOLDER_LOOKUP_KEY)],
      });

      const outcome = await runBillingRequestsJob({ now: NOW, stripe: w.stripe });
      expect(outcome).toEqual({
        status: "ok",
        note: "1 finished, 0 deferred, 0 failed; 1 setup closures held while setup-closure is off.",
      });
      expect((await requestOf(billing.clinicId, "plan_start")).outcome).toBe("done");
      const job = await getJob(JOB_BILLING_REQUESTS);
      expect(job?.lastRunStatus).toBe("ok");
      expect(job?.runningSince).toBeNull();
    });
  });
});
