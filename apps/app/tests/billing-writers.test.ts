import { randomUUID } from "node:crypto";

import { getPlan } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  applyBilledPlan,
  applyBoughtPlan,
  applyPlanChange,
  claimStripeMutationLease,
  effectiveIncluded,
  EntitlementsNotFoundError,
  getEntitlements,
  hasPlanStarted,
  markFirstPeriodRefunded,
  markFirstPlanInvoice,
  markPlanStartApplied,
  markPlanStarted,
  moveOpenInvoice,
  openAllowanceWindow,
  recordFirstInvoice,
  recordInvoicePaid,
  recordOpenInvoice,
  recordSetupFeePaid,
  releaseStripeMutationLease,
  rollAllowancePeriod,
  setCancelAt,
  setLocations,
  setMeteredPriceKeys,
  setOverageMode,
  setSetupDeadline,
  setUsageAlertsEnabled,
} from "@/lib/billing/entitlements";
import {
  closeUnfinishedSetup,
  rearmBillingRequest,
  requestCancelNow,
  startPlan,
  stepUpPackage,
} from "@/lib/billing/requests";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The entitlements writers and the billing-request recorders S0 lays down
 * for packages B, C and D (build spec §3; R2, R5, R8, R9, BD5, BD7, BD31):
 * bought and billed kept apart, the deferred start's one-time stamps, the
 * window opening only from the first plan invoice, the open invoice cleared
 * only by its own payment, the Stripe mutation lease, the allowance a meter
 * counts against, and requests recorded on the billing clinic inside the
 * caller's transaction.
 */

const actor = { type: "service", serviceName: "billing-writers-test" } as const;

function plan(id: string) {
  const found = getPlan(id);
  if (!found) throw new Error(`No package ${id}`);
  return found;
}

function inClinic<T>(clinicId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant({ clinicId, actor }, fn);
}

async function row(clinicId: string) {
  const found = await inClinic(clinicId, (tx) => getEntitlements(tx.db, clinicId));
  if (!found) throw new Error(`No entitlements for ${clinicId}`);
  return found;
}

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("effectiveIncluded (BD5)", () => {
  const base = {
    includedVoiceMinutes: 0,
    includedChatConversations: 1_000,
    boughtPlanId: "web-voice" as string | null,
    locations: 1,
  };

  test("is the billed package's allowance when it has one, times the locations", () => {
    expect(effectiveIncluded(base, "chat_conversations")).toBe(1_000);
    expect(effectiveIncluded({ ...base, locations: 3 }, "chat_conversations")).toBe(3_000);
  });

  test("falls back to the bought package's allowance for a channel bought but not yet billed", () => {
    // Bought Web + Voice, billed as AYA Web Chat: the phone's first call counts
    // against the bought package's 1,000 minutes, never against 0.
    expect(effectiveIncluded(base, "voice_minutes")).toBe(1_000);
    expect(effectiveIncluded({ ...base, locations: 2 }, "voice_minutes")).toBe(2_000);
  });

  test("is 0 on a legacy row or a meter the bought package does not sell", () => {
    expect(effectiveIncluded({ ...base, boughtPlanId: null }, "voice_minutes")).toBe(0);
    expect(effectiveIncluded({ ...base, boughtPlanId: "chat-web" }, "voice_minutes")).toBe(0);
    expect(effectiveIncluded({ ...base, boughtPlanId: "gone-from-catalog" }, "voice_minutes")).toBe(
      0,
    );
  });
});

describe("hasPlanStarted (R8)", () => {
  test("once either the worker's update went through or the first plan invoice was paid", () => {
    const at = new Date("2026-10-10T00:00:00Z");
    expect(hasPlanStarted({ planStartedAt: null, planStartAppliedAt: null })).toBe(false);
    expect(hasPlanStarted({ planStartedAt: null, planStartAppliedAt: at })).toBe(true);
    expect(hasPlanStarted({ planStartedAt: at, planStartAppliedAt: null })).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("billing writers and recorders", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  describe("bought and billed", () => {
    test("billing a smaller package moves the allowances, never the channels a bought row may answer on", async () => {
      const { clinicId } = await seedClinic("billed-new");
      await seedEntitled(clinicId, { planId: "complete" });
      const result = await inClinic(clinicId, (tx) =>
        applyBilledPlan(tx.db, clinicId, plan("chat-web"), "month"),
      );
      expect(result).toEqual({ changed: true });
      expect(await row(clinicId)).toMatchObject({
        planCode: "chat-web",
        boughtPlanId: "complete",
        channelsEnabled: { web: true, meta: true, voice: true },
        includedVoiceMinutes: 0,
        includedChatConversations: 1_000,
      });
      // The same plan again changes nothing and writes nothing.
      const before = (await row(clinicId)).updatedAt;
      expect(
        await inClinic(clinicId, (tx) =>
          applyBilledPlan(tx.db, clinicId, plan("chat-web"), "month"),
        ),
      ).toEqual({ changed: false });
      expect((await row(clinicId)).updatedAt.getTime()).toBe(before.getTime());
    });

    test("on a legacy row the channels still follow the billed package, through either name", async () => {
      const { clinicId } = await seedClinic("billed-legacy");
      await seedEntitled(clinicId, { planId: "complete", legacy: true });
      await inClinic(clinicId, (tx) => applyPlanChange(tx.db, clinicId, plan("web-voice"), "year"));
      expect(await row(clinicId)).toMatchObject({
        planCode: "web-voice",
        billingInterval: "year",
        boughtPlanId: null,
        channelsEnabled: { web: true, meta: false, voice: true },
      });
    });

    test("recording what was bought moves the channels and leaves billing alone", async () => {
      const { clinicId } = await seedClinic("bought");
      await seedEntitled(clinicId, { planId: "chat-web", legacy: true });
      await inClinic(clinicId, (tx) => applyBoughtPlan(tx.db, clinicId, plan("meta-voice")));
      expect(await row(clinicId)).toMatchObject({
        planCode: "chat-web",
        boughtPlanId: "meta-voice",
        channelsEnabled: { web: false, meta: true, voice: true },
      });
    });
  });

  describe("the deferred start", () => {
    test("the first invoice of a bought row records the setup fee and opens no window", async () => {
      const { clinicId } = await seedClinic("first-invoice");
      await seedEntitled(clinicId, { planId: "web-voice", firstInvoice: false });
      const paidAt = new Date("2026-10-02T08:00:00Z");
      await inClinic(clinicId, (tx) =>
        recordFirstInvoice(tx.db, clinicId, {
          periodStart: new Date("2026-10-02T08:00:00Z"),
          periodEnd: new Date("2026-11-02T08:00:00Z"),
          setupFeePaidUsd: 997,
          paidAt,
        }),
      );
      const after = await row(clinicId);
      expect(after.currentPeriodStart).toBeNull();
      expect(after.currentPeriodEnd).toBeNull();
      expect(after.setupFeePaidUsd).toBe("997.00");
      expect(after.firstPaidAt?.toISOString()).toBe(paidAt.toISOString());
    });

    test("the one-time stamps are written once, and say whether this call wrote them", async () => {
      const { clinicId } = await seedClinic("stamps");
      await seedEntitled(clinicId);
      const first = new Date("2026-10-10T00:00:00Z");
      const later = new Date("2026-11-10T00:00:00Z");
      for (const [mark, name] of [
        [markPlanStarted, "planStartedAt"],
        [markPlanStartApplied, "planStartAppliedAt"],
        [markFirstPeriodRefunded, "firstPeriodRefundedAt"],
      ] as const) {
        expect(await inClinic(clinicId, (tx) => mark(tx.db, clinicId, first)), name).toBe(true);
        expect(await inClinic(clinicId, (tx) => mark(tx.db, clinicId, later)), name).toBe(false);
        expect((await row(clinicId))[name]?.toISOString(), name).toBe(first.toISOString());
      }
      expect(
        await inClinic(clinicId, (tx) => markFirstPlanInvoice(tx.db, clinicId, "in_first")),
      ).toBe(true);
      expect(
        await inClinic(clinicId, (tx) => markFirstPlanInvoice(tx.db, clinicId, "in_second")),
      ).toBe(false);
      expect((await row(clinicId)).firstPlanInvoiceId).toBe("in_first");
      expect(hasPlanStarted(await row(clinicId))).toBe(true);

      // A clinic with no row is an error, not "already set".
      const bare = await seedClinic("stamps-bare");
      await expect(
        inClinic(bare.clinicId, (tx) => markPlanStarted(tx.db, bare.clinicId, first)),
      ).rejects.toBeInstanceOf(EntitlementsNotFoundError);
    });

    test("the first window opens from the first plan invoice's period, with the counters from zero", async () => {
      const { clinicId } = await seedClinic("window");
      await seedEntitled(clinicId, { interval: "year" });
      await getMigratorPool().query(
        `update entitlements set used_voice_minutes = 12, used_chat_conversations = 7 where clinic_id = $1`,
        [clinicId],
      );
      const start = new Date("2026-10-10T00:00:00Z");
      const window = await inClinic(clinicId, (tx) =>
        openAllowanceWindow(tx.db, clinicId, { start, end: new Date("2027-10-10T00:00:00Z") }),
      );
      // An annual plan's window is its first month.
      expect(window.end.toISOString()).toBe("2026-11-10T00:00:00.000Z");
      const after = await row(clinicId);
      expect(after.currentPeriodStart?.toISOString()).toBe(start.toISOString());
      expect(after.currentPeriodEnd?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
      expect(after.usedVoiceMinutes).toBe("0.00");
      expect(after.usedChatConversations).toBe(0);
    });

    test("the setup fee's paid date is kept from the first time it is recorded", async () => {
      const { clinicId } = await seedClinic("setup-fee");
      await seedEntitled(clinicId, { firstInvoice: false });
      const first = new Date("2026-10-01T00:00:00Z");
      await inClinic(clinicId, (tx) =>
        recordSetupFeePaid(tx.db, clinicId, { usd: 497, at: first }),
      );
      await inClinic(clinicId, (tx) =>
        recordSetupFeePaid(tx.db, clinicId, { usd: 997, at: new Date("2026-10-05T00:00:00Z") }),
      );
      const after = await row(clinicId);
      expect(after.setupFeePaidUsd).toBe("997.00");
      expect(after.firstPaidAt?.toISOString()).toBe(first.toISOString());
    });
  });

  describe("invoices", () => {
    test("a paid invoice clears the open one only when it is that invoice, and paid-through only moves forward", async () => {
      const { clinicId } = await seedClinic("invoices");
      await seedEntitled(clinicId);
      await inClinic(clinicId, (tx) =>
        recordOpenInvoice(tx.db, clinicId, {
          invoiceId: "in_renewal",
          url: "https://invoice.stripe.com/i/renewal",
          amountDueCents: 89_700,
        }),
      );
      expect(await row(clinicId)).toMatchObject({
        openInvoiceId: "in_renewal",
        openInvoiceUrl: "https://invoice.stripe.com/i/renewal",
        openInvoiceAmountCents: 89_700,
      });

      // A different invoice paid (a proration): the renewal is still owed.
      await inClinic(clinicId, (tx) =>
        recordInvoicePaid(tx.db, clinicId, {
          invoiceId: "in_proration",
          paidThrough: new Date("2026-12-01T00:00:00Z"),
        }),
      );
      expect(await row(clinicId)).toMatchObject({
        lastPaidInvoiceId: "in_proration",
        openInvoiceId: "in_renewal",
        openInvoiceAmountCents: 89_700,
      });

      // The renewal itself, with an earlier period end: cleared, and
      // paid-through is not pulled back.
      await inClinic(clinicId, (tx) =>
        recordInvoicePaid(tx.db, clinicId, {
          invoiceId: "in_renewal",
          paidThrough: new Date("2026-11-01T00:00:00Z"),
        }),
      );
      const after = await row(clinicId);
      expect(after).toMatchObject({
        lastPaidInvoiceId: "in_renewal",
        openInvoiceId: null,
        openInvoiceUrl: null,
        openInvoiceAmountCents: null,
      });
      expect(after.paidThrough?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    });

    test("a second unpaid invoice never replaces the first, and the slot moves only from the invoice it holds (review fix)", async () => {
      const { clinicId } = await seedClinic("invoices-two");
      await seedEntitled(clinicId);
      const renewal = {
        invoiceId: "in_renewal",
        url: "https://invoice.stripe.com/i/renewal",
        amountDueCents: 89_700,
      };
      const overage = {
        invoiceId: "in_overage",
        url: "https://invoice.stripe.com/i/overage",
        amountDueCents: 8_000,
      };
      const record = (invoice: typeof renewal) =>
        inClinic(clinicId, (tx) => recordOpenInvoice(tx.db, clinicId, invoice));
      const move = (from: string | null, to: typeof renewal | null) =>
        inClinic(clinicId, (tx) => moveOpenInvoice(tx.db, clinicId, from, to));

      expect(await record(renewal)).toBe(true);
      expect(await record(overage)).toBe(false);
      // Stripe's retry of the recorded invoice refreshes what it asks for.
      expect(await record({ ...renewal, amountDueCents: 89_000 })).toBe(true);
      expect(await row(clinicId)).toMatchObject({
        openInvoiceId: "in_renewal",
        openInvoiceUrl: renewal.url,
        openInvoiceAmountCents: 89_000,
      });

      expect(await move("in_other", overage)).toBe(false);
      expect(await move(null, overage)).toBe(false);
      expect(await move("in_renewal", overage)).toBe(true);
      expect(await row(clinicId)).toMatchObject({
        openInvoiceId: "in_overage",
        openInvoiceUrl: overage.url,
        openInvoiceAmountCents: 8_000,
      });
      expect(await move("in_overage", null)).toBe(true);
      expect(await row(clinicId)).toMatchObject({
        openInvoiceId: null,
        openInvoiceUrl: null,
        openInvoiceAmountCents: null,
      });
      expect(await move(null, renewal)).toBe(true);
      expect((await row(clinicId)).openInvoiceId).toBe("in_renewal");
    });
  });

  describe("the small writers", () => {
    test("each writes its own column, and refuses what cannot be true", async () => {
      const { clinicId } = await seedClinic("small-writers");
      await seedEntitled(clinicId);
      const cancelAt = new Date("2026-11-01T00:00:00Z");
      const deadline = new Date("2026-11-05T00:00:00Z");
      await inClinic(clinicId, async (tx) => {
        await setMeteredPriceKeys(tx.db, clinicId, [
          "healdesk_meter_voice_minutes_block100_8000",
          "healdesk_meter_chat_conversations_block100_3000",
          "healdesk_meter_voice_minutes_block100_8000",
        ]);
        await setLocations(tx.db, clinicId, 3);
        await setCancelAt(tx.db, clinicId, cancelAt);
        await setSetupDeadline(tx.db, clinicId, deadline);
        await setUsageAlertsEnabled(tx.db, clinicId, false);
        await setOverageMode(tx.db, clinicId, "hard_cap");
      });
      const after = await row(clinicId);
      expect(after).toMatchObject({
        meteredPriceKeys: [
          "healdesk_meter_chat_conversations_block100_3000",
          "healdesk_meter_voice_minutes_block100_8000",
        ],
        locations: 3,
        usageAlertsEnabled: false,
        overageMode: "hard_cap",
      });
      expect(after.cancelAt?.toISOString()).toBe(cancelAt.toISOString());
      expect(after.setupDeadlineAt?.toISOString()).toBe(deadline.toISOString());

      await inClinic(clinicId, (tx) => setCancelAt(tx.db, clinicId, null));
      expect((await row(clinicId)).cancelAt).toBeNull();
      for (const bad of [0, 1.5, -2]) {
        await expect(
          inClinic(clinicId, (tx) => setLocations(tx.db, clinicId, bad)),
        ).rejects.toThrow(RangeError);
      }
      await expect(
        inClinic(clinicId, (tx) => setOverageMode(tx.db, clinicId, "unlimited" as never)),
      ).rejects.toThrow(RangeError);
    });

    test("rolling an annual window holds the row lock until the transaction ends", async () => {
      const { clinicId } = await seedClinic("roll-lock");
      await seedEntitled(clinicId, {
        interval: "year",
        planStartedAt: new Date("2026-08-01T00:00:00Z"),
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const holder = inClinic(clinicId, async (tx) => {
        const roll = await rollAllowancePeriod(tx.db, clinicId, new Date("2026-10-15T00:00:00Z"));
        expect(roll.rolled).toBe(2);
        locked();
        await released;
      });
      await isLocked;
      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
        await expect(
          client.query(`select 1 from entitlements where clinic_id = $1 for update nowait`, [
            clinicId,
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await client.query("rollback").catch(() => {});
        client.release();
        release();
      }
      await holder;
    });
  });

  describe("the Stripe mutation lease (R5)", () => {
    test("one holder at a time; the holder may renew; a lapsed lease is taken over; only the holder releases", async () => {
      const { clinicId } = await seedClinic("lease");
      await seedEntitled(clinicId);
      const now = new Date("2026-10-06T12:00:00Z");
      const claim = (owner: string, at: Date) =>
        inClinic(clinicId, (tx) => claimStripeMutationLease(tx.db, clinicId, owner, { now: at }));

      expect(await claim("billing_request:r1:1", now)).toBe(true);
      expect((await row(clinicId)).stripeMutationLeaseUntil?.toISOString()).toBe(
        "2026-10-06T12:05:00.000Z",
      );
      expect(await claim("change_plan:p1", new Date("2026-10-06T12:01:00Z"))).toBe(false);
      // The holder renews it before its next Stripe call.
      expect(await claim("billing_request:r1:1", new Date("2026-10-06T12:03:00Z"))).toBe(true);
      expect((await row(clinicId)).stripeMutationLeaseUntil?.toISOString()).toBe(
        "2026-10-06T12:08:00.000Z",
      );
      // Its holder died: once it has run out, anyone may take it.
      expect(await claim("change_plan:p1", new Date("2026-10-06T12:09:00Z"))).toBe(true);
      expect(
        await inClinic(clinicId, (tx) =>
          releaseStripeMutationLease(tx.db, clinicId, "billing_request:r1:1"),
        ),
      ).toBe(false);
      expect((await row(clinicId)).stripeMutationLeaseOwner).toBe("change_plan:p1");
      expect(
        await inClinic(clinicId, (tx) =>
          releaseStripeMutationLease(tx.db, clinicId, "change_plan:p1"),
        ),
      ).toBe(true);
      expect(await row(clinicId)).toMatchObject({
        stripeMutationLeaseOwner: null,
        stripeMutationLeaseUntil: null,
      });

      await expect(claim("", now)).rejects.toThrow(RangeError);
      await expect(claim("o".repeat(121), now)).rejects.toThrow(RangeError);
      const bare = await seedClinic("lease-bare");
      await expect(
        inClinic(bare.clinicId, (tx) => claimStripeMutationLease(tx.db, bare.clinicId, "x")),
      ).rejects.toBeInstanceOf(EntitlementsNotFoundError);
    });
  });

  describe("recording billing requests (R2)", () => {
    async function requestsOf(clinicId: string) {
      return inTenant(clinicId, async (c) => {
        const { rows } = await c.query<{
          id: string;
          clinic_id: string;
          kind: string;
          channel_key: string;
          reason: string;
        }>(
          `select id, clinic_id, kind, channel_key, reason from billing_requests where clinic_id = $1 order by kind, channel_key`,
          [clinicId],
        );
        return rows;
      });
    }

    async function seedLocation(billingClinicId: string, organizationId: string) {
      const { rows } = await getMigratorPool().query<{ id: string }>(
        `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
         values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
        [organizationId, `loc-${randomUUID().slice(0, 6)}`, billingClinicId],
      );
      return rows[0]!.id;
    }

    test("a location's transaction records on its billing clinic, once per kind and channel", async () => {
      const billing = await seedClinic("record-billing");
      const location = await seedLocation(billing.clinicId, billing.organizationId);

      expect(await inClinic(location, (tx) => startPlan(tx, location))).toEqual({ recorded: true });
      expect(await inClinic(location, (tx) => startPlan(tx, location, "reconcile"))).toEqual({
        recorded: false,
      });
      expect(
        await inClinic(location, (tx) => stepUpPackage(tx, location, "voice", "first_answer")),
      ).toEqual({ recorded: true });
      expect(
        await inClinic(billing.clinicId, (tx) => closeUnfinishedSetup(tx, billing.clinicId)),
      ).toEqual({ recorded: true });
      expect(
        await inClinic(billing.clinicId, (tx) => requestCancelNow(tx, billing.clinicId)),
      ).toEqual({
        recorded: true,
      });

      const rows = await requestsOf(billing.clinicId);
      expect(rows.map((r) => [r.clinic_id, r.kind, r.channel_key, r.reason])).toEqual([
        [billing.clinicId, "cancel_now", "-", "ops"],
        [billing.clinicId, "close_setup", "-", "deadline"],
        [billing.clinicId, "plan_start", "-", "first_answer"],
        [billing.clinicId, "step_up", "voice", "first_answer"],
      ]);
      expect(await requestsOf(location)).toEqual([]);
    });

    test("the request commits or rolls back with the caller's transaction, and names the caller's own clinic", async () => {
      const { clinicId } = await seedClinic("record-atomic");
      await expect(
        inClinic(clinicId, async (tx) => {
          await startPlan(tx, clinicId);
          throw new Error("the first answer was not recorded after all");
        }),
      ).rejects.toThrow(/not recorded/);
      expect(await requestsOf(clinicId)).toEqual([]);

      const other = await seedClinic("record-other");
      await expect(inClinic(clinicId, (tx) => startPlan(tx, other.clinicId))).rejects.toThrow(
        /own transaction/,
      );
      expect(await requestsOf(other.clinicId)).toEqual([]);
    });

    test("re-arming makes a finished request due again, and leaves one a worker still holds", async () => {
      const { clinicId } = await seedClinic("rearm");
      await inClinic(clinicId, (tx) => startPlan(tx, clinicId));
      await inClinic(clinicId, (tx) => stepUpPackage(tx, clinicId, "web", "first_answer"));
      const [plan_start, step_up] = await requestsOf(clinicId);
      const now = new Date("2026-10-06T12:00:00Z");
      await inTenant(clinicId, async (c) => {
        await c.query(
          `update billing_requests set done_at = $2, outcome = 'skipped', outcome_reason = 'cancel_pending',
                  attempts = 3, last_error = 'stripe:card_declined', lease_until = $2
            where id = $1`,
          [plan_start!.id, now],
        );
        await c.query(`update billing_requests set attempts = 1, lease_until = $2 where id = $1`, [
          step_up!.id,
          new Date(now.getTime() + 2 * 60_000),
        ]);
      });

      expect(
        await inClinic(clinicId, (tx) => rearmBillingRequest(tx, plan_start!.id, "reconcile", now)),
      ).toBe(true);
      expect(
        await inClinic(clinicId, (tx) => rearmBillingRequest(tx, step_up!.id, "ops", now)),
      ).toBe(false);
      // Another clinic's request is out of reach.
      const stranger = await seedClinic("rearm-other");
      expect(
        await inClinic(stranger.clinicId, (tx) =>
          rearmBillingRequest(tx, plan_start!.id, "ops", now),
        ),
      ).toBe(false);

      const rows = await inTenant(clinicId, async (c) => {
        const { rows } = await c.query<{
          id: string;
          done_at: Date | null;
          outcome: string | null;
          outcome_reason: string | null;
          lease_until: Date | null;
          attempts: number;
          epoch: number;
          next_attempt_at: Date;
          reason: string;
          last_error: string | null;
        }>(`select * from billing_requests where clinic_id = $1`, [clinicId]);
        return rows;
      });
      const rearmed = rows.find((r) => r.id === plan_start!.id)!;
      expect(rearmed).toMatchObject({
        done_at: null,
        outcome: null,
        outcome_reason: null,
        lease_until: null,
        attempts: 0,
        // A new epoch (review fix): the restarted attempts never reuse an
        // idempotency key or lease owner from before the re-arm.
        epoch: 1,
        reason: "reconcile",
        last_error: "stripe:card_declined",
      });
      expect(rearmed.next_attempt_at.toISOString()).toBe(now.toISOString());
      expect(rows.find((r) => r.id === step_up!.id)).toMatchObject({
        attempts: 1,
        epoch: 0,
        reason: "first_answer",
      });
    });
  });
});
