import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runChange, ChangeRefused } from "../scripts/db-apply-lib";

import { closePools, getMigratorPool, hasTestDatabase } from "./setup/db";
import { seedClinic, type SeededClinic } from "./setup/factories";

/**
 * The write path against a real database: the real migrations, the real
 * triggers and row-level security, and the role the db-apply task connects as
 * (TEST_WRITER_URL; CI provisions it and runs scripts/writer-grants.ts). Skipped
 * without a database or without that role.
 */

const WRITER_URL = process.env.TEST_WRITER_URL;
const describeDb = hasTestDatabase && WRITER_URL ? describe : describe.skip;

describeDb("db-apply", () => {
  let dir: string;
  let writer: Pool;
  let a: SeededClinic;
  let b: SeededClinic;

  const change = (name: string, sql: string) => writeFileSync(path.join(dir, `${name}.sql`), sql);
  const run = (name: string, clinic: string, mode: "dry-run" | "apply", expectRows: number | null = null) =>
    runChange({ change: name, clinic, mode, expectRows, connectionString: WRITER_URL!, dir });
  // clinic_closures forces row-level security, the table owner included, so even
  // the checks below see a clinic's rows only with that clinic set.
  async function inClinic<T>(clinicId: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await getMigratorPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.clinic_id', $1, true)", [clinicId]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (error) {
      await c.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  const closures = (clinicId: string) =>
    inClinic(clinicId, async (c) => (await c.query<{ n: string }>("select count(*)::text as n from clinic_closures")).rows[0]!.n);
  const labels = (clinicId: string) =>
    inClinic(clinicId, async (c) => (await c.query<{ label: string }>("select label from clinic_closures order by closed_on")).rows.map((r) => r.label));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "db-changes-"));
    mkdirSync(dir, { recursive: true });
    writer = new Pool({ connectionString: WRITER_URL });
    const tag = randomUUID().slice(0, 6);
    a = await seedClinic(`applya${tag}`);
    b = await seedClinic(`applyb${tag}`);
  });

  afterAll(async () => {
    await writer?.end();
    rmSync(dir, { recursive: true, force: true });
    await closePools();
  });

  test("a dry run counts the rows and changes nothing", async () => {
    change("add-closure", `insert into clinic_closures (clinic_id, closed_on, label) values ('${a.clinicId}', '2026-12-25', 'Closed')`);
    const dry = await run("add-closure", a.clinicId, "dry-run");
    expect(dry).toMatchObject({ rowCount: 1, committed: false, mode: "dry-run", table: "clinic_closures", verb: "insert" });
    expect(await closures(a.clinicId)).toBe("0");
  });

  test("an apply with the wrong count rolls back; with the right count it commits", async () => {
    const wrong = await run("add-closure", a.clinicId, "apply", 2);
    expect(wrong).toMatchObject({ rowCount: 1, committed: false });
    expect(wrong.verdict).toMatch(/not the 2 expected/);
    expect(await closures(a.clinicId)).toBe("0");

    const right = await run("add-closure", a.clinicId, "apply", 1);
    expect(right).toMatchObject({ rowCount: 1, committed: true });
    expect(await closures(a.clinicId)).toBe("1");
  });

  test("a statement with no clinic filter changes only the named clinic's rows", async () => {
    await inClinic(b.clinicId, (c) => c.query("insert into clinic_closures (clinic_id, closed_on, label) values ($1, '2026-12-26', 'Other clinic')", [b.clinicId]));
    change("relabel-all", "update clinic_closures set label = 'Relabelled'");
    const done = await run("relabel-all", a.clinicId, "apply", 1);
    expect(done.committed).toBe(true);
    expect(await labels(a.clinicId)).toEqual(["Relabelled"]);
    expect(await labels(b.clinicId)).toEqual(["Other clinic"]);
  });

  test("a statement that matches nothing is a count of zero, not an error", async () => {
    change("noop", "update clinic_closures set label = label where false");
    expect(await run("noop", a.clinicId, "dry-run")).toMatchObject({ rowCount: 0, committed: false });
    expect(await run("noop", a.clinicId, "apply", 0)).toMatchObject({ rowCount: 0, committed: true });
  });

  test("a request that is wrong is refused before the database is touched", async () => {
    await expect(run("missing-file", a.clinicId, "dry-run")).rejects.toBeInstanceOf(ChangeRefused);
    await expect(run("noop", "not-a-uuid", "dry-run")).rejects.toBeInstanceOf(ChangeRefused);
    await expect(run("noop", a.clinicId, "apply", null)).rejects.toBeInstanceOf(ChangeRefused);
    change("bad", "delete from clinic_closures");
    await expect(run("bad", a.clinicId, "dry-run")).rejects.toBeInstanceOf(ChangeRefused);
  });

  test("the role itself cannot do what the fence forbids", async () => {
    // Straight to the database, past the runner's fence: the grants and the policies stand alone.
    const c = await writer.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
      await expect(c.query("delete from clinic_closures")).rejects.toThrow(/permission denied/);
      await c.query("rollback");
      for (const sql of ["update clinics set name = 'x'", "update clinic_settings set updated_at = now()", "select * from contacts", "update baa_acceptances set organization_id = organization_id", "truncate clinic_closures"]) {
        await c.query("begin");
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied/);
        await c.query("rollback");
      }
      // And with no clinic set, row-level security refuses to insert at all.
      await c.query("begin");
      await expect(c.query(`insert into clinic_closures (clinic_id, closed_on, label) values ('${b.clinicId}', '2026-12-27', 'x')`)).rejects.toThrow(/row-level security/);
      await c.query("rollback");
      // And with a clinic set, it cannot insert for a different one.
      await c.query("begin");
      await c.query("select set_config('app.clinic_id', $1, true)", [a.clinicId]);
      await expect(c.query(`insert into clinic_closures (clinic_id, closed_on, label) values ('${b.clinicId}', '2026-12-28', 'x')`)).rejects.toThrow(/row-level security/);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });
});
