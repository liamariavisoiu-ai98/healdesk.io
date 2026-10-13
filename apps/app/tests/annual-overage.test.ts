import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { invoiceAnnualOverage, runAnnualOverageJob } from "@/lib/billing/annual-overage";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { retryOverageInvoice } from "@/lib/billing/support";
import { assertPayloadAllowed } from "@/lib/email/lint";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { everyParam, createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * Overage on annual plans (BD20, R13a, R17): each closed allowance month is
 * claimed in the ledger, then charged on its own draft-first invoice at the
 * BOUGHT package's rates, in started blocks of 100 on the month's total per
 * meter (6 October 2026); a crash resumes the same invoice by hd_ref, a
 * failure is retried on the next run, zero units are recorded as skipped,
 * and a declined card leaves the invoice owed, not voided.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-09-10T05:00:00Z");
const STARTED = new Date("2026-07-07T00:00:00Z");
const W1 = new Date("2026-07-07T00:00:00Z");
const W2 = new Date("2026-08-07T00:00:00Z");
const OPEN = new Date("2026-09-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

let world: StripeWorld;

async function insertUsage(
  clinicId: string,
  usage: {
    meter: "voice_minutes" | "chat_conversations";
    overAllowance: number;
    windowStart: Date;
    reported?: boolean;
  },
) {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into usage_events
         (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at,
          window_start, included, used_before, over_allowance, stripe_reported_at)
       values ($1, $1, $2, $3, $4, $5, $6, $6, 1000, 1000, $7, $8)`,
      [
        clinicId,
        usage.meter,
        usage.meter === "voice_minutes" ? "voice_call" : "web_chat",
        `ref-${randomUUID()}`,
        Math.max(usage.overAllowance, 1),
        usage.windowStart,
        usage.overAllowance,
        usage.reported ? NOW : null,
      ],
    ),
  );
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
      stripe_invoice_id: string | null;
      error: string | null;
    }>(
      `select window_start, window_end, status, voice_units, chat_units, voice_rate_cents,
              chat_rate_cents, amount_cents, stripe_invoice_id, error
         from overage_invoices where clinic_id = $1 order by window_start`,
      [clinicId],
    );
    return rows;
  });
}

async function noticesOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      kind: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>(
      `select kind, dedupe_key, payload from billing_notices where clinic_id = $1 order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

/** An annual Voice + Web Chat clinic two allowance months into its year, with W1 and W2 closed. */
async function seedAnnual(label: string) {
  const clinic = await seedClinic(label);
  const ids = await seedEntitled(clinic.clinicId, {
    planId: "voice-webchat-1000-1000",
    interval: "year",
    planStartedAt: STARTED,
  });
  await inTenant(clinic.clinicId, (c) =>
    c.query(
      `update entitlements set current_period_start = $2, current_period_end = $3 where clinic_id = $1`,
      [clinic.clinicId, OPEN, new Date("2026-10-07T00:00:00Z")],
    ),
  );
  world = createStripeWorld({
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
    items: [{ lookupKey: "healdesk_voice-webchat-1000-1000_year_1152000" }],
    periodStart: s(STARTED),
    periodEnd: s(new Date("2027-07-07T00:00:00Z")),
    customerDefaultPm: "pm_customer",
    nowSeconds: s(NOW),
  });
  __setStripeForTests(world.stripe);
  return { clinicId: clinic.clinicId, customerId: ids.stripeCustomerId! };
}

describeDb("annual overage", () => {
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

  test("a closed month is claimed, charged draft-first in started blocks of 100 at the bought rates, and overage_invoiced enqueued; zero units are recorded as skipped", async () => {
    const clinic = await seedAnnual("overage-basic");
    // Two calls over the allowance: blocks count the month's total, 200
    // minutes, which is exactly two blocks (never a block per call).
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 120,
      windowStart: W1,
    });
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 80,
      windowStart: W1,
    });
    // 101 conversations start a second block.
    await insertUsage(clinic.clinicId, {
      meter: "chat_conversations",
      overAllowance: 101,
      windowStart: W1,
    });
    // Already reported to a meter (a monthly plan before): never billed twice.
    // Counted, it would have started a third voice block.
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 7,
      windowStart: W1,
      reported: true,
    });
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 0,
      windowStart: W2,
    });
    // The open month is not invoiced yet.
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 3,
      windowStart: OPEN,
    });

    const summary = await invoiceAnnualOverage({ now: NOW });
    expect(summary).toEqual({ clinics: 1, invoiced: 1, skipped: 1, failed: 0 });

    const w1Iso = W1.toISOString();
    const prefix = `hd-annual-overage:${clinic.clinicId}:${w1Iso}`;
    const [create] = world.fake.callsTo("invoices.create");
    expect(create!.args[0]).toEqual({
      customer: clinic.customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      default_payment_method: "pm_customer",
      description: "Usage over your allowance, 2026-07-07 to 2026-08-07",
      metadata: { hd_kind: "annual_overage", hd_ref: `${clinic.clinicId}:${w1Iso}` },
    });
    expect(create!.args[1]).toMatchObject({ idempotencyKey: `${prefix}:invoice` });
    // One item per meter: the blocks as the quantity, at the price of one block
    // ($104 for voice, $52 for chat on Voice + Web Chat), never units at the unit rate.
    const items = world.fake.callsTo("invoiceItems.create");
    expect(items.map((call) => call.args[0])).toEqual([
      expect.objectContaining({
        price_data: { currency: "usd", product: "prod_meter_voice_minutes", unit_amount: 10_400 },
        quantity: 2,
        description: "Voice minutes over allowance, 2026-07-07 to 2026-08-07: 2 blocks of 100",
      }),
      expect.objectContaining({
        price_data: {
          currency: "usd",
          product: "prod_meter_chat_conversations",
          unit_amount: 5_200,
        },
        quantity: 2,
        description: "Chat conversations over allowance, 2026-07-07 to 2026-08-07: 2 blocks of 100",
      }),
    ]);
    expect(
      items.map((call) => (call.args[1] as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([`${prefix}:item:1`, `${prefix}:item:2`]);
    expect(everyParam(world.fake)).not.toContain('"pending_invoice_items_behavior":"include"');

    // 2 × $104 + 2 × $52. Per unit it would have been 200 × $1.04 + 101 × $0.52.
    const ledger = await ledgerOf(clinic.clinicId);
    expect(ledger).toEqual([
      expect.objectContaining({
        window_start: W1,
        window_end: W2,
        status: "invoiced",
        voice_units: 200,
        chat_units: 101,
        voice_rate_cents: 10_400,
        chat_rate_cents: 5_200,
        amount_cents: 31_200,
        stripe_invoice_id: world.state.invoices[0]!.id,
      }),
      expect.objectContaining({ window_start: W2, status: "skipped", amount_cents: 0 }),
    ]);
    const notices = await noticesOf(clinic.clinicId);
    expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([["overage_invoiced", w1Iso]]);
    expect(notices[0]!.payload).toEqual({
      amountCents: 31_200,
      windowStart: w1Iso,
      windowEnd: W2.toISOString(),
      voiceMinutes: 200,
      chatConversationsCount: 101,
      voiceBlocksCount: 2,
      chatBlocksCount: 2,
      voiceBlockRateCents: 10_400,
      chatBlockRateCents: 5_200,
      hostedInvoiceUrl: `https://invoice.stripe.com/i/${world.state.invoices[0]!.id}`,
      isPaid: true,
    });
    assertPayloadAllowed(notices[0]!.payload, "overage_invoiced");

    // The next run finds both months done and asks Stripe for nothing new.
    const calls = world.fake.calls.length;
    expect(await invoiceAnnualOverage({ now: NOW })).toEqual({
      clinics: 0,
      invoiced: 0,
      skipped: 0,
      failed: 0,
    });
    expect(world.fake.calls.length).toBe(calls);
  });

  test("a run that died after the draft resumes that invoice by hd_ref, adding only the items it lacks", async () => {
    const clinic = await seedAnnual("overage-resume");
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 4,
      windowStart: W1,
    });
    await insertUsage(clinic.clinicId, {
      meter: "chat_conversations",
      overAllowance: 2,
      windowStart: W1,
    });
    const hdRef = `${clinic.clinicId}:${W1.toISOString()}`;
    // The voice item the first run added: 4 minutes over is one block of $104.
    const draft = world.addInvoice({
      status: "draft",
      metadata: { hd_kind: "annual_overage", hd_ref: hdRef },
      total: 10_400,
      amount_due: 10_400,
      lines: {
        has_more: false,
        data: [
          {
            id: "il_earlier",
            amount: 10_400,
            metadata: { hd_kind: "annual_overage", hd_ref: hdRef, hd_item: "1" },
          },
        ],
      },
    });

    expect(await invoiceAnnualOverage({ now: NOW })).toMatchObject({ invoiced: 1 });
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    const items = world.fake.callsTo("invoiceItems.create");
    expect(items).toHaveLength(1);
    expect(items[0]!.args[0]).toMatchObject({
      invoice: draft.id,
      price_data: { unit_amount: 5_200 },
      quantity: 1,
      metadata: { hd_item: "2" },
    });
    expect(world.fake.callsTo("invoices.pay")[0]!.args[0]).toBe(draft.id);
    expect((await ledgerOf(clinic.clinicId))[0]).toMatchObject({
      status: "invoiced",
      stripe_invoice_id: draft.id,
    });
  });

  test("a failure is recorded with a closed code, ops are told, and the next run retries it", async () => {
    const clinic = await seedAnnual("overage-failed");
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 2,
      windowStart: W1,
    });
    world.state.failNextInvoiceCreate = true;

    expect(await invoiceAnnualOverage({ now: NOW })).toMatchObject({ failed: 1, invoiced: 0 });
    expect((await ledgerOf(clinic.clinicId))[0]).toMatchObject({
      status: "failed",
      error: "api_error:500",
    });
    expect(notifyOps).toHaveBeenCalledWith("overage_invoice_failed", {
      clinicId: clinic.clinicId,
      windowStart: W1.toISOString(),
    });

    expect(await invoiceAnnualOverage({ now: NOW })).toMatchObject({ failed: 0, invoiced: 1 });
    expect((await ledgerOf(clinic.clinicId))[0]).toMatchObject({ status: "invoiced", error: null });
    expect(world.fake.callsTo("invoices.create")).toHaveLength(2);
    expect((await noticesOf(clinic.clinicId)).map((n) => n.kind)).toEqual(["overage_invoiced"]);
  });

  test("a declined card leaves the invoice open for dunning, never voided", async () => {
    const clinic = await seedAnnual("overage-declined");
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 2,
      windowStart: W1,
    });
    world.state.declineNextPay = true;
    expect(await invoiceAnnualOverage({ now: NOW })).toMatchObject({ invoiced: 1 });
    expect(world.fake.callsTo("invoices.voidInvoice")).toHaveLength(0);
    expect(world.state.invoices[0]!.status).toBe("open");
    expect((await ledgerOf(clinic.clinicId))[0]).toMatchObject({ status: "invoiced" });
    // Not charged, so the email must not say it was: it says the invoice is due.
    const [notice] = await noticesOf(clinic.clinicId);
    expect(notice!.payload).toMatchObject({ isPaid: false });
  });

  test("an invoice voided by hand in Stripe is respected: the month is skipped, never invoiced again", async () => {
    const clinic = await seedAnnual("overage-voided");
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 2,
      windowStart: W1,
    });
    const voided = world.addInvoice({
      status: "void",
      metadata: { hd_kind: "annual_overage", hd_ref: `${clinic.clinicId}:${W1.toISOString()}` },
    });
    expect(await invoiceAnnualOverage({ now: NOW })).toMatchObject({ skipped: 1, invoiced: 0 });
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    expect((await ledgerOf(clinic.clinicId))[0]).toMatchObject({
      status: "skipped",
      stripe_invoice_id: voided.id,
      error: "invoice_voided",
    });
    expect(await noticesOf(clinic.clinicId)).toEqual([]);
  });

  test("the console's retry invoices a failed month now; anything done is refused", async () => {
    const clinic = await seedAnnual("overage-retry");
    await insertUsage(clinic.clinicId, {
      meter: "chat_conversations",
      overAllowance: 3,
      windowStart: W1,
    });
    world.state.failNextInvoiceCreate = true;
    await invoiceAnnualOverage({ now: NOW });

    const retried = await retryOverageInvoice(
      { clinicId: clinic.clinicId, windowStart: W1.toISOString(), actorLabel: "ops@healdesk.test" },
      { now: NOW },
    );
    // Three conversations over is one started block: $52 on Voice + Web Chat.
    expect(retried).toEqual({
      status: "invoiced",
      amountCents: 5_200,
      hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
    });
    expect(
      await retryOverageInvoice(
        {
          clinicId: clinic.clinicId,
          windowStart: W1.toISOString(),
          actorLabel: "ops@healdesk.test",
        },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/already invoiced/) });
    expect(
      await retryOverageInvoice(
        { clinicId: clinic.clinicId, windowStart: "not a date", actorLabel: "ops@healdesk.test" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused" });
  });

  test("a cancelled subscription is not invoiced for the month it was cancelled in, however long after", async () => {
    // A cancellation at once (a termination of the agreement, or a
    // first-period refund) leaves the subscription's open month open for
    // good: no renewal re-anchors the allowance window, so the month in
    // which the Services ended never closes, and its overage is never
    // invoiced, as cancel_now sends no final invoice on a monthly plan.
    const clinic = await seedAnnual("overage-cancelled");
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update entitlements set status = 'canceled' where clinic_id = $1`, [clinic.clinicId]),
    );
    await insertUsage(clinic.clinicId, {
      meter: "voice_minutes",
      overAllowance: 40,
      windowStart: OPEN,
    });

    const later = new Date(OPEN.getTime() + 75 * 24 * 60 * 60 * 1000);
    expect(await invoiceAnnualOverage({ now: later })).toEqual({
      clinics: 0,
      invoiced: 0,
      skipped: 0,
      failed: 0,
    });
    expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
    expect(await ledgerOf(clinic.clinicId)).toEqual([]);
  });

  test("the job runs behind its switch", async () => {
    expect(await runAnnualOverageJob({ now: NOW })).toEqual({ status: "disabled" });
  });
});
