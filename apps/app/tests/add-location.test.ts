import { randomUUID } from "node:crypto";

import { channelList, getPlan, type Channel } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getEntitlements } from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { addLocation, resumeLocationSetup } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { previewAddLocation } from "@/lib/billing/summary";
import { retryLocationSetup } from "@/lib/billing/support";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * addLocation (BD13, R14, spec §13) and its resume. createLocationClinic
 * belongs to the funnel session and is still a stub behind
 * LOCATION_CLINICS_READY, so the module is replaced here: the flag is
 * switchable per test, and the function records what it was asked.
 */

const location = vi.hoisted(() => ({
  ready: false,
  calls: [] as Array<{ billingClinicId: string; locationNumber: number; name?: string }>,
  fail: false,
}));

vi.mock("@/lib/location-clinic", () => ({
  get LOCATION_CLINICS_READY() {
    return location.ready;
  },
  createLocationClinic: async (input: {
    billingClinicId: string;
    locationNumber: number;
    name?: string;
  }) => {
    location.calls.push({
      billingClinicId: input.billingClinicId,
      locationNumber: input.locationNumber,
      ...(input.name ? { name: input.name } : {}),
    });
    if (location.fail) throw new Error("provisioning is down");
    return {
      clinicId: "11111111-2222-4333-8444-555555555555",
      slug: `location-${input.locationNumber}`,
    };
  },
}));

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const actor = { type: "service", serviceName: "add-location-test" } as const;
const NOW = new Date("2026-10-10T12:00:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

let world: StripeWorld;

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
      `select kind, dedupe_key, payload from billing_notices where clinic_id = $1 order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

async function seedBilling(label: string, options: { started: boolean; inService?: Channel[] }) {
  const clinic = await seedClinic(label);
  const bought = getPlan("web-voice")!;
  const ids = await seedEntitled(clinic.clinicId, {
    planId: "web-voice",
    boughtPlanId: "web-voice",
    ...(options.started ? { planStartedAt: STARTED, planStartAppliedAt: STARTED } : {}),
    channelRows: channelList(bought).map((channel) => ({
      channel,
      firstAnswerAt: options.inService?.includes(channel) ? STARTED : null,
    })),
  });
  world = createStripeWorld({
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
    items: options.started
      ? [
          { lookupKey: "healdesk_web-voice_month_89700", quantity: 1 },
          ...(expectedMeteredKeys("web-voice", "month") ?? []).map((lookupKey) => ({ lookupKey })),
        ]
      : [{ lookupKey: "healdesk_plan_start_placeholder_month", quantity: 1 }],
    periodStart: s(STARTED),
    periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    customerDefaultPm: "pm_customer",
    nowSeconds: s(NOW),
  });
  __setStripeForTests(world.stripe);
  return { ...clinic, ...ids };
}

describeDb("addLocation", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    location.ready = true;
    location.fail = false;
    location.calls.length = 0;
    notifyOps.mockClear();
    __clearPriceCacheForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("while LOCATION_CLINICS_READY is false it is not available, before anything is written or charged", async () => {
    location.ready = false;
    const clinic = await seedClinic("loc-flag");
    await seedEntitled(clinic.clinicId, { planId: "web-voice", planStartedAt: STARTED });
    const fake = createStripeFake(); // any call at all would fail loudly
    __setStripeForTests(fake.stripe);
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: "loc-1", actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "not_available" });
    expect(await previewAddLocation(clinic.clinicId, { now: NOW })).toMatchObject({
      status: "not_available",
    });
    expect(fake.calls).toHaveLength(0);
    expect(location.calls).toHaveLength(0);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
    });
  });

  test("after the start: one update for quantity n plus the setup fee, then the location's clinic with its number, then location_added", async () => {
    const clinic = await seedBilling("loc-started", { started: true, inService: ["web", "voice"] });
    const packageItem = world.state.subscription.items.data[0]!.id as string;

    const result = await addLocation(
      {
        clinicId: clinic.clinicId,
        requestId: "loc-started-1",
        actorLabel: "owner",
        name: "Uptown",
      },
      { now: NOW },
    );
    expect(result).toEqual({
      status: "added",
      clinicId: "11111111-2222-4333-8444-555555555555",
      slug: "location-2",
    });

    const updates = world.fake.callsTo("subscriptions.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[1]).toEqual({
      items: [{ id: packageItem, quantity: 2 }],
      add_invoice_items: [{ price: "price_healdesk_web-voice_setup_99700" }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      off_session: true,
      metadata: { hd_location: "loc-started-1" },
      expand: ["items.data.price", "latest_invoice"],
    });
    expect(updates[0]!.args[2]).toMatchObject({
      idempotencyKey: `hd-location:${clinic.clinicId}:loc-started-1`,
    });
    expect(location.calls).toEqual([
      { billingClinicId: clinic.clinicId, locationNumber: 2, name: "Uptown" },
    ]);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
      pendingLocationCount: null,
      pendingLocationChargedAt: null,
      stripeMutationLeaseOwner: null,
    });
    const notices = await noticesOf(clinic.clinicId);
    expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
      ["location_added", "location:loc-started-1"],
    ]);
    expect(notices[0]!.payload).toEqual({
      locations: 2,
      recurringCents: 89_700,
      setupFeeCents: 99_700,
      hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
      isBeforeStart: false,
      billedPlanId: "web-voice",
    });
    assertPayloadAllowed(notices[0]!.payload, "location_added");
  });

  test("before the start the setup fee is a draft-first one-off invoice, and nothing recurring changes", async () => {
    const clinic = await seedBilling("loc-pre", { started: false });
    const result = await addLocation(
      { clinicId: clinic.clinicId, requestId: "loc-pre-1", actorLabel: "owner" },
      { now: NOW },
    );
    expect(result).toMatchObject({ status: "added", slug: "location-2" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    const [create] = world.fake.callsTo("invoices.create");
    expect(create!.args[0]).toMatchObject({
      pending_invoice_items_behavior: "exclude",
      auto_advance: false,
      metadata: { hd_kind: "location_setup", hd_ref: "loc-pre-1" },
    });
    expect(create!.args[1]).toMatchObject({
      idempotencyKey: `hd-location:${clinic.clinicId}:loc-pre-1:invoice`,
    });
    const [item] = world.fake.callsTo("invoiceItems.create");
    expect(item!.args[0]).toMatchObject({
      pricing: { price: "price_healdesk_web-voice_setup_99700" },
      quantity: 1,
    });
    expect((await rowOf(clinic.clinicId)).locations).toBe(2);
    const [notice] = await noticesOf(clinic.clinicId);
    expect(notice!.payload).toMatchObject({ isBeforeStart: true, billedPlanId: null });
  });

  test("a decline clears the pending request and charges nothing; the location count stays", async () => {
    const clinic = await seedBilling("loc-decline", { started: true, inService: ["web"] });
    world.state.declineNextUpdate = true;
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: "loc-dec-1", actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "payment_failed" });
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
      stripeMutationLeaseOwner: null,
    });
    expect(location.calls).toHaveLength(0);
    expect(await noticesOf(clinic.clinicId)).toEqual([]);
  });

  test("a clinic that fails to be created after the charge stays pending, ops are told, and the resume finishes it without charging again", async () => {
    const clinic = await seedBilling("loc-pending", { started: true, inService: ["web", "voice"] });
    location.fail = true;
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: "loc-pend-1", actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "pending_setup" });
    expect(notifyOps).toHaveBeenCalledWith("location_charged_not_created", {
      clinicId: clinic.clinicId,
      count: 2,
    });
    const pending = await rowOf(clinic.clinicId);
    expect(pending).toMatchObject({
      locations: 2,
      pendingLocationRequestId: "loc-pend-1",
      pendingLocationCount: 2,
      stripeMutationLeaseOwner: null,
    });
    expect(pending.pendingLocationChargedAt).not.toBeNull();

    // A different request is refused while this one is pending.
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: "loc-pend-2", actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/still being added/) });

    // The same request resumes: no second charge, the same location number.
    location.fail = false;
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: "loc-pend-1", actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "added", slug: "location-2" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect(location.calls.map((call) => call.locationNumber)).toEqual([2, 2]);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
    });
    expect((await noticesOf(clinic.clinicId)).map((n) => n.dedupe_key)).toEqual([
      "location:loc-pend-1",
    ]);
  });

  test("the console's retry finishes a charged location through the same resume", async () => {
    const clinic = await seedBilling("loc-retry", { started: true, inService: ["web"] });
    location.fail = true;
    await addLocation(
      { clinicId: clinic.clinicId, requestId: "loc-retry-1", actorLabel: "owner" },
      { now: NOW },
    );
    location.fail = false;
    expect(
      await retryLocationSetup(
        { clinicId: clinic.clinicId, actorLabel: "ops@healdesk.test" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "added", slug: "location-2" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect(await rowOf(clinic.clinicId)).toMatchObject({ pendingLocationRequestId: null });
  });

  test("the resume asks Stripe about a request with no charge on record: charged means finish, not charged means clear", async () => {
    const charged = await seedBilling("loc-resume-charged", { started: true, inService: ["web"] });
    // As if the attempt died after Stripe charged and before it was recorded.
    world.state.subscription.metadata.hd_location = "loc-lost-1";
    await inTenant(charged.clinicId, (c) =>
      c.query(
        `update entitlements set pending_location_request_id = 'loc-lost-1', pending_location_count = 2 where clinic_id = $1`,
        [charged.clinicId],
      ),
    );
    expect(
      await resumeLocationSetup({ clinicId: charged.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toMatchObject({ status: "added" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    expect(await rowOf(charged.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
    });

    const never = await seedBilling("loc-resume-never", { started: true, inService: ["web"] });
    await inTenant(never.clinicId, (c) =>
      c.query(
        `update entitlements set pending_location_request_id = 'loc-never-1', pending_location_count = 2 where clinic_id = $1`,
        [never.clinicId],
      ),
    );
    expect(
      await resumeLocationSetup({ clinicId: never.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toEqual({ status: "cleared" });
    expect(location.calls.filter((c) => c.billingClinicId === never.clinicId)).toHaveLength(0);
    expect(await rowOf(never.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
    });

    // Before the start: an attempt that died between finalizing its invoice
    // and paying it. Clearing the request voids that invoice; nothing is paid.
    const unpaid = await seedBilling("loc-resume-open", { started: false });
    const open = world.addInvoice({
      status: "open",
      metadata: { hd_kind: "location_setup", hd_ref: "loc-open-1" },
      total: 99_700,
      amount_due: 99_700,
    });
    await inTenant(unpaid.clinicId, (c) =>
      c.query(
        `update entitlements set pending_location_request_id = 'loc-open-1', pending_location_count = 2 where clinic_id = $1`,
        [unpaid.clinicId],
      ),
    );
    expect(
      await resumeLocationSetup({ clinicId: unpaid.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toEqual({ status: "cleared" });
    expect(world.fake.callsTo("invoices.voidInvoice").map((c) => c.args[0])).toEqual([open.id]);
    expect(world.fake.callsTo("invoices.pay")).toHaveLength(0);
  });

  test("the preview prices the setup fee once and Stripe's proration for one more location", async () => {
    const clinic = await seedBilling("loc-preview", { started: true, inService: ["web", "voice"] });
    world.fake.on("invoices.createPreview", () => ({
      lines: {
        data: [{ amount: 59_800, parent: { subscription_item_details: { proration: true } } }],
      },
    }));
    const packageItem = world.state.subscription.items.data[0]!.id;
    expect(await previewAddLocation(clinic.clinicId, { now: NOW })).toEqual({
      status: "ok",
      locations: 2,
      recurringCents: 89_700,
      setupFeeCents: 99_700,
      prorationCents: 59_800,
    });
    expect(world.fake.callsTo("invoices.createPreview")[0]!.args[0]).toMatchObject({
      subscription_details: {
        items: [{ id: packageItem, quantity: 2 }],
        proration_behavior: "always_invoice",
      },
    });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
  });

  test("a location is added to the billing clinic even when asked from a location", async () => {
    const billing = await seedBilling("loc-from-location", { started: true, inService: ["web"] });
    const { getMigratorPool } = await import("./setup/db");
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, 'Second', 'med-spa', $3) returning id`,
      [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
    );
    const result = await addLocation(
      { clinicId: rows[0]!.id, requestId: "loc-via-location", actorLabel: "owner" },
      { now: NOW },
    );
    expect(result).toMatchObject({ status: "added" });
    expect(location.calls).toEqual([{ billingClinicId: billing.clinicId, locationNumber: 2 }]);
  });
});
