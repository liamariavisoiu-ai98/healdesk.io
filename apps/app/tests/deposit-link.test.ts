import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { clampDepositExpiry, createDepositLink, depositLinkText } from "@/lib/billing/deposit-link";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";
import { createStripeFake, stripeError, type StripeFake } from "./setup/stripe-fake";

/**
 * The deposit payment link (BD27, R23): a card-only Checkout on the clinic's
 * own account, carrying an amount and an opaque reference, one live link per
 * appointment, its expiry clamped and fixed so a retry is the same request.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 30_000 };
const ACTOR = { type: "service", serviceName: "test" } as const;
const ACCOUNT = "acct_1DepositLink";
const NOW = new Date("2026-10-06T15:00:00Z");
const MINUTE = 60_000;

describe("the link's fixed parts", () => {
  test("the expiry sits inside Stripe's 30-minute-to-24-hour window, with a margin either side", () => {
    expect(clampDepositExpiry(NOW, 30).getTime() - NOW.getTime()).toBe(31 * MINUTE);
    expect(clampDepositExpiry(NOW, 60).getTime() - NOW.getTime()).toBe(60 * MINUTE);
    expect(clampDepositExpiry(NOW, 1440).getTime() - NOW.getTime()).toBe((23 * 60 + 59) * MINUTE);
  });

  test("the words sent with a link name no treatment, amount or time, and only an https link is accepted", () => {
    const text = depositLinkText("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(text).toBe(
      "To hold your appointment, please pay the deposit through this secure link: https://checkout.stripe.com/c/pay/cs_test_1",
    );
    expect(() => depositLinkText("http://checkout.stripe.com/c/pay/cs_test_1")).toThrow();
    expect(() => depositLinkText("javascript:alert(1)")).toThrow();
  });
});

describeDb(
  "createDepositLink, against the database and a recording Stripe",
  DB_TEST_OPTIONS,
  () => {
    let fake: StripeFake;
    let sessions = 0;

    beforeAll(async () => {
      await runMigrations();
    }, 60_000);

    beforeEach(async () => {
      await truncateAll();
      vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
      sessions = 0;
      fake = createStripeFake({
        "checkout.sessions.create": (params: unknown) => {
          sessions += 1;
          const expiresAt = (params as { expires_at: number }).expires_at;
          return {
            id: `cs_test_${sessions}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_${sessions}`,
            status: "open",
            expires_at: expiresAt,
          };
        },
        "checkout.sessions.retrieve": (id: unknown) => ({
          id,
          url: `https://checkout.stripe.com/c/pay/${String(id)}`,
          status: "open",
          payment_status: "unpaid",
          expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
        }),
        "checkout.sessions.expire": (id: unknown) => ({ id, status: "expired" }),
      });
      __setStripeForTests(fake.stripe);
    });

    afterEach(() => {
      __setStripeForTests(null);
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      await closePools();
    });

    /** A clinic that takes deposits: connected, switched on, with a hold and a service list. */
    async function depositClinic(
      label: string,
      opts: { hold?: number; services?: string[]; connected?: boolean; enabled?: boolean } = {},
    ) {
      const c = await seedClinic(label);
      if (opts.connected !== false) {
        await getMigratorPool().query(
          `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = now() where id = $1`,
          [c.clinicId, ACCOUNT],
        );
      }
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, deposits_enabled, deposit_hold_minutes) values ($1, $2, $3)`,
          [c.clinicId, opts.enabled !== false, opts.hold ?? 60],
        ),
      );
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        updateAgentConfig(tx, {
          greeting: "Hi",
          services: (opts.services ?? ["Chemical peel", "Consultation"]).map((name) => ({
            name,
            priceFromUsd: null,
            priceToUsd: null,
            durationMinutes: 30,
            depositUsd: 75,
          })),
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: null,
        }),
      );
      return c;
    }

    let phone = 0;
    async function appointment(
      clinicId: string,
      depositUsd: string | null = "75.00",
    ): Promise<string> {
      phone += 1;
      return inTenant(clinicId, async (client) => {
        const { rows: contact } = await client.query<{ id: string }>(
          `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
          [clinicId, `+1555010${String(1000 + phone)}`],
        );
        const { rows } = await client.query<{ id: string }>(
          `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, deposit_usd, deposit_status) values ($1, $2, $3, 'Chemical peel', $4, 'none') returning id`,
          [clinicId, contact[0]!.id, new Date(NOW.getTime() + 3 * 24 * 60 * MINUTE), depositUsd],
        );
        return rows[0]!.id;
      });
    }

    const deposits = (clinicId: string) =>
      inTenant(clinicId, (client) =>
        client.query<{
          id: string;
          status: string;
          checkout_session_id: string | null;
          expires_at: Date;
          amount_cents: number;
          stripe_account_id: string;
          channel: string;
        }>(
          `select id, status, checkout_session_id, expires_at, amount_cents, stripe_account_id, channel from deposit_payments order by created_at`,
        ),
      );
    const depositStatus = async (clinicId: string, appointmentId: string) =>
      (
        await inTenant(clinicId, (client) =>
          client.query<{ deposit_status: string }>(
            `select deposit_status from appointments where id = $1`,
            [appointmentId],
          ),
        )
      ).rows[0]!.deposit_status;

    test("a card-only Checkout on the clinic's own account, carrying an amount, a generic product and one opaque reference", async () => {
      const c = await depositClinic("link-shape");
      const appt = await appointment(c.clinicId);
      const result = await createDepositLink(c.clinicId, appt, { channel: "web", now: NOW });
      const [row] = (await deposits(c.clinicId)).rows;
      expect(result).toEqual({
        status: "open",
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        depositId: row!.id,
        expiresAt: new Date(NOW.getTime() + 60 * MINUTE),
        amountCents: 7500,
        reused: false,
      });
      expect(row).toMatchObject({
        status: "open",
        checkout_session_id: "cs_test_1",
        amount_cents: 7500,
        stripe_account_id: ACCOUNT,
        channel: "web",
      });
      expect(await depositStatus(c.clinicId, appt)).toBe("pending_link");

      const [call] = fake.callsTo("checkout.sessions.create");
      const [params, options] = call!.args as [Record<string, unknown>, Record<string, unknown>];
      expect(params).toEqual({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 7500,
              product_data: { name: "Appointment deposit" },
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          statement_descriptor_suffix: "DEPOSIT",
          metadata: { hd: "deposit", ref: row!.id },
        },
        client_reference_id: row!.id,
        metadata: { hd: "deposit", ref: row!.id },
        expires_at: Math.floor((NOW.getTime() + 60 * MINUTE) / 1000),
        success_url: "https://app.healdesk.test/deposit/thanks",
        cancel_url: "https://app.healdesk.test/deposit/cancelled",
      });
      expect(options).toMatchObject({
        stripeAccount: ACCOUNT,
        idempotencyKey: `hd-deposit:${row!.id}`,
      });
      // Nothing about the treatment, the patient or the time reaches Stripe.
      expect(JSON.stringify(params)).not.toMatch(/peel|Chemical|\+1555|2026-10-09/i);
    });

    test("never on a call: the ledger refuses a link for any channel but website chat and Meta", async () => {
      // BAA 1.3.0 release gate 10 (docs/counsel/agreement-changes.md § 12.14):
      // links only in website chat and on Meta. The type allows only those two;
      // this is the check behind it, and createDepositLink's first write meets
      // it before Stripe is called.
      const c = await depositClinic("link-not-on-a-call");
      const insert = (channel: string) =>
        inTenant(c.clinicId, (client) =>
          client.query(
            `insert into deposit_payments (clinic_id, channel, amount_cents, stripe_account_id, status)
             values ($1, $2, 7500, $3, 'creating')`,
            [c.clinicId, channel, ACCOUNT],
          ),
        );
      await expect(insert("voice")).rejects.toMatchObject({
        code: "23514",
        constraint: "deposit_payments_channel_check",
      });
      await expect(insert("web")).resolves.toBeDefined();
      await expect(insert("meta")).resolves.toBeDefined();
      expect(sessions).toBe(0);
    });

    test("one live link per appointment: a second request gets the same open session back", async () => {
      const c = await depositClinic("link-once");
      const appt = await appointment(c.clinicId);
      const first = await createDepositLink(c.clinicId, appt, { channel: "meta", now: NOW });
      const second = await createDepositLink(c.clinicId, appt, {
        channel: "meta",
        now: new Date(NOW.getTime() + MINUTE),
      });
      expect(second).toMatchObject({
        status: "open",
        url: first.status === "open" ? first.url : "",
        reused: true,
      });
      expect(fake.callsTo("checkout.sessions.create")).toHaveLength(1);
      expect(fake.callsTo("checkout.sessions.retrieve")[0]!.args[2]).toMatchObject({
        stripeAccount: ACCOUNT,
      });
      expect((await deposits(c.clinicId)).rows).toHaveLength(1);
    });

    test("the expiry is clamped when the row is written and reused when a crashed attempt is resumed", async () => {
      const short = await depositClinic("link-short", { hold: 30 });
      const apptShort = await appointment(short.clinicId);
      await createDepositLink(short.clinicId, apptShort, { channel: "web", now: NOW });
      expect((await deposits(short.clinicId)).rows[0]!.expires_at.getTime() - NOW.getTime()).toBe(
        31 * MINUTE,
      );

      const long = await depositClinic("link-long", { hold: 1440 });
      const apptLong = await appointment(long.clinicId);
      // An earlier attempt committed its row and died before Stripe answered.
      const fixed = new Date(NOW.getTime() + (23 * 60 + 59) * MINUTE);
      const crashed = await inTenant(
        long.clinicId,
        async (client) =>
          (
            await client.query<{ id: string }>(
              `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, expires_at) values ($1, $2, 'web', 7500, $3, 'creating', $4) returning id`,
              [long.clinicId, apptLong, ACCOUNT, fixed],
            )
          ).rows[0]!.id,
      );
      const resumed = await createDepositLink(long.clinicId, apptLong, {
        channel: "web",
        now: new Date(NOW.getTime() + 5 * MINUTE),
      });
      expect(resumed).toMatchObject({ status: "open", depositId: crashed, expiresAt: fixed });
      const [, call] = fake.callsTo("checkout.sessions.create");
      expect((call!.args[0] as { expires_at: number }).expires_at).toBe(
        Math.floor(fixed.getTime() / 1000),
      );
      expect(call!.args[1]).toMatchObject({ idempotencyKey: `hd-deposit:${crashed}` });
      expect((await deposits(long.clinicId)).rows).toHaveLength(1);
    });

    test("refused without deposits, a connection, an amount or the appointment, before anything reaches Stripe", async () => {
      const off = await depositClinic("link-off", { enabled: false });
      expect(
        await createDepositLink(off.clinicId, await appointment(off.clinicId), {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "deposits_off" });
      const loose = await depositClinic("link-loose", { connected: false });
      expect(
        await createDepositLink(loose.clinicId, await appointment(loose.clinicId), {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "not_connected" });
      const free = await depositClinic("link-free");
      expect(
        await createDepositLink(free.clinicId, await appointment(free.clinicId, null), {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "no_amount" });
      expect(
        await createDepositLink(free.clinicId, await appointment(free.clinicId, "0.25"), {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "no_amount" });
      expect(
        await createDepositLink(free.clinicId, "00000000-0000-4000-8000-000000000009", {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "unknown_appointment" });
      vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.test");
      expect(
        await createDepositLink(free.clinicId, await appointment(free.clinicId), {
          channel: "web",
          now: NOW,
        }),
      ).toEqual({ status: "unavailable", reason: "no_public_origin" });
      expect(fake.calls).toHaveLength(0);
      expect((await deposits(free.clinicId)).rows).toHaveLength(0);
    });

    test("a service name in anything bound for Stripe fails the link rather than being stripped", async () => {
      const c = await depositClinic("link-name", { services: ["Deposit"] });
      const appt = await appointment(c.clinicId);
      expect(await createDepositLink(c.clinicId, appt, { channel: "web", now: NOW })).toEqual({
        status: "unavailable",
        reason: "treatment_name",
      });
      expect(fake.calls).toHaveLength(0);
      expect((await deposits(c.clinicId)).rows.map((r) => r.status)).toEqual(["failed"]);
    });

    test("a Stripe refusal marks the attempt failed, and the next request starts afresh under a new key", async () => {
      const c = await depositClinic("link-refused");
      const appt = await appointment(c.clinicId);
      fake.on("checkout.sessions.create", () => {
        throw stripeError("invalid_request", {
          message: "This account cannot currently make live charges.",
        });
      });
      expect(await createDepositLink(c.clinicId, appt, { channel: "web", now: NOW })).toEqual({
        status: "unavailable",
        reason: "stripe_error",
      });
      fake.on("checkout.sessions.create", () => ({
        id: "cs_test_again",
        url: "https://checkout.stripe.com/c/pay/cs_test_again",
        status: "open",
      }));
      const retried = await createDepositLink(c.clinicId, appt, { channel: "web", now: NOW });
      const rows = (await deposits(c.clinicId)).rows;
      expect(rows.map((r) => r.status)).toEqual(["failed", "open"]);
      expect(retried).toMatchObject({ status: "open", depositId: rows[1]!.id });
      const keys = fake
        .callsTo("checkout.sessions.create")
        .map((call) => (call.args[1] as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toEqual([`hd-deposit:${rows[0]!.id}`, `hd-deposit:${rows[1]!.id}`]);
    });

    test("a disconnect landing while Stripe creates the session cancels the row and expires the session", async () => {
      const c = await depositClinic("link-race");
      const appt = await appointment(c.clinicId);
      fake.on("checkout.sessions.create", async () => {
        await getMigratorPool().query(
          `update clinics set stripe_connect_account_id = null where id = $1`,
          [c.clinicId],
        );
        return {
          id: "cs_test_race",
          url: "https://checkout.stripe.com/c/pay/cs_test_race",
          status: "open",
        };
      });
      expect(await createDepositLink(c.clinicId, appt, { channel: "web", now: NOW })).toEqual({
        status: "unavailable",
        reason: "not_connected",
      });
      expect(
        fake
          .callsTo("checkout.sessions.expire")
          .map((call) => [call.args[0], (call.args[2] as { stripeAccount: string }).stripeAccount]),
      ).toEqual([["cs_test_race", ACCOUNT]]);
      expect((await deposits(c.clinicId)).rows.map((r) => r.status)).toEqual(["cancelled"]);
      expect(await depositStatus(c.clinicId, appt)).toBe("none");
    });

    test("an open session that lapsed or was paid before its webhook arrived is recorded, not reused", async () => {
      const c = await depositClinic("link-lapsed");
      const lapsed = await appointment(c.clinicId);
      await createDepositLink(c.clinicId, lapsed, { channel: "web", now: NOW });
      fake.on("checkout.sessions.retrieve", (id: unknown) => ({
        id,
        url: null,
        status: "expired",
        payment_status: "unpaid",
      }));
      expect(await createDepositLink(c.clinicId, lapsed, { channel: "web", now: NOW })).toEqual({
        status: "unavailable",
        reason: "link_lapsed",
      });
      expect((await deposits(c.clinicId)).rows.map((r) => r.status)).toEqual(["expired"]);
      expect(await depositStatus(c.clinicId, lapsed)).toBe("pending_front_desk");

      const paid = await appointment(c.clinicId);
      await createDepositLink(c.clinicId, paid, { channel: "web", now: NOW });
      fake.on("checkout.sessions.retrieve", (id: unknown) => ({
        id,
        url: null,
        status: "complete",
        payment_status: "paid",
      }));
      expect(await createDepositLink(c.clinicId, paid, { channel: "web", now: NOW })).toEqual({
        status: "unavailable",
        reason: "already_paid",
      });
      expect(await depositStatus(c.clinicId, paid)).toBe("paid");
    });
  },
);
