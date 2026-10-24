import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ChangeRefused, runChange, runParsed } from "../scripts/db-apply-lib";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase } from "./setup/db";
import { inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * Lane B, E4-7: the database's safety net. An ops change file run through
 * db-apply (owner decision D8 keeps them on clinic_closures,
 * clinic_providers and clinic_provider_services) writes no change of its
 * own, so the statement trigger of drizzle/0114 records one count-only
 * `direct` row per clinic per statement: one run, one row. A dry run (rolled
 * back) leaves none; the app's own sessions are left to record their own,
 * and so is a transaction that already wrote that clinic's change row, which
 * the change file's role cannot do. No setting hides a change: the role can
 * set app.change_emitted, and it changes nothing. Run as the db-apply task's
 * role (TEST_WRITER_URL), against the real migrations.
 */

const WRITER_URL = process.env.TEST_WRITER_URL;
const describeDb = hasTestDatabase && WRITER_URL ? describe : describe.skip;

describeDb("a change file's edit is recorded as a direct change", () => {
  let dir: string;
  let a: SeededClinic;
  let b: SeededClinic;
  const change = (name: string, sql: string) => writeFileSync(path.join(dir, `${name}.sql`), sql);
  const run = (name: string, mode: "dry-run" | "apply", expectRows: number | null = null) =>
    runChange({ change: name, clinic: a.clinicId, mode, expectRows, connectionString: WRITER_URL!, dir });
  const direct = () =>
    inTenant(a.clinicId, async (c) =>
      (
        await c.query<{ kind: string; source: string; actor_kind: string; summary: Record<string, unknown> }>(
          `select kind, source, actor_kind, summary from clinic_change_events order by changed_at, id`,
        )
      ).rows,
    );

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "db-changes-direct-"));
    a = await seedClinic(`direct${randomUUID().slice(0, 6)}`);
    b = await seedClinic(`directb${randomUUID().slice(0, 6)}`);
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await closePools();
  });

  test("a dry run records nothing; an applied insert of two closed days is one row with the count", async () => {
    change(
      "close-two",
      `insert into clinic_closures (clinic_id, closed_on, label) values ('${a.clinicId}', '2026-12-24', 'Closed'), ('${a.clinicId}', '2026-12-25', 'Closed')`,
    );
    expect(await run("close-two", "dry-run")).toMatchObject({ rowCount: 2, committed: false });
    expect(await direct()).toEqual([]);

    expect(await run("close-two", "apply", 2)).toMatchObject({ rowCount: 2, committed: true });
    expect(await direct()).toEqual([
      {
        kind: "closures",
        source: "direct",
        actor_kind: "change_file",
        summary: { rows: 2, operation: "insert", table: "clinic_closures" },
      },
    ]);
  });

  test("an update that matches nothing records nothing; one that changes a row records it", async () => {
    change("noop", "update clinic_closures set label = label where false");
    expect(await run("noop", "apply", 0)).toMatchObject({ committed: true });
    expect(await direct()).toHaveLength(1);
    change("relabel", "update clinic_closures set label = 'Holiday' where closed_on = '2026-12-24'");
    expect(await run("relabel", "apply", 1)).toMatchObject({ committed: true });
    const rows = await direct();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: "closures", summary: { rows: 1, operation: "update" } });
  });

  test("the roster's tables are covered too", async () => {
    // The provider branches are tested as the migrator only, as a psql edit
    // would be: the change file's role cannot write clinic_providers or
    // clinic_provider_services today (their BAA gate trigger calls
    // app_clinic_phi_update_permitted, which that role may not execute),
    // whatever this trigger does. Raised with the owner by the lead.
    await inTenant(a.clinicId, (c) =>
      c.query(`insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, 'Dr Lee', 'primary')`, [
        a.clinicId,
      ]),
    );
    const rows = await direct();
    expect(rows.at(-1)).toMatchObject({
      kind: "providers",
      source: "direct",
      actor_kind: "direct",
      summary: { rows: 1, operation: "insert", table: "clinic_providers" },
    });
    expect(JSON.stringify(rows)).not.toContain("Dr Lee");
  });

  test("the app's own session, and a transaction that already wrote the clinic's change row, are left alone", async () => {
    const before = (await direct()).length;
    const app = await getAppPool().connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
      await app.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2026-12-31')`, [a.clinicId]);
      await app.query("commit");
    } finally {
      app.release();
    }
    await inTenant(a.clinicId, async (c) => {
      await c.query(
        `insert into clinic_change_events (clinic_id, kind, source, actor_kind) values ($1, 'closures', 'ops_console', 'ops')`,
        [a.clinicId],
      );
      await c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2027-01-01')`, [a.clinicId]);
    });
    // The row that transaction wrote itself, and no `direct` one beside it.
    expect(await direct()).toHaveLength(before + 1);
    // And the migrator's own psql-style edit is seen.
    await inTenant(a.clinicId, (c) =>
      c.query(`delete from clinic_closures where clinic_id = $1 and closed_on = '2027-01-01'`, [a.clinicId]),
    );
    expect((await direct()).at(-1)).toMatchObject({ source: "direct", summary: { operation: "delete", rows: 1 } });
  });

  test("the change file's role can neither read nor write the change rows itself", async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: WRITER_URL });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
      await expect(
        c.query(`insert into clinic_change_events (clinic_id, kind, source) values ($1, 'hours', 'portal')`, [a.clinicId]),
      ).rejects.toThrow(/permission denied/);
      await c.query("rollback");
    } finally {
      await c.end();
    }
    // The migrator's pool is still the one tests read with.
    expect(getMigratorPool()).toBeTruthy();
  });

  test("no way of setting app.change_emitted hides the change file's role's edit", async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: WRITER_URL });
    await c.connect();
    const before = (await direct()).length;
    try {
      for (const [i, setIt] of [
        "set local app.change_emitted = 'on'",
        "select set_config('app.change_emitted', 'on', true)",
        `select U&"!0073et_config" UESCAPE '!'('app.change_emitted', 'on', true)`,
      ].entries()) {
        await c.query("begin");
        await c.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
        await c.query(setIt);
        await c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, $2)`, [a.clinicId, `2027-02-0${i + 1}`]);
        await c.query("commit");
      }
    } finally {
      await c.end();
    }
    const rows = await direct();
    expect(rows).toHaveLength(before + 3);
    expect(rows.slice(-3).every((r) => r.source === "direct" && r.summary.rows === 1)).toBe(true);
  });

  test("a change file that spells set_config in Unicode escapes is refused before it runs", async () => {
    change(
      "uescape",
      `insert into clinic_closures (clinic_id, closed_on, label) select '${a.clinicId}','2027-04-04','Closed' where U&"!0073et_config" UESCAPE '!'('app.change_emitted','on',true) is not null`,
    );
    await expect(run("uescape", "dry-run")).rejects.toBeInstanceOf(ChangeRefused);
    await expect(run("uescape", "apply", 1)).rejects.toBeInstanceOf(ChangeRefused);
  });

  test("the reviewer's escapes from the named clinic are refused by the fence, and rolled back by the run's own checks if they pass it", async () => {
    const payloads = [
      `insert into clinic_closures (clinic_id, closed_on, label) values ('${b.clinicId}', '2027-05-05', $a$'$a$ || set_config('app.clinic_id', '${b.clinicId}', true) || $a$'$a$)`,
      `insert into clinic_closures (clinic_id, closed_on, label) select '${b.clinicId}', '2027-05-06', 'x' where query_to_xml('select set_config(''app.clinic_id'',''${b.clinicId}'',true)', true, false, '') is not null`,
    ];
    const count = (clinicId: string) =>
      inTenant(clinicId, async (c) =>
        (await c.query<{ n: number }>(`select count(*)::int as n from clinic_closures where closed_on >= '2027-05-05'`)).rows[0]!.n,
      );
    for (const [i, sql] of payloads.entries()) {
      change(`escape-${i}`, sql);
      await expect(run(`escape-${i}`, "dry-run")).rejects.toBeInstanceOf(ChangeRefused);
      await expect(run(`escape-${i}`, "apply", 1)).rejects.toBeInstanceOf(ChangeRefused);
      // Past the fence, straight to the run: refused and rolled back, both modes.
      for (const mode of ["dry-run", "apply"] as const) {
        const out = await runParsed(
          {
            change: `escape-${i}`,
            clinic: a.clinicId,
            mode,
            expectRows: mode === "apply" ? 1 : null,
            connectionString: WRITER_URL!,
          },
          { statement: sql, verb: "insert", table: "clinic_closures" },
        );
        expect(out.committed, `${i} ${mode}`).toBe(false);
        expect(out.verdict).toMatch(/reached outside the clinic/);
      }
    }
    expect(await count(a.clinicId)).toBe(0);
    expect(await count(b.clinicId)).toBe(0);
  });

  test("one writer transaction's insert, insert and update are one event each", async () => {
    const before = (await direct()).length;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: WRITER_URL });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
      await c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2027-06-01')`, [a.clinicId]);
      await c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2027-06-02')`, [a.clinicId]);
      await c.query(`update clinic_closures set label = 'Holiday' where closed_on in ('2027-06-01', '2027-06-02')`);
      await c.query("commit");
    } finally {
      await c.end();
    }
    const rows = (await direct()).slice(before);
    expect(rows.map((r) => [r.summary.operation, r.summary.rows])).toEqual([
      ["insert", 1],
      ["insert", 1],
      ["update", 2],
    ]);
  });

  test("while the audits are on, a change file's edit waits for its audit like any other change", async () => {
    await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
    try {
      change("close-queued", `insert into clinic_closures (clinic_id, closed_on) values ('${a.clinicId}', '2027-07-01')`);
      expect(await run("close-queued", "apply", 1)).toMatchObject({ committed: true });
    } finally {
      await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
    }
    const status = await inTenant(a.clinicId, async (c) =>
      (await c.query<{ audit_status: string | null }>(`select audit_status from clinic_change_events order by changed_at desc, id limit 1`)).rows[0]!.audit_status,
    );
    expect(status).toBe("queued");
  });

  test("a closed account's rows can still be deleted by the migrator, and nobody is told", async () => {
    const closed = await seedClinic(`closed${randomUUID().slice(0, 6)}`);
    await inTenant(closed.clinicId, (c) =>
      c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, '2027-08-01')`, [closed.clinicId]),
    );
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [closed.clinicId]);
    const before = await inTenant(closed.clinicId, async (c) =>
      (await c.query<{ n: number }>(`select count(*)::int as n from clinic_change_events`)).rows[0]!.n,
    );
    await inTenant(closed.clinicId, (c) => c.query(`delete from clinic_closures where clinic_id = $1`, [closed.clinicId]));
    const after = await inTenant(closed.clinicId, async (c) =>
      (await c.query<{ n: number }>(`select count(*)::int as n from clinic_change_events`)).rows[0]!.n,
    );
    expect(after).toBe(before);
  });
});
