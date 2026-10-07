import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getEntitlements, setGrace } from "@/lib/billing/entitlements";
import { __clearPriceCacheForTests } from "@/lib/billing/prices";
import { transition } from "@/lib/billing/state-machine";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { isMutating, isOpName, runOperation, type OpName, type Operator } from "@/lib/ops/api";
import type { ClinicBillingView } from "@/lib/ops/billing";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";

/**
 * The ops console's billing panel (build spec §7 E, R35), driven through the
 * envelope's own dispatch: each operation's validation, its projection (no
 * payload ever crosses), its audit rows on both planes, and what a replay of
 * the same request does. The envelope's signature is good for 300 seconds and
 * carries no nonce, so a second copy of any write must change nothing more.
 *
 * Also F1: setConnectionPhiBasis, against a real connection, with and
 * without a note, which is the path the old `note` audit key broke.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test, on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 60_000 };

const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "127.0.0.1", userAgent: "vitest" },
};
const NOW = new Date("2026-10-10T12:00:00Z");
const STARTED = new Date("2026-10-07T00:00:00Z");
const PERIOD_END = new Date("2026-11-07T00:00:00Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);
const EMAIL_LIKE = /[^\s@"]+@[^\s@"]+\.[^\s@"]{2,}/;
const actor = { type: "service", serviceName: "ops-billing-test" } as const;

const BILLING_OPS = [
  "getClinicBilling",
  "previewRefund",
  "setOverageMode",
  "setUsageAlerts",
  "replayBillingEvent",
  "commitRefund",
  "setClinicSettings",
  "setDepositSettings",
  "disconnectStripeConnect",
  "issueStripeConnectLink",
  "retryBillingRequest",
  "liftSuspension",
  "extendSetupDeadline",
  "retryLocationSetup",
  "retryOverageInvoice",
  "closeUnfinishedSetup",
  "replayConnectEvent",
  "setAutoRenew",
] as const;

type Outcome = { status: string; message?: string; [key: string]: unknown };

async function run<T = Outcome>(op: OpName, args: Record<string, unknown>): Promise<T> {
  const outcome = await runOperation(op, args, OPERATOR);
  if (outcome.status !== 200) {
    throw new Error(`ops ${outcome.status}: ${JSON.stringify(outcome.body)}`);
  }
  return (outcome.body as { data: T }).data;
}

/** Security events of one name, as the identity plane recorded them. */
async function securityEvents(event: string) {
  const { rows } = await getMigratorPool().query<{
    metadata: Record<string, unknown> | null;
    actor_label: string;
    ip_address: string | null;
  }>(
    `select metadata, actor_label, ip_address from security_events where event = $1 order by occurred_at, id`,
    [event],
  );
  return rows;
}

async function eventsFor(event: string, key: string, value: string) {
  return (await securityEvents(event)).filter((row) => row.metadata?.[key] === value);
}

/** The tenant-plane audit rows the operator's own requests wrote; the fixtures write some too. */
async function auditRows(clinicId: string, resourceType: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      action: string;
      metadata: Record<string, unknown> | null;
      actor_label: string;
      ip_address: string | null;
    }>(
      `select action, metadata, actor_label, ip_address from audit_log
        where clinic_id = $1 and resource_type = $2 and actor_label = $3
        order by occurred_at, id`,
      [clinicId, resourceType, OPERATOR.email],
    );
    return rows;
  });
}

async function rowOf(clinicId: string) {
  const row = await withTenant({ clinicId, actor }, (tx) => getEntitlements(tx.db, clinicId));
  if (!row) throw new Error("no entitlements");
  return row;
}

async function seedLocation(billingClinicId: string, organizationId: string): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, 'Second location', 'med-spa', $3) returning id`,
    [organizationId, `loc-${randomUUID().slice(0, 6)}`, billingClinicId],
  );
  return rows[0]!.id;
}

async function connectAccount(clinicId: string, accountId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
    [clinicId, accountId, STARTED],
  );
}

describe("the billing panel's operations are registered", () => {
  test("every one is a known operation; the read and the preview are not mutating, every other is", () => {
    for (const op of BILLING_OPS) {
      expect(isOpName(op), op).toBe(true);
      expect(isMutating(op), op).toBe(op !== "getClinicBilling" && op !== "previewRefund");
    }
  });
});

describeDb("ops: the billing panel", DB_TEST_OPTIONS, () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    notifyOps.mockClear();
    __clearPriceCacheForTests();
    // Every "now" in the code under test, pinned. Only Date: faking the
    // timers too would stall the pg driver's own timeouts.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setStripeForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // getClinicBilling
  // ---------------------------------------------------------------------------

  describe("getClinicBilling", () => {
    test("a location reads its billing clinic's ledgers, with flags, and parked events as ids, types and codes; no payload crosses", async () => {
      const billing = await seedClinic("ob-view");
      await seedEntitled(billing.clinicId, {
        planId: "web-voice",
        boughtPlanId: "complete",
        planStartedAt: STARTED,
        channelRows: [
          { channel: "web", readyAt: STARTED, liveAt: STARTED, firstAnswerAt: STARTED },
          { channel: "voice", readyAt: STARTED },
          { channel: "meta" },
        ],
      });
      const locationId = await seedLocation(billing.clinicId, billing.organizationId);
      await seedChannels(locationId, [
        { channel: "voice", readyAt: STARTED, liveAt: STARTED, firstAnswerAt: STARTED },
      ]);
      await inTenant(billing.clinicId, async (c) => {
        await c.query(
          `update entitlements set cancel_at = $2, open_invoice_id = 'in_open_view',
             open_invoice_url = 'https://invoice.stripe.com/i/in_open_view', open_invoice_amount_cents = 89700,
             pending_plan_change_request_id = 'req-view-pending', pending_plan_change_plan_id = 'chat-web',
             pending_plan_change_interval = 'year'
           where clinic_id = $1`,
          [billing.clinicId, PERIOD_END],
        );
        await c.query(
          `insert into billing_notices (clinic_id, kind, dedupe_key, payload, created_at, send_after, attempts, last_error)
           values ($1, 'payment_failed', 'in_open_view', $2, $3, $3, 6, 'dead: refused for buyer@example.test')`,
          [
            billing.clinicId,
            JSON.stringify({
              amountDueCents: 89700,
              hostedInvoiceUrl: "https://invoice.stripe.com/i/secret-path",
            }),
            STARTED,
          ],
        );
        await c.query(
          `insert into billing_requests (clinic_id, kind, channel_key, reason, requested_at, next_attempt_at, attempts)
           values ($1, 'step_up', 'voice', 'first_answer', $2, $2, 3)`,
          [billing.clinicId, new Date(NOW.getTime() - 2 * 24 * 3_600_000)],
        );
        await c.query(
          `insert into billing_requests (clinic_id, kind, reason, requested_at, next_attempt_at, attempts, done_at, outcome, outcome_reason)
           values ($1, 'plan_start', 'first_answer', $2, $2, 1, $2, 'done', 'already_started')`,
          [billing.clinicId, STARTED],
        );
        await c.query(
          `insert into overage_invoices (clinic_id, window_start, window_end, voice_units, amount_cents, status, error)
           values ($1, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 12, 960, 'failed', 'card_error:card_declined')`,
          [billing.clinicId],
        );
      });
      const pool = getMigratorPool();
      await pool.query(
        `insert into billing_events (stripe_event_id, type, outcome, failures, error, resolved_clinic_id, payload)
         values ('evt_view_parked', 'invoice.paid', 'dead_letter', 3,
                 'UnresolvedClinicError: Stripe event evt_view_parked names buyer@example.test', $1, $2),
                ('evt_view_done', 'invoice.paid', 'processed', 0, null, $1, $2)`,
        [
          billing.clinicId,
          JSON.stringify({ data: { object: { customer_email: "buyer@example.test" } } }),
        ],
      );
      await pool.query(
        `insert into stripe_connect_events (stripe_event_id, type, account, outcome, failures, error, resolved_clinic_id)
         values ('evt_view_connect', 'checkout.session.completed', 'acct_1View', 'failed', 1, 'amount_mismatch', $1)`,
        [locationId],
      );
      await connectAccount(locationId, "acct_1View");
      await inTenant(locationId, (c) =>
        c.query(
          `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_by_label, ai_paused_until, direct_line_e164, direct_line_set_at)
           values ($1, $2, 'healdesk support', $3, '+14155550199', $2)`,
          [locationId, new Date(NOW.getTime() - 3_600_000), new Date(NOW.getTime() + 3_600_000)],
        ),
      );
      const fake = createStripeFake({
        "accounts.retrieve": () => ({
          settings: { dashboard: { display_name: "View Aesthetics" } },
        }),
      });
      __setStripeForTests(fake.stripe);

      const view = await run<ClinicBillingView>("getClinicBilling", { clinicId: locationId });

      expect(Object.keys(view).sort()).toEqual([
        "attentionEvents",
        "channelsInService",
        "clinic",
        "connect",
        "deposits",
        "entitlements",
        "flags",
        "group",
        "notices",
        "overageInvoices",
        "requests",
        "settings",
        "transitions",
        "usage",
      ]);
      expect(Object.keys(view.entitlements!).sort()).toEqual([
        "billedPlanId",
        "boughtPlanId",
        "cancelAt",
        "closesAt",
        "firstPeriodRefundedAt",
        "graceEndsAt",
        "hasSubscription",
        "interval",
        "isLegacy",
        "isMutationInFlight",
        "isPlanStarted",
        "locations",
        "openInvoice",
        "overageMode",
        "paidThrough",
        "planStartAppliedAt",
        "planStartedAt",
        "setupDeadlineAt",
        "status",
        "usageAlertsEnabled",
      ]);
      expect(view.clinic).toMatchObject({
        id: locationId,
        billingClinicId: billing.clinicId,
        isLocation: true,
      });
      expect(view.group.map((g) => [g.clinicId, g.isBillingClinic])).toEqual([
        [billing.clinicId, true],
        [locationId, false],
      ]);
      expect(view.group[1]!.channels).toEqual([
        {
          channel: "voice",
          enabled: true,
          status: "paused",
          readyAt: STARTED.toISOString(),
          waitingOn: null,
          liveAt: STARTED.toISOString(),
          firstAnswerAt: STARTED.toISOString(),
        },
      ]);
      expect(view.channelsInService).toEqual(["web", "voice"]);
      expect(view.entitlements).toMatchObject({
        status: "active",
        boughtPlanId: "complete",
        billedPlanId: "web-voice",
        isLegacy: false,
        isPlanStarted: true,
        planStartedAt: STARTED.toISOString(),
        cancelAt: PERIOD_END.toISOString(),
        closesAt: PERIOD_END.toISOString(),
        openInvoice: { url: "https://invoice.stripe.com/i/in_open_view", amountCents: 89700 },
        isMutationInFlight: false,
      });
      expect(view.usage.map((u) => [u.meter, u.used, u.isWindowOpen])).toEqual([
        ["voice_minutes", 0, true],
        ["chat_conversations", 0, true],
      ]);
      expect(view.transitions.map((t) => [t.fromStatus, t.toStatus])).toContainEqual([
        "provisioning",
        "active",
      ]);
      expect(view.notices).toEqual([
        {
          kind: "payment_failed",
          createdAt: STARTED.toISOString(),
          sendAfter: STARTED.toISOString(),
          sentAt: null,
          attempts: 6,
          recipientsCount: null,
          lastError: "dead: refused for [email redacted]",
        },
      ]);
      expect(view.requests.map((r) => [r.kind, r.channel, r.outcome, r.isStuck])).toEqual([
        ["plan_start", null, "done", false],
        ["step_up", "voice", null, true],
      ]);
      expect(view.overageInvoices).toEqual([
        {
          windowStart: "2026-09-01T00:00:00.000Z",
          windowEnd: "2026-10-01T00:00:00.000Z",
          voiceUnits: 12,
          chatUnits: 0,
          amountCents: 960,
          status: "failed",
          invoicedAt: null,
          code: "card_error:card_declined",
        },
      ]);
      expect(view.attentionEvents).toEqual([
        expect.objectContaining({
          source: "billing",
          stripeEventId: "evt_view_parked",
          type: "invoice.paid",
          outcome: "dead_letter",
          failures: 3,
          code: "UnresolvedClinicError",
        }),
        expect.objectContaining({
          source: "connect",
          stripeEventId: "evt_view_connect",
          type: "checkout.session.completed",
          outcome: "failed",
          failures: 1,
          code: "amount_mismatch",
        }),
      ]);
      expect(view.settings).toMatchObject({
        isPaused: true,
        pausedByLabel: "healdesk support",
        directLineE164: "+14155550199",
      });
      expect(view.connect).toEqual({
        isConnected: true,
        accountLabel: "View Aesthetics",
        connectedAt: STARTED.toISOString(),
        disconnectedAt: null,
      });
      expect(view.flags).toEqual({
        refundWindowOpen: true,
        refundEligibleUntil: "2026-10-21",
        refundDue: true,
        stuckRequests: 1,
        pendingLocation: null,
        pendingPlanChange: { planId: "chat-web", interval: "year" },
      });

      // Nothing from a payload or an error's message crosses, nor the
      // pending change's request id: the console needs the plan, not the token.
      const wire = JSON.stringify(view);
      expect(wire).not.toContain("req-view-pending");
      expect(wire).not.toContain("payload");
      expect(wire).not.toContain("secret-path");
      expect(wire).not.toContain("buyer@example.test");
      expect(wire).not.toMatch(EMAIL_LIKE);

      // Both tenant reads are on record, with the operator's address.
      expect(await auditRows(locationId, "clinic_settings")).toEqual([
        expect.objectContaining({
          action: "read",
          metadata: { purpose: "ops_billing_view" },
          actor_label: OPERATOR.email,
          ip_address: "127.0.0.1",
        }),
      ]);
      expect(await auditRows(billing.clinicId, "entitlements")).toEqual([
        expect.objectContaining({ action: "read", metadata: { purpose: "ops_billing_view" } }),
      ]);

      // The billing clinic's own view: its parked event, not its location's.
      const own = await run<ClinicBillingView>("getClinicBilling", { clinicId: billing.clinicId });
      expect(own.clinic.isLocation).toBe(false);
      expect(own.attentionEvents.map((e) => e.stripeEventId)).toEqual(["evt_view_parked"]);
      expect(own.connect).toMatchObject({ isConnected: false, accountLabel: null });
    });

    test("an unknown or malformed clinic is a 404; a clinic with no billing row reads empty", async () => {
      for (const clinicId of [randomUUID(), "not-a-uuid", undefined]) {
        const outcome = await runOperation("getClinicBilling", { clinicId }, OPERATOR);
        expect(outcome.status).toBe(404);
        expect(outcome.body).toEqual({ error: "No such clinic.", code: "invalid_args" });
      }
      const bare = await seedClinic("ob-bare");
      const view = await run<ClinicBillingView>("getClinicBilling", { clinicId: bare.clinicId });
      expect(view.entitlements).toBeNull();
      expect(view.usage).toEqual([]);
      expect(view.flags).toEqual({
        refundWindowOpen: false,
        refundEligibleUntil: null,
        refundDue: false,
        stuckRequests: 0,
        pendingLocation: null,
        pendingPlanChange: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The switches
  // ---------------------------------------------------------------------------

  describe("setOverageMode and setUsageAlerts", () => {
    test("a location's switch moves its billing clinic's row, is audited once, and a replay changes nothing", async () => {
      const billing = await seedClinic("ob-overage");
      await seedEntitled(billing.clinicId, { planId: "chat-web" });
      const locationId = await seedLocation(billing.clinicId, billing.organizationId);

      expect(await run("setOverageMode", { clinicId: locationId, mode: "hard_cap" })).toEqual({
        status: "updated",
        changed: true,
        auditRecorded: true,
      });
      expect((await rowOf(billing.clinicId)).overageMode).toBe("hard_cap");
      expect(await auditRows(billing.clinicId, "entitlements")).toEqual([
        expect.objectContaining({
          action: "update",
          metadata: { field: "overage_mode", mode: "hard_cap" },
          actor_label: OPERATOR.email,
        }),
      ]);

      // The same request again: nothing to change, nothing more on record.
      expect(await run("setOverageMode", { clinicId: locationId, mode: "hard_cap" })).toEqual({
        status: "updated",
        changed: false,
        auditRecorded: true,
      });
      expect(await auditRows(billing.clinicId, "entitlements")).toHaveLength(1);
      const slug = (
        await getMigratorPool().query<{ slug: string }>(`select slug from clinics where id = $1`, [
          locationId,
        ])
      ).rows[0]!.slug;
      expect(await eventsFor("billing_overage_mode_set", "clinicSlug", slug)).toEqual([
        expect.objectContaining({
          metadata: { clinicSlug: slug, mode: "hard_cap" },
          actor_label: OPERATOR.email,
          ip_address: "127.0.0.1",
        }),
      ]);

      expect(await run("setUsageAlerts", { clinicId: billing.clinicId, on: false })).toEqual({
        status: "updated",
        changed: true,
        auditRecorded: true,
      });
      expect((await rowOf(billing.clinicId)).usageAlertsEnabled).toBe(false);
      expect(await run("setUsageAlerts", { clinicId: billing.clinicId, on: false })).toMatchObject({
        changed: false,
      });
      expect(await eventsFor("billing_usage_alerts_set", "clinicSlug", billing.slug)).toHaveLength(
        1,
      );
    });

    test("refused: an unknown clinic, a mode outside the two, a switch that is not a boolean, no billing row", async () => {
      const c = await seedClinic("ob-overage-bad");
      expect(await run("setOverageMode", { clinicId: randomUUID(), mode: "allow" })).toEqual({
        status: "error",
        message: "No such clinic.",
      });
      expect(
        await run("setOverageMode", { clinicId: c.clinicId, mode: "unlimited" }),
      ).toMatchObject({ status: "error" });
      expect(await run("setUsageAlerts", { clinicId: c.clinicId, on: "yes" })).toMatchObject({
        status: "error",
      });
      expect(await run("setUsageAlerts", { clinicId: c.clinicId, on: true })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/no billing account/),
      });
    });
  });

  describe("setClinicSettings", () => {
    test("pauses with an end and sets the direct line, audited with booleans, never the digits; a replay changes nothing", async () => {
      const c = await seedClinic("ob-settings");
      const until = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();

      expect(
        await run("setClinicSettings", {
          clinicId: c.clinicId,
          aiPaused: true,
          aiPausedUntil: until,
        }),
      ).toEqual({ status: "updated", changed: true, auditRecorded: true });
      expect(
        await run("setClinicSettings", {
          clinicId: c.clinicId,
          aiPaused: true,
          aiPausedUntil: until,
        }),
      ).toEqual({ status: "updated", changed: false, auditRecorded: true });

      expect(
        await run("setClinicSettings", { clinicId: c.clinicId, directLineE164: "+1 415 555 0177" }),
      ).toEqual({ status: "updated", changed: true, auditRecorded: true });

      const view = await run<ClinicBillingView>("getClinicBilling", { clinicId: c.clinicId });
      expect(view.settings).toMatchObject({
        isPaused: true,
        pausedUntil: until,
        // The clinic sees the team, not the administrator's address.
        pausedByLabel: "healdesk support",
        directLineE164: "+14155550177",
      });

      const events = await eventsFor("clinic_settings_set", "clinicSlug", c.slug);
      expect(events.map((e) => e.metadata)).toEqual([
        { clinicSlug: c.slug, fields: ["aiPaused"], aiPaused: true },
        { clinicSlug: c.slug, fields: ["directLineE164"], directLineSet: true },
      ]);
      expect(JSON.stringify(events)).not.toContain("4155550177");
      const audit = await auditRows(c.clinicId, "clinic_settings");
      expect(JSON.stringify(audit)).not.toContain("4155550177");
      expect(audit.filter((row) => row.action === "update")).toHaveLength(2);

      // Resume clears the pause, once.
      expect(
        await run("setClinicSettings", { clinicId: c.clinicId, aiPaused: false }),
      ).toMatchObject({ changed: true });
      expect(
        await run("setClinicSettings", { clinicId: c.clinicId, aiPaused: false }),
      ).toMatchObject({ changed: false });
    });

    test("refused: nothing to change, a pause end that is not a date, an end without a pause, the published number", async () => {
      const c = await seedClinic("ob-settings-bad");
      expect(await run("setClinicSettings", { clinicId: c.clinicId })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/Nothing to change/),
      });
      // Not a date, and dates with no zone, which this server would read in
      // its own zone: refused before anything is written.
      for (const aiPausedUntil of ["soon", "2026-10-10T14:00", "2026-10-11", 1791640800000]) {
        expect(
          await run("setClinicSettings", { clinicId: c.clinicId, aiPaused: true, aiPausedUntil }),
        ).toMatchObject({ status: "error", message: expect.stringMatching(/with its zone/) });
      }
      expect(
        await run("setClinicSettings", {
          clinicId: c.clinicId,
          aiPausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
        }),
      ).toEqual({
        status: "error",
        message: "A pause's end is chosen when pausing the assistant.",
      });
      expect(
        await run("setClinicSettings", { clinicId: c.clinicId, directLineE164: 4155550100 }),
      ).toMatchObject({ status: "error" });
      await getMigratorPool().query(`update clinics set published_phone_e164 = $2 where id = $1`, [
        c.clinicId,
        "+14155550100",
      ]);
      expect(
        await run("setClinicSettings", { clinicId: c.clinicId, directLineE164: "+14155550100" }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/would loop/) });
      expect(await eventsFor("clinic_settings_set", "clinicSlug", c.slug)).toEqual([]);
    });
  });

  describe("setDepositSettings", () => {
    test("deposits.ts decides: refused on without a connected account; a hold change is audited once", async () => {
      const c = await seedClinic("ob-deposits");
      expect(
        await run("setDepositSettings", { clinicId: c.clinicId, depositsEnabled: true }),
      ).toEqual({
        status: "error",
        message:
          "Connect your Stripe account before turning deposits on: deposits are paid straight into it.",
      });
      expect(
        await run("setDepositSettings", { clinicId: c.clinicId, depositHoldMinutes: 90 }),
      ).toEqual({ status: "updated", changed: true, auditRecorded: true });
      expect(
        await run("setDepositSettings", { clinicId: c.clinicId, depositHoldMinutes: 90 }),
      ).toEqual({ status: "updated", changed: false, auditRecorded: true });
      expect(await eventsFor("deposit_settings_set", "clinicSlug", c.slug)).toEqual([
        expect.objectContaining({
          metadata: { clinicSlug: c.slug, fields: ["depositHoldMinutes"] },
        }),
      ]);
      expect(
        await run("setDepositSettings", { clinicId: c.clinicId, depositHoldMinutes: 10 }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/30 to 1440/) });
      expect(
        await run("setDepositSettings", { clinicId: c.clinicId, bookChatWithoutDeposit: "yes" }),
      ).toMatchObject({ status: "error" });
      expect(await run("setDepositSettings", { clinicId: c.clinicId })).toMatchObject({
        status: "error",
        message: "Nothing to change.",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Stripe Connect
  // ---------------------------------------------------------------------------

  describe("Stripe Connect", () => {
    beforeEach(() => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_ops_billing");
      vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test_ops_billing");
      vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    });

    test("issueStripeConnectLink returns the link once, never audits it, refuses a repeat inside the replay window, and a later one cancels the old", async () => {
      const c = await seedClinic("ob-connect-link");
      __setStripeForTests(createStripeFake().stripe);

      const issued = await run("issueStripeConnectLink", { clinicId: c.clinicId });
      expect(issued).toMatchObject({
        status: "issued",
        expiresAt: "2026-10-10 12:15 UTC",
        auditRecorded: true,
      });
      const link = new URL(issued.url as string);
      expect(`${link.origin}${link.pathname}`).toBe("https://connect.stripe.com/oauth/authorize");
      expect(link.searchParams.get("client_id")).toBe("ca_test_ops_billing");

      const events = await eventsFor("stripe_connect_link_issued", "clinicId", c.clinicId);
      expect(events.map((e) => e.metadata)).toEqual([
        { clinicId: c.clinicId, expiresInMinutes: 15 },
      ]);
      expect(JSON.stringify(events)).not.toContain(link.searchParams.get("state")!);

      // A replayed or double-sent request: refused, and no second link minted.
      const again = await run("issueStripeConnectLink", { clinicId: c.clinicId });
      expect(again).toMatchObject({ status: "error", reason: "recently_issued" });
      expect(again.message).toBe(
        "A Connect link for this clinic was issued at 2026-10-10 12:00 UTC. It works until 2026-10-10 12:15 UTC and is shown only once. A new one can be issued from 2026-10-10 12:06 UTC, and it cancels any earlier link not yet used.",
      );
      const states = async () =>
        (
          await getMigratorPool().query<{ expires_at: Date }>(
            `select expires_at from stripe_connect_states where target_clinic_id = $1 order by created_at`,
            [c.clinicId],
          )
        ).rows;
      expect(await states()).toHaveLength(1);

      // Still refused at the window's last second, which allows the two
      // hosts' clocks a minute's disagreement on top of the 300 seconds.
      vi.setSystemTime(new Date(NOW.getTime() + 359_000));
      expect(await run("issueStripeConnectLink", { clinicId: c.clinicId })).toMatchObject({
        reason: "recently_issued",
      });

      // Past it, a new link is minted and the old one expires.
      vi.setSystemTime(new Date(NOW.getTime() + 361_000));
      expect(await run("issueStripeConnectLink", { clinicId: c.clinicId })).toMatchObject({
        status: "issued",
      });
      const [first, second] = await states();
      expect(first!.expires_at.getTime()).toBe(NOW.getTime() + 361_000);
      expect(second!.expires_at.getTime()).toBe(NOW.getTime() + 361_000 + 15 * 60_000);
    });

    test("a link the clinic has already opened does not reopen the window for a replayed request", async () => {
      const c = await seedClinic("ob-connect-opened");
      __setStripeForTests(createStripeFake().stripe);
      expect(await run("issueStripeConnectLink", { clinicId: c.clinicId })).toMatchObject({
        status: "issued",
      });
      // The clinic opened it and declined on Stripe's page: the state is spent.
      await getMigratorPool().query(
        `update stripe_connect_states set used_at = $2 where target_clinic_id = $1`,
        [c.clinicId, new Date(NOW.getTime() + 60_000)],
      );

      vi.setSystemTime(new Date(NOW.getTime() + 120_000));
      const replayed = await run("issueStripeConnectLink", { clinicId: c.clinicId });
      expect(replayed).toMatchObject({ status: "error", reason: "recently_issued" });
      expect(replayed.message).toMatch(/It has been opened already\./);
      const { rows } = await getMigratorPool().query(
        `select 1 from stripe_connect_states where target_clinic_id = $1`,
        [c.clinicId],
      );
      expect(rows).toHaveLength(1);
      expect(await eventsFor("stripe_connect_link_issued", "clinicId", c.clinicId)).toHaveLength(1);
    });

    test("issueStripeConnectLink is refused while the clinic is connected", async () => {
      const c = await seedClinic("ob-connect-on");
      await connectAccount(c.clinicId, "acct_1Already");
      expect(await run("issueStripeConnectLink", { clinicId: c.clinicId })).toMatchObject({
        status: "error",
        reason: "already_connected",
      });
      expect(await eventsFor("stripe_connect_link_issued", "clinicId", c.clinicId)).toEqual([]);
    });

    test("disconnectStripeConnect runs the cascade with the operator's label and source ops; a replay finds nothing connected", async () => {
      const c = await seedClinic("ob-connect-off");
      await connectAccount(c.clinicId, "acct_1Disconnect");
      const fake = createStripeFake({
        "oauth.deauthorize": (params: unknown) => ({
          stripe_user_id: (params as { stripe_user_id: string }).stripe_user_id,
        }),
      });
      __setStripeForTests(fake.stripe);

      expect(await run("disconnectStripeConnect", { clinicId: c.clinicId })).toEqual({
        status: "disconnected",
        deauthorized: true,
        shared: false,
        cancelledLinks: 0,
        paidLinks: 0,
        uncheckedLinks: 0,
        auditRecorded: true,
      });
      const { rows } = await getMigratorPool().query<{ acct: string | null; off: Date | null }>(
        `select stripe_connect_account_id as acct, stripe_connect_disconnected_at as off from clinics where id = $1`,
        [c.clinicId],
      );
      expect(rows[0]).toEqual({ acct: null, off: NOW });
      expect((await auditRows(c.clinicId, "clinic_stripe_connect"))[0]?.metadata).toMatchObject({
        connected: false,
        source: "ops",
      });
      expect(await eventsFor("stripe_connect_disconnected", "clinicSlug", c.slug)).toHaveLength(1);

      expect(await run("disconnectStripeConnect", { clinicId: c.clinicId })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/nothing to disconnect/),
      });
      expect(fake.callsTo("oauth.deauthorize")).toHaveLength(1);
      expect(await eventsFor("stripe_connect_disconnected", "clinicSlug", c.slug)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Parked events
  // ---------------------------------------------------------------------------

  describe("replaying parked events", () => {
    test("replayBillingEvent re-runs a parked event, audits a digest of its id, and a replay finds it no longer parked", async () => {
      const eventId = "evt_ops_replay_1";
      await getMigratorPool().query(
        `insert into billing_events (stripe_event_id, type, outcome, failures, error, payload)
         values ($1, 'customer.created', 'dead_letter', 3, 'Error: boom', $2)`,
        [eventId, JSON.stringify({ id: eventId, type: "customer.created", data: { object: {} } })],
      );
      expect(await run("replayBillingEvent", { eventId })).toEqual({
        status: "replayed",
        outcome: "ignored",
        auditRecorded: true,
      });
      const ref = createHash("sha256").update(eventId).digest("hex");
      const events = await eventsFor("billing_event_replayed", "eventRef", ref);
      expect(events.map((e) => e.metadata)).toEqual([
        { eventRef: ref, type: "customer.created", outcome: "ignored" },
      ]);
      expect(JSON.stringify(events)).not.toContain(eventId);

      expect(await run("replayBillingEvent", { eventId })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/not parked/),
      });
      expect(await eventsFor("billing_event_replayed", "eventRef", ref)).toHaveLength(1);
    });

    test("replayBillingEvent refuses an id that is not Stripe's, and an event that never parked", async () => {
      for (const eventId of ["not-an-event", "evt_", "evt_x; drop table", undefined]) {
        expect(await run("replayBillingEvent", { eventId })).toEqual({
          status: "error",
          message: "That is not a Stripe event id.",
        });
      }
      expect(await run("replayBillingEvent", { eventId: "evt_never_seen" })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/not parked/),
      });
    });

    test("replayConnectEvent fetches the event from the clinic's account and applies it once; a failed fetch leaves it parked", async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_ops_billing");
      const pool = getMigratorPool();
      for (const id of ["evt_ops_connect_1", "evt_ops_connect_2"]) {
        await pool.query(
          `insert into stripe_connect_events (stripe_event_id, type, account, outcome, failures, error)
           values ($1, 'account.updated', 'acct_1Replay', 'dead_letter', 3, 'internal_error')`,
          [id],
        );
      }
      const fake = createStripeFake({
        "events.retrieve": (id: unknown) => {
          if (id === "evt_ops_connect_2") throw new Error("Stripe is down");
          return {
            id,
            type: "account.updated",
            account: "acct_1Replay",
            livemode: false,
            created: s(NOW),
            data: { object: {} },
          };
        },
      });
      __setStripeForTests(fake.stripe);

      expect(await run("replayConnectEvent", { eventId: "evt_ops_connect_1" })).toEqual({
        status: "replayed",
        outcome: "ignored",
        auditRecorded: true,
      });
      expect(fake.callsTo("events.retrieve")[0]!.args[2]).toMatchObject({
        stripeAccount: "acct_1Replay",
      });
      expect(await run("replayConnectEvent", { eventId: "evt_ops_connect_1" })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/not parked/),
      });

      const failed = await run("replayConnectEvent", { eventId: "evt_ops_connect_2" });
      expect(failed).toMatchObject({
        status: "error",
        message: expect.stringMatching(/still on the queue/),
      });
      const { rows } = await pool.query<{ outcome: string }>(
        `select outcome from stripe_connect_events where stripe_event_id = 'evt_ops_connect_2'`,
      );
      expect(rows[0]!.outcome).toBe("dead_letter");
      const ref = createHash("sha256").update("evt_ops_connect_2").digest("hex");
      expect(
        (await eventsFor("connect_event_replayed", "eventRef", ref))[0]?.metadata,
      ).toMatchObject({ outcome: "failed", type: "account.updated" });
    });
  });

  // ---------------------------------------------------------------------------
  // Refunds and auto-renew
  // ---------------------------------------------------------------------------

  /** A started monthly clinic with its first plan invoice paid in a stateful Stripe. */
  async function seedStarted(label: string): Promise<{
    clinicId: string;
    slug: string;
    world: StripeWorld;
  }> {
    const c = await seedClinic(label);
    const ids = await seedEntitled(c.clinicId, {
      planId: "web-voice",
      boughtPlanId: "web-voice",
      planStartedAt: STARTED,
      planStartAppliedAt: STARTED,
      channelRows: [
        { channel: "web", readyAt: STARTED, liveAt: STARTED, firstAnswerAt: STARTED },
        { channel: "voice", readyAt: STARTED, liveAt: STARTED, firstAnswerAt: STARTED },
      ],
    });
    const world = createStripeWorld({
      customerId: ids.stripeCustomerId!,
      subscriptionId: ids.stripeSubscriptionId!,
      items: [{ lookupKey: "healdesk_web-voice_month_89700", quantity: 1 }],
      periodStart: s(STARTED),
      periodEnd: s(PERIOD_END),
      customerDefaultPm: "pm_customer",
      nowSeconds: s(NOW),
    });
    const first = world.addPaidSubscriptionInvoice({
      created: s(STARTED),
      lines: [
        {
          lookupKey: "healdesk_web-voice_month_89700",
          amount: 89_700,
          periodStart: s(STARTED),
          periodEnd: s(PERIOD_END),
        },
      ],
    });
    await inTenant(c.clinicId, (client) =>
      client.query(`update entitlements set first_plan_invoice_id = $2 where clinic_id = $1`, [
        c.clinicId,
        first.id,
      ]),
    );
    __setStripeForTests(world.stripe);
    return { clinicId: c.clinicId, slug: c.slug, world };
  }

  describe("refunds and auto-renew", () => {
    test("previewRefund then commitRefund: the typed amount must match, the refund is audited, and a replay is refused because refunds never stack", async () => {
      const { clinicId, slug, world } = await seedStarted("ob-refund");
      expect(await run("previewRefund", { clinicId, kind: "first_period_cancel" })).toEqual({
        status: "ok",
        kind: "first_period_cancel",
        amountCents: 89_700,
        cancelsPlan: true,
        planStartedOn: "2026-10-07",
        windowEndsOn: "2026-10-21",
      });
      expect(await auditRows(clinicId, "entitlements")).toContainEqual(
        expect.objectContaining({
          action: "read",
          metadata: { purpose: "refund_preview", kind: "first_period_cancel" },
        }),
      );

      expect(
        await run("commitRefund", {
          clinicId,
          kind: "first_period_cancel",
          confirmAmountCents: 50_000,
          reason: "Asked to cancel in the first week",
        }),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/Preview it again/) });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(0);

      const args = {
        clinicId,
        kind: "first_period_cancel",
        confirmAmountCents: 89_700,
        reason: "Asked to cancel in the first week",
      };
      expect(await run("commitRefund", args)).toEqual({
        status: "refunded",
        amountCents: 89_700,
        refundedAt: NOW.toISOString(),
        isCancelRequested: true,
        auditRecorded: true,
      });
      expect((await rowOf(clinicId)).firstPeriodRefundedAt).toEqual(NOW);
      expect(await eventsFor("billing_refund_committed", "clinicSlug", slug)).toEqual([
        expect.objectContaining({
          metadata: {
            clinicSlug: slug,
            kind: "first_period_cancel",
            amountCents: 89_700,
            isCancelRequested: true,
          },
        }),
      ]);

      expect(await run("commitRefund", args)).toMatchObject({
        status: "refused",
        message: expect.stringMatching(/don't stack/),
      });
      expect(world.fake.callsTo("refunds.create")).toHaveLength(1);
      expect(await eventsFor("billing_refund_committed", "clinicSlug", slug)).toHaveLength(1);
    });

    test("refund validation: the kind, a whole positive amount and a reason are required", async () => {
      const c = await seedClinic("ob-refund-bad");
      expect(await run("previewRefund", { clinicId: c.clinicId, kind: "setup_fee" })).toMatchObject(
        {
          status: "error",
        },
      );
      for (const confirmAmountCents of [0, -5, 12.5, "89700", undefined]) {
        expect(
          await run("commitRefund", {
            clinicId: c.clinicId,
            kind: "guarantee",
            confirmAmountCents,
            reason: "Guarantee",
          }),
        ).toMatchObject({ status: "error", message: expect.stringMatching(/amount/) });
      }
      expect(
        await run("commitRefund", {
          clinicId: c.clinicId,
          kind: "guarantee",
          confirmAmountCents: 100,
        }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/reason/) });
      expect(
        await run("commitRefund", {
          clinicId: c.clinicId,
          kind: "guarantee",
          confirmAmountCents: 100,
          reason: "x".repeat(600),
        }),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/500 characters/) });
    });

    test("a refund Stripe does not complete is audited as failed, and the sentence says to check Stripe first", async () => {
      const { clinicId, slug, world } = await seedStarted("ob-refund-failed");
      world.fake.on("refunds.create", () => {
        throw Object.assign(new Error("Stripe is down"), {
          type: "StripeAPIError",
          statusCode: 500,
        });
      });
      expect(
        await run("commitRefund", {
          clinicId,
          kind: "first_period_cancel",
          confirmAmountCents: 89_700,
          reason: "Asked to cancel in the first week",
        }),
      ).toEqual({
        status: "failed",
        message:
          "Stripe didn't complete the refund. Check the payments in Stripe before trying again: a retry reuses any part that went through.",
      });
      expect((await rowOf(clinicId)).firstPeriodRefundedAt).toBeNull();
      expect(await eventsFor("billing_refund_failed", "clinicSlug", slug)).toEqual([
        expect.objectContaining({ metadata: { clinicSlug: slug, kind: "first_period_cancel" } }),
      ]);
      expect(await eventsFor("billing_refund_committed", "clinicSlug", slug)).toEqual([]);
    });

    test("setAutoRenew on the clinic's behalf stamps cancel_at and is audited; a repeat is answered from the record and puts nothing on it twice", async () => {
      const { clinicId, slug, world } = await seedStarted("ob-renew");
      const refundDueAlerts = () =>
        (notifyOps.mock.calls as unknown[][]).filter(
          (call) => call[0] === "first_period_refund_due",
        );
      const notes = async (reason: string) =>
        inTenant(
          clinicId,
          async (c) =>
            (
              await c.query(
                `select id from billing_transitions where clinic_id = $1 and reason = $2`,
                [clinicId, reason],
              )
            ).rows,
        );

      expect(await run("setAutoRenew", { clinicId, on: false })).toEqual({
        status: "ok",
        closesOn: "2026-11-07",
        changed: true,
        auditRecorded: true,
      });
      expect((await rowOf(clinicId)).cancelAt).toEqual(PERIOD_END);
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(1);
      expect(await eventsFor("billing_auto_renew_set", "clinicSlug", slug)).toEqual([
        expect.objectContaining({ metadata: { clinicSlug: slug, on: false } }),
      ]);
      // Inside the first 14 days, so ops hear that a refund is due.
      expect(refundDueAlerts()).toEqual([["first_period_refund_due", { clinicId }]]);
      expect(await notes("auto_renew_off")).toHaveLength(1);

      // A double click, or the same request replayed inside the envelope's
      // window: already off, so Stripe is not asked and nothing is recorded.
      const stripeCalls = world.fake.calls.length;
      expect(await run("setAutoRenew", { clinicId, on: false })).toEqual({
        status: "ok",
        closesOn: "2026-11-07",
        changed: false,
        auditRecorded: true,
      });
      expect(world.fake.calls).toHaveLength(stripeCalls);
      expect(await eventsFor("billing_auto_renew_set", "clinicSlug", slug)).toHaveLength(1);
      expect(refundDueAlerts()).toHaveLength(1);
      expect(await notes("auto_renew_off")).toHaveLength(1);

      // Back on is a change, and goes to Stripe.
      expect(await run("setAutoRenew", { clinicId, on: true })).toEqual({
        status: "ok",
        closesOn: null,
        changed: true,
        auditRecorded: true,
      });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(2);
      expect((await rowOf(clinicId)).cancelAt).toBeNull();
      expect(await run("setAutoRenew", { clinicId, on: true })).toMatchObject({ changed: false });
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(2);
      expect(await run("setAutoRenew", { clinicId, on: "off" })).toMatchObject({ status: "error" });
    });

    test("setAutoRenew leaves an account it cannot be changed on to stripe-actions' refusal", async () => {
      const c = await seedClinic("ob-renew-ended");
      await seedEntitled(c.clinicId, { planId: "chat-web", planStartedAt: STARTED });
      await withTenant({ clinicId: c.clinicId, actor }, (tx) =>
        transition(tx, "canceled", { actor: "system", reason: "customer.subscription.deleted" }),
      );
      __setStripeForTests(createStripeFake().stripe);
      expect(await run("setAutoRenew", { clinicId: c.clinicId, on: true })).toEqual({
        status: "refused",
        message: "This plan has already ended.",
      });
      expect(await eventsFor("billing_auto_renew_set", "clinicSlug", c.slug)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Support
  // ---------------------------------------------------------------------------

  describe("support operations", () => {
    test("retryBillingRequest re-arms a dead letter in the billing clinic's tenant, refuses one in flight and one that is not this clinic's", async () => {
      const billing = await seedClinic("ob-retry");
      await seedEntitled(billing.clinicId, { planId: "chat-web" });
      const locationId = await seedLocation(billing.clinicId, billing.organizationId);
      const ids = await inTenant(billing.clinicId, async (c) => {
        const dead = await c.query<{ id: string }>(
          `insert into billing_requests (clinic_id, kind, reason, attempts, done_at, outcome, last_error)
           values ($1, 'plan_start', 'first_answer', 10, $2, 'dead_letter', 'stripe:api_error') returning id`,
          [billing.clinicId, STARTED],
        );
        const leased = await c.query<{ id: string }>(
          `insert into billing_requests (clinic_id, kind, channel_key, reason, attempts, lease_until)
           values ($1, 'step_up', 'web', 'first_answer', 1, $2) returning id`,
          [billing.clinicId, new Date(NOW.getTime() + 60_000)],
        );
        return { dead: dead.rows[0]!.id, leased: leased.rows[0]!.id };
      });

      expect(
        await run("retryBillingRequest", { clinicId: locationId, requestId: ids.dead }),
      ).toEqual({ status: "retried", kind: "plan_start", auditRecorded: true });
      const rearmed = await inTenant(
        billing.clinicId,
        async (c) =>
          (
            await c.query(
              `select attempts, done_at, outcome, reason, next_attempt_at, last_error from billing_requests where id = $1`,
              [ids.dead],
            )
          ).rows[0],
      );
      expect(rearmed).toEqual({
        attempts: 0,
        done_at: null,
        outcome: null,
        reason: "ops",
        next_attempt_at: NOW,
        last_error: "stripe:api_error",
      });
      expect(await auditRows(billing.clinicId, "billing_request")).toEqual([
        expect.objectContaining({
          action: "update",
          metadata: { field: "rearm", kind: "plan_start", previousOutcome: "dead_letter" },
        }),
      ]);

      expect(
        await run("retryBillingRequest", { clinicId: billing.clinicId, requestId: ids.leased }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/worker/) });
      expect(
        await run("retryBillingRequest", { clinicId: billing.clinicId, requestId: randomUUID() }),
      ).toMatchObject({
        status: "error",
        message: expect.stringMatching(/No such billing request/),
      });
      const other = await seedClinic("ob-retry-other");
      await seedEntitled(other.clinicId, { planId: "chat-web" });
      expect(
        await run("retryBillingRequest", { clinicId: other.clinicId, requestId: ids.dead }),
      ).toMatchObject({
        status: "error",
        message: expect.stringMatching(/No such billing request/),
      });
      expect(
        await run("retryBillingRequest", { clinicId: billing.clinicId, requestId: "42" }),
      ).toMatchObject({ status: "error" });
    });

    test("liftSuspension lifts once with the reason on record; a replay finds nothing suspended", async () => {
      const c = await seedClinic("ob-lift");
      await seedEntitled(c.clinicId, { planId: "chat-web", planStartedAt: STARTED });
      await withTenant({ clinicId: c.clinicId, actor }, async (tx) => {
        await transition(tx, "past_due", { actor: "system", reason: "invoice.payment_failed" });
        await setGrace(tx.db, c.clinicId, new Date("2026-10-09T00:00:00Z"));
        await transition(tx, "suspended", { actor: "system", reason: "dispute" });
      });

      expect(await run("liftSuspension", { clinicId: c.clinicId })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/reason/),
      });
      expect(
        await run("liftSuspension", {
          clinicId: c.clinicId,
          reason: "Dispute withdrawn by the bank",
        }),
      ).toEqual({ status: "lifted", auditRecorded: true });
      expect((await rowOf(c.clinicId)).status).toBe("active");
      expect(await run("liftSuspension", { clinicId: c.clinicId, reason: "Again" })).toEqual({
        status: "refused",
        message: "This account isn't suspended.",
      });
      expect(await eventsFor("billing_suspension_lifted", "clinicSlug", c.slug)).toHaveLength(1);
    });

    test("extendSetupDeadline names the deadline it extends, so a replay cannot add the days twice", async () => {
      const c = await seedClinic("ob-extend");
      const deadline = new Date("2026-10-20T00:00:00Z");
      await seedEntitled(c.clinicId, { planId: "chat-web", setupDeadlineAt: deadline });

      for (const fromDeadline of [undefined, "2026-10-20", "2026-10-20T00:00:00"]) {
        expect(
          await run("extendSetupDeadline", { clinicId: c.clinicId, days: 7, fromDeadline }),
        ).toMatchObject({ status: "error", message: expect.stringMatching(/which deadline/) });
      }
      const args = { clinicId: c.clinicId, days: 7, fromDeadline: deadline.toISOString() };
      expect(await run("extendSetupDeadline", args)).toEqual({
        status: "extended",
        setupDeadlineAt: "2026-10-27T00:00:00.000Z",
        auditRecorded: true,
      });
      expect(await run("extendSetupDeadline", args)).toEqual({
        status: "refused",
        message:
          "The setup deadline has changed since this was asked, so nothing was extended. Reload to see the new deadline.",
      });
      expect((await rowOf(c.clinicId)).setupDeadlineAt).toEqual(new Date("2026-10-27T00:00:00Z"));
      expect(await eventsFor("setup_deadline_extended", "clinicSlug", c.slug)).toEqual([
        expect.objectContaining({ metadata: { clinicSlug: c.slug, days: 7 } }),
      ]);
      expect(
        await run("extendSetupDeadline", {
          clinicId: c.clinicId,
          days: 45,
          fromDeadline: "2026-10-27T00:00:00.000Z",
        }),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/1 to 30/) });
    });

    test("retryLocationSetup and retryOverageInvoice pass the library's refusals through, and validate the month", async () => {
      const c = await seedClinic("ob-support-misc");
      await seedEntitled(c.clinicId, { planId: "chat-web", planStartedAt: STARTED });
      expect(await run("retryLocationSetup", { clinicId: c.clinicId })).toEqual({
        status: "refused",
        message: "No location is waiting to be set up on this account.",
      });
      for (const windowStart of ["last month", "2026-09-01", undefined]) {
        expect(
          await run("retryOverageInvoice", { clinicId: c.clinicId, windowStart }),
        ).toMatchObject({ status: "error", message: expect.stringMatching(/Which month/) });
      }
      expect(
        await run("retryOverageInvoice", {
          clinicId: c.clinicId,
          windowStart: "2026-09-01T00:00:00.000Z",
        }),
      ).toEqual({ status: "refused", message: "No overage invoice is on record for that month." });
      expect(await eventsFor("billing_location_setup_retried", "clinicSlug", c.slug)).toEqual([]);
      expect(await eventsFor("billing_overage_retried", "clinicSlug", c.slug)).toEqual([]);
    });

    test("retryLocationSetup clears a location Stripe never charged, audited with its outcome; a replay finds nothing waiting", async () => {
      const { clinicId, slug, world } = await seedStarted("ob-location-retry");
      await inTenant(clinicId, (c) =>
        c.query(
          `update entitlements set pending_location_request_id = 'loc-ops-1', pending_location_count = 2 where clinic_id = $1`,
          [clinicId],
        ),
      );

      expect(await run("retryLocationSetup", { clinicId })).toEqual({
        status: "cleared",
        auditRecorded: true,
      });
      expect(await rowOf(clinicId)).toMatchObject({
        locations: 1,
        pendingLocationRequestId: null,
      });
      expect(await eventsFor("billing_location_setup_retried", "clinicSlug", slug)).toEqual([
        expect.objectContaining({ metadata: { clinicSlug: slug, outcome: "cleared" } }),
      ]);

      expect(await run("retryLocationSetup", { clinicId })).toEqual({
        status: "refused",
        message: "No location is waiting to be set up on this account.",
      });
      expect(await eventsFor("billing_location_setup_retried", "clinicSlug", slug)).toHaveLength(1);
      // It never charges.
      expect(world.fake.callsTo("subscriptions.update")).toHaveLength(0);
      expect(world.fake.callsTo("invoices.pay")).toHaveLength(0);
    });

    test("retryOverageInvoice invoices a failed month now, audited with its outcome; a replay finds it invoiced", async () => {
      const yearStart = new Date("2026-08-07T00:00:00Z");
      const month = new Date("2026-09-07T00:00:00Z");
      const open = new Date("2026-10-07T00:00:00Z");
      const c = await seedClinic("ob-overage-retry");
      const ids = await seedEntitled(c.clinicId, {
        planId: "web-voice",
        interval: "year",
        planStartedAt: yearStart,
      });
      await inTenant(c.clinicId, async (client) => {
        await client.query(
          `update entitlements set current_period_start = $2, current_period_end = $3 where clinic_id = $1`,
          [c.clinicId, open, new Date("2026-11-07T00:00:00Z")],
        );
        await client.query(
          `insert into usage_events
             (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at,
              window_start, included, used_before, over_allowance)
           values ($1, $1, 'chat_conversations', 'web_chat', $2, 3, $3, $3, 1000, 1000, 3)`,
          [c.clinicId, `ref-${randomUUID()}`, month],
        );
        // As the 05 UTC run left it when Stripe failed.
        await client.query(
          `insert into overage_invoices (clinic_id, window_start, window_end, chat_units, amount_cents, status, error)
           values ($1, $2, $3, 3, 90, 'failed', 'api_error:500')`,
          [c.clinicId, month, open],
        );
      });
      const world = createStripeWorld({
        customerId: ids.stripeCustomerId!,
        subscriptionId: ids.stripeSubscriptionId!,
        items: [{ lookupKey: "healdesk_web-voice_year_860400" }],
        periodStart: s(yearStart),
        periodEnd: s(new Date("2027-08-07T00:00:00Z")),
        customerDefaultPm: "pm_customer",
        nowSeconds: s(NOW),
      });
      __setStripeForTests(world.stripe);

      const args = { clinicId: c.clinicId, windowStart: month.toISOString() };
      const retried = await run("retryOverageInvoice", args);
      const [ledger] = await inTenant(
        c.clinicId,
        async (client) =>
          (
            await client.query<{ status: string; amount_cents: number }>(
              `select status, amount_cents from overage_invoices where clinic_id = $1`,
              [c.clinicId],
            )
          ).rows,
      );
      expect(ledger).toMatchObject({ status: "invoiced" });
      expect(retried).toEqual({
        status: "invoiced",
        amountCents: ledger!.amount_cents,
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
        auditRecorded: true,
      });
      expect(await eventsFor("billing_overage_retried", "clinicSlug", c.slug)).toEqual([
        expect.objectContaining({ metadata: { clinicSlug: c.slug, outcome: "invoiced" } }),
      ]);

      expect(await run("retryOverageInvoice", args)).toEqual({
        status: "refused",
        message: "That month's overage is already invoiced.",
      });
      expect(world.fake.callsTo("invoices.create")).toHaveLength(1);
      expect(await eventsFor("billing_overage_retried", "clinicSlug", c.slug)).toHaveLength(1);
    });

    test("closeUnfinishedSetup needs the confirmation, refuses what the worker would skip, records once on the billing clinic", async () => {
      const billing = await seedClinic("ob-close");
      await seedEntitled(billing.clinicId, {
        planId: "chat-web",
        channelRows: [{ channel: "web", readyAt: STARTED }],
      });
      const locationId = await seedLocation(billing.clinicId, billing.organizationId);

      expect(await run("closeUnfinishedSetup", { clinicId: locationId })).toMatchObject({
        status: "error",
        message: expect.stringMatching(/Tick the box/),
      });
      expect(
        await run("closeUnfinishedSetup", { clinicId: locationId, confirm: "true" }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/Tick the box/) });

      expect(await run("closeUnfinishedSetup", { clinicId: locationId, confirm: true })).toEqual({
        status: "recorded",
        isNew: true,
        isSwitchOn: false,
        auditRecorded: true,
      });
      const requests = async () =>
        inTenant(
          billing.clinicId,
          async (c) =>
            (await c.query(`select clinic_id, kind, reason from billing_requests`, [])).rows,
        );
      expect(await requests()).toEqual([
        { clinic_id: billing.clinicId, kind: "close_setup", reason: "ops" },
      ]);
      expect(await auditRows(locationId, "billing_request")).toEqual([
        expect.objectContaining({
          action: "create",
          metadata: { kind: "close_setup", reason: "ops" },
        }),
      ]);

      // A replay: the request is already there, and nothing more is recorded.
      expect(await run("closeUnfinishedSetup", { clinicId: locationId, confirm: true })).toEqual({
        status: "recorded",
        isNew: false,
        isSwitchOn: false,
        auditRecorded: true,
      });
      expect(await requests()).toHaveLength(1);
      const slug = (
        await getMigratorPool().query<{ slug: string }>(`select slug from clinics where id = $1`, [
          locationId,
        ])
      ).rows[0]!.slug;
      expect(await eventsFor("billing_setup_closure_requested", "clinicSlug", slug)).toHaveLength(
        1,
      );
    });

    test("closeUnfinishedSetup is refused once a channel is live or the plan has started", async () => {
      const live = await seedClinic("ob-close-live");
      await seedEntitled(live.clinicId, {
        planId: "chat-web",
        channelRows: [{ channel: "web", readyAt: STARTED, liveAt: STARTED }],
      });
      expect(
        await run("closeUnfinishedSetup", { clinicId: live.clinicId, confirm: true }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/live/) });

      const started = await seedClinic("ob-close-started");
      await seedEntitled(started.clinicId, { planId: "chat-web", planStartedAt: STARTED });
      expect(
        await run("closeUnfinishedSetup", { clinicId: started.clinicId, confirm: true }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/plan has started/) });
      for (const clinicId of [live.clinicId, started.clinicId]) {
        const rows = await inTenant(
          clinicId,
          async (c) => (await c.query(`select id from billing_requests`, [])).rows,
        );
        expect(rows).toEqual([]);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F1: setConnectionPhiBasis
  // ---------------------------------------------------------------------------

  describe("setConnectionPhiBasis (F1)", () => {
    test("records the basis against a real connection, with and without a note, under the audit key remark", async () => {
      const c = await seedClinic("ob-phi-basis");
      const connectionId = await inTenant(c.clinicId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into provider_connections
             (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
           values ($1, 'test-calendar', 'active', 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
          [c.clinicId],
        );
        return rows[0]!.id;
      });

      // Without a note: the audit write used to throw on the key `note` and
      // roll the basis back, which ops.test.ts never reached.
      expect(
        await run("setConnectionPhiBasis", {
          clinicId: c.clinicId,
          connectionId,
          basis: "practice_account",
        }),
      ).toEqual({ status: "updated", auditRecorded: true });
      // With one: it used to be refused as patient details, whatever it said.
      expect(
        await run("setConnectionPhiBasis", {
          clinicId: c.clinicId,
          connectionId,
          basis: "vendor_baa",
          note: "Vendor BAA countersigned, ref 2026-17",
        }),
      ).toEqual({ status: "updated", auditRecorded: true });

      const basis = await inTenant(
        c.clinicId,
        async (client) =>
          (
            await client.query<{ phi_basis: string }>(
              `select phi_basis from provider_connections where id = $1`,
              [connectionId],
            )
          ).rows[0]!.phi_basis,
      );
      expect(basis).toBe("vendor_baa");
      expect((await auditRows(c.clinicId, "provider_connection")).map((r) => r.metadata)).toEqual([
        { provider: "test-calendar", phiBasis: "practice_account", remark: null },
        {
          provider: "test-calendar",
          phiBasis: "vendor_baa",
          remark: "Vendor BAA countersigned, ref 2026-17",
        },
      ]);

      // A note that does carry a phone number is still refused, with the reason.
      expect(
        await run("setConnectionPhiBasis", {
          clinicId: c.clinicId,
          connectionId,
          basis: null,
          note: "Call the practice on +1 415 555 0123",
        }),
      ).toMatchObject({ status: "error", message: expect.stringMatching(/note looks like/) });
    });
  });
});
