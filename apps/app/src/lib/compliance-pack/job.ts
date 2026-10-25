import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { describeError, log } from "@/lib/log";
import { raiseOpsAlertKeyed, type OpsFields } from "@/lib/ops/notify";
import { runJob, type JobOutcome } from "@/lib/scheduler/jobs";

import { buildCompliancePack, unreadSections, type CompliancePack } from "./build";
import { getPack, insertPack, packExists, type InsertOutcome } from "./store";
import { dueWeekStart, isWeekStart, weekHasEnded } from "./week";

/**
 * The weekly compliance pack's job (ops automation lane P6h; design E6
 * item 18; owner decision D20), behind the `compliance-pack` switch, seeded
 * OFF by drizzle/0123. Called by every hourly tick; it decides for itself
 * whether a week has come due (./week.ts: 07:00 New York on the Monday after
 * the week, 11:00 UTC in summer and 12:00 UTC in winter).
 *
 *   - Idempotent by week: a week already stored is never built again, and
 *     the insert itself does nothing on a second row for the same week, so
 *     two runners at once store one pack.
 *   - It tells the owner once per week, through the ops email path (an ops
 *     alert, `compliance_pack_ready`, emailed to the ops address only):
 *     a pointer to the pack and its five headline numbers. Nothing else is
 *     contacted.
 *   - A run that throws is tried again by the next hour's tick. When the
 *     same week fails twice in a row, `compliance_pack_failed` is raised,
 *     once for that week.
 *   - A pack in which a section could not be read is still stored: the
 *     section says `could_not_read` and carries no numbers, and the alert
 *     counts such sections, so a failed read is never shown as a zero.
 *
 * A week the job missed (the switch was off, the host was in standby) is
 * made by the operator's generateCompliancePack (lib/ops/pack-ops.ts).
 */

export const JOB_COMPLIANCE_PACK = "compliance-pack";
export const PACK_SERVICE = "compliance-pack";

/** The pointer's fields: the week's Monday and the five numbers, each left out when its section could not be read. */
export function readyFields(pack: CompliancePack): OpsFields {
  const h = pack.headline;
  const fields: Record<string, string | number> = { windowStart: pack.week.start };
  if (h.incidentsOpen !== null) fields.incidentsOpenCount = h.incidentsOpen;
  if (h.rightsOverdue !== null) fields.rightsOverdueCount = h.rightsOverdue;
  if (h.resignsOpen !== null) fields.resignsOpenCount = h.resignsOpen;
  if (h.vendorsNeedingAttention !== null) fields.vendorsCount = h.vendorsNeedingAttention;
  if (h.transcriptCopiesPast30Days !== null) fields.transcriptCopiesCount = h.transcriptCopiesPast30Days;
  fields.unreadCount = unreadSections(pack).length;
  return fields;
}

/** Build and store one week's pack. Refuses a week that has not ended. */
export async function makePack(
  weekStart: string,
  generatedBy: string,
  now: Date,
): Promise<{ pack: CompliancePack; outcome: InsertOutcome }> {
  if (!isWeekStart(weekStart)) throw new RangeError("A pack's week starts on a Monday.");
  if (!weekHasEnded(weekStart, now)) throw new RangeError("That week has not ended yet.");
  const pack = await buildCompliancePack(weekStart);
  return { pack, outcome: await insertPack(pack, generatedBy, now) };
}

async function lastRun(): Promise<{ status: string | null; note: string | null }> {
  const result = await unsafeDb.execute<{ last_run_status: string | null; last_run_note: string | null }>(
    sql`select last_run_status, last_run_note from scheduled_jobs where name = ${JOB_COMPLIANCE_PACK}`,
  );
  const row = result.rows[0];
  return { status: row?.last_run_status ?? null, note: row?.last_run_note ?? null };
}

/** What the job's note says of a week: the prefix a second failure is recognised by. */
function weekNote(weekStart: string, what: string): string {
  return `week ${weekStart}: ${what}`;
}

/**
 * The pointer, once per week by its key: raised again by every later run
 * while the week is due, which is a no-op once it is recorded, so a pointer
 * the ops log could not take when the pack was stored still goes.
 */
async function tellOwner(pack: CompliancePack): Promise<void> {
  await raiseOpsAlertKeyed("compliance_pack_ready", readyFields(pack), {
    key: `compliance_pack_ready:${pack.week.start}`,
    email: true,
  });
}

export async function storeDuePack(now: Date): Promise<string> {
  const weekStart = dueWeekStart(now);
  if (await packExists(weekStart)) {
    const stored = await getPack(weekStart);
    if (stored) await tellOwner(stored.payload);
    return weekNote(weekStart, "already stored");
  }
  const previous = await lastRun();
  try {
    const { pack, outcome } = await makePack(weekStart, PACK_SERVICE, now);
    if (outcome.status === "exists") return weekNote(weekStart, "already stored");
    await tellOwner(pack);
    const unread = unreadSections(pack);
    return weekNote(weekStart, unread.length > 0 ? `stored, ${unread.length} sections could not be read` : "stored");
  } catch (error) {
    log.error("compliance pack not made", { error: describeError(error) });
    const failedBefore = previous.status === "failed" && previous.note?.startsWith(weekNote(weekStart, "")) === true;
    if (failedBefore) {
      await raiseOpsAlertKeyed(
        "compliance_pack_failed",
        { windowStart: weekStart },
        { key: `compliance_pack_failed:${weekStart}`, email: true },
      );
    }
    throw new Error(weekNote(weekStart, failedBefore ? "could not be made again; ops told" : "could not be made"));
  }
}

/** The hourly job, behind the `compliance-pack` switch. */
export async function runCompliancePackJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_COMPLIANCE_PACK, () => storeDuePack(now), now);
}
