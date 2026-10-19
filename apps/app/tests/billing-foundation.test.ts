import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runAnnualOverageJob } from "@/lib/billing/annual-overage";
import { resolveBillingClinicId, withBillingTenant } from "@/lib/billing/billing-clinic";
import { runCardExpiringJob } from "@/lib/billing/card-expiring";
import { purgeBillingHousekeeping, runBillingHousekeepingJob } from "@/lib/billing/housekeeping";
import { reconcileMeteredItems } from "@/lib/billing/metered-items";
import { enqueueNotice, runBillingNoticesJob, sendPendingNotices } from "@/lib/billing/notices";
import { billingRecipients } from "@/lib/billing/recipients";
import { runBillingReconcileJob } from "@/lib/billing/reconcile";
import { drainBillingRequests, runBillingRequestsJob } from "@/lib/billing/requests";
import { runUsageAlertsJob } from "@/lib/billing/usage-alerts";
import { runUsageMeterReportJob } from "@/lib/billing/usage-report";
import { addRecipient } from "@/lib/reporting/recipients";
import {
  getJob,
  JOB_BILLING_HOUSEKEEPING,
  JOB_BILLING_RECONCILE,
  JOB_BILLING_REQUESTS,
  JOB_CARD_EXPIRING,
  setJobEnabled,
} from "@/lib/scheduler/jobs";
import { runTick } from "@/lib/scheduler/tick";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled, seedPortalUser } from "./setup/factories";

/**
 * The shared billing helpers work package F0 lays down for the Stripe launch:
 * who billing mail goes to, the notice outbox's dedupe, resolving the billing
 * clinic of a location, the housekeeping purge, the job wiring, and the
 * fixtures later packages build on.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "billing-foundation-test" } as const;
const DAY = 24 * 60 * 60 * 1000;

async function seedOpsUser(): Promise<string> {
  const id = `usr_ops_${randomUUID().slice(0, 8)}`;
  await getMigratorPool().query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ops', $2, true, now(), now())`,
    [id, `${id}@healdesk.test`],
  );
  return id;
}

/** A location of `billingClinicId`: a clinic in the same organisation pointing at it. */
async function seedLocation(billingClinicId: string, organizationId: string): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [organizationId, `loc-${randomUUID().slice(0, 6)}`, billingClinicId],
  );
  return rows[0]!.id;
}

describeDb("billing foundation", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  describe("billingRecipients", () => {
    test("owners and billing contacts with an active grant, owners first, never a manager or a revoked grant", async () => {
      const clinic = await seedClinic("recipients");
      const billing = await seedPortalUser(clinic.clinicId, "billing");
      await seedPortalUser(clinic.clinicId, "admin");
      await seedPortalUser(clinic.clinicId, "front_desk");
      const gone = await seedPortalUser(clinic.clinicId, "billing", { label: "former" });
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update clinic_memberships set revoked_at = now() where user_id = $1`, [
          gone.userId,
        ]),
      );
      // A report recipient (the front-desk inbox) is not who pays.
      await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        addRecipient(tx, { email: "info@example-clinic.test", addedBy: "ops" }),
      );

      const recipients = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        billingRecipients(tx),
      );
      expect(recipients).toEqual([
        { email: clinic.staffEmail, role: "owner", userId: clinic.staffUserId },
        { email: billing.email, role: "billing", userId: billing.userId },
      ]);
    });

    test("a person holding both roles is mailed once, as owner", async () => {
      const clinic = await seedClinic("recipients-dup");
      const billing = await seedPortalUser(clinic.clinicId, "billing");
      // Same address on a second grant row is impossible (one active grant per
      // user and clinic), so the overlap is two users with one address.
      await getMigratorPool().query(`update "user" set email = upper($1) where id = $2`, [
        clinic.staffEmail,
        billing.userId,
      ]);
      const recipients = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        billingRecipients(tx),
      );
      expect(recipients).toEqual([
        { email: clinic.staffEmail, role: "owner", userId: clinic.staffUserId },
      ]);
    });

    test("with no owner or billing grant, the buyer seeded at provisioning — and only that address", async () => {
      const clinic = await seedClinic("recipients-legacy");
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [
          clinic.clinicId,
        ]),
      );
      await withTenant({ clinicId: clinic.clinicId, actor }, async (tx) => {
        await addRecipient(tx, { email: "Buyer@Example-Clinic.test", addedBy: "provisioning" });
        await addRecipient(tx, { email: "frontdesk@example-clinic.test", addedBy: "ops" });
      });
      const recipients = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        billingRecipients(tx),
      );
      expect(recipients).toEqual([
        { email: "buyer@example-clinic.test", role: "owner", userId: null },
      ]);
    });
  });

  describe("the billing clinic", () => {
    test("a location resolves to the clinic holding the subscription; a clinic bought at checkout to itself", async () => {
      const root = await seedClinic("billing-root");
      const location = await seedLocation(root.clinicId, root.organizationId);

      expect(
        await withTenant({ clinicId: location, actor }, (tx) => resolveBillingClinicId(tx)),
      ).toBe(root.clinicId);
      expect(
        await withTenant({ clinicId: root.clinicId, actor }, (tx) => resolveBillingClinicId(tx)),
      ).toBe(root.clinicId);
      const seen = await withBillingTenant(location, actor, async (tx) => tx.clinicId);
      expect(seen).toBe(root.clinicId);
    });
  });

  describe("enqueueNotice", () => {
    test("queues once per (clinic, kind, dedupe key) and reports whether it inserted", async () => {
      const clinic = await seedClinic("notices");
      const enqueue = (key: string) =>
        withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
          enqueueNotice(tx, "payment_failed", key, {
            amountDueCents: 120_000,
            hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
            graceEndsAt: "2026-10-12T00:00:00.000Z",
            isFirstPlanCharge: false,
          }),
        );
      expect(await enqueue("in_test_1")).toBe(true);
      expect(await enqueue("in_test_1")).toBe(false);
      expect(await enqueue("in_test_2")).toBe(true);
      // Same key, different kind: a different notice.
      const other = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        enqueueNotice(tx, "payment_action_required", "in_test_1", {
          amountDueCents: 120_000,
          hostedInvoiceUrl: null,
        }),
      );
      expect(other).toBe(true);

      const sendAfter = new Date("2026-10-06T09:00:00Z");
      await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
        enqueueNotice(
          tx,
          "grace_ending",
          "in_test_1",
          { graceEndsAt: "2026-10-07T00:00:00.000Z", hostedInvoiceUrl: null, amountDueCents: null },
          { sendAfter },
        ),
      );

      const rows = await inTenant(clinic.clinicId, async (c) => {
        const { rows } = await c.query<{
          kind: string;
          dedupe_key: string;
          send_after: Date;
          sent_at: Date | null;
          attempts: number;
        }>(
          `select kind, dedupe_key, send_after, sent_at, attempts from billing_notices where clinic_id = $1 order by kind, dedupe_key`,
          [clinic.clinicId],
        );
        return rows;
      });
      expect(rows.map((r) => `${r.kind}:${r.dedupe_key}`)).toEqual([
        "grace_ending:in_test_1",
        "payment_action_required:in_test_1",
        "payment_failed:in_test_1",
        "payment_failed:in_test_2",
      ]);
      expect(rows[0]!.send_after.getTime()).toBe(sendAfter.getTime());
      expect(rows.every((r) => r.sent_at === null && r.attempts === 0)).toBe(true);

      // A notice is invisible from another clinic's tenant.
      const stranger = await seedClinic("notices-other");
      const seen = await inTenant(
        stranger.clinicId,
        async (c) => (await c.query(`select id from billing_notices`)).rows,
      );
      expect(seen).toEqual([]);
    });

    test("refuses an empty or oversized dedupe key", async () => {
      const clinic = await seedClinic("notices-keys");
      for (const key of ["", "   ", "x".repeat(201)]) {
        await expect(
          withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
            enqueueNotice(tx, "restored", key, { receiptUrl: null }),
          ),
        ).rejects.toThrow(/dedupe key/);
      }
    });
  });

  describe("billing housekeeping", () => {
    test("purges expired intents, long-consumed intents, old Meta refs and old Connect states, and nothing else", async () => {
      const now = new Date("2026-10-05T06:00:00Z");
      const pool = getMigratorPool();
      const payload = JSON.stringify({ clinicName: "Radiance" });
      const intent = async (expiresAt: Date, consumedAt: Date | null) => {
        const { rows } = await pool.query<{ ref: string }>(
          `insert into checkout_intents (payload, agreement_id, contact_email, plan, billing_interval, expires_at, consumed_at)
           values ($1, $2, 'buyer@example-clinic.test', 'complete', 'month', $3, $4) returning ref`,
          [payload, randomUUID(), expiresAt, consumedAt],
        );
        return rows[0]!.ref;
      };
      const expired = await intent(new Date(now.getTime() - DAY), null);
      const live = await intent(new Date(now.getTime() + DAY), null);
      const oldConsumed = await intent(
        new Date(now.getTime() - 100 * DAY),
        new Date(now.getTime() - 91 * DAY),
      );
      const recentConsumed = await intent(
        new Date(now.getTime() - 20 * DAY),
        new Date(now.getTime() - 30 * DAY),
      );

      const clinic = await seedClinic("housekeeping");
      await inTenant(clinic.clinicId, async (c) => {
        await c.query(
          `insert into meta_inbound_messages (clinic_id, platform, message_ref, received_at) values
             ($1, 'messenger', 'old', $2), ($1, 'whatsapp', 'new', $3)`,
          [clinic.clinicId, new Date(now.getTime() - 8 * DAY), new Date(now.getTime() - 6 * DAY)],
        );
      });
      const state = (createdAt: Date) =>
        pool.query(
          `insert into stripe_connect_states (state_hash, target_clinic_id, return_to, created_at, expires_at) values ($1, $2, 'settings', $3, $3::timestamptz + interval '15 minutes')`,
          [createHash("sha256").update(randomBytes(16)).digest(), clinic.clinicId, createdAt],
        );
      await state(new Date(now.getTime() - 2 * DAY));
      await state(new Date(now.getTime() - 60 * 60 * 1000));

      const result = await purgeBillingHousekeeping(now);
      expect(result).toMatchObject({
        expiredIntents: 1,
        consumedIntents: 1,
        connectStates: 1,
        clinicsFailed: 0,
      });
      expect(result.metaMessageRefs).toBeGreaterThanOrEqual(1);

      const { rows: intents } = await pool.query<{ ref: string }>(
        `select ref from checkout_intents`,
      );
      expect(intents.map((r) => r.ref).sort()).toEqual([live, recentConsumed].sort());
      expect(intents.some((r) => r.ref === expired || r.ref === oldConsumed)).toBe(false);
      const refs = await inTenant(clinic.clinicId, async (c) =>
        (
          await c.query<{ message_ref: string }>(`select message_ref from meta_inbound_messages`)
        ).rows.map((r) => r.message_ref),
      );
      expect(refs).toEqual(["new"]);
      const { rows: states } = await pool.query(`select 1 from stripe_connect_states`);
      expect(states).toHaveLength(1);

      // A second run finds nothing more to do.
      expect(await purgeBillingHousekeeping(now)).toMatchObject({
        expiredIntents: 0,
        consumedIntents: 0,
        metaMessageRefs: 0,
        connectStates: 0,
      });
    });

    test("purges chat threads idle for more than 30 days in every clinic, and keeps the live ones", async () => {
      // A thread holds an HMAC of the sender's id (a WhatsApp number among
      // them): kept past its use, it is a record of who messaged the clinic.
      const now = new Date("2026-10-05T06:00:00Z");
      const thread = (clinicId: string, partyRef: string, lastInboundAt: Date) =>
        inTenant(clinicId, (c) =>
          c.query(
            `insert into chat_threads (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at)
             values ($1, 'whatsapp', $2, $3, $4, $4)`,
            [clinicId, partyRef, randomUUID(), lastInboundAt],
          ),
        );
      const a = await seedClinic("threads-a");
      const b = await seedClinic("threads-b");
      await thread(a.clinicId, "v1:idle-a", new Date(now.getTime() - 31 * DAY));
      await thread(a.clinicId, "v1:live-a", new Date(now.getTime() - 29 * DAY));
      await thread(b.clinicId, "v1:idle-b", new Date(now.getTime() - 45 * DAY));
      await thread(b.clinicId, "v1:live-b", new Date(now.getTime() - DAY));

      const result = await purgeBillingHousekeeping(now);
      expect(result).toMatchObject({ chatThreads: 2, clinicsFailed: 0 });
      const left = (clinicId: string) =>
        inTenant(clinicId, async (c) =>
          (await c.query<{ party_ref: string }>(`select party_ref from chat_threads`)).rows.map(
            (r) => r.party_ref,
          ),
        );
      expect(await left(a.clinicId)).toEqual(["v1:live-a"]);
      expect(await left(b.clinicId)).toEqual(["v1:live-b"]);
      expect((await purgeBillingHousekeeping(now)).chatThreads).toBe(0);
    });

    test("runs only behind its switch, and records what it did", async () => {
      const now = new Date("2026-10-05T06:00:00Z");
      expect(await runBillingHousekeepingJob({ now })).toEqual({ status: "disabled" });
      await setJobEnabled(JOB_BILLING_HOUSEKEEPING, true, await seedOpsUser());
      const outcome = await runBillingHousekeepingJob({ now });
      expect(outcome.status).toBe("ok");
      const job = await getJob(JOB_BILLING_HOUSEKEEPING);
      expect(job?.lastRunStatus).toBe("ok");
      expect(job?.lastRunNote).toMatch(/^Purged \d+ expired and \d+ consumed checkout intents/);
      expect(job?.runningSince).toBeNull();
      await setJobEnabled(JOB_BILLING_HOUSEKEEPING, false, await seedOpsUser());
    });
  });

  describe("job wiring and stubs", () => {
    // Two whole ticks, every job in each: seconds on a loaded machine, so not
    // the default five (tests must not race the clock).
    test("the 05 and 06 UTC ticks add the annual overage invoice and the housekeeping, each behind its switch", async () => {
      const at5 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T05:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at5["annual-overage-invoice"]).toBe("disabled");
      expect(at5["billing-housekeeping"]).toBeUndefined();
      const at6 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T06:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at6["billing-housekeeping"]).toBe("disabled");
      expect(at6["annual-overage-invoice"]).toBeUndefined();
      // The Stripe build (drizzle/0050): the reconcile and the requests
      // worker every hour, the card-expiry check at 07 only.
      for (const hourly of [
        "usage-meter-report",
        "usage-alerts",
        "billing-reconcile",
        "billing-requests",
      ]) {
        expect(at5[hourly], hourly).toBe("disabled");
        expect(at6[hourly], hourly).toBe("disabled");
      }
      expect(at5["card-expiring"]).toBeUndefined();
      expect(at6["card-expiring"]).toBeUndefined();
      const at7 = Object.fromEntries(
        (await runTick(new Date("2026-10-05T07:00:00Z"))).map((o) => [o.job, o.status]),
      );
      expect(at7["card-expiring"]).toBe("disabled");
      expect(at7["billing-housekeeping"]).toBeUndefined();
      // The reconcile runs before the worker, so a request it records this
      // hour is carried out this hour.
      const order = (await runTick(new Date("2026-10-05T08:00:00Z"))).map((o) => o.job);
      expect(order.indexOf("billing-reconcile")).toBeLessThan(order.indexOf("billing-requests"));
      // setup-closure is a switch the worker reads, never a job the tick runs.
      expect(order).not.toContain("setup-closure");
      // The notices sender runs every minute from the `notices` queue now, not
      // from the hourly tick (lib/email/outbox.ts).
      expect(at5["billing-notices"]).toBeUndefined();
    }, 30_000);

    test("the stubs later packages replace are safe: they run behind their switches and do nothing", async () => {
      const now = new Date("2026-10-05T07:00:00Z");
      expect(await runUsageMeterReportJob({ now })).toEqual({ status: "disabled" });
      expect(await runAnnualOverageJob({ now })).toEqual({ status: "disabled" });
      expect(await runUsageAlertsJob({ now })).toEqual({ status: "disabled" });
      // The sender is real now (lib/email/outbox.ts), and still does nothing
      // while its switch, the billing-notices job row, is off.
      expect(await runBillingNoticesJob({ now })).toEqual({ status: "disabled" });
      expect(await sendPendingNotices({ now })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
      // Real now (Package C-actions): a clinic with no billing row is skipped.
      expect(await reconcileMeteredItems(randomUUID())).toEqual({
        status: "skipped",
        reason: "no_entitlements",
      });
      // The Stripe build's jobs (S0's entry points, C-requests' bodies), each
      // behind its switch.
      expect(await runBillingRequestsJob({ now })).toEqual({ status: "disabled" });
      expect(await runBillingReconcileJob({ now })).toEqual({ status: "disabled" });
      expect(await runCardExpiringJob({ now })).toEqual({ status: "disabled" });
      expect(await drainBillingRequests({ now })).toEqual({ processed: 0, deferred: 0, failed: 0 });
    });

    test("the Stripe build's jobs record their runs once switched on, and leave no lock behind", async () => {
      const now = new Date("2026-10-05T07:00:00Z");
      const ops = await seedOpsUser();
      for (const [name, run] of [
        [JOB_BILLING_REQUESTS, () => runBillingRequestsJob({ now })],
        [JOB_BILLING_RECONCILE, () => runBillingReconcileJob({ now })],
        [JOB_CARD_EXPIRING, () => runCardExpiringJob({ now })],
      ] as const) {
        await setJobEnabled(name, true, ops);
        expect(await run(), name).toMatchObject({ status: "ok" });
        const job = await getJob(name);
        expect(job?.lastRunStatus, name).toBe("ok");
        expect(job?.runningSince, name).toBeNull();
        await setJobEnabled(name, false, ops);
      }
      // The minute worker skips runJob's 60-minute lock: a run left "running"
      // by a crashed process does not stop the next one (runSwitchedJob).
      await setJobEnabled(JOB_BILLING_REQUESTS, true, ops);
      await getMigratorPool().query(`update scheduled_jobs set running_since = $2 where name = $1`, [
        JOB_BILLING_REQUESTS,
        new Date(now.getTime() - 60_000),
      ]);
      expect(await runBillingRequestsJob({ now })).toMatchObject({ status: "ok" });
      await setJobEnabled(JOB_BILLING_REQUESTS, false, ops);
    });
  });

  describe("fixtures", () => {
    test("seedEntitled writes an active row through the real writers; seedPortalUser grants and the portal can see it", async () => {
      type Row = {
        status: string;
        plan_code: string;
        bought_plan_id: string | null;
        channels_enabled: Record<string, boolean>;
        locations: number;
        current_period_start: Date | null;
        current_period_end: Date | null;
        plan_started_at: Date | null;
        plan_start_applied_at: Date | null;
        first_plan_invoice_id: string | null;
        first_paid_at: Date | null;
        paid_through: Date | null;
        setup_deadline_at: Date | null;
      };
      const rowOf = (clinicId: string) =>
        inTenant(clinicId, async (c) => {
          const { rows } = await c.query<Row>(
            `select status, plan_code, bought_plan_id, channels_enabled, locations,
                    current_period_start, current_period_end, plan_started_at,
                    plan_start_applied_at, first_plan_invoice_id, first_paid_at, paid_through,
                    setup_deadline_at
               from entitlements where clinic_id = $1`,
            [clinicId],
          );
          return rows[0]!;
        });

      // The default: bought under the deferred start, setup fee paid, plan not
      // started, so no allowance window yet.
      const clinic = await seedClinic("fixtures");
      const ids = await seedEntitled(clinic.clinicId, {
        planId: "voice-webchat-1000-1000",
        interval: "year",
        locations: 2,
      });
      expect(ids.stripeSubscriptionId).toMatch(/^sub_test/);
      const row = await rowOf(clinic.clinicId);
      expect(row).toMatchObject({
        status: "active",
        plan_code: "voice-webchat-1000-1000",
        bought_plan_id: "voice-webchat-1000-1000",
        locations: 2,
        current_period_start: null,
        plan_started_at: null,
      });
      expect(row.first_paid_at?.toISOString()).toBe("2026-10-01T00:00:00.000Z");

      // Bought Voice + Meta Chat, billed as AYA Web Chat, started: channels follow what
      // was bought, and the window opens from the start through
      // allowanceWindow (an annual plan's first month).
      const started = await seedClinic("fixtures-started");
      const startedAt = new Date("2026-10-10T00:00:00Z");
      await seedEntitled(started.clinicId, {
        planId: "webchat-1000",
        boughtPlanId: "voice-metachat-1000-1000",
        interval: "year",
        planStartedAt: startedAt,
        planStartAppliedAt: startedAt,
        firstPlanInvoiceId: "in_fixturefirstplan",
        setupDeadlineAt: new Date("2026-11-05T00:00:00Z"),
        channelRows: [
          { channel: "web", liveAt: startedAt, firstAnswerAt: startedAt },
          { channel: "voice", readyAt: startedAt, waitingOn: "forwarding" },
        ],
      });
      const startedRow = await rowOf(started.clinicId);
      expect(startedRow).toMatchObject({
        plan_code: "webchat-1000",
        bought_plan_id: "voice-metachat-1000-1000",
        channels_enabled: { web: true, meta: true, voice: true },
        first_plan_invoice_id: "in_fixturefirstplan",
      });
      expect(startedRow.plan_started_at?.toISOString()).toBe(startedAt.toISOString());
      expect(startedRow.plan_start_applied_at?.toISOString()).toBe(startedAt.toISOString());
      expect(startedRow.current_period_start?.toISOString()).toBe(startedAt.toISOString());
      expect(startedRow.current_period_end?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
      expect(startedRow.paid_through?.toISOString()).toBe("2027-10-10T00:00:00.000Z");
      expect(startedRow.setup_deadline_at?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
      const channels = await inTenant(started.clinicId, async (c) => {
        const { rows } = await c.query<{
          channel: string;
          waiting_on: string | null;
          first_answer_at: Date | null;
        }>(
          `select channel, waiting_on, first_answer_at from clinic_channels where clinic_id = $1 order by channel`,
          [started.clinicId],
        );
        return rows;
      });
      expect(channels.map((c) => [c.channel, c.waiting_on, c.first_answer_at !== null])).toEqual([
        ["voice", "forwarding", false],
        ["web", null, true],
      ]);

      // legacy: the row every fixture got before the deferred start.
      const legacy = await seedClinic("fixtures-legacy");
      await seedEntitled(legacy.clinicId, {
        planId: "voice-webchat-1000-1000",
        interval: "year",
        legacy: true,
      });
      const legacyRow = await rowOf(legacy.clinicId);
      expect(legacyRow).toMatchObject({
        plan_code: "voice-webchat-1000-1000",
        bought_plan_id: null,
      });
      expect(legacyRow.current_period_start?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      await expect(
        seedEntitled((await seedClinic("fixtures-bad")).clinicId, {
          legacy: true,
          planStartedAt: startedAt,
        }),
      ).rejects.toThrow(/legacy row/);

      const noStripe = await seedClinic("fixtures-nostripe");
      expect(await seedEntitled(noStripe.clinicId, { stripe: false, firstInvoice: false })).toEqual(
        {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        },
      );

      const billing = await seedPortalUser(clinic.clinicId, "billing");
      const { rows } = await getMigratorPool().query<{ role: string }>(
        `select role from app_user_clinic_grants($1)`,
        [billing.userId],
      );
      expect(rows).toEqual([{ role: "billing" }]);
    });
  });
});
