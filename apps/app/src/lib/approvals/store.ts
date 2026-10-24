import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsApprovalEvents, opsApprovals, type OpsApproval } from "@/db/schema";

import {
  KIND_SPECS,
  OUTCOME_CODE,
  PROPOSER,
  type ApprovalEventName,
  type ApprovalKind,
  type ApprovalStatus,
  type Payloads,
} from "./kinds";

/**
 * The approval inbox's two tables (drizzle/0119), read and written outside
 * any tenant as the runtime role: ops_approvals takes an insert and, from a
 * decision, only its status, decided_at and outcome_code; its trigger allows
 * only waiting → approved | rejected | expired and approved → executed |
 * failed. ops_approval_events takes inserts and nothing else, ever.
 *
 * Every status move here is a compare-and-set on the status it expects, so
 * two decisions on one item, or a decision racing the expiry, change it
 * once: the second finds nothing to move and is told so.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Who an event is attributed to: the operator account and what its request carried, or a service. */
export type EventActor = { label: string; ip?: string | null; userAgent?: string | null };

export const SERVICE_ACTOR: EventActor = { label: PROPOSER };

type Db = Pick<typeof unsafeDb, "insert" | "select" | "update" | "execute">;

export async function recordEvent(
  db: Db,
  approvalId: string,
  event: ApprovalEventName,
  actor: EventActor,
  extra: { outcomeCode?: string | null; draftHashApproved?: string | null; draftHashSent?: string | null; at?: Date } = {},
): Promise<void> {
  const outcome = extra.outcomeCode ?? null;
  await db.insert(opsApprovalEvents).values({
    approvalId,
    event,
    actorLabel: actor.label.slice(0, 200),
    ip: actor.ip ? actor.ip.slice(0, 64) : null,
    userAgent: actor.userAgent ? actor.userAgent.slice(0, 256) : null,
    draftHashApproved: extra.draftHashApproved ?? null,
    draftHashSent: extra.draftHashSent ?? null,
    outcomeCode: outcome !== null && OUTCOME_CODE.test(outcome) ? outcome : null,
    ...(extra.at ? { at: extra.at } : {}),
  });
}

export type Proposal<K extends ApprovalKind = ApprovalKind> = {
  kind: K;
  subjectClinicId: string | null;
  subjectRef: string;
  payload: Payloads[K];
};

/**
 * Propose one item, at most once per subject: nothing is inserted while an
 * item for the same kind and subject is waiting, or was ever approved,
 * rejected or expired (the owner said no, or let it lapse; a new episode of
 * the same failure carries a new subject reference). An item whose operation
 * ran (executed or failed) does not block a new one: the subject failed
 * again. The partial unique index is the guard against two proposers racing;
 * a lost race is "not proposed", never an error. Returns the new id or null.
 */
export async function propose(proposal: Proposal, now: Date): Promise<string | null> {
  const spec = KIND_SPECS[proposal.kind];
  return unsafeDb.transaction(async (tx) => {
    const [seen] = await tx
      .select({ id: opsApprovals.id })
      .from(opsApprovals)
      .where(
        and(
          eq(opsApprovals.kind, proposal.kind),
          eq(opsApprovals.subjectRef, proposal.subjectRef),
          inArray(opsApprovals.status, ["waiting", "approved", "rejected", "expired"]),
        ),
      )
      .limit(1);
    if (seen) return null;
    const [row] = await tx
      .insert(opsApprovals)
      .values({
        kind: proposal.kind,
        subjectClinicId: proposal.subjectClinicId,
        subjectRef: proposal.subjectRef,
        payload: proposal.payload as Record<string, string | number | boolean | null>,
        dueAt: new Date(now.getTime() + spec.dueHours * HOUR_MS),
        expiresAt: spec.expiryDays === null ? null : new Date(now.getTime() + spec.expiryDays * DAY_MS),
        urgency: spec.urgency,
        proposedBy: PROPOSER,
        proposedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: opsApprovals.id });
    if (!row) return null;
    await recordEvent(tx, row.id, "proposed", SERVICE_ACTOR, { at: now });
    return row.id;
  });
}

/**
 * Move one item from the status it is expected to hold, recording the event
 * in the same transaction. False when the item was not in that status: a
 * second decision, a decision that lost to the expiry, or the reverse.
 */
export async function moveStatus(
  id: string,
  from: ApprovalStatus,
  to: ApprovalStatus,
  event: ApprovalEventName,
  actor: EventActor,
  now: Date,
  extra: { outcomeCode?: string | null; draftHashApproved?: string | null; draftHashSent?: string | null } = {},
): Promise<boolean> {
  return unsafeDb.transaction(async (tx) => {
    const code = extra.outcomeCode ?? null;
    const moved = await tx
      .update(opsApprovals)
      .set({
        status: to,
        ...(from === "waiting" ? { decidedAt: now } : {}),
        outcomeCode: code !== null && OUTCOME_CODE.test(code) ? code : null,
      })
      .where(and(eq(opsApprovals.id, id), eq(opsApprovals.status, from)))
      .returning({ id: opsApprovals.id });
    if (moved.length === 0) return false;
    await recordEvent(tx, id, event, actor, { ...extra, at: now });
    return true;
  });
}

/** Every waiting item past its window, moved to `expired` with its event. Never runs one. */
export async function expireDue(now: Date): Promise<number> {
  const due = await unsafeDb
    .select({ id: opsApprovals.id })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.status, "waiting"), lte(opsApprovals.expiresAt, now)));
  let expired = 0;
  for (const { id } of due) {
    if (await moveStatus(id, "waiting", "expired", "expired", SERVICE_ACTOR, now, { outcomeCode: "window_passed" })) {
      expired += 1;
    }
  }
  return expired;
}

export async function getApproval(id: string): Promise<OpsApproval | null> {
  const [row] = await unsafeDb.select().from(opsApprovals).where(eq(opsApprovals.id, id)).limit(1);
  return row ?? null;
}

export async function listByStatus(statuses: readonly ApprovalStatus[], limit: number): Promise<OpsApproval[]> {
  return unsafeDb
    .select()
    .from(opsApprovals)
    .where(inArray(opsApprovals.status, [...statuses]))
    .orderBy(asc(opsApprovals.dueAt), asc(opsApprovals.proposedAt))
    .limit(limit);
}

export async function waitingItems(): Promise<OpsApproval[]> {
  return unsafeDb.select().from(opsApprovals).where(eq(opsApprovals.status, "waiting")).orderBy(asc(opsApprovals.dueAt));
}

/** How many `reminded` events an item has, and when the last was. */
export async function reminders(id: string): Promise<{ count: number; last: Date | null }> {
  const [row] = await unsafeDb
    .select({ n: sql<number>`count(*)::int`, last: sql<Date | null>`max(${opsApprovalEvents.at})` })
    .from(opsApprovalEvents)
    .where(and(eq(opsApprovalEvents.approvalId, id), eq(opsApprovalEvents.event, "reminded")));
  return { count: row?.n ?? 0, last: row?.last ? new Date(row.last) : null };
}

export type HistoryRow = {
  id: string;
  approvalId: string;
  kind: ApprovalKind;
  subjectClinicId: string | null;
  event: ApprovalEventName;
  actorLabel: string;
  ip: string | null;
  userAgent: string | null;
  draftHashApproved: string | null;
  draftHashSent: string | null;
  outcomeCode: string | null;
  at: Date;
};

/** The record, newest first, with each event's item kind: never a draft. */
export async function history(limit: number, kind?: ApprovalKind): Promise<HistoryRow[]> {
  const rows = await unsafeDb
    .select({
      id: opsApprovalEvents.id,
      approvalId: opsApprovalEvents.approvalId,
      kind: opsApprovals.kind,
      subjectClinicId: opsApprovals.subjectClinicId,
      event: opsApprovalEvents.event,
      actorLabel: opsApprovalEvents.actorLabel,
      ip: opsApprovalEvents.ip,
      userAgent: opsApprovalEvents.userAgent,
      draftHashApproved: opsApprovalEvents.draftHashApproved,
      draftHashSent: opsApprovalEvents.draftHashSent,
      outcomeCode: opsApprovalEvents.outcomeCode,
      at: opsApprovalEvents.at,
    })
    .from(opsApprovalEvents)
    .innerJoin(opsApprovals, eq(opsApprovals.id, opsApprovalEvents.approvalId))
    .where(kind ? eq(opsApprovals.kind, kind) : undefined)
    .orderBy(desc(opsApprovalEvents.at), desc(opsApprovalEvents.id))
    .limit(limit);
  return rows;
}
