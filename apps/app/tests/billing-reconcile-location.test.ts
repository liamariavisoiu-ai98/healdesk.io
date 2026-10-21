import { getPlan, recurringUsd } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { claimStripeMutationLease } from "@/lib/billing/entitlements";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeededClinic } from "./setup/factories";
import { stripeError } from "./setup/stripe-fake";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * The reconcile's resume of an extra location that was charged but never
 * created (build spec R14 and §13), with the funnel's createLocationClinic
 * standing in as ready: it is called with the location number, the pending
 * marker is cleared and `location_added` queued once; a failure leaves the
 * location pending and tells ops once; nothing runs while another holder has
 * the billing clinic's Stripe mutation lease.
 *
 * And its settling of one left pending with no charge on record (review
 * fix): Stripe's evidence decides, so a charged location is finished, one
 * never charged is cleared for the clinic to add again, and one that cannot
 * be settled is told to ops once.
 *
 * Its own file, because the switch is a module's (lib/locations.ts) and only
 * a module mock can turn it on.
 */

const location = vi.hoisted(() => ({
  create: vi.fn(async (input: { billingClinicId: string; locationNumber: number }) => ({
    clinicId: input.billingClinicId,
    slug: `location-${input.locationNumber}`,
  })),
}));

vi.mock("@/lib/locations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/locations")>()),
  locationsReady: () => true,
  anyLocationsReady: () => true,
}));

vi.mock("@/lib/location-clinic", () => ({
  createLocationClinic: location.create,
}));

vi.setConfig({ testTimeout: 30_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

let world: StripeWorld;

type Pending = {
  pending_location_request_id: string | null;
  pending_location_count: number | null;
  pending_location_charged_at: Date | null;
  stripe_mutation_lease_owner: string | null;
};

async function pendingOf(clinicId: string): Promise<Pending> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<Pending>(
      `select pending_location_request_id, pending_location_count, pending_location_charged_at,
              stripe_mutation_lease_owner
         from entitlements where clinic_id = $1`,
      [clinicId],
    );
    return rows[0]!;
  });
}

async function noticesOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices where clinic_id = $1 and kind = 'location_added'`,
      [clinicId],
    );
    return rows;
  });
}

/** Started, billed as Voice + Web Chat, a second location requested and (by default) charged. */
async function seedPending(label: string, charged = true): Promise<SeededClinic> {
  const clinic = await seedClinic(label);
  await seedEntitled(clinic.clinicId, {
    planId: "voice-webchat-1000-1000",
    boughtPlanId: "voice-metachat-1000-1000",
    planStartAppliedAt: at(-10 * 24 * HOUR),
    locations: 2,
  });
  await inTenant(clinic.clinicId, (c) =>
    c.query(
      `update entitlements set pending_location_request_id = 'locreq_2', pending_location_count = 2,
              pending_location_charged_at = $2 where clinic_id = $1`,
      [clinic.clinicId, charged ? at(-HOUR) : null],
    ),
  );
  return clinic;
}

describeDb("the reconcile's extra-location resume (R14), with createLocationClinic ready", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  afterAll(closePools);
  beforeEach(async () => {
    await truncateAll();
    location.create.mockClear();
  });
  afterEach(() => {
    __setStripeForTests(null);
  });

  test("creates the location by its number, clears the marker and queues location_added once", async () => {
    const billing = await seedPending("resume");

    expect(await reconcileBilling(NOW)).toMatchObject({ locationsResumed: 1, locationsHeld: 0 });

    expect(location.create).toHaveBeenCalledTimes(1);
    expect(location.create).toHaveBeenCalledWith({
      billingClinicId: billing.clinicId,
      locationNumber: 2,
      actor: { type: "service", serviceName: "billing-reconcile" },
    });
    expect(await pendingOf(billing.clinicId)).toEqual({
      pending_location_request_id: null,
      pending_location_count: null,
      pending_location_charged_at: null,
      stripe_mutation_lease_owner: null,
    });
    const notices = await noticesOf(billing.clinicId);
    expect(notices).toEqual([
      {
        dedupe_key: "location:locreq_2",
        payload: {
          locations: 2,
          recurringCents: Math.round(recurringUsd(getPlan("voice-webchat-1000-1000")!, "month") * 100),
          setupFeeCents: 139_400,
          hostedInvoiceUrl: null,
          isBeforeStart: false,
          billedPlanId: "voice-webchat-1000-1000",
        },
      },
    ]);
    expect(() => assertPayloadAllowed(notices[0]!.payload, "location_added")).not.toThrow();

    // Nothing pending any more: the next run does nothing.
    await reconcileBilling(at(HOUR));
    expect(location.create).toHaveBeenCalledTimes(1);
  });

  test("a failed creation leaves the location pending, frees the lease and tells ops once", async () => {
    const billing = await seedPending("resume-fail");
    location.create
      .mockRejectedValueOnce(new Error("provisioning is down"))
      .mockRejectedValueOnce(new Error("provisioning is down"));

    expect(await reconcileBilling(NOW)).toMatchObject({ locationsResumed: 0, locationsHeld: 1 });
    await reconcileBilling(at(HOUR));

    expect(location.create).toHaveBeenCalledTimes(2);
    expect(await pendingOf(billing.clinicId)).toMatchObject({
      pending_location_request_id: "locreq_2",
      stripe_mutation_lease_owner: null,
    });
    expect(await noticesOf(billing.clinicId)).toEqual([]);
    const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'location_charged_not_created' and fields->>'clinicId' = $1`,
      [billing.clinicId],
    );
    expect(rows.map((r) => r.fields)).toEqual([
      expect.objectContaining({ requestId: "locreq_2", count: 2 }),
    ]);
  });

  test("waits while another holder has the Stripe mutation lease, charged or not", async () => {
    const busy = await seedPending("resume-busy");
    const busyUncharged = await seedPending("resume-busy-uncharged", false);
    // Leased the way the resume itself leases, on the later of `now` and the
    // real clock, so the holder's five minutes are still running when the
    // reconcile looks, whatever the date this test runs on.
    for (const clinic of [busy, busyUncharged]) {
      await withTenant({ clinicId: clinic.clinicId, actor: { type: "system" } }, (tx) =>
        claimStripeMutationLease(tx.db, clinic.clinicId, "add_location:portal", {
          now: new Date(Math.max(NOW.getTime(), Date.now())),
        }),
      );
    }
    // A Stripe that answers, so the assertion below is that nothing asked it.
    world = createStripeWorld({
      customerId: "cus_unused",
      subscriptionId: "sub_unused",
      items: [],
      periodStart: 0,
      periodEnd: 1,
    });
    __setStripeForTests(world.stripe);

    await reconcileBilling(NOW);

    expect(location.create).not.toHaveBeenCalled();
    expect(world.fake.calls).toEqual([]);
    for (const clinic of [busy, busyUncharged]) {
      expect(await pendingOf(clinic.clinicId)).toMatchObject({
        pending_location_request_id: "locreq_2",
        stripe_mutation_lease_owner: "add_location:portal",
      });
    }
  });

  describe("a location pending with no charge on record (review fix)", () => {
    /** Started on Voice + Web Chat, a second location requested, its charge's answer never recorded. */
    async function seedUncharged(label: string): Promise<SeededClinic> {
      const clinic = await seedClinic(label);
      const ids = await seedEntitled(clinic.clinicId, {
        planId: "voice-webchat-1000-1000",
        boughtPlanId: "voice-metachat-1000-1000",
        planStartAppliedAt: at(-10 * 24 * HOUR),
      });
      await inTenant(clinic.clinicId, (c) =>
        c.query(
          `update entitlements set pending_location_request_id = 'locreq_2', pending_location_count = 2
            where clinic_id = $1`,
          [clinic.clinicId],
        ),
      );
      world = createStripeWorld({
        customerId: ids.stripeCustomerId!,
        subscriptionId: ids.stripeSubscriptionId!,
        items: [{ lookupKey: "healdesk_voice-webchat-1000-1000_month_120000", quantity: 1 }],
        periodStart: Math.floor(at(-10 * 24 * HOUR).getTime() / 1000),
        periodEnd: Math.floor(at(20 * 24 * HOUR).getTime() / 1000),
        customerDefaultPm: "pm_customer",
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      });
      __setStripeForTests(world.stripe);
      return clinic;
    }

    async function locationAlerts(clinicId: string) {
      const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
        `select fields from ops_alerts where event = 'location_charged_not_created' and fields->>'clinicId' = $1`,
        [clinicId],
      );
      return rows.map((r) => r.fields);
    }

    test("charged on Stripe: the location is finished, and nothing is charged again", async () => {
      const billing = await seedUncharged("settle-charged");
      // The update went through (quantity 2, the setup fee, our marker), and
      // its answer was lost before the charge was recorded.
      const packageItem = world.state.subscription.items.data[0]!;
      packageItem.quantity = 2;
      world.state.subscription.metadata.hd_location = "locreq_2";

      expect(await reconcileBilling(NOW)).toMatchObject({ locationsResumed: 1, locationsHeld: 0 });

      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(world.fake.callsTo("invoices.create")).toHaveLength(0);
      expect(location.create).toHaveBeenCalledTimes(1);
      expect(location.create).toHaveBeenCalledWith({
        billingClinicId: billing.clinicId,
        locationNumber: 2,
        actor: { type: "service", serviceName: "billing-reconcile" },
      });
      expect(await pendingOf(billing.clinicId)).toEqual({
        pending_location_request_id: null,
        pending_location_count: null,
        pending_location_charged_at: null,
        stripe_mutation_lease_owner: null,
      });
      const { rows } = await inTenant(billing.clinicId, (c) =>
        c.query<{ locations: number }>(`select locations from entitlements where clinic_id = $1`, [
          billing.clinicId,
        ]),
      );
      expect(rows[0]!.locations).toBe(2);
      expect((await noticesOf(billing.clinicId)).map((n) => n.dedupe_key)).toEqual([
        "location:locreq_2",
      ]);
      expect(await locationAlerts(billing.clinicId)).toEqual([]);
    });

    test("never charged: the request is cleared and the attempt's open invoice voided, so the clinic can add it again", async () => {
      const billing = await seedUncharged("settle-never");
      const open = world.addInvoice({
        status: "open",
        metadata: { hd_kind: "location_setup", hd_ref: "locreq_2" },
        total: 139_400,
        amount_due: 139_400,
      });

      expect(await reconcileBilling(NOW)).toMatchObject({
        locationsResumed: 0,
        locationsHeld: 0,
        locationsCleared: 1,
      });

      expect(world.fake.callsTo("invoices.voidInvoice").map((call) => call.args[0])).toEqual([
        open.id,
      ]);
      expect(world.fake.callsTo("invoices.pay")).toHaveLength(0);
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(location.create).not.toHaveBeenCalled();
      expect(await pendingOf(billing.clinicId)).toMatchObject({
        pending_location_request_id: null,
        stripe_mutation_lease_owner: null,
      });
      expect(await noticesOf(billing.clinicId)).toEqual([]);
      expect(await locationAlerts(billing.clinicId)).toEqual([]);
    });

    test("one Stripe cannot answer about stays pending and is told to ops once", async () => {
      const billing = await seedUncharged("settle-unanswered");
      world.fake.on("subscriptions.retrieve", () => {
        throw stripeError("api", { statusCode: 503 });
      });

      expect(await reconcileBilling(NOW)).toMatchObject({ locationsResumed: 0, locationsHeld: 1 });
      await reconcileBilling(at(HOUR));

      expect(location.create).not.toHaveBeenCalled();
      expect(await pendingOf(billing.clinicId)).toMatchObject({
        pending_location_request_id: "locreq_2",
        pending_location_charged_at: null,
        stripe_mutation_lease_owner: null,
      });
      expect(await locationAlerts(billing.clinicId)).toEqual([
        expect.objectContaining({ requestId: "locreq_2", count: 2 }),
      ]);
    });
  });
});
