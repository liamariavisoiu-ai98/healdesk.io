import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getPlan, stripeLookupKey } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type Stripe from "stripe";

import {
  checkLocationQuantities,
  expectedLocations,
  runLocationQuantityJob,
} from "@/lib/billing/location-quantity";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { activatePendingLocation, writePendingLocation } from "@/lib/location-add";
import { JOB_LOCATION_QUANTITY, setJobEnabled } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedClinic,
  seedEntitled,
  type SeededClinic,
} from "./setup/factories";
import { priceFor } from "./setup/stripe-world";

/**
 * The hourly location-quantity check (lib/billing/location-quantity.ts,
 * drizzle/0111): Stripe's quantity on the package item against the active
 * locations, plus a pending one whose charge is recorded. Stripe here is a
 * fake that can only READ a subscription: any write the check attempted
 * would throw, and every call is recorded so the tests can say there was
 * none. Alerts are read back from the ops log.
 *
 * Writing a further location goes through the real writer, so the
 * acknowledgement's release is mocked on, as in add-location.test.ts.
 */

vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentCentralAssistantAcknowledgement: () => ({
      ...actual.currentCentralAssistantAcknowledgement(),
      released: true,
    }),
  };
});

vi.setConfig({ testTimeout: 60_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const PLAN = "webchat-1000";
const PACKAGE_KEY = stripeLookupKey(getPlan(PLAN)!, "month");

/** A Stripe that reads subscriptions and does nothing else; quantities by subscription id. */
function readOnlyStripe(quantities: Map<string, number>) {
  const calls: { method: string; args: unknown[] }[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (...args: unknown[]) => {
        calls.push({ method: "subscriptions.retrieve", args });
        const id = args[0] as string;
        return {
          id,
          object: "subscription",
          status: "active",
          items: {
            data: [
              {
                id: `si_${id}`,
                object: "subscription_item",
                quantity: quantities.get(id) ?? 1,
                price: priceFor(PACKAGE_KEY),
              },
            ],
          },
        };
      },
    },
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

type Account = SeededClinic & { subscriptionId: string };

async function seedAccount(label: string, options: { started?: boolean } = {}): Promise<Account> {
  const clinic = await seedClinic(label);
  const ids = await seedEntitled(clinic.clinicId, {
    planId: PLAN,
    boughtPlanId: PLAN,
    ...(options.started === false ? {} : { planStartAppliedAt: at(-10 * 24 * HOUR) }),
  });
  return { ...clinic, subscriptionId: ids.stripeSubscriptionId! };
}

/** A further location, pending, as addLocation's first transaction writes it. */
async function writePending(account: Account, requestId: string): Promise<void> {
  await bindAgreementInEffect(account.clinicId);
  const pool = getMigratorPool();
  const { rows: factor } = await pool.query<{ id: string }>(
    `insert into user_factors (user_id, kind, device_label, credential_id, public_key, counter, backed_up)
     values ($1, 'passkey', 'Front desk Mac', $2, '\\x01', 0, true) returning id`,
    [account.staffUserId, randomBytes(16).toString("base64url")],
  );
  const { rows: stepUp } = await pool.query<{ id: string }>(
    `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
     values ($1, $2, $3, 'Front desk Mac', now(), now()) returning id`,
    [createHash("sha256").update(randomBytes(24)).digest(), account.staffUserId, factor[0]!.id],
  );
  await withTenant(
    {
      clinicId: account.clinicId,
      actor: { type: "user", userId: account.staffUserId, label: "x" },
    },
    async (tx) => {
      const written = await writePendingLocation(tx, {
        requestId,
        boughtPlan: getPlan(PLAN)!,
        location: { name: "Uptown", address: "12 Main St, Springfield" },
        acceptance: {
          userId: account.staffUserId,
          acceptedByLabel: "Laura Owner, owner",
          stepUp: {
            stepUpId: stepUp[0]!.id,
            passkeyId: factor[0]!.id,
            deviceLabel: "Front desk Mac",
          },
          accepted: true,
        },
      });
      if (!written.ok) throw new Error(written.message);
    },
  );
}

async function setPending(account: Account, requestId: string, charged: boolean) {
  await inTenant(account.clinicId, (c) =>
    c.query(
      `update entitlements set pending_location_request_id = $2, pending_location_count = 2,
              pending_location_charged_at = $3 where clinic_id = $1`,
      [account.clinicId, requestId, charged ? at(-HOUR) : null],
    ),
  );
}

/** A second location, made active the way addLocation finishes one, and the add cleared. */
async function addActiveLocation(account: Account): Promise<void> {
  const requestId = randomUUID();
  await writePending(account, requestId);
  await setPending(account, requestId, true);
  await withTenant(
    { clinicId: account.clinicId, actor: { type: "service", serviceName: "test" } },
    async (tx) => {
      await activatePendingLocation(tx, requestId);
    },
  );
  await inTenant(account.clinicId, (c) =>
    c.query(
      `update entitlements set pending_location_request_id = null, pending_location_count = null,
              pending_location_charged_at = null, locations = 2 where clinic_id = $1`,
      [account.clinicId],
    ),
  );
}

async function alertsOf(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    event: string;
    fields: Record<string, unknown>;
  }>(
    `select event, fields from ops_alerts
      where event like 'location_quantity_%' and fields->>'clinicId' = $1
      order by raised_at`,
    [clinicId],
  );
  return rows;
}

describe("expectedLocations", () => {
  test("the active locations, and one more only for an add whose charge is recorded", () => {
    expect(expectedLocations(1, false)).toBe(1);
    expect(expectedLocations(2, false)).toBe(2);
    expect(expectedLocations(1, true)).toBe(2);
  });
});

describeDb("the location-quantity check", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);
  afterAll(closePools);
  beforeEach(async () => {
    await truncateAll();
  });

  test("counts that match raise nothing, and Stripe is only read", async () => {
    const one = await seedAccount("lq-match-one");
    const two = await seedAccount("lq-match-two");
    await addActiveLocation(two);
    const { stripe, calls } = readOnlyStripe(
      new Map([
        [one.subscriptionId, 1],
        [two.subscriptionId, 2],
      ]),
    );

    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({
      agree: 2,
      drift: 0,
      alerted: 0,
      failures: 0,
    });
    expect(await alertsOf(one.clinicId)).toEqual([]);
    expect(await alertsOf(two.clinicId)).toEqual([]);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["subscriptions.retrieve"]));
  });

  test("a mismatch is told to ops once, with ids, counts and a time only, however many hours it lasts", async () => {
    const account = await seedAccount("lq-drift");
    const { stripe, calls } = readOnlyStripe(new Map([[account.subscriptionId, 3]]));

    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({
      drift: 1,
      alerted: 1,
    });
    expect(await checkLocationQuantities({ now: at(HOUR), stripe })).toMatchObject({
      drift: 1,
      alerted: 0,
    });
    expect(await checkLocationQuantities({ now: at(2 * HOUR), stripe })).toMatchObject({
      alerted: 0,
    });

    const alerts = await alertsOf(account.clinicId);
    expect(alerts).toEqual([
      {
        event: "location_quantity_drift",
        fields: {
          clinicId: account.clinicId,
          windowStart: NOW.toISOString(),
          locationCount: 1,
          billedCount: 3,
        },
      },
    ]);
    expect(() => assertPayloadAllowed(alerts[0]!.fields, "ops_alert")).not.toThrow();
    expect(calls.every((c) => c.method === "subscriptions.retrieve")).toBe(true);
  });

  test("the episode ends once when the counts agree again, and a later mismatch is a new one", async () => {
    const account = await seedAccount("lq-clear");
    const quantities = new Map([[account.subscriptionId, 2]]);
    const { stripe } = readOnlyStripe(quantities);

    await checkLocationQuantities({ now: NOW, stripe });
    quantities.set(account.subscriptionId, 1);
    expect(await checkLocationQuantities({ now: at(HOUR), stripe })).toMatchObject({
      agree: 1,
      cleared: 1,
    });
    expect(await checkLocationQuantities({ now: at(2 * HOUR), stripe })).toMatchObject({
      cleared: 0,
    });
    quantities.set(account.subscriptionId, 2);
    expect(await checkLocationQuantities({ now: at(3 * HOUR), stripe })).toMatchObject({
      alerted: 1,
    });

    expect((await alertsOf(account.clinicId)).map((a) => [a.event, a.fields.windowStart])).toEqual([
      ["location_quantity_drift", NOW.toISOString()],
      ["location_quantity_agrees", NOW.toISOString()],
      ["location_quantity_drift", at(3 * HOUR).toISOString()],
    ]);
  });

  test("a pending location counts once its charge is recorded, and not while the add is in flight", async () => {
    const account = await seedAccount("lq-pending");
    const requestId = randomUUID();
    await writePending(account, requestId);
    const quantities = new Map([[account.subscriptionId, 2]]);
    const { stripe, calls } = readOnlyStripe(quantities);

    // Pending, no charge on record: the add is in flight, so nothing is read.
    await setPending(account, requestId, false);
    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({ skipped: 1 });
    expect(calls).toHaveLength(0);

    // Charged: one active and one pending charged make two, which Stripe bills.
    await setPending(account, requestId, true);
    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({ agree: 1 });

    // Stripe still at one after the charge is recorded: drift.
    quantities.set(account.subscriptionId, 1);
    expect(await checkLocationQuantities({ now: at(HOUR), stripe })).toMatchObject({
      drift: 1,
      alerted: 1,
    });
    expect((await alertsOf(account.clinicId))[0]!.fields).toMatchObject({
      locationCount: 2,
      billedCount: 1,
    });
  });

  test("a plan not started, and a Stripe change in flight, are left alone", async () => {
    const notStarted = await seedAccount("lq-not-started", { started: false });
    const leased = await seedAccount("lq-leased");
    await inTenant(leased.clinicId, (c) =>
      c.query(
        `update entitlements set stripe_mutation_lease_owner = 'someone', stripe_mutation_lease_until = $2
          where clinic_id = $1`,
        [leased.clinicId, at(5 * 60 * 1000)],
      ),
    );
    const { stripe, calls } = readOnlyStripe(
      new Map([
        [notStarted.subscriptionId, 5],
        [leased.subscriptionId, 5],
      ]),
    );
    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({
      skipped: 2,
      drift: 0,
    });
    expect(calls).toHaveLength(0);
  });

  test("each account is counted in its own tenant: another account's locations never count", async () => {
    const big = await seedAccount("lq-tenant-big");
    await addActiveLocation(big);
    const small = await seedAccount("lq-tenant-small");
    const quantities = new Map([
      [big.subscriptionId, 2],
      [small.subscriptionId, 1],
    ]);
    const { stripe } = readOnlyStripe(quantities);
    expect(await checkLocationQuantities({ now: NOW, stripe })).toMatchObject({ agree: 2 });

    quantities.set(small.subscriptionId, 2);
    expect(await checkLocationQuantities({ now: at(HOUR), stripe })).toMatchObject({
      drift: 1,
      alerted: 1,
    });
    expect(await alertsOf(big.clinicId)).toEqual([]);
    expect((await alertsOf(small.clinicId)).map((a) => a.fields)).toEqual([
      expect.objectContaining({ clinicId: small.clinicId, locationCount: 1, billedCount: 2 }),
    ]);
  });

  test("the job does nothing while its switch is off, which is how it ships", async () => {
    const account = await seedAccount("lq-switch");
    const { stripe, calls } = readOnlyStripe(new Map([[account.subscriptionId, 4]]));
    // Seeded off by its migration.
    const seed = readFileSync(
      fileURLToPath(new URL("../drizzle/0111_location_quantity_check.sql", import.meta.url)),
      "utf8",
    );
    expect(seed).toMatch(/\('location-quantity', '(?:[^']|'')+', false\)/);
    const { rows } = await getMigratorPool().query<{ enabled: boolean }>(
      `select enabled from scheduled_jobs where name = $1`,
      [JOB_LOCATION_QUANTITY],
    );
    expect(rows).toEqual([{ enabled: false }]);

    expect(await runLocationQuantityJob({ now: NOW, stripe })).toEqual({ status: "disabled" });
    expect(calls).toHaveLength(0);
    expect(await alertsOf(account.clinicId)).toEqual([]);

    await setJobEnabled(JOB_LOCATION_QUANTITY, true, account.staffUserId);
    try {
      expect(await runLocationQuantityJob({ now: NOW, stripe })).toMatchObject({ status: "ok" });
      expect(calls).toHaveLength(1);
      expect(await alertsOf(account.clinicId)).toHaveLength(1);
    } finally {
      await setJobEnabled(JOB_LOCATION_QUANTITY, false, account.staffUserId);
    }
  });
});
