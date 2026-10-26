import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  markIntentPaidSeen,
  PROVISION_DEAD_LETTER_AT,
  recordProvisionFailure,
} from "@/lib/checkout/dead-letter";
import { pruneEmailEvents } from "@/lib/email/health";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail } from "@/lib/email/send";
import { DIGEST_EMAIL_BLIND_SPOTS, renderOpsDigest } from "@/lib/email/templates/ops_digest";
import { flagClinics, runHealthFlagsJob } from "@/lib/ops/health-flags";
import { collectDigest, sendOpsDigest } from "@/lib/ops/digest";
import { parseEnvelope, runOperation } from "@/lib/ops/api";
import { listSupportRequests } from "@/lib/ops/support-replies";
import { runOpsWatchJob, watchPurchases, watchSupportReplies } from "@/lib/ops/watch";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import {
  findUnhealthyConnections,
  runConnectionHealthJob,
} from "@/lib/scheduler/connection-health";
import {
  JOB_CONNECTION_HEALTH,
  JOB_HEALTH_FLAGS,
  JOB_OPS_DIGEST,
  JOB_OPS_WATCH,
  setJobEnabled,
} from "@/lib/scheduler/jobs";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedConversation } from "./setup/factories";

/**
 * WP5: the internal health flags, the ops watch's dated promises, the
 * provisioning dead letter, the 07:00 digest, and the ops operations that
 * feed them. Every alert is observed as its row in the ops log
 * (ops_alerts); HEALDESK_OPS_EMAIL is unset, so none is mailed.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OPERATOR = { email: "ops@healdesk.test", request: {} };

async function alerts(event: string) {
  const { rows } = await getMigratorPool().query<{
    fields: Record<string, unknown>;
    repeats: number;
  }>(`select fields, repeats from ops_alerts where event = $1 order by raised_at`, [event]);
  return rows;
}

async function op(name: string, args: Record<string, unknown>) {
  const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
  if (!parsed.ok) throw new Error(`${name} is not an operation`);
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

/** A purchase as /api/provision imports it, written as the migrator. */
async function seedIntent(
  fields: {
    paidSeenAt?: Date | null;
    consumed?: boolean;
    failedAt?: Date | null;
    failures?: number;
  } = {},
): Promise<string> {
  const ref = randomUUID();
  await getMigratorPool().query(
    `insert into checkout_intents
       (ref, payload, agreement_id, contact_email, plan, billing_interval, expires_at,
        paid_seen_at, consumed_at, provision_failed_at, provision_failures)
     values ($1, $2, $3, 'owner@example-clinic.test', 'voice-webchat-500-300', 'month',
             now() + interval '14 days', $4, $5, $6, $7)`,
    [
      ref,
      JSON.stringify({
        plan: "voice-webchat-500-300",
        billingInterval: "month",
        clinicName: "Radiance Med Spa",
        contactEmail: "owner@example-clinic.test",
        specialty: "med_spa",
      }),
      randomUUID(),
      fields.paidSeenAt ?? null,
      fields.consumed ? new Date() : null,
      fields.failedAt ?? null,
      fields.failures ?? 0,
    ],
  );
  return ref;
}

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  constructor(private readonly outcome: "sent" | "failed" = "sent") {}
  async send(target: DeliveryTarget, message: OutgoingEmail) {
    this.sent.push({ target, message });
    return this.outcome === "sent"
      ? { status: "sent" as const, messageId: `fake-${this.sent.length}` }
      : { status: "failed" as const, reason: "fake transport refused" };
  }
}

describeDb("WP5: health flags, the ops watch and the digest", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
  });

  afterAll(async () => {
    await closePools();
  });

  test("the migration seeds health-flags off and the two that only alert ops on", async () => {
    // truncateAll re-seeds every job off for the tests; read the migration's
    // own seed from a fresh insert of the same statement instead.
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../drizzle/", import.meta.url);
    const file = readdirSync(dir).find((name) => name.endsWith("_health_and_digest.sql"));
    const sql = readFileSync(new URL(file!, dir), "utf8");
    expect(sql).toMatch(/\('health-flags', '[^']*(?:''[^']*)*', false\)/);
    expect(sql).toMatch(/\('ops-digest', '[^']*(?:''[^']*)*', true\)/);
    expect(sql).toMatch(/\('ops-watch', '[^']*(?:''[^']*)*', true\)/);
  });

  describe("health flags", () => {
    test("a clinic live for 48 hours with no interaction anywhere is flagged once; one with a call is not", async () => {
      const quiet = await seedClinic("flags-quiet");
      const busy = await seedClinic("flags-busy");
      const young = await seedClinic("flags-young");
      const now = new Date();
      await seedChannels(quiet.clinicId, [
        {
          channel: "web",
          readyAt: new Date(now.getTime() - 3 * DAY),
          liveAt: new Date(now.getTime() - 49 * HOUR),
        },
      ]);
      await seedChannels(busy.clinicId, [
        {
          channel: "voice",
          readyAt: new Date(now.getTime() - 3 * DAY),
          liveAt: new Date(now.getTime() - 49 * HOUR),
        },
      ]);
      await seedChannels(young.clinicId, [
        {
          channel: "web",
          readyAt: new Date(now.getTime() - 3 * DAY),
          liveAt: new Date(now.getTime() - 47 * HOUR),
        },
      ]);
      await seedConversation(busy.clinicId, { startedAt: new Date(now.getTime() - 2 * HOUR) });

      const summary = await flagClinics(now);
      expect(summary.failures).toBe(0);
      const raised = (await alerts("no_interactions_48_hours")).map((a) => a.fields.clinicId);
      expect(raised).toEqual([quiet.clinicId]);

      // Once per clinic: an hour on, the quiet one is not raised again, and
      // the young one has now crossed its own 48 hours.
      await flagClinics(new Date(now.getTime() + HOUR));
      const again = (await alerts("no_interactions_48_hours")).map((a) => a.fields.clinicId);
      expect(again.filter((id) => id === quiet.clinicId)).toHaveLength(1);
      expect(again).toContain(young.clinicId);
      expect(again).not.toContain(busy.clinicId);
    });

    test("a Meta message counts as an interaction, and a paused clinic is not flagged", async () => {
      const meta = await seedClinic("flags-meta");
      const paused = await seedClinic("flags-paused");
      const now = new Date();
      for (const c of [meta, paused]) {
        await seedChannels(c.clinicId, [
          {
            channel: "meta",
            readyAt: new Date(now.getTime() - 4 * DAY),
            liveAt: new Date(now.getTime() - 3 * DAY),
          },
        ]);
      }
      await inTenant(meta.clinicId, (client) =>
        client.query(
          `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
           values ($1, 'instagram', 'ref-1', $2, $3, $3)`,
          [meta.clinicId, randomUUID(), new Date(now.getTime() - DAY)],
        ),
      );
      await inTenant(paused.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, ai_paused_at) values ($1, $2)
           on conflict (clinic_id) do update set ai_paused_at = excluded.ai_paused_at, ai_paused_until = null`,
          [paused.clinicId, new Date(now.getTime() - 2 * DAY)],
        ),
      );
      await flagClinics(now);
      const raised = (await alerts("no_interactions_48_hours")).map((a) => a.fields.clinicId);
      expect(raised).not.toContain(meta.clinicId);
      expect(raised).not.toContain(paused.clinicId);
    });

    test("a live phone line with no call for 14 days is flagged once per quiet stretch, naming no time", async () => {
      const silent = await seedClinic("flags-silent");
      const now = new Date();
      await seedChannels(silent.clinicId, [
        {
          channel: "voice",
          readyAt: new Date(now.getTime() - 40 * DAY),
          liveAt: new Date(now.getTime() - 30 * DAY),
        },
      ]);
      const { conversationId: first } = await seedConversation(silent.clinicId, {
        startedAt: new Date(now.getTime() - 20 * DAY),
      });

      await flagClinics(now);
      let raised = (await alerts("no_inbound_calls_14_days")).filter(
        (a) => a.fields.clinicId === silent.clinicId,
      );
      expect(raised).toHaveLength(1);
      expect(raised[0]!.fields).toEqual({
        clinicId: silent.clinicId,
        channel: "voice",
        conversationId: first,
      });

      await flagClinics(new Date(now.getTime() + DAY));
      raised = (await alerts("no_inbound_calls_14_days")).filter(
        (a) => a.fields.clinicId === silent.clinicId,
      );
      expect(raised).toHaveLength(1);

      // A call ends the stretch; fourteen quiet days after it is a new one.
      const { conversationId: second } = await seedConversation(silent.clinicId, {
        startedAt: new Date(now.getTime() - HOUR),
      });
      await flagClinics(new Date(now.getTime() + 2 * DAY));
      expect(
        (await alerts("no_inbound_calls_14_days")).filter(
          (a) => a.fields.clinicId === silent.clinicId,
        ),
      ).toHaveLength(1);
      await flagClinics(new Date(now.getTime() + 15 * DAY));
      raised = (await alerts("no_inbound_calls_14_days")).filter(
        (a) => a.fields.clinicId === silent.clinicId,
      );
      expect(raised.map((a) => a.fields.conversationId)).toEqual([first, second]);
    });

    test("a phone line switched off is not flagged", async () => {
      const off = await seedClinic("flags-off");
      const now = new Date();
      await seedChannels(off.clinicId, [
        {
          channel: "voice",
          enabled: false,
          readyAt: new Date(now.getTime() - 40 * DAY),
          liveAt: new Date(now.getTime() - 30 * DAY),
        },
      ]);
      await flagClinics(now);
      expect(
        (await alerts("no_inbound_calls_14_days")).map((a) => a.fields.clinicId),
      ).not.toContain(off.clinicId);
    });

    test("the job is behind its switch", async () => {
      await setJobEnabled(JOB_HEALTH_FLAGS, false, (await seedClinic("flags-switch")).staffUserId);
      expect((await runHealthFlagsJob()).status).toBe("disabled");
    });
  });

  describe("the ops watch: paid orders and B3's follow-up", () => {
    test("a paid order with no account ten minutes on is raised once; a made, refused or fresh one is not", async () => {
      const now = new Date();
      const waiting = await seedIntent({
        paidSeenAt: new Date(now.getTime() - 11 * 60_000),
        failures: 1,
      });
      const fresh = await seedIntent({ paidSeenAt: new Date(now.getTime() - 9 * 60_000) });
      const made = await seedIntent({ paidSeenAt: new Date(now.getTime() - HOUR), consumed: true });
      const refused = await seedIntent({
        paidSeenAt: new Date(now.getTime() - HOUR),
        failedAt: new Date(now.getTime() - HOUR),
      });
      const unpaid = await seedIntent();

      const result = await watchPurchases(now);
      const raised = await alerts("paid_intent_without_clinic");
      const refs = raised.map((a) => a.fields.requestId);
      expect(refs).toContain(waiting);
      for (const ref of [fresh, made, refused, unpaid]) expect(refs).not.toContain(ref);
      expect(raised.find((a) => a.fields.requestId === waiting)!.fields.attempts).toBe(1);
      expect(result.paidWithoutClinic).toBeGreaterThanOrEqual(1);

      await watchPurchases(new Date(now.getTime() + 5 * 60_000));
      expect(
        (await alerts("paid_intent_without_clinic")).filter((a) => a.fields.requestId === waiting),
      ).toHaveLength(1);
    });

    test("B3's day passing with no account raises provisioning_follow_up_past_due, once, and not on the day", async () => {
      // Tuesday 6 October 2026, 15:00 in New York: B3 promises Wednesday 7 October.
      const failedAt = new Date("2026-10-06T19:00:00Z");
      const ref = await seedIntent({ paidSeenAt: failedAt, failedAt });
      const onTheDay = new Date("2026-10-07T23:00:00Z"); // 19:00 on the 7th in New York
      const after = new Date("2026-10-08T05:00:00Z"); // 01:00 on the 8th

      await watchPurchases(onTheDay);
      expect(
        (await alerts("provisioning_follow_up_past_due")).map((a) => a.fields.requestId),
      ).not.toContain(ref);
      await watchPurchases(after);
      await watchPurchases(new Date(after.getTime() + HOUR));
      expect(
        (await alerts("provisioning_follow_up_past_due")).filter((a) => a.fields.requestId === ref),
      ).toHaveLength(1);
    });

    test("the job runs behind its switch, without a lock", async () => {
      const clinic = await seedClinic("watch-switch");
      await setJobEnabled(JOB_OPS_WATCH, false, clinic.staffUserId);
      expect((await runOpsWatchJob()).status).toBe("disabled");
      await setJobEnabled(JOB_OPS_WATCH, true, clinic.staffUserId);
      const outcome = await runOpsWatchJob({ supportReplies: true });
      expect(outcome.status).toBe("ok");
      await setJobEnabled(JOB_OPS_WATCH, false, clinic.staffUserId);
    });
  });

  describe("the provisioning dead letter", () => {
    test("the paid relay is stamped once, from the database's clock", async () => {
      const ref = await seedIntent();
      await markIntentPaidSeen(ref);
      const {
        rows: [first],
      } = await getMigratorPool().query<{ paid_seen_at: Date }>(
        `select paid_seen_at from checkout_intents where ref = $1`,
        [ref],
      );
      expect(first!.paid_seen_at).toBeInstanceOf(Date);
      await markIntentPaidSeen(ref);
      const {
        rows: [again],
      } = await getMigratorPool().query<{ paid_seen_at: Date }>(
        `select paid_seen_at from checkout_intents where ref = $1`,
        [ref],
      );
      expect(again!.paid_seen_at.getTime()).toBe(first!.paid_seen_at.getTime());
    });

    test("the third retryable failure dead-letters the purchase, once; a made one is not counted", async () => {
      const ref = await seedIntent({ paidSeenAt: new Date() });
      const outcomes = [];
      for (let i = 0; i < PROVISION_DEAD_LETTER_AT + 1; i += 1)
        outcomes.push(await recordProvisionFailure(ref));
      expect(outcomes.map((o) => o.status)).toEqual([
        "counted",
        "counted",
        "dead_lettered",
        "counted",
      ]);
      const {
        rows: [row],
      } = await getMigratorPool().query<{
        provision_failed_at: Date | null;
        provision_failures: number;
      }>(`select provision_failed_at, provision_failures from checkout_intents where ref = $1`, [
        ref,
      ]);
      expect(row!.provision_failed_at).not.toBeNull();
      expect(row!.provision_failures).toBe(PROVISION_DEAD_LETTER_AT + 1);

      const made = await seedIntent({ paidSeenAt: new Date(), consumed: true });
      expect((await recordProvisionFailure(made)).status).toBe("not_counted");
      expect((await recordProvisionFailure(randomUUID())).status).toBe("not_counted");
    });
  });

  describe("support replies", () => {
    async function seedSupportRequest(clinicId: string, replyByOn: string): Promise<string> {
      const requestId = randomUUID();
      await inTenant(clinicId, (client) =>
        client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload)
           values ($1, 'support_request', $2, $3)`,
          [
            clinicId,
            `support_request:${requestId}`,
            JSON.stringify({ requestId, topic: "billing", replyByOn, helpPhoneE164: null }),
          ],
        ),
      );
      return requestId;
    }

    test("past its day with no mark raises once; marked, or still on its day, does not", async () => {
      const clinic = await seedClinic("support-replies");
      // created_at is the database's clock, so the look-back is read from today;
      // the reply days are set far in the past and far in the future.
      const today = new Date();
      const owed = await seedSupportRequest(clinic.clinicId, "2000-01-03");
      const replied = await seedSupportRequest(clinic.clinicId, "2000-01-03");
      const notYet = await seedSupportRequest(clinic.clinicId, "2999-01-01");

      expect(
        (await op("markSupportReplied", { clinicId: clinic.clinicId, requestId: replied })).body,
      ).toEqual({
        data: { status: "marked" },
      });
      expect(
        (
          (await op("markSupportReplied", { clinicId: clinic.clinicId, requestId: replied }))
            .body as { data: { status: string } }
        ).data.status,
      ).toBe("already");
      expect(
        (await op("markSupportReplied", { clinicId: clinic.clinicId, requestId: randomUUID() }))
          .body,
      ).toEqual({
        data: { status: "not_found" },
      });
      expect(
        (await op("markSupportReplied", { clinicId: clinic.clinicId, requestId: "not-an-id" }))
          .status,
      ).toBe(400);

      const watch = await watchSupportReplies(today);
      expect(watch.failures).toBe(0);
      const raised = (await alerts("support_reply_past_due")).map((a) => a.fields.requestId);
      expect(raised).toContain(owed);
      expect(raised).not.toContain(replied);
      expect(raised).not.toContain(notYet);
      await watchSupportReplies(today);
      expect(
        (await alerts("support_reply_past_due")).filter((a) => a.fields.requestId === owed),
      ).toHaveLength(1);

      const listed = await listSupportRequests(today);
      const byId = Object.fromEntries(listed.rows.map((r) => [r.requestId, r]));
      expect(byId[replied]!.repliedAt).toBeInstanceOf(Date);
      expect(byId[owed]!.pastDue).toBe(true);
      expect(byId[notYet]!.pastDue).toBe(false);

      const view = await op("listSupportRequests", {});
      expect(view.status).toBe(200);
      const requests = (
        view.body as { data: { requests: { requestId: string; clinicSlug: string | null }[] } }
      ).data.requests;
      expect(requests.map((r) => r.requestId)).toEqual(
        expect.arrayContaining([owed, replied, notYet]),
      );
    });
  });

  describe("setupRepliesPastDue, from apps/web's cron", () => {
    test("raises one alert per setup request, once, and refuses anything but ids", async () => {
      const a = randomUUID();
      const b = randomUUID();
      const outcome = await op("setupRepliesPastDue", { requestIds: [a, b, a] });
      expect(outcome.body).toEqual({ data: { raised: 2 } });
      await op("setupRepliesPastDue", { requestIds: [a] });
      const raised = await alerts("setup_request_reply_past_due");
      expect(raised.map((r) => r.fields.requestId).sort()).toEqual([a, b].sort());
      for (const args of [
        {},
        { requestIds: "x" },
        { requestIds: ["owner@example.test"] },
        { requestIds: Array.from({ length: 51 }, () => randomUUID()) },
      ]) {
        expect(
          (await op("setupRepliesPastDue", args)).status,
          JSON.stringify(args).slice(0, 40),
        ).toBe(400);
      }
    });
  });

  describe("connection health", () => {
    test("a revoked connection is raised at once, a Meta token is never stale, and nothing is mailed by the job", async () => {
      const revoked = await seedClinic("health-revoked-wp5");
      const meta = await seedClinic("health-meta-wp5");
      const connect = (clinicId: string, provider: string, status: string) =>
        inTenant(clinicId, async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into provider_connections
               (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
             values ($1, $2, $3, 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
            [clinicId, provider, status],
          );
          return rows[0]!.id;
        });
      const dead = await connect(revoked.clinicId, "fixture", "revoked");
      await connect(meta.clinicId, "meta-instagram", "active");

      const findings = await findUnhealthyConnections(new Date());
      expect(findings.filter((f) => f.clinicId === meta.clinicId)).toEqual([]);

      await setJobEnabled(JOB_CONNECTION_HEALTH, true, revoked.staffUserId);
      expect((await runConnectionHealthJob()).status).toBe("ok");
      await runConnectionHealthJob();
      const raised = (await alerts("connection_broken")).filter(
        (a) => a.fields.connectionId === dead,
      );
      expect(raised).toHaveLength(1);
      expect(raised[0]!.fields).toEqual({
        clinicId: revoked.clinicId,
        connectionId: dead,
        provider: "fixture",
        status: "revoked",
      });
      await setJobEnabled(JOB_CONNECTION_HEALTH, false, revoked.staffUserId);
    });
  });

  describe("I2, the 07:00 digest", () => {
    test("counts the queues and the email, names connections by id, and passes the payload allowlist", async () => {
      const clinic = await seedClinic("digest-counts");
      const now = new Date();
      await inTenant(clinic.clinicId, async (client) => {
        await client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after)
           values ($1, 'receipt', 'digest-pending', '{}', $2, $2)`,
          [clinic.clinicId, new Date(now.getTime() - 30 * 60_000)],
        );
        await client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, attempts)
           values ($1, 'payment_failed', 'digest-dead', '{}', 6)`,
          [clinic.clinicId],
        );
        await client.query(
          `insert into report_deliveries (clinic_id, kind, period_key, recipient, status, attempted_at, delivery_status, delivery_at)
           values ($1, 'receipt', 'p1', 'owner@example-clinic.test', 'sent', $2, 'bounced', $2),
                  ($1, 'receipt', 'p2', 'owner@example-clinic.test', 'sent', $2, 'delivered', $2)`,
          [clinic.clinicId, new Date(now.getTime() - HOUR)],
        );
      });
      await seedIntent({ paidSeenAt: new Date(now.getTime() - 2 * HOUR) });
      await getMigratorPool().query(`insert into email_daily_quota (day, used) values ($1, 71)`, [
        new Date(now.getTime() - DAY).toISOString().slice(0, 10),
      ]);

      const digest = await collectDigest(now);
      expect(() => assertPayloadAllowed(digest, "ops_digest")).not.toThrow();
      const queue = Object.fromEntries(digest.queueRows.map((q) => [q.kind, q]));
      expect(queue.outbox!.count).toBeGreaterThanOrEqual(1);
      expect(queue.outbox!.oldestMinutes).toBeGreaterThanOrEqual(30);
      expect(queue.orders_without_account!.count).toBeGreaterThanOrEqual(1);
      expect(queue.support_replies).toBeDefined();
      const receipt = digest.emailRows.find((e) => e.kind === "receipt")!;
      expect(receipt).toMatchObject({ sentCount: 2, bouncedCount: 1 });
      expect(digest.emailRows.find((e) => e.kind === "payment_failed")!.deadCount).toBe(1);
      expect(digest.emailsYesterdayCount).toBe(71);
      expect(digest.hasQuotaWarning).toBe(true);
      expect(digest.hasRateWarning).toBe(true);
      // Ids and counts: no clinic's name, no address anywhere in it.
      const text = JSON.stringify(digest);
      expect(text).not.toContain("example-clinic.test");
      expect(text).not.toContain(clinic.slug);
    });

    /**
     * The digest's queue numbers are Home's and the System page's (lane P7f):
     * one read, one rule. A reminder held for tomorrow is not waiting, and
     * one that fell due waits from when it fell due, not from when it was
     * queued; the approval inbox is one line.
     */
    test("counts the queues by the machine-queue rule, so a held reminder is not waiting and the numbers are the System page's", async () => {
      const clinic = await seedClinic("digest-held");
      const now = new Date(Date.now());
      const base = async () => (await collectDigest(now)).queueRows.find((q) => q.kind === "outbox")!;
      const before = await base();
      await inTenant(clinic.clinicId, async (client) => {
        await client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after)
           values ($1, 'setup_reminder', 'digest-held-tomorrow', '{}', $2, $3)`,
          [clinic.clinicId, new Date(now.getTime() - 2 * HOUR), new Date(now.getTime() + DAY)],
        );
      });
      // Queued two hours ago but not due until tomorrow: not in the outbox count.
      expect((await base()).count).toBe(before.count);
      await inTenant(clinic.clinicId, async (client) => {
        await client.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after)
           values ($1, 'setup_reminder', 'digest-due-now', '{}', $2, $3)`,
          [clinic.clinicId, new Date(now.getTime() - 5 * HOUR), new Date(now.getTime() - 20 * 60_000)],
        );
      });
      const after = await base();
      expect(after.count).toBe(before.count + 1);
      // The same numbers the System page reads, from the same function.
      const { machineQueuesOf } = await import("@/lib/ops/machine-queues-ops");
      const { readMachineQueues } = await import("@/lib/ops/inbox/queues");
      const system = machineQueuesOf(
        await readMachineQueues({ now, actor: { type: "service", serviceName: "test" }, request: {} }),
        now,
      ).queues.find((q) => q.key === "outbox");
      expect(system).toMatchObject({ count: after.count, oldestAgeMinutes: after.oldestMinutes });
    }, 60_000);

    test("says how many items wait for the owner's yes in the approval inbox, support replies apart", async () => {
      const pool = getMigratorPool();
      const now = new Date();
      const count = async () => (await collectDigest(now)).approvalsWaitingCount;
      const before = (await count()) ?? 0;
      await pool.query(
        `insert into ops_approvals (kind, subject_ref, payload, due_at, urgency, proposed_by)
         values ('billing_event_replay', 'digest-approvals-a', '{}', now(), 'money', 'approvals-propose'),
                ('support_reply_send', 'digest-approvals-b', '{}', now(), 'routine', 'support-send')`,
      );
      expect(await count()).toBe(before + 1);
      const digest = await collectDigest(now);
      expect(() => assertPayloadAllowed(digest, "ops_digest")).not.toThrow();
      const rendered = renderOpsDigest(digest, {
        clinicName: null,
        audience: "patients",
        reason: "test",
        raisedAt: now,
        timeZone: "UTC",
      });
      expect(rendered.text).toMatch(/Approvals: \d+ items? waiting for your yes\./);
      await pool.query(`update ops_approvals set status = 'rejected', decided_at = now() where subject_ref like 'digest-approvals-%' and status = 'waiting'`);
    }, 60_000);

    /**
     * Until 19 October 2026 the digest read only the ledgers and the ops log:
     * the direct kinds no ledger holds were counted nowhere, and apps/web's
     * mail never reached apps/app, though Resend pauses the whole account.
     */
    test("counts the mail no ledger holds, apps/web's under web:, takes the rates over all of it, and says what it cannot see", async () => {
      await getMigratorPool().query(`truncate email_events`);
      const now = new Date();
      // A sign-in link (B2): no ledger row, so sendEmail counts the send.
      await sendEmail(
        {
          to: "owner@digest-clinic.test",
          kind: "sign_in_link",
          subject: "Your healdesk sign-in link",
          text: "Sign in.",
          html: "<p>Sign in.</p>",
          phiClass: "none",
          payload: { validMinutes: 15 },
          deliveryId: randomUUID(),
          idempotencyKey: `hd-sign_in_link-${randomUUID()}-1`,
        },
        { transport: new FakeTransport(), now: new Date(now.getTime() - HOUR) },
      );
      // apps/web's mail, as its webhook relays Resend's events: three sent, a complaint.
      const at = new Date(now.getTime() - 2 * HOUR).toISOString();
      for (const [type, eventId] of [
        ["sent", "msg_d1"],
        ["sent", "msg_d2"],
        ["sent", "msg_d3"],
        ["complained", "msg_d4"],
      ] as const) {
        const parsed = parseEnvelope(
          JSON.stringify({ op: "emailEvent", args: { type, at, kind: "nurture_1", app: "web", eventId } }),
        );
        if (!parsed.ok) throw new Error("the relay's envelope did not parse");
        await runOperation(parsed.envelope.op, parsed.envelope.args, {
          email: "ops@healdesk.test",
          request: { requestId: "req_digest" },
        });
      }

      const digest = await collectDigest(now);
      expect(() => assertPayloadAllowed(digest, "ops_digest")).not.toThrow();
      expect(digest.emailRows.find((e) => e.kind === "sign_in_link")).toMatchObject({ sentCount: 1 });
      expect(digest.emailRows.find((e) => e.kind === "web:nurture_1")).toMatchObject({
        sentCount: 3,
        complainedCount: 1,
      });
      // The complaint is the account's: over the target, whichever app sent it.
      expect(digest.complaintPercent).toBeGreaterThan(0.05);
      expect(digest.hasRateWarning).toBe(true);
      const rendered = renderOpsDigest(digest, {
        clinicName: null,
        audience: "patients",
        reason: "You're receiving this because you're on healdesk's ops rota.",
        raisedAt: now,
        timeZone: "UTC",
      });
      expect(rendered.text).toContain(DIGEST_EMAIL_BLIND_SPOTS);
      expect(JSON.stringify(digest)).not.toContain("digest-clinic.test");

      // Kept a month, then gone.
      await pruneEmailEvents(new Date(now.getTime() + 31 * DAY));
      const { rows } = await getMigratorPool().query(`select 1 from email_events`);
      expect(rows).toEqual([]);
    });

    /** /sign-in/help's requests for addresses with no account alert no one: the digest says how many. */
    test("counts the day's sign-in help requests for addresses with no account", async () => {
      const now = new Date();
      for (const [code, hoursAgo] of [
        ["no_account", 1],
        ["no_account", 3],
        ["no_account", 30],
        ["no_match", 1],
      ] as const) {
        await getMigratorPool().query(
          `insert into security_events (actor_label, event, metadata, occurred_at)
           values ('sign-in-help', 'sign_in_help_unmatched', $1, $2)`,
          [JSON.stringify({ code }), new Date(now.getTime() - hoursAgo * HOUR)],
        );
      }
      const digest = await collectDigest(now);
      expect(digest.signInHelpNoAccountCount).toBe(2);
      expect(() => assertPayloadAllowed(digest, "ops_digest")).not.toThrow();
      const rendered = renderOpsDigest(digest, {
        clinicName: null,
        audience: "patients",
        reason: "You're receiving this because you're on healdesk's ops rota.",
        raisedAt: now,
        timeZone: "UTC",
      });
      expect(rendered.text).toContain("Sign-in help: 2 requests in the last 24 hours named an address with no account.");
    });

    test("goes once a UTC day from 07:00, to ops, and is retried by the next tick when it fails", async () => {
      process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
      const morning = new Date();
      morning.setUTCHours(7, 5, 0, 0);
      expect((await sendOpsDigest(new Date(morning.getTime() - HOUR))).status).toBe("not_due");

      const failing = new FakeTransport("failed");
      expect((await sendOpsDigest(morning, { transport: failing })).status).toBe("failed");
      const transport = new FakeTransport();
      const sent = await sendOpsDigest(new Date(morning.getTime() + HOUR), { transport });
      expect(sent).toEqual({ status: "sent", attempt: 2 });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.target.to).toBe("ops@healdesk.test");
      expect(transport.sent[0]!.message.subject).toMatch(/^healdesk ops digest, \d{4}-\d{2}-\d{2}/);
      expect(transport.sent[0]!.message.idempotencyKey).toMatch(/^hd-ops_digest-[0-9a-f-]+-2$/);
      expect(
        (await sendOpsDigest(new Date(morning.getTime() + 2 * HOUR), { transport })).status,
      ).toBe("already_sent");
      expect(transport.sent).toHaveLength(1);
    });

    test("the tick runs the flags and the watch every hour, and the digest from 07 UTC", async () => {
      const { runTick } = await import("@/lib/scheduler/tick");
      const at6 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T06:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at6["ops-digest"]).toBeUndefined();
      expect(at6["health-flags"]).toBe("disabled");
      expect(at6["ops-watch"]).toBe("disabled");
      const at7 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T07:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at7["ops-digest"]).toBe("disabled");
      const at13 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T13:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at13["ops-digest"]).toBe("disabled");
    });

    test("is not mailed anywhere without an ops address, and the job is behind its switch", async () => {
      const morning = new Date();
      morning.setUTCHours(8, 0, 0, 0);
      expect((await sendOpsDigest(morning)).status).toBe("no_address");
      const { runOpsDigestJob } = await import("@/lib/ops/digest");
      await setJobEnabled(JOB_OPS_DIGEST, false, (await seedClinic("digest-switch")).staffUserId);
      expect((await runOpsDigestJob({ now: morning })).status).toBe("disabled");
    });
  });
});
