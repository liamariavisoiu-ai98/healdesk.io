import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { BillingRequestKind } from "@/db/schema";
import { decideDraft, serialiseDraft, type Draft } from "@/lib/approvals/drafts";
import type { Executor } from "@/lib/approvals/executors";
import { draftHash, KIND_SPECS, parsePayload } from "@/lib/approvals/kinds";
import { eventEffect } from "@/lib/approvals/packets";
import { proposeApprovals, runApprovalsProposeJob } from "@/lib/approvals/proposers";
import { getApproval } from "@/lib/approvals/store";
import { closeUnfinishedSetup, drainBillingRequests, requestCancelNow, startPlan } from "@/lib/billing/requests";
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
 * add-only record, the proposer over failures the real code leaves behind
 * and only those nothing retries by itself, the decision running the
 * console's own operation once, and the packet.
 *
 * ops_approvals and ops_approval_events cannot be truncated (that is the
 * point), so truncateAll sets any waiting item aside (waiting → expired, the
 * one move the trigger allows a migrator too) and each test reads its own
 * subjects.
 */

vi.setConfig({ testTimeout: 60_000 });

const describeDb = hasTestDatabase ? describe : describe.skip;

const ACTOR = { type: "service", serviceName: "approvals-test" } as const;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
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

async function setAsideWaiting(): Promise<void> {
  await getMigratorPool().query(`update ops_approvals set status = 'expired', decided_at = now() where status = 'waiting'`);
}

async function setJob(name: string, enabled: boolean): Promise<void> {
  await getMigratorPool().query(`update scheduled_jobs set enabled = $2 where name = $1`, [name, enabled]);
}

async function requestRow(clinicId: string, kind: BillingRequestKind) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      id: string;
      outcome: string | null;
      outcome_reason: string | null;
      attempts: number;
      epoch: number;
      done_at: Date | null;
    }>(`select id, outcome, outcome_reason, attempts, epoch, done_at from billing_requests where clinic_id = $1 and kind = $2`, [clinicId, kind]);
    return rows[0]!;
  });
}

/**
 * A billing request the worker itself dead-lettered: recorded through the
 * real recorder, on its tenth attempt, against a Stripe that answers 503 to
 * everything (lib/billing/requests.ts settle).
 */
async function deadLettered(
  kind: "cancel_now" | "close_setup" | "plan_start",
  label: string,
): Promise<{ clinic: SeededClinic; requestId: string; epoch: number }> {
  const clinic = await seedClinic(label);
  // A closure is skipped while a channel is live, so its clinic has none.
  await seedEntitled(clinic.clinicId, kind === "close_setup" ? {} : { channelRows: [inService("web")] });
  await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
    kind === "cancel_now"
      ? requestCancelNow(tx, clinic.clinicId)
      : kind === "close_setup"
        ? closeUnfinishedSetup(tx, clinic.clinicId)
        : startPlan(tx, clinic.clinicId),
  );
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update billing_requests set attempts = 9, next_attempt_at = $2 where clinic_id = $1 and kind = $3`, [
      clinic.clinicId,
      at(-HOUR),
      kind,
    ]),
  );
  const down = () => {
    throw stripeError("api", { statusCode: 503 });
  };
  const fake = createStripeFake({
    "subscriptions.retrieve": down,
    "subscriptions.cancel": down,
    "subscriptions.update": down,
  });
  if (kind === "close_setup") await setJob("setup-closure", true);
  try {
    await drainBillingRequests({ now: NOW, stripe: fake.stripe });
  } finally {
    if (kind === "close_setup") await setJob("setup-closure", false);
  }
  const row = await requestRow(clinic.clinicId, kind);
  expect(row, kind).toMatchObject({ outcome: "dead_letter", attempts: 10 });
  return { clinic, requestId: row.id, epoch: row.epoch };
}

/** A month's overage invoice as the 05 UTC run leaves it (lib/billing/annual-overage.ts). */
async function overageRow(clinicId: string, status: "failed" | "pending"): Promise<string> {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into overage_invoices (clinic_id, window_start, window_end, chat_units, amount_cents, status, error)
       values ($1, '2026-09-07T00:00:00Z', '2026-10-07T00:00:00Z', 3, 1250, $2, $3) returning id`,
      [clinicId, status, status === "failed" ? "api_error:500" : null],
    );
    return rows[0]!.id;
  });
}

/**
 * A Stripe event as recordFailure leaves it (lib/billing/events.ts): parked
 * after its third failure, or `failed` while Stripe still resends it.
 */
async function stripeEvent(
  clinicId: string | null,
  options: { type?: string; outcome?: "dead_letter" | "failed"; failures?: number; parkedAt?: Date } = {},
): Promise<string> {
  const eventId = `evt_approvals_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const type = options.type ?? "customer.created";
  await getMigratorPool().query(
    `insert into billing_events (stripe_event_id, type, outcome, failures, error, resolved_clinic_id, processed_at, payload)
     values ($1, $2, $3, $4, 'Error: boom', $5, $6, $7)`,
    [
      eventId,
      type,
      options.outcome ?? "dead_letter",
      options.failures ?? 3,
      clinicId,
      options.parkedAt ?? at(-HOUR),
      JSON.stringify({ id: eventId, type, data: { object: {} } }),
    ],
  );
  return eventId;
}

async function itemsFor(subjectPrefix: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    kind: string;
    status: string;
    subject_ref: string;
    outcome_code: string | null;
  }>(`select id, kind, status, subject_ref, outcome_code from ops_approvals where subject_ref like $1 order by proposed_at, status`, [
    `${subjectPrefix}%`,
  ]);
  return rows;
}

async function itemsOfClinic(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    kind: string;
    status: string;
    subject_ref: string;
    outcome_code: string | null;
  }>(`select id, kind, status, subject_ref, outcome_code from ops_approvals where subject_clinic_id = $1 order by proposed_at, status`, [
    clinicId,
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
  return opDecideApproval({ codeChecked: true, ...args }, operator, { now: at(MINUTE), ...options });
}

function dataOf(out: { status: number; body: unknown }): Outcome {
  expect(out.status).toBe(200);
  return (out.body as { data: Outcome }).data;
}

const WORKER_OFF = "The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";

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
      const { clinic } = await deadLettered("cancel_now", "ap-immutable");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
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
      // A decision time, once set, stays.
      expect(dataOf(await decide({ id: item!.id, action: "reject", reasonCode: "not_needed" }))).toMatchObject({ status: "rejected" });
      await expect(
        getMigratorPool().query(`update ops_approvals set decided_at = now() - interval '1 day' where id = $1`, [item!.id]),
      ).rejects.toThrow(/decision time is fixed/);
    });

    test("the four guard triggers fire always, so session_replication_role cannot skip them", async () => {
      const { rows } = await getMigratorPool().query<{ tgname: string; tgenabled: string }>(
        `select tgname, tgenabled from pg_trigger
          where tgname in ('ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')
          order by tgname`,
      );
      expect(rows).toEqual([
        { tgname: "ops_approval_events_add_only", tgenabled: "A" },
        { tgname: "ops_approval_events_no_truncate", tgenabled: "A" },
        { tgname: "ops_approvals_guard", tgenabled: "A" },
        { tgname: "ops_approvals_no_truncate", tgenabled: "A" },
      ]);
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
      const ok = await insert("billing_event_replay", { id: randomUUID(), on: "2026-10-24T10:00:00.000Z" });
      expect(ok.rowCount).toBe(1);
    });
  });

  describe("the proposer (approvals-propose)", () => {
    test("proposes a dead cancellation, a dead closure and a parked event naming a clinic, once, and runs nothing", async () => {
      const cancel = await deadLettered("cancel_now", "ap-propose");
      const close = await deadLettered("close_setup", "ap-propose-close");
      const eventId = await stripeEvent(cancel.clinic.clinicId);

      const first = await proposeApprovals(NOW);
      expect(first.proposed).toBe(3);
      expect((await proposeApprovals(at(HOUR))).proposed).toBe(0);

      const items = [...(await itemsOfClinic(cancel.clinic.clinicId)), ...(await itemsOfClinic(close.clinic.clinicId))];
      expect(items.map((i) => [i.kind, i.subject_ref.split(":")[0], i.status]).sort()).toEqual(
        [
          ["billing_event_replay", eventId, "waiting"],
          ["billing_request_retry", cancel.requestId, "waiting"],
          ["billing_request_retry", close.requestId, "waiting"],
        ].sort(),
      );
      for (const item of items) expect((await eventsOf(item.id)).map((e) => e.event)).toEqual(["proposed"]);
      expect(await requestRow(cancel.clinic.clinicId, "cancel_now")).toMatchObject({ outcome: "dead_letter", epoch: cancel.epoch });
      const { rows } = await getMigratorPool().query<{ outcome: string }>(`select outcome from billing_events where stripe_event_id = $1`, [eventId]);
      expect(rows[0]!.outcome).toBe("dead_letter");
    });

    test("never proposes what an automatic process still retries (D17)", async () => {
      // A plan start the worker dead-lettered: the reconcile re-arms it after a day.
      const planStart = await deadLettered("plan_start", "ap-neg-start");
      // A cancellation still being retried: attempt 3 of 10, pending.
      const retrying = await seedClinic("ap-neg-retrying");
      await seedEntitled(retrying.clinicId, { channelRows: [inService("web")] });
      await withTenant({ clinicId: retrying.clinicId, actor: ACTOR }, (tx) => requestCancelNow(tx, retrying.clinicId));
      await inTenant(retrying.clinicId, (c) =>
        c.query(`update billing_requests set attempts = 3, last_error = 'stripe:api_error' where clinic_id = $1`, [retrying.clinicId]),
      );
      // Overage invoices: the 05 UTC run invoices failed and pending months again by itself.
      const failedOverage = await overageRow(planStart.clinic.clinicId, "failed");
      const pendingOverage = await overageRow(retrying.clinicId, "pending");
      // A Stripe event still being resent (failed, not parked), and one parked that names no clinic,
      // which provisioning replays by itself.
      const resent = await stripeEvent(planStart.clinic.clinicId, { outcome: "failed", failures: 1 });
      const orphan = await stripeEvent(null);

      await proposeApprovals(NOW);
      await proposeApprovals(at(2 * DAY));
      expect(await itemsOfClinic(planStart.clinic.clinicId)).toEqual([]);
      expect(await itemsOfClinic(retrying.clinicId)).toEqual([]);
      for (const subject of [failedOverage, pendingOverage, resent, orphan]) expect(await itemsFor(subject), subject).toEqual([]);
      expect(KIND_SPECS.overage_invoice_retry.proposed).toBe(false);
    });

    test("leaves out the demo clinic and a closed account, and moves out an item whose clinic has since closed", async () => {
      const demo = await deadLettered("cancel_now", "ap-demo");
      await inTenant(demo.clinic.clinicId, (c) =>
        c.query(`update entitlements set status = 'demo', stripe_subscription_id = null, stripe_customer_id = null where clinic_id = $1`, [
          demo.clinic.clinicId,
        ]),
      );
      const demoEvent = await stripeEvent(demo.clinic.clinicId);
      const closed = await deadLettered("cancel_now", "ap-closed");
      await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [closed.clinic.clinicId]);
      const later = await deadLettered("cancel_now", "ap-closes-later");

      await proposeApprovals(NOW);
      expect(await itemsOfClinic(demo.clinic.clinicId)).toEqual([]);
      expect(await itemsOfClinic(closed.clinic.clinicId)).toEqual([]);
      expect(await itemsFor(demoEvent)).toEqual([]);
      expect((await itemsOfClinic(later.clinic.clinicId)).map((i) => i.status)).toEqual(["waiting"]);

      await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [later.clinic.clinicId]);
      const summary = await proposeApprovals(at(HOUR));
      expect(summary.outOfService).toBe(1);
      expect((await itemsOfClinic(later.clinic.clinicId))[0]).toMatchObject({ status: "expired", outcome_code: "clinic_out_of_service" });
    });

    test("is a switched job, off by default", async () => {
      await deadLettered("cancel_now", "ap-switch");
      expect(await runApprovalsProposeJob({ now: NOW })).toEqual({ status: "disabled" });
      await setJob("approvals-propose", true);
      try {
        expect(await runApprovalsProposeJob({ now: NOW })).toMatchObject({ status: "ok" });
      } finally {
        await setJob("approvals-propose", false);
      }
    });

    test("only a rejection and a passed window block a new proposal of the same subject", async () => {
      // Rejected: never again for that episode; a new epoch is a new subject.
      const rejected = await deadLettered("cancel_now", "ap-again");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(rejected.clinic.clinicId);
      expect(dataOf(await decide({ id: item!.id, action: "reject", reasonCode: "not_needed" }))).toMatchObject({ status: "rejected" });
      await proposeApprovals(at(HOUR));
      expect((await itemsOfClinic(rejected.clinic.clinicId)).map((i) => i.status)).toEqual(["rejected"]);
      await inTenant(rejected.clinic.clinicId, (c) => c.query(`update billing_requests set epoch = epoch + 1 where id = $1`, [rejected.requestId]));
      await proposeApprovals(at(2 * HOUR));
      expect((await itemsOfClinic(rejected.clinic.clinicId)).map((i) => i.status).sort()).toEqual(["rejected", "waiting"]);

      // Expired as no longer needed: the same subject failing again is proposed again.
      const moot = await deadLettered("cancel_now", "ap-moot");
      await proposeApprovals(NOW);
      await inTenant(moot.clinic.clinicId, (c) =>
        c.query(`update billing_requests set outcome = 'done', outcome_reason = 'canceled' where id = $1`, [moot.requestId]),
      );
      expect((await proposeApprovals(at(HOUR))).resolved).toBe(1);
      expect((await itemsOfClinic(moot.clinic.clinicId))[0]).toMatchObject({ status: "expired", outcome_code: "no_longer_needed" });
      await inTenant(moot.clinic.clinicId, (c) =>
        c.query(`update billing_requests set outcome = 'dead_letter', outcome_reason = 'attempts_exhausted' where id = $1`, [moot.requestId]),
      );
      await proposeApprovals(at(2 * HOUR));
      expect((await itemsOfClinic(moot.clinic.clinicId)).map((i) => i.status).sort()).toEqual(["expired", "waiting"]);

      // Expired by its window: never again for that episode.
      const lapsed = await deadLettered("cancel_now", "ap-lapsed");
      await proposeApprovals(NOW);
      await proposeApprovals(at(8 * DAY));
      await proposeApprovals(at(9 * DAY));
      expect((await itemsOfClinic(lapsed.clinic.clinicId)).map((i) => [i.status, i.outcome_code])).toEqual([["expired", "window_passed"]]);
    });

    test("nothing changes by time but waiting → expired: after the window it leaves the list unrun", async () => {
      const { clinic, epoch } = await deadLettered("cancel_now", "ap-window");
      await proposeApprovals(NOW);
      const summary = await proposeApprovals(at(8 * DAY));
      expect(summary.expired).toBeGreaterThanOrEqual(1);
      const [item] = await itemsOfClinic(clinic.clinicId);
      expect(item).toMatchObject({ status: "expired", outcome_code: "window_passed" });
      // The run that finds it past its window expires it before it would remind.
      expect((await eventsOf(item!.id)).map((e) => e.event)).toEqual(["proposed", "expired"]);
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ outcome: "dead_letter", epoch });
      await proposeApprovals(at(30 * DAY));
      expect((await itemsOfClinic(clinic.clinicId)).map((i) => i.status)).toEqual(["expired"]);
    });

    test("an item left approved past 15 minutes is recorded failed / interrupted, and does not block a new proposal", async () => {
      const { clinic } = await deadLettered("cancel_now", "ap-stuck");
      const fresh = await deadLettered("cancel_now", "ap-stuck-fresh");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
      const [young] = await itemsOfClinic(fresh.clinic.clinicId);
      // As a process that died after its decision leaves it, and one still running.
      await getMigratorPool().query(`update ops_approvals set status = 'approved', decided_at = $2 where id = $1`, [item!.id, at(-20 * MINUTE)]);
      await getMigratorPool().query(`update ops_approvals set status = 'approved', decided_at = $2 where id = $1`, [young!.id, at(-5 * MINUTE)]);

      const summary = await proposeApprovals(at(MINUTE));
      expect(summary.interrupted).toBe(1);
      expect((await getApproval(item!.id))?.status).toBe("failed");
      expect((await eventsOf(item!.id)).map((e) => [e.event, e.outcome_code])).toEqual([
        ["proposed", null],
        ["failed", "interrupted"],
      ]);
      expect((await getApproval(young!.id))?.status).toBe("approved");
      // Neither the interrupted item nor the one still approved blocks the subject: both are proposed again.
      expect((await itemsOfClinic(clinic.clinicId)).map((i) => i.status).sort()).toEqual(["failed", "waiting"]);
      expect((await itemsOfClinic(fresh.clinic.clinicId)).map((i) => i.status).sort()).toEqual(["approved", "waiting"]);
    });

    test("a money item re-alerts once past due; a legal-clock item every 4 hours at most", async () => {
      const { clinic } = await deadLettered("cancel_now", "ap-remind");
      const before = (await waitingAlerts()).length;
      await proposeApprovals(NOW);
      expect(await waitingAlerts()).toHaveLength(before);
      await proposeApprovals(at(25 * HOUR));
      const after = await waitingAlerts();
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toEqual({ kind: "billing_request_retry", count: 1 });
      await proposeApprovals(at(30 * HOUR));
      expect(await waitingAlerts()).toHaveLength(before + 1);
      const [item] = await itemsOfClinic(clinic.clinicId);
      expect((await eventsOf(item!.id)).filter((e) => e.event === "reminded")).toHaveLength(1);

      // No kind has a legal clock yet: one written straight in, on a parked event.
      await setAsideWaiting();
      const parkedAt = new Date(Math.floor(at(-HOUR).getTime() / 1000) * 1000);
      const eventId = await stripeEvent(clinic.clinicId, { parkedAt });
      await getMigratorPool().query(
        `insert into ops_approvals (kind, subject_clinic_id, subject_ref, payload, due_at, urgency, proposed_by, proposed_at)
         values ('billing_event_replay', $5, $1, $2, $3, 'legal_clock', 'approvals-propose', $4)`,
        [
          `${eventId}:${parkedAt.getTime() / 1000}`,
          JSON.stringify({ eventType: "customer.created", parkedAt: parkedAt.toISOString() }),
          at(DAY),
          NOW,
          clinic.clinicId,
        ],
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
      expect((await getApproval(legal!.id))?.status).toBe("waiting");
    });
  });

  describe("the decision (decideApproval)", () => {
    test("approve re-arms the dead cancellation through the console's own retry, once, and says so", async () => {
      const { clinic, epoch } = await deadLettered("cancel_now", "ap-approve");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
      const out = dataOf(await decide({ id: item!.id, action: "approve", reasonCode: "cause_fixed" }));
      expect(out).toEqual({
        status: "executed",
        outcomeCode: "rearmed",
        message: `Re-armed: the change is due again, with ten fresh tries. The billing worker carries it out at its next run if it still applies. ${WORKER_OFF}`,
        auditRecorded: true,
      });
      expect(out.message).not.toMatch(/carried out\./);
      // The same effect as the Billing tab's Retry: due again, a new epoch, no Stripe change yet.
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ outcome: null, attempts: 0, epoch: epoch + 1 });
      const { rows: retried } = await getMigratorPool().query(
        `select 1 from security_events where event = 'billing_request_retried' and metadata->>'clinicSlug' = $1`,
        [clinic.slug],
      );
      expect(retried).toHaveLength(1);
      const events = await eventsOf(item!.id);
      expect(events.map((e) => [e.event, e.outcome_code])).toEqual([
        ["proposed", null],
        ["approved", "cause_fixed"],
        ["executed", "rearmed"],
      ]);
      expect(events[1]).toMatchObject({ actor_label: OPERATOR.email, ip: "203.0.113.9", user_agent: "vitest" });
      expect(events[0]).toMatchObject({ actor_label: "approvals-propose", ip: null, user_agent: null });
      expect(await securityEvents("approval_approved", item!.id)).toEqual([
        expect.objectContaining({
          actor_label: OPERATOR.email,
          ip_address: "203.0.113.9",
          metadata: expect.objectContaining({ kind: "billing_request_retry", outcome: "executed", outcomeCode: "rearmed", freshCode: true }),
        }),
      ]);
      for (const action of ["approve", "reject"] as const) {
        const again = dataOf(await decide({ id: item!.id, action, reasonCode: action === "approve" ? "cause_fixed" : "not_needed" }));
        expect(again).toMatchObject({ status: "error", message: expect.stringMatching(/already been decided/) });
      }
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ epoch: epoch + 1 });
      expect(await eventsOf(item!.id)).toHaveLength(3);
    });

    test("two decisions at once: exactly one runs, the other is told it was already decided", async () => {
      const { clinic, epoch } = await deadLettered("cancel_now", "ap-race");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
      const outs = await Promise.all([
        decide({ id: item!.id, action: "approve", reasonCode: "cause_fixed" }),
        decide({ id: item!.id, action: "approve", reasonCode: "owner_checked" }),
      ]);
      const data = outs.map(dataOf);
      expect(data.map((d) => d.status).sort()).toEqual(["error", "executed"]);
      expect(data.find((d) => d.status === "error")?.message).toMatch(/already been decided/);
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ epoch: epoch + 1 });
      expect((await eventsOf(item!.id)).map((e) => e.event)).toEqual(["proposed", "approved", "executed"]);
    });

    test("reject runs nothing", async () => {
      const { clinic, epoch } = await deadLettered("cancel_now", "ap-reject");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
      expect(dataOf(await decide({ id: item!.id, action: "reject", reasonCode: "handled_elsewhere" }))).toEqual({
        status: "rejected",
        outcomeCode: "handled_elsewhere",
        auditRecorded: true,
      });
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ outcome: "dead_letter", epoch });
      expect((await eventsOf(item!.id)).map((e) => e.event)).toEqual(["proposed", "rejected"]);
      expect(await securityEvents("approval_rejected", item!.id)).toHaveLength(1);
    });

    test("a replay runs only while the event is parked as proposed; a refused or throwing run records failed", async () => {
      const clinic = await seedClinic("ap-refused");
      const replayId = await stripeEvent(clinic.clinicId);
      const goneId = await stripeEvent(clinic.clinicId);
      const reparkedId = await stripeEvent(clinic.clinicId);
      await proposeApprovals(NOW);
      const [replay] = await itemsFor(replayId);
      const [gone] = await itemsFor(goneId);
      const [reparked] = await itemsFor(reparkedId);
      expect(dataOf(await decide({ id: replay!.id, action: "approve", reasonCode: "passing_fault" }))).toEqual({
        status: "executed",
        outcomeCode: "replayed",
        message: null,
        auditRecorded: true,
      });
      // Applied another way since: the executor runs nothing.
      await getMigratorPool().query(`update billing_events set outcome = 'processed' where stripe_event_id = $1`, [goneId]);
      expect(dataOf(await decide({ id: gone!.id, action: "approve", reasonCode: "passing_fault" }))).toMatchObject({
        status: "failed",
        outcomeCode: "no_longer_needed",
      });
      // Parked again later: another episode, not the one approved here.
      await getMigratorPool().query(`update billing_events set processed_at = $2 where stripe_event_id = $1`, [reparkedId, at(30 * MINUTE)]);
      expect(dataOf(await decide({ id: reparked!.id, action: "approve", reasonCode: "passing_fault" }))).toMatchObject({
        status: "failed",
        outcomeCode: "no_longer_needed",
      });
      const { rows } = await getMigratorPool().query<{ outcome: string }>(`select outcome from billing_events where stripe_event_id = $1`, [reparkedId]);
      expect(rows[0]!.outcome).toBe("dead_letter");
      expect((await eventsOf(gone!.id)).map((e) => [e.event, e.outcome_code])).toEqual([
        ["proposed", null],
        ["approved", "passing_fault"],
        ["failed", "no_longer_needed"],
      ]);

      const another = await stripeEvent(clinic.clinicId);
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
      const { clinic, epoch } = await deadLettered("cancel_now", "ap-refuse");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
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
      expect(await requestRow(clinic.clinicId, "cancel_now")).toMatchObject({ outcome: "dead_letter", epoch });
    });

    test("an edit is linted again, reaches the executor as edited, and is recorded only once the decision wins", async () => {
      // No kind carries a draft yet, so a drafted spec stands in over a parked event.
      const clinic = await seedClinic("ap-draft");
      const parkedAt = new Date(Math.floor(at(-HOUR).getTime() / 1000) * 1000);
      const draftItem = async () => {
        const eventId = await stripeEvent(clinic.clinicId, { parkedAt });
        const draft = serialiseDraft({ subject: "A quick question about your account", body: "Hi team, could you reply with one word?" });
        await getMigratorPool().query(
          `insert into ops_approvals (kind, subject_ref, payload, draft, draft_hash, due_at, urgency, proposed_by, proposed_at)
           values ('billing_event_replay', $1, $2, $3, $4, $5, 'routine', 'approvals-propose', $6)`,
          [
            `${eventId}:${parkedAt.getTime() / 1000}`,
            JSON.stringify({ eventType: "customer.created", parkedAt: parkedAt.toISOString() }),
            draft,
            draftHash(draft),
            at(DAY),
            NOW,
          ],
        );
        return { item: (await itemsFor(eventId))[0]!, draft };
      };
      const received: (Draft | null)[] = [];
      const specs = { ...KIND_SPECS, billing_event_replay: { ...KIND_SPECS.billing_event_replay, hasDraft: true } };
      const executors: Record<string, Executor> = {
        billing_event_replay: async (_approval, _operator, context) => {
          received.push(context.draft);
          return { ok: true, outcomeCode: "sent", message: null, auditRecorded: true };
        },
      };
      const { item, draft } = await draftItem();
      const refused = dataOf(
        await decide(
          { id: item.id, action: "approve", reasonCode: "owner_checked", editedDraft: { subject: "Your revenue report", body: "Hi team." } },
          { specs, executors },
        ),
      );
      expect(refused).toMatchObject({ status: "error", message: expect.stringMatching(/cannot go as written/) });
      expect(received).toEqual([]);
      const edited = { subject: "A quick question about your healdesk account", body: "Hi team, could you reply Yes or No?" };
      expect(
        dataOf(await decide({ id: item.id, action: "approve", reasonCode: "owner_checked", editedDraft: edited }, { specs, executors })),
      ).toMatchObject({ status: "executed", outcomeCode: "sent" });
      expect(received).toEqual([edited]);
      const events = await eventsOf(item.id);
      expect(events.map((e) => e.event)).toEqual(["edited", "approved", "executed"]);
      const hash = draftHash(serialiseDraft(edited));
      expect(events.find((e) => e.event === "approved")?.draft_hash_approved).toBe(hash);
      expect(events.find((e) => e.event === "edited")?.draft_hash_approved).toBe(hash);
      expect(hash).not.toBe(draftHash(draft));

      // A decision that loses the item leaves no edit behind.
      const lost = await draftItem();
      expect(dataOf(await decide({ id: lost.item.id, action: "reject", reasonCode: "not_needed" }))).toMatchObject({ status: "rejected" });
      expect(
        dataOf(await decide({ id: lost.item.id, action: "approve", reasonCode: "owner_checked", editedDraft: edited }, { specs, executors })),
      ).toMatchObject({ status: "error" });
      expect((await eventsOf(lost.item.id)).map((e) => e.event)).toEqual(["rejected"]);
      expect(decideDraft(false, { draft: null, draftHash: null }, edited)).toMatchObject({ ok: false, code: "no_draft_kind" });
    });
  });

  describe("the reads", () => {
    test("the packet holds ids, codes, counts and switches only, and says what approving really does", async () => {
      const cancel = await deadLettered("cancel_now", "ap-packet");
      const close = await deadLettered("close_setup", "ap-packet-close");
      await stripeEvent(cancel.clinic.clinicId, { type: "invoice.paid" });
      await proposeApprovals(NOW);
      const read = async () => {
        const out = await opListApprovals({}, OPERATOR, NOW);
        const data = (out.body as { data: { items: { kind: string; clinic: unknown; packet: Record<string, unknown> | null }[] } }).data;
        return data.items.filter((i) => [cancel.clinic.clinicId, close.clinic.clinicId].some((id) => JSON.stringify(i.clinic).includes(id)));
      };
      const mine = await read();
      expect(mine.map((i) => i.kind).sort()).toEqual(["billing_event_replay", "billing_request_retry", "billing_request_retry"]);
      for (const item of mine) {
        const packet = item.packet!;
        expect(Object.keys(packet).sort()).toEqual(["effect", "facts", "irreversible", "operation", "stillNeeded"]);
        const text = JSON.stringify(packet);
        expect(text).not.toMatch(/@/);
        expect(text).not.toMatch(/\d{7,}/);
        expect(packet.stillNeeded).toBe(true);
      }
      const requestPacket = (kind: string) =>
        mine.find((i) => i.kind === "billing_request_retry" && (i.packet!.facts as { requestKind: string }).requestKind === kind)!.packet!;
      const cancelPacket = requestPacket("cancel_now");
      expect(Object.keys(cancelPacket.facts as object).sort()).toEqual(
        ["attempts", "billingStatus", "channel", "closureOn", "kind", "lastErrorCode", "maxAttempts", "reasonCode", "requestKind", "supersededBy", "workerOn"].sort(),
      );
      expect(cancelPacket.facts).toMatchObject({
        requestKind: "cancel_now",
        attempts: 10,
        maxAttempts: 10,
        reasonCode: "attempts_exhausted",
        lastErrorCode: "stripe:api_error",
        workerOn: false,
        closureOn: null,
      });
      expect(cancelPacket.effect).toBe(
        `Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with ten fresh tries. Once carried out, the subscription is cancelled at once, and that cannot be undone. ${WORKER_OFF}`,
      );
      const closePacket = requestPacket("close_setup");
      expect(closePacket.facts).toMatchObject({ requestKind: "close_setup", workerOn: false, closureOn: false });
      expect(closePacket.effect).toBe(
        "Makes this closure due again. The billing worker carries it out at its next run, with ten fresh tries, if nothing has gone live and setup closure is switched on. Once carried out, the subscription is cancelled and the account closed, the setup fee is not refunded, and that cannot be undone. " +
          `${WORKER_OFF} Setup closure is switched off, so the closure waits until it is switched on at System > Jobs.`,
      );
      const eventPacket = mine.find((i) => i.kind === "billing_event_replay")!.packet!;
      expect(Object.keys(eventPacket.facts as object).sort()).toEqual(["eventType", "failures", "kind", "maxFailures"]);
      expect(eventPacket.effect).toBe(
        "Applies a paid invoice: it can activate a clinic still being set up, start its plan, move its billing period on, or lift a suspension for non-payment. It is applied as if it had just arrived, and may send the clinic the billing email that event calls for.",
      );

      // Switched on, the worker's line goes.
      await setJob("billing-requests", true);
      await setJob("setup-closure", true);
      try {
        const on = await read();
        const effect = (kind: string) =>
          on.find((i) => i.kind === "billing_request_retry" && (i.packet!.facts as { requestKind: string }).requestKind === kind)!.packet!.effect as string;
        expect(effect("cancel_now")).not.toMatch(/switched off/);
        expect(effect("close_setup")).not.toMatch(/switched off/);
      } finally {
        await setJob("billing-requests", false);
        await setJob("setup-closure", false);
      }
    });

    test("each Stripe event type says what replaying it does, with the email line kept", () => {
      expect(eventEffect("charge.dispute.created")).toBe(
        "Applies a payment dispute: where the account can be suspended, AYA is suspended until support lifts it and the clinic is emailed its call-forwarding steps; otherwise the dispute is noted in its billing history. It is applied as if it had just arrived, and may send the clinic the billing email that event calls for.",
      );
      expect(eventEffect("customer.subscription.deleted")).toMatch(/^Applies the end of the subscription: the account is cancelled/);
      expect(eventEffect("invoice.payment_failed")).toMatch(/^Applies a failed payment: the clinic is emailed Stripe's page to pay/);
      expect(eventEffect("customer.created")).toBe(
        "Applies the parked Stripe event again from the start. It is applied as if it had just arrived, and may send the clinic the billing email that event calls for.",
      );
    });

    test("the history reads the record without drafts; Home shows one plain row per kind", async () => {
      const { clinic } = await deadLettered("cancel_now", "ap-history");
      await stripeEvent(clinic.clinicId);
      await stripeEvent(clinic.clinicId);
      // Later than any other test's clock, so this item's events are the newest in the record.
      const later = at(400 * DAY);
      await proposeApprovals(later);
      const home = await approvalsSource.read({} as never);
      expect(home.rows.map((r) => [r.id, r.count, r.sentence, r.tone, r.button]).sort()).toEqual([
        ["approvals:billing_event_replay", 2, "2 Stripe event replays are waiting for your yes.", "warn", { label: "Open approvals", kind: "link", href: "/admin/queues#approvals" }],
        [
          "approvals:billing_request_retry",
          1,
          "1 cancellation or closure the billing worker gave up on is waiting for your yes.",
          "warn",
          { label: "Open approvals", kind: "link", href: "/admin/queues#approvals" },
        ],
      ]);
      const [item] = (await itemsOfClinic(clinic.clinicId)).filter((i) => i.kind === "billing_request_retry");
      await decide({ id: item!.id, action: "reject", reasonCode: "ask_clinic_first" }, { now: new Date(later.getTime() + MINUTE) });
      const out = await opListApprovalHistory({ limit: 200 });
      const events = (out.body as { data: { events: Record<string, unknown>[] } }).data.events;
      const own = events.filter((e) => e.approvalId === item!.id);
      expect(own.map((e) => e.event)).toEqual(["rejected", "proposed"]);
      expect(own[0]).toMatchObject({ approvalId: item!.id, event: "rejected", actorLabel: OPERATOR.email, outcomeCode: "ask_clinic_first" });
      for (const e of events) expect(Object.keys(e)).not.toContain("draft");
      expect((await opListApprovalHistory({ kind: "refund" })).status).toBe(400);
    });

    test("the three operations are on the closed list; only the decision is mutating", async () => {
      for (const op of ["listApprovals", "decideApproval", "listApprovalHistory"]) expect(isOpName(op), op).toBe(true);
      expect(isMutating("decideApproval")).toBe(true);
      expect(isMutating("listApprovals")).toBe(false);
      expect(isMutating("listApprovalHistory")).toBe(false);
      expect((await runOperation("listApprovals", { status: "nope" }, OPERATOR)).status).toBe(400);
      const { clinic } = await deadLettered("cancel_now", "ap-dispatch");
      await proposeApprovals(NOW);
      const [item] = await itemsOfClinic(clinic.clinicId);
      const out = await runOperation("decideApproval", { id: item!.id, action: "approve", reasonCode: "cause_fixed" }, OPERATOR);
      expect(dataOf(out)).toMatchObject({ status: "error" });
      expect(parsePayload("billing_request_retry", { ...JSON.parse(JSON.stringify((await getApproval(item!.id))!.payload)), extra: 1 })).toBeNull();
    });
  });
});
