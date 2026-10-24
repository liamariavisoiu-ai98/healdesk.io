import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runOperation } from "@/lib/ops/api";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * The Touch log takes a note for every clinic (lane N3): ten alerts tell the
 * operator to note what they did there, and the form used to show only for a
 * production clinic in its first sixty days live. A note is our words about
 * the account, never a patient (patient details are still refused), and
 * lib/retention/purge.ts keeps it until the account closes, so a clinic not
 * live yet, synthetic, long live, leaving or destroyed takes one; a clinic
 * whose account is closed does not, because app_close_clinic_account deleted
 * its notes once and a new one would outlive the closure for good.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR = { email: "ops@healdesk.test", request: {} };

async function touch(clinicId: string, summary = "Phoned the manager about forwarding.") {
  const outcome = await runOperation("recordClinicTouch", { clinicId, kind: "call", summary }, OPERATOR);
  return (outcome.body as { data: { status: string; message?: string } }).data;
}

/** Forced row-level security hides the rows even from the owner without the tenant set. */
async function touches(clinicId: string): Promise<number> {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from clinic_touches where clinic_id = $1`,
      [clinicId],
    );
    await client.query("commit");
    return rows[0]!.n;
  } finally {
    client.release();
  }
}

describeDb("the Touch log for every clinic", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("a clinic not live, long live, leaving or destroyed takes a note", async () => {
    const notLive = await seedClinic("touch-not-live");
    const longLive = await seedClinic("touch-long-live");
    const destroyed = await seedClinic("touch-destroyed");
    const migrator = getMigratorPool();
    await migrator.query(`update clinics set went_live_at = now() - interval '200 days' where id = $1`, [longLive.clinicId]);
    await migrator.query(
      `update clinics set offboarding_started_at = now() - interval '40 days', destroyed_at = now() - interval '1 day' where id = $1`,
      [destroyed.clinicId],
    );
    for (const clinic of [notLive, longLive, destroyed]) {
      expect(await touch(clinic.clinicId), clinic.clinicId).toEqual({ status: "updated" });
      expect(await touches(clinic.clinicId)).toBe(1);
    }
    // Patient details are still refused, whatever the clinic's state.
    const phi = await touch(longLive.clinicId, "Spoke about jane@example.com's booking");
    expect(phi.status).toBe("error");
    expect(await touches(longLive.clinicId)).toBe(1);
  });

  test("a clinic whose account is closed takes none, and says why", async () => {
    const closed = await seedClinic("touch-closed");
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [closed.clinicId]);
    const refused = await touch(closed.clinicId);
    expect(refused.status).toBe("error");
    expect(refused.message).toMatch(/account is closed/);
    expect(await touches(closed.clinicId)).toBe(0);
  });
});
