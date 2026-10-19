import { randomUUID } from "node:crypto";

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import type { AgreementRecord, IntentRecord } from "@healdesk/catalog/checkout-record";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * /api/provision's dead letter (WP5): a paid purchase whose provisioning
 * keeps failing in a way a redelivery could fix. The relay stamps the
 * purchase as paid before provisioning runs; the third retryable failure
 * dead-letters it (ops told, B3 owed, /welcome stops waiting) while the
 * answer stays 500; and a later redelivery that finds the fault gone still
 * makes the account, which /welcome then hands over.
 *
 * provisionClinic is made to throw a plain error (a database fault, as far
 * as the route can tell) while `failing` is set.
 */

const failing = vi.hoisted(() => ({ on: false, seed: false, b3: [] as string[] }));
vi.mock("@/lib/provisioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning")>();
  return {
    ...actual,
    provisionClinic: async (...args: Parameters<typeof actual.provisionClinic>) => {
      if (failing.on) throw new Error("connection terminated unexpectedly");
      return actual.provisionClinic(...args);
    },
  };
});

// A bug on one stored payload: reading the setup seed throws before
// provisioning is reached, every time, while `failing.seed` is set.
vi.mock("@/lib/setup/seed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup/seed")>();
  return {
    ...actual,
    setupSeedFromIntent: (...args: Parameters<typeof actual.setupSeedFromIntent>) => {
      if (failing.seed)
        throw new TypeError("Cannot read properties of undefined (reading 'locations')");
      return actual.setupSeedFromIntent(...args);
    },
  };
});
// B3, observed: which purchases it went to.
vi.mock("@/lib/checkout/order-delayed", () => ({
  sendOrderConfirmedDelayed: async (intent: { ref: string }) => {
    failing.b3.push(intent.ref);
    return "sent";
  },
}));

const SECRET = "provision-dead-letter-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

const { POST: postProvision } = await import("@/app/api/provision/route");
const { findIntent } = await import("@/lib/checkout/intents");
const { welcomeState } = await import("@/lib/checkout/welcome");
const { agreementRecord, intentRecord, nonce, records } = await import("./setup/checkout-records");
const { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } =
  await import("./setup/db");

const describeDb = hasTestDatabase ? describe : describe.skip;

function purchase() {
  const email = `laura-${randomUUID().slice(0, 8)}@glowspa.test`;
  const agreement = agreementRecord(
    { signatoryEmail: email },
    { acceptedAt: new Date(Date.now() - 3 * 60_000) },
  );
  const n = nonce();
  const intent = intentRecord(agreement, {
    attempt: 1,
    sessionId: "cs_test_dead",
    nonceHash: n.hash,
    purchase: {},
  });
  return { agreement, intent, nonce: n };
}

async function provision(
  p: { agreement: AgreementRecord; intent: IntentRecord },
  subscription: string,
) {
  const raw = JSON.stringify({
    ref: p.intent.ref,
    idempotencyKey: subscription,
    stripeCustomerId: "cus_test_dead",
    stripeSubscriptionId: subscription,
    attempt: p.intent.attempt,
    plan: "voice-webchat-1000-1000",
    billingInterval: "month",
    records: records(p.agreement, p.intent),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await postProvision(
    new Request("http://app.test/api/provision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
      },
      body: raw,
    }),
  );
  return response.status;
}

async function alerts(event: string) {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = $1`,
    [event],
  );
  return rows;
}

describeDb("/api/provision: the dead letter", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts`);
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    failing.on = false;
    failing.seed = false;
    failing.b3 = [];
  });

  afterAll(async () => {
    await closePools();
  });

  test("stamps the paid relay, dead-letters on the third failure with the answer still 500, and a later delivery still provisions", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = purchase();
    const sub = `sub_test_${randomUUID().slice(0, 8)}`;
    const asPayer = { ref: p.intent.ref, sessionId: "cs_test_dead", nonce: p.nonce.value };

    failing.on = true;
    expect(await provision(p, sub)).toBe(500);
    const seen = (await findIntent(p.intent.ref))!;
    expect(seen.paidSeenAt).toBeInstanceOf(Date);
    expect(seen.provisionFailures).toBe(1);
    expect(await welcomeState(asPayer)).toMatchObject({ status: "pending" });

    expect(await provision(p, sub)).toBe(500);
    expect(await alerts("provisioning_dead_lettered")).toEqual([]);
    expect(await provision(p, sub)).toBe(500);
    const dead = (await findIntent(p.intent.ref))!;
    expect(dead.provisionFailures).toBe(3);
    expect(dead.provisionFailedAt).toBeInstanceOf(Date);
    expect(dead.paidSeenAt!.getTime()).toBe(seen.paidSeenAt!.getTime());
    expect((await alerts("provisioning_dead_lettered")).map((a) => a.fields)).toEqual([
      { requestId: p.intent.ref, attempts: 3 },
    ]);
    expect(failing.b3).toEqual([p.intent.ref]);
    expect(await welcomeState(asPayer)).toMatchObject({ status: "failed" });

    // A fourth failure tells nobody again.
    expect(await provision(p, sub)).toBe(500);
    expect(await alerts("provisioning_dead_lettered")).toHaveLength(1);

    // The fault clears; Stripe's next delivery makes the account.
    failing.on = false;
    expect(await provision(p, sub)).toBe(201);
    expect((await findIntent(p.intent.ref))!.consumedAt).toBeInstanceOf(Date);
    expect(await welcomeState(asPayer)).toMatchObject({ status: "ready" });
    quiet.mockRestore();
    warn.mockRestore();
  });

  test("an error before provisioning, the same on every delivery, dead-letters on the third and sends B3", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = purchase();
    const sub = `sub_test_${randomUUID().slice(0, 8)}`;

    failing.seed = true;
    expect(await provision(p, sub)).toBe(500);
    expect(await provision(p, sub)).toBe(500);
    expect(await alerts("provisioning_dead_lettered")).toEqual([]);
    expect(failing.b3).toEqual([]);
    expect(await provision(p, sub)).toBe(500);

    const dead = (await findIntent(p.intent.ref))!;
    expect(dead.paidSeenAt).toBeInstanceOf(Date);
    expect(dead.provisionFailures).toBe(3);
    expect(dead.provisionFailedAt).toBeInstanceOf(Date);
    expect(dead.consumedAt).toBeNull();
    expect((await alerts("provisioning_dead_lettered")).map((a) => a.fields)).toEqual([
      { requestId: p.intent.ref, attempts: 3 },
    ]);
    expect(failing.b3).toEqual([p.intent.ref]);
    quiet.mockRestore();
    warn.mockRestore();
  });
});
