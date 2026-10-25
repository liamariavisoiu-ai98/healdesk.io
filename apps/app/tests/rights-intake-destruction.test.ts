import { randomUUID } from "node:crypto";

import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeAccountsDue, KEPT_FOR_GOOD } from "@/lib/offboarding/account-closure";
import { destroyDueClinics, markExportDelivered, startOffboarding } from "@/lib/offboarding/offboarding";
import { PURGE_COVERAGE } from "@/lib/retention/purge";
import { withTenant } from "@/lib/tenant";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * A clinic's patient-rights intakes (rights_intakes, drizzle/0120) go with
 * its data at destruction, open or closed, like its deletion records,
 * amendments and patient requests (owner, 25 October 2026; drizzle/0121).
 * 0120 kept them for good when the account closed. Destruction never deletes
 * the clinics row (the runtime role has no DELETE on it, 0066), so the
 * foreign key's cascade never runs: only app_destroy_rights_intakes() takes
 * them, on the destruction floor, and the destroyed stamp refuses while one
 * is left.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;

/** Offboarded, export delivered, and moved past the pass-through: due for destruction, then for closure. */
async function leave(clinicId: string): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
  await withTenant({ clinicId, actor: ACTOR }, (tx) => markExportDelivered(tx, "bundle handed over"));
  const secs = (FORWARDING_PASS_THROUGH_DAYS + 1) * 86_400;
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(secs => $2),
            destroy_after = destroy_after - make_interval(secs => $2),
            export_delivered_at = export_delivered_at - make_interval(secs => $2)
      where id = $1`,
    [clinicId, secs],
  );
}

/** One intake, as the tracker writes it; closed with `done` when asked. */
async function seedIntake(clinicId: string, closed = false): Promise<string> {
  return inTenant(clinicId, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into rights_intakes (clinic_id, request_key, kind, received_on, verified_via, due_on, recorded_by)
       values ($1, $2, 'export', current_date - 3, 'notice_address', current_date + 7, 'ops')
       returning id`,
      [clinicId, randomUUID()],
    );
    const id = rows[0]!.id;
    if (closed) await q.query(`update rights_intakes set status = 'done' where id = $1`, [id]);
    return id;
  });
}

async function intakesOf(clinicId: string): Promise<string[]> {
  return inTenant(clinicId, async (q) =>
    (await q.query<{ id: string }>(`select id from rights_intakes where clinic_id = $1 order by id`, [clinicId])).rows.map(
      (r) => r.id,
    ),
  );
}

/** One statement as the runtime role, inside the tenant, rolled back. */
async function asApp(clinicId: string, text: string, values: unknown[] = []): Promise<unknown[]> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return (await client.query(text, values)).rows;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

describeDb("patient-rights intakes at destruction (drizzle/0121)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("are destroyed with the clinic's data, not kept for good, and not left to the purge", () => {
    expect(KEPT_FOR_GOOD).not.toHaveProperty("rights_intakes");
    expect(PURGE_COVERAGE.purged).not.toHaveProperty("rights_intakes");
    expect(PURGE_COVERAGE.notPurged.rights_intakes).toMatch(/destruction/);
  });

  test("destruction takes the clinic's open and closed intakes, records itself only once they are gone, touches no other clinic's, and the account still closes", async () => {
    const leaving = await seedClinic("intakes-leaving");
    const staying = await seedClinic("intakes-staying");
    await seedIntake(leaving.clinicId);
    await seedIntake(leaving.clinicId, true);
    const theirs = [await seedIntake(staying.clinicId), await seedIntake(staying.clinicId, true)].sort();

    // Leaving but not due yet: the definer refuses, on the same floor as its
    // neighbours, and an open request's record stays until the floor.
    const early = await seedClinic("intakes-early");
    const earlyOnes = [await seedIntake(early.clinicId), await seedIntake(early.clinicId, true)].sort();
    await withTenant({ clinicId: early.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    await expect(
      asApp(early.clinicId, `select app_destroy_rights_intakes($1::uuid)`, [early.clinicId]),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/not due for destruction/) });
    // Never another tenant's.
    await expect(
      asApp(staying.clinicId, `select app_destroy_rights_intakes($1::uuid)`, [leaving.clinicId]),
    ).rejects.toMatchObject({ code: "42501" });
    // The runtime role still cannot delete one itself.
    await expect(
      asApp(leaving.clinicId, `delete from rights_intakes where clinic_id = $1`, [leaving.clinicId]),
    ).rejects.toMatchObject({ code: "42501" });
    await leave(leaving.clinicId);

    // Due, and holding nothing but its intakes: the database will not record
    // a destruction that left them.
    await expect(
      asApp(leaving.clinicId, `select app_mark_clinic_destroyed($1::uuid)`, [leaving.clinicId]),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/still holds/) });

    const results = (await destroyDueClinics()).filter((r) => r.clinicId === leaving.clinicId);
    expect(results).toHaveLength(1);
    expect(results[0]!.deleted).toMatchObject({ rights_intakes: 2 });
    expect(await intakesOf(leaving.clinicId)).toEqual([]);
    expect(await intakesOf(staying.clinicId)).toEqual(theirs);
    expect(await intakesOf(early.clinicId)).toEqual(earlyOnes);
    const { rows } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
      `select destroyed_at from clinics where id = $1`,
      [leaving.clinicId],
    );
    expect(rows[0]!.destroyed_at).not.toBeNull();

    // A destroyed clinic takes no new intake: destruction runs once, so one
    // written now would be kept for good.
    await expect(seedIntake(leaving.clinicId)).rejects.toMatchObject({
      code: "42501",
      message: expect.stringMatching(/was destroyed/),
    });

    // And the account closes, with no intake on its way out or left after.
    const run = await closeAccountsDue();
    expect(run.closed.map((c) => c.clinicId)).toContain(leaving.clinicId);
    expect(run.failed).not.toContain(leaving.clinicId);
    expect(await intakesOf(leaving.clinicId)).toEqual([]);
    expect(await intakesOf(staying.clinicId)).toEqual(theirs);
  });

  test("a closed account takes no new intake (app_refuse_after_account_closure)", async () => {
    const c = await seedClinic("intakes-closed");
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [c.clinicId]);
    await expect(seedIntake(c.clinicId)).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/account is closed/) });
  });
});
