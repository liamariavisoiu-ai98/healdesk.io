import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The Connect webhook (BD28, R23): signature, mode, recognising our own
 * sessions, resolving through the deposit, conditional writes, closed error
 * codes, dead letters, payments after a disconnect, and deauthorization.
 */

const mocks = vi.hoisted(() => ({
  ops: [] as Array<{ event: string; fields: Record<string, unknown> }>,
  alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, string | boolean> }>,
}));

vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps: async (event: string, fields: Record<string, unknown>) => {
    mocks.ops.push({ event, fields });
  },
}));
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (
    tx: { clinicId: string },
    kind: string,
    ref: Record<string, string | boolean>,
  ) => {
    mocks.alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));

import { POST as connectWebhook } from "@/app/api/webhooks/stripe-connect/route";
import { replayConnectEvent } from "@/lib/billing/connect-events";
import { __setStripeForTests } from "@/lib/billing/stripe-client";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";
import { createStripeFake, type StripeFake } from "./setup/stripe-fake";

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 120_000 };
const SECRET = "whsec_test_connect_hook";
const ACCOUNT = "acct_1Hook";
const NOW = new Date("2026-10-06T15:00:00Z");
const created = (at: Date) => Math.floor(at.getTime() / 1000);

let eventSeq = 0;
function nextEventId(): string {
  eventSeq += 1;
  return `evt_test_${String(eventSeq).padStart(6, "0")}`;
}

function request(event: Record<string, unknown>, secret = SECRET): Request {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("https://app.healdesk.test/api/webhooks/stripe-connect", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
}

function sessionEvent(
  type: string,
  input: {
    id?: string;
    account?: string;
    sessionId: string;
    ref: string;
    amount?: number;
    currency?: string;
    paymentStatus?: string;
    status?: string;
    livemode?: boolean;
    marker?: string | null;
  },
): Record<string, unknown> {
  return {
    id: input.id ?? nextEventId(),
    object: "event",
    type,
    account: input.account ?? ACCOUNT,
    livemode: input.livemode ?? false,
    created: created(NOW),
    data: {
      object: {
        id: input.sessionId,
        object: "checkout.session",
        client_reference_id: input.ref,
        metadata: input.marker === null ? {} : { hd: input.marker ?? "deposit", ref: input.ref },
        amount_total: input.amount ?? 5000,
        currency: input.currency ?? "usd",
        payment_status: input.paymentStatus ?? "paid",
        status: input.status ?? "complete",
        customer_details: { email: "patient@example.test", name: "Synthetic Patient" },
      },
    },
  };
}

describeDb("POST /api/webhooks/stripe-connect", DB_TEST_OPTIONS, () => {
  let fake: StripeFake;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.ops.length = 0;
    mocks.alerts.length = 0;
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_hook");
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_hook");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    // No handlers: any Stripe call a webhook makes fails the test loudly.
    fake = createStripeFake();
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closePools();
  });

  let phone = 0;
  /** A clinic on ACCOUNT with deposits on, and one open link on an appointment waiting for it. */
  async function openDeposit(
    label: string,
    accountId = ACCOUNT,
    connectedAt = new Date(NOW.getTime() - 24 * 3600_000),
  ) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
      [c.clinicId, accountId, connectedAt],
    );
    phone += 1;
    const ids = await inTenant(c.clinicId, async (client) => {
      await client.query(
        `insert into clinic_settings (clinic_id, deposits_enabled) values ($1, true)`,
        [c.clinicId],
      );
      const contact = (
        await client.query<{ id: string }>(
          `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
          [c.clinicId, `+1555030${String(1000 + phone)}`],
        )
      ).rows[0]!.id;
      const appointment = (
        await client.query<{ id: string }>(
          `insert into appointments (clinic_id, contact_id, scheduled_for, deposit_usd, deposit_status) values ($1, $2, now() + interval '2 days', 50, 'pending_link') returning id`,
          [c.clinicId, contact],
        )
      ).rows[0]!.id;
      const sessionId = `cs_test_${label}`;
      const deposit = (
        await client.query<{ id: string }>(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, checkout_session_id, status, expires_at) values ($1, $2, 'web', 5000, $3, $4, 'open', now() + interval '1 hour') returning id`,
          [c.clinicId, appointment, accountId, sessionId],
        )
      ).rows[0]!.id;
      return { appointment, deposit, sessionId };
    });
    return { ...c, ...ids };
  }

  async function row(clinicId: string, depositId: string) {
    return inTenant(clinicId, async (client) => ({
      ...(
        await client.query<{ status: string; paid_at: Date | null; last_event_id: string | null }>(
          `select status, paid_at, last_event_id from deposit_payments where id = $1`,
          [depositId],
        )
      ).rows[0]!,
      appointment: (
        await client.query<{ deposit_status: string }>(
          `select a.deposit_status from appointments a join deposit_payments d on d.appointment_id = a.id where d.id = $1`,
          [depositId],
        )
      ).rows[0]!.deposit_status,
    }));
  }

  async function ledger(eventId: string) {
    return (
      await getMigratorPool().query<{
        outcome: string | null;
        error: string | null;
        failures: number;
        resolved_clinic_id: string | null;
        account: string;
      }>(
        `select outcome, error, failures, resolved_clinic_id, account from stripe_connect_events where stripe_event_id = $1`,
        [eventId],
      )
    ).rows[0];
  }

  test("503 without the secret or a readable key; 400 on a bad signature; nothing recorded", async () => {
    const d = await openDeposit("hook-auth");
    const event = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
    });
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    expect((await connectWebhook(request(event))).status).toBe(503);
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect((await connectWebhook(request(event))).status).toBe(503);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_hook");
    expect((await connectWebhook(request(event, "whsec_someone_else"))).status).toBe(400);
    expect(
      (await getMigratorPool().query(`select 1 from stripe_connect_events`)).rows,
    ).toHaveLength(0);
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");
  });

  test("an event in the other mode is ignored before anything else", async () => {
    const d = await openDeposit("hook-mode");
    const live = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
      livemode: true,
    });
    const response = await connectWebhook(request(live));
    expect(await response.json()).toMatchObject({ received: true, outcome: "ignored" });
    expect(await ledger(live.id as string)).toMatchObject({
      outcome: "ignored",
      error: "livemode_mismatch",
      resolved_clinic_id: null,
    });
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");

    // A test-mode revocation reaching a live deployment must not disconnect anyone.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_hook");
    const testMode = {
      id: nextEventId(),
      object: "event",
      type: "account.application.deauthorized",
      account: ACCOUNT,
      livemode: false,
      created: created(NOW),
      data: { object: { id: "ca_x", object: "application" } },
    };
    expect(await (await connectWebhook(request(testMode))).json()).toMatchObject({
      outcome: "ignored",
    });
    const { rows } = await getMigratorPool().query<{ acct: string | null }>(
      `select stripe_connect_account_id as acct from clinics where id = $1`,
      [d.clinicId],
    );
    expect(rows[0]!.acct).toBe(ACCOUNT);
  });

  test("the clinic's own Checkout traffic is ignored with no error text and no tenant lookup", async () => {
    const d = await openDeposit("hook-foreign");
    for (const event of [
      sessionEvent("checkout.session.completed", {
        sessionId: "cs_test_their_own_sale",
        ref: d.deposit,
        marker: null,
      }),
      sessionEvent("checkout.session.completed", {
        sessionId: "cs_test_their_own_sale",
        ref: "order-1234",
        marker: "deposit",
      }),
      sessionEvent("checkout.session.expired", {
        sessionId: "cs_test_other",
        ref: d.deposit,
        marker: "invoice",
      }),
    ]) {
      expect(await (await connectWebhook(request(event))).json()).toMatchObject({
        outcome: "ignored",
      });
      expect(await ledger(event.id as string)).toMatchObject({
        outcome: "ignored",
        error: null,
        resolved_clinic_id: null,
      });
    }
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");
  });

  test("a paid completion marks the deposit paid once, however often it arrives", async () => {
    const d = await openDeposit("hook-paid");
    const first = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
    });
    expect(await (await connectWebhook(request(first))).json()).toEqual({
      received: true,
      outcome: "processed",
      duplicate: false,
    });
    expect(await (await connectWebhook(request(first))).json()).toEqual({
      received: true,
      outcome: "processed",
      duplicate: true,
    });
    const after = await row(d.clinicId, d.deposit);
    expect(after).toMatchObject({ status: "paid", last_event_id: first.id, appointment: "paid" });
    // A second event for the same session (Checkout may fulfil twice) changes nothing.
    const second = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
    });
    expect((await connectWebhook(request(second))).status).toBe(200);
    expect(await row(d.clinicId, d.deposit)).toEqual(after);
    expect(await ledger(first.id as string)).toMatchObject({
      outcome: "processed",
      resolved_clinic_id: d.clinicId,
      account: ACCOUNT,
    });
  });

  test("a completed but unsettled session waits for the async event", async () => {
    const d = await openDeposit("hook-async");
    await connectWebhook(
      request(
        sessionEvent("checkout.session.completed", {
          sessionId: d.sessionId,
          ref: d.deposit,
          paymentStatus: "unpaid",
        }),
      ),
    );
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");
    await connectWebhook(
      request(
        sessionEvent("checkout.session.async_payment_succeeded", {
          sessionId: d.sessionId,
          ref: d.deposit,
        }),
      ),
    );
    expect(await row(d.clinicId, d.deposit)).toMatchObject({ status: "paid", appointment: "paid" });
  });

  test("a mismatch fails with a closed code, is retried, then parks and tells ops", async () => {
    const d = await openDeposit("hook-mismatch");
    const wrong = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
      amount: 4900,
    });
    expect((await connectWebhook(request(wrong))).status).toBe(500);
    expect((await connectWebhook(request(wrong))).status).toBe(500);
    expect(mocks.ops).toHaveLength(0);
    const parked = await connectWebhook(request(wrong));
    expect(parked.status).toBe(200);
    expect(await parked.json()).toMatchObject({ outcome: "dead_letter" });
    expect(await ledger(wrong.id as string)).toMatchObject({
      outcome: "dead_letter",
      error: "amount_mismatch",
      failures: 3,
      resolved_clinic_id: d.clinicId,
    });
    expect(mocks.ops).toEqual([
      {
        event: "connect_event_dead_lettered",
        fields: {
          eventId: wrong.id,
          eventType: "checkout.session.completed",
          clinicId: d.clinicId,
          code: "amount_mismatch",
        },
      },
    ]);
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");

    const currency = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
      currency: "eur",
    });
    expect((await connectWebhook(request(currency))).status).toBe(500);
    expect((await ledger(currency.id as string))?.error).toBe("currency_mismatch");
    const account = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
      account: "acct_1SomeoneElse",
    });
    expect((await connectWebhook(request(account))).status).toBe(500);
    expect((await ledger(account.id as string))?.error).toBe("account_mismatch");
    // Only closed codes are ever stored: nothing the event carried.
    const errors = (
      await getMigratorPool().query<{ error: string | null }>(
        `select error from stripe_connect_events`,
      )
    ).rows.map((r) => r.error);
    expect(errors.every((e) => e === null || /^[a-z_]+$/.test(e))).toBe(true);
    expect(JSON.stringify(errors)).not.toMatch(/patient|example\.test/);
  });

  test("a session id that is not the row's is not ours to apply", async () => {
    const d = await openDeposit("hook-orphan");
    const orphan = sessionEvent("checkout.session.expired", {
      sessionId: "cs_test_never_handed_out",
      ref: d.deposit,
      status: "expired",
      paymentStatus: "unpaid",
    });
    expect(await (await connectWebhook(request(orphan))).json()).toMatchObject({
      outcome: "ignored",
    });
    expect(await ledger(orphan.id as string)).toMatchObject({
      error: "session_mismatch",
      resolved_clinic_id: d.clinicId,
    });
    expect((await row(d.clinicId, d.deposit)).status).toBe("open");
  });

  test("a payment completing after the clinic disconnected is still recorded", async () => {
    const d = await openDeposit("hook-late");
    // The disconnect left the link open because it could not be checked.
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = null, stripe_connect_disconnected_at = $2 where id = $1`,
      [d.clinicId, NOW],
    );
    await inTenant(d.clinicId, (client) =>
      client.query(`update appointments set deposit_status = 'pending_front_desk' where id = $1`, [
        d.appointment,
      ]),
    );
    const late = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
    });
    expect(await (await connectWebhook(request(late))).json()).toMatchObject({
      outcome: "processed",
    });
    expect(await row(d.clinicId, d.deposit)).toMatchObject({ status: "paid", appointment: "paid" });
  });

  test("an expired or failed link goes to the front desk with the L10 alert", async () => {
    const expired = await openDeposit("hook-expired");
    await connectWebhook(
      request(
        sessionEvent("checkout.session.expired", {
          sessionId: expired.sessionId,
          ref: expired.deposit,
          status: "expired",
          paymentStatus: "unpaid",
        }),
      ),
    );
    expect(await row(expired.clinicId, expired.deposit)).toMatchObject({
      status: "expired",
      appointment: "pending_front_desk",
    });
    const failed = await openDeposit("hook-failed");
    await connectWebhook(
      request(
        sessionEvent("checkout.session.async_payment_failed", {
          sessionId: failed.sessionId,
          ref: failed.deposit,
          paymentStatus: "unpaid",
        }),
      ),
    );
    expect(await row(failed.clinicId, failed.deposit)).toMatchObject({
      status: "failed",
      appointment: "pending_front_desk",
    });
    expect(mocks.alerts).toEqual([
      {
        clinicId: expired.clinicId,
        kind: "deposit_to_collect",
        ref: { appointmentId: expired.appointment },
      },
      {
        clinicId: failed.clinicId,
        kind: "deposit_to_collect",
        ref: { appointmentId: failed.appointment },
      },
    ]);
    // A late duplicate of the expiry does not alert again.
    await connectWebhook(
      request(
        sessionEvent("checkout.session.expired", {
          sessionId: expired.sessionId,
          ref: expired.deposit,
          status: "expired",
          paymentStatus: "unpaid",
        }),
      ),
    );
    expect(mocks.alerts).toHaveLength(2);
  });

  test("a deauthorization disconnects every clinic on the account without calling Stripe, unless it predates the connection", async () => {
    const a = await openDeposit("hook-gone-a", "acct_1Gone");
    const b = await openDeposit("hook-gone-b", "acct_1Gone");
    const event = {
      id: nextEventId(),
      object: "event",
      type: "account.application.deauthorized",
      account: "acct_1Gone",
      livemode: false,
      created: created(NOW),
      data: { object: { id: "ca_x", object: "application" } },
    };
    expect(await (await connectWebhook(request(event))).json()).toMatchObject({
      outcome: "processed",
    });
    expect(fake.calls).toHaveLength(0);
    for (const clinic of [a, b]) {
      const { rows } = await getMigratorPool().query<{ acct: string | null; gone: Date | null }>(
        `select stripe_connect_account_id as acct, stripe_connect_disconnected_at as gone from clinics where id = $1`,
        [clinic.clinicId],
      );
      expect(rows[0]!.acct).toBeNull();
      expect(rows[0]!.gone).not.toBeNull();
      const settings = await inTenant(clinic.clinicId, (client) =>
        client.query<{ deposits_enabled: boolean }>(`select deposits_enabled from clinic_settings`),
      );
      expect(settings.rows[0]!.deposits_enabled).toBe(false);
      // Its open link cannot be checked any more: left open, handed to the desk,
      // and the alert says it may already have been paid.
      expect(await row(clinic.clinicId, clinic.deposit)).toMatchObject({
        status: "open",
        appointment: "pending_front_desk",
      });
      expect(mocks.alerts.filter((a) => a.clinicId === clinic.clinicId)).toEqual([
        {
          clinicId: clinic.clinicId,
          kind: "deposit_to_collect",
          ref: { appointmentId: clinic.appointment, mayBePaid: true },
        },
      ]);
      const notices = await inTenant(clinic.clinicId, (client) =>
        client.query<{ kind: string; payload: Record<string, unknown> }>(
          `select kind, payload from billing_notices`,
        ),
      );
      expect(notices.rows).toEqual([
        {
          kind: "connect_disconnected",
          // Its open link could not be checked: the email says it may still be paid.
          payload: {
            disconnectedAt: expect.any(String),
            wasByWebhook: true,
            source: "stripe",
            hasUncheckedLinks: true,
          },
        },
      ]);
    }
    // Again: nobody holds the account now.
    const again = { ...event, id: nextEventId() };
    await connectWebhook(request(again));
    expect(await ledger(again.id)).toMatchObject({ outcome: "ignored", error: "no_clinic" });

    // A revocation older than the clinic's current connection is the old connection's.
    const back = await openDeposit("hook-back", "acct_1Back", NOW);
    const stale = {
      ...event,
      id: nextEventId(),
      account: "acct_1Back",
      created: created(NOW) - 3600,
    };
    await connectWebhook(request(stale));
    expect(await ledger(stale.id)).toMatchObject({
      outcome: "ignored",
      error: "stale_deauthorization",
    });
    const { rows } = await getMigratorPool().query<{ acct: string | null }>(
      `select stripe_connect_account_id as acct from clinics where id = $1`,
      [back.clinicId],
    );
    expect(rows[0]!.acct).toBe("acct_1Back");
  });

  test("replayConnectEvent fetches a parked event again from the clinic's account and applies it", async () => {
    const d = await openDeposit("hook-replay");
    const wrong = sessionEvent("checkout.session.completed", {
      sessionId: d.sessionId,
      ref: d.deposit,
      amount: 1,
    });
    for (let i = 0; i < 3; i += 1) await connectWebhook(request(wrong));
    expect((await ledger(wrong.id as string))?.outcome).toBe("dead_letter");

    fake.on("events.retrieve", (id: unknown) =>
      sessionEvent("checkout.session.completed", {
        id: String(id),
        sessionId: d.sessionId,
        ref: d.deposit,
      }),
    );
    const replayed = await replayConnectEvent(wrong.id as string, { now: NOW });
    expect(replayed).toMatchObject({
      outcome: "processed",
      duplicate: false,
      clinicId: d.clinicId,
    });
    expect(fake.callsTo("events.retrieve")[0]!.args).toEqual([
      wrong.id,
      {},
      expect.objectContaining({ stripeAccount: ACCOUNT }),
    ]);
    expect(await row(d.clinicId, d.deposit)).toMatchObject({ status: "paid" });
    expect(await replayConnectEvent(wrong.id as string, { now: NOW })).toBeNull();
  });
});
