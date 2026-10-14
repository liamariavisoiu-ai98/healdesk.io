import { and, eq, isNull, lt } from "drizzle-orm";

import { incidents } from "@/db/schema";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import type { TenantTx } from "@/lib/tenant";

import { addBusinessDays, agreementReportDeadline } from "./reporting-rules";

export { addBusinessDays } from "./reporting-rules";

/**
 * Incidents: the BAA's promises as rows with deadlines.
 *
 * The agreement (packages/catalog/src/baa.ts, "Reporting breaches and
 * security incidents") commits healdesk to tell the clinic of:
 *
 *   a. any use or disclosure of PHI the agreement does not permit;
 *   b. any breach of unsecured PHI;
 *   c. any security incident, a state-law breach of security included.
 *
 * Since BAA 1.2.2 (owner, 9 October 2026), and in BAA 1.3.0 and the DPA draft,
 * it promises each "without unreasonable delay and in no case later than 60
 * calendar days" after discovery, the product spec's wording. The clock this
 * file keeps is stricter, and stays so on purpose: 24 hours from discovery
 * for all three classes at every clinic, whichever version it signed, as an
 * operating target the agreements no longer state (docs/incident-response.md).
 * It meets every version's promise, and a covered clinic's own sixty-day
 * clock to notify patients may run from our discovery, so a report near our
 * outer limit could leave it no time. For a breach at a clinic that is not a
 * covered entity, a state law can ask for notice "immediately following
 * discovery", as California's does of a business holding data for its owner
 * (Cal. Civ. Code 1798.82(b)); the 24 hours is what meets that now, since the
 * agreement no longer says it, and whichever of the two clocks is earlier is
 * the one kept.
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
 * Two deadlines, then, and the console shows both (WP7): the agreement's
 * own, `agreement_notify_by`, stamped at opening from the agreement in
 * effect (lib/incidents/reporting-rules.ts), which is the promise; and
 * `notify_by`, the internal target, which the hourly incident-deadlines job
 * chases. Never present the second as the first: no page, email or
 * agreement may promise "24 hours" (owner, 12 October 2026).
 *
 * Ops then decides, once, for an incident the agreement covers: send the
 * report (L29, built from fixed fields only and queued through the outbox,
 * lib/notices/operator-notices.ts), or record it as not reportable, with the
 * reason, such as a routine unsuccessful attempt the clause already reports
 * once. Nothing reaches a clinic unless ops sends it. A report can be added
 * to as more is learned, as the agreement says, so each one counts.
 *
 * Nothing here holds patient data: a summary in ids, and a conversation id
 * where the transcript is the evidence — never the transcript.
 */

export type IncidentClass = "security_incident" | "improper_use_or_disclosure" | "breach" | "service_complaint";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Our deadline for (a), (b) and (c), stricter than the agreement's: 24 hours from discovery. */
const REPORT_WITHIN_MS = DAY_MS;

/** "Immediately following discovery", as a deadline the console can show. */
const IMMEDIATELY_MS = DAY_MS;

/** California's clock for the owner of the data to notify the people affected. */
const OWNER_NOTICE_DAYS = 30;

/**
 * When the clinic must be told: discovery plus 24 hours for a breach, a
 * security incident and an improper use or disclosure, at every clinic,
 * covered entity or not. The status is required, not defaulted: for a breach
 * at a clinic that is not a covered entity the state-law clock runs too, and
 * the earlier of the two is kept, so a caller that forgot the status would
 * miss that clock the day it became the shorter one.
 */
export function notifyDeadline(cls: IncidentClass, discoveredAt: Date, isCoveredEntity: boolean | null): Date {
  switch (cls) {
    case "breach":
    case "improper_use_or_disclosure":
    case "security_incident": {
      // A breach at a clinic that is not a covered entity also runs the
      // state-law clause's "immediately"; the earlier of the two is kept.
      const stateLaw = cls === "breach" && isCoveredEntity === false;
      return new Date(discoveredAt.getTime() + (stateLaw ? Math.min(REPORT_WITHIN_MS, IMMEDIATELY_MS) : REPORT_WITHIN_MS));
    }
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
   * From clinics.is_covered_entity. For a breach, false adds the owner's
   * 30-day clock, and the state-law clock wherever it is shorter than the
   * 24 hours every clinic gets.
   */
  isCoveredEntity: boolean | null;
};

export async function openIncident(tx: TenantTx, input: OpenIncidentInput) {
  const discoveredAt = input.discoveredAt ?? new Date();
  // The agreement in effect now is the one in effect at discovery for any
  // incident opened promptly; the deadline is fixed here, so a later
  // re-signing never moves the promise an open incident was made under.
  const version = (await agreementInEffect(tx))?.documentVersion ?? null;
  const agreement = agreementReportDeadline(input.class, discoveredAt, version);
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
      agreementNotifyBy: agreement.notifyBy,
      agreementVersion: version,
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

/**
 * Open incidents past their clinic-notification deadline with no
 * notification recorded, and none recorded as not reportable: an incident
 * ops decided owes the clinic nothing has no notice to chase.
 */
export async function overdueIncidents(tx: TenantTx, now: Date = new Date()) {
  return tx.db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.clinicId, tx.clinicId),
        isNull(incidents.resolvedAt),
        isNull(incidents.notifiedAt),
        isNull(incidents.notReportableAt),
        lt(incidents.notifyBy, now),
      ),
    );
}

export type IncidentDecisionRefusal =
  | "no_such_incident"
  | "resolved"
  | "not_reportable_class"
  | "already_not_reportable"
  | "already_reported";

/**
 * The incident, locked for its decision, or why no decision can be taken on
 * it: a resolved incident is closed, a service complaint is no agreement's
 * to report, and one decision excludes the other.
 */
export async function incidentForDecision(
  tx: TenantTx,
  id: string,
  decision: "report" | "not_reportable",
): Promise<{ row: typeof incidents.$inferSelect } | { refused: IncidentDecisionRefusal }> {
  const [row] = await tx.db
    .select()
    .from(incidents)
    .where(and(eq(incidents.id, id), eq(incidents.clinicId, tx.clinicId)))
    .for("update");
  if (!row) return { refused: "no_such_incident" };
  if (row.resolvedAt) return { refused: "resolved" };
  if (row.class === "service_complaint") return { refused: "not_reportable_class" };
  if (row.notReportableAt) return { refused: "already_not_reportable" };
  if (decision === "not_reportable" && row.reportedAt) return { refused: "already_reported" };
  return { row };
}

/**
 * Record that a report (or an update to one) was queued for the clinic, in
 * the transaction that queued it. The first one is also the notice the
 * internal target chases, so it stamps `notified_at` when nothing else has.
 * Returns the report's number, from 1.
 */
export async function recordReportQueued(
  tx: TenantTx,
  id: string,
  input: { noticeId: string; decidedBy: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const [row] = await tx.db
    .select({ reportsSent: incidents.reportsSent, notifiedAt: incidents.notifiedAt, reportedAt: incidents.reportedAt })
    .from(incidents)
    .where(and(eq(incidents.id, id), eq(incidents.clinicId, tx.clinicId)))
    .limit(1);
  if (!row) throw new Error("No such incident at this clinic.");
  const n = row.reportsSent + 1;
  await tx.db
    .update(incidents)
    .set({
      reportsSent: n,
      reportedAt: row.reportedAt ?? now,
      decidedBy: input.decidedBy.slice(0, 320),
      ...(row.notifiedAt
        ? {}
        : {
            notifiedAt: now,
            notifiedHow: `Report emailed to the practice's address from the incidents page (notice ${input.noticeId})`,
          }),
      updatedAt: now,
    })
    .where(and(eq(incidents.id, id), eq(incidents.clinicId, tx.clinicId)));
  tx.audit.record({
    action: "update",
    resourceType: "incident",
    resourceId: id,
    metadata: { reported: true, report: n, noticeId: input.noticeId },
  });
  return n;
}

/**
 * Record that an incident owes the clinic no report, and why. The reason is
 * operator prose, PHI-scanned by the caller before it gets here.
 */
export async function recordNotReportable(
  tx: TenantTx,
  id: string,
  input: { reason: string; decidedBy: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const [row] = await tx.db
    .update(incidents)
    .set({
      notReportableAt: now,
      notReportableReason: input.reason.slice(0, 2000),
      decidedBy: input.decidedBy.slice(0, 320),
      updatedAt: now,
    })
    .where(
      and(
        eq(incidents.id, id),
        eq(incidents.clinicId, tx.clinicId),
        isNull(incidents.reportedAt),
        isNull(incidents.notReportableAt),
        isNull(incidents.resolvedAt),
      ),
    )
    .returning();
  if (row) {
    tx.audit.record({
      action: "update",
      resourceType: "incident",
      resourceId: id,
      metadata: { notReportable: true },
    });
  }
  return row ?? null;
}
