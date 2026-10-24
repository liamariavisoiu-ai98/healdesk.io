import { createHash } from "node:crypto";

import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";

import {
  clinicAudits,
  clinicClosures,
  clinicLocations,
  clinicProviders,
  clinicProviderServices,
  clinics,
  type AuditCheckOutcome,
  type AuditPack,
  type AuditResult,
  type AuditTrigger,
  type ClinicAuditRow,
  type ClinicChangeKind,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { checksFor, type AuditContext, type AuditDeps, type CheckOutcome } from "./checks";

/**
 * The audit runner (design E3 §2.1): runs one pack's checks for one clinic,
 * stores one clinic_audits row, keeps the last AUDITS_KEPT per clinic and
 * pack, and returns the row.
 *
 * Each check runs in its own tenant transaction under CHECK_BUDGET_MS, both
 * as a statement timeout in the database and as a clock here; a check that
 * throws or runs out of time is `error`, and the pack still stores. The
 * pack's result is the worst of its checks. Nothing here writes anything but
 * the audit's own row, and nothing it does can reach a clinic's save: it runs
 * from the worker, after the save committed, or for an operator.
 */

export const CHECK_BUDGET_MS = 20_000;
export const AUDITS_KEPT = 20;

const ACTOR: ActorContext = { type: "service", serviceName: "clinic-audits" };

const ORDER: Readonly<Record<AuditResult, number>> = { pass: 0, warn: 1, fail: 2, error: 3 };

/** The worst of the results: error, then fail, then warn, then pass. */
export function worstOf(results: readonly AuditResult[]): AuditResult {
  return results.reduce<AuditResult>((worst, r) => (ORDER[r] > ORDER[worst] ? r : worst), "pass");
}

export type RunPackInput = {
  trigger: AuditTrigger;
  changeKind?: ClinicChangeKind | null;
  /** The operator's address for a manual run; the service's name otherwise. */
  requestedBy: string;
  now?: Date;
  manual?: boolean;
  deps?: AuditDeps;
  /** Overrides the time budget (tests). */
  budgetMs?: number;
};

/**
 * The check's budget on our side: its result stops being waited for, and
 * `controller` aborts what it is still asking a vendor. Its database work is
 * stopped by the statement timeout each of its transactions sets.
 */
function withBudget<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`check ran past its ${ms} ms budget`));
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** The counts a check may store: finite, non-negative integers under short keys. */
function cleanCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

const CODE = /^[a-z0-9_]{1,40}$/;

function stored(id: string, outcome: CheckOutcome): AuditCheckOutcome {
  return {
    id,
    result: outcome.result,
    hint: outcome.hint ? outcome.hint.slice(0, 400) : null,
    counts: cleanCounts(outcome.counts),
    code: outcome.code && CODE.test(outcome.code) ? outcome.code : null,
    side: outcome.side ?? null,
  };
}

/**
 * sha256 of what decides when and with whom AYA books: the weekly hours,
 * every closed day (dates only), the active providers with their calendars
 * and services, and each location's hours. The hourly check compares it with
 * the last availability audit's, so a change no writer recorded (a website
 * edit, a script) still gets audited.
 */
export async function availabilityFingerprint(tx: TenantTx): Promise<string> {
  const [clinic] = await tx.db
    .select({ hours: clinics.openingHours })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const closures = await tx.db
    .select({ on: clinicClosures.closedOn })
    .from(clinicClosures)
    .where(eq(clinicClosures.clinicId, tx.clinicId))
    .orderBy(asc(clinicClosures.closedOn));
  const providers = await tx.db
    .select({ id: clinicProviders.id, calendarId: clinicProviders.calendarId })
    .from(clinicProviders)
    .where(and(eq(clinicProviders.clinicId, tx.clinicId), eq(clinicProviders.active, true)))
    .orderBy(asc(clinicProviders.id));
  const services = await tx.db
    .select({ providerId: clinicProviderServices.providerId, key: clinicProviderServices.serviceKey })
    .from(clinicProviderServices)
    .where(eq(clinicProviderServices.clinicId, tx.clinicId))
    .orderBy(asc(clinicProviderServices.providerId), asc(clinicProviderServices.serviceKey));
  const locations = await tx.db
    .select({ id: clinicLocations.id, hours: clinicLocations.openingHours })
    .from(clinicLocations)
    .where(eq(clinicLocations.clinicId, tx.clinicId))
    .orderBy(asc(clinicLocations.id));
  const active = new Set(providers.map((p) => p.id));
  const canonical = JSON.stringify({
    hours: sortKeys(clinic?.hours ?? null),
    closures: closures.map((c) => c.on),
    providers: providers.map((p) => [
      p.id,
      p.calendarId,
      services.filter((s) => s.providerId === p.id).map((s) => s.key),
    ]),
    unusedServices: services.filter((s) => !active.has(s.providerId)).length,
    locations: locations.map((l) => [l.id, sortKeys(l.hours ?? null)]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Run one pack for one clinic, store it, keep the last AUDITS_KEPT, and return the row. */
export async function runAuditPack(
  clinicId: string,
  pack: AuditPack,
  input: RunPackInput,
): Promise<ClinicAuditRow> {
  const startedAt = input.now ?? new Date();
  const budget = input.budgetMs ?? CHECK_BUDGET_MS;
  const base: Omit<AuditContext, "signal"> = {
    clinicId,
    now: startedAt,
    manual: input.manual === true,
    deps: input.deps ?? {},
    read: (fn) =>
      withTenant({ clinicId, actor: ACTOR }, async (tx) => {
        // SET LOCAL, by set_config's third argument: this transaction only.
        await tx.db.execute(sql`select set_config('statement_timeout', ${String(budget)}, true)`);
        return fn(tx);
      }),
  };

  const outcomes: AuditCheckOutcome[] = [];
  for (const check of checksFor(pack)) {
    try {
      outcomes.push(stored(check.id, await withBudget((signal) => check.run({ ...base, signal }), budget)));
    } catch (error) {
      log.warn("audit check could not run", { clinicId, code: check.id, error: describeError(error) });
      outcomes.push(
        stored(check.id, {
          result: "error",
          hint: "The check could not run: see apps/app's error lines for it.",
          counts: {},
        }),
      );
    }
  }
  const result = worstOf(outcomes.map((o) => o.result));

  let fingerprint: string | null = null;
  if (pack === "availability" || pack === "roster") {
    try {
      fingerprint = await withTenant({ clinicId, actor: ACTOR }, availabilityFingerprint);
    } catch (error) {
      log.warn("audit fingerprint not read", { clinicId, error: describeError(error) });
    }
  }

  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [row] = await tx.db
      .insert(clinicAudits)
      .values({
        clinicId: tx.clinicId,
        pack,
        trigger: input.trigger,
        changeKind: input.changeKind ?? null,
        fingerprint,
        result,
        checks: outcomes,
        requestedBy: input.requestedBy.slice(0, 320),
        startedAt,
      })
      .returning();
    const kept = await tx.db
      .select({ id: clinicAudits.id })
      .from(clinicAudits)
      .where(and(eq(clinicAudits.clinicId, tx.clinicId), eq(clinicAudits.pack, pack)))
      .orderBy(desc(clinicAudits.startedAt), desc(clinicAudits.finishedAt))
      .limit(AUDITS_KEPT);
    await tx.db.delete(clinicAudits).where(
      and(
        eq(clinicAudits.clinicId, tx.clinicId),
        eq(clinicAudits.pack, pack),
        notInArray(
          clinicAudits.id,
          kept.map((k) => k.id),
        ),
      ),
    );
    return row!;
  });
}

/** The newest audit of a pack for the tenant's clinic, or null. */
export async function latestAudit(tx: TenantTx, pack: AuditPack): Promise<ClinicAuditRow | null> {
  const [row] = await tx.db
    .select()
    .from(clinicAudits)
    .where(and(eq(clinicAudits.clinicId, tx.clinicId), eq(clinicAudits.pack, pack)))
    .orderBy(desc(clinicAudits.startedAt), desc(clinicAudits.finishedAt))
    .limit(1);
  return row ?? null;
}
