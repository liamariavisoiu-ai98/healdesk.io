import { makePack, PackIncompleteError } from "@/lib/compliance-pack/job";
import { getPack, listPacks, packExists, type PackSummary, type StoredPack } from "@/lib/compliance-pack/store";
import { dueWeekStart, isWeekStart, weekHasEnded } from "@/lib/compliance-pack/week";
import { addLocalDays } from "@/lib/scheduler/summary-clock";
import { describeError, log } from "@/lib/log";

// api.ts imports this module for its dispatch, and this module borrows
// api.ts's helpers: safe, because nothing here touches them while the
// modules load (the same note as lib/ops/approval-ops.ts).
import { audit, ok, opsProblem, type Operator, type OpsOutcome } from "./api";

/**
 * The weekly compliance pack's three operations (ops automation lane P6h;
 * design E6 item 18; owner decision D20). The printable page is lane P6j's,
 * at /admin/compliance/pack/<week>.
 *
 *   - `getCompliancePack {week}` (read): one stored pack, or not_found.
 *   - `listCompliancePacks {limit?}` (read): the newest packs first, each
 *     with its five headline numbers, 12 by default, 104 at most.
 *   - `generateCompliancePack {week?}` (write): makes and stores the pack of
 *     a week that has ended and has none, by default the week now due, at
 *     most 104 weeks before it and never a week still to come. It refuses a
 *     week that already has one (a stored pack is never made again), and a
 *     week with a section that cannot be read inside its first 48 hours (the
 *     job's rule, lib/compliance-pack/job.ts). It reads, writes read-audit
 *     rows and the pack, contacts nobody, and writes one security event
 *     naming the operator.
 */

const UNKNOWN = (args: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(args).filter((key) => !allowed.includes(key));

export const PACK_LIST_DEFAULT = 12;
export const PACK_LIST_MAX = 104;
/** What generateCompliancePack stores as `generated_by`. */
export const CONSOLE_SERVICE = "ops-console";
/** How far back a week may be made by hand: two years of weeks. */
export const PACK_GENERATE_MAX_WEEKS_BACK = 104;

export type GetCompliancePackOutcome = { status: "found"; pack: StoredPack } | { status: "not_found" };
export type ListCompliancePacksOutcome = { packs: PackSummary[] };
export type GenerateCompliancePackOutcome =
  | {
      status: "stored";
      weekStart: string;
      packId: string;
      payloadHash: string;
      /** Sections that could not be read: stored as such, never as zeros. */
      unreadSections: number;
      auditRecorded: boolean;
    }
  | { status: "refused"; message: string };

export async function opGetCompliancePack(args: Record<string, unknown>): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["week"]);
  if (unknown.length > 0) return opsProblem("getCompliancePack takes only week.", 400, "invalid_args");
  if (!isWeekStart(args.week)) return opsProblem("The week is its Monday, as YYYY-MM-DD.", 400, "invalid_args");
  try {
    const pack = await getPack(args.week);
    return ok((pack ? { status: "found", pack } : { status: "not_found" }) satisfies GetCompliancePackOutcome);
  } catch (error) {
    log.error("compliance pack not read", { error: describeError(error) });
    return opsProblem("The compliance pack could not be read.", 500, "failed");
  }
}

export async function opListCompliancePacks(args: Record<string, unknown>): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["limit"]);
  if (unknown.length > 0) return opsProblem("listCompliancePacks takes only limit.", 400, "invalid_args");
  const limit = args.limit ?? PACK_LIST_DEFAULT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > PACK_LIST_MAX) {
    return opsProblem(`The limit is a whole number from 1 to ${PACK_LIST_MAX}.`, 400, "invalid_args");
  }
  try {
    return ok({ packs: await listPacks(limit) } satisfies ListCompliancePacksOutcome);
  } catch (error) {
    log.error("compliance packs not listed", { error: describeError(error) });
    return opsProblem("The compliance packs could not be read.", 500, "failed");
  }
}

const refused = (message: string) => ok({ status: "refused", message } satisfies GenerateCompliancePackOutcome);

export async function opGenerateCompliancePack(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["week"]);
  if (unknown.length > 0) return opsProblem("generateCompliancePack takes only week.", 400, "invalid_args");
  const week = args.week === undefined || args.week === null ? dueWeekStart(now) : args.week;
  if (!isWeekStart(week)) return opsProblem("The week is its Monday, as YYYY-MM-DD.", 400, "invalid_args");
  if (!weekHasEnded(week, now)) return refused("That week has not ended yet, so its pack cannot be made. Nothing was stored.");
  if (week < addLocalDays(dueWeekStart(now), -7 * PACK_GENERATE_MAX_WEEKS_BACK)) {
    return refused(`A pack can be made for the last ${PACK_GENERATE_MAX_WEEKS_BACK} weeks only. Nothing was stored.`);
  }
  try {
    if (await packExists(week)) {
      return refused("That week's pack is already stored, and a stored pack is never made again. Nothing was changed.");
    }
    const { pack, outcome } = await makePack(week, CONSOLE_SERVICE, now);
    if (outcome.status === "exists") {
      return refused("That week's pack is already stored, and a stored pack is never made again. Nothing was changed.");
    }
    // Ids only: the security log's number check reads a date as digits.
    const auditRecorded = await audit(operator, "compliance_pack_generated", { packId: outcome.id });
    return ok({
      status: "stored",
      weekStart: week,
      packId: outcome.id,
      payloadHash: outcome.payloadHash,
      unreadSections: pack.build.unreadSections.length,
      auditRecorded,
    } satisfies GenerateCompliancePackOutcome);
  } catch (error) {
    if (error instanceof PackIncompleteError) {
      return refused(
        "Part of that week could not be read, so its pack was not stored. Try again later: after two days from its due time it is stored with the missing parts marked.",
      );
    }
    log.error("compliance pack not generated", { error: describeError(error) });
    return opsProblem("The compliance pack could not be made. Nothing was stored.", 500, "failed");
  }
}
