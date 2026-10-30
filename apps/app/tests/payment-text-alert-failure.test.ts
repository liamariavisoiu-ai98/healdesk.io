import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { EMPTY_TOOL_STATE, type BookingToolState } from "@/lib/assistant/booking-tools";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { supersededReason } from "@/lib/email/superseded";
import { dedupeKey, notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import { callRefHash, PAYMENT_TEXT_LINES_EN, paymentTextTools, type PaymentTextDeps } from "@/lib/sms/payment-text";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

/**
 * The payment-link text's possibly-paid alert, when it cannot be queued
 * (notifyBookingAlert never throws; it answers false). The plain "collect"
 * email must then still go: a plain email beats none. Synthetic data only.
 */

const failPossiblyPaid = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/notices/booking-alerts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/notices/booking-alerts")>();
  return {
    ...real,
    notifyBookingAlert: (async (...args: Parameters<typeof real.notifyBookingAlert>) => {
      if (failPossiblyPaid.on && args[2]?.mayBePaid) return false;
      return real.notifyBookingAlert(...args);
    }) as typeof real.notifyBookingAlert,
  };
});

const opsCalls = vi.hoisted(() => [] as Array<{ event: string; fields: Record<string, unknown> }>);
vi.mock("@/lib/ops/notify", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ops/notify")>();
  return {
    ...real,
    notifyOps: (async (event: string, fields: Record<string, unknown>) => {
      opsCalls.push({ event, fields });
    }) as unknown as typeof real.notifyOps,
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const NOW = new Date("2026-10-30T18:00:00Z");

describeDb("a text left queued whose possibly-paid alert cannot be queued", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);
  beforeEach(async () => {
    await truncateAll();
    failPossiblyPaid.on = false;
    opsCalls.length = 0;
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePools();
  });

  test("the plain 'collect' email is not closed: it still goes", async () => {
    const c = await seedClinic("text-alert-fail");
    const appointmentId = await inTenant(c.clinicId, async (client) => {
      const { rows: contact } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, '+14155550142') returning id`,
        [c.clinicId],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, deposit_usd, deposit_status)
         values ($1, $2, $3, 'Chemical peel', '75.00', 'pending_link') returning id`,
        [c.clinicId, contact[0]!.id, new Date(NOW.getTime() + 3 * 86_400_000)],
      );
      await client.query(
        `insert into payment_link_texts (clinic_id, appointment_id, call_ref_hash, status, opted_in_at, confirmed_at, created_at)
         values ($1, $2, $3, 'queued', $4, $4, $4)`,
        [c.clinicId, rows[0]!.id, callRefHash("call_fail"), NOW],
      );
      return rows[0]!.id;
    });
    const payload = { appointmentId, isPossiblyPaid: false };
    failPossiblyPaid.on = true;
    const reason = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", payload));
    expect(reason).toBeNull();
    // A person is told, once, with no patient detail.
    expect(opsCalls).toEqual([{ event: "payment_text_not_sent", fields: { clinicId: c.clinicId, code: "unannounced" } }]);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", payload));
    expect(opsCalls).toHaveLength(1);
    // With the alert queued, the plain one would be closed instead.
    failPossiblyPaid.on = false;
    await inTenant(c.clinicId, (client) =>
      client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]),
    );
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", payload)),
    ).toMatch(/outcome is unknown/);
  });

  test("a text AWS did not answer, whose possibly-paid alert cannot be queued: the plain email is released, not closed, and ops are told", async () => {
    const c = await seedClinic("text-unknown-fail");
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_1AlertFail', stripe_connect_connected_at = now(), agreement_kind = 'baa' where id = $1`,
      [c.clinicId],
    );
    await bindAgreementInEffect(c.clinicId, "1.6.0");
    await inTenant(c.clinicId, (client) =>
      client.query(`insert into clinic_settings (clinic_id, deposits_enabled, deposit_hold_minutes) values ($1, true, 60)`, [c.clinicId]),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Chemical peel", priceFromUsd: null, priceToUsd: null, durationMinutes: 30, depositUsd: 75 }],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: null,
      }),
    );
    const appointmentId = await inTenant(c.clinicId, async (client) => {
      const { rows: contact } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, '+14155550142') returning id`,
        [c.clinicId],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, deposit_usd, deposit_status)
         values ($1, $2, $3, 'Chemical peel', '75.00', 'pending_front_desk') returning id`,
        [c.clinicId, contact[0]!.id, new Date(NOW.getTime() + 3 * 86_400_000)],
      );
      return rows[0]!.id;
    });
    // The booking's plain L10, held while the text is offered.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "deposit_to_collect", { appointmentId }));
    await inTenant(c.clinicId, (client) =>
      client.query(`update billing_notices set send_after = $2 where clinic_id = $1`, [c.clinicId, new Date(NOW.getTime() + 300_000)]),
    );
    const fake = createStripeFake({
      "checkout.sessions.create": (params: unknown) => ({
        id: "cs_test_fail",
        url: "https://checkout.stripe.com/c/pay/cs_test_fail",
        status: "open",
        expires_at: (params as { expires_at: number }).expires_at,
      }),
    });
    __setStripeForTests(fake.stripe);
    const notified: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const notify = (async (event: string, fields: Record<string, unknown>) => {
      notified.push({ event, fields });
    }) as unknown as NonNullable<PaymentTextDeps["notify"]>;
    failPossiblyPaid.on = true;
    try {
      const t = paymentTextTools(
        { clinicId: c.clinicId, callId: "call_unknown_fail" },
        {
          offered: async () => true,
          env: { HEALDESK_SMS_ORIGINATION_IDENTITY: "phone-0123456789abcdef0123456789abcdef" },
          notify,
          realCalls: true,
          smsDeadlineMs: 50,
          transport: () => new Promise(() => undefined),
        },
      );
      const state: BookingToolState = {
        ...EMPTY_TOOL_STATE,
        text: { stage: "confirming", appointmentId, number: "+14155550142", optedInAt: new Date(NOW.getTime() + 5000).toISOString(), unanswered: 0 },
      };
      const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: new Date(NOW.getTime() + 15_000) });
      expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.unsure);
    } finally {
      __setStripeForTests(null);
    }
    const rows = await inTenant(c.clinicId, (client) =>
      client.query<{ dedupe_key: string; sent_at: Date | null; send_after: Date }>(
        `select dedupe_key, sent_at, send_after from billing_notices where kind = 'deposit_to_collect' order by created_at`,
      ),
    ).then((r) => r.rows);
    // Only the plain one exists, unsent, and due now: it goes.
    expect(rows.map((r) => [r.dedupe_key, r.sent_at])).toEqual([[dedupeKey("deposit_to_collect", { appointmentId }), null]]);
    expect(rows[0]!.send_after).toEqual(new Date(NOW.getTime() + 15_000));
    expect(notified).toEqual([{ event: "payment_text_not_sent", fields: { clinicId: c.clinicId, code: "unannounced" } }]);
  });
});
