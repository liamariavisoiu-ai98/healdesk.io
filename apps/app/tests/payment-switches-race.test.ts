import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { markCalendarBrokenWithin } from "@/lib/connections/google-calendar";
import { saveSetting, type SettingContext } from "@/lib/portal/settings";
import { UNLOCK_REASONS } from "@/lib/portal/switch-rules";
import { withTenant } from "@/lib/tenant";

import { insertGoogleConnection } from "./setup/calendar-db";
import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The invariant "never full payment with Auto-confirm off" (or with the
 * calendar gone) under two transactions at once (fix lane 1, R2). A second
 * session plays the other writer by hand, holding the payment-facts lock
 * (lockAutoConfirm, `auto-confirm:<clinic>`) as every real writer does, and
 * commits its half while the writer under test waits: the writer must read
 * what that session committed, not what stood before it. Without the lock
 * in writeDepositSettings and applySwitchResets both cases below commit
 * full payment with the fact it needs already gone. Synthetic data only.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "payment-race-test" } as const;
const NOW = new Date("2026-10-28T16:00:00Z");

let clinic: PortalClinic;

function ctxFor(c: PortalClinic): SettingContext {
  return { clinicId: c.clinicId, userId: c.userId, actorLabel: "Front desk Mac", steppedUp: false };
}

async function migrator(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query(text, values)).rows;
}

async function switches(clinicId: string) {
  const rows = await inTenant(clinicId, async (c) =>
    (
      await c.query<{ payment_ask: string; auto_confirm_bookings: boolean }>(
        `select payment_ask, auto_confirm_bookings from clinic_settings where clinic_id = $1`,
        [clinicId],
      )
    ).rows,
  );
  return rows[0]!;
}

/** Wait until some session is waiting on an advisory lock: the writer under test reached it. */
async function untilWaitingOnLock(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await migrator(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
    );
    if (row.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The writer never waited on the payment-facts lock.");
}

/** A second session holding the payment-facts lock, in an open transaction. */
async function otherWriter(clinicId: string): Promise<PoolClient> {
  const client = await getMigratorPool().connect();
  await client.query("begin");
  // Row security holds for this role too: the tenant, as withTenant sets it.
  await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `auto-confirm:${clinicId}`,
  ]);
  return client;
}

describeDb("payment switches under concurrent writers", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  });

  beforeEach(async () => {
    clinic = await provisionPortalClinic("payrace", { plan: "voice-webchat-1000-1000" });
    await migrator(
      `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
      [clinic.clinicId, `acct_1Race${clinic.clinicId.slice(0, 8)}`, new Date("2026-10-01T00:00:00Z")],
    );
    await inTenant(clinic.clinicId, async (q) => {
      await q.query(
        `update agent_configs set services = '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30,"depositUsd":50}]'::jsonb where clinic_id = $1`,
        [clinic.clinicId],
      );
    });
    // A settings row to race on.
    // (Off: the text cannot be turned on while no sender exists; switch-rules.ts.)
    expect(await saveSetting(ctxFor(clinic), "text_payment_link", false, NOW)).toMatchObject({ ok: true });
  });

  afterAll(async () => {
    await closePools();
  });

  test("full payment saved while Auto-confirm goes off is refused once the switch commits", async () => {
    await insertGoogleConnection(clinic.clinicId, { managed: true });
    const other = await otherWriter(clinic.clinicId);
    try {
      // setAutoConfirm's half: Auto-confirm off, its reset already run and
      // finding deposit only. Not committed yet.
      await other.query(
        `update clinic_settings set auto_confirm_bookings = false,
            auto_confirm_changed_at = $2, auto_confirm_changed_by_label = 'Front desk iPad'
          where clinic_id = $1`,
        [clinic.clinicId, NOW],
      );
      // The page still shows full payment as available: the pre-check passes.
      const saving = saveSetting(ctxFor(clinic), "payment_ask", "full_payment", NOW);
      await untilWaitingOnLock();
      await other.query("commit");
      // Refused by the one writer itself, under the lock (its own field name).
      expect(await saving).toEqual({
        ok: false,
        field: "paymentAsk",
        message: UNLOCK_REASONS.turn_on_auto_confirm,
      });
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    expect(await switches(clinic.clinicId)).toEqual({
      payment_ask: "deposit_only",
      auto_confirm_bookings: false,
    });
  });

  test("a calendar break that waits for a full-payment save resets what that save committed", async () => {
    const connection = await insertGoogleConnection(clinic.clinicId, { managed: true });
    const other = await otherWriter(clinic.clinicId);
    let breaking: Promise<unknown> | null = null;
    try {
      // writeDepositSettings' half: full payment passed its rules and is
      // written, not committed yet.
      await other.query(`update clinic_settings set payment_ask = 'full_payment' where clinic_id = $1`, [
        clinic.clinicId,
      ]);
      breaking = withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
        markCalendarBrokenWithin(tx, {
          code: "calendar_not_found",
          connectionId: connection!.id,
          credentialVersion: "x",
        }),
      );
      await untilWaitingOnLock();
      await other.query("commit");
      await breaking;
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
    }
    expect((await switches(clinic.clinicId)).payment_ask).toBe("deposit_only");
  });
});
