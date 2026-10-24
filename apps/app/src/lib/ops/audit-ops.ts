import { and, desc, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";

import {
  AUDIT_PACKS,
  clinicAuditClaims,
  clinicAudits,
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
import { withTenant, type TenantTx } from "@/lib/tenant";
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
 *   - `clinicAudits {clinicId?, history?, limit?}`, a read: per clinic, the
 *     newest result of each pack, an overall state and the last change; with
 *     `clinicId`, that clinic's history too (the newest 50 at most), unless
 *     `history: false`. Codes, counts, fixed hints and times, never a
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
  /**
   * The availability packs' state (AVAILABILITY_PACKS; `packs` still lists
   * all four). `audits_off`: a change nobody will audit, made while the
   * clinic-audits job was off and newer than the last availability audit.
   */
  overall: AuditOverall;
  lastChange: { kind: ClinicChangeKind; at: string } | null;
  packs: Partial<
    Record<AuditPack, { result: AuditResult; at: string; trigger: AuditTrigger; failing: { id: string; hint: string | null }[] }>
  >;
};

export type AuditOverall = "pass" | "warn" | "fail" | "running" | "audits_off" | "never";

/** The most history rows `clinicAudits` returns, newest first. */
export const AUDIT_HISTORY_MAX = 50;

/**
 * Whether the clinic-audits job is switched on. One statement, across
 * tenants: the switch is the scheduler's, not a clinic's.
 */
export async function clinicAuditsOn(): Promise<boolean> {
  const [job] = await unsafeDb
    .select({ enabled: scheduledJobs.enabled })
    .from(scheduledJobs)
    .where(eq(scheduledJobs.name, JOB_CLINIC_AUDITS))
    .limit(1);
  return job?.enabled === true;
}

/**
 * The packs that speak for a clinic's availability: what a change to hours,
 * closed days or providers is audited with (lib/audits/jobs.ts). Go-live
 * and transcripts are not about availability (go-live fails for every clinic
 * not yet in production), so the Clinics column, Home's row and the
 * Availability card's state read these two only.
 */
export const AVAILABILITY_PACKS = ["availability", "roster"] as const satisfies readonly AuditPack[];
type AvailabilityPack = (typeof AVAILABILITY_PACKS)[number];

function isAvailabilityPack(pack: AuditPack): pack is AvailabilityPack {
  return (AVAILABILITY_PACKS as readonly string[]).includes(pack);
}

/** What one clinic's audits say now. */
export type ClinicAuditFacts = {
  /** The newest row of each of the four packs. */
  latest: ClinicAuditRow[];
  change: { kind: ClinicChangeKind; at: Date } | null;
  /** A change is being audited: claimed (running), or queued while the audits are on. */
  checking: boolean;
  /**
   * A change nobody will audit: written while the audits were off
   * (audit_status null, as change-events.ts and the 0114 trigger write it),
   * or queued while they are off now, and newer than the newest
   * availability audit, which would have checked it.
   */
  unaudited: boolean;
  /** The newest passing run of each availability pack. */
  lastPassAt: Partial<Record<AvailabilityPack, Date>>;
};

type FactsRow = {
  kind: ClinicChangeKind | null;
  changed_at: Date | string | null;
  checking: boolean;
  unaudited: boolean;
  availability_pass_at: Date | string | null;
  roster_pass_at: Date | string | null;
};

function at(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * One clinic's audit facts, inside its tenant, in a FIXED two statements
 * (the Clinics strip counts them): the newest row of each pack; and one row
 * of the newest change, whether a change is being checked or will not be,
 * and each availability pack's newest pass. `auditsOn` is the clinic-audits
 * switch (clinicAuditsOn), read once by the caller.
 */
export async function readClinicAuditFacts(tx: TenantTx, auditsOn: boolean): Promise<ClinicAuditFacts> {
  const latest = await tx.db
    .selectDistinctOn([clinicAudits.pack])
    .from(clinicAudits)
    .where(eq(clinicAudits.clinicId, tx.clinicId))
    .orderBy(clinicAudits.pack, desc(clinicAudits.startedAt), desc(clinicAudits.finishedAt));
  const c = tx.clinicId;
  const result = await tx.db.execute<FactsRow>(sql`
    select
      (select e.kind from clinic_change_events e where e.clinic_id = ${c}
        order by e.changed_at desc limit 1) as kind,
      (select max(e.changed_at) from clinic_change_events e where e.clinic_id = ${c}) as changed_at,
      exists (select 1 from clinic_change_events e where e.clinic_id = ${c}
        and (e.audit_status = 'running' or (e.audit_status = 'queued' and ${auditsOn}::boolean))) as checking,
      exists (select 1 from clinic_change_events e where e.clinic_id = ${c}
        and (e.audit_status is null or (e.audit_status = 'queued' and not ${auditsOn}::boolean))
        and e.changed_at > coalesce(
          (select max(a.started_at) from clinic_audits a where a.clinic_id = ${c} and a.pack = 'availability'),
          '-infinity'::timestamptz)) as unaudited,
      (select max(a.started_at) from clinic_audits a
        where a.clinic_id = ${c} and a.pack = 'availability' and a.result = 'pass') as availability_pass_at,
      (select max(a.started_at) from clinic_audits a
        where a.clinic_id = ${c} and a.pack = 'roster' and a.result = 'pass') as roster_pass_at
  `);
  const row = result.rows[0];
  const changedAt = at(row?.changed_at ?? null);
  const lastPassAt: ClinicAuditFacts["lastPassAt"] = {};
  const availabilityPass = at(row?.availability_pass_at ?? null);
  const rosterPass = at(row?.roster_pass_at ?? null);
  if (availabilityPass) lastPassAt.availability = availabilityPass;
  if (rosterPass) lastPassAt.roster = rosterPass;
  return {
    latest,
    change: row?.kind && changedAt ? { kind: row.kind, at: changedAt } : null,
    checking: row?.checking === true,
    unaudited: row?.unaudited === true,
    lastPassAt,
  };
}

/**
 * The one rule for a clinic's overall audit state, which the console's
 * Availability card reads: a change being audited is `running`; a change
 * nobody will audit is `audits_off`; else the worst of the results passed
 * in (callers pass the availability packs' only), an `error` read as
 * `fail`; `never` with none.
 */
export function auditOverall(f: { checking: boolean; unaudited: boolean; latest: readonly AuditResult[] }): AuditOverall {
  if (f.checking) return "running";
  if (f.unaudited) return "audits_off";
  if (f.latest.length === 0) return "never";
  const worst = worstOf(f.latest);
  return worst === "error" ? "fail" : worst;
}

/** The availability packs' newest rows, of the four. */
export function availabilityRows(facts: Pick<ClinicAuditFacts, "latest">): ClinicAuditRow[] {
  return facts.latest.filter((r) => isAvailabilityPack(r.pack));
}

/** The card's overall state: the availability packs only. */
export function availabilityOverall(facts: ClinicAuditFacts): AuditOverall {
  return auditOverall({
    checking: facts.checking,
    unaudited: facts.unaudited,
    latest: availabilityRows(facts).map((r) => r.result),
  });
}

/**
 * Whether a warning is news: a pack that warns for an ordinary setup state
 * (website chat not live yet, no voice agent yet) warns on every run, change
 * or no change. A warning counts only when a change was made after that
 * pack's last pass (or the pack never passed and something changed).
 */
function warnIsNews(facts: ClinicAuditFacts): boolean {
  const change = facts.change;
  if (!change) return false;
  return availabilityRows(facts).some((r) => {
    if (r.result !== "warn" || !isAvailabilityPack(r.pack)) return false;
    const pass = facts.lastPassAt[r.pack];
    return !pass || change.at.getTime() > pass.getTime();
  });
}

/**
 * What about a clinic's availability needs ops, for Home (lib/ops/inbox/
 * availability.ts): a change nobody will audit; an availability pack that
 * failed; a warning that a change brought. Null otherwise, including while
 * a change is being audited and for a setup-state warning with no change
 * since the last pass. Changes left unseen are the source's own count.
 */
export function availabilityAttention(facts: ClinicAuditFacts): "audits_off" | "fail" | "warn" | null {
  if (facts.checking) return null;
  if (facts.unaudited) return "audits_off";
  const results = availabilityRows(facts).map((r) => r.result);
  if (results.length === 0) return null;
  const worst = worstOf(results);
  if (worst === "fail" || worst === "error") return "fail";
  if (worst === "warn" && warnIsNews(facts)) return "warn";
  return null;
}

/**
 * The Clinics table's Availability audit level, by the same rule as Home's
 * row: running while a change is audited; never (drawn "changed, not
 * audited" beside a change time) for a change nobody will audit; fail; warn
 * only when a change brought it. A setup-state warning with no change since
 * the last pass reads as that pass, or as never when nothing ever passed,
 * so a clinic in setup is not marked by what setup itself leaves undone.
 */
export function availabilityLevel(facts: ClinicAuditFacts): "pass" | "warn" | "fail" | "running" | "never" {
  if (facts.checking) return "running";
  if (facts.unaudited) return "never";
  const results = availabilityRows(facts).map((r) => r.result);
  if (results.length === 0) return "never";
  const worst = worstOf(results);
  if (worst === "fail" || worst === "error") return "fail";
  if (worst === "pass") return "pass";
  if (warnIsNews(facts)) return "warn";
  return Object.keys(facts.lastPassAt).length > 0 ? "pass" : "never";
}

/**
 * `clinicAudits {clinicId?, history?, limit?}`. With `clinicId`, that
 * clinic's history too, newest first and at most `limit` rows (1 to
 * AUDIT_HISTORY_MAX, the default), unless `history: false`, for a page
 * that does not show it. Without `clinicId` there is no history, and
 * `history` or `limit` is refused rather than ignored.
 */
export async function opClinicAudits(args: Record<string, unknown>): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  if (clinicId !== undefined && !UUID_SHAPED.test(clinicId)) {
    return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  }
  if (args.history !== undefined && typeof args.history !== "boolean") {
    return opsProblem("history is true or false.", 400, "invalid_args");
  }
  const limitArg = args.limit;
  if (
    limitArg !== undefined &&
    (typeof limitArg !== "number" || !Number.isInteger(limitArg) || limitArg < 1 || limitArg > AUDIT_HISTORY_MAX)
  ) {
    return opsProblem(`limit is a whole number from 1 to ${AUDIT_HISTORY_MAX}.`, 400, "invalid_args");
  }
  if (!clinicId && (args.history !== undefined || limitArg !== undefined)) {
    return opsProblem("History is read for one clinic: pass its clinicId.", 400, "invalid_args");
  }
  const historyLimit = clinicId && args.history !== false ? ((limitArg as number | undefined) ?? AUDIT_HISTORY_MAX) : 0;
  try {
    const clinics = (await listClinics()).filter((c) => (clinicId ? c.id === clinicId : c.destroyedAt === null));
    // Changes left waiting while the audits are switched off are not being
    // checked by anyone: they read as `audits_off`, never `running`.
    const auditsOn = await clinicAuditsOn();
    const summaries: ClinicAuditSummary[] = [];
    let history: AuditView[] | null = null;
    for (const clinic of clinics) {
      const read = await withTenant({ clinicId: clinic.id, actor: READ_ACTOR }, async (tx) => {
        const facts = await readClinicAuditFacts(tx, auditsOn);
        const rows =
          historyLimit > 0
            ? await tx.db
                .select()
                .from(clinicAudits)
                .where(eq(clinicAudits.clinicId, tx.clinicId))
                .orderBy(desc(clinicAudits.startedAt), desc(clinicAudits.finishedAt))
                .limit(historyLimit)
            : null;
        return { facts, rows };
      });
      const packs: ClinicAuditSummary["packs"] = {};
      for (const row of read.facts.latest) {
        packs[row.pack] = {
          result: row.result,
          at: row.startedAt.toISOString(),
          trigger: row.trigger,
          failing: row.checks.filter((c) => c.result !== "pass").map((c) => ({ id: c.id, hint: c.hint ?? null })),
        };
      }
      summaries.push({
        clinicId: clinic.id,
        name: clinic.name,
        overall: availabilityOverall(read.facts),
        lastChange: read.facts.change
          ? { kind: read.facts.change.kind, at: read.facts.change.at.toISOString() }
          : null,
        packs,
      });
      if (clinicId) history = read.rows ? read.rows.map(auditView) : null;
    }
    return ok({ clinics: summaries, history });
  } catch (error) {
    log.error("clinic audits not read", { error: describeError(error) });
    return opsProblem("The audits could not be read.", 500, "failed");
  }
}
