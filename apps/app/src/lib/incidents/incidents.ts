import { and, eq, isNull, lt } from "drizzle-orm";

import { incidents } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Incidents: the BAA's promises as rows with deadlines.
 *
 * The agreement (packages/catalog/src/baa.ts, "Reporting breaches and
 * security incidents") commits healdesk to tell the clinic:
 *
 *   a. within FIVE BUSINESS DAYS of becoming aware of any use or disclosure
 *      the agreement does not permit;
 *   b. within FIVE CALENDAR DAYS of discovering a breach of unsecured PHI;
 *   c. within five business days of any security incident.
 *
 * A clock that lives in someone's memory is a clock that is missed. Opening
 * an incident computes `notify_by` from the class and the discovery time;
 * the console lists open incidents with the deadline; resolving one records
 * how the clinic was told. For a clinic that is not a covered entity, a
 * breach also gets `ftc_notify_by`, 60 days from discovery. The column's name
 * predates a correction: the FTC Health Breach Notification Rule (16 CFR
 * 318.2) reaches vendors of personal health records, not a clinic's booking
 * records, so the second clock is a conservative floor under state
 * breach-notification law, not the Rule's own deadline (docs/incident-
 * response.md, 1 October 2026).
 *
 * Nothing here holds patient data: a summary in ids, and a conversation id
 * where the transcript is the evidence — never the transcript.
 */

export type IncidentClass = "security_incident" | "improper_use_or_disclosure" | "breach" | "service_complaint";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Five business days, skipping Saturday and Sunday in UTC. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export function notifyDeadline(cls: IncidentClass, discoveredAt: Date): Date {
  switch (cls) {
    case "breach":
      return new Date(discoveredAt.getTime() + 5 * DAY_MS);
    case "improper_use_or_disclosure":
    case "security_incident":
      return addBusinessDays(discoveredAt, 5);
    case "service_complaint":
      // Not a BAA clock; a service promise. Two business days to a first reply.
      return addBusinessDays(discoveredAt, 2);
  }
}

export type OpenIncidentInput = {
  class: IncidentClass;
  summary: string;
  conversationId?: string | null;
  discoveredAt?: Date;
  openedBy: string;
  /** From clinics.is_covered_entity; false adds the FTC clock for a breach. */
  isCoveredEntity: boolean | null;
};

export async function openIncident(tx: TenantTx, input: OpenIncidentInput) {
  const discoveredAt = input.discoveredAt ?? new Date();
  const [row] = await tx.db
    .insert(incidents)
    .values({
      clinicId: tx.clinicId,
      class: input.class,
      summary: input.summary.slice(0, 2000),
      conversationId: input.conversationId ?? null,
      discoveredAt,
      notifyBy: notifyDeadline(input.class, discoveredAt),
      ftcNotifyBy:
        input.class === "breach" && input.isCoveredEntity === false
          ? new Date(discoveredAt.getTime() + 60 * DAY_MS)
          : null,
      openedBy: input.openedBy,
    })
    .returning();
  tx.audit.record({
    action: "create",
    resourceType: "incident",
    resourceId: row!.id,
    metadata: { class: input.class, conversationId: input.conversationId ?? undefined },
  });
  return row!;
}

export async function markNotified(tx: TenantTx, id: string, how: string) {
  const [row] = await tx.db
    .update(incidents)
    .set({ notifiedAt: new Date(), notifiedHow: how.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(incidents.id, id), eq(incidents.clinicId, tx.clinicId)))
    .returning();
  if (row) tx.audit.record({ action: "update", resourceType: "incident", resourceId: id, metadata: { notified: true } });
  return row ?? null;
}

export async function resolveIncident(tx: TenantTx, id: string, resolution: string) {
  const [row] = await tx.db
    .update(incidents)
    .set({ resolvedAt: new Date(), resolution: resolution.slice(0, 2000), updatedAt: new Date() })
    .where(and(eq(incidents.id, id), eq(incidents.clinicId, tx.clinicId), isNull(incidents.resolvedAt)))
    .returning();
  if (row) tx.audit.record({ action: "update", resourceType: "incident", resourceId: id, metadata: { resolved: true } });
  return row ?? null;
}

export async function listIncidents(tx: TenantTx, options: { openOnly?: boolean } = {}) {
  return tx.db
    .select()
    .from(incidents)
    .where(
      options.openOnly
        ? and(eq(incidents.clinicId, tx.clinicId), isNull(incidents.resolvedAt))
        : eq(incidents.clinicId, tx.clinicId),
    );
}

/** Open incidents past their clinic-notification deadline with no notification recorded. */
export async function overdueIncidents(tx: TenantTx, now: Date = new Date()) {
  return tx.db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.clinicId, tx.clinicId),
        isNull(incidents.resolvedAt),
        isNull(incidents.notifiedAt),
        lt(incidents.notifyBy, now),
      ),
    );
}
