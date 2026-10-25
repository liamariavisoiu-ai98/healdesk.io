import { and, asc, eq } from "drizzle-orm";

import { incidentChecklistTicks, incidents } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { CHECKLIST_STEPS, type ChecklistStep } from "./vocab";

/**
 * An incident's checklist (design E6 §3 item 17): each step of
 * docs/incident-response.md's procedure ticked once, add-only
 * (incident_checklist_ticks, drizzle/0124). A tick records that a person
 * did the step, never what they wrote: the step's code, the operator
 * account, the database's time, and for the affected list, how many people
 * the incident's list names now (incidents.affected_recorded), never who.
 *
 * Two steps are facts the incident row already holds, so they are ticked
 * only when it holds them: `notify_email` once a report went or a notice was
 * recorded, `resolve` once the incident is resolved. A tick never does the
 * step: it records it.
 */

export type TickRefusal = "no_such_incident" | "not_notified_yet" | "not_resolved_yet";

export type TickOutcome =
  | { status: "ticked"; step: ChecklistStep; tickedAt: Date; affectedCount: number | null }
  | { status: "already"; step: ChecklistStep; tickedAt: Date }
  | { status: "refused"; refusal: TickRefusal };

export async function tickStep(
  tx: TenantTx,
  input: { incidentId: string; step: ChecklistStep; tickedBy: string; batchKey?: string },
): Promise<TickOutcome> {
  const [incident] = await tx.db
    .select({
      id: incidents.id,
      reportedAt: incidents.reportedAt,
      notifiedAt: incidents.notifiedAt,
      resolvedAt: incidents.resolvedAt,
      affectedRecorded: incidents.affectedRecorded,
    })
    .from(incidents)
    .where(and(eq(incidents.id, input.incidentId), eq(incidents.clinicId, tx.clinicId)))
    .limit(1);
  if (!incident) return { status: "refused", refusal: "no_such_incident" };
  if (input.step === "notify_email" && !incident.reportedAt && !incident.notifiedAt) {
    return { status: "refused", refusal: "not_notified_yet" };
  }
  if (input.step === "resolve" && !incident.resolvedAt) return { status: "refused", refusal: "not_resolved_yet" };
  const affectedCount = input.step === "affected_list_recorded" ? incident.affectedRecorded : null;
  const [row] = await tx.db
    .insert(incidentChecklistTicks)
    .values({
      clinicId: tx.clinicId,
      incidentId: incident.id,
      step: input.step,
      affectedCount,
      batchKey: input.batchKey ?? null,
      tickedBy: input.tickedBy,
    })
    .onConflictDoNothing({ target: [incidentChecklistTicks.incidentId, incidentChecklistTicks.step] })
    .returning({ tickedAt: incidentChecklistTicks.tickedAt });
  if (!row) {
    const [seen] = await tx.db
      .select({ tickedAt: incidentChecklistTicks.tickedAt })
      .from(incidentChecklistTicks)
      .where(and(eq(incidentChecklistTicks.incidentId, incident.id), eq(incidentChecklistTicks.step, input.step)))
      .limit(1);
    return { status: "already", step: input.step, tickedAt: seen!.tickedAt };
  }
  tx.audit.record({
    action: "update",
    resourceType: "incident",
    resourceId: incident.id,
    metadata: { checklistStep: input.step },
  });
  return { status: "ticked", step: input.step, tickedAt: row.tickedAt, affectedCount };
}

export type ChecklistRow = {
  step: ChecklistStep;
  /** Null while the step is not ticked. */
  tickedAt: string | null;
  tickedBy: string | null;
  affectedCount: number | null;
  /** Ticked by an approved batch that opened the incident. */
  fromBatch: boolean;
};

/** Every step in the procedure's order, ticked or not. */
export async function checklistOf(tx: TenantTx, incidentId: string): Promise<ChecklistRow[] | null> {
  const [incident] = await tx.db
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), eq(incidents.clinicId, tx.clinicId)))
    .limit(1);
  if (!incident) return null;
  const ticks = await tx.db
    .select()
    .from(incidentChecklistTicks)
    .where(and(eq(incidentChecklistTicks.clinicId, tx.clinicId), eq(incidentChecklistTicks.incidentId, incidentId)))
    .orderBy(asc(incidentChecklistTicks.tickedAt));
  const byStep = new Map(ticks.map((t) => [t.step, t]));
  return CHECKLIST_STEPS.map((step) => {
    const t = byStep.get(step);
    return {
      step,
      tickedAt: t ? t.tickedAt.toISOString() : null,
      tickedBy: t ? t.tickedBy : null,
      affectedCount: t ? t.affectedCount : null,
      fromBatch: t ? t.batchKey !== null : false,
    };
  });
}

/** The batch-opened incident at this clinic under this key, if one was opened. */
export async function incidentOpenedBy(tx: TenantTx, batchKey: string): Promise<string | null> {
  const [row] = await tx.db
    .select({ incidentId: incidentChecklistTicks.incidentId })
    .from(incidentChecklistTicks)
    .where(and(eq(incidentChecklistTicks.clinicId, tx.clinicId), eq(incidentChecklistTicks.batchKey, batchKey)))
    .limit(1);
  return row?.incidentId ?? null;
}
