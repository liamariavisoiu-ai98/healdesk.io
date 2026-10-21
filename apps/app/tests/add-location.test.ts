import { createHash, randomBytes, randomUUID } from "node:crypto";

import { channelList, getPlan, type Channel } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getEntitlements } from "@/lib/billing/entitlements";
import { expectedMeteredKeys } from "@/lib/billing/metered-items";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { addLocation, resumeLocationSetup } from "@/lib/billing/stripe-actions";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { checkPlanChange, previewAddLocation } from "@/lib/billing/summary";
import { retryLocationSetup } from "@/lib/billing/support";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { writePendingLocation } from "@/lib/location-add";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * addLocation (BD13, R14, spec §13) and its resume, on the owner's central
 * model of 20 October 2026: a further location is a row of the account's own
 * clinic_locations (drizzle/0108), written pending with the practice's
 * acceptance of one central AYA before the charge, made active by
 * app_activate_location() after it, and retired when the add is cleared
 * without one (lib/location-add.ts).
 *
 * locationsReady is false for every package and the acknowledgement 1.0.0 is
 * not released, so both are switchable here; activation can be made to fail,
 * to stand for a database that is down after the charge.
 */

const location = vi.hoisted(() => ({ ready: false, released: true, fail: false }));

vi.mock("@/lib/locations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/locations")>()),
  locationsReady: () => location.ready,
  anyLocationsReady: () => location.ready,
}));

vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentCentralAssistantAcknowledgement: () => ({
      ...actual.currentCentralAssistantAcknowledgement(),
      released: location.released,
    }),
  };
});

vi.mock("@/lib/location-add", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/location-add")>();
  return {
    ...actual,
    activatePendingLocation: async (...args: Parameters<typeof actual.activatePendingLocation>) => {
      if (location.fail) throw new Error("the database is down");
      return actual.activatePendingLocation(...args);
    },
  };
});

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
  const bought = getPlan("voice-webchat-1000-1000")!;
  const ids = await seedEntitled(clinic.clinicId, {
    planId: "voice-webchat-1000-1000",
    boughtPlanId: "voice-webchat-1000-1000",
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
          { lookupKey: "healdesk_voice-webchat-1000-1000_month_120000", quantity: 1 },
          ...(expectedMeteredKeys("voice-webchat-1000-1000", "month") ?? []).map((lookupKey) => ({ lookupKey })),
        ]
      : [{ lookupKey: "healdesk_plan_start_placeholder_month", quantity: 1 }],
    periodStart: s(STARTED),
    periodEnd: s(new Date("2026-11-07T00:00:00Z")),
    customerDefaultPm: "pm_customer",
    nowSeconds: s(NOW),
  });
  __setStripeForTests(world.stripe);
  await bindAgreementInEffect(clinic.clinicId);
  return { ...clinic, ...ids };
}

type Billing = Awaited<ReturnType<typeof seedBilling>>;

/** A passkey and a live step-up on it for the clinic's staff user, as the portal leaves them. */
async function seedStepUp(userId: string, device = "Front desk Mac") {
  const pool = getMigratorPool();
  const { rows: factor } = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', $2, $3, '\\x01', 0, true) returning id`,
    [userId, device, randomBytes(16).toString("base64url")],
  );
  const { rows: stepUp } = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, $4, now(), now()) returning id`,
    [createHash("sha256").update(randomBytes(24)).digest(), userId, factor[0]!.id, device],
  );
  return { stepUpId: stepUp[0]!.id, passkeyId: factor[0]!.id, deviceLabel: device };
}

/** What the portal sends for a new add: the location and the ticked acknowledgement. */
async function added(clinic: Billing, name = "Uptown") {
  return {
    location: { name, address: "12 Main St, Springfield" },
    acceptance: {
      userId: clinic.staffUserId,
      acceptedByLabel: "Laura Owner, owner",
      stepUp: await seedStepUp(clinic.staffUserId),
      accepted: true,
    },
  };
}

async function locationsOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      position: number;
      status: string;
      label: string | null;
      address: string | null;
      add_request_id: string | null;
      acknowledgement_id: string | null;
      activated_at: Date | null;
    }>(
      `select position, status, label, address, add_request_id, acknowledgement_id, activated_at
         from clinic_locations where clinic_id = $1 order by position`,
      [clinicId],
    );
    return rows;
  });
}

async function acknowledgementsOf(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ document_version: string; rendered_text: string }>(
      `select document_version, rendered_text from location_acknowledgements where clinic_id = $1`,
      [clinicId],
    );
    return rows;
  });
}

/** A pending add with its location row, as addLocation's first transaction leaves it. */
async function seedPendingAdd(clinic: Billing, requestId: string) {
  const extra = await added(clinic, "Pending place");
  await withTenant(
    { clinicId: clinic.clinicId, actor: { type: "user", userId: clinic.staffUserId, label: "x" } },
    async (tx) => {
      const written = await writePendingLocation(tx, {
        requestId,
        boughtPlan: getPlan("voice-webchat-1000-1000")!,
        ...extra,
      });
      if (!written.ok) throw new Error(written.message);
    },
  );
  await inTenant(clinic.clinicId, (c) =>
    c.query(
      `update entitlements set pending_location_request_id = $2, pending_location_count = 2 where clinic_id = $1`,
      [clinic.clinicId, requestId],
    ),
  );
}

describeDb("addLocation", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    location.ready = true;
    location.released = true;
    location.fail = false;
    notifyOps.mockClear();
    __clearPriceCacheForTests();
  });

  afterEach(() => {
    __setStripeForTests(null);
  });

  afterAll(async () => {
    await closePools();
  });

  test("while locationsReady is false it is not available, before anything is written or charged", async () => {
    location.ready = false;
    const clinic = await seedClinic("loc-flag");
    await seedEntitled(clinic.clinicId, { planId: "voice-webchat-1000-1000", planStartedAt: STARTED });
    const fake = createStripeFake(); // any call at all would fail loudly
    __setStripeForTests(fake.stripe);
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: randomUUID(), actorLabel: "owner" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "not_available" });
    expect(await previewAddLocation(clinic.clinicId, { now: NOW })).toMatchObject({
      status: "not_available",
    });
    expect(fake.calls).toHaveLength(0);
    expect(await locationsOf(clinic.clinicId)).toHaveLength(1);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
    });
  });

  test("after the start: the acceptance and a pending location before one update for quantity n plus the setup fee, then the location active, then location_added", async () => {
    const clinic = await seedBilling("loc-started", { started: true, inService: ["web", "voice"] });
    const packageItem = world.state.subscription.items.data[0]!.id as string;
    const requestId = randomUUID();

    const result = await addLocation(
      { clinicId: clinic.clinicId, requestId, actorLabel: "owner", ...(await added(clinic)) },
      { now: NOW },
    );
    expect(result).toEqual({ status: "added", locationId: expect.any(String) });

    const updates = world.fake.callsTo("subscriptions.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[1]).toEqual({
      items: [{ id: packageItem, quantity: 2 }],
      add_invoice_items: [{ price: "price_healdesk_voice-webchat_setup_95600" }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      off_session: true,
      metadata: { hd_location: requestId },
      expand: ["items.data.price", "latest_invoice"],
    });
    expect(updates[0]!.args[2]).toMatchObject({
      idempotencyKey: `hd-location:${clinic.clinicId}:${requestId}`,
    });
    const rows = await locationsOf(clinic.clinicId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      position: 2,
      status: "active",
      label: "Uptown",
      address: "12 Main St, Springfield",
      add_request_id: requestId,
    });
    expect(rows[1]!.activated_at).not.toBeNull();
    // The acceptance is the server's render, for a package with phone, naming
    // the practice, the location and its address.
    const [ack] = await acknowledgementsOf(clinic.clinicId);
    expect(ack!.document_version).toBe("central-assistant-acknowledgement/1.0.0");
    expect(ack!.rendered_text).toContain("CENTRAL ASSISTANT ACKNOWLEDGEMENT");
    expect(ack!.rendered_text.replace(/\s+/g, " ")).toContain("12 Main St, Springfield");
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
      pendingLocationCount: null,
      pendingLocationChargedAt: null,
      stripeMutationLeaseOwner: null,
    });
    const notices = await noticesOf(clinic.clinicId);
    expect(notices.map((n) => [n.kind, n.dedupe_key])).toEqual([
      ["location_added", `location:${requestId}`],
    ]);
    expect(notices[0]!.payload).toEqual({
      locations: 2,
      recurringCents: 120_000,
      setupFeeCents: 95_600,
      hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
      isBeforeStart: false,
      billedPlanId: "voice-webchat-1000-1000",
    });
    assertPayloadAllowed(notices[0]!.payload, "location_added");
  });

  test("before the start the setup fee is a draft-first one-off invoice, and nothing recurring changes", async () => {
    const clinic = await seedBilling("loc-pre", { started: false });
    const requestId = randomUUID();
    const result = await addLocation(
      { clinicId: clinic.clinicId, requestId, actorLabel: "owner", ...(await added(clinic)) },
      { now: NOW },
    );
    expect(result).toMatchObject({ status: "added" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    const [create] = world.fake.callsTo("invoices.create");
    expect(create!.args[0]).toMatchObject({
      pending_invoice_items_behavior: "exclude",
      auto_advance: false,
      metadata: { hd_kind: "location_setup", hd_ref: requestId },
    });
    expect(create!.args[1]).toMatchObject({
      idempotencyKey: `hd-location:${clinic.clinicId}:${requestId}:invoice`,
    });
    const [item] = world.fake.callsTo("invoiceItems.create");
    expect(item!.args[0]).toMatchObject({
      pricing: { price: "price_healdesk_voice-webchat_setup_95600" },
      quantity: 1,
    });
    expect((await rowOf(clinic.clinicId)).locations).toBe(2);
    expect((await locationsOf(clinic.clinicId)).map((l) => l.status)).toEqual(["active", "active"]);
    const [notice] = await noticesOf(clinic.clinicId);
    expect(notice!.payload).toMatchObject({ isBeforeStart: true, billedPlanId: null });
  });

  test("nothing is written or charged without the details, the tick, a released acknowledgement or a BAA", async () => {
    const clinic = await seedBilling("loc-refusals", { started: true, inService: ["web"] });
    const base = { clinicId: clinic.clinicId, actorLabel: "owner" };
    const extra = await added(clinic);

    expect(await addLocation({ ...base, requestId: randomUUID() }, { now: NOW })).toMatchObject({
      status: "refused",
    });
    expect(
      await addLocation(
        { ...base, requestId: randomUUID(), ...extra, acceptance: { ...extra.acceptance, accepted: false } },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/Tick/) });
    expect(
      await addLocation(
        { ...base, requestId: randomUUID(), ...extra, location: { name: "Up{{x}}", address: "1 St" } },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused" });
    // A request id that is not a lower-case uuid is never accepted.
    expect(
      await addLocation({ ...base, requestId: "loc-1", ...extra }, { now: NOW }),
    ).toMatchObject({ status: "refused" });

    location.released = false;
    expect(await addLocation({ ...base, requestId: randomUUID(), ...extra }, { now: NOW })).toMatchObject({
      status: "not_available",
    });
    location.released = true;

    // A practice under a data processing agreement: refused in this release.
    const dpa = await seedBilling("loc-dpa", { started: true, inService: ["web"] });
    await getMigratorPool().query(
      `update baa_acceptances set terminated_at = now() where organization_id = $1`,
      [dpa.organizationId],
    );
    await getMigratorPool().query(
      `insert into baa_acceptances
         (id, organization_id, document_version, document_hash, rendered_text, variables, assent_label,
          accepted_by_name, accepted_by_email, accepted_at, bound_at)
       values ($1, $2, 'dpa/1.0.0', repeat('e', 64), 'AGREEMENT (synthetic test)', '{}'::jsonb, 'I agree',
               'Alex Chen', 'alex@agreement.test', now() - interval '1 day', now() - interval '1 day')`,
      [randomUUID(), dpa.organizationId],
    );
    expect(
      await addLocation(
        { clinicId: dpa.clinicId, actorLabel: "owner", requestId: randomUUID(), ...(await added(dpa)) },
        { now: NOW },
      ),
    ).toMatchObject({ status: "not_available", message: expect.stringMatching(/data processing/) });

    for (const c of [clinic, dpa]) {
      expect(await locationsOf(c.clinicId)).toHaveLength(1);
      expect(await acknowledgementsOf(c.clinicId)).toEqual([]);
      expect(await rowOf(c.clinicId)).toMatchObject({
        locations: 1,
        pendingLocationRequestId: null,
        stripeMutationLeaseOwner: null,
      });
    }
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
  });

  test("a decline clears the pending request, retires its location and charges nothing; a retry takes the next place", async () => {
    const clinic = await seedBilling("loc-decline", { started: true, inService: ["web"] });
    world.state.declineNextUpdate = true;
    const first = randomUUID();
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: first, actorLabel: "owner", ...(await added(clinic)) },
        { now: NOW },
      ),
    ).toMatchObject({ status: "payment_failed" });
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
      stripeMutationLeaseOwner: null,
    });
    expect((await locationsOf(clinic.clinicId)).map((l) => [l.position, l.status])).toEqual([
      [1, "active"],
      [2, "retired"],
    ]);
    expect(await noticesOf(clinic.clinicId)).toEqual([]);

    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: randomUUID(), actorLabel: "owner", ...(await added(clinic)) },
        { now: NOW },
      ),
    ).toMatchObject({ status: "added" });
    expect((await locationsOf(clinic.clinicId)).map((l) => [l.position, l.status])).toEqual([
      [1, "active"],
      [2, "retired"],
      [3, "active"],
    ]);
    expect((await rowOf(clinic.clinicId)).locations).toBe(2);
  });

  test("a location that fails to activate after the charge stays pending, ops are told, and the resume finishes it without charging again", async () => {
    const clinic = await seedBilling("loc-pending", { started: true, inService: ["web", "voice"] });
    location.fail = true;
    const requestId = randomUUID();
    const extra = await added(clinic);
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId, actorLabel: "owner", ...extra },
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
      pendingLocationRequestId: requestId,
      pendingLocationCount: 2,
      stripeMutationLeaseOwner: null,
    });
    expect(pending.pendingLocationChargedAt).not.toBeNull();
    expect((await locationsOf(clinic.clinicId))[1]).toMatchObject({ status: "pending" });

    // A different request is refused while this one is pending.
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: randomUUID(), actorLabel: "owner", ...extra },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/still being added/) });

    // The same request resumes: no second charge, no second location.
    location.fail = false;
    expect(
      await addLocation({ clinicId: clinic.clinicId, requestId, actorLabel: "owner" }, { now: NOW }),
    ).toMatchObject({ status: "added" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect((await locationsOf(clinic.clinicId)).map((l) => l.status)).toEqual(["active", "active"]);
    expect(await acknowledgementsOf(clinic.clinicId)).toHaveLength(1);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
    });
    expect((await noticesOf(clinic.clinicId)).map((n) => n.dedupe_key)).toEqual([
      `location:${requestId}`,
    ]);
  });

  test("a retry after a lost update response finds its own marker and never charges the setup fee twice (R14)", async () => {
    const clinic = await seedBilling("loc-lost", { started: true, inService: ["web", "voice"] });
    // Stripe applies the update (the quantity, the setup fee's invoice, the
    // marker), and the answer is lost.
    world.state.loseNextUpdateResponse = true;
    const requestId = randomUUID();
    const extra = await added(clinic);
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId, actorLabel: "owner", ...extra },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/never charged twice/) });
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: requestId,
      pendingLocationChargedAt: null,
      stripeMutationLeaseOwner: `add_location:${requestId}`,
    });
    expect(world.state.subscription.metadata.hd_location).toBe(requestId);

    // Another request is refused while this one is unresolved.
    expect(
      await addLocation(
        { clinicId: clinic.clinicId, requestId: randomUUID(), actorLabel: "owner", ...extra },
        { now: NOW },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/still being added/) });

    // The same request again, as if after Stripe had forgotten its
    // idempotency key: only the marker says it was charged.
    expect(
      await addLocation({ clinicId: clinic.clinicId, requestId, actorLabel: "owner" }, { now: NOW }),
    ).toEqual({ status: "added", locationId: expect.any(String) });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect(
      world.state.invoices.filter((invoice) => invoice.billing_reason === "subscription_update"),
    ).toHaveLength(1);
    expect(await rowOf(clinic.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
      pendingLocationCount: null,
      pendingLocationChargedAt: null,
      stripeMutationLeaseOwner: null,
    });
    expect((await noticesOf(clinic.clinicId)).map((n) => [n.kind, n.dedupe_key])).toEqual([
      ["location_added", `location:${requestId}`],
    ]);
  });

  test("the console's retry finishes a charged location through the same resume", async () => {
    const clinic = await seedBilling("loc-retry", { started: true, inService: ["web"] });
    location.fail = true;
    await addLocation(
      { clinicId: clinic.clinicId, requestId: randomUUID(), actorLabel: "owner", ...(await added(clinic)) },
      { now: NOW },
    );
    location.fail = false;
    expect(
      await retryLocationSetup(
        { clinicId: clinic.clinicId, actorLabel: "ops@healdesk.test" },
        { now: NOW },
      ),
    ).toMatchObject({ status: "added" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
    expect(await rowOf(clinic.clinicId)).toMatchObject({ pendingLocationRequestId: null });
    expect((await locationsOf(clinic.clinicId)).map((l) => l.status)).toEqual(["active", "active"]);
  });

  test("the resume asks Stripe about a request with no charge on record: charged means finish, not charged means clear and retire", async () => {
    const charged = await seedBilling("loc-resume-charged", { started: true, inService: ["web"] });
    const chargedId = randomUUID();
    await seedPendingAdd(charged, chargedId);
    // As if the attempt died after Stripe charged and before it was recorded.
    world.state.subscription.metadata.hd_location = chargedId;
    expect(
      await resumeLocationSetup({ clinicId: charged.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toMatchObject({ status: "added" });
    expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
    expect(await rowOf(charged.clinicId)).toMatchObject({
      locations: 2,
      pendingLocationRequestId: null,
    });
    expect((await locationsOf(charged.clinicId)).map((l) => l.status)).toEqual(["active", "active"]);

    const never = await seedBilling("loc-resume-never", { started: true, inService: ["web"] });
    await seedPendingAdd(never, randomUUID());
    expect(
      await resumeLocationSetup({ clinicId: never.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toEqual({ status: "cleared" });
    expect(await rowOf(never.clinicId)).toMatchObject({
      locations: 1,
      pendingLocationRequestId: null,
    });
    expect((await locationsOf(never.clinicId)).map((l) => l.status)).toEqual(["active", "retired"]);

    // Before the start: an attempt that died between finalizing its invoice
    // and paying it. Clearing the request voids that invoice; nothing is paid.
    const unpaid = await seedBilling("loc-resume-open", { started: false });
    const openId = randomUUID();
    const open = world.addInvoice({
      status: "open",
      metadata: { hd_kind: "location_setup", hd_ref: openId },
      total: 95_600,
      amount_due: 95_600,
    });
    await seedPendingAdd(unpaid, openId);
    expect(
      await resumeLocationSetup({ clinicId: unpaid.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toEqual({ status: "cleared" });
    expect(world.fake.callsTo("invoices.voidInvoice").map((c) => c.args[0])).toEqual([open.id]);
    expect(world.fake.callsTo("invoices.pay")).toHaveLength(0);
  });

  test("a charged add with no location row, from before 0108, stays pending and ops are told", async () => {
    const legacy = await seedBilling("loc-legacy", { started: true, inService: ["web"] });
    const legacyId = randomUUID();
    world.state.subscription.metadata.hd_location = legacyId;
    await inTenant(legacy.clinicId, (c) =>
      c.query(
        `update entitlements set pending_location_request_id = $2, pending_location_count = 2,
                pending_location_charged_at = now() where clinic_id = $1`,
        [legacy.clinicId, legacyId],
      ),
    );
    expect(
      await resumeLocationSetup({ clinicId: legacy.clinicId, actorLabel: "ops" }, { now: NOW }),
    ).toMatchObject({ status: "pending_setup" });
    expect(notifyOps).toHaveBeenCalledWith("location_charged_not_created", {
      clinicId: legacy.clinicId,
      count: 2,
    });
    expect(await locationsOf(legacy.clinicId)).toHaveLength(1);
    expect(await rowOf(legacy.clinicId)).toMatchObject({ pendingLocationRequestId: legacyId });
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
      recurringCents: 120_000,
      setupFeeCents: 95_600,
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

  test("asked from a legacy location clinic, the location is added to the billing clinic's account", async () => {
    const billing = await seedBilling("loc-from-location", { started: true, inService: ["web"] });
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
       values ($1, $2, 'Second', 'med-spa', $3) returning id`,
      [billing.organizationId, `loc-${randomUUID().slice(0, 6)}`, billing.clinicId],
    );
    const result = await addLocation(
      { clinicId: rows[0]!.id, requestId: randomUUID(), actorLabel: "owner", ...(await added(billing)) },
      { now: NOW },
    );
    expect(result).toMatchObject({ status: "added" });
    expect((await locationsOf(billing.clinicId)).map((l) => l.status)).toEqual(["active", "active"]);
    expect(await locationsOf(rows[0]!.id)).toHaveLength(1);
  });

  test("an account with more than one location cannot move into a package with phone", async () => {
    const clinic = await seedClinic("loc-plan-phone");
    await seedEntitled(clinic.clinicId, {
      planId: "webchat-1000",
      boughtPlanId: "webchat-1000",
      planStartedAt: STARTED,
      planStartAppliedAt: STARTED,
    });
    const one = await rowOf(clinic.clinicId);
    const target = { planId: "voice-webchat-1000-1000", interval: "month" as const };
    expect(checkPlanChange(one, target, ["web"], NOW)).toMatchObject({ ok: true });
    expect(checkPlanChange({ ...one, locations: 2 }, target, ["web"], NOW)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/more than one location/),
    });
    expect(
      checkPlanChange({ ...one, pendingLocationRequestId: randomUUID(), pendingLocationCount: 2 }, target, ["web"], NOW),
    ).toMatchObject({ ok: false });
  });
});
