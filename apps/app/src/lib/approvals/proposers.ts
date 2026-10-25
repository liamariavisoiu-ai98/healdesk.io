import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { BILLING_REQUEST_KINDS, billingEvents, billingRequests, overageInvoices, type OpsApproval } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { raiseOpsAlertKeyed } from "@/lib/ops/notify";
import { getJob, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { KIND_SPECS, LEGAL_CLOCK_REMINDER_MS, parsePayload, PROPOSER, RETRIED_BY_REQUEST_KIND, type ApprovalKind } from "./kinds";
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
import { classifyUnresolvedEvent } from "./stripe-ids";
import { INCIDENT_KINDS, waitingAlertEvent } from "./incident-kinds";
import { runIncidentSweep } from "./incident-sweep";

/**
 * The `approvals-propose` job (ops automation Phase 6, lane P6a; design E6
 * §3 item 15): hourly, behind its switch, which ships off, run by the tick
 * after the billing reconcile and the requests worker.
 *
 * Owner decision D17: the inbox gates from the dead letter onward, and
 * nothing may be both waiting for the owner's yes and retried by itself. So
 * it proposes only what no automatic process will retry or re-arm, judged
 * at each run by the switch of the job that would (KIND_SPECS retriedBy,
 * RETRIED_BY_REQUEST_KIND):
 *
 *   - a `cancel_now` or `close_setup` billing request the worker
 *     dead-lettered (lib/billing/requests.ts settle). Nothing re-arms these;
 *   - a `plan_start` or `step_up` dead letter, only while `billing-reconcile`
 *     is switched off. While it is on, the hourly reconcile re-arms it once
 *     it has rested DEAD_LETTER_REST_MS whenever the worker could carry it
 *     out (lib/billing/reconcile.ts decideReconcile, whose conditions mirror
 *     the worker's re-check). One item per request and epoch;
 *   - an annual overage invoice that failed, only while
 *     `annual-overage-invoice` is switched off. While it is on, the 05 UTC
 *     run invoices every failed month again. One item per month's row;
 *   - a Stripe event parked after its retries (lib/billing/events.ts) that
 *     names a clinic, or that resolved to none and that no purchase waiting
 *     to be provisioned names (provisioning replays those by itself,
 *     replayParkedBillingEvents; nothing replays the rest). One item per
 *     event and parking.
 *
 * When one of those switches is turned on, a waiting item it now covers
 * leaves the list (`retried_automatically`), unrun.
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
  /** Waiting items a job switched on since now retries by itself. */
  retriedAutomatically: number;
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
/** Which automatic retries are switched on now: the reconcile's re-arm and the daily extra-usage run. */
export async function automaticRetries(): Promise<ReadonlySet<string>> {
  const on = new Set<string>();
  for (const name of ["billing-reconcile", "annual-overage-invoice"]) {
    if ((await getJob(name))?.enabled === true) on.add(name);
  }
  return on;
}

function retriedNow(kind: ApprovalKind, payload: unknown, on: ReadonlySet<string>): boolean {
  if (kind === "billing_request_retry") {
    const p = parsePayload("billing_request_retry", payload);
    const job = p ? RETRIED_BY_REQUEST_KIND[p.requestKind] : null;
    return job !== null && on.has(job);
  }
  const job = KIND_SPECS[kind]?.retriedBy ?? null;
  return job !== null && on.has(job);
}

export async function findOpenSubjects(now: Date, on: ReadonlySet<string> = new Set()): Promise<Found & { unread: number }> {
  const requestKinds = BILLING_REQUEST_KINDS.filter((k) => {
    const job = RETRIED_BY_REQUEST_KIND[k];
    return job === null || !on.has(job);
  });
  const overageOpen = !on.has("annual-overage-invoice");
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
              inArray(billingRequests.kind, [...requestKinds]),
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
        if (!overageOpen) return;
        const failed = await tx.db
          .select({ id: overageInvoices.id, windowStart: overageInvoices.windowStart })
          .from(overageInvoices)
          .where(and(eq(overageInvoices.clinicId, tx.clinicId), eq(overageInvoices.status, "failed")));
        for (const o of failed) {
          found.open.add(key("overage_invoice_retry", o.id));
          found.proposals.push({
            kind: "overage_invoice_retry",
            subjectClinicId: id,
            subjectRef: o.id,
            payload: { billingClinicId: id, overageId: o.id, windowStart: o.windowStart.toISOString() },
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
  // resolved to, if any. One that resolved to none is read again: if a
  // purchase still waiting to be provisioned names it, provisioning will
  // replay it, so it is left out; otherwise (a clinic that exists, whose
  // event parked before it was resolved, or one nothing matches) nothing
  // replays it, and it is proposed (./stripe-ids.ts).
  try {
    const parked = await unsafeDb
      .select({
        id: billingEvents.stripeEventId,
        type: billingEvents.type,
        clinicId: billingEvents.resolvedClinicId,
        processedAt: billingEvents.processedAt,
        receivedAt: billingEvents.receivedAt,
        payload: billingEvents.payload,
      })
      .from(billingEvents)
      .where(eq(billingEvents.outcome, "dead_letter"));
    for (const e of parked) {
      if (!/^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) || !/^[a-z][a-z0-9_.]{0,80}$/.test(e.type)) continue;
      const parkedAt = parkedAtOf(e.processedAt, e.receivedAt);
      const subjectRef = `${e.id}:${Math.floor(parkedAt.getTime() / 1000)}`;
      let clinicId = e.clinicId;
      if (!clinicId) {
        const unresolved = await classifyUnresolvedEvent(e.type, e.payload, now);
        if (unresolved.state === "provisioning_pending") continue;
        clinicId = unresolved.state === "resolved" ? unresolved.clinicId : null;
      }
      found.open.add(key("billing_event_replay", subjectRef));
      if (clinicId) {
        const state = await stateOf(clinicId);
        if (!state) {
          unread += 1;
          continue;
        }
        if (state.demo || state.closed) {
          found.outOfService.add(clinicId);
          continue;
        }
      }
      found.proposals.push({
        kind: "billing_event_replay",
        subjectClinicId: clinicId,
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
export async function remind(now: Date, which: (kind: string) => boolean = () => true): Promise<number> {
  const waiting = await waitingItems();
  const byKind = new Map<ApprovalKind, OpsApproval[]>();
  for (const item of waiting) {
    if (!which(item.kind)) continue;
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
    const alertId = await raiseOpsAlertKeyed(waitingAlertEvent(kind), { kind, count: due.length }, { key: alertKey, email: true });
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
  const on = await automaticRetries();
  const found = await findOpenSubjects(now, on);
  let proposed = 0;
  for (const proposal of found.proposals) {
    if (!KIND_SPECS[proposal.kind] || retriedNow(proposal.kind, proposal.payload, on)) continue;
    if (await propose(proposal, now)) proposed += 1;
  }
  const interrupted = await sweepInterrupted(now);
  const expired = await expireDue(now);
  let gone = 0;
  let outOfService = 0;
  let retriedAutomatically = 0;
  for (const item of await waitingItems()) {
    // An incident item is a legal clock, swept by its own rules below
    // (./incident-sweep.ts), never by the billing ones.
    if (INCIDENT_KINDS.has(item.kind)) continue;
    if (retriedNow(item.kind as ApprovalKind, item.payload, on)) {
      if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "retried_automatically" })) {
        retriedAutomatically += 1;
      }
      continue;
    }
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
  const reminded = await remind(now, (kind) => !INCIDENT_KINDS.has(kind));
  // The incident assistant (lane P6i): its first reports, overtaken items and
  // 4-hourly alerts. The incident-deadlines job runs the same sweep, so it
  // does not wait on this job's switch.
  const incidents = await runIncidentSweep(now);
  return {
    proposed: proposed + incidents.proposed,
    expired,
    resolved: gone + incidents.resolved,
    outOfService: outOfService + incidents.outOfService,
    interrupted,
    retriedAutomatically,
    reminded: reminded + incidents.reminded,
    unread: found.unread + incidents.unread,
  };
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
        `${r.outOfService} out of service, ${r.retriedAutomatically} now retried by their own job, ${r.interrupted} interrupted, ${r.reminded} reminded` +
        (r.unread ? `, ${r.unread} could not be read` : "") +
        "."
      );
    },
    now,
  );
}

