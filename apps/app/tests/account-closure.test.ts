import { randomBytes, randomUUID } from "node:crypto";

import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeAccountsDue, KEPT_FOR_GOOD, KEPT_IN_PART } from "@/lib/offboarding/account-closure";
import {
  destroyDueClinics,
  markExportDelivered,
  startOffboarding,
} from "@/lib/offboarding/offboarding";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * Closing the account (the audit's R8 item 1). The spec closes a clinic
 * "keeping only the signed agreement and the billing records the law
 * requires", and the Terms promise the same; destruction took only the
 * patient rows, and nothing ever deleted the account, its sign-in or its
 * setup. app_close_clinic_account() (drizzle/0092) does, once the data is
 * destroyed and the pass-through has ended, and these tests hold it to
 * that: what goes, what stays, when, and that no other clinic is touched.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "account-closure-test" } as const;

/** Time passing for the offboarding clock, as the migrator, which owns clinics. */
async function backdate(clinicId: string, days: number): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set offboarding_started_at = offboarding_started_at - make_interval(secs => $2),
            destroy_after = destroy_after - make_interval(secs => $2),
            export_delivered_at = export_delivered_at - make_interval(secs => $2)
      where id = $1`,
    [clinicId, days * 86_400],
  );
}

/** One statement as the runtime role, inside the tenant, rolled back. */
async function asApp<T>(clinicId: string, sql: string, values: unknown[] = []): Promise<T[]> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return (await client.query(sql, values)).rows as T[];
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** The tables app_close_clinic_account() deletes a clinic's rows from, read from its source. */
async function deletedAtClosure(): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ prosrc: string }>(
    `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'app_close_clinic_account'`,
  );
  expect(rows).toHaveLength(1);
  return [
    ...new Set(
      [
        ...rows[0]!.prosrc.matchAll(
          /delete\s+from\s+([a-z_]+)\s+[a-z]+\s+where\s+[a-z]+\.clinic_id\s*=\s*target_clinic/gi,
        ),
      ].map((m) => m[1]!),
    ),
  ].sort();
}

async function countIn(clinicId: string, table: string): Promise<number> {
  return inTenant(
    clinicId,
    async (c) =>
      (
        await c.query<{ n: number }>(
          `select count(*)::int as n from ${table} where clinic_id = $1`,
          [clinicId],
        )
      ).rows[0]!.n,
  );
}

/** A clinic's setup and business data, one row in each table the closure deletes, and a few it keeps. */
async function seedAccount(clinicId: string, userId: string): Promise<void> {
  await inTenant(clinicId, async (c) => {
    await c.query(
      `insert into agent_configs (clinic_id, greeting) values ($1, 'Thanks for calling.')`,
      [clinicId],
    );
    await c.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, '+15550100001')`,
      [clinicId],
    );
    await c.query(
      `insert into clinic_settings_history (clinic_id, field, actor_label, after_value) values ($1, 'direct_line_e164', 'owner', '•••0001')`,
      [clinicId],
    );
    await c.query(
      `insert into report_recipients (clinic_id, email, added_by) values ($1, 'desk@example-clinic.test', 'provisioning')`,
      [clinicId],
    );
    await c.query(
      `insert into clinic_touches (clinic_id, by_label, kind, summary) values ($1, 'ops', 'call', 'Asked about the export.')`,
      [clinicId],
    );
    await c.query(
      `insert into site_rereads (clinic_id, reason, website) values ($1, 'ops', 'example-clinic.test')`,
      [clinicId],
    );
    await c.query(
      `insert into connection_links (clinic_id, token_hash, expires_at, purpose) values ($1, $2, now() + interval '1 day', 'setup')`,
      [clinicId, randomBytes(32)],
    );
    // Kept: the billing record, the notice given and its ledger row.
    await c.query(
      `insert into entitlements (clinic_id, plan_code, billing_interval) values ($1, 'voice-web', 'month')`,
      [clinicId],
    );
    await c.query(
      `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, 'canceled', 'canceled')`,
      [clinicId],
    );
    await c.query(
      `insert into report_deliveries (clinic_id, kind, period_key, recipient, status) values ($1, 'canceled', 'canceled', 'desk@example-clinic.test', 'sent')`,
      [clinicId],
    );
    // Kept: the record of the notice addresses the practice gave, one applied
    // and one still waiting, which the closure ends.
    await c.query(
      `insert into sign_in_address_changes
         (clinic_id, user_id, old_email, new_email, source, status, requested_by, confirmed_at, effective_at, resolved_at)
       values ($1, $2, 'first@example-clinic.test', 'second@example-clinic.test', 'operator', 'applied', 'ops', now(), now(), now())`,
      [clinicId, userId],
    );
    await c.query(
      `insert into sign_in_address_changes
         (clinic_id, user_id, old_email, new_email, source, status, requested_by, confirmed_at, effective_at)
       values ($1, $2, 'second@example-clinic.test', 'third@example-clinic.test', 'operator', 'pending', 'ops', now(), now() + interval '3 days')`,
      [clinicId, userId],
    );
    await c.query(
      `update clinics set website = 'example-clinic.test', site_profile = '{"services": []}'::jsonb,
              onboarding = '{"basics": true}'::jsonb, published_phone_e164 = '+15550100002'
        where id = $1`,
      [clinicId],
    );
  });
  await getMigratorPool().query(
    `insert into session (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
    [`ses_${randomUUID().slice(0, 8)}`, randomUUID(), userId],
  );
}

describeDb("closing the account once the data is destroyed and the pass-through has ended", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("the closure deletes the sign-in, the setup and our notes, keeps the agreement, the billing records and the notices, and no other clinic is touched", async () => {
    const leaving = await seedClinic("close-leaving");
    const staying = await seedClinic("close-staying");
    // The same practice's other location, and a person with a grant on both.
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty) values ($1, $2, 'Second location', 'med-spa') returning id`,
      [leaving.organizationId, `close-second-${randomUUID().slice(0, 6)}`],
    );
    const secondLocation = rows[0]!.id;
    const both = await seedPortalUser(leaving.clinicId, "admin", { label: "both" });
    await inTenant(secondLocation, (c) =>
      c.query(
        `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'admin')`,
        [secondLocation, both.userId],
      ),
    );
    await seedAccount(leaving.clinicId, leaving.staffUserId);
    await seedAccount(staying.clinicId, staying.staffUserId);

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await backdate(leaving.clinicId, FORWARDING_PASS_THROUGH_DAYS + 1);
    const destroyed = await destroyDueClinics();
    expect(destroyed.map((d) => d.clinicId)).toContain(leaving.clinicId);

    const closed = await closeAccountsDue();
    expect(closed.map((c) => c.clinicId)).toEqual([leaving.clinicId]);
    expect(closed[0]!.deleted).toMatchObject({
      users: 1,
      clinic_memberships: 2,
      agent_configs: 1,
      clinic_settings: 1,
    });

    // Every table the closure lists is empty for the clinic that left, and untouched for the one that stayed.
    const tables = await deletedAtClosure();
    expect(tables).toEqual(
      expect.arrayContaining([
        "agent_configs",
        "clinic_memberships",
        "clinic_settings",
        "report_recipients",
      ]),
    );
    for (const table of tables) {
      expect(await countIn(leaving.clinicId, table), table).toBe(0);
    }
    for (const table of [
      "agent_configs",
      "clinic_settings",
      "clinic_settings_history",
      "report_recipients",
      "clinic_touches",
      "site_rereads",
      "connection_links",
      "clinic_memberships",
    ]) {
      expect(await countIn(staying.clinicId, table), table).toBeGreaterThan(0);
    }

    // The sign-in: the person whose only grant it was is gone with their
    // session; the person with a grant on the other location keeps it.
    const users = await getMigratorPool().query<{ id: string }>(
      `select id from "user" where id = any($1)`,
      [[leaving.staffUserId, both.userId, staying.staffUserId]],
    );
    expect(users.rows.map((r) => r.id).sort()).toEqual([both.userId, staying.staffUserId].sort());
    const sessions = await getMigratorPool().query(`select 1 from session where user_id = $1`, [
      leaving.staffUserId,
    ]);
    expect(sessions.rows).toHaveLength(0);
    expect(await countIn(secondLocation, "clinic_memberships")).toBe(1);

    // Kept: the billing record, the notice and its ledger, and the record of
    // the notice addresses, without the sign-in it named, the open one ended.
    for (const table of ["entitlements", "billing_notices", "report_deliveries"]) {
      expect(await countIn(leaving.clinicId, table), table).toBe(1);
    }
    const changes = await inTenant(
      leaving.clinicId,
      async (c) =>
        (
          await c.query<{ user_id: string | null; status: string; new_email: string }>(
            `select user_id, status, new_email from sign_in_address_changes order by created_at, new_email`,
          )
        ).rows,
    );
    expect(changes.map((r) => [r.user_id, r.status, r.new_email]).sort()).toEqual(
      [
        [null, "applied", "second@example-clinic.test"],
        [null, "failed", "third@example-clinic.test"],
      ].sort(),
    );

    // The clinic row stays as the anchor, with its setup columns cleared and the number the widget shows.
    const clinic = await getMigratorPool().query<{
      account_closed_at: Date | null;
      website: string | null;
      site_profile: unknown;
      onboarding: unknown;
      name: string;
      published_phone_e164: string | null;
    }>(
      `select account_closed_at, website, site_profile, onboarding, name, published_phone_e164 from clinics where id = $1`,
      [leaving.clinicId],
    );
    expect(clinic.rows[0]).toMatchObject({
      website: null,
      site_profile: null,
      onboarding: {},
      name: "close-leaving Clinic",
      published_phone_e164: "+15550100002",
    });
    expect(clinic.rows[0]!.account_closed_at).not.toBeNull();

    // Recorded: an audit row with the counts, and the identity plane's event.
    const audit = await inTenant(
      leaving.clinicId,
      async (c) =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from audit_log where resource_type = 'clinic_account_closure'`,
          )
        ).rows[0]!.n,
    );
    expect(audit).toBe(1);
    const events = await getMigratorPool().query(
      `select 1 from security_events where event = 'clinic_account_closed' and metadata->>'clinicId' = $1`,
      [leaving.clinicId],
    );
    expect(events.rows).toHaveLength(1);

    // Once: nothing is due again, and a second call changes nothing.
    expect(await closeAccountsDue()).toEqual([]);
    expect(
      (
        await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
          tx.db.execute<{ r: unknown }>(
            sql`select app_close_clinic_account(${leaving.clinicId}::uuid) as r`,
          ),
        )
      ).rows[0]!.r,
    ).toBeNull();
  });

  test("the account closes only after destruction, and only once forwarded calls stop passing through", async () => {
    const c = await seedClinic("close-timing");
    await seedAccount(c.clinicId, c.staffUserId);
    const refused = (text: RegExp) =>
      expect(
        asApp(c.clinicId, `select app_close_clinic_account($1::uuid)`, [c.clinicId]),
      ).rejects.toThrow(text);

    // A customer, then a clinic whose service ended but whose data is held.
    await refused(/not destroyed/);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await refused(/not destroyed/);

    // Destroyed on day 29, a day before the pass-through ends: the direct line
    // and the clinic's address are still needed, so the account stays open.
    await backdate(c.clinicId, FORWARDING_PASS_THROUGH_DAYS - 0.5);
    expect((await destroyDueClinics()).map((d) => d.clinicId)).toContain(c.clinicId);
    await refused(/still pass through/);
    expect((await closeAccountsDue()).map((x) => x.clinicId)).not.toContain(c.clinicId);
    expect(await countIn(c.clinicId, "clinic_settings")).toBe(1);

    // The pass-through's last hour passes: the next hourly run closes it.
    await backdate(c.clinicId, 0.5 + 1 / 24);
    expect((await closeAccountsDue()).map((x) => x.clinicId)).toEqual([c.clinicId]);
    expect(await countIn(c.clinicId, "clinic_settings")).toBe(0);
  });

  test("another tenant's account cannot be closed, the runtime role cannot stamp a closure, and no clinic is born closed", async () => {
    const mine = await seedClinic("close-mine");
    const theirs = await seedClinic("close-theirs");
    await expect(
      asApp(mine.clinicId, `select app_close_clinic_account($1::uuid)`, [theirs.clinicId]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(mine.clinicId, `update clinics set account_closed_at = now() where id = $1`, [
        mine.clinicId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      getAppPool().query(
        `insert into clinics (organization_id, slug, name, specialty, account_closed_at)
         values ($1, $2, 'Born closed', 'med-spa', now())`,
        [mine.organizationId, `born-closed-${randomUUID().slice(0, 6)}`],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The pass-through the database counts is the catalog's.
    const { rows } = await getMigratorPool().query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname in ('app_close_clinic_account', 'app_accounts_to_close')`,
    );
    for (const row of rows)
      expect(row.prosrc).toContain(`make_interval(hours => ${24 * FORWARDING_PASS_THROUGH_DAYS})`);
  });

  test("KEPT_FOR_GOOD gives a reason for every table it keeps, and the closure deletes none of them, except in the part it names", async () => {
    const closure = await deletedAtClosure();
    for (const [table, reason] of Object.entries(KEPT_FOR_GOOD)) {
      expect(reason.length, table).toBeGreaterThan(30);
      if (!KEPT_IN_PART.has(table)) expect(closure, table).not.toContain(table);
    }
    expect([...KEPT_IN_PART].filter((t) => !(t in KEPT_FOR_GOOD) || !closure.includes(t))).toEqual(
      [],
    );
  });

  test("a connection link something still names outlives the closure, and every other link goes", async () => {
    // A calendar election names the link it was signed through, and an
    // OAuth state in flight names its link too, each by a foreign key with no
    // delete action: the closure keeps those, and the delete would fail
    // without the exception. The OAuth state stands in for both here, as the
    // election takes a signed agreement to record.
    const c = await seedClinic("close-named-link");
    const link = async (purpose: string) =>
      (
        await inTenant(c.clinicId, (q) =>
          q.query<{ id: string }>(
            `insert into connection_links (clinic_id, token_hash, expires_at, purpose) values ($1, $2, now() + interval '1 day', $3) returning id`,
            [c.clinicId, randomBytes(32), purpose],
          ),
        )
      ).rows[0]!.id;
    const named = await link("calendar");
    const loose = await link("setup");
    await getMigratorPool().query(
      `insert into google_oauth_states
         (state_hash, target_clinic_id, initiated_via, return_to, link_id, browser_binding_hash,
          disclosure_version, disclosure_sha256, disclosure_accepted_at, expires_at)
       values ($1, $2, 'calendar_link', 'calendar_link', $3, $4, 'google-calendar-disclosure/1.0.0', $5, now(), now() + interval '10 minutes')`,
      [randomBytes(32), c.clinicId, named, randomBytes(32), randomBytes(32)],
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await backdate(c.clinicId, FORWARDING_PASS_THROUGH_DAYS + 1);
    await destroyDueClinics();
    const closed = await closeAccountsDue();
    expect(closed.find((x) => x.clinicId === c.clinicId)?.deleted.connection_links).toBe(1);
    const left = await inTenant(c.clinicId, async (q) =>
      (
        await q.query<{ id: string }>(`select id from connection_links where clinic_id = $1`, [
          c.clinicId,
        ])
      ).rows.map((r) => r.id),
    );
    expect(left).toEqual([named]);
    expect(left).not.toContain(loose);
  });
});
