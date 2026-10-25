import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { log } from "@/lib/log";
import { runOperation, type Operator } from "@/lib/ops/api";
import { RIGHTS_ACCOUNT_CLOSED, RIGHTS_CLINIC_DESTROYED } from "@/lib/ops/rights-ops";
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
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

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
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    const openOne = await seedIntake(leaving.clinicId);
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

    const errors = vi.spyOn(log, "error");
    const results = (await destroyDueClinics()).filter((r) => r.clinicId === leaving.clinicId);
    expect(results).toHaveLength(1);
    expect(results[0]!.deleted).toMatchObject({ rights_intakes: 2 });
    // The open one is named to ops, by id and kind only; the audit row counts both.
    const told = errors.mock.calls.filter(([message]) => /open patient-rights intakes/.test(String(message)));
    expect(told).toHaveLength(1);
    expect(told[0]![1]).toEqual({ clinicId: leaving.clinicId, count: 1, requestId: openOne, kind: "export" });
    errors.mockRestore();
    const audit = await inTenant(leaving.clinicId, async (q) =>
      (
        await q.query<{ metadata: Record<string, number> }>(
          `select metadata from audit_log where resource_type = 'clinic_destruction' and clinic_id = $1`,
          [leaving.clinicId],
        )
      ).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ rights_intakes: 2, rightsIntakesOpen: 1, rightsIntakesClosed: 1 });
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
  test("the runtime role is refused an intake for a destroyed clinic and for a closed one, and the ops operations say why with a 409", async () => {
    const destroyed = await seedClinic("intakes-app-destroyed");
    const closed = await seedClinic("intakes-app-closed");
    // One open intake each, written while the clinic was live.
    const destroyedOpen = await seedIntake(destroyed.clinicId);
    const closedOpen = await seedIntake(closed.clinicId);
    await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [destroyed.clinicId]);
    await getMigratorPool().query(`update clinics set destroyed_at = now(), account_closed_at = now() where id = $1`, [closed.clinicId]);

    const insertAsApp = (clinicId: string) =>
      asApp(
        clinicId,
        `insert into rights_intakes (clinic_id, request_key, kind, received_on, verified_via, due_on, recorded_by)
         values ($1, $2, 'export', current_date - 3, 'notice_address', current_date + 7, 'ops')`,
        [clinicId, randomUUID()],
      );
    // rights_intakes_guard reads the clinic's row FOR SHARE against the
    // stamp's FOR UPDATE, so the refusal holds under a race too.
    await expect(insertAsApp(destroyed.clinicId)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/was destroyed/) });
    // A closed clinic was destroyed first; either refusal is the database's.
    await expect(insertAsApp(closed.clinicId)).rejects.toMatchObject({ message: expect.stringMatching(/was destroyed|account is closed/) });

    const record = (clinicId: string) =>
      runOperation(
        "recordRightsIntake",
        { clinicId, requestKey: randomUUID(), kind: "export", receivedOn: new Date().toISOString().slice(0, 10), verifiedVia: "notice_address" },
        OPERATOR,
      );
    expect(await record(destroyed.clinicId)).toEqual({ status: 409, body: { error: RIGHTS_CLINIC_DESTROYED, code: "invalid_args" } });
    expect(await record(closed.clinicId)).toEqual({ status: 409, body: { error: RIGHTS_ACCOUNT_CLOSED, code: "invalid_args" } });
    const close = (clinicId: string, id: string) =>
      runOperation("closeRightsIntake", { clinicId, id, status: "done" }, OPERATOR);
    expect(await close(destroyed.clinicId, destroyedOpen)).toEqual({ status: 409, body: { error: RIGHTS_CLINIC_DESTROYED, code: "invalid_args" } });
    expect(await close(closed.clinicId, closedOpen)).toEqual({ status: 409, body: { error: RIGHTS_ACCOUNT_CLOSED, code: "invalid_args" } });
  });

  test("0121 deletes the intakes left at clinics destroyed or closed while 0120 was live, and only theirs, and runs again harmlessly", async () => {
    const sql = readFileSync(join(__dirname, "..", "drizzle", "0121_rights_intakes_destroyed.sql"), "utf8");
    const block = sql.slice(sql.indexOf("-- BEGIN leftover-intakes"), sql.indexOf("-- END leftover-intakes"));
    expect(block).toMatch(/DELETE FROM rights_intakes/);
    const destroyed = await seedClinic("intakes-left-destroyed");
    const closed = await seedClinic("intakes-left-closed");
    const live = await seedClinic("intakes-left-live");
    await seedIntake(destroyed.clinicId);
    await seedIntake(destroyed.clinicId, true);
    await seedIntake(closed.clinicId);
    const kept = [await seedIntake(live.clinicId), await seedIntake(live.clinicId, true)].sort();
    // As 0120 left them: destroyed and closed with their intakes still there.
    await getMigratorPool().query(`update clinics set destroyed_at = now() where id = $1`, [destroyed.clinicId]);
    await getMigratorPool().query(`update clinics set destroyed_at = now(), account_closed_at = now() where id = $1`, [closed.clinicId]);
    expect(await intakesOf(destroyed.clinicId)).toHaveLength(2);

    await getMigratorPool().query(block);
    expect(await intakesOf(destroyed.clinicId)).toEqual([]);
    expect(await intakesOf(closed.clinicId)).toEqual([]);
    expect(await intakesOf(live.clinicId)).toEqual(kept);
    await getMigratorPool().query(block);
    expect(await intakesOf(live.clinicId)).toEqual(kept);
  });

  test("0121 pins the guard's search_path and zone, and only the runtime role may call the definer", async () => {
    const { rows } = await getMigratorPool().query<{ config: string[] | null }>(
      `select proconfig as config from pg_proc where oid = 'rights_intakes_guard()'::regprocedure`,
    );
    expect(rows[0]!.config).toEqual(expect.arrayContaining(["search_path=public, pg_temp", "TimeZone=UTC"]));
    const { rows: grants } = await getMigratorPool().query<{ app: boolean; anyone: boolean; readonly: boolean; del: boolean }>(
      `select has_function_privilege('healdesk_app', 'app_destroy_rights_intakes(uuid)'::regprocedure, 'EXECUTE') as app,
              has_function_privilege('public', 'app_destroy_rights_intakes(uuid)'::regprocedure, 'EXECUTE') as anyone,
              has_function_privilege('healdesk_readonly', 'app_destroy_rights_intakes(uuid)'::regprocedure, 'EXECUTE') as readonly,
              has_table_privilege('healdesk_app', 'rights_intakes'::regclass, 'DELETE') as del`,
    );
    expect(grants[0]).toEqual({ app: true, anyone: false, readonly: false, del: false });
  });
});
