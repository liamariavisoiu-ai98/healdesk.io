import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { billingEvents, billingRequests, overageInvoices, type OpsApproval } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { raiseOpsAlertKeyed } from "@/lib/ops/notify";
import { runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { KIND_SPECS, LEGAL_CLOCK_REMINDER_MS, PROPOSER, type ApprovalKind } from "./kinds";
import { expireDue, moveStatus, propose, recordEvent, reminders, SERVICE_ACTOR, waitingItems, type Proposal } from "./store";

/**
 * The `approvals-propose` job (ops automation Phase 6, lane P6a; design E6
 * §3 item 15): hourly, behind its switch, which ships off.
 *
 * It finds, across clinics, the billing work only a person can let go on
 * (owner decision D17: from the dead letter onward; the worker's ten
 * attempts, the reconcile's re-arm and Stripe's dunning stay ungated):
 *
 *   - a billing request dead-lettered: every attempt used, or a failure
 *     retrying cannot fix (lib/billing/requests.ts settle, which raises
 *     billing_request_dead_lettered). One item per request and epoch: a
 *     request re-armed and dead again is a new episode;
 *   - an annual overage invoice that failed (lib/billing/annual-overage.ts,
 *     overage_invoice_failed). One item per month's ledger row; the 05 UTC
 *     run keeps retrying it on its own, as it always has;
 *   - a Stripe event parked after its retries (lib/billing/events.ts,
 *     billing_event_dead_lettered). One item per event.
 *
 * and inserts one waiting item for each (lib/approvals/store.ts propose:
 * idempotent, and never again for a subject the owner rejected or let
 * expire). It never retries, invoices or replays anything itself: only an
 * approval does, through the console's own operation.
 *
 * It leaves out healdesk's demo clinic (app_clinic_is_demo) and clinics
 * whose account is closed. It expires waiting items past their window, and
 * those whose subject has moved on (the request done, the invoice paid, the
 * event applied): both only leave the list, and neither runs anything. Then
 * it re-alerts: a money or routine item once when past due, a legal-clock
 * item every 4 hours while it waits (D18), one alert per kind.
 */

export const JOB_APPROVALS_PROPOSE = PROPOSER;

const ACTOR = { type: "service", serviceName: PROPOSER } as const;

export type ProposeSummary = {
  proposed: number;
  expired: number;
  resolved: number;
  reminded: number;
  /** Clinics whose rows could not be read: their items are neither proposed nor expired as resolved. */
  unread: number;
};

type ClinicState = { demo: boolean; closed: boolean };

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Each open subject found this run, by kind and reference, and the clinics fully read. */
type Found = { proposals: Proposal[]; open: Set<string>; readClinics: Set<string>; eventsRead: boolean };

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

/** Every open subject, across billing clinics and the parked Stripe events. */
export async function findOpenSubjects(): Promise<Found & { unread: number }> {
  const found: Found = { proposals: [], open: new Set(), readClinics: new Set(), eventsRead: false };
  let unread = 0;
  const states = new Map<string, ClinicState | null>();
  const stateOf = async (id: string) => {
    if (!states.has(id)) states.set(id, await clinicState(id));
    return states.get(id)!;
  };

  const clinics = rowsOf<{ id: string }>(
    await unsafeDb.execute(
      sql`select id from app_clinics_overview() where billing_clinic_id is null and destroyed_at is null`,
    ),
  );
  for (const { id } of clinics) {
    const state = await stateOf(id);
    if (!state) {
      unread += 1;
      continue;
    }
    if (state.demo || state.closed) {
      found.readClinics.add(id);
      continue;
    }
    try {
      await withTenant({ clinicId: id, actor: ACTOR }, async (tx) => {
        const dead = await tx.db
          .select({ id: billingRequests.id, kind: billingRequests.kind, epoch: billingRequests.epoch })
          .from(billingRequests)
          .where(and(eq(billingRequests.clinicId, tx.clinicId), eq(billingRequests.outcome, "dead_letter")));
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
  // resolved to, if any. One that names a demo or closed clinic is left out.
  try {
    const parked = await unsafeDb
      .select({ id: billingEvents.stripeEventId, type: billingEvents.type, clinicId: billingEvents.resolvedClinicId })
      .from(billingEvents)
      .where(eq(billingEvents.outcome, "dead_letter"));
    for (const e of parked) {
      if (!/^evt_[A-Za-z0-9_]{1,250}$/.test(e.id) || !/^[a-z][a-z0-9_.]{0,80}$/.test(e.type)) continue;
      found.open.add(key("billing_event_replay", e.id));
      if (e.clinicId) {
        const state = await stateOf(e.clinicId);
        if (!state) {
          unread += 1;
          continue;
        }
        if (state.demo || state.closed) continue;
      }
      found.proposals.push({
        kind: "billing_event_replay",
        subjectClinicId: e.clinicId,
        subjectRef: e.id,
        payload: { eventType: e.type },
      });
    }
    found.eventsRead = true;
  } catch (error) {
    unread += 1;
    log.warn("approvals: the parked Stripe events could not be read", { error: describeError(error) });
  }
  return { ...found, unread };
}

/** Whether a waiting item's subject was read this run and is no longer open. */
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
    if (!KIND_SPECS[proposal.kind]) continue;
    if (await propose(proposal, now)) proposed += 1;
  }
  const expired = await expireDue(now);
  let gone = 0;
  for (const item of await waitingItems()) {
    if (!resolved(item, found)) continue;
    if (await moveStatus(item.id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "no_longer_needed" })) {
      gone += 1;
    }
  }
  const reminded = await remind(now);
  return { proposed, expired, resolved: gone, reminded, unread: found.unread };
}

/** The `approvals-propose` job: hourly from the tick, behind its switch. */
export async function runApprovalsProposeJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_APPROVALS_PROPOSE,
    async () => {
      const r = await proposeApprovals(now);
      return (
        `${r.proposed} proposed, ${r.expired} expired, ${r.resolved} no longer needed, ${r.reminded} reminded` +
        (r.unread ? `, ${r.unread} could not be read` : "") +
        "."
      );
    },
    now,
  );
}

