import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";

import {
  AUDIT_PACKS,
  clinicAuditClaims,
  clinicAudits,
  clinicChangeEvents,
  scheduledJobs,
  clinics as clinicRows,
  type AuditCheckOutcome,
  type AuditPack,
  type AuditResult,
  type AuditTrigger,
  type ClinicAuditRow,
  type ClinicChangeKind,
} from "@/db/schema";
import type { AuditDeps } from "@/lib/audits/checks";
import { runAuditPack, worstOf } from "@/lib/audits/run";
import { JOB_CLINIC_AUDITS } from "@/lib/clinic/change-events";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";
import { verifyVoiceAgent } from "@/lib/voice/provision";

import { audit, clinicById, ok, opsProblem, stringArg, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The ops operations for the clinic audits (design E3 §2.5; lib/audits),
 * kept beside the ops API's dispatch rather than in it.
 *
 *   - `runClinicAudit {clinicId, pack?}`, a write: one pack, or all four,
 *     run now for one clinic, synchronously, with the read-backs a manual run
 *     may make (Retell's, GET only). A security event names the operator. One
 *     at a time per clinic (a claim row, stale after two minutes; `busy`
 *     otherwise), and at most
 *     one each MANUAL_COOLDOWN_MS (`too_soon`), so a button pressed again and
 *     again runs once; `closed` for an account that has closed.
 *   - `clinicAudits {clinicId?}`, a read: per clinic, the newest result of
 *     each pack, an overall state and the last change; with `clinicId`, that
 *     clinic's history too. Codes, counts, fixed hints and times, never a
 *     name of a person, a date the clinic chose or anything it typed.
 */

export const MANUAL_COOLDOWN_MS = 60_000;
/** A manual run's claim older than this belongs to a run that stopped. */
export const CLAIM_STALE_MS = 2 * 60_000;

let depsForTests: AuditDeps | undefined;

/** Test seam: the read-backs a manual run makes. Undefined restores Retell's. */
export function __setAuditDepsForTests(deps: AuditDeps | undefined): void {
  depsForTests = deps;
}

const READ_ACTOR = { type: "service", serviceName: "ops-audits" } as const;

/** One stored audit as the console reads it. */
export type AuditView = {
  id: string;
  pack: AuditPack;
  trigger: AuditTrigger;
  changeKind: ClinicChangeKind | null;
  result: AuditResult;
  startedAt: string;
  finishedAt: string;
  checks: AuditCheckOutcome[];
};

export function auditView(row: ClinicAuditRow): AuditView {
  return {
    id: row.id,
    pack: row.pack,
    trigger: row.trigger,
    changeKind: row.changeKind ?? null,
    result: row.result,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    checks: row.checks.map((c) => ({
      id: c.id,
      result: c.result,
      hint: c.hint ?? null,
      counts: c.counts ?? {},
      code: c.code ?? null,
      side: c.side ?? null,
    })),
  };
}

function isPack(value: unknown): value is AuditPack {
  return typeof value === "string" && (AUDIT_PACKS as readonly string[]).includes(value);
}

export async function opRunClinicAudit(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId)) return opsProblem("A clinic id is required.", 400, "invalid_args");
  const packArg = args.pack;
  if (packArg !== undefined && packArg !== null && !isPack(packArg)) {
    return opsProblem(`A pack is one of ${AUDIT_PACKS.join(", ")}.`, 400, "invalid_args");
  }
  if (!(await clinicById(clinicId))) return ok({ status: "not_found" });
  const now = new Date();
  try {
    const closed = await withTenant({ clinicId, actor: READ_ACTOR }, async (tx) => {
      const [clinic] = await tx.db
        .select({ closedAt: clinicRows.accountClosedAt, destroyedAt: clinicRows.destroyedAt })
        .from(clinicRows)
        .where(eq(clinicRows.id, tx.clinicId))
        .limit(1);
      return Boolean(clinic?.closedAt ?? clinic?.destroyedAt);
    });
    // A closed account keeps nothing to audit, and its tables refuse new rows.
    if (closed) return ok({ status: "closed" });
    // One manual run per clinic at a time: a claim row taken in its own short
    // transaction (a second taker waits on the first's insert, then finds it
    // held), so no connection is held for the run. A claim older than
    // CLAIM_STALE_MS is a run that stopped, and is taken over.
    const claimed = await withTenant({ clinicId, actor: READ_ACTOR }, (tx) =>
      tx.db
        .insert(clinicAuditClaims)
        .values({ clinicId: tx.clinicId, startedAt: now, requestedBy: operator.email })
        .onConflictDoUpdate({
          target: clinicAuditClaims.clinicId,
          set: { startedAt: now, requestedBy: operator.email },
          setWhere: sql`${clinicAuditClaims.startedAt} < ${new Date(now.getTime() - CLAIM_STALE_MS)}`,
        })
        .returning({ clinicId: clinicAuditClaims.clinicId }),
    );
    if (claimed.length === 0) return ok({ status: "busy" });
    try {
      return await runManual(clinicId, packArg, operator, now);
    } finally {
      await withTenant({ clinicId, actor: READ_ACTOR }, (tx) =>
        tx.db
          .delete(clinicAuditClaims)
          .where(and(eq(clinicAuditClaims.clinicId, tx.clinicId), eq(clinicAuditClaims.startedAt, now))),
      ).catch((error: unknown) => log.warn("audit claim not released", { clinicId, error: describeError(error) }));
    }
  } catch (error) {
    log.error("clinic audit not run", { clinicId, error: describeError(error) });
    return opsProblem("The audit could not be run.", 500, "failed");
  }
}

async function runManual(
  clinicId: string,
  packArg: unknown,
  operator: Operator,
  now: Date,
): Promise<OpsOutcome> {
  {
    const state = await withTenant({ clinicId, actor: READ_ACTOR }, async (tx) => {
      const [clinic] = await tx.db
        .select({ closedAt: clinicRows.accountClosedAt, destroyedAt: clinicRows.destroyedAt })
        .from(clinicRows)
        .where(eq(clinicRows.id, tx.clinicId))
        .limit(1);
      const [recent] = await tx.db
        .select({ startedAt: clinicAudits.startedAt })
        .from(clinicAudits)
        .where(
          and(
            eq(clinicAudits.clinicId, tx.clinicId),
            eq(clinicAudits.trigger, "manual"),
            gt(clinicAudits.startedAt, new Date(now.getTime() - MANUAL_COOLDOWN_MS)),
          ),
        )
        .orderBy(desc(clinicAudits.startedAt))
        .limit(1);
      return { closed: Boolean(clinic?.closedAt ?? clinic?.destroyedAt), recent: recent ?? null };
    });
    // A closed account keeps nothing to audit, and its tables refuse new rows.
    if (state.closed) return ok({ status: "closed" });
    const recent = state.recent;
    if (recent) {
      return ok({
        status: "too_soon",
        notBefore: new Date(recent.startedAt.getTime() + MANUAL_COOLDOWN_MS).toISOString(),
      });
    }
    const packs: readonly AuditPack[] = isPack(packArg) ? [packArg] : AUDIT_PACKS;
    const deps: AuditDeps = depsForTests ?? {
      verifyVoice: (id, signal) =>
        verifyVoiceAgent(id, {
          fetch: (input, init) =>
            fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
        }),
    };
    const rows: ClinicAuditRow[] = [];
    for (const pack of packs) {
      rows.push(
        await runAuditPack(clinicId, pack, {
          trigger: "manual",
          requestedBy: operator.email,
          manual: true,
          deps,
          now,
        }),
      );
    }
    const result = worstOf(rows.map((r) => r.result));
    const auditRecorded = await audit(operator, "clinic_audit_run", {
      clinicId,
      pack: isPack(packArg) ? packArg : "all",
      result,
    });
    return ok({ status: "ran", result, audits: rows.map(auditView), auditRecorded });
  }
}

export type ClinicAuditSummary = {
  clinicId: string;
  name: string;
  /** `audits_off`: changes wait for an audit while the clinic-audits job is switched off. */
  overall: "pass" | "warn" | "fail" | "running" | "audits_off" | "never";
  lastChange: { kind: ClinicChangeKind; at: string } | null;
  packs: Partial<
    Record<AuditPack, { result: AuditResult; at: string; trigger: AuditTrigger; failing: { id: string; hint: string | null }[] }>
  >;
};

export async function opClinicAudits(args: Record<string, unknown>): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (clinicId !== undefined && !UUID_SHAPED.test(clinicId)) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  try {
    const clinics = (await listClinics()).filter((c) => (clinicId ? c.id === clinicId : c.destroyedAt === null));
    // Changes left waiting while the audits are switched off are not being
    // checked by anyone: they read as `audits_off`, never `running`.
    const [job] = await unsafeDb
      .select({ enabled: scheduledJobs.enabled })
      .from(scheduledJobs)
      .where(eq(scheduledJobs.name, JOB_CLINIC_AUDITS))
      .limit(1);
    const auditsOn = job?.enabled === true;
    const summaries: ClinicAuditSummary[] = [];
    let history: AuditView[] | null = null;
    for (const clinic of clinics) {
      const read = await withTenant({ clinicId: clinic.id, actor: READ_ACTOR }, async (tx) => {
        const rows = await tx.db
          .select()
          .from(clinicAudits)
          .where(eq(clinicAudits.clinicId, tx.clinicId))
          .orderBy(desc(clinicAudits.startedAt), desc(clinicAudits.finishedAt));
        const [change] = await tx.db
          .select({ kind: clinicChangeEvents.kind, at: clinicChangeEvents.changedAt })
          .from(clinicChangeEvents)
          .where(eq(clinicChangeEvents.clinicId, tx.clinicId))
          .orderBy(desc(clinicChangeEvents.changedAt))
          .limit(1);
        const [pending] = await tx.db
          .select({ id: clinicChangeEvents.id })
          .from(clinicChangeEvents)
          .where(
            and(
              eq(clinicChangeEvents.clinicId, tx.clinicId),
              inArray(clinicChangeEvents.auditStatus, ["queued", "running"]),
            ),
          )
          .limit(1);
        return { rows, change: change ?? null, pending: Boolean(pending) };
      });
      const packs: ClinicAuditSummary["packs"] = {};
      for (const row of read.rows) {
        if (packs[row.pack]) continue;
        packs[row.pack] = {
          result: row.result,
          at: row.startedAt.toISOString(),
          trigger: row.trigger,
          failing: row.checks.filter((c) => c.result !== "pass").map((c) => ({ id: c.id, hint: c.hint ?? null })),
        };
      }
      const latest = Object.values(packs).map((p) => p!.result);
      const worst = worstOf(latest);
      summaries.push({
        clinicId: clinic.id,
        name: clinic.name,
        overall: read.pending
          ? auditsOn
            ? "running"
            : "audits_off"
          : latest.length === 0
            ? "never"
            : worst === "error"
              ? "fail"
              : worst,
        lastChange: read.change ? { kind: read.change.kind, at: read.change.at.toISOString() } : null,
        packs,
      });
      if (clinicId) history = read.rows.map(auditView);
    }
    return ok({ clinics: summaries, history });
  } catch (error) {
    log.error("clinic audits not read", { error: describeError(error) });
    return opsProblem("The audits could not be read.", 500, "failed");
  }
}
