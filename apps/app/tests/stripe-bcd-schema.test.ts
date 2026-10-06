import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { STRIPE_CONNECT_RETURN_TO, TENANT_SCOPED_TABLES } from "@/db/schema";
import {
  getJob,
  JOB_BILLING_RECONCILE,
  JOB_BILLING_REQUESTS,
  JOB_CARD_EXPIRING,
  JOB_SETUP_CLOSURE,
} from "@/lib/scheduler/jobs";

import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * drizzle/0047 (the Stripe build, S0), asserted: the billing-request ledger's
 * row-level security, privileges and CHECKs; the two definers it is written
 * and drained through, including that the recorder resolves a location's
 * billing clinic and that both hand the caller's tenant setting back; the
 * deposit definer; one live deposit link per appointment; the entitlements
 * columns added and dropped; the Connect return targets; and the four job
 * seeds, read from the migration itself.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One block on the RUNTIME role, optionally inside a tenant, always rolled back. */
async function asApp<T>(clinicId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    if (clinicId) await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function tablePrivileges(table: string): Promise<Record<string, boolean>> {
  const { rows } = await getMigratorPool().query<Record<string, boolean>>(
    `select has_table_privilege('healdesk_app', $1::regclass, 'SELECT') as select,
            has_table_privilege('healdesk_app', $1::regclass, 'INSERT') as insert,
            has_table_privilege('healdesk_app', $1::regclass, 'UPDATE') as update,
            has_table_privilege('healdesk_app', $1::regclass, 'DELETE') as delete`,
    [table],
  );
  return rows[0]!;
}

/** The columns of `table` the runtime role may UPDATE, sorted. */
async function updatableColumns(table: string): Promise<string[]> {
  const { rows } = await getMigratorPool().query<{ attname: string }>(
    `select a.attname
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('healdesk_app', a.attrelid, a.attnum, 'UPDATE')
      order by a.attname`,
    [table],
  );
  return rows.map((r) => r.attname);
}

/** A location billed on `billingClinicId`: a clinic in the same organisation pointing at it. */
async function seedLocation(billingClinicId: string, organizationId: string): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [organizationId, `loc-${randomUUID().slice(0, 6)}`, billingClinicId],
  );
  return rows[0]!.id;
}

/** A request row as the migrator would write it, inside the clinic's tenant. */
async function insertRequest(
  clinicId: string,
  values: {
    kind: string;
    channelKey?: string;
    nextAttemptAt?: Date;
    leaseUntil?: Date | null;
    done?: boolean;
  },
): Promise<string> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into billing_requests (clinic_id, kind, channel_key, reason, next_attempt_at, lease_until, done_at, outcome)
       values ($1, $2, $3, 'reconcile', $4, $5,
               case when $6::boolean then now() end, case when $6::boolean then 'done' end)
       returning id`,
      [
        clinicId,
        values.kind,
        values.channelKey ?? "-",
        values.nextAttemptAt ?? new Date("2026-10-06T10:00:00Z"),
        values.leaseUntil ?? null,
        values.done ?? false,
      ],
    );
    return rows[0]!.id;
  });
}

describeDb("drizzle/0047: the Stripe build's schema", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  describe("billing_requests", () => {
    test("forces RLS, has exactly its isolation policy and is listed as tenant-scoped", async () => {
      const { rows } = await getMigratorPool().query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: string[];
      }>(
        `select c.relrowsecurity, c.relforcerowsecurity,
                coalesce(array_agg(p.polname::text) filter (where p.polname is not null), array[]::text[]) as policies
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           left join pg_policy p on p.polrelid = c.oid
          where c.relname = 'billing_requests'
          group by c.relrowsecurity, c.relforcerowsecurity`,
      );
      expect(rows).toEqual([
        {
          relrowsecurity: true,
          relforcerowsecurity: true,
          policies: ["billing_requests_tenant_isolation"],
        },
      ]);
      expect((TENANT_SCOPED_TABLES as readonly string[]).includes("billing_requests")).toBe(true);
    });

    test("the runtime role may read and append, move only the worker's columns, and never delete", async () => {
      expect(await tablePrivileges("billing_requests")).toEqual({
        select: true,
        insert: true,
        update: false,
        delete: false,
      });
      expect(await updatableColumns("billing_requests")).toEqual([
        "attempts",
        "done_at",
        "last_error",
        "lease_until",
        "next_attempt_at",
        "outcome",
        "outcome_reason",
        "reason",
      ]);

      const { clinicId } = await seedClinic("req-grants");
      const id = await insertRequest(clinicId, { kind: "plan_start" });
      await asApp(clinicId, async (c) => {
        await c.query("savepoint s");
        for (const statement of [
          `update billing_requests set kind = 'step_up', channel_key = 'web' where id = $1`,
          `update billing_requests set requested_at = now() - interval '1 day' where id = $1`,
          `update billing_requests set clinic_id = clinic_id where id = $1`,
          `delete from billing_requests where id = $1`,
        ]) {
          await expect(c.query(statement, [id]), statement).rejects.toMatchObject({
            code: "42501",
          });
          await c.query("rollback to savepoint s");
        }
        // The worker's claim: a conditional UPDATE of its own columns.
        const claimed = await c.query(
          `update billing_requests
              set lease_until = now() + interval '5 minutes', attempts = attempts + 1
            where id = $1 and done_at is null and (lease_until is null or lease_until < now())
            returning attempts`,
          [id],
        );
        expect(claimed.rows).toEqual([{ attempts: 1 }]);
        const finished = await c.query(
          `update billing_requests
              set done_at = now(), outcome = 'skipped', outcome_reason = 'cancel_pending', lease_until = null
            where id = $1 and attempts = 1 and done_at is null returning id`,
          [id],
        );
        expect(finished.rows).toHaveLength(1);
      });
    });

    test("the CHECKs hold the kinds, channels, reasons and outcomes, and one row per clinic, kind and channel", async () => {
      const { clinicId } = await seedClinic("req-checks");
      await asApp(clinicId, async (c) => {
        const insert = (columns: string, values: string) =>
          c.query(`insert into billing_requests (clinic_id, ${columns}) values ($1, ${values})`, [
            clinicId,
          ]);
        await c.query("savepoint s");
        const refused: [string, string][] = [
          ["kind, reason", "'refund', 'ops'"],
          ["kind, reason", "'plan_start', 'whim'"],
          ["kind, channel_key, reason", "'step_up', 'sms', 'first_answer'"],
          // A step-up names its channel, and nothing else names one.
          ["kind, reason", "'step_up', 'first_answer'"],
          ["kind, channel_key, reason", "'plan_start', 'voice', 'first_answer'"],
          ["kind, reason, outcome, done_at", "'plan_start', 'ops', 'won', now()"],
          // Finished means an outcome, and only a finished request has one.
          ["kind, reason, outcome", "'plan_start', 'ops', 'done'"],
          ["kind, reason, done_at", "'plan_start', 'ops', now()"],
          [
            "kind, reason, outcome, done_at, outcome_reason",
            "'plan_start', 'ops', 'skipped', now(), 'Not A Code'",
          ],
          ["kind, reason, last_error", `'plan_start', 'ops', '${"x".repeat(301)}'`],
          ["kind, reason, attempts", "'plan_start', 'ops', -1"],
        ];
        for (const [columns, values] of refused) {
          await expect(insert(columns, values), values).rejects.toMatchObject({ code: "23514" });
          await c.query("rollback to savepoint s");
        }

        for (const kind of ["plan_start", "close_setup", "cancel_now"]) {
          await insert("kind, reason", `'${kind}', 'ops'`);
        }
        for (const channel of ["web", "meta", "voice"]) {
          await insert("kind, channel_key, reason", `'step_up', '${channel}', 'waiting'`);
        }
        await c.query("savepoint t");
        await expect(insert("kind, reason", "'plan_start', 'reconcile'")).rejects.toMatchObject({
          code: "23505",
        });
        await c.query("rollback to savepoint t");
        await expect(
          insert("kind, channel_key, reason", "'step_up', 'voice', 'first_answer'"),
        ).rejects.toMatchObject({ code: "23505" });
      });
    });
  });

  describe("app_record_billing_request", () => {
    test("records on the billing clinic from a location's tenant, once, and hands the tenant back", async () => {
      const billing = await seedClinic("rec-billing");
      const location = await seedLocation(billing.clinicId, billing.organizationId);

      await asApp(location, async (c) => {
        const first = await c.query<{ recorded: boolean }>(
          `select app_record_billing_request('plan_start', '-', 'first_answer') as recorded`,
        );
        expect(first.rows[0]!.recorded).toBe(true);
        const again = await c.query<{ recorded: boolean }>(
          `select app_record_billing_request('plan_start', '-', 'reconcile') as recorded`,
        );
        expect(again.rows[0]!.recorded).toBe(false);
        const stepUp = await c.query<{ recorded: boolean }>(
          `select app_record_billing_request('step_up', 'voice', 'first_answer') as recorded`,
        );
        expect(stepUp.rows[0]!.recorded).toBe(true);

        // The caller's tenant is the location again, and the location's own
        // view holds no request: they live on the billing clinic.
        const tenant = await c.query<{ tenant: string }>(
          `select current_setting('app.clinic_id', true) as tenant`,
        );
        expect(tenant.rows[0]!.tenant).toBe(location);
        expect((await c.query(`select id from billing_requests`)).rows).toEqual([]);

        // A refused insert restores the tenant too.
        await c.query("savepoint s");
        await expect(
          c.query(`select app_record_billing_request('refund', '-', 'ops')`),
        ).rejects.toMatchObject({ code: "23514" });
        await c.query("rollback to savepoint s");
        const after = await c.query<{ tenant: string }>(
          `select current_setting('app.clinic_id', true) as tenant`,
        );
        expect(after.rows[0]!.tenant).toBe(location);
      });

      // Committed this time, to read it back from the billing clinic.
      const client = await getAppPool().connect();
      try {
        await client.query("begin");
        await client.query(`select set_config('app.clinic_id', $1, true)`, [location]);
        await client.query(`select app_record_billing_request('close_setup', '-', 'deadline')`);
        await client.query("commit");
      } finally {
        client.release();
      }
      const rows = await inTenant(billing.clinicId, async (c) => {
        const { rows } = await c.query<{ clinic_id: string; kind: string; reason: string }>(
          `select clinic_id, kind, reason from billing_requests`,
        );
        return rows;
      });
      expect(rows).toEqual([
        { clinic_id: billing.clinicId, kind: "close_setup", reason: "deadline" },
      ]);
    });

    test("refuses a caller with no tenant, and writes nowhere else", async () => {
      await asApp(null, async (c) => {
        await expect(
          c.query(`select app_record_billing_request('plan_start', '-', 'ops')`),
        ).rejects.toMatchObject({ code: "42501" });
      });
      // A tenant naming no clinic at all.
      await asApp(randomUUID(), async (c) => {
        await expect(
          c.query(`select app_record_billing_request('plan_start', '-', 'ops')`),
        ).rejects.toMatchObject({ code: "23503" });
      });
    });
  });

  describe("app_due_billing_requests", () => {
    test("walks every billing clinic, returns due rows only, filters by kind and hands the tenant back", async () => {
      await getMigratorPool().query(`truncate billing_requests`);
      const a = await seedClinic("due-a");
      const b = await seedClinic("due-b");
      const at = new Date("2026-10-06T12:00:00Z");
      const early = new Date("2026-10-06T09:00:00Z");
      const aDue = await insertRequest(a.clinicId, { kind: "plan_start", nextAttemptAt: early });
      const bDue = await insertRequest(b.clinicId, {
        kind: "step_up",
        channelKey: "voice",
        nextAttemptAt: new Date("2026-10-06T10:00:00Z"),
      });
      // Not due: leased by a running worker, finished, or not yet time.
      await insertRequest(b.clinicId, {
        kind: "plan_start",
        leaseUntil: new Date("2026-10-06T12:05:00Z"),
      });
      await insertRequest(a.clinicId, { kind: "step_up", channelKey: "web", done: true });
      await insertRequest(a.clinicId, {
        kind: "cancel_now",
        nextAttemptAt: new Date("2026-10-06T13:00:00Z"),
      });
      // Due, but a kind the caller left out (setup-closure is off).
      const closeDue = await insertRequest(b.clinicId, {
        kind: "close_setup",
        nextAttemptAt: early,
      });
      // A lease that ran out is due again.
      const lapsed = await insertRequest(a.clinicId, {
        kind: "close_setup",
        nextAttemptAt: early,
        leaseUntil: new Date("2026-10-06T11:00:00Z"),
      });

      await asApp(null, async (c) => {
        const { rows } = await c.query<Record<string, unknown>>(
          `select * from app_due_billing_requests($1, 10, array['plan_start', 'step_up', 'cancel_now'])`,
          [at],
        );
        expect(rows.map((r) => r.id)).toEqual([aDue, bDue]);
        expect(rows.map((r) => r.clinic_id)).toEqual([a.clinicId, b.clinicId]);
        expect(Object.keys(rows[0]!).sort()).toEqual([
          "clinic_id",
          "id",
          "kind",
          "next_attempt_at",
        ]);

        const withClosures = await c.query<{ id: string }>(
          `select id from app_due_billing_requests($1, 10, array['plan_start', 'step_up', 'cancel_now', 'close_setup'])`,
          [at],
        );
        expect(withClosures.rows.map((r) => r.id).sort()).toEqual(
          [aDue, bDue, closeDue, lapsed].sort(),
        );

        // Earliest first, cut to max.
        const one = await c.query<{ id: string }>(
          `select id from app_due_billing_requests($1, 1, array['plan_start', 'step_up'])`,
          [at],
        );
        expect(one.rows.map((r) => r.id)).toEqual([aDue]);

        const tenant = await c.query<{ tenant: string | null }>(
          `select app_current_clinic_id()::text as tenant`,
        );
        expect(tenant.rows[0]!.tenant).toBeNull();
      });

      // From inside a tenant, that tenant comes back unchanged.
      await asApp(b.clinicId, async (c) => {
        await c.query(`select * from app_due_billing_requests($1, 10, array['plan_start'])`, [at]);
        const tenant = await c.query<{ tenant: string }>(
          `select current_setting('app.clinic_id', true) as tenant`,
        );
        expect(tenant.rows[0]!.tenant).toBe(b.clinicId);
      });
    });
  });

  describe("deposits", () => {
    test("app_clinic_for_deposit finds a deposit's clinic across tenants and hands the tenant back", async () => {
      const billing = await seedClinic("dep-billing");
      const location = await seedLocation(billing.clinicId, billing.organizationId);
      const other = await seedClinic("dep-other");
      const { appointmentId } = await seedConversation(location, {
        startedAt: new Date("2026-10-06T10:00:00Z"),
        booked: true,
      });
      const depositId = await inTenant(location, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status)
           values ($1, $2, 'web', 5000, 'acct_testdeposit', 'open') returning id`,
          [location, appointmentId],
        );
        return rows[0]!.id;
      });

      await asApp(other.clinicId, async (c) => {
        const found = await c.query<{ clinic: string | null }>(
          `select app_clinic_for_deposit($1::uuid)::text as clinic`,
          [depositId],
        );
        expect(found.rows[0]!.clinic).toBe(location);
        const none = await c.query<{ clinic: string | null }>(
          `select app_clinic_for_deposit($1::uuid)::text as clinic`,
          [randomUUID()],
        );
        expect(none.rows[0]!.clinic).toBeNull();
        const nothing = await c.query<{ clinic: string | null }>(
          `select app_clinic_for_deposit(null)::text as clinic`,
        );
        expect(nothing.rows[0]!.clinic).toBeNull();
        const tenant = await c.query<{ tenant: string }>(
          `select current_setting('app.clinic_id', true) as tenant`,
        );
        expect(tenant.rows[0]!.tenant).toBe(other.clinicId);
      });
    });

    test("an appointment has at most one live deposit link", async () => {
      const { clinicId } = await seedClinic("dep-one-link");
      const { appointmentId } = await seedConversation(clinicId, {
        startedAt: new Date("2026-10-06T10:00:00Z"),
        booked: true,
      });
      await asApp(clinicId, async (c) => {
        const insert = (status: string, appointment: string | null = appointmentId) =>
          c.query<{ id: string }>(
            `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status)
             values ($1, $2, 'meta', 2500, 'acct_testdeposit', $3) returning id`,
            [clinicId, appointment, status],
          );
        const first = await insert("creating");
        await c.query("savepoint s");
        await expect(insert("open")).rejects.toMatchObject({ code: "23505" });
        await c.query("rollback to savepoint s");
        // Finished links do not count, and neither do links with no appointment.
        await insert("paid");
        await insert("expired");
        await insert("open", null);
        await insert("open", null);
        // Once the live one is over, a new one may open.
        await c.query(`update deposit_payments set status = 'expired' where id = $1`, [
          first.rows[0]!.id,
        ]);
        await insert("open");
      });
    });
  });

  describe("entitlements", () => {
    test("gains the deferred start's columns, writable by the runtime role, and loses the setup-fee refund", async () => {
      const added = [
        "first_plan_invoice_id",
        "open_invoice_amount_cents",
        "pending_location_charged_at",
        "pending_location_count",
        "pending_location_request_id",
        "plan_start_applied_at",
        "stripe_mutation_lease_owner",
        "stripe_mutation_lease_until",
      ];
      const updatable = await updatableColumns("entitlements");
      for (const column of added) expect(updatable, column).toContain(column);
      const { rows } = await getMigratorPool().query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'entitlements'
            and column_name in ('setup_fee_refunded_at', 'setup_fee_refunded_usd')`,
      );
      expect(rows).toEqual([]);
    });

    test("a lease is a holder and an expiry together, and a pending location is a valid request", async () => {
      const { clinicId } = await seedClinic("ent-checks");
      await asApp(clinicId, async (c) => {
        await c.query(
          `insert into entitlements (clinic_id, plan_code, billing_interval) values ($1, 'complete', 'month')`,
          [clinicId],
        );
        await c.query("savepoint s");
        for (const set of [
          "stripe_mutation_lease_until = now()",
          "stripe_mutation_lease_owner = 'billing_request:x:1'",
          `stripe_mutation_lease_until = now(), stripe_mutation_lease_owner = '${"o".repeat(121)}'`,
          "pending_location_request_id = 'req-1'",
          "pending_location_count = 2",
          "pending_location_charged_at = now()",
          "pending_location_request_id = 'req-1', pending_location_count = 1",
          "pending_location_request_id = 'not a token!', pending_location_count = 2",
        ]) {
          await expect(
            c.query(`update entitlements set ${set} where clinic_id = $1`, [clinicId]),
            set,
          ).rejects.toMatchObject({ code: "23514" });
          await c.query("rollback to savepoint s");
        }
        const ok = await c.query(
          `update entitlements
              set stripe_mutation_lease_until = now() + interval '5 minutes',
                  stripe_mutation_lease_owner = 'change_plan:3fa85f64',
                  pending_location_request_id = '3fa85f64-5717-4562-b3fc-2c963f66afa6',
                  pending_location_count = 2,
                  pending_location_charged_at = now(),
                  plan_start_applied_at = now(),
                  first_plan_invoice_id = 'in_firstplan',
                  open_invoice_amount_cents = 89700
            where clinic_id = $1 returning clinic_id`,
          [clinicId],
        );
        expect(ok.rows).toHaveLength(1);
      });
    });
  });

  test("a Connect state returns to the portal's Settings, the setup wizard or the operator's page, and nowhere else", async () => {
    expect([...STRIPE_CONNECT_RETURN_TO]).toEqual(["settings", "setup", "ops"]);
    const { clinicId } = await seedClinic("connect-return");
    await asApp(null, async (c) => {
      const insert = (returnTo: string) =>
        c.query(
          `insert into stripe_connect_states (state_hash, target_clinic_id, return_to, expires_at)
           values (sha256(gen_random_uuid()::text::bytea), $1, $2, now() + interval '15 minutes')`,
          [clinicId, returnTo],
        );
      for (const returnTo of STRIPE_CONNECT_RETURN_TO) await insert(returnTo);
      await c.query("savepoint s");
      for (const refused of ["portal", "admin"]) {
        await expect(insert(refused), refused).rejects.toMatchObject({ code: "23514" });
        await c.query("rollback to savepoint s");
      }
    });
  });

  test("the migration itself seeds the four jobs, and seeds them off", async () => {
    // Read the migration, not the table: truncateAll() reseeds scheduled_jobs
    // from tests/setup/db.ts after every TRUNCATE ... CASCADE, so a query here
    // alone would check the harness's copy and pass with a misspelled seed.
    // Found by its tag, not its number: the number is assigned when the
    // branch merges (build spec R27).
    const drizzleDir = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_stripe_bcd\.sql$/.test(name));
    expect(files).toHaveLength(1);
    const sql = readFileSync(`${drizzleDir}${files[0]!}`, "utf8");
    const insert = sql.match(
      /INSERT INTO scheduled_jobs[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/i,
    )?.[0];
    expect(insert, "0047 seeds scheduled_jobs").toBeDefined();
    // ('name', 'cadence, with '' escapes', enabled)
    const row = /\(\s*'([a-z-]+)'\s*,\s*'(?:[^']|'')*'\s*,\s*(true|false)\s*\)/gi;
    const seeded = [...insert!.matchAll(row)].map((m) => [m[1]!, m[2]!.toLowerCase()]);
    expect(seeded.sort()).toEqual(
      [
        ["billing-reconcile", "false"],
        ["billing-requests", "false"],
        ["card-expiring", "false"],
        ["setup-closure", "false"],
      ].sort(),
    );
    // They are the names the code reads: a mismatch makes runJob throw
    // "Unknown job" on every tick.
    const names = [
      JOB_BILLING_REQUESTS,
      JOB_SETUP_CLOSURE,
      JOB_BILLING_RECONCILE,
      JOB_CARD_EXPIRING,
    ];
    expect(seeded.map(([name]) => name).sort()).toEqual([...names].sort());
    // And the harness reseeds every one of them, off, after a truncate.
    for (const name of names) {
      const job = await getJob(name);
      expect(job, name).toBeDefined();
      expect(job!.enabled, name).toBe(false);
    }
  });
});
