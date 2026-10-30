import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { supersededReason } from "@/lib/email/superseded";
import { callRefHash } from "@/lib/sms/payment-text";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

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
    // With the alert queued, the plain one would be closed instead.
    failPossiblyPaid.on = false;
    await inTenant(c.clinicId, (client) =>
      client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]),
    );
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", payload)),
    ).toMatch(/outcome is unknown/);
  });
});
