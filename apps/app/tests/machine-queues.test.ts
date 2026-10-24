import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

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

describe("the attention rule (pure)", () => {
  test("a queue needs a person only with something in it: at once when its patience is none, else once its oldest waited it", () => {
    const kinds = [...Object.keys(QUEUE_WORDS), "pgboss:send-email", "pgboss_failed:send-email"];
    for (const kind of kinds) {
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
        // A receipt waiting two hours in the outbox.
        await q.query(`insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at) values ($1, 'receipt', $2, '{}', $3)`, [
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
    });
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
    expect(rows.get("queue:outbox_dead")!.sentence).toBe("Emails to clinics that gave up after every attempt, in the last 7 days; the oldest is 24 h old.");
  });

  test("a part that cannot be read is named and absent, never a zero", async () => {
    const { a } = await seedQueues();
    failing.floor = true;
    failing.clinicId = a.clinicId;
    const { queues, partial } = await machineQueues();
    expect(partial).toEqual(expect.arrayContaining(["agreements below the floor", "1 clinic(s)"]));
    const keys = queues.map((q) => q.key);
    expect(keys).not.toContain("agreements_below_floor");
    // B's queues are still counted, as a lower bound; a per-clinic queue B has nothing in is not listed as zero.
    expect(queues.find((q) => q.key === "outbox")).toMatchObject({ count: 1 });
    expect(keys).not.toContain("outbox_dead");
    expect(keys).not.toContain("billing_requests");
    // What was read in full still is.
    expect(queues.find((q) => q.key === "connect_events_parked")).toMatchObject({ count: 0 });
    // Home says the same parts.
    const inbox = await readOpsInbox(OPERATOR, { sources: [queuesSource] });
    expect(inbox.unreadable[0]!.reason).toMatch(/agreements below the floor/);
    expect(inbox.unreadable[0]!.reason).toMatch(/1 clinic\(s\)/);
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
});
