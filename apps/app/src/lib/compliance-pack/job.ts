import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { describeError, log } from "@/lib/log";
import { raiseOpsAlertKeyed, type OpsFields } from "@/lib/ops/notify";
import { runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { addLocalDays } from "@/lib/scheduler/summary-clock";

import { buildCompliancePack, type CompliancePack, type PackBuild } from "./build";
import { getPack, insertPack, type InsertOutcome } from "./store";
import { dueWeekStart, isWeekStart, packWeek, weekHasEnded } from "./week";

/**
 * The weekly compliance pack's job (ops automation lane P6h; design E6
 * item 18; owner decision D20), behind the `compliance-pack` switch, seeded
 * OFF by drizzle/0123. Called by every hourly tick; it decides for itself
 * which weeks have come due (./week.ts: 07:00 New York on the Monday after
 * the week, 11:00 UTC in summer and 12:00 UTC in winter).
 *
 *   - Each run looks at the week now due and the four before it, and stores
 *     any that is missing, built from the same reads as of each week's end:
 *     a worker that was down for ten days fills its gap on its first run
 *     back. A pack made more than an hour after it was due says so
 *     (`build.builtLate`, `build.lateDays`). Older weeks are made by hand
 *     (generateCompliancePack, lib/ops/pack-ops.ts).
 *   - Idempotent by week: a stored week is never built again, and the insert
 *     does nothing on a second row for the same week.
 *   - A week with a section that could not be read is NOT stored on its
 *     first tries: the run fails, the next hourly run tries again, and only
 *     once the week's due time plus 48 hours has passed is it stored as it
 *     stands, with `build.partial` and the unread sections named. A failed
 *     read is never stored as a zero, and never silently.
 *   - It tells the owner once per week, through the ops email path (an ops
 *     alert, `compliance_pack_ready`, emailed to the ops address only, kept
 *     off Slack and Home): a pointer and the five headline numbers.
 *   - When the same week fails on two runs in a row, `compliance_pack_failed`
 *     is raised, once for that week.
 *
 * The job's note names weeks and outcomes in fixed words, never an error's
 * own message.
 */

export const JOB_COMPLIANCE_PACK = "compliance-pack";
export const PACK_SERVICE = "compliance-pack";
/** The weeks before the one now due that each run checks for a gap. */
export const LOOKBACK_WEEKS = 4;
/** A week with an unread section is stored as partial only after its due time plus this. */
export const PARTIAL_AFTER_MS = 48 * 3_600_000;
/** A pack made this long after its due time is marked built late (the first tick at or after it is on time). */
export const LATE_AFTER_MS = 3_600_000;

/** A week whose pack still has unread sections inside its 48 hours: not stored, tried again. */
export class PackIncompleteError extends Error {
  constructor(readonly unread: readonly string[]) {
    super("A section of the pack could not be read.");
    this.name = "PackIncompleteError";
  }
}

/** How a pack made at `now` was made. Pure. */
export function buildInfo(weekStart: string, now: Date, unread: readonly string[]): PackBuild {
  const lateMs = now.getTime() - packWeek(weekStart).dueAt.getTime();
  const builtLate = lateMs >= LATE_AFTER_MS;
  return {
    partial: unread.length > 0,
    unreadSections: [...unread],
    builtLate,
    lateDays: builtLate ? Math.floor(lateMs / 86_400_000) : 0,
  };
}

/** The pointer's fields: the week's Monday, the five numbers (each left out when unread), the unread count and how late. */
export function readyFields(pack: CompliancePack): OpsFields {
  const h = pack.headline;
  const fields: Record<string, string | number> = { windowStart: pack.week.start };
  if (h.incidentsOpen !== null) fields.incidentsOpenCount = h.incidentsOpen;
  if (h.rightsOverdue !== null) fields.rightsOverdueCount = h.rightsOverdue;
  if (h.resignsOpen !== null) fields.resignsOpenCount = h.resignsOpen;
  if (h.vendorsNeedingAttention !== null) fields.vendorsCount = h.vendorsNeedingAttention;
  if (h.transcriptCopiesPast30Days !== null) fields.transcriptCopiesCount = h.transcriptCopiesPast30Days;
  fields.unreadCount = pack.build.unreadSections.length;
  fields.lateDays = pack.build.lateDays;
  return fields;
}

/**
 * Build and store one week's pack. Refuses a week that has not ended, and
 * throws PackIncompleteError for a pack with an unread section until the
 * week's due time plus 48 hours.
 */
export async function makePack(
  weekStart: string,
  generatedBy: string,
  now: Date,
): Promise<{ pack: CompliancePack; outcome: InsertOutcome }> {
  if (!isWeekStart(weekStart)) throw new RangeError("A pack's week starts on a Monday.");
  if (!weekHasEnded(weekStart, now)) throw new RangeError("That week has not ended yet.");
  const pack = await buildCompliancePack(weekStart, (unread) => buildInfo(weekStart, now, unread));
  if (pack.build.partial && now.getTime() < packWeek(weekStart).dueAt.getTime() + PARTIAL_AFTER_MS) {
    throw new PackIncompleteError(pack.build.unreadSections);
  }
  return { pack, outcome: await insertPack(pack, generatedBy, now) };
}

/**
 * The pointer, once per week by its key: raised again by every later run
 * while the week is in the look-back, which is a no-op once it is recorded,
 * so a pointer the ops log could not take when the pack was stored still goes.
 */
async function tellOwner(pack: CompliancePack): Promise<void> {
  await raiseOpsAlertKeyed("compliance_pack_ready", readyFields(pack), {
    key: `compliance_pack_ready:${pack.week.start}`,
    email: true,
  });
}

/** The weeks the previous run failed on, read from its note (fixed words this file wrote). */
export function failedWeeksOf(status: string | null, note: string | null): Set<string> {
  if (status !== "failed" || !note) return new Set();
  const match = /failed ((?:\d{4}-\d{2}-\d{2}(?:, )?)+)/.exec(note);
  return new Set(match ? match[1]!.split(", ").filter(Boolean) : []);
}

async function previousFailures(): Promise<Set<string>> {
  try {
    const result = await unsafeDb.execute<{ last_run_status: string | null; last_run_note: string | null }>(
      sql`select last_run_status, last_run_note from scheduled_jobs where name = ${JOB_COMPLIANCE_PACK}`,
    );
    const row = result.rows[0];
    return failedWeeksOf(row?.last_run_status ?? null, row?.last_run_note ?? null);
  } catch (error) {
    log.error("compliance pack: last run not read", { error: describeError(error) });
    return new Set();
  }
}

type WeekOutcome = "stored" | "already" | "failed";

async function storeWeek(weekStart: string, now: Date, failedBefore: ReadonlySet<string>): Promise<WeekOutcome> {
  try {
    const stored = await getPack(weekStart);
    if (stored) {
      await tellOwner(stored.payload);
      return "already";
    }
    const { pack, outcome } = await makePack(weekStart, PACK_SERVICE, now);
    if (outcome.status === "exists") return "already";
    await tellOwner(pack);
    return "stored";
  } catch (error) {
    log.error("compliance pack not made", {
      hint: error instanceof PackIncompleteError ? `unread: ${error.unread.join(", ")}` : "build or store failed",
      error: describeError(error),
    });
    if (failedBefore.has(weekStart)) {
      await raiseOpsAlertKeyed(
        "compliance_pack_failed",
        { windowStart: weekStart },
        { key: `compliance_pack_failed:${weekStart}`, email: true },
      );
    }
    return "failed";
  }
}

/** One run: the due week and the four before it, oldest first. Throws, with a fixed-word note, when any week failed. */
export async function storeDuePacks(now: Date): Promise<string> {
  const due = dueWeekStart(now);
  const weeks = Array.from({ length: LOOKBACK_WEEKS + 1 }, (_, i) => addLocalDays(due, -7 * (LOOKBACK_WEEKS - i)));
  const failedBefore = await previousFailures();
  const stored: string[] = [];
  const failed: string[] = [];
  let already = 0;
  for (const week of weeks) {
    const outcome = await storeWeek(week, now, failedBefore);
    if (outcome === "stored") stored.push(week);
    else if (outcome === "failed") failed.push(week);
    else already += 1;
  }
  const parts = [
    stored.length > 0 ? `stored ${stored.join(", ")}` : null,
    `${already} already stored`,
    failed.length > 0 ? `failed ${failed.join(", ")}` : null,
  ].filter(Boolean);
  const note = `due week ${due}: ${parts.join("; ")}`;
  if (failed.length > 0) throw new Error(note);
  return note;
}

/** The hourly job, behind the `compliance-pack` switch. */
export async function runCompliancePackJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_COMPLIANCE_PACK, () => storeDuePacks(now), now);
}
