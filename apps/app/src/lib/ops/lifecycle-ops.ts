import { eq, inArray } from "drizzle-orm";

import { unsafeDb } from "@/db";

import { clinicLifecycle, opsAlerts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { setupLastDay } from "@/lib/clinic/setup-window";
import {
  LIFECYCLE_IGNORE_NOTES,
  readLifecycleIgnore,
  writeLifecycleIgnore,
  type LifecycleIgnoreNote,
} from "@/lib/lifecycle/ignore";
import { readLedger } from "@/lib/lifecycle/ledger";
import { IGNORED_RECOMMENDATION } from "@/lib/lifecycle/recommend";
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
 *     extendSetupDeadline does, through recordExtension below.
 *   - `setLifecycleIgnored {clinicId, ignored, note?}`: puts a billing clinic
 *     on the watch's ignore list (healdesk's own test accounts) or takes it
 *     off, with a reason from a closed list, never free text.
 *   - `listLifecycleIgnored {clinicId?}`, a read: the clinics on that list,
 *     with the reason, who set it and when.
 *
 * An ignored clinic is still in `listLifecycle` when the watch has a row for
 * it, marked `ignored`, owing no decision and with a recommendation that
 * says it is not watched; Home's decision rows and the digest leave it out.
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
  /** On the ignore list: not watched (internal). */
  ignored: boolean;
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

/** One watched clinic and its lifecycle view; an ignored one owes no decision. */
export type WatchedLifecycle = { clinic: ClinicOverview; view: LifecycleView; ignored: boolean };

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
          const row = await readLifecycleRow(tx, { includeIgnored: true });
          if (!row) return null;
          const seen = lifecycleView(row, await readLedger(tx), clinic.timezone, options.now);
          if ((await readLifecycleIgnore(tx))?.ignored !== true) return { view: seen, ignored: false };
          // Not watched (internal): nothing is owed and nothing is recommended.
          return {
            view: { ...seen, decisionOwed: false, recommendation: { ...IGNORED_RECOMMENDATION } },
            ignored: true,
          };
        },
      );
      if (view) views.push({ clinic, ...view });
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
    for (const { clinic, view: seen, ignored } of views) {
      rows.push({
        ...seen,
        ignored,
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

export type WriteOutcome = { outcome: "saved" } | { outcome: "not_watched" };

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

/**
 * "Extend the setup window" recorded on the lifecycle row at once (lane P5d,
 * the wave 2 follow-up): the new deadline, its last day and the decision
 * `extended`, by the operator, through the same write as decideLifecycle.
 * Without it Home's "decision owed" row stayed until the next watch run, or
 * for good with the watch off. The last day is written too, so the watch's
 * next run does not read a later last day as a second extension and relabel
 * the decision. A clinic the watch has not seen has no row, and none is
 * created: `not_watched`.
 */
export async function recordExtension(
  clinic: Pick<ClinicOverview, "id" | "timezone">,
  operator: Operator,
  deadlineAt: Date,
  now: Date = new Date(),
): Promise<WriteOutcome> {
  return writeRow(
    clinic.id,
    operator,
    {
      deadlineAt,
      lastDay: setupLastDay(deadlineAt, clinic.timezone),
      decision: "extended",
      decidedBy: operator.email.slice(0, 200),
      decidedAt: now,
    },
    { field: "decision", decision: "extended" },
  );
}

export type LifecycleIgnoredRow = {
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  note: LifecycleIgnoreNote | null;
  setBy: string;
  setAt: string;
};

export async function opSetLifecycleIgnored(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  // The security event must name a person: an operator with no address is refused before anything is read.
  if (typeof operator?.email !== "string" || operator.email.trim().length === 0) {
    return opsProblem("No operator: the ignore list names who set it.", 400, "invalid_args");
  }
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  if (clinic.billingClinicId) {
    return opsProblem("A location is watched with its account: set the account instead.", 400, "invalid_args");
  }
  if (typeof args.ignored !== "boolean") {
    return opsProblem("Say ignored: true or false.", 400, "invalid_args");
  }
  const rawNote = args.note;
  if (
    rawNote !== undefined &&
    rawNote !== null &&
    !(LIFECYCLE_IGNORE_NOTES as readonly unknown[]).includes(rawNote)
  ) {
    return opsProblem(
      `The reason is one of ${LIFECYCLE_IGNORE_NOTES.join(", ")}, or none.`,
      400,
      "invalid_args",
    );
  }
  const ignored = args.ignored;
  const note = ignored ? ((rawNote as LifecycleIgnoreNote | null | undefined) ?? null) : null;
  try {
    const saved = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => writeLifecycleIgnore(tx, { ignored, note, setBy: operator.email, now }),
    );
    const auditRecorded = await audit(operator, "lifecycle_ignored_set", {
      clinicSlug: clinic.slug,
      ignored,
      reason: note,
    });
    return ok({
      outcome: "saved",
      ignored: saved.ignored,
      note: saved.note,
      setAt: saved.setAt.toISOString(),
      auditRecorded,
    });
  } catch (error) {
    log.error("lifecycle ignore not saved", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The ignore list could not be saved.", 500, "failed");
  }
}

export async function opListLifecycleIgnored(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const raw = args.clinicId;
  if (raw !== undefined && (typeof raw !== "string" || !UUID_SHAPED.test(raw))) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  const wanted = raw?.toLowerCase();
  try {
    const rows: LifecycleIgnoredRow[] = [];
    for (const clinic of await listClinics()) {
      if (wanted !== undefined && clinic.id !== wanted) continue;
      if (clinic.billingClinicId || clinic.destroyedAt) continue;
      const mark = await withTenant(
        { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
        (tx) => readLifecycleIgnore(tx),
      );
      if (!mark?.ignored) continue;
      rows.push({
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        note: mark.note,
        setBy: mark.setBy,
        setAt: mark.setAt.toISOString(),
      });
    }
    rows.sort((a, b) => a.clinicName.localeCompare(b.clinicName));
    return ok({ clinics: rows });
  } catch (error) {
    log.error("lifecycle ignore list not read", { error: describeError(error) });
    return opsProblem("The ignore list could not be read.", 500, "failed");
  }
}
