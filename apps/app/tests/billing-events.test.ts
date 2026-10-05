import { randomUUID } from "node:crypto";

import { getPlan, plans, stripeLookupKey, type PriceKind } from "@healdesk/catalog";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { parseLookupKey, seedEntitlements } from "@/lib/billing/entitlements";
import {
  GRACE_DAYS,
  handleStripeEvent,
  MAX_FAILURES,
  replayParkedBillingEvents,
} from "@/lib/billing/events";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The Stripe lifecycle, driven by hand-built events. No network: apps/web
 * verifies the signature and this module only ever sees the parsed JSON, so
 * the fixtures are the JSON.
 *
 * Every id in a fixture is letters-only on purpose. The audit guard rejects
 * anything shaped like a phone number, and a Stripe id with a ten-digit run
 * would fail a test at random with a message blaming PHI.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

const chatVoice = getPlan("chat-voice")!;
const complete = getPlan("complete")!;

const DAY = 24 * 60 * 60;

function eventId(): string {
  return `evt_${randomUUID().replace(/-/g, "").replace(/\d/g, "x")}`;
}

/** The narrowest thing that is still a Stripe.Event to the handler. */
function event(type: string, object: Record<string, unknown>, id = eventId()): Stripe.Event {
  return {
    id,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

type Ids = { customer: string; subscription: string };

/** An invoice as the current API version sends it: prices as ids, parents typed. */
function invoice(
  ids: Ids,
  billingReason: string,
  options: { periodStart: number; periodEnd: number; setupCents?: number },
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const lines: Record<string, unknown>[] = [
    {
      id: "il_recurring",
      amount: chatVoice.monthlyUsd * 100,
      period: { start: options.periodStart, end: options.periodEnd },
      parent: { type: "subscription_item_details" },
      pricing: { type: "price_details", price_details: { price: "price_recurring" } },
    },
  ];
  if (options.setupCents !== undefined) {
    lines.push({
      id: "il_setup",
      amount: options.setupCents,
      period: { start: now, end: now },
      parent: { type: "invoice_item_details" },
      pricing: { type: "price_details", price_details: { price: "price_setup" } },
    });
  }
  return {
    id: "in_fixture",
    object: "invoice",
    customer: ids.customer,
    billing_reason: billingReason,
    period_start: now,
    period_end: now,
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: ids.subscription,
        metadata: { app: "healdesk" },
      },
    },
    lines: { object: "list", data: lines },
  };
}

function subscription(
  ids: Ids,
  options: {
    lookupKey: string;
    cancelAtPeriodEnd?: boolean;
    /** What the Dashboard/portal pause actually looks like on the wire. */
    pauseCollection?: boolean;
    status?: string;
  },
): Record<string, unknown> {
  return {
    id: ids.subscription,
    object: "subscription",
    customer: ids.customer,
    status: options.status ?? "active",
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    pause_collection: options.pauseCollection
      ? { behavior: "void", resumes_at: null }
      : null,
    metadata: { app: "healdesk" },
    items: {
      object: "list",
      data: [
        {
          id: "si_metered",
          price: {
            id: "price_meter",
            lookup_key: "healdesk_meter_voice_minutes_80",
            recurring: { usage_type: "metered" },
          },
        },
        {
          id: "si_package",
          price: {
            id: "price_package",
            lookup_key: options.lookupKey,
            recurring: { usage_type: "licensed" },
          },
        },
      ],
    },
  };
}

describe("parseLookupKey", () => {
  test("round-trips stripeLookupKey for every plan and kind", () => {
    const kinds: PriceKind[] = ["month", "year", "setup"];
    for (const plan of plans) {
      for (const kind of kinds) {
        const key = stripeLookupKey(plan, kind);
        expect(parseLookupKey(key), key).toEqual({
          planId: plan.id,
          kind,
          cents:
            kind === "setup"
              ? plan.setupFeeUsd * 100
              : kind === "year"
                ? plan.annualMonthlyUsd * 12 * 100
                : plan.monthlyUsd * 100,
        });
      }
    }
  });

  test("returns null for anything that is not a package price", () => {
    expect(parseLookupKey("healdesk_meter_voice_minutes")).toBeNull();
    expect(parseLookupKey("healdesk_meter_voice_minutes_80")).toBeNull();
    expect(parseLookupKey("healdesk_meter_chat_conversations_30")).toBeNull();
    expect(parseLookupKey("scalabid_pro_month_9900")).toBeNull();
    expect(parseLookupKey("healdesk_chat-voice_weekly_100")).toBeNull();
    expect(parseLookupKey("")).toBeNull();
  });
});

describeDb("handleStripeEvent", () => {
  let clinicId: string;
  const ids: Ids = { customer: "cus_evtclinic", subscription: "sub_evtclinic" };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    clinicId = (await seedClinic("evt")).clinicId;
    await withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, clinicId, {
        plan: chatVoice,
        interval: "month",
        chatChannelChoice: "web",
        stripeCustomerId: ids.customer,
        stripeSubscriptionId: ids.subscription,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  async function row(): Promise<{
    status: string;
    plan_code: string;
    billing_interval: string;
    current_period_start: Date | null;
    current_period_end: Date | null;
    grace_ends_at: Date | null;
    channels_enabled: { web: boolean; meta: boolean; voice: boolean };
    included_voice_minutes: number;
    included_chat_conversations: number;
    used_voice_minutes: string;
    used_chat_conversations: number;
    setup_fee_paid_usd: string;
  }> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query(`select * from entitlements where clinic_id = $1`, [clinicId]),
    );
    return rows[0] as never;
  }

  async function transitionsFor(stripeEventId: string): Promise<number> {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ count: string }>(
        `select count(*)::text as count from billing_transitions where stripe_event_id = $1`,
        [stripeEventId],
      ),
    );
    return Number(rows[0]!.count);
  }

  async function ledger(stripeEventId: string): Promise<{
    outcome: string | null;
    failures: number;
    resolved_clinic_id: string | null;
    error: string | null;
  }> {
    const { rows } = await getMigratorPool().query(
      `select outcome, failures, resolved_clinic_id, error
         from billing_events where stripe_event_id = $1`,
      [stripeEventId],
    );
    return rows[0]!;
  }

  test("(b) the first invoice activates the clinic and records the setup fee", async () => {
    const start = Math.floor(Date.now() / 1000);
    const end = start + 30 * DAY;
    const e = event(
      "invoice.paid",
      invoice(ids, "subscription_create", {
        periodStart: start,
        periodEnd: end,
        setupCents: chatVoice.setupFeeUsd * 100,
      }),
    );

    const result = await handleStripeEvent(e);
    expect(result).toEqual({ outcome: "processed", duplicate: false, clinicId });

    const r = await row();
    expect(r.status).toBe("active");
    expect(r.setup_fee_paid_usd).toBe("997.00");
    // From the recurring LINE, not the invoice's own period, which on a first
    // invoice is the moment of creation.
    expect(r.current_period_start?.getTime()).toBe(start * 1000);
    expect(r.current_period_end?.getTime()).toBe(end * 1000);

    expect(await ledger(e.id)).toMatchObject({
      outcome: "processed",
      failures: 0,
      resolved_clinic_id: clinicId,
    });

    // (a) The same event id again does no work and says so.
    const again = await handleStripeEvent(e);
    expect(again).toEqual({ outcome: "processed", duplicate: true, clinicId });
    expect(await transitionsFor(e.id)).toBe(1);
  });

  test("(c) a failed payment moves active → past_due and opens a 7-day grace window", async () => {
    const e = event(
      "invoice.payment_failed",
      invoice(ids, "subscription_cycle", {
        periodStart: Math.floor(Date.now() / 1000),
        periodEnd: Math.floor(Date.now() / 1000) + 30 * DAY,
      }),
    );
    const before = Date.now();
    await handleStripeEvent(e);

    const r = await row();
    expect(r.status).toBe("past_due");
    const grace = r.grace_ends_at!.getTime();
    expect(grace).toBeGreaterThanOrEqual(before + GRACE_DAYS * DAY * 1000 - 60_000);
    expect(grace).toBeLessThanOrEqual(Date.now() + GRACE_DAYS * DAY * 1000 + 60_000);

    // A second failure (Stripe's retry) is idempotent: still past_due, and the
    // window does not move.
    const retry = event("invoice.payment_failed", invoice(ids, "subscription_cycle", {
      periodStart: 0,
      periodEnd: 1,
    }));
    await handleStripeEvent(retry);
    expect((await row()).status).toBe("past_due");
    expect((await row()).grace_ends_at!.getTime()).toBe(grace);
    // No status change → no transition row for the retry.
    expect(await transitionsFor(retry.id)).toBe(0);
  });

  test("(d) a paid renewal resets usage, clears grace and returns to active", async () => {
    // Some usage during the period, written the way the meters will.
    await inTenant(clinicId, (client) =>
      client.query(
        `update entitlements
            set used_voice_minutes = 812.50, used_chat_conversations = 1_337
          where clinic_id = $1`,
        [clinicId],
      ),
    );

    const start = Math.floor(Date.now() / 1000) + 30 * DAY;
    const end = start + 31 * DAY;
    const e = event(
      "invoice.paid",
      invoice(ids, "subscription_cycle", { periodStart: start, periodEnd: end }),
    );
    await handleStripeEvent(e);

    const r = await row();
    expect(r.status).toBe("active");
    expect(Number(r.used_voice_minutes)).toBe(0);
    expect(r.used_chat_conversations).toBe(0);
    expect(r.grace_ends_at).toBeNull();
    expect(r.current_period_start?.getTime()).toBe(start * 1000);
    expect(r.current_period_end?.getTime()).toBe(end * 1000);
    // The setup fee is not touched by a renewal.
    expect(r.setup_fee_paid_usd).toBe("997.00");
  });

  test("(e) a subscription update onto an annual price changes interval and allowances", async () => {
    const e = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year") }),
    );
    await handleStripeEvent(e);

    const r = await row();
    expect(r.plan_code).toBe("complete");
    expect(r.billing_interval).toBe("year");
    // The FULL new allowance — owner policy, no proration of minutes.
    expect(r.included_voice_minutes).toBe(complete.includedVoiceMinutes);
    expect(r.included_chat_conversations).toBe(complete.includedChatConversations);
    expect(r.channels_enabled).toEqual({ web: true, meta: true, voice: true });
    // Recorded as a plan change in the history, status untouched.
    expect(await transitionsFor(e.id)).toBe(1);
    expect(r.status).toBe("active");
  });

  test("cancel_at_period_end moves to canceling, and clearing it reverses", async () => {
    const cancel = event(
      "customer.subscription.updated",
      subscription(ids, {
        lookupKey: stripeLookupKey(complete, "year"),
        cancelAtPeriodEnd: true,
      }),
    );
    await handleStripeEvent(cancel);
    expect((await row()).status).toBe("canceling");

    const reverse = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year") }),
    );
    await handleStripeEvent(reverse);
    expect((await row()).status).toBe("active");
  });

  test("pause_collection on a subscription update pauses, and clearing it resumes", async () => {
    // Stripe never sends customer.subscription.paused without a trial; the
    // pause a person can cause is this field on an ordinary update, with the
    // subscription's own status unchanged.
    const pause = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year"), pauseCollection: true }),
    );
    await handleStripeEvent(pause);
    expect((await row()).status).toBe("paused");
    expect(await transitionsFor(pause.id)).toBe(1);

    // Delivered again: already paused, nothing to do, no second row.
    const again = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year"), pauseCollection: true }),
    );
    await handleStripeEvent(again);
    expect(await transitionsFor(again.id)).toBe(0);

    const resume = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year") }),
    );
    await handleStripeEvent(resume);
    expect((await row()).status).toBe("active");

    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ actor: string; reason: string }>(
        `select actor, reason from billing_transitions where stripe_event_id in ($1, $2) order by created_at`,
        [pause.id, resume.id],
      ),
    );
    expect(rows).toEqual([
      { actor: "client", reason: "pause_collection" },
      { actor: "client", reason: "pause_collection_cleared" },
    ]);
  });

  test("a subscription Stripe has given up on (status unpaid) is suspended", async () => {
    const e = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: stripeLookupKey(complete, "year"), status: "unpaid" }),
    );
    await handleStripeEvent(e);
    expect((await row()).status).toBe("suspended");

    // A renewal paid afterwards (the card was updated) lifts it.
    const s = Math.floor(Date.now() / 1000);
    await handleStripeEvent(
      event("invoice.paid", invoice(ids, "subscription_cycle", { periodStart: s, periodEnd: s + 30 * DAY })),
    );
    expect((await row()).status).toBe("active");
  });

  test("a chargeback suspends; a paid renewal lifts it; deletion cancels", async () => {
    await handleStripeEvent(
      event("charge.dispute.created", {
        id: "dp_fixture",
        object: "dispute",
        // Expanded by apps/web before forwarding; the id alone names no customer.
        charge: { id: "ch_fixture", customer: ids.customer, metadata: {} },
        payment_intent: null,
      }),
    );
    expect((await row()).status).toBe("suspended");

    const s = Math.floor(Date.now() / 1000);
    await handleStripeEvent(
      event("invoice.paid", invoice(ids, "subscription_cycle", { periodStart: s, periodEnd: s + 30 * DAY })),
    );
    expect((await row()).status).toBe("active");

    await handleStripeEvent(
      event("customer.subscription.deleted", { ...subscription(ids, { lookupKey: "" }), status: "canceled" }),
    );
    expect((await row()).status).toBe("canceled");
    // The end of the subscription is the start of offboarding: the BAA's
    // return-or-destroy clock is stamped on the clinic, not remembered.
    const { rows: offboarding } = await inTenant(clinicId, (client) =>
      client.query<{ offboarding_started_at: Date | null; destroy_after: Date | null }>(
        `select offboarding_started_at, destroy_after from clinics where id = $1`,
        [clinicId],
      ),
    );
    expect(offboarding[0]!.offboarding_started_at).not.toBeNull();
    expect(offboarding[0]!.destroy_after).not.toBeNull();
  });

  test("payment_action_required writes a note without moving the status", async () => {
    const e = event(
      "invoice.payment_action_required",
      invoice(ids, "subscription_cycle", { periodStart: 0, periodEnd: 1 }),
    );
    const statusBefore = (await row()).status;
    await handleStripeEvent(e);
    expect((await row()).status).toBe(statusBefore);

    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ from_status: string; to_status: string; reason: string }>(
        `select from_status, to_status, reason from billing_transitions where stripe_event_id = $1`,
        [e.id],
      ),
    );
    expect(rows).toEqual([
      { from_status: statusBefore, to_status: statusBefore, reason: "authentication_required" },
    ]);
  });

  test("an event type outside the lifecycle is recorded and ignored", async () => {
    const e = event("customer.updated", { id: ids.customer, object: "customer" });
    expect(await handleStripeEvent(e)).toEqual({
      outcome: "ignored",
      duplicate: false,
      clinicId: null,
    });
    expect(await ledger(e.id)).toMatchObject({ outcome: "ignored" });
  });

  test("somebody else's subscription on the shared account is ignored, not failed", async () => {
    const e = event(
      "invoice.paid",
      {
        ...invoice({ customer: "cus_scalabid", subscription: "sub_scalabid" }, "subscription_cycle", {
          periodStart: 0,
          periodEnd: 1,
        }),
        parent: { type: "subscription_details", subscription_details: { subscription: "sub_scalabid", metadata: { app: "scalabid" } } },
      },
    );
    expect(await handleStripeEvent(e)).toMatchObject({ outcome: "ignored", clinicId: null });
    expect(await ledger(e.id)).toMatchObject({ outcome: "ignored", failures: 0 });
  });

  test("our marker with no clinic yet fails, retries, and dead-letters at MAX_FAILURES", async () => {
    // An invoice.paid that beat checkout.session.completed to the endpoint.
    const e = event(
      "invoice.paid",
      invoice({ customer: "cus_notyet", subscription: "sub_notyet" }, "subscription_create", {
        periodStart: 0,
        periodEnd: 1,
        setupCents: 99_700,
      }),
    );

    for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
      await expect(handleStripeEvent(e)).rejects.toMatchObject({
        name: "UnresolvedClinicError",
      });
      expect(await ledger(e.id)).toMatchObject({ outcome: "failed", failures: attempt });
    }

    // The last attempt does not throw: 200 to Stripe, parked for a person.
    expect(await handleStripeEvent(e)).toEqual({
      outcome: "dead_letter",
      duplicate: false,
      clinicId: null,
    });
    expect(await ledger(e.id)).toMatchObject({
      outcome: "dead_letter",
      failures: MAX_FAILURES,
      error: expect.stringContaining("UnresolvedClinicError"),
    });

    // And once parked, a further delivery is a duplicate, not a fourth attempt.
    expect(await handleStripeEvent(e)).toEqual({
      outcome: "dead_letter",
      duplicate: true,
      clinicId: null,
    });
    expect((await ledger(e.id)).failures).toBe(MAX_FAILURES);
  });

  test("provisioning the clinic afterwards replays the parked first invoice", async () => {
    // The dead-lettered invoice above names cus_notyet / sub_notyet. Once a
    // clinic with those ids exists, provisioning calls this with them, and
    // the parked event is applied: the clinic activates and the ledger row
    // is re-marked processed rather than left as a dead letter for a person.
    const notYet = (await seedClinic("notyet")).clinicId;
    await withTenant({ clinicId: notYet, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, notYet, {
        plan: chatVoice,
        interval: "month",
        stripeCustomerId: "cus_notyet",
        stripeSubscriptionId: "sub_notyet",
      }),
    );

    // Ids that match nothing parked: a no-op, not an error.
    expect(await replayParkedBillingEvents({ customerId: "cus_nobody" })).toEqual({
      replayed: 0,
      processed: 0,
    });

    expect(await replayParkedBillingEvents({ subscriptionId: "sub_notyet" })).toEqual({
      replayed: 1,
      processed: 1,
    });

    const { rows } = await inTenant(notYet, (client) =>
      client.query<{ status: string; setup_fee_paid_usd: string }>(
        `select status, setup_fee_paid_usd from entitlements where clinic_id = $1`,
        [notYet],
      ),
    );
    expect(rows[0]).toEqual({ status: "active", setup_fee_paid_usd: "997.00" });

    const parked = await getMigratorPool().query<{ outcome: string; failures: number; resolved_clinic_id: string }>(
      `select outcome, failures, resolved_clinic_id from billing_events
        where outcome in ('failed', 'dead_letter') and resolved_clinic_id is null`,
    );
    expect(parked.rows).toHaveLength(0);

    // And a second replay finds nothing parked for these ids.
    expect(await replayParkedBillingEvents({ subscriptionId: "sub_notyet" })).toEqual({
      replayed: 0,
      processed: 0,
    });
  });

  test("late events on a canceled clinic are recorded without moving it", async () => {
    // The first clinic is canceled (above). A pause that arrives late has
    // nothing to pause; a dispute on the last charge — the common late
    // dispute — has no service to withhold. Neither may throw and
    // dead-letter: the status stays, and the dispute is still in the history.
    const pause = event(
      "customer.subscription.updated",
      subscription(ids, { lookupKey: "", pauseCollection: true }),
    );
    expect(await handleStripeEvent(pause)).toMatchObject({ outcome: "processed" });
    expect((await row()).status).toBe("canceled");
    expect(await transitionsFor(pause.id)).toBe(0);

    const dispute = event("charge.dispute.created", {
      id: "dp_late",
      object: "dispute",
      charge: { id: "ch_late", customer: ids.customer, metadata: {} },
      payment_intent: null,
    });
    expect(await handleStripeEvent(dispute)).toMatchObject({ outcome: "processed" });
    expect((await row()).status).toBe("canceled");

    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ from_status: string; to_status: string; reason: string }>(
        `select from_status, to_status, reason from billing_transitions where stripe_event_id = $1`,
        [dispute.id],
      ),
    );
    expect(rows).toEqual([{ from_status: "canceled", to_status: "canceled", reason: "dispute" }]);
  });
});

describeDb("the setup fee on an invoice whose prices arrive expanded", () => {
  let clinicId: string;
  const ids: Ids = { customer: "cus_expandedfee", subscription: "sub_expandedfee" };

  beforeAll(async () => {
    await runMigrations();
    clinicId = (await seedClinic("expandedfee")).clinicId;
    await withTenant({ clinicId, actor: { type: "system" } }, (tx) =>
      seedEntitlements(tx.db, clinicId, {
        plan: chatVoice,
        interval: "month",
        chatChannelChoice: "web",
        stripeCustomerId: ids.customer,
        stripeSubscriptionId: ids.subscription,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("a setup line carrying its lookup key is recorded at its amount, not $0", async () => {
    // The legacy line shape an older endpoint API version sends: `line.price`
    // is the full Price object, lookup key included. The setup key ends in the
    // amount (healdesk_chat-voice_setup_99700), so it has to be parsed — a
    // suffix test for "_setup" never matched and recorded $0.
    const start = Math.floor(Date.now() / 1000);
    const end = start + 30 * DAY;
    const e = event("invoice.paid", {
      id: "in_expandedfee",
      object: "invoice",
      customer: ids.customer,
      billing_reason: "subscription_create",
      period_start: start,
      period_end: start,
      subscription: ids.subscription,
      subscription_details: { metadata: { app: "healdesk" } },
      lines: {
        object: "list",
        data: [
          {
            id: "il_pkg",
            amount: chatVoice.monthlyUsd * 100,
            period: { start, end },
            type: "subscription",
            price: {
              id: "price_pkg",
              lookup_key: stripeLookupKey(chatVoice, "month"),
              recurring: { usage_type: "licensed" },
            },
          },
          {
            id: "il_fee",
            amount: chatVoice.setupFeeUsd * 100,
            period: { start, end: start },
            type: "invoiceitem",
            price: { id: "price_fee", lookup_key: stripeLookupKey(chatVoice, "setup"), recurring: null },
          },
        ],
      },
    });

    expect(await handleStripeEvent(e)).toMatchObject({ outcome: "processed", clinicId });
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ status: string; setup_fee_paid_usd: string; current_period_end: Date }>(
        `select status, setup_fee_paid_usd, current_period_end from entitlements where clinic_id = $1`,
        [clinicId],
      ),
    );
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.setup_fee_paid_usd).toBe("997.00");
    expect(rows[0]!.current_period_end.getTime()).toBe(end * 1000);
  });
});
