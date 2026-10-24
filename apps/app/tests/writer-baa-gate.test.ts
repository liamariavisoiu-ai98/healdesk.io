import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runChange } from "../scripts/db-apply-lib";

import { closePools, getMigratorPool, hasTestDatabase } from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, type SeededClinic } from "./setup/factories";

/**
 * Lane G (drizzle/0116): the change file's role, healdesk_writer, may write
 * the roster tables an ops change file targets (owner decision D8), and the
 * BAA gate still decides whether it may. clinic_providers and
 * clinic_provider_services carry app_enforce_baa_gate(), which runs with the
 * caller's rights and asks app_clinic_accepts_phi() on an INSERT and
 * app_clinic_phi_update_permitted() on an UPDATE; until 0116 only the runtime
 * role could execute them, so every roster change file failed with
 * "permission denied for function". Every write here is a change file run by
 * db-apply's own code (runChange) as the real role (TEST_WRITER_URL), against
 * the real migrations; the migrator only seeds and reads back.
 */

const WRITER_URL = process.env.TEST_WRITER_URL;
const describeDb = hasTestDatabase && WRITER_URL ? describe : describe.skip;

async function gate(clinicId: string): Promise<{ accepts: boolean; update: boolean }> {
  const { rows } = await getMigratorPool().query<{ accepts: boolean; update: boolean }>(
    `select app_clinic_accepts_phi($1) as accepts, app_clinic_phi_update_permitted($1) as update`,
    [clinicId],
  );
  return rows[0]!;
}

function events(clinicId: string) {
  return inTenant(clinicId, async (c) =>
    (
      await c.query<{ kind: string; source: string; actor_kind: string; summary: Record<string, unknown> }>(
        `select kind, source, actor_kind, summary from clinic_change_events order by changed_at, id`,
      )
    ).rows,
  );
}

function roster(clinicId: string) {
  return inTenant(clinicId, async (c) => ({
    providers: (await c.query<{ display_name: string }>(`select display_name from clinic_providers order by display_name`)).rows.map(
      (r) => r.display_name,
    ),
    services: (await c.query<{ service_key: string }>(`select service_key from clinic_provider_services order by service_key`)).rows.map(
      (r) => r.service_key,
    ),
  }));
}

/** A plain session as the writer, for what no change file may contain. */
async function writerQuery(clinicId: string, sql: string, values: unknown[] = []) {
  const c = new Client({ connectionString: WRITER_URL });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.clinic_id', $1, true)", [clinicId]);
    return (await c.query(sql, values)).rows;
  } finally {
    await c.query("rollback").catch(() => undefined);
    await c.end();
  }
}

describeDb("the change file's role passes the BAA gate on the roster tables, and only where the gate allows", () => {
  let dir: string;
  /** Production, an agreement in effect: takes new rows. */
  let covered: SeededClinic;
  /** Production, no agreement: takes nothing. */
  let uncovered: SeededClinic;
  /** Production, agreement signed, offboarding started: changes to rows it holds only. */
  let leaving: SeededClinic;
  let held: string;
  let planted: string;
  /**
   * Production, baa_signed_at set and a kind the regime accepts, but no
   * agreement in effect: one never bound, one whose agreement was terminated.
   * Only the agreements lookup inside the definer function refuses these.
   */
  let neverBound: SeededClinic;
  let terminated: SeededClinic;
  const signedOnly: Record<string, string> = {};

  const apply = (clinic: SeededClinic, sql: string, expectRows = 1) => {
    const name = `g-${randomUUID().slice(0, 8)}`;
    writeFileSync(path.join(dir, `${name}.sql`), sql);
    return runChange({ change: name, clinic: clinic.clinicId, mode: "apply", expectRows, connectionString: WRITER_URL!, dir });
  };

  const providerAs = async (clinic: SeededClinic, name: string) =>
    inTenant(clinic.clinicId, async (c) =>
      (
        await c.query<{ id: string }>(
          `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, $2, 'primary') returning id`,
          [clinic.clinicId, name],
        )
      ).rows[0]!.id,
    );

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "db-changes-writer-gate-"));
    const pool = getMigratorPool();
    const production = (id: string, signed: boolean) =>
      pool.query(
        `update clinics set data_classification = 'production', baa_signed_at = ${signed ? "now() - interval '30 days'" : "null"} where id = $1`,
        [id],
      );
    covered = await seedClinic(`wgcov${randomUUID().slice(0, 6)}`);
    uncovered = await seedClinic(`wgunc${randomUUID().slice(0, 6)}`);
    leaving = await seedClinic(`wglea${randomUUID().slice(0, 6)}`);

    await bindAgreementInEffect(covered.clinicId);
    await production(covered.clinicId, true);

    // Each of the other two holds a provider written while it could take one.
    planted = await providerAs(uncovered, "Dr Planted");
    await production(uncovered.clinicId, false);

    await bindAgreementInEffect(leaving.clinicId);
    await production(leaving.clinicId, true);
    held = await providerAs(leaving, "Dr Held");
    await pool.query(`update clinics set offboarding_started_at = now() where id = $1`, [leaving.clinicId]);

    neverBound = await seedClinic(`wgnev${randomUUID().slice(0, 6)}`);
    terminated = await seedClinic(`wgter${randomUUID().slice(0, 6)}`);
    for (const clinic of [neverBound, terminated]) {
      signedOnly[clinic.clinicId] = await providerAs(clinic, "Dr Signed");
      if (clinic === terminated) await bindAgreementInEffect(clinic.clinicId);
      await pool.query(
        `update clinics set data_classification = 'production', baa_signed_at = now() - interval '30 days',
                agreement_kind = 'baa', regulatory_regime = 'hipaa'
          where id = $1`,
        [clinic.clinicId],
      );
    }
    await pool.query(
      `update baa_acceptances set terminated_at = now()
        where organization_id = (select organization_id from clinics where id = $1)`,
      [terminated.clinicId],
    );
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await closePools();
  });

  test("the seeded clinics stand where the gate says", async () => {
    expect(await gate(covered.clinicId)).toEqual({ accepts: true, update: true });
    expect(await gate(uncovered.clinicId)).toEqual({ accepts: false, update: false });
    expect(await gate(leaving.clinicId)).toEqual({ accepts: false, update: true });
    expect(await gate(neverBound.clinicId)).toEqual({ accepts: false, update: false });
    expect(await gate(terminated.clinicId)).toEqual({ accepts: false, update: false });
    // Signed, and a kind the regime accepts: only the agreement in effect is missing.
    const { rows } = await getMigratorPool().query<{ sufficient: boolean }>(
      `select app_agreement_kind_sufficient(regulatory_regime, agreement_kind, is_covered_entity) as sufficient
         from clinics where id = any($1::uuid[]) and baa_signed_at is not null`,
      [[neverBound.clinicId, terminated.clinicId]],
    );
    expect(rows).toEqual([{ sufficient: true }, { sufficient: true }]);
  });

  test("(a) a change file inserts a provider for a covered clinic, recorded as one change-file row", async () => {
    const before = await events(covered.clinicId);
    expect(
      await apply(covered, `insert into clinic_providers (clinic_id, display_name, calendar_id) values ('${covered.clinicId}', 'Dr Lee', 'primary')`),
    ).toMatchObject({ rowCount: 1, committed: true });
    expect((await roster(covered.clinicId)).providers).toEqual(["Dr Lee"]);
    const rows = await events(covered.clinicId);
    expect(rows.slice(before.length)).toEqual([
      {
        kind: "providers",
        source: "direct",
        actor_kind: "change_file",
        summary: { rows: 1, operation: "insert", table: "clinic_providers" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("Dr Lee");
  });

  test("(b) a change file inserts a provider's service for a covered clinic, recorded as one change-file row", async () => {
    const before = await events(covered.clinicId);
    expect(
      await apply(
        covered,
        `insert into clinic_provider_services (clinic_id, provider_id, service_key) select clinic_id, id, 'consultation' from clinic_providers where display_name = 'Dr Lee'`,
      ),
    ).toMatchObject({ rowCount: 1, committed: true });
    expect((await roster(covered.clinicId)).services).toEqual(["consultation"]);
    expect((await events(covered.clinicId)).slice(before.length)).toEqual([
      {
        kind: "provider_services",
        source: "direct",
        actor_kind: "change_file",
        summary: { rows: 1, operation: "insert", table: "clinic_provider_services" },
      },
    ]);
  });

  test("(c) for a clinic without an agreement the gate refuses the change file, on both tables, and nothing is written", async () => {
    const before = await events(uncovered.clinicId);
    await expect(
      apply(uncovered, `insert into clinic_providers (clinic_id, display_name, calendar_id) values ('${uncovered.clinicId}', 'Dr No', 'primary')`),
    ).rejects.toThrow(/refusing to write PHI to clinic_providers/);
    await expect(
      apply(
        uncovered,
        `insert into clinic_provider_services (clinic_id, provider_id, service_key) values ('${uncovered.clinicId}', '${planted}', 'botox')`,
      ),
    ).rejects.toThrow(/refusing to write PHI to clinic_provider_services/);
    await expect(apply(uncovered, `update clinic_providers set display_name = 'Dr Renamed' where id = '${planted}'`)).rejects.toThrow(
      /refusing to write PHI to clinic_providers/,
    );
    expect(await roster(uncovered.clinicId)).toEqual({ providers: ["Dr Planted"], services: [] });
    expect(await events(uncovered.clinicId)).toEqual(before);
  });

  test("(d) an UPDATE asks the update rule: an offboarding clinic's held provider changes, a new one is refused", async () => {
    const before = (await events(leaving.clinicId)).length;
    expect(await apply(leaving, `update clinic_providers set active = false where id = '${held}'`)).toMatchObject({
      rowCount: 1,
      committed: true,
    });
    const rows = await events(leaving.clinicId);
    expect(rows.slice(before)).toEqual([
      {
        kind: "providers",
        source: "direct",
        actor_kind: "change_file",
        summary: { rows: 1, operation: "update", table: "clinic_providers" },
      },
    ]);

    await expect(
      apply(leaving, `insert into clinic_providers (clinic_id, display_name, calendar_id) values ('${leaving.clinicId}', 'Dr New', 'primary')`),
    ).rejects.toThrow(/refusing to write PHI to clinic_providers/);
    expect((await roster(leaving.clinicId)).providers).toEqual(["Dr Held"]);
    expect(await events(leaving.clinicId)).toHaveLength(before + 1);

    // And a covered clinic's update, through the same rule, with its one row.
    const coveredBefore = (await events(covered.clinicId)).length;
    expect(await apply(covered, `update clinic_providers set display_name = 'Dr Lee-Park' where display_name = 'Dr Lee'`)).toMatchObject({
      rowCount: 1,
      committed: true,
    });
    expect((await roster(covered.clinicId)).providers).toEqual(["Dr Lee-Park"]);
    expect((await events(covered.clinicId)).slice(coveredBefore)).toEqual([
      {
        kind: "providers",
        source: "direct",
        actor_kind: "change_file",
        summary: { rows: 1, operation: "update", table: "clinic_providers" },
      },
    ]);
  });

  test("(c2) signed, with a sufficient kind, but no agreement in effect (never bound, or terminated): refused on both tables, nothing written", async () => {
    for (const clinic of [neverBound, terminated]) {
      const before = await events(clinic.clinicId);
      await expect(
        apply(clinic, `insert into clinic_providers (clinic_id, display_name, calendar_id) values ('${clinic.clinicId}', 'Dr No', 'primary')`),
        clinic.slug,
      ).rejects.toThrow(/refusing to write PHI to clinic_providers/);
      await expect(
        apply(
          clinic,
          `insert into clinic_provider_services (clinic_id, provider_id, service_key) values ('${clinic.clinicId}', '${signedOnly[clinic.clinicId]}', 'botox')`,
        ),
        clinic.slug,
      ).rejects.toThrow(/refusing to write PHI to clinic_provider_services/);
      expect(await roster(clinic.clinicId)).toEqual({ providers: ["Dr Signed"], services: [] });
      expect(await events(clinic.clinicId)).toEqual(before);
    }
  });

  test("(c3) inside one clinic's session, a row for another covered clinic is refused by the gate, not by row-level security", async () => {
    // The definer functions read baa_acceptances as its owner, but the table
    // FORCEs row-level security, so the tenant session sees only its own
    // organisation's agreement and the other clinic has none in effect.
    const other = await seedClinic(`wgoth${randomUUID().slice(0, 6)}`);
    await bindAgreementInEffect(other.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now() - interval '30 days' where id = $1`,
      [other.clinicId],
    );
    expect(await gate(other.clinicId)).toEqual({ accepts: true, update: true });
    await expect(
      writerQuery(covered.clinicId, `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, 'Dr Across', 'primary')`, [
        other.clinicId,
      ]),
    ).rejects.toThrow(/refusing to write PHI to clinic_providers/);
    expect((await roster(other.clinicId)).providers).toEqual([]);
  });

  test("(e) the grant opens nothing else: no DELETE, no table off its list, no other gate function", async () => {
    for (const sql of [
      "delete from clinic_providers",
      "delete from clinic_provider_services",
      "truncate clinic_providers",
      "select * from contacts",
      "select * from conversations",
      "select * from appointments",
      "update clinics set baa_signed_at = now()",
      "select app_clinic_amendment_permitted(id) from clinics",
    ]) {
      await expect(writerQuery(covered.clinicId, sql), sql).rejects.toThrow(/permission denied/);
    }
    expect((await roster(covered.clinicId)).providers).toEqual(["Dr Lee-Park"]);

    // What it may now ask is a yes or no about a clinic id, nothing more.
    expect(
      await writerQuery(covered.clinicId, "select app_clinic_accepts_phi($1) as accepts, app_clinic_phi_update_permitted($1) as update", [
        uncovered.clinicId,
      ]),
    ).toEqual([{ accepts: false, update: false }]);

    const { rows } = await getMigratorPool().query<{ fn: string; writer: boolean; app: boolean; anyone: boolean }>(
      `select p.proname as fn,
              has_function_privilege('healdesk_writer', p.oid, 'EXECUTE') as writer,
              has_function_privilege('healdesk_app', p.oid, 'EXECUTE') as app,
              has_function_privilege('public', p.oid, 'EXECUTE') as anyone
         from pg_proc p
        where p.proname in ('app_clinic_accepts_phi', 'app_clinic_phi_update_permitted')
        order by p.proname`,
    );
    expect(rows).toEqual([
      { fn: "app_clinic_accepts_phi", writer: true, app: true, anyone: false },
      { fn: "app_clinic_phi_update_permitted", writer: true, app: true, anyone: false },
    ]);
  });
});
