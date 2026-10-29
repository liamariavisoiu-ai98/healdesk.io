import { isMissCaseStatus, listAnswerCases, setMissCaseStatus } from "@/lib/channels/miss-cases";
import { describeError, log } from "@/lib/log";

import { actorFor, audit, clinicById, ok, opsProblem, stringArg, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The ops operations for Queues › Misses and outages (lib/channels/
 * miss-cases.ts; the workflows in lib/channels/answer-notices.ts), kept
 * beside the ops API's dispatch as recording-alerts-ops.ts is:
 *
 *   - `listAnswerCases`, a read: every outage incident (opened with L17,
 *     closed with L18) and every miss case (opened with L21), as ids, channel
 *     ids, counts, days and times. Never a caller, a number or a word.
 *   - `setMissCaseStatus`, the owner's move of one miss case: looking,
 *     explained or closed (or back to open). Each move is a security event
 *     naming the operator.
 */

export async function opListAnswerCases(operator: Operator): Promise<OpsOutcome> {
  try {
    return ok(await listAnswerCases(actorFor(operator), operator.request));
  } catch (error) {
    log.error("answer cases not listed", { error: describeError(error) });
    return opsProblem("The misses and outages could not be read.", 500, "failed");
  }
}

export async function opSetMissCaseStatus(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  const caseId = stringArg(args, "caseId", 64);
  const status = args.status;
  if (!clinicId || !UUID_SHAPED.test(clinicId) || !caseId || !UUID_SHAPED.test(caseId) || !isMissCaseStatus(status)) {
    return opsProblem("A clinic id, a case id and a status are required.", 400, "invalid_args");
  }
  if (!(await clinicById(clinicId))) return ok({ status: "not_found" });
  try {
    const moved = await setMissCaseStatus(clinicId, caseId, status, actorFor(operator), { note: args.note });
    if (moved.status === "moved") await audit(operator, "miss_case_status", { clinicId, caseId, status });
    return ok(moved);
  } catch (error) {
    log.error("miss case not moved", { clinicId, error: describeError(error) });
    return opsProblem("The miss case could not be moved.", 500, "failed");
  }
}
