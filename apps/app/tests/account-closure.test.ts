import { randomBytes, randomUUID } from "node:crypto";

import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { acceptInvitationFor } from "@/lib/access";
import { billingRecipients, OWED_AFTER_CLOSURE } from "@/lib/billing/recipients";
import { NOTICE_KIND_REGISTRY, NOTICE_KINDS } from "@/lib/email/kinds";
import { deliverNotice } from "@/lib/email/outbox";
import { compose } from "@/lib/email/templates/compose";
import type { TemplateEntry } from "@/lib/email/templates/registry";
import { stopOptionalEmail } from "@/lib/email/stop";
import { recordGuaranteeClaim } from "@/lib/notices/operator-notices";
import {
  closeAccountsDue,
  FROZEN_AT_CLOSURE,
  KEPT_FOR_GOOD,
  KEPT_IN_PART,
} from "@/lib/offboarding/account-closure";
import {
  destroyDueClinics,
  markExportDelivered,
  recordVoiceVendorDeletion,
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
import { inTenant, seedChannels, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * Closing the account (the audit's R8 item 1, and its review's fix round).
 * The spec closes a clinic "keeping only the signed agreement and the billing
 * records the law requires", and the Terms promise the same; destruction took
 * only the patient rows, and nothing ever closed the account.
 * app_close_clinic_account() (drizzle/0096) does, once nothing is left to
 * finish, and these tests hold it to that: what goes, what stays, when, and
 * that no other clinic is touched.
 *
 * The first version deleted the user row, and the review found that every
 * real closure rolled back: the audit log names a portal user as the actor of
 * each action, its foreign key nulls the id on a delete, and
 * audit_log_actor_shape refuses a user actor with no id. Nothing here wrote a
 * user-actor audit row, so the suite passed. Every account below now has
 * them, written by the AuditRecorder as a portal action writes them.
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
async function asApp<T>(clinicId: string, text: string, values: unknown[] = []): Promise<T[]> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return (await client.query(text, values)).rows as T[];
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

/** What a portal person leaves in the audit log: actions recorded as theirs, by the AuditRecorder. */
async function portalActions(clinicId: string, userId: string): Promise<void> {
  await withTenant(
    { clinicId, actor: { type: "user", userId, label: "Practice owner" } },
    async (tx) => {
      tx.audit.record({ action: "update", resourceType: "clinic_settings", resourceId: clinicId });
      tx.audit.record({ action: "read", resourceType: "conversation", resultCount: 1 });
    },
  );
}

/** A clinic's setup and business data, one row in each table the closure deletes, and a few it keeps. */
async function seedAccount(clinicId: string, userId: string, email: string): Promise<void> {
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
      `insert into billing_notices (clinic_id, kind, dedupe_key, sent_at) values ($1, 'canceled', 'canceled', now())`,
      [clinicId],
    );
    await c.query(
      `insert into report_deliveries (clinic_id, kind, period_key, recipient, status) values ($1, 'canceled', 'canceled', $2, 'sent')`,
      [clinicId, email],
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
              onboarding = '{"basics": true}'::jsonb, published_phone_e164 = '+15550100002',
              carrier = 'att', booking_provider = 'mindbody', meta_front_door_enabled = true,
              call_routing = 'always', call_routing_confirmed_at = now(),
              timezone_confirmed_at = now(), agent_approved_at = now(), went_live_at = now(),
              attribution_mode = 'verified', plan = 'voice-web'
        where id = $1`,
      [clinicId],
    );
  });
  // The sign-in's ways in, and the checkout the clinic was bought through.
  const pool = getMigratorPool();
  await pool.query(
    `insert into session (id, expires_at, token, created_at, updated_at, user_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
    [`ses_${randomUUID().slice(0, 8)}`, randomUUID(), userId],
  );
  await pool.query(
    `insert into account (id, account_id, provider_id, user_id, created_at, updated_at)
     values ($1, $2, 'credential', $2, now(), now())`,
    [`acc_${randomUUID().slice(0, 8)}`, userId],
  );
  // Better Auth's rows for a user, in the two forms its core writes with
  // lib/auth.ts's configuration: the token in the identifier, the user's id
  // as the value.
  await seedVerification(`reset-password:${randomBytes(12).toString("hex")}`, userId);
  await seedVerification(`delete-account-${randomBytes(12).toString("hex")}`, userId);
  // A device recovery link (0095), bound to the sign-in's address as it is.
  await pool.query(
    `insert into device_recoveries (user_id, token_hash, address_hash, landing, issued_by, expires_at)
     values ($1, $2, app_address_hash($1), '/c/closing/protect', 'ops@healdesk.test', now() + interval '1 hour')`,
    [userId, randomBytes(32)],
  );
  const agreement = randomUUID();
  await pool.query(
    `insert into checkout_intents (payload, agreement_id, contact_email, plan, billing_interval, expires_at, provisioned_clinic_id, profile, profile_status, consumed_at)
     values ('{"clinicName": "x", "website": "example-clinic.test"}'::jsonb, $1, $2, 'voice-web', 'month', now() + interval '1 day', $3, '{"services": []}'::jsonb, 'read', now())`,
    [agreement, email, clinicId],
  );
  await portalActions(clinicId, userId);
}

/** One Better Auth verification row, as the migrator. */
async function seedVerification(identifier: string, value: string): Promise<void> {
  await getMigratorPool().query(
    `insert into verification (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, $2, $3, now() + interval '1 hour', now(), now())`,
    [`ver_${randomUUID().slice(0, 8)}`, identifier, value],
  );
}

/** Offboard, deliver the export, and move the clock past the pass-through: due for destruction, then closure. */
async function leaveAndWait(
  clinicId: string,
  days = FORWARDING_PASS_THROUGH_DAYS + 1,
): Promise<void> {
  await withTenant({ clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
  await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    markExportDelivered(tx, "bundle handed over"),
  );
  await backdate(clinicId, days);
}

describeDb("closing the account once the data is destroyed and nothing is left to finish", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("the closure ends the sign-in but keeps the user the audit log names, revokes and keeps the grants, deletes the setup, and keeps the agreement, the billing and the notices; no other clinic is touched", async () => {
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
    await seedAccount(leaving.clinicId, leaving.staffUserId, leaving.staffEmail);
    await seedAccount(staying.clinicId, staying.staffUserId, staying.staffEmail);
    await portalActions(leaving.clinicId, both.userId);

    await leaveAndWait(leaving.clinicId);
    expect((await destroyDueClinics()).map((d) => d.clinicId)).toContain(leaving.clinicId);

    const run = await closeAccountsDue();
    expect(run.failed).toEqual([]);
    expect(run.closed.map((c) => c.clinicId)).toEqual([leaving.clinicId]);
    expect(run.closed[0]!.closed).toMatchObject({
      memberships_revoked: 2,
      sign_ins_ended: 1,
      agent_configs: 1,
      clinic_settings: 1,
      checkout_intents: 1,
    });

    // The audit trail is whole: every user-actor row still names its user.
    const actors = await inTenant(leaving.clinicId, async (c) =>
      (
        await c.query<{ actor_user_id: string | null }>(
          `select actor_user_id from audit_log where actor_type = 'user'`,
        )
      ).rows.map((r) => r.actor_user_id),
    );
    expect(actors.length).toBe(4);
    expect(actors.every((id) => id === leaving.staffUserId || id === both.userId)).toBe(true);

    // The person whose only grant it was: still there for the log, as a
    // tombstone, with every way in gone.
    const pool = getMigratorPool();
    const tomb = await pool.query<{ email: string; name: string; email_verified: boolean }>(
      `select email, name, email_verified from "user" where id = $1`,
      [leaving.staffUserId],
    );
    expect(tomb.rows[0]).toMatchObject({ name: "Closed account", email_verified: false });
    expect(tomb.rows[0]!.email).toMatch(/^closed\+[0-9a-f]{32}@invalid$/);
    for (const [table, column] of [
      ["session", "user_id"],
      ["account", "user_id"],
      ["member", "user_id"],
      ["user_factors", "user_id"],
      ["sign_in_links", "user_id"],
      ["step_ups", "user_id"],
      ["device_recoveries", "user_id"],
      ["verification", "value"],
    ] as const) {
      const left = await pool.query(`select 1 from ${table} where ${column} = $1`, [
        leaving.staffUserId,
      ]);
      expect(left.rows, table).toHaveLength(0);
    }
    // The person with a grant on the other location keeps their sign-in.
    const kept = await pool.query<{ email: string }>(`select email from "user" where id = $1`, [
      both.userId,
    ]);
    expect(kept.rows[0]!.email).toBe(both.email);
    expect(
      (await pool.query(`select 1 from member where user_id = $1`, [both.userId])).rows,
    ).toHaveLength(1);

    // The grants are kept as access history, every one revoked; the other location's stands.
    const grants = await inTenant(
      leaving.clinicId,
      async (c) =>
        (await c.query<{ revoked_at: Date | null }>(`select revoked_at from clinic_memberships`))
          .rows,
    );
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => g.revoked_at !== null)).toBe(true);
    const other = await inTenant(
      secondLocation,
      async (c) =>
        (await c.query<{ revoked_at: Date | null }>(`select revoked_at from clinic_memberships`))
          .rows,
    );
    expect(other).toEqual([{ revoked_at: null }]);

    // Every table the closure lists is empty for the clinic that left, and untouched for the one that stayed.
    const tables = await deletedAtClosure();
    expect(tables).toEqual(
      expect.arrayContaining(["agent_configs", "clinic_settings", "report_recipients"]),
    );
    expect(tables).not.toContain("clinic_memberships");
    for (const table of tables) expect(await countIn(leaving.clinicId, table), table).toBe(0);
    for (const table of [
      "agent_configs",
      "clinic_settings",
      "clinic_settings_history",
      "report_recipients",
      "clinic_touches",
      "site_rereads",
      "connection_links",
    ]) {
      expect(await countIn(staying.clinicId, table), table).toBeGreaterThan(0);
    }
    expect(
      (
        await pool.query(`select 1 from checkout_intents where provisioned_clinic_id = $1`, [
          leaving.clinicId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(`select 1 from checkout_intents where provisioned_clinic_id = $1`, [
          staying.clinicId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (await pool.query(`select 1 from session where user_id = $1`, [staying.staffUserId])).rows,
    ).toHaveLength(1);

    // Kept: the billing record, the notice and its ledger, and the record of
    // the notice addresses, the open one ended.
    for (const table of ["entitlements", "billing_notices", "report_deliveries"]) {
      expect(await countIn(leaving.clinicId, table), table).toBe(1);
    }
    const changes = await inTenant(
      leaving.clinicId,
      async (c) =>
        (
          await c.query<{ user_id: string; status: string }>(
            `select user_id, status from sign_in_address_changes order by new_email`,
          )
        ).rows,
    );
    expect(changes).toEqual([
      { user_id: leaving.staffUserId, status: "applied" },
      { user_id: leaving.staffUserId, status: "failed" },
    ]);

    // The clinic row: the anchor, its setup columns cleared, the number the
    // widget shows kept, and the agreement's notice address kept for six years.
    const clinic = await pool.query<{
      account_closed_at: Date | null;
      offboarding_started_at: Date;
      notice_address: string | null;
      notice_address_until: Date | null;
      website: string | null;
      site_profile: unknown;
      onboarding: unknown;
      carrier: string | null;
      booking_provider: string | null;
      meta_front_door_enabled: boolean;
      name: string;
      published_phone_e164: string | null;
    }>(`select * from clinics where id = $1`, [leaving.clinicId]);
    const row = clinic.rows[0]!;
    expect(row).toMatchObject({
      website: null,
      site_profile: null,
      onboarding: {},
      carrier: null,
      booking_provider: null,
      meta_front_door_enabled: false,
      // How calls were routed, what was confirmed, when it went live and the
      // package: setup, back to the defaults (the review's #12).
      call_routing: "conditional",
      call_routing_confirmed_at: null,
      timezone_confirmed_at: null,
      agent_approved_at: null,
      went_live_at: null,
      attribution_mode: "estimated",
      plan: null,
      name: "close-leaving Clinic",
      published_phone_e164: "+15550100002",
      notice_address: leaving.staffEmail,
    });
    expect(row.account_closed_at).not.toBeNull();
    const sixYears = new Date(row.offboarding_started_at);
    sixYears.setUTCFullYear(sixYears.getUTCFullYear() + 6);
    expect(row.notice_address_until!.getTime()).toBe(sixYears.getTime());

    // A notice the agreement still owes goes to that address: the senders'
    // one resolver finds it once no sign-in is left, for an owed kind only.
    const recipients = await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      billingRecipients(tx, "incident_report"),
    );
    expect(recipients).toEqual([{ email: leaving.staffEmail, role: "owner", userId: null }]);

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
    const events = await pool.query(
      `select 1 from security_events where event = 'clinic_account_closed' and metadata->>'clinicId' = $1`,
      [leaving.clinicId],
    );
    expect(events.rows).toHaveLength(1);

    // Once: nothing is due again, and a second call changes nothing.
    expect((await closeAccountsDue()).closed).toEqual([]);
    const again = await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) =>
      tx.db.execute<{ r: unknown }>(
        sql`select app_close_clinic_account(${leaving.clinicId}::uuid, null) as r`,
      ),
    );
    expect(again.rows[0]!.r).toBeNull();
  });

  test("a closed account takes no new grant, settings or setup row, an old stop link writes nothing, and the kept records stay writable", async () => {
    const c = await seedClinic("close-frozen");
    await seedAccount(c.clinicId, c.staffUserId, c.staffEmail);
    await leaveAndWait(c.clinicId);
    await destroyDueClinics();
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toContain(c.clinicId);
    const refused = (text: string, values: unknown[]) =>
      expect(asApp(c.clinicId, text, values)).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/account is closed/),
      });

    await refused(`insert into clinic_settings (clinic_id, daily_summary) values ($1, false)`, [
      c.clinicId,
    ]);
    await refused(`insert into agent_configs (clinic_id, greeting) values ($1, 'Back again')`, [
      c.clinicId,
    ]);
    await refused(
      `insert into clinic_memberships (clinic_id, user_id, role) values ($1, $2, 'owner')`,
      [c.clinicId, c.staffUserId],
    );
    await refused(`update clinic_memberships set revoked_at = null where clinic_id = $1`, [
      c.clinicId,
    ]);
    await refused(
      `insert into report_recipients (clinic_id, email, added_by) values ($1, 'back@example-clinic.test', 'ops')`,
      [c.clinicId],
    );

    // The stop link in an old email answers as done and writes nothing.
    expect(await stopOptionalEmail({ clinicId: c.clinicId, scope: "daily_summary" })).toMatchObject(
      {
        status: "stopped",
      },
    );
    expect(await countIn(c.clinicId, "clinic_settings")).toBe(0);

    // What the agreement still needs written after a closure is not frozen:
    // an incident report's notice, its ledger row, the audit log.
    await inTenant(c.clinicId, async (q) => {
      await q.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, 'incident_report', 'incident_report:x:1')`,
        [c.clinicId],
      );
      await q.query(
        `insert into report_deliveries (clinic_id, kind, period_key, recipient, status) values ($1, 'incident_report', 'x', $2, 'sent')`,
        [c.clinicId, c.staffEmail],
      );
    });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      tx.audit.record({ action: "read", resourceType: "incident", resultCount: 0 });
    });
  });

  test("the frozen tables are every one the destruction or the closure empties, and the kept access records; nothing else", async () => {
    const { rows } = await getMigratorPool().query<{ relname: string; frozen: boolean }>(
      `select c.relname,
              exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = c.relname || '_closed_account') as frozen
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'clinic_id' and a.attnum > 0 and not a.attisdropped)`,
    );
    expect(rows.length).toBeGreaterThan(20);
    const expected = rows
      .map((r) => r.relname)
      .filter((t) => !(t in KEPT_FOR_GOOD) || FROZEN_AT_CLOSURE.has(t))
      .sort();
    expect(
      rows
        .filter((r) => r.frozen)
        .map((r) => r.relname)
        .sort(),
    ).toEqual(expected);
  });

  test("the account waits for the agent's release at Retell, an open incident, a critical notice and the Stripe Connect link, telling ops once for each", async () => {
    const c = await seedClinic("close-waits");
    await seedChannels(c.clinicId, [{ channel: "voice" }]);
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = 'acct_closewaits' where id = $1`,
      [c.clinicId],
    );
    await inTenant(c.clinicId, async (q) => {
      await q.query(
        `insert into incidents (clinic_id, class, summary, discovered_at, notify_by, opened_by)
         values ($1, 'security_incident', 'Notice 7f3a went to a second inbox.', now(), now() + interval '1 day', 'ops')`,
        [c.clinicId],
      );
      await q.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, 'incident_report', 'incident_report:wait:1')`,
        [c.clinicId],
      );
    });
    await leaveAndWait(c.clinicId);
    await destroyDueClinics();

    const waitingOn = async () => {
      const run = await closeAccountsDue();
      expect(run.closed.map((x) => x.clinicId)).not.toContain(c.clinicId);
      return run.waiting.find((w) => w.clinicId === c.clinicId)?.on ?? null;
    };
    const alerts = async () =>
      (
        await getMigratorPool().query<{ code: string }>(
          `select fields->>'code' as code from ops_alerts where event = 'account_closure_waiting' and fields->>'clinicId' = $1 order by raised_at`,
          [c.clinicId],
        )
      ).rows.map((r) => r.code);

    expect(await waitingOn()).toBe("voice_agent");
    await expect(
      asApp(c.clinicId, `select app_close_clinic_account($1::uuid, null)`, [c.clinicId]),
    ).rejects.toThrow(/cannot close yet: voice_agent/);
    await recordVoiceVendorDeletion({
      clinicId: c.clinicId,
      clinicSlug: c.slug,
      how: "released",
      actorLabel: "ops@healdesk.test",
      step: "agent",
    });

    expect(await waitingOn()).toBe("incident_open");
    await inTenant(c.clinicId, (q) =>
      q.query(
        `update incidents set resolved_at = now(), resolution = 'contained' where clinic_id = $1`,
        [c.clinicId],
      ),
    );
    expect(await waitingOn()).toBe("critical_notice");
    await inTenant(c.clinicId, (q) =>
      q.query(`update billing_notices set attempts = 6 where clinic_id = $1`, [c.clinicId]),
    );
    expect(await waitingOn()).toBe("stripe_connect");
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = null where id = $1`,
      [c.clinicId],
    );

    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toEqual([c.clinicId]);
    // Ops heard once of each thing it waited on, in order.
    expect(await alerts()).toEqual([
      "voice_agent",
      "incident_open",
      "critical_notice",
      "stripe_connect",
    ]);
  });

  test("the account closes only after destruction, and only once forwarded calls stop passing through", async () => {
    const c = await seedClinic("close-timing");
    await seedAccount(c.clinicId, c.staffUserId, c.staffEmail);
    const refused = (text: RegExp) =>
      expect(
        asApp(c.clinicId, `select app_close_clinic_account($1::uuid, null)`, [c.clinicId]),
      ).rejects.toThrow(text);

    await refused(/not_destroyed/);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      startOffboarding(tx, "operator"),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      markExportDelivered(tx, "bundle handed over"),
    );
    await refused(/not_destroyed/);

    // Destroyed on day 29, a day before the pass-through ends: the direct line
    // and the clinic's address are still needed, so the account stays open.
    await backdate(c.clinicId, FORWARDING_PASS_THROUGH_DAYS - 0.5);
    expect((await destroyDueClinics()).map((d) => d.clinicId)).toContain(c.clinicId);
    await refused(/pass_through/);
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).not.toContain(c.clinicId);
    expect(await countIn(c.clinicId, "clinic_settings")).toBe(1);

    // The pass-through's last hour passes: the next hourly run closes it.
    await backdate(c.clinicId, 0.5 + 1 / 24);
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toEqual([c.clinicId]);
    expect(await countIn(c.clinicId, "clinic_settings")).toBe(0);
  });

  test("the kept notice address ends with its six years", async () => {
    const c = await seedClinic("close-notice-expiry");
    await leaveAndWait(c.clinicId);
    await destroyDueClinics();
    await closeAccountsDue();
    const read = async () =>
      (
        await getMigratorPool().query<{ a: string | null }>(
          `select notice_address as a from clinics where id = $1`,
          [c.clinicId],
        )
      ).rows[0]!.a;
    expect(await read()).toBe(c.staffEmail);
    const owed = () =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        billingRecipients(tx, "incident_report"),
      );
    expect(await owed()).toEqual([{ email: c.staffEmail, role: "owner", userId: null }]);
    await getMigratorPool().query(
      `update clinics set notice_address_until = now() - interval '1 minute' where id = $1`,
      [c.clinicId],
    );
    // Past its end, the address is never used, though the hourly job has not
    // cleared it yet (healdesk-io-58's review).
    expect(await read()).toBe(c.staffEmail);
    expect(await owed()).toEqual([]);
    expect((await closeAccountsDue()).noticeAddressesExpired).toBeGreaterThanOrEqual(1);
    expect(await read()).toBeNull();
    // With nothing kept, the senders' resolver finds no address at all.
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => billingRecipients(tx)),
    ).toEqual([]);
  });

  test("another tenant's account cannot be closed, the runtime role cannot stamp a closure or a notice address, and no clinic is born closed", async () => {
    const mine = await seedClinic("close-mine");
    const theirs = await seedClinic("close-theirs");
    await expect(
      asApp(mine.clinicId, `select app_close_clinic_account($1::uuid, null)`, [theirs.clinicId]),
    ).rejects.toMatchObject({ code: "42501" });
    for (const column of [
      "account_closed_at = now()",
      "notice_address = 'x@example.test'",
      "notice_address_until = now()",
    ]) {
      await expect(
        asApp(mine.clinicId, `update clinics set ${column} where id = $1`, [mine.clinicId]),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      getAppPool().query(
        `insert into clinics (organization_id, slug, name, specialty, account_closed_at)
         values ($1, $2, 'Born closed', 'med-spa', now())`,
        [mine.organizationId, `born-closed-${randomUUID().slice(0, 6)}`],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The pass-through the database counts is the catalog's.
    const { rows } = await getMigratorPool().query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname = 'app_account_closure_waiting_on' or proname = 'app_accounts_to_close'`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.prosrc).toContain(`make_interval(hours => ${24 * FORWARDING_PASS_THROUGH_DAYS})`);
  });

  test("the closure waits for exactly the registry's critical notice kinds", async () => {
    const { rows } = await getMigratorPool().query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname = 'app_account_closure_waiting_on'`,
    );
    const list = /b\.kind IN \(([^)]*)\)/.exec(rows[0]!.prosrc)![1]!;
    const inSql = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    const critical = Object.entries(NOTICE_KIND_REGISTRY)
      .filter(([, a]) => a.priority === "critical")
      .map(([k]) => k)
      .sort();
    expect(inSql).toEqual(critical);
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
    expect([...FROZEN_AT_CLOSURE].filter((t) => !(t in KEPT_FOR_GOOD))).toEqual([]);
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
    await leaveAndWait(c.clinicId);
    await destroyDueClinics();
    const run = await closeAccountsDue();
    expect(run.closed.find((x) => x.clinicId === c.clinicId)?.closed.connection_links).toBe(1);
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

  test("the closure deletes the person's Better Auth rows by their id, never another person's whose address contains theirs", async () => {
    // The review's N4: the rows were matched by the address as a substring of
    // the identifier and value, so closing a@b.com deleted xa@b.com's, and
    // the forms Better Auth writes here, which hold the user's id and no
    // address, were never matched at all.
    const leaving = await seedClinic("close-near");
    const staying = await seedClinic("xclose-near");
    expect(staying.staffEmail).toContain(leaving.staffEmail);
    const own = `reset-password:${randomBytes(12).toString("hex")}`;
    await seedVerification(own, leaving.staffUserId);
    const theirs = [
      `reset-password:${randomBytes(12).toString("hex")}`,
      `sign-in-otp-${staying.staffEmail}`,
    ];
    await seedVerification(theirs[0]!, staying.staffUserId);
    await seedVerification(theirs[1]!, `${randomBytes(8).toString("hex")}:0`);

    await leaveAndWait(leaving.clinicId);
    await destroyDueClinics();
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toContain(leaving.clinicId);

    const { rows } = await getMigratorPool().query<{ identifier: string }>(
      `select identifier from verification where identifier = any($1::text[]) order by identifier`,
      [[own, ...theirs]],
    );
    expect(rows.map((r) => r.identifier)).toEqual([...theirs].sort());
  });

  test("a closed account's notice address receives only the notices still owed after the end, through the outbox", async () => {
    // healdesk-io-58's review: the fallback served every kind, so a product
    // update, a recap or a dunning email queued for a closed account would
    // have gone to the address kept for the agreement's notices.
    const c = await seedClinic("close-owed-kinds");
    await seedAccount(c.clinicId, c.staffUserId, c.staffEmail);
    await leaveAndWait(c.clinicId);
    await destroyDueClinics();
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toContain(c.clinicId);

    for (const kind of OWED_AFTER_CLOSURE) {
      expect(
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          billingRecipients(tx, kind),
        ),
        kind,
      ).toEqual([{ email: c.staffEmail, role: "owner", userId: null }]);
    }
    // A final invoice raised, declined or waiting on the practice is still
    // owed after the end (healdesk-io-58's review); the states of a
    // subscription that ended with the service are not.
    expect([...OWED_AFTER_CLOSURE]).toEqual(
      expect.arrayContaining([
        "overage_invoiced",
        "payment_failed",
        "payment_action_required",
        // The first-month guarantee survives termination (Terms section 15).
        "guarantee_claim_received",
        "guarantee_finding",
      ]),
    );
    const notOwed = NOTICE_KINDS.filter((k) => !OWED_AFTER_CLOSURE.has(k));
    expect(notOwed).toEqual(
      expect.arrayContaining([
        "product_update",
        "weekly_recap",
        "grace_ending",
        "suspended",
        "renewal_upcoming",
        "card_expiring",
      ]),
    );
    for (const kind of [undefined, ...notOwed]) {
      expect(
        await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          billingRecipients(tx, kind),
        ),
        String(kind),
      ).toEqual([]);
    }

    // And the send itself: the outbox resolves each notice's recipients by
    // its own kind.
    const sent: { to: string; kind: string }[] = [];
    const ids = new Map<string, string>();
    for (const kind of ["incident_report", "refund_issued", "product_update", "weekly_recap"]) {
      const { rows } = await inTenant(c.clinicId, (q) =>
        q.query<{ id: string }>(
          `insert into billing_notices (clinic_id, kind, dedupe_key) values ($1, $2, $3) returning id`,
          [c.clinicId, kind, `${kind}:closed:1`],
        ),
      );
      ids.set(kind, rows[0]!.id);
    }
    const template: TemplateEntry = {
      render: (_payload, ctx) =>
        compose({ subject: "A notice", preheader: "A test notice.", blocks: [] }, ctx),
      fixture: {},
    };
    for (const [kind, id] of ids) {
      await deliverNotice(c.clinicId, id, {
        now: new Date("2030-01-15T16:00:00Z"),
        templates: () => template,
        transport: {
          name: "fake",
          send: async (target) => {
            sent.push({ to: target.to, kind });
            return { status: "sent", messageId: `msg_${sent.length}` };
          },
        },
      });
    }
    expect(sent.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { to: c.staffEmail, kind: "incident_report" },
      { to: c.staffEmail, kind: "refund_issued" },
    ]);

    // The first-month guarantee survives termination (Terms section 15): a
    // claim can come up to 30 days after the first month, so after a
    // first-month cancellation it can reach us after the account closed. Its
    // acknowledgement is queued rather than refused for want of an address,
    // and goes to the address kept for the agreement's notices.
    const claim = await recordGuaranteeClaim(c.clinicId, {
      claimReceivedOn: new Date().toISOString().slice(0, 10),
      actorLabel: "ops@healdesk.test",
    });
    expect(claim).toMatchObject({ status: "queued" });
    expect(
      await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        billingRecipients(tx, "guarantee_finding"),
      ),
    ).toEqual([{ email: c.staffEmail, role: "owner", userId: null }]);
  });

  test("accepting an invitation for an organisation with a closed location completes, and grants the closed location nothing", async () => {
    // The review's N2: the grant loop inserts a membership into each clinic of
    // the organisation, and the closed location's freeze would refuse one and
    // roll back every live location's grant with it. The loop now passes over
    // a closed location (lib/access.ts). As the runtime role, which is what
    // the sign-up hook runs as, the loop's read of the organisation's clinics
    // sees none at all (clinics_tenant_isolation, 0002, with no tenant set),
    // so today it grants no location: v1 writes no invitation (one shared
    // sign-in), and this pins that. Reviving the grant for the spec's
    // deferred roles changes the clinicIds below, and must keep the closed
    // location's count at zero.
    const closed = await seedClinic("close-invite");
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into clinics (organization_id, slug, name, specialty) values ($1, $2, 'Live location', 'med-spa') returning id`,
      [closed.organizationId, `close-invite-live-${randomUUID().slice(0, 6)}`],
    );
    const live = rows[0]!.id;
    await leaveAndWait(closed.clinicId);
    await destroyDueClinics();
    expect((await closeAccountsDue()).closed.map((x) => x.clinicId)).toContain(closed.clinicId);

    const inviter = await seedPortalUser(live, "owner", { label: "inviter" });
    const suffix = randomUUID().slice(0, 8);
    const invitee = { id: `usr_invitee_${suffix}`, email: `invitee-${suffix}@example-clinic.test` };
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Invitee', $2, true, now(), now())`,
      [invitee.id, invitee.email],
    );
    await getMigratorPool().query(
      `insert into invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '1 day', now(), $4)`,
      [`inv_${suffix}`, closed.organizationId, invitee.email, inviter.userId],
    );

    const accepted = await acceptInvitationFor(invitee.email, invitee.id);
    expect(accepted).toEqual({ organizationId: closed.organizationId, clinicIds: [] });
    const { rows: claimed } = await getMigratorPool().query<{ status: string }>(
      `select status from invitation where id = $1`,
      [`inv_${suffix}`],
    );
    expect(claimed).toEqual([{ status: "accepted" }]);
    const grants = async (clinicId: string) =>
      (
        await inTenant(clinicId, (q) =>
          q.query<{ n: number }>(
            `select count(*)::int as n from clinic_memberships where clinic_id = $1 and user_id = $2`,
            [clinicId, invitee.id],
          ),
        )
      ).rows[0]!.n;
    expect(await grants(closed.clinicId)).toBe(0);
    expect(await grants(live)).toBe(0);
  });
});
