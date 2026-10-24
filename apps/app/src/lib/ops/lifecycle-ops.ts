import { eq, inArray } from "drizzle-orm";

import { unsafeDb } from "@/db";

import { clinicLifecycle, opsAlerts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { readLedger } from "@/lib/lifecycle/ledger";
import { lifecycleView, type LifecycleView } from "@/lib/lifecycle/view";
import { readLifecycleRow } from "@/lib/lifecycle/watch";
import { describeError, log } from "@/lib/log";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import {
  actorFor,
  audit,
  clinicById,
  numberArg,
  ok,
  opsProblem,
  stringArg,
  UUID_SHAPED,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The lifecycle watch's ops operations (design E2; lib/lifecycle), kept beside
 * the ops API's dispatch rather than in it. Ids, counts, dates, closed words
 * and the clinic's name; never a patient, never a notice's words.
 *
 *   - `listLifecycle {clinicId?}`, a read: every billing clinic the watch has
 *     seen (or only the one named), its stage, steps left, days left,
 *     decision, snooze and the recommendation, those owing a decision first. healdesk's demo clinic is never in it:
 *     the watch never observes its `demo` billing row, so it has no row. A
 *     paying clinic still classed synthetic before it goes live is a real
 *     one and is shown.
 *   - `listLifecycleWaves {clinicId}`, a read: the clinic's reminder ledger,
 *     each wave with its target, outcome and provider id, and for an ops
 *     wave the event of the alert that carried it.
 *   - `snoozeLifecycle {clinicId, days: 3 | 7 | 14}`: mutes the clinic's ops
 *     waves until then. Never the clinic's own reminders.
 *   - `decideLifecycle {clinicId, decision}`: none, extension_offered or
 *     let_close (which stops the day-27 and day-30 waves). `extended` is not
 *     set here: the watch sets it when the deadline moves, which only
 *     extendSetupDeadline does.
 *
 * Each write records an audit row in the clinic's tenant and a security event
 * naming the operator, like its neighbours.
 */

export const SNOOZE_DAYS = [3, 7, 14] as const;
export const OPERATOR_DECISIONS = ["none", "extension_offered", "let_close"] as const;
type OperatorDecision = (typeof OPERATOR_DECISIONS)[number];

const DAY_MS = 86_400_000;

export type LifecycleListRow = Omit<
  LifecycleView,
  "stageSince" | "lastProgressAt" | "deadlineAt" | "decidedAt" | "snoozedUntil"
> & {
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  stageSince: string;
  lastProgressAt: string | null;
  deadlineAt: string | null;
  decidedAt: string | null;
  snoozedUntil: string | null;
};

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const STAGE_ORDER = ["waiting_on_us", "in_setup", "not_started", "partly_live", "live", "closed"];

/** One watched clinic and its lifecycle view. */
export type WatchedLifecycle = { clinic: ClinicOverview; view: LifecycleView };

/**
 * The lifecycle view of every billing clinic the watch has seen, or of the
 * one named (any other id reads nothing), each in its own tenant, under the
 * caller's actor. Locations and destroyed clinics have none. A clinic that
 * cannot be read throws, unless `partial` is set: then it is counted in
 * `failed` and the rest are still returned (Home's "Needs a decision" rows,
 * which must not lose every clinic to one).
 */
export async function readLifecycleViews(options: {
  actor: ActorContext;
  request?: RequestContext;
  now: Date;
  clinicId?: string;
  partial?: boolean;
}): Promise<{ views: WatchedLifecycle[]; failed: number }> {
  const views: WatchedLifecycle[] = [];
  let failed = 0;
  const wanted = options.clinicId?.toLowerCase();
  for (const clinic of await listClinics()) {
    if (wanted !== undefined && clinic.id !== wanted) continue;
    if (clinic.billingClinicId || clinic.destroyedAt) continue;
    try {
      const view = await withTenant(
        { clinicId: clinic.id, actor: options.actor, request: options.request },
        async (tx) => {
          const row = await readLifecycleRow(tx);
          if (!row) return null;
          return lifecycleView(row, await readLedger(tx), clinic.timezone, options.now);
        },
      );
      if (view) views.push({ clinic, view });
    } catch (error) {
      if (!options.partial) throw error;
      failed += 1;
      log.warn("lifecycle view not read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return { views, failed };
}

export async function opListLifecycle(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const raw = args.clinicId;
  if (raw !== undefined && (typeof raw !== "string" || !UUID_SHAPED.test(raw))) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  try {
    const rows: LifecycleListRow[] = [];
    const { views } = await readLifecycleViews({
      actor: actorFor(operator),
      request: operator.request,
      now,
      clinicId: raw,
    });
    for (const { clinic, view: seen } of views) {
      rows.push({
        ...seen,
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        stageSince: seen.stageSince.toISOString(),
        lastProgressAt: iso(seen.lastProgressAt),
        deadlineAt: iso(seen.deadlineAt),
        decidedAt: iso(seen.decidedAt),
        snoozedUntil: iso(seen.snoozedUntil),
      });
    }
    rows.sort(
      (a, b) =>
        Number(b.decisionOwed) - Number(a.decisionOwed) ||
        STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
        (a.remainingDays ?? 99) - (b.remainingDays ?? 99) ||
        a.clinicName.localeCompare(b.clinicName),
    );
    return ok({ clinics: rows });
  } catch (error) {
    log.error("lifecycle list failed", { error: describeError(error) });
    return opsProblem("The lifecycle list could not be read.", 500, "failed");
  }
}

export async function opListLifecycleWaves(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId");
  if (!clinicId || !UUID_SHAPED.test(clinicId))
    return opsProblem("A clinic id is required.", 400, "invalid_args");
  const clinic = await clinicById(clinicId);
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  try {
    const waves = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => readLedger(tx),
    );
    // The event of the alert each ops wave carried (day_22 a decision or a
    // closing-soon, say), from the ops log, which is not a tenant table.
    const alertIds = [...new Set(waves.flatMap((w) => (w.opsAlertId ? [w.opsAlertId] : [])))];
    const events = new Map<string, string>();
    if (alertIds.length > 0) {
      const found = await unsafeDb
        .select({ id: opsAlerts.id, event: opsAlerts.event })
        .from(opsAlerts)
        .where(inArray(opsAlerts.id, alertIds));
      for (const { id, event } of found) events.set(id, event);
    }
    return ok({
      waves: waves.map((w) => ({
        id: w.id,
        stage: w.stage,
        wave: w.wave,
        target: w.target,
        queuedAt: w.queuedAt.toISOString(),
        sentAt: iso(w.sentAt),
        outcome: w.outcome,
        providerId: w.providerId,
        escalated: w.escalated,
        event: w.opsAlertId ? (events.get(w.opsAlertId) ?? null) : null,
        manualBy: w.manualBy,
        skippedBecause: w.outcome === "skipped" ? w.error : null,
      })),
    });
  } catch (error) {
    log.error("lifecycle waves not read", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The clinic's reminders could not be read.", 500, "failed");
  }
}

type WriteOutcome = { outcome: "saved" } | { outcome: "not_watched" };

/** Change the clinic's row under its own tenant, with an audit row; not_watched before the watch has seen it. */
async function writeRow(
  clinicId: string,
  operator: Operator,
  set: Partial<typeof clinicLifecycle.$inferInsert>,
  metadata: Record<string, unknown>,
): Promise<WriteOutcome> {
  return withTenant(
    { clinicId, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const updated = await tx.db
        .update(clinicLifecycle)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(clinicLifecycle.clinicId, tx.clinicId))
        .returning({ clinicId: clinicLifecycle.clinicId });
      if (updated.length === 0) return { outcome: "not_watched" };
      tx.audit.record({
        action: "update",
        resourceType: "clinic_lifecycle",
        resourceId: clinicId,
        metadata,
      });
      return { outcome: "saved" };
    },
  );
}

export async function opSnoozeLifecycle(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const days = numberArg(args, "days");
  if (!(SNOOZE_DAYS as readonly number[]).includes(days ?? NaN)) {
    return opsProblem("Snooze for 3, 7 or 14 days.", 400, "invalid_args");
  }
  const until = new Date(now.getTime() + days! * DAY_MS);
  try {
    const result = await writeRow(
      clinic.id,
      operator,
      { snoozedUntil: until, snoozedBy: operator.email.slice(0, 200) },
      { field: "snoozed_until", days },
    );
    if (result.outcome !== "saved") return ok(result);
    const auditRecorded = await audit(operator, "lifecycle_snoozed", {
      clinicSlug: clinic.slug,
      days,
    });
    return ok({ outcome: "saved", snoozedUntil: until.toISOString(), auditRecorded });
  } catch (error) {
    log.error("lifecycle snooze failed", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The snooze could not be saved.", 500, "failed");
  }
}

export async function opDecideLifecycle(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const decision = stringArg(args, "decision");
  if (!(OPERATOR_DECISIONS as readonly string[]).includes(decision ?? "")) {
    return opsProblem(
      "Decide none, extension_offered or let_close. An extension is recorded when the deadline moves.",
      400,
      "invalid_args",
    );
  }
  const chosen = decision as OperatorDecision;
  try {
    const result = await writeRow(
      clinic.id,
      operator,
      chosen === "none"
        ? { decision: "none", decidedBy: null, decidedAt: null }
        : { decision: chosen, decidedBy: operator.email.slice(0, 200), decidedAt: now },
      { field: "decision", decision: chosen },
    );
    if (result.outcome !== "saved") return ok(result);
    const auditRecorded = await audit(operator, "lifecycle_decided", {
      clinicSlug: clinic.slug,
      decision: chosen,
    });
    return ok({ outcome: "saved", decision: chosen, auditRecorded });
  } catch (error) {
    log.error("lifecycle decision failed", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The decision could not be saved.", 500, "failed");
  }
}
