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
 * For a clinic that is not a covered entity, BAA 1.3.0's clause "Where
 * Practice is not a covered entity" governs where it differs, and it
 * shortens (b): healdesk tells the practice of a breach "immediately
 * following discovery" wherever a state law requires a business holding data
 * for its owner to tell the owner that soon, as California's does (Cal. Civ.
 * Code 1798.82(b)). Here that is 24 hours from discovery.
 *
 * A clock that lives in someone's memory is a clock that is missed. Opening
 * an incident computes `notify_by` from the class, the discovery time and
 * the clinic's covered-entity status; the console lists open incidents with
 * the deadline; resolving one records how the clinic was told. For a clinic
 * that is not a covered entity, a breach also gets `ftc_notify_by`, 30 days
 * from discovery: California's deadline for the owner of the data, which is
 * the clinic, to notify the people affected (Cal. Civ. Code
 * 1798.82(a)(2)(A)), the strictest owner clock among the states (decision of
 * 3 October 2026). The clause commits healdesk to help the practice meet it.
 * The column's name predates two corrections: the FTC Health Breach
 * Notification Rule (16 CFR 318.2) reaches vendors of personal health
 * records, not a clinic's booking records (docs/incident-response.md,
 * 1 October 2026), and the clock it held was 60 days until 3 October 2026.
 * Covered clinics keep the BAA's clocks and get no second one.
 *
 * Nothing here holds patient data: a summary in ids, and a conversation id
 * where the transcript is the evidence — never the transcript.
 */

export type IncidentClass = "security_incident" | "improper_use_or_disclosure" | "breach" | "service_complaint";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Immediately following discovery", as a deadline the console can show. */
const IMMEDIATELY_MS = DAY_MS;

/** California's clock for the owner of the data to notify the people affected. */
const OWNER_NOTICE_DAYS = 30;

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

/**
 * When the clinic must be told. The status is required, not defaulted: a
 * caller that forgot it would silently get the covered clock, five days
 * where the agreement promises one.
 */
export function notifyDeadline(cls: IncidentClass, discoveredAt: Date, isCoveredEntity: boolean | null): Date {
  switch (cls) {
    case "breach":
      // Not a covered entity: the state-law clause's "immediately".
      return isCoveredEntity === false
        ? new Date(discoveredAt.getTime() + IMMEDIATELY_MS)
        : new Date(discoveredAt.getTime() + 5 * DAY_MS);
    case "improper_use_or_disclosure":
    case "security_incident":
      return addBusinessDays(discoveredAt, 5);
    case "service_complaint":
      // Not a BAA clock; a service promise. Two business days to a first reply.
      return addBusinessDays(discoveredAt, 2);
  }
}

/**
 * The second clock, stored in `ftc_notify_by`: the day by which a clinic
 * that is not a covered entity must itself notify the people a breach
 * affected. Null for every other incident, and for a covered clinic.
 */
export function ownerNotifyDeadline(cls: IncidentClass, discoveredAt: Date, isCoveredEntity: boolean | null): Date | null {
  return cls === "breach" && isCoveredEntity === false
    ? new Date(discoveredAt.getTime() + OWNER_NOTICE_DAYS * DAY_MS)
    : null;
}

export type OpenIncidentInput = {
  class: IncidentClass;
  summary: string;
  conversationId?: string | null;
  discoveredAt?: Date;
  openedBy: string;
  /**
   * From clinics.is_covered_entity. For a breach, false shortens the clinic's
   * clock to 24 hours and adds the owner's 30-day clock.
   */
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
      notifyBy: notifyDeadline(input.class, discoveredAt, input.isCoveredEntity),
      ftcNotifyBy: ownerNotifyDeadline(input.class, discoveredAt, input.isCoveredEntity),
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
