import { randomUUID } from "node:crypto";

import { getPlan, type Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { decideDraft, serialiseDraft } from "@/lib/approvals/drafts";
import type { Executor } from "@/lib/approvals/executors";
import { draftHash, KIND_SPECS, parsePayload } from "@/lib/approvals/kinds";
import { PACKET_KEYS } from "@/lib/approvals/packets";
import { proposeApprovals, runApprovalsProposeJob } from "@/lib/approvals/proposers";
import { getApproval } from "@/lib/approvals/store";
import { drainBillingRequests, startPlan } from "@/lib/billing/requests";
import { opDecideApproval, opListApprovalHistory, opListApprovals } from "@/lib/ops/approval-ops";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { approvalsSource } from "@/lib/ops/inbox/approvals";
import { withTenant } from "@/lib/tenant";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedEntitled, type SeedChannelRow, type SeededClinic } from "./setup/factories";
import { createStripeFake, stripeError } from "./setup/stripe-fake";

/**
 * The approval inbox (ops automation Phase 6, lane P6a; design E6 §2 and §3
 * item 15; owner decisions D17, D18, D21), against the real schema: the
 * add-only record, the proposer over failures the real code leaves behind,
 * the decision running the console's own operation once, and the packet.
 *
 * ops_approvals and ops_approval_events cannot be truncated (that is the
 * point), so each test works on its own subjects and sets any waiting item
 * left by an earlier test aside first (waiting → expired, the one move the
 * trigger allows a migrator too).
 */

vi.setConfig({ testTimeout: 60_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const ACTOR = { type: "service", serviceName: "approvals-test" } as const;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" },
};

const inService = (channel: Channel): SeedChannelRow => ({
  channel,
  readyAt: at(-10 * DAY),
  liveAt: at(-9 * DAY),
  firstAnswerAt: at(-DAY),
});

type Seeded = SeededClinic;

async function setAsideWaiting(): Promise<void> {
  await getMigratorPool().query(`update ops_approvals set status = 'expired', decided_at = now() where status = 'waiting'`);
}

/** A plan start dead-lettered by the worker itself: its tenth attempt fails at Stripe (lib/billing/requests.ts settle). */
async function deadLetteredPlanStart(label: string): Promise<{ clinic: Seeded; requestId: string; epoch: number }> {
  const clinic = await seedClinic(label);
  await seedEntitled(clinic.clinicId, { channelRows: [inService("web")] });
  await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => startPlan(tx, clinic.clinicId));
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update billing_requests set attempts = 9, next_attempt_at = $2 where clinic_id = $1 and kind = 'plan_start'`, [
      clinic.clinicId,
      at(-HOUR),
    ]),
  );
  const fake = createStripeFake({
    "subscriptions.retrieve": () => {
      throw stripeError("api", { statusCode: 503 });
    },
  });
  await drainBillingRequests({ now: NOW, stripe: fake.stripe });
  const row = await requestRow(clinic.clinicId);
  expect(row).toMatchObject({ outcome: "dead_letter", outcome_reason: "attempts_exhausted", attempts: 10 });
  return { clinic, requestId: row.id, epoch: row.epoch };
}

async function requestRow(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string; outcome: string | null; outcome_reason: string | null; attempts: number; epoch: number }>(
      `select id, outcome, outcome_reason, attempts, epoch from billing_requests where clinic_id = $1 and kind = 'plan_start'`,
      [clinicId],
    );
    return rows[0]!;
  });
}

/** A month's overage invoice as the 05 UTC run leaves it when Stripe fails (lib/billing/annual-overage.ts). */
async function failedOverage(clinicId: string, amountCents = 1250): Promise<string> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into overage_invoices (clinic_id, window_start, window_end, chat_units, amount_cents, status, error)
       values ($1, '2026-09-07T00:00:00Z', '2026-10-07T00:00:00Z', 3, $2, 'failed', 'api_error:500') returning id`,
      [clinicId, amountCents],
    );
    return rows[0]!.id;
  });
}

/** A Stripe event parked after its third failure, as recordFailure leaves it (lib/billing/events.ts). */
async function parkedEvent(clinicId: string | null, type = "customer.created"): Promise<string> {
  const eventId = `evt_approvals_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await getMigratorPool().query(
    `insert into billing_events (stripe_event_id, type, outcome, failures, error, resolved_clinic_id, processed_at, payload)
     values ($1, $2, 'dead_letter', 3, 'Error: boom', $3, now(), $4)`,
    [eventId, type, clinicId, JSON.stringify({ id: eventId, type, data: { object: {} } })],
  );
  return eventId;
}

async function itemsFor(subjectPrefix: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    kind: string;
    status: string;
    subject_ref: string;
    subject_clinic_id: string | null;
    outcome_code: string | null;
  }>(`select id, kind, status, subject_ref, subject_clinic_id, outcome_code from ops_approvals where subject_ref like $1 order by proposed_at`, [
    `${subjectPrefix}%`,
  ]);
  return rows;
}

async function eventsOf(approvalId: string) {
  const { rows } = await getMigratorPool().query<{
    event: string;
    actor_label: string;
    ip: string | null;
    user_agent: string | null;
    outcome_code: string | null;
    draft_hash_approved: string | null;
  }>(`select event, actor_label, ip, user_agent, outcome_code, draft_hash_approved from ops_approval_events where approval_id = $1 order by at, event`, [
    approvalId,
  ]);
  return rows;
}

async function securityEvents(event: string, approvalId: string) {
  const { rows } = await getMigratorPool().query<{ actor_label: string; ip_address: string | null; metadata: Record<string, unknown> }>(
    `select actor_label, ip_address, metadata from security_events where event = $1 and metadata->>'approvalId' = $2`,
    [event, approvalId],
  );
  return rows;
}

async function waitingAlerts(): Promise<Record<string, unknown>[]> {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = 'approval_waiting' order by raised_at`,
  );
  return rows.map((r) => r.fields);
}

type Outcome = { status: string; outcomeCode?: string; message?: string | null; auditRecorded?: boolean };

async function decide(args: Record<string, unknown>, options: Parameters<typeof opDecideApproval>[2] = {}, operator = OPERATOR) {
  const out = await opDecideApproval({ codeChecked: true, ...args }, operator, { now: at(60_000), ...options });
  return out;
}

function dataOf(out: { status: number; body: unknown }): Outcome {
  expect(out.status).toBe(200);
  return (out.body as { data: Outcome }).data;
}

describeDb("the approval inbox", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);
  afterAll(async () => {
    await setAsideWaiting();
    await closePools();
  });
  beforeEach(async () => {
    // truncateAll sets aside any waiting item too (tests/setup/db.ts).
    await truncateAll();
  });

  describe("the record cannot be rewritten", () => {
    test("UPDATE, DELETE and TRUNCATE on ops_approval_events are refused for the runtime role and the migrator", async () => {
      const { clinic } = await deadLetteredPlanStart("ap-immutable");
      await proposeApprovals(NOW);
      const [item] = (await opsItemsOfClinic(clinic.clinicId));
      expect(item).toBeDefined();
      const statements = [
        `update ops_approval_events set actor_label = 'someone else' where approval_id = '${item!.id}'`,
        `delete from ops_approval_events where approval_id = '${item!.id}'`,
        `truncate ops_approval_events`,
      ];
      for (const pool of [getAppPool(), getMigratorPool()]) {
        for (const statement of statements) {
          await expect(pool.query(statement), statement).rejects.toThrow();
        }
      }
      expect(await eventsOf(item!.id)).toHaveLength(1);
      // The item itself: never deleted, its proposal fixed, only forward moves.
      for (const pool of [getAppPool(), getMigratorPool()]) {
        await expect(pool.query(`delete from ops_approvals where id = $1`, [item!.id])).rejects.toThrow();
        await expect(pool.query(`truncate ops_approvals cascade`)).rejects.toThrow();
      }
      await expect(
        getMigratorPool().query(`update ops_approvals set payload = '{"eventType":"x"}' where id = $1`, [item!.id]),
      ).rejects.toThrow(/fixed once made/);
      await expect(getAppPool().query(`update ops_approvals set payload = '{}' where id = $1`, [item!.id])).rejects.toThrow();
      await expect(
        getMigratorPool().query(`update ops_approvals set status = 'executed', decided_at = now() where id = $1`, [item!.id]),
      ).rejects.toThrow(/cannot move from waiting to executed/);
    });

    test("a payload refuses an address and a run of digits, and the kind list is closed", async () => {
      const insert = (kind: string, payload: unknown) =>
        getMigratorPool().query(
          `insert into ops_approvals (kind, subject_ref, payload, due_at, urgency, proposed_by)
           values ($1, $2, $3, now() + interval '1 day', 'money', 'approvals-propose')`,
          [kind, `evt_check_${randomUUID().slice(0, 8)}`, JSON.stringify(payload)],
        );
      await expect(insert("billing_event_replay", { eventType: "a@b.example" })).rejects.toThrow(/payload_check/);
      await expect(insert("billing_event_replay", { eventType: "call 415 555 0142" })).rejects.toThrow(/payload_check/);
      await expect(insert("refund", { eventType: "invoice.paid" })).rejects.toThrow(/kind_check/);
      // A uuid and a date are not a run of digits.
      const ok = await insert("billing_event_replay", { id: randomUUID(), on: "2026-10-24T10:00:00.000Z" });
      expect(ok.rowCount).toBe(1);
    });
  });

  describe("the proposer (approvals-propose)", () => {
    test("proposes one item per dead letter the real code left, once, across runs, and runs nothing", async () => {
      const { clinic, requestId, epoch } = await deadLetteredPlanStart("ap-propose");
      const overageId = await failedOverage(clinic.clinicId);
      const eventId = await parkedEvent(clinic.clinicId);

      const first = await proposeApprovals(NOW);
      expect(first.proposed).toBeGreaterThanOrEqual(3);
      const second = await proposeApprovals(at(HOUR));
      expect(second.proposed).toBe(0);

      const items = await opsItemsOfClinic(clinic.clinicId);
      expect(items.map((i) => [i.kind, i.subject_ref, i.status]).sort()).toEqual(
        [
          ["billing_event_replay", eventId, "waiting"],
          ["billing_request_retry", `${requestId}:${epoch}`, "waiting"],
          ["overage_invoice_retry", overageId, "waiting"],
        ].sort(),
      );
      for (const item of items) expect((await eventsOf(item.id)).map((e) => e.event)).toEqual(["proposed"]);
      // Nothing was retried, invoiced or replayed.
      expect(await requestRow(clinic.clinicId)).toMatchObject({ outcome: "dead_letter", epoch });
      const { rows: overage } = await inTenant(clinic.clinicId, (c) =>
        c.query<{ status: string }>(`select status from overage_invoices where id = $1`, [overageId]),
      );
      expect(overage[0]!.status).toBe("failed");
      const { rows: event } = await getMigratorPool().query<{ outcome: string }>(
        `select outcome from billing_events where stripe_event_id = $1`,
        [eventId],
      );
      expect(event[0]!.outcome).toBe("dead_letter");
    });

    test("leaves out the demo clinic and a clinic whose account is closed", async () => {
      const demo = await deadLetteredPlanStart("ap-demo");
      await inTenant(demo.clinic.clinicId, (c) =>
        c.query(`update entitlements set status = 'demo', stripe_subscription_id = null, stripe_customer_id = null where clinic_id = $1`, [
          demo.clinic.clinicId,
        ]),
      );
      const demoEvent = await parkedEvent(demo.clinic.clinicId);
      const closed = await deadLetteredPlanStart("ap-closed");
      await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [closed.clinic.clinicId]);
      await failedOverage(closed.clinic.clinicId);

      await proposeApprovals(NOW);
      expect(await opsItemsOfClinic(demo.clinic.clinicId)).toEqual([]);
      expect(await opsItemsOfClinic(closed.clinic.clinicId)).toEqual([]);
      expect(await itemsFor(demoEvent)).toEqual([]);
    });

    test("is a switched job, off by default", async () => {
      await deadLetteredPlanStart("ap-switch");
      expect(await runApprovalsProposeJob({ now: NOW })).toEqual({ status: "disabled" });
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'approvals-propose'`);
      try {
        expect(await runApprovalsProposeJob({ now: NOW })).toMatchObject({ status: "ok" });
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'approvals-propose'`);
      }
    });

    test("a rejected or expired subject is never proposed again; a new episode is", async () => {
      const { clinic, requestId } = await deadLetteredPlanStart("ap-again");
      await proposeApprovals(NOW);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      expect(dataOf(await decide({ id: item!.id, action: "reject", reasonCode: "not_needed" }))).toMatchObject({ status: "rejected" });
      await proposeApprovals(at(HOUR));
      expect((await opsItemsOfClinic(clinic.clinicId)).map((i) => i.status)).toEqual(["rejected"]);
      // The reconcile re-arms it and it dies again: a new epoch, a new item.
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update billing_requests set epoch = epoch + 1 where id = $1`, [requestId]),
      );
      await proposeApprovals(at(2 * HOUR));
      expect((await opsItemsOfClinic(clinic.clinicId)).map((i) => i.status).sort()).toEqual(["rejected", "waiting"]);
    });

    test("nothing changes by time but waiting → expired: after the window it leaves the list unrun", async () => {
      const { clinic, epoch } = await deadLetteredPlanStart("ap-window");
      await proposeApprovals(NOW);
      const summary = await proposeApprovals(at(8 * DAY));
      expect(summary.expired).toBeGreaterThanOrEqual(1);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      expect(item).toMatchObject({ status: "expired", outcome_code: "window_passed" });
      // The run that finds it past its window expires it before it would remind.
      expect((await eventsOf(item!.id)).map((e) => e.event)).toEqual(["proposed", "expired"]);
      expect(await requestRow(clinic.clinicId)).toMatchObject({ outcome: "dead_letter", epoch });
      // And thirty days on, nothing more: no approval, no execution.
      await proposeApprovals(at(30 * DAY));
      expect((await opsItemsOfClinic(clinic.clinicId)).map((i) => i.status)).toEqual(["expired"]);
    });

    test("an item whose subject went through since leaves the list as no longer needed, unrun", async () => {
      const { clinic, requestId } = await deadLetteredPlanStart("ap-moot");
      await proposeApprovals(NOW);
      await inTenant(clinic.clinicId, (c) =>
        c.query(`update billing_requests set outcome = 'done', outcome_reason = 'started' where id = $1`, [requestId]),
      );
      const summary = await proposeApprovals(at(HOUR));
      expect(summary.resolved).toBe(1);
      expect((await opsItemsOfClinic(clinic.clinicId))[0]).toMatchObject({ status: "expired", outcome_code: "no_longer_needed" });
    });

    test("a money item re-alerts once past due; a legal-clock item every 4 hours at most", async () => {
      const { clinic } = await deadLetteredPlanStart("ap-remind");
      const before = (await waitingAlerts()).length;
      await proposeApprovals(NOW);
      expect(await waitingAlerts()).toHaveLength(before);
      await proposeApprovals(at(25 * HOUR));
      const after = await waitingAlerts();
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toEqual({ kind: "billing_request_retry", count: 1 });
      await proposeApprovals(at(30 * HOUR));
      expect(await waitingAlerts()).toHaveLength(before + 1);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      expect((await eventsOf(item!.id)).filter((e) => e.event === "reminded")).toHaveLength(1);

      // No kind has a legal clock yet: one written straight in, on a parked event.
      await setAsideWaiting();
      const eventId = await parkedEvent(null);
      await getMigratorPool().query(
        `insert into ops_approvals (kind, subject_ref, payload, due_at, urgency, proposed_by, proposed_at)
         values ('billing_event_replay', $1, '{"eventType":"customer.created"}', $2, 'legal_clock', 'approvals-propose', $3)`,
        [eventId, at(DAY), NOW],
      );
      const [legal] = await itemsFor(eventId);
      const reminded = async () => (await eventsOf(legal!.id)).filter((e) => e.event === "reminded").length;
      await proposeApprovals(NOW);
      expect(await reminded()).toBe(1);
      await proposeApprovals(at(HOUR));
      await proposeApprovals(at(3 * HOUR));
      expect(await reminded()).toBe(1);
      await proposeApprovals(at(4 * HOUR));
      expect(await reminded()).toBe(2);
      await proposeApprovals(at(5 * HOUR));
      expect(await reminded()).toBe(2);
      // Still waiting: re-alerting never decides it.
      expect((await getApproval(legal!.id))?.status).toBe("waiting");
    });
  });

  describe("the decision (decideApproval)", () => {
    test("approve runs the console's own retry once and records its outcome, the operator and a security event", async () => {
      const { clinic, epoch } = await deadLetteredPlanStart("ap-approve");
      await proposeApprovals(NOW);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      const out = dataOf(await decide({ id: item!.id, action: "approve", reasonCode: "cause_fixed" }));
      expect(out).toEqual({ status: "executed", outcomeCode: "retried", message: null, auditRecorded: true });
      // The same effect as the Billing tab's Retry: re-armed, a new epoch.
      expect(await requestRow(clinic.clinicId)).toMatchObject({ outcome: null, attempts: 0, epoch: epoch + 1 });
      const { rows: retried } = await getMigratorPool().query(
        `select 1 from security_events where event = 'billing_request_retried' and metadata->>'clinicSlug' = $1`,
        [clinic.slug],
      );
      expect(retried).toHaveLength(1);
      const events = await eventsOf(item!.id);
      expect(events.map((e) => [e.event, e.outcome_code])).toEqual([
        ["proposed", null],
        ["approved", "cause_fixed"],
        ["executed", "retried"],
      ]);
      expect(events[1]).toMatchObject({ actor_label: OPERATOR.email, ip: "203.0.113.9", user_agent: "vitest" });
      expect(events[0]).toMatchObject({ actor_label: "approvals-propose", ip: null, user_agent: null });
      expect(await securityEvents("approval_approved", item!.id)).toEqual([
        expect.objectContaining({
          actor_label: OPERATOR.email,
          ip_address: "203.0.113.9",
          metadata: expect.objectContaining({ kind: "billing_request_retry", outcome: "executed", outcomeCode: "retried", freshCode: true }),
        }),
      ]);
      expect((await getApproval(item!.id))?.status).toBe("executed");

      // A second decision on the same item is refused and runs nothing more.
      for (const action of ["approve", "reject"] as const) {
        const again = dataOf(await decide({ id: item!.id, action, reasonCode: action === "approve" ? "cause_fixed" : "not_needed" }));
        expect(again).toMatchObject({ status: "error", message: expect.stringMatching(/already been decided/) });
      }
      expect(await requestRow(clinic.clinicId)).toMatchObject({ epoch: epoch + 1 });
      expect(await eventsOf(item!.id)).toHaveLength(3);
    });

    test("reject runs nothing", async () => {
      const { clinic, epoch } = await deadLetteredPlanStart("ap-reject");
      await proposeApprovals(NOW);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      expect(dataOf(await decide({ id: item!.id, action: "reject", reasonCode: "handled_elsewhere" }))).toEqual({
        status: "rejected",
        outcomeCode: "handled_elsewhere",
        auditRecorded: true,
      });
      expect(await requestRow(clinic.clinicId)).toMatchObject({ outcome: "dead_letter", epoch });
      expect((await eventsOf(item!.id)).map((e) => e.event)).toEqual(["proposed", "rejected"]);
      expect(await securityEvents("approval_rejected", item!.id)).toHaveLength(1);
    });

    test("a refused operation records failed with its code; a replay of a parked event records executed", async () => {
      const clinic = await seedClinic("ap-refused");
      const eventId = await parkedEvent(clinic.clinicId);
      const goneId = await parkedEvent(clinic.clinicId);
      await proposeApprovals(NOW);
      const [replay] = await itemsFor(eventId);
      const [gone] = await itemsFor(goneId);
      expect(dataOf(await decide({ id: replay!.id, action: "approve", reasonCode: "passing_fault" }))).toEqual({
        status: "executed",
        outcomeCode: "replayed",
        message: null,
        auditRecorded: true,
      });
      // Applied another way after it was proposed: the operation refuses, and the item says so.
      await getMigratorPool().query(`update billing_events set outcome = 'processed' where stripe_event_id = $1`, [goneId]);
      const refused = dataOf(await decide({ id: gone!.id, action: "approve", reasonCode: "passing_fault" }));
      expect(refused).toMatchObject({ status: "failed", outcomeCode: "refused", message: expect.stringMatching(/not parked/) });
      expect((await eventsOf(gone!.id)).map((e) => [e.event, e.outcome_code])).toEqual([
        ["proposed", null],
        ["approved", "passing_fault"],
        ["failed", "refused"],
      ]);
      expect((await getApproval(gone!.id))?.status).toBe("failed");

      // An executor that refuses or throws records failed, never an unrecorded item.
      const another = await parkedEvent(clinic.clinicId);
      await proposeApprovals(at(HOUR));
      const [third] = await itemsFor(another);
      const throwing: Record<string, Executor> = {
        billing_event_replay: async () => {
          throw new Error("boom");
        },
      };
      expect(dataOf(await decide({ id: third!.id, action: "approve", reasonCode: "owner_checked" }, { executors: throwing }))).toMatchObject({
        status: "failed",
        outcomeCode: "threw",
      });
      expect((await getApproval(third!.id))?.status).toBe("failed");
    });

    test("an expired item cannot be approved; a decision without an operator or the fresh-code mark is refused", async () => {
      const { clinic, epoch } = await deadLetteredPlanStart("ap-refuse");
      await proposeApprovals(NOW);
      const [item] = await opsItemsOfClinic(clinic.clinicId);

      const noOperator = await opDecideApproval(
        { id: item!.id, action: "approve", reasonCode: "cause_fixed", codeChecked: true },
        { email: "", request: {} },
        { now: NOW },
      );
      expect(noOperator.status).toBe(401);
      const noMark = dataOf(await opDecideApproval({ id: item!.id, action: "approve", reasonCode: "cause_fixed" }, OPERATOR, { now: NOW }));
      expect(noMark).toMatchObject({ status: "error", message: expect.stringMatching(/authenticator/) });
      expect((await opDecideApproval({ id: item!.id, action: "approve", reasonCode: "because" }, OPERATOR)).status).toBe(400);
      expect((await getApproval(item!.id))?.status).toBe("waiting");

      const late = dataOf(await decide({ id: item!.id, action: "approve", reasonCode: "cause_fixed" }, { now: at(8 * DAY) }));
      expect(late).toMatchObject({ status: "error", message: expect.stringMatching(/window has passed/) });
      expect((await getApproval(item!.id))?.status).toBe("expired");
      expect(await requestRow(clinic.clinicId)).toMatchObject({ outcome: "dead_letter", epoch });
    });

    test("an edited draft is linted again and both hashes are kept (a test-only drafted kind)", async () => {
      // No kind carries a draft yet, so a drafted spec stands in over a parked event.
      const eventId = await parkedEvent(null);
      const draft = serialiseDraft({ subject: "A quick question about your account", body: "Hi team, could you reply with one word?" });
      await getMigratorPool().query(
        `insert into ops_approvals (kind, subject_ref, payload, draft, draft_hash, due_at, urgency, proposed_by, proposed_at)
         values ('billing_event_replay', $1, '{"eventType":"customer.created"}', $2, $3, $4, 'routine', 'approvals-propose', $5)`,
        [eventId, draft, draftHash(draft), at(DAY), NOW],
      );
      const [item] = await itemsFor(eventId);
      const sent: unknown[] = [];
      const specs = { ...KIND_SPECS, billing_event_replay: { ...KIND_SPECS.billing_event_replay, hasDraft: true } };
      const executors: Record<string, Executor> = {
        billing_event_replay: async () => {
          sent.push("sent");
          return { ok: true, outcomeCode: "sent", message: null, auditRecorded: true };
        },
      };
      const refused = dataOf(
        await decide(
          { id: item!.id, action: "approve", reasonCode: "owner_checked", editedDraft: { subject: "Your revenue report", body: "Hi team." } },
          { specs, executors },
        ),
      );
      expect(refused).toMatchObject({ status: "error", message: expect.stringMatching(/cannot go as written/) });
      expect(sent).toEqual([]);
      const edited = { subject: "A quick question about your healdesk account", body: "Hi team, could you reply Yes or No?" };
      expect(
        dataOf(await decide({ id: item!.id, action: "approve", reasonCode: "owner_checked", editedDraft: edited }, { specs, executors })),
      ).toMatchObject({ status: "executed", outcomeCode: "sent" });
      const events = await eventsOf(item!.id);
      expect(events.map((e) => e.event)).toEqual(["edited", "approved", "executed"]);
      const hash = draftHash(serialiseDraft(edited));
      expect(events.find((e) => e.event === "approved")?.draft_hash_approved).toBe(hash);
      expect(hash).not.toBe(draftHash(draft));
      // A kind with no draft takes no edit.
      expect(decideDraft(false, { draft: null, draftHash: null }, edited)).toMatchObject({ ok: false, code: "no_draft_kind" });
    });
  });

  describe("the reads", () => {
    test("the packet carries ids, codes, counts and cents only, and its money words are the catalog's", async () => {
      const { clinic } = await deadLetteredPlanStart("ap-packet");
      await failedOverage(clinic.clinicId, 1250);
      await parkedEvent(clinic.clinicId);
      await proposeApprovals(NOW);
      const out = await opListApprovals({}, OPERATOR, NOW);
      const data = (out.body as { data: { items: { kind: string; clinic: unknown; packet: Record<string, unknown> | null }[]; partial: string[] } }).data;
      const mine = data.items.filter((i) => JSON.stringify(i.clinic).includes(clinic.clinicId));
      expect(mine.map((i) => i.kind).sort()).toEqual(["billing_event_replay", "billing_request_retry", "overage_invoice_retry"]);
      const plan = getPlan("voice-metachat-1000-1000")!;
      for (const item of mine) {
        const packet = item.packet!;
        expect(Object.keys(packet).sort()).toEqual([...PACKET_KEYS].sort());
        // The packet is what the owner reads; the item's ids are ids.
        const text = JSON.stringify(packet);
        expect(text).not.toMatch(/@/);
        expect(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "")).not.toMatch(
          /\d{7,}/,
        );
        expect(packet.stillNeeded).toBe(true);
      }
      const request = mine.find((i) => i.kind === "billing_request_retry")!.packet!;
      expect(Object.keys(request.facts as object).sort()).toEqual(
        ["attempts", "billingStatus", "channel", "interval", "kind", "lastErrorCode", "maxAttempts", "priceCents", "reasonCode", "requestKind", "supersededBy"].sort(),
      );
      expect(request.facts).toMatchObject({ requestKind: "plan_start", attempts: 10, maxAttempts: 10, reasonCode: "attempts_exhausted", lastErrorCode: "stripe:api_error" });
      expect(request.effect).toBe(
        `Starts the package price on the subscription, up to $${plan.monthlyUsd.toLocaleString("en-US")} a month, replacing the $0 line.`,
      );
      expect(request.operation).toBe("retryBillingRequest");
      const overage = mine.find((i) => i.kind === "overage_invoice_retry")!.packet!;
      expect(overage.effect).toMatch(/^Invoices the extra usage for the month from 7 Sep: \$12\.50, charged to the card on file\./);
      expect(overage.facts).toEqual({ kind: "overage_invoice_retry", windowStart: "2026-09-07T00:00:00.000Z", amountCents: 1250, lastErrorCode: "api_error" });
      const event = mine.find((i) => i.kind === "billing_event_replay")!.packet!;
      expect(Object.keys(event.facts as object).sort()).toEqual(["eventType", "failures", "kind", "maxFailures"]);
    });

    test("the history reads the record without drafts; Home shows one plain row per kind", async () => {
      const { clinic } = await deadLetteredPlanStart("ap-history");
      await parkedEvent(clinic.clinicId);
      await parkedEvent(clinic.clinicId);
      // Later than any other test's clock, so this item's events are the newest in the record.
      const later = at(400 * DAY);
      await proposeApprovals(later);
      const [item] = (await opsItemsOfClinic(clinic.clinicId)).filter((i) => i.kind === "billing_request_retry");
      await decide({ id: item!.id, action: "reject", reasonCode: "ask_clinic_first" }, { now: new Date(later.getTime() + 60_000) });
      const out = await opListApprovalHistory({ limit: 200 });
      const events = (out.body as { data: { events: Record<string, unknown>[] } }).data.events;
      // Newest first: the rejection, then the proposal (earlier tests' events are on other items).
      const own = events.filter((e) => e.approvalId === item!.id);
      expect(own.map((e) => e.event)).toEqual(["rejected", "proposed"]);
      expect(own[0]).toMatchObject({ approvalId: item!.id, event: "rejected", actorLabel: OPERATOR.email, outcomeCode: "ask_clinic_first" });
      for (const e of events) expect(Object.keys(e)).not.toContain("draft");
      expect((await opListApprovalHistory({ kind: "refund" })).status).toBe(400);

      const home = await approvalsSource.read({} as never);
      expect(home.rows.map((r) => [r.id, r.count, r.sentence, r.tone, r.button])).toEqual([
        ["approvals:billing_event_replay", 2, "2 Stripe event replays are waiting for your yes.", "warn", { label: "Open approvals", kind: "link", href: "/admin/queues#approvals" }],
      ]);
    });

    test("the three operations are on the closed list; only the decision is mutating", async () => {
      for (const op of ["listApprovals", "decideApproval", "listApprovalHistory"]) expect(isOpName(op), op).toBe(true);
      expect(isMutating("decideApproval")).toBe(true);
      expect(isMutating("listApprovals")).toBe(false);
      expect(isMutating("listApprovalHistory")).toBe(false);
      const listed = await runOperation("listApprovals", { status: "nope" }, OPERATOR);
      expect(listed.status).toBe(400);
      // Through the dispatch, the decision needs the mark too.
      const { clinic } = await deadLetteredPlanStart("ap-dispatch");
      await proposeApprovals(NOW);
      const [item] = await opsItemsOfClinic(clinic.clinicId);
      const out = await runOperation("decideApproval", { id: item!.id, action: "approve", reasonCode: "cause_fixed" }, OPERATOR);
      expect(dataOf(out)).toMatchObject({ status: "error" });
      expect(parsePayload("billing_request_retry", { ...JSON.parse(JSON.stringify((await getApproval(item!.id))!.payload)), extra: 1 })).toBeNull();
    });
  });
});

async function opsItemsOfClinic(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    kind: string;
    status: string;
    subject_ref: string;
    outcome_code: string | null;
  }>(`select id, kind, status, subject_ref, outcome_code from ops_approvals where subject_clinic_id = $1 order by proposed_at, kind`, [clinicId]);
  return rows;
}

