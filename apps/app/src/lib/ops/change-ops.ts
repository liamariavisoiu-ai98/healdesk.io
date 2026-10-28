import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";

import {
  clinicChangeEvents,
  type ClinicChangeActor,
  type ClinicChangeAuditStatus,
  type ClinicChangeEventRow,
  type ClinicChangeKind,
  type ClinicChangeSource,
  type ClinicChangeSummary,
} from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { audit, ok, opsProblem, stringArg, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The ops operations for clinics' availability changes (design E4 §3.C;
 * lib/clinic/change-events.ts), kept beside the ops API's dispatch.
 *
 *   - `listClinicChanges {clinicId?, since?}`, a read: the changes, newest
 *     first, at most LIST_LIMIT, from `since` (an ISO instant; 30 days back
 *     by default). Kind, source, a coarse kind of actor, counts and the
 *     closed days' dates, the audit's state and the acknowledgement.
 *     Settings changes (kind `setting`, lib/clinic/setting-changes.ts) are
 *     left out unless `includeSettings` is true: the Availability changes
 *     card reads availability alone, and each settings change is already
 *     told to ops by email and Slack on its own.
 *   - `acknowledgeClinicChange {id, clinicId?}`, a write: the operator has
 *     looked at it. Once; a second time says `already`. A security event
 *     names the operator.
 */

export const LIST_LIMIT = 200;
const DEFAULT_DAYS = 30;
const ACTOR = { type: "service", serviceName: "ops-changes" } as const;

export type ClinicChangeView = {
  id: string;
  clinicId: string;
  clinicName: string;
  locationId: string | null;
  kind: ClinicChangeKind;
  source: ClinicChangeSource;
  actorKind: ClinicChangeActor;
  summary: ClinicChangeSummary;
  changedAt: string;
  alertedAt: string | null;
  auditStatus: ClinicChangeAuditStatus | null;
  auditId: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

function view(row: ClinicChangeEventRow, clinicName: string): ClinicChangeView {
  return {
    id: row.id,
    clinicId: row.clinicId,
    clinicName,
    locationId: row.locationId ?? null,
    kind: row.kind,
    source: row.source,
    actorKind: row.actorKind,
    summary: row.summary,
    changedAt: row.changedAt.toISOString(),
    alertedAt: row.alertedAt?.toISOString() ?? null,
    auditStatus: row.auditStatus ?? null,
    auditId: row.auditId ?? null,
    acknowledgedAt: row.opsAcknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: row.opsAcknowledgedBy ?? null,
  };
}

export async function opListClinicChanges(args: Record<string, unknown>): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (clinicId !== undefined && !UUID_SHAPED.test(clinicId)) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  const sinceArg = stringArg(args, "since", 40);
  const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - DEFAULT_DAYS * 86_400_000);
  if (Number.isNaN(since.getTime())) return opsProblem("`since` is an ISO instant.", 400, "invalid_args");
  const includeSettings = args.includeSettings === true;
  try {
    const clinics = (await listClinics()).filter((c) => (clinicId ? c.id === clinicId : c.destroyedAt === null));
    const changes: ClinicChangeView[] = [];
    for (const clinic of clinics) {
      const rows = await withTenant({ clinicId: clinic.id, actor: ACTOR }, (tx) =>
        tx.db
          .select()
          .from(clinicChangeEvents)
          .where(
            and(
              eq(clinicChangeEvents.clinicId, tx.clinicId),
              gte(clinicChangeEvents.changedAt, since),
              includeSettings ? undefined : ne(clinicChangeEvents.kind, "setting"),
            ),
          )
          .orderBy(desc(clinicChangeEvents.changedAt))
          .limit(LIST_LIMIT),
      );
      for (const row of rows) changes.push(view(row, clinic.name));
    }
    changes.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
    return ok({ since: since.toISOString(), changes: changes.slice(0, LIST_LIMIT) });
  } catch (error) {
    log.error("clinic changes not listed", { error: describeError(error) });
    return opsProblem("The changes could not be read.", 500, "failed");
  }
}

export async function opAcknowledgeClinicChange(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const id = stringArg(args, "id", 64);
  if (!id || !UUID_SHAPED.test(id)) return opsProblem("A change id is required.", 400, "invalid_args");
  const clinicId = stringArg(args, "clinicId", 64);
  if (clinicId !== undefined && !UUID_SHAPED.test(clinicId)) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  try {
    const candidates = clinicId
      ? [clinicId]
      : (await listClinics()).filter((c) => c.destroyedAt === null).map((c) => c.id);
    const now = new Date();
    for (const candidate of candidates) {
      const outcome = await withTenant({ clinicId: candidate, actor: ACTOR }, async (tx) => {
        const [row] = await tx.db
          .select({ acknowledgedAt: clinicChangeEvents.opsAcknowledgedAt })
          .from(clinicChangeEvents)
          .where(and(eq(clinicChangeEvents.clinicId, tx.clinicId), eq(clinicChangeEvents.id, id)))
          .limit(1);
        if (!row) return null;
        if (row.acknowledgedAt) return { status: "already" as const, acknowledgedAt: row.acknowledgedAt };
        const [done] = await tx.db
          .update(clinicChangeEvents)
          .set({ opsAcknowledgedAt: now, opsAcknowledgedBy: operator.email })
          .where(
            and(
              eq(clinicChangeEvents.clinicId, tx.clinicId),
              eq(clinicChangeEvents.id, id),
              isNull(clinicChangeEvents.opsAcknowledgedAt),
            ),
          )
          .returning({ acknowledgedAt: clinicChangeEvents.opsAcknowledgedAt });
        return done?.acknowledgedAt
          ? { status: "acknowledged" as const, acknowledgedAt: done.acknowledgedAt }
          : { status: "already" as const, acknowledgedAt: now };
      });
      if (!outcome) continue;
      const auditRecorded =
        outcome.status === "acknowledged"
          ? await audit(operator, "clinic_change_acknowledged", { clinicId: candidate, changeId: id })
          : true;
      return ok({ status: outcome.status, acknowledgedAt: outcome.acknowledgedAt.toISOString(), auditRecorded });
    }
    return ok({ status: "not_found" });
  } catch (error) {
    log.error("clinic change not acknowledged", { error: describeError(error) });
    return opsProblem("The change could not be acknowledged.", 500, "failed");
  }
}
