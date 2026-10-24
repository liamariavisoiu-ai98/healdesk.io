import { createHash } from "node:crypto";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { billingEvents, billingRequests, type OpsApproval } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { raiseOpsAlertKeyed } from "@/lib/ops/notify";
import { runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { KIND_SPECS, LEGAL_CLOCK_REMINDER_MS, PROPOSED_REQUEST_KINDS, PROPOSER, type ApprovalKind } from "./kinds";
import {
  expireDue,
  moveStatus,
  propose,
  recordEvent,
  reminders,
  SERVICE_ACTOR,
  sweepInterrupted,
  waitingItems,
  type Proposal,
} from "./store";

/**
 * The `approvals-propose` job (ops automation Phase 6, lane P6a; design E6
 * §3 item 15): hourly, behind its switch, which ships off, run by the tick
 * after the billing reconcile and the requests worker.
 *
 * Owner decision D17: the inbox gates from the dead letter onward, and
 * nothing may be both waiting for the owner's yes and retried by itself. So
 * it proposes only what no automatic process will retry or re-arm:
 *
 *   - a `cancel_now` or `close_setup` billing request the worker
 *     dead-lettered (lib/billing/requests.ts settle). Nothing re-arms these.
 *     A `plan_start` or `step_up` dead letter is NOT proposed: the hourly
 *     reconcile re-arms it once it has rested DEAD_LETTER_REST_MS whenever
 *     the worker could carry it out (lib/billing/reconcile.ts
 *     decideReconcile, whose conditions mirror the worker's re-check), and
 *     where they do not hold the worker would only skip it again. One item
 *     per request and epoch;
 *   - a Stripe event parked after its retries (lib/billing/events.ts) that
 *     resolved to a clinic. One that names no clinic is left out:
 *     provisioning replays such events by itself (replayParkedBillingEvents).
 *     A `failed` event Stripe is still resending is not parked. One item per
 *     event and parking;
 *   - never an annual overage invoice: the 05 UTC run invoices every failed
 *     month again by itself (KIND_SPECS.overage_invoice_retry.proposed).
 *
 * It runs nothing itself. It leaves out healdesk's demo clinic
 * (app_clinic_is_demo) and closed accounts, and moves out of the list an
 * item whose clinic has since become one (`clinic_out_of_service`), one past
 * its window (`window_passed`) and one whose subject went through since
 * (`no_longer_needed`): none of them runs anything. It records as `failed`
 * / `interrupted` an item left `approved` by a process that died. Then it
 * re-alerts: a money or routine item once past due, a legal-clock item
 * every 4 hours while it waits (D18), one alert per kind.
 */

export const JOB_APPROVALS_PROPOSE = PROPOSER;

const ACTOR = { type: "service", serviceName: PROPOSER } as const;

export type ProposeSummary = {
  proposed: number;
  expired: number;
  resolved: number;
  outOfService: number;
  interrupted: number;
  reminded: number;
  /** Clinics whose rows could not be read: their items are neither proposed nor expired as resolved. */
  unread: number;
};

type ClinicState = { demo: boolean; closed: boolean };

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Each open subject found this run, by kind and reference, and the clinics fully read or out of service. */
type Found = {
  proposals: Proposal[];
  open: Set<string>;
  readClinics: Set<string>;
  outOfService: Set<string>;
  eventsRead: boolean;
};

const key = (kind: ApprovalKind, subjectRef: string) => `${kind}|${subjectRef}`;

async function clinicState(clinicId: string): Promise<ClinicState | null> {
  try {
    return await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const result = await tx.db.execute(
        sql`select app_clinic_is_demo(c.id) as demo, (c.account_closed_at is not null or c.destroyed_at is not null) as closed
              from clinics c where c.id = ${tx.clinicId}`,
      );
      const [row] = rowsOf<{ demo: boolean; closed: boolean }>(result);
      return row ? { demo: row.demo === true, closed: row.closed === true } : null;
    });
  } catch (error) {
    log.warn("approvals: a clinic could not be read", { clinicId, error: describeError(error) });
    return null;
  }
}

/** When an event was parked, to the second: its episode. */
function parkedAtOf(processedAt: Date | null, receivedAt: Date): Date {
  return new Date(Math.floor((processedAt ?? receivedAt).getTime() / 1000) * 1000);
}

/** Every open subject the inbox may propose, across billing clinics and the parked Stripe events. */
export async function findOpenSubjects(): Promise<Found & { unread: number }> {
  const found: Found = { proposals: [], open: new Set(), readClinics: new Set(), outOfService: new Set(), eventsRead: false };
  let unread = 0;
  const states = new Map<string, ClinicState | null>();
  const stateOf = async (id: string) => {
    if (!states.has(id)) states.set(id, await clinicState(id));
    return states.get(id)!;
  };

  const clinics = rowsOf<{ id: string }>(
    await unsafeDb.execute(sql`select id from app_clinics_overview() where billing_clinic_id is null`),
  );
  for (const { id } of clinics) {
    const state = await stateOf(id);
    if (!state) {
      unread += 1;
      continue;
    }
    if (state.demo || state.closed) {
      found.outOfService.add(id);
      continue;
    }
    try {
      await withTenant({ clinicId: id, actor: ACTOR }, async (tx) => {
        const dead = await tx.db
          .select({ id: billingRequests.id, kind: billingRequests.kind, epoch: billingRequests.epoch })
          .from(billingRequests)
          .where(
            and(
              eq(billingRequests.clinicId, tx.clinicId),
              eq(billingRequests.outcome, "dead_letter"),
              inArray(billingRequests.kind, [...PROPOSED_REQUEST_KINDS]),
            ),
          );
        for (const r of dead) {
          const subjectRef = `${r.id}:${r.epoch}`;
          found.open.add(key("billing_request_retry", subjectRef));
          found.proposals.push({
            kind: "billing_request_retry",
            subjectClinicId: id,
            subjectRef,
            payload: { billingClinicId: id, requestId: r.id, requestKind: r.kind, epoch: r.epoch },
          });
        }
      });
      found.readClinics.add(id);
    } catch (error) {
      unread += 1;
      log.warn("approvals: a clinic's billing rows could not be read", { clinicId: id, error: describeError(error) });
    }
  }

  // Parked Stripe events live outside any tenant, each with the clinic it
  // resolved to. Only those that resolved to one, in service, are proposed.
  try {
    const parked = await unsafeDb
      .select({
        id: billingEvents.stripeEventId,
        type: billingEvents.type,
        clinicId: billingEvents.resolvedClinicId,
        processedAt: billingEvents.processedAt,
        receivedAt: billingEvents.receivedAt,
      })
      .from(billingEvents)
      .where(and(eq(billingEvents.outcome, "dead_letter"), isNotNull(billingEvents.resolvedClinicId)));
    for (const e of parked) {
      if (!/^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) || !/^[a-z][a-z0-9_.]{0,80}$/.test(e.type) || !e.clinicId) continue;
      const parkedAt = parkedAtOf(e.processedAt, e.receivedAt);
      const subjectRef = `${e.id}:${Math.floor(parkedAt.getTime() / 1000)}`;
      found.open.add(key("billing_event_replay", subjectRef));
      const state = await stateOf(e.clinicId);
      if (!state) {
        unread += 1;
        continue;
      }
      if (state.demo || state.closed) {
        found.outOfService.add(e.clinicId);
        continue;
      }
      found.proposals.push({
        kind: "billing_event_replay",
        subjectClinicId: e.clinicId,
        subjectRef,
        payload: { eventType: e.type, parkedAt: parkedAt.toISOString() },
      });
    }
    found.eventsRead = true;
  } catch (error) {
    unread += 1;
    log.warn("approvals: the parked Stripe events could not be read", { error: describeError(error) });
  }
  return { ...found, unread };
}

/** Whether a waiting item's subject was read this run and is no longer open, or its kind is no longer proposed. */
function resolved(item: OpsApproval, found: Found): boolean {
  if (found.open.has(key(item.kind as ApprovalKind, item.subjectRef))) return false;
  if (item.kind === "billing_event_replay") return found.eventsRead;
  if (!KIND_SPECS[item.kind as ApprovalKind]?.proposed) return true;
  const clinic = item.subjectClinicId;
  return clinic !== null && found.readClinics.has(clinic);
}

/**
 * The re-alert for one kind: which waiting items are due one now. A legal
 * clock every 4 hours from its proposal (its first is its arrival); money
 * and routine once, past due.
 */
async function dueReminders(items: OpsApproval[], now: Date): Promise<{ item: OpsApproval; count: number }[]> {
  const due: { item: OpsApproval; count: number }[] = [];
  for (const item of items) {
    const sent = await reminders(item.id);
    if (item.urgency === "legal_clock") {
      const since = sent.last ?? null;
      if (since === null || now.getTime() - since.getTime() >= LEGAL_CLOCK_REMINDER_MS) due.push({ item, count: sent.count });
    } else if (sent.count === 0 && item.dueAt.getTime() <= now.getTime()) {
      due.push({ item, count: 0 });
    }
  }
  return due;
}

/**
 * One alert per kind with items due a reminder, keyed on exactly those items
 * and how many reminders each had: a run that raised it and stopped before
 * recording the reminders raises nothing twice. Slack and the ops address
 * (an approval waiting is the owner's to act on).
 */
async function remind(now: Date): Promise<number> {
  const waiting = await waitingItems();
  const byKind = new Map<ApprovalKind, OpsApproval[]>();
  for (const item of waiting) {
    const kind = item.kind as ApprovalKind;
    byKind.set(kind, [...(byKind.get(kind) ?? []), item]);
  }
  let reminded = 0;
  for (const [kind, items] of byKind) {
    const due = await dueReminders(items, now);
    if (due.length === 0) continue;
    const identity = due
      .map((d) => `${d.item.id}:${d.count}`)
      .sort()
      .join(",");
    const alertKey = `approval_waiting:${kind}:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
    const alertId = await raiseOpsAlertKeyed("approval_waiting", { kind, count: due.length }, { key: alertKey, email: true });
    if (!alertId) continue;
    for (const { item } of due) {
      await recordEvent(unsafeDb, item.id, "reminded", SERVICE_ACTOR, { at: now });
      reminded += 1;
    }
  }
  return reminded;
}

/** One run: propose, expire, re-alert. Exported for the tests; the job wraps it. */
export async function proposeApprovals(now: Date = new Date()): Promise<ProposeSummary> {
  const found = await findOpenSubjects();
  let proposed = 0;
  for (const proposal of found.proposals) {
    if (!KIND_SPECS[proposal.kind]?.proposed) continue;
    if (await propose(proposal, now)) proposed += 1;
  }
  const interrupted = await sweepInterrupted(now);
  const expired = await expireDue(now);
  let gone = 0;
  let outOfService = 0;
  for (const item of await waitingItems()) {
    if (item.subjectClinicId !== null && found.outOfService.has(item.subjectClinicId)) {
      if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "clinic_out_of_service" })) {
        outOfService += 1;
      }
      continue;
    }
    if (!resolved(item, found)) continue;
    if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "no_longer_needed" })) {
      gone += 1;
    }
  }
  const reminded = await remind(now);
  return { proposed, expired, resolved: gone, outOfService, interrupted, reminded, unread: found.unread };
}

/** The `approvals-propose` job: hourly from the tick, behind its switch. */
export async function runApprovalsProposeJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_APPROVALS_PROPOSE,
    async () => {
      const r = await proposeApprovals(now);
      return (
        `${r.proposed} proposed, ${r.expired} expired, ${r.resolved} no longer needed, ` +
        `${r.outOfService} out of service, ${r.interrupted} interrupted, ${r.reminded} reminded` +
        (r.unread ? `, ${r.unread} could not be read` : "") +
        "."
      );
    },
    now,
  );
}

