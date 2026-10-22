import { describeError, log } from "@/lib/log";
import { deleteRecordedCall, listRecordingAlerts, type DeleteDeps } from "@/lib/voice/recording-alerts";

import {
  actorFor,
  audit,
  clinicById,
  ok,
  opsProblem,
  stringArg,
  UUID_SHAPED,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The ops operations for Retell calls not deleted in time, kept beside the
 * ops API's dispatch rather than in it (lib/ops/api.ts names them and calls
 * these). Retell keeps each call's transcript and recording until the
 * backstop job deletes the call once it is recorded here
 * (lib/voice/recording-alerts.ts); an alert is a call Retell still held
 * RETELL_DELETION_WINDOW_MS after it ended.
 *
 *   - `listRecordingAlerts`, a read for /admin/recordings: every alert, open
 *     first. A hand-written projection of ids and times (the clinic's id and
 *     slug, Retell's call id, when it was raised, the delete attempts and our
 *     own reason for the last failure). Never a recording URL, a transcript
 *     or a number: the table holds none (drizzle/0105).
 *   - `deleteRecordedCall`, the manual backstop's button: apps/app, which
 *     alone holds HEALDESK_RETELL_API_KEY, asks Retell to delete the call,
 *     and the alert resolves when Retell answers 204, or its own JSON 404 (status "error") for a call it
 *     no longer has. A resolved alert answers `already` without asking
 *     again; a failure stays open with the reason. Each press is a security
 *     event naming the operator.
 */

let depsForTests: DeleteDeps | undefined;

/** Test seam: the fetch, key and clock the delete uses. Undefined restores them. */
export function __setRecordingDeleteDepsForTests(deps: DeleteDeps | undefined): void {
  depsForTests = deps;
}

export async function opListRecordingAlerts(operator: Operator): Promise<OpsOutcome> {
  try {
    return ok(await listRecordingAlerts(actorFor(operator), operator.request));
  } catch (error) {
    log.error("retell deletion alerts not listed", { error: describeError(error) });
    return opsProblem("The Retell deletion alerts could not be read.", 500, "failed");
  }
}

export async function opDeleteRecordedCall(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinicId = stringArg(args, "clinicId", 64);
  const alertId = stringArg(args, "alertId", 64);
  if (!clinicId || !UUID_SHAPED.test(clinicId) || !alertId || !UUID_SHAPED.test(alertId)) {
    return opsProblem("A clinic id and an alert id are required.", 400, "invalid_args");
  }
  if (!(await clinicById(clinicId))) return ok({ status: "not_found" });
  let outcome;
  try {
    outcome = await deleteRecordedCall(clinicId, alertId, actorFor(operator), operator.request, depsForTests);
  } catch (error) {
    log.error("recorded call not deleted", { clinicId, error: describeError(error) });
    return opsProblem("The delete could not be recorded.", 500, "failed");
  }
  if (outcome.status === "deleted" || outcome.status === "failed") {
    await audit(operator, "retell_recorded_call_delete", { clinicId, alertId, outcome: outcome.status });
  }
  return ok(outcome);
}
