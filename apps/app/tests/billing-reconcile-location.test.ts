import { getPlan, recurringUsd } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { claimStripeMutationLease } from "@/lib/billing/entitlements";
import { reconcileBilling } from "@/lib/billing/reconcile";
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

/**
 * The reconcile's resume of an extra location that was charged but never
 * created (build spec R14 and §13), with the funnel's createLocationClinic
 * standing in as ready: it is called with the location number, the pending
 * marker is cleared and `location_added` queued once; a failure leaves the
 * location pending and tells ops once; nothing runs while another holder has
 * the billing clinic's Stripe mutation lease, or before the charge.
 *
 * Its own file, because the flag is a module constant and only a module mock
 * can turn it on.
 */

const location = vi.hoisted(() => ({
  create: vi.fn(async (input: { billingClinicId: string; locationNumber: number }) => ({
    clinicId: input.billingClinicId,
    slug: `location-${input.locationNumber}`,
  })),
}));

vi.mock("@/lib/location-clinic", () => ({
  LOCATION_CLINICS_READY: true,
  createLocationClinic: location.create,
}));

vi.setConfig({ testTimeout: 30_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

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

/** Started, billed as Web + Voice, a second location requested and (by default) charged. */
async function seedPending(label: string, charged = true): Promise<SeededClinic> {
  const clinic = await seedClinic(label);
  await seedEntitled(clinic.clinicId, {
    planId: "web-voice",
    boughtPlanId: "complete",
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
          recurringCents: Math.round(recurringUsd(getPlan("web-voice")!, "month") * 100),
          setupFeeCents: 99_700,
          hostedInvoiceUrl: null,
          isBeforeStart: false,
          billedPlanId: "web-voice",
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

  test("waits while another holder has the Stripe mutation lease, and never resumes a location not yet charged", async () => {
    const busy = await seedPending("resume-busy");
    // Leased the way the resume itself leases, on the later of `now` and the
    // real clock, so the holder's five minutes are still running when the
    // reconcile looks, whatever the date this test runs on.
    await withTenant({ clinicId: busy.clinicId, actor: { type: "system" } }, (tx) =>
      claimStripeMutationLease(tx.db, busy.clinicId, "add_location:portal", {
        now: new Date(Math.max(NOW.getTime(), Date.now())),
      }),
    );
    const uncharged = await seedPending("resume-uncharged", false);

    await reconcileBilling(NOW);

    expect(location.create).not.toHaveBeenCalled();
    expect((await pendingOf(busy.clinicId)).pending_location_request_id).toBe("locreq_2");
    expect((await pendingOf(uncharged.clinicId)).pending_location_request_id).toBe("locreq_2");
  });
});
