import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// One clinic's tenant read, or the BAA floor's read, can be made to fail, to
// prove an unread part is named rather than counted as empty.
const failing = vi.hoisted(() => ({ clinicId: null as string | null, floor: false }));
vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    withTenant: async (...args: Parameters<typeof actual.withTenant>) => {
      if (failing.clinicId && args[0].clinicId === failing.clinicId) throw new Error("synthetic read failure");
      return actual.withTenant(...args);
    },
  };
});
vi.mock("@/lib/agreements/resign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agreements/resign")>();
  return {
    ...actual,
    belowFloorUnsigned: async (...args: Parameters<typeof actual.belowFloorUnsigned>) => {
      if (failing.floor) throw new Error("synthetic read failure");
      return actual.belowFloorUnsigned(...args);
    },
  };
});

import { runOperation, type Operator } from "@/lib/ops/api";
import { MACHINE_QUEUES_PAGE, QUEUE_WORDS, needsAttention, queuesSource, wordsFor } from "@/lib/ops/inbox/queues";
import { readOpsInbox } from "@/lib/ops/inbox/run";
import type { MachineQueue, MachineQueues } from "@/lib/ops/machine-queues-ops";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * Lane P5d: `listMachineQueues`, the System page's read-only section, and
 * Home's queue rows, which read the same queues (readMachineQueues) and
 * judge them by the same rule (needsAttention). Rows are seeded as the code
 * that owns each queue writes them; nothing here is a patient.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The pg-boss stand-in (below) is this file's own, known by its marker table.
 * A real pg-boss schema (no marker) is never touched; one left by a killed run
 * (marker present) is removed before anything reads the queues.
 */
const STAND_IN_MARKER = "p5d_machine_queues_stand_in";

async function standInState(): Promise<"none" | "ours" | "real"> {
  const { rows } = await getMigratorPool().query<{ schema: string | null; marker: string | null }>(
    `select to_regnamespace('pgboss')::text as schema, to_regclass($1)::text as marker`,
    [`pgboss.${STAND_IN_MARKER}`],
  );
  if (rows[0]!.schema === null) return "none";
  return rows[0]!.marker === null ? "real" : "ours";
}

/** Drop the stand-in, and only ever a schema carrying its marker. */
async function dropStandIn(): Promise<void> {
  if ((await standInState()) === "ours") await getMigratorPool().query(`drop schema pgboss cascade`);
}

describe("the attention rule (pure)", () => {
  test("a queue needs a person only with something in it: at once when its patience is none, else once its oldest waited it", () => {
    const kinds = [...Object.keys(QUEUE_WORDS), "pgboss:send-email", "pgboss_failed:send-email"];
    for (const kind of kinds) {
      // Transcript copies have their own Home source on the integration
      // branch, so the attention rule is bypassed for them there.
      if (kind === "transcript_emails") continue;
      const { patienceMinutes } = wordsFor(kind);
      expect(needsAttention(kind, 0, 10_000), kind).toBe(false);
      if (patienceMinutes === 0) {
        expect(needsAttention(kind, 1, 0), kind).toBe(true);
        expect(needsAttention(kind, 1, null), kind).toBe(true);
      } else {
        expect(needsAttention(kind, 1, patienceMinutes - 1), kind).toBe(false);
        expect(needsAttention(kind, 1, patienceMinutes), kind).toBe(true);
        expect(needsAttention(kind, 1, null), kind).toBe(false);
      }
    }
  });

  test("every queue Home words opens the machine queues section, the job switches or the agreements page, and none says there is no page", () => {
    for (const [kind, words] of Object.entries(QUEUE_WORDS)) {
      expect([MACHINE_QUEUES_PAGE, "/admin/compliance/agreements"], kind).toContain(words.href);
      expect(words.words, kind).not.toMatch(/no page|morning email/);
    }
    expect(MACHINE_QUEUES_PAGE).toBe("/admin/system#attention");
    expect(wordsFor("pgboss:send-email").href).toBe("/admin/system/jobs");
  });
});

describeDb("listMachineQueues and Home's queue rows (lane P5d)", () => {
  beforeAll(async () => {
    await runMigrations();
    await dropStandIn(); // a leftover from a killed run
  }, 180_000);

  beforeEach(async () => {
    failing.clinicId = null;
    failing.floor = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  });

  afterAll(async () => {
    failing.clinicId = null;
    failing.floor = false;
    await closePools();
  });

  const ago = (ms: number) => new Date(Date.now() - ms);

  /** What every queue holds, written as its owner writes it. */
  async function seedQueues() {
    const a = await seedClinic("mq-a");
    const b = await seedClinic("mq-b");
    for (const c of [a, b]) {
      await inTenant(c.clinicId, async (q) => {
        // A receipt due when it was queued two hours ago, still unsent (enqueueing sets both to the same instant).
        await q.query(`insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after) values ($1, 'receipt', $2, '{}', $3, $3)`, [
          c.clinicId,
          `mq-pending-${randomUUID()}`,
          ago(2 * HOUR),
        ]);
        // A delivered receipt Resend later said bounced, an hour ago; and one it said was delivered.
        await q.query(
          `insert into report_deliveries (clinic_id, kind, period_key, recipient, status, attempted_at, delivery_status, delivery_at)
           values ($1, 'receipt', $2, 'owner@example-clinic.test', 'sent', $3, 'bounced', $3),
                  ($1, 'receipt', $4, 'owner@example-clinic.test', 'sent', $3, 'delivered', $3)`,
          [c.clinicId, `mq-b-${randomUUID()}`, ago(c === a ? HOUR : 3 * HOUR), `mq-d-${randomUUID()}`],
        );
      });
    }
    await inTenant(a.clinicId, async (q) => {
      // A payment-failed notice that used every attempt, a day ago: A's alone.
      await q.query(`insert into billing_notices (clinic_id, kind, dedupe_key, payload, attempts, created_at) values ($1, 'payment_failed', 'mq-dead', '{}', 6, $2)`, [
        a.clinicId,
        ago(DAY),
      ]);
      // A plan start asked of Stripe, not done, from now.
      await q.query(`insert into billing_requests (clinic_id, kind, reason) values ($1, 'plan_start', 'first_answer')`, [a.clinicId]);
    });
    // A transcript copy waiting for SES, queued now, as the outbox queues it (its time is the database's).
    const { conversationId } = await seedConversation(b.clinicId, { startedAt: new Date() });
    await inTenant(b.clinicId, (q) =>
      q.query(
        `insert into transcript_emails (clinic_id, conversation_id, sealed, status, destroy_after)
         values ($1, $2, '{"v":1}'::jsonb, 'pending', now() + interval '30 days')`,
        [b.clinicId, conversationId],
      ),
    );
    const pool = getMigratorPool();
    // Stripe: one retrying for ten minutes, one parked since yesterday; Connect: one retrying for two hours.
    await pool.query(
      `insert into billing_events (stripe_event_id, type, outcome, failures, error, payload, received_at)
       values ('evt_mq_young', 'customer.created', 'failed', 1, 'Error: boom', '{}'::jsonb, $1),
              ('evt_mq_parked', 'invoice.paid', 'dead_letter', 5, 'Error: boom', '{}'::jsonb, $2)`,
      [ago(10 * MINUTE), ago(DAY)],
    );
    await pool.query(
      `insert into stripe_connect_events (stripe_event_id, type, account, outcome, failures, error, received_at)
       values ('evt_mq_connect', 'account.updated', 'acct_1Mq', 'failed', 2, 'internal_error', $1)`,
      [ago(2 * HOUR)],
    );
    // A paid order no account was made for, three hours ago.
    await pool.query(
      `insert into checkout_intents (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at, paid_seen_at)
       values ($1, '{"clinicName": "Paid Practice"}'::jsonb, $2, 'owner@example-clinic.test', 'voice-webchat-500-300', 'month', now() + interval '14 days', $3)`,
      [randomUUID(), randomUUID(), ago(3 * HOUR)],
    );
    // An ops alert the email could not carry, an hour ago.
    await pool.query(
      `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at, last_error) values ('calendar_broken', $1, '{}'::jsonb, $2, $2, 'send failed')`,
      [`calendar_broken|${randomUUID()}`, ago(HOUR)],
    );
    return { a, b };
  }

  async function machineQueues(): Promise<MachineQueues> {
    const result = await runOperation("listMachineQueues", {}, OPERATOR);
    expect(result.status).toBe(200);
    return (result.body as { data: MachineQueues }).data;
  }

  /** pg-boss's schema is installed by `queue:install`, which the test database does not run. */
  async function pgBossInstalled(): Promise<boolean> {
    const { rows } = await getMigratorPool().query<{ t: string | null }>(`select to_regclass('pgboss.job')::text as t`);
    return rows[0]!.t !== null;
  }

  test("each queue's count, the age of its oldest, its attention and its link", async () => {
    const { a } = await seedQueues();
    const { queues, partial } = await machineQueues();
    expect(partial).toEqual((await pgBossInstalled()) ? [] : ["pg-boss"]);
    const by = Object.fromEntries(queues.map((q) => [q.key, q])) as Record<string, MachineQueue>;
    const near = (minutes: number | null, expected: number) => {
      expect(minutes).not.toBeNull();
      expect(Math.abs(minutes! - expected)).toBeLessThanOrEqual(2);
    };

    expect(by.outbox).toMatchObject({ count: 2, needsAttention: true, tone: "warn", href: MACHINE_QUEUES_PAGE });
    near(by.outbox!.oldestAgeMinutes, 120);
    // One clinic's dead letter opens that clinic's Deliveries tab.
    expect(by.outbox_dead).toMatchObject({ count: 1, needsAttention: true, href: `/admin/clinics/${a.clinicId}/deliveries` });
    near(by.outbox_dead!.oldestAgeMinutes, 24 * 60);
    // Two clinics' bounces open the section; the delivered ones are not counted.
    expect(by.emails_undeliverable).toMatchObject({ count: 2, needsAttention: true, href: MACHINE_QUEUES_PAGE });
    near(by.emails_undeliverable!.oldestAgeMinutes, 180);
    // Within their patience: shown, counted, not needing anyone.
    expect(by.transcript_emails).toMatchObject({ count: 1, needsAttention: false });
    near(by.transcript_emails!.oldestAgeMinutes, 0);
    expect(by.billing_requests).toMatchObject({ count: 1, needsAttention: false });
    expect(by.billing_events_retrying).toMatchObject({ count: 1, needsAttention: false });
    expect(by.billing_events_parked).toMatchObject({ count: 1, needsAttention: true });
    expect(by.connect_events_retrying).toMatchObject({ count: 1, needsAttention: true });
    expect(by.orders_without_account).toMatchObject({ count: 1, needsAttention: true, tone: "bad" });
    near(by.orders_without_account!.oldestAgeMinutes, 180);
    expect(by.ops_alerts_unsent).toMatchObject({ count: 1, needsAttention: true });
    // Read in full and empty: a real zero.
    expect(by.connect_events_parked).toEqual({
      key: "connect_events_parked",
      words: "Stripe Connect events parked",
      count: 0,
      oldestAgeMinutes: null,
      needsAttention: false,
      tone: "ok",
      href: MACHINE_QUEUES_PAGE,
      lowerBound: false,
    });
    // Everything was read: no count is a lower bound.
    expect(queues.every((q) => q.lowerBound === false)).toBe(true);
    expect(by.agreements_below_floor).toMatchObject({ count: 0, needsAttention: false });
    // Attention first.
    const flags = queues.map((q) => q.needsAttention);
    expect(flags).toEqual([...flags].sort((x, y) => Number(y) - Number(x)));
    // Words, counts, ages and links only: no address, no clinic name.
    const text = JSON.stringify(queues);
    expect(text).not.toMatch(/example-clinic\.test|Paid Practice|mq-a Clinic|mq-b Clinic/);
  });

  test("Home's rows and the section agree, queue by queue: the same attention, the same link, no 'no page' sentence", async () => {
    await seedQueues();
    const now = new Date();
    const { queues } = await machineQueues();
    const inbox = await readOpsInbox(OPERATOR, { now, sources: [queuesSource] });
    const rows = new Map(inbox.rows.map((r) => [r.id, r]));
    expect(queues.length).toBeGreaterThan(0);
    for (const q of queues) {
      const row = rows.get(`queue:${q.key}`);
      expect(Boolean(row), q.key).toBe(q.needsAttention);
      if (row) {
        expect(row.count, q.key).toBe(q.count);
        expect(row.button, q.key).toEqual({ label: "Open", kind: "link", href: q.href });
        expect(row.sentence, q.key).toMatch(new RegExp(`^${q.words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        expect(row.sentence, q.key).not.toMatch(/no page/);
      }
    }
    // And no Home row the section does not list.
    for (const id of rows.keys()) expect(queues.some((q) => `queue:${q.key}` === id), id).toBe(true);
    expect(rows.get("queue:emails_undeliverable")!.sentence).toMatch(
      /^Emails to clinics that bounced, were marked as spam or were blocked, in the last 24 hours; the oldest is 3 h old\.$/,
    );
    // True of a notice that used every attempt and of one refused for good (attempts set to the maximum).
    expect(rows.get("queue:outbox_dead")!.sentence).toBe(
      "Emails to clinics that could not be sent and will not be tried again, in the last 7 days; the oldest is 24 h old.",
    );
  });

  test("a part that cannot be read is named and absent, never a zero", async () => {
    const { a } = await seedQueues();
    failing.floor = true;
    failing.clinicId = a.clinicId;
    const { queues, partial } = await machineQueues();
    expect(partial).toEqual(expect.arrayContaining(["agreements below the floor", "1 clinic(s)"]));
    const keys = queues.map((q) => q.key);
    expect(keys).not.toContain("agreements_below_floor");
    // B's queues are still counted, as a lower bound and marked so; a per-clinic queue B has nothing in is not listed as zero.
    expect(queues.find((q) => q.key === "outbox")).toMatchObject({ count: 1, lowerBound: true, needsAttention: true });
    expect(queues.find((q) => q.key === "emails_undeliverable")).toMatchObject({ lowerBound: true });
    expect(queues.find((q) => q.key === "billing_events_parked")).toMatchObject({ lowerBound: false });
    expect(keys).not.toContain("outbox_dead");
    expect(keys).not.toContain("billing_requests");
    // What was read in full still is.
    expect(queues.find((q) => q.key === "connect_events_parked")).toMatchObject({ count: 0 });
    // Home says the same parts.
    const inbox = await readOpsInbox(OPERATOR, { sources: [queuesSource] });
    expect(inbox.unreadable[0]!.reason).toMatch(/agreements below the floor/);
    expect(inbox.unreadable[0]!.reason).toMatch(/1 clinic\(s\)/);
    // Home says the count is a floor, on each per-clinic row and no other.
    const outboxRow = inbox.rows.find((r) => r.id === "queue:outbox")!;
    expect(outboxRow.sentence).toMatch(/^Emails waiting to send \(at least 1: a clinic could not be read\); the oldest is 2 h old\.$/);
    expect(inbox.rows.find((r) => r.id === "queue:billing_events_parked")!.sentence).not.toMatch(/at least/);
  });

  test("the operation writes nothing: no row anywhere it reads, no access row, no security event; and it takes no argument", async () => {
    const { a, b } = await seedQueues();
    const snapshot = async () => {
      const pool = getMigratorPool();
      const global = await pool.query(
        `select (select count(*) from security_events) as security,
                (select count(*) from ops_alerts) as alerts,
                (select count(*) from billing_events) as stripe,
                (select count(*) from stripe_connect_events) as connect,
                (select count(*) from checkout_intents) as intents`,
      );
      const tenant = [];
      for (const c of [a, b]) {
        tenant.push(
          await inTenant(c.clinicId, async (q) =>
            (
              await q.query(
                `select (select count(*) from audit_log) as access,
                        (select count(*) from billing_notices) as notices,
                        (select count(*) from report_deliveries) as deliveries,
                        (select count(*) from transcript_emails) as transcripts,
                        (select count(*) from billing_requests) as requests`,
              )
            ).rows[0],
          ),
        );
      }
      return { global: global.rows[0], tenant };
    };
    const before = await snapshot();
    await machineQueues();
    await readOpsInbox(OPERATOR, { sources: [queuesSource] });
    expect(await snapshot()).toEqual(before);
    expect((await runOperation("listMachineQueues", { clinicId: a.clinicId }, OPERATOR)).status).toBe(400);
  });

  test("the outbox counts only what is due, aged from when it fell due: a notice meant to wait is not late", async () => {
    const c = await seedClinic("mq-due");
    await inTenant(c.clinicId, async (q) => {
      // Queued two hours ago for tomorrow (a reminder held to its day): not due, not counted.
      await q.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after) values ($1, 'receipt', 'mq-later', '{}', $2, $3)`,
        [c.clinicId, ago(2 * HOUR), new Date(Date.now() + DAY)],
      );
      // Queued three hours ago, due half an hour ago: waiting 30 minutes, inside its hour.
      await q.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after) values ($1, 'receipt', 'mq-due', '{}', $2, $3)`,
        [c.clinicId, ago(3 * HOUR), ago(30 * MINUTE)],
      );
    });
    const { queues } = await machineQueues();
    const outbox = queues.find((q) => q.key === "outbox")!;
    expect(outbox).toMatchObject({ count: 1, needsAttention: false });
    expect(Math.abs(outbox.oldestAgeMinutes! - 30)).toBeLessThanOrEqual(2);
    const inbox = await readOpsInbox(OPERATOR, { sources: [queuesSource] });
    expect(inbox.rows.some((r) => r.id === "queue:outbox")).toBe(false);
  });

  describe("pg-boss's jobs, against a stand-in of its job table", () => {
    // queue:install is not run on the test database, so the read's fixed
    // `pgboss.job` is stood in for with the columns it uses, as pg-boss 10
    // defines them. The stand-in is this test's own, known by its marker
    // table: a real pg-boss schema (no marker) is never touched and the test
    // is skipped; one left by a killed run (marker present) is removed first.
    let ours = false;

    beforeEach(async () => {
      await dropStandIn();
      ours = false;
      if ((await standInState()) === "real") return;
      const pool = getMigratorPool();
      await pool.query(`create schema pgboss`);
      ours = true;
      await pool.query(`create table pgboss.${STAND_IN_MARKER} ()`);
      await pool.query(
        `create table pgboss.job (
           id uuid not null default gen_random_uuid(), name text not null, state text not null default 'created',
           start_after timestamptz not null default now(), created_on timestamptz not null default now(),
           completed_on timestamptz)`,
      );
      await pool.query(`grant usage on schema pgboss to healdesk_app`);
      await pool.query(`grant select on pgboss.job to healdesk_app`);
    });
    afterEach(async () => {
      if (ours) await dropStandIn();
      ours = false;
    });
    afterAll(async () => {
      await dropStandIn();
    });

    test("a job waits from when it fell due, and a failure counts for two days only", async (context) => {
      if (!ours) {
        context.skip("pg-boss is installed on this database: its real job table is not seeded or dropped by this test.");
      }
      const pool = getMigratorPool();
      await pool.query(
        `insert into pgboss.job (name, state, created_on, start_after, completed_on) values
           ('send-email', 'created', $1, $2, null),
           ('nightly-sync', 'failed', $3, $3, $4),
           ('hourly-tick', 'failed', $5, $5, $6)`,
        // Queued three hours ago to start ten minutes ago; a cron run that
        // failed three days ago; one that failed an hour ago.
        [ago(3 * HOUR), ago(10 * MINUTE), ago(3 * DAY + HOUR), ago(3 * DAY), ago(2 * HOUR), ago(HOUR)],
      );
      const { queues, partial } = await machineQueues();
      expect(partial).toEqual([]);
      const waiting = queues.find((q) => q.key === "pgboss:send-email")!;
      expect(waiting).toMatchObject({ count: 1, needsAttention: false, href: "/admin/system/jobs" });
      expect(Math.abs(waiting.oldestAgeMinutes! - 10)).toBeLessThanOrEqual(2);
      expect(queues.some((q) => q.key === "pgboss_failed:nightly-sync")).toBe(false);
      const failed = queues.find((q) => q.key === "pgboss_failed:hourly-tick")!;
      expect(failed).toMatchObject({ count: 1, needsAttention: true });
      expect(Math.abs(failed.oldestAgeMinutes! - 60)).toBeLessThanOrEqual(2);
      const ids = (await readOpsInbox(OPERATOR, { sources: [queuesSource] })).rows.map((r) => r.id);
      expect(ids).toEqual(["queue:pgboss_failed:hourly-tick"]);
    });
  });
});
