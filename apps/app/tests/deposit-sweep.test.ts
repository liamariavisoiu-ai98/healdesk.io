import { setGoogleTimeouts, type FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * DEPOSIT-01's crash gap: a website chat booking that owes a deposit is
 * written owing it (`pending_link`, with its amount) in the booking's own
 * transaction, before its link is made; a link never made is handed to the
 * front desk by the sweep, once, and never sent to the patient late. The
 * booking goes through the real engine against the Google fake; Stripe is
 * the recording fake. Everything synthetic.
 */

const state = vi.hoisted(() => ({
  alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, unknown> }>,
}));
// The direct-booking switch is three facts (lib/booking/direct-switch.ts, DB-1):
// the owner's env var, the owner's release of the addendum (28 October 2026)
// and the deployed addendum version. The committed catalog now has the addendum
// released, so this mock is redundant but harmless: it pins the release in this
// test process, so these suites book as production does once all three are set.
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: true }),
  };
});
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (tx: { clinicId: string }, kind: string, ref: Record<string, unknown>) => {
    state.alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));

import type { AgentService } from "@/db/schema";
import { flagUnlinkedDepositsFor, sweepUnlinkedDeposits, UNLINKED_DEPOSIT_GRACE_MS } from "@/lib/billing/deposit-sweep";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { chatDepositFor } from "@/lib/booking/deposit-gate";
import { bookConversation } from "@/lib/booking/engine";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { deskLocation, deskTime, freshGoogle, installGoogleEnv, restoreGoogleEnv } from "./setup/desk-calendar";
import { inTenant } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "test" } as const;
const PEEL: AgentService = { name: "Chemical peel", priceFromUsd: 150, priceToUsd: 250, durationMinutes: 60, depositUsd: 75 };

describeDb("a chat deposit whose link is never made", () => {
  let google: FakeGoogleCalendar;
  let sessions = 0;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
    state.alerts.length = 0;
    sessions = 0;
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    vi.stubEnv("HEALDESK_DIRECT_BOOKING_ENABLED", "true");
    vi.stubEnv("HEALDESK_DIRECT_BOOKING_ADDENDUM", "direct-booking-addendum/1.0.0");
    __setStripeForTests(
      createStripeFake({
        "checkout.sessions.create": (params: unknown) => {
          sessions += 1;
          return {
            id: `cs_test_${sessions}`,
            url: `https://checkout.stripe.com/c/pay/cs_test_${sessions}`,
            status: "open",
            expires_at: (params as { expires_at: number }).expires_at,
          };
        },
      }).stripe,
    );
  });

  afterEach(() => {
    setGoogleTimeouts(undefined);
    __setStripeForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  /** A live location taking chat deposits: covered, connected to Google and to Stripe, deposits on. */
  async function location(label: string) {
    const f = await deskLocation(google, label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(),
              stripe_connect_account_id = 'acct_1Sweep', stripe_connect_connected_at = now() where id = $1`,
      [f.clinicId],
    );
    await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [PEEL],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    await inTenant(f.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, deposits_enabled) values ($1, true)
         on conflict (clinic_id) do update set deposits_enabled = true`,
        [f.clinicId],
      ),
    );
    return f;
  }

  const chatBooking = (clinicId: string, conversation: string) =>
    bookConversation(clinicId, {
      channel: "web_chat",
      holderKey: `web:${conversation}`,
      bookingKey: `web:${conversation}:1`,
      startsAt: deskTime(3, 10),
      firstName: "Ana",
      phoneE164: "+14155550177",
      service: "Chemical peel",
      budgetMs: 20_000,
    });

  const appointmentsOf = async (clinicId: string) =>
    (
      await inTenant(clinicId, (client) =>
        client.query<{ id: string; deposit_status: string; deposit_usd: string | null }>(
          `select id, deposit_status, deposit_usd from appointments order by created_at`,
        ),
      )
    ).rows;
  const depositRows = async (clinicId: string) =>
    (
      await inTenant(clinicId, (client) =>
        client.query<{ status: string }>(`select status from deposit_payments order by created_at`),
      )
    ).rows;
  const alertsOf = (clinicId: string) =>
    state.alerts.filter((a) => a.clinicId === clinicId).map(({ kind, ref }) => ({ kind, ref }));
  const afterGrace = () => new Date(Date.now() + UNLINKED_DEPOSIT_GRACE_MS + 60_000);

  test(
    "the booking commits owing its deposit before any link exists; the sweep leaves it inside the grace, then flags it once",
    async () => {
      const f = await location("sweep-crash");
      const booked = await chatBooking(f.clinicId, "crash-1");
      expect(booked).toMatchObject({ kind: "booked" });

      // The process dies here: chatDepositFor never runs.
      const [appt] = await appointmentsOf(f.clinicId);
      expect(appt).toMatchObject({ deposit_status: "pending_link", deposit_usd: "75.00" });
      expect(await depositRows(f.clinicId)).toEqual([]);
      expect(alertsOf(f.clinicId)).toEqual([]);

      // Inside the grace the chat may still be making its link: nothing moves.
      expect(await flagUnlinkedDepositsFor(f.clinicId, new Date())).toBe(0);
      expect((await appointmentsOf(f.clinicId))[0]!.deposit_status).toBe("pending_link");

      const first = await sweepUnlinkedDeposits(afterGrace());
      expect(first).toMatchObject({ flagged: 1, failures: 0 });
      expect((await appointmentsOf(f.clinicId))[0]).toMatchObject({
        deposit_status: "pending_front_desk",
        deposit_usd: "75.00",
      });
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "deposit_to_collect", ref: { appointmentId: appt!.id } },
      ]);
      // Flagged, never linked late: no Stripe session was made for it.
      expect(sessions).toBe(0);
      expect(await depositRows(f.clinicId)).toEqual([]);

      // Twice changes nothing: one flag per booking.
      expect(await sweepUnlinkedDeposits(afterGrace())).toMatchObject({ flagged: 0, failures: 0 });
      expect((await appointmentsOf(f.clinicId))[0]!.deposit_status).toBe("pending_front_desk");
      expect(alertsOf(f.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a normal run opens the link, and the sweep, run twice, finds nothing to flag",
    async () => {
      const f = await location("sweep-normal");
      const booked = await chatBooking(f.clinicId, "normal-1");
      expect(booked).toMatchObject({ kind: "booked" });
      const appointmentId = (booked as { appointmentId: string }).appointmentId;

      const deposit = await chatDepositFor(f.clinicId, appointmentId, { channel: "web", actor: ACTOR });
      expect(deposit).toMatchObject({ kind: "link", reused: false });
      expect(await depositRows(f.clinicId)).toEqual([{ status: "open" }]);

      for (let run = 0; run < 2; run += 1) {
        expect(await flagUnlinkedDepositsFor(f.clinicId, afterGrace())).toBe(0);
      }
      expect((await appointmentsOf(f.clinicId))[0]!.deposit_status).toBe("pending_link");
      expect(alertsOf(f.clinicId)).toEqual([]);
      expect(sessions).toBe(1);
    },
    SLOW,
  );

  test(
    "a link attempt that left only a `creating` row (a crash mid-Stripe) is flagged once its grace has passed",
    async () => {
      const f = await location("sweep-creating");
      const booked = await chatBooking(f.clinicId, "creating-1");
      const appointmentId = (booked as { appointmentId: string }).appointmentId;
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, currency, stripe_account_id, status, expires_at)
           values ($1, $2, 'web', 7500, 'usd', 'acct_1Sweep', 'creating', now() + interval '1 hour')`,
          [f.clinicId, appointmentId],
        ),
      );
      expect(await flagUnlinkedDepositsFor(f.clinicId, afterGrace())).toBe(1);
      expect(await flagUnlinkedDepositsFor(f.clinicId, afterGrace())).toBe(0);
      expect((await appointmentsOf(f.clinicId))[0]!.deposit_status).toBe("pending_front_desk");
      expect(alertsOf(f.clinicId)).toEqual([{ kind: "deposit_to_collect", ref: { appointmentId } }]);
    },
    SLOW,
  );
});
