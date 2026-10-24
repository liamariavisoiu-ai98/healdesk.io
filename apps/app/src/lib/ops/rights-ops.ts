import { PATIENT_REQUEST_KINDS, type PatientRequestKind } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { isIsoDay, RIGHTS_KINDS, RIGHTS_VERIFICATIONS, utcDay, type RightsKind, type RightsVerification } from "@/lib/rights/clocks";
import {
  closeIntake,
  LINKABLE,
  RETELL_OUTSTANDING,
  listRights,
  recordIntake,
  RIGHTS_LIST_MAX,
  type RightsFilter,
} from "@/lib/rights/tracker";
import { withTenant } from "@/lib/tenant";

import { actorFor, audit, clinicById, ok, opsProblem, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The patient-rights tracker's ops operations (ops automation lane P6c;
 * design E6 item 16), kept beside the ops API's dispatch rather than in it.
 * The tracker tracks: these record, list and close, and none of them runs,
 * schedules or triggers an erasure, an amendment, an export or a host task.
 *
 *   - `listRights {status?, limit?, includeDemo?}`, a read across clinics:
 *     the open requests (or the done ones, or all) with their clocks and
 *     each one's prepared command (lib/rights/tracker.ts);
 *   - `recordRightsIntake {clinicId, requestKey, kind, receivedOn,
 *     verifiedVia, askedFor?, linkedRecordId?}`: one intake, once per
 *     request key (the form's own uuid) and per record it names;
 *     `askedFor` is required for a
 *     patient_request and refused for every other kind, because the host's
 *     task needs it;
 *   - `closeRightsIntake {clinicId, id, status}`: done or not applicable,
 *     once.
 *
 * Plain writes, with no fresh authenticator code: they record what the
 * operator says and execute nothing. Each writes an audit row in the
 * clinic's tenant and a security event naming the operator, with ids and
 * closed words only (no date: the security log's number check reads one as
 * digits).
 */

const UNKNOWN = (args: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(args).filter((key) => !allowed.includes(key));

/** The operator's label on the row: the address's local part when it has no `@`-free surprises, else "operator". */
export function operatorLabel(email: string): string {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return /^[a-z0-9._+-]{1,64}$/.test(local) && !/[0-9]{3,}/.test(local) ? local : "operator";
}

export async function opListRights(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["status", "limit", "includeDemo"]);
  if (unknown.length > 0) {
    return opsProblem("listRights takes only status, limit and includeDemo.", 400, "invalid_args");
  }
  const status = args.status ?? "open";
  if (status !== "open" && status !== "done" && status !== "all") {
    return opsProblem("The status is open, done or all.", 400, "invalid_args");
  }
  const limit = args.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > RIGHTS_LIST_MAX)) {
    return opsProblem(`The limit is a whole number from 1 to ${RIGHTS_LIST_MAX}.`, 400, "invalid_args");
  }
  if (args.includeDemo !== undefined && typeof args.includeDemo !== "boolean") {
    return opsProblem("includeDemo is a boolean.", 400, "invalid_args");
  }
  try {
    return ok(
      await listRights({
        actor: actorFor(operator),
        request: operator.request,
        operator: operator.email,
        filter: status as RightsFilter,
        limit: limit as number | undefined,
        includeDemo: args.includeDemo === true,
      }),
    );
  } catch (error) {
    log.error("rights tracker not listed", { error: describeError(error) });
    return opsProblem("The patient-rights requests could not be read.", 500, "failed");
  }
}

export async function opRecordRightsIntake(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["clinicId", "requestKey", "kind", "receivedOn", "verifiedVia", "askedFor", "linkedRecordId"]);
  if (unknown.length > 0) {
    return opsProblem(
      "recordRightsIntake takes only clinicId, requestKey, kind, receivedOn, verifiedVia, askedFor and linkedRecordId.",
      400,
      "invalid_args",
    );
  }
  const requestKey = typeof args.requestKey === "string" ? args.requestKey.trim().toLowerCase() : "";
  if (!UUID_SHAPED.test(requestKey)) {
    return opsProblem("The request key is a uuid, generated once when the form opens.", 400, "invalid_args");
  }
  const rawClinic = typeof args.clinicId === "string" ? args.clinicId.trim().toLowerCase() : "";
  if (!UUID_SHAPED.test(rawClinic)) return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  if (!(RIGHTS_KINDS as readonly unknown[]).includes(args.kind)) {
    return opsProblem(`The kind is one of ${RIGHTS_KINDS.join(", ")}.`, 400, "invalid_args");
  }
  const kind = args.kind as RightsKind;
  if (!(RIGHTS_VERIFICATIONS as readonly unknown[]).includes(args.verifiedVia)) {
    return opsProblem(`How it was verified is one of ${RIGHTS_VERIFICATIONS.join(", ")}.`, 400, "invalid_args");
  }
  const verifiedVia = args.verifiedVia as RightsVerification;
  if (!isIsoDay(args.receivedOn)) return opsProblem("The day received is YYYY-MM-DD.", 400, "invalid_args");
  const receivedOn = args.receivedOn;
  // A day ahead of UTC's is allowed: a clinic east of UTC can already be in tomorrow. Never later.
  if (receivedOn > utcDay(new Date(now.getTime() + 24 * 60 * 60 * 1000))) {
    return opsProblem("A request cannot be received after today.", 400, "invalid_args");
  }
  let askedFor: PatientRequestKind | null = null;
  if (kind === "patient_request") {
    if (!(PATIENT_REQUEST_KINDS as readonly unknown[]).includes(args.askedFor)) {
      return opsProblem(`What the patient asked for is one of ${PATIENT_REQUEST_KINDS.join(", ")}.`, 400, "invalid_args");
    }
    askedFor = args.askedFor as PatientRequestKind;
  } else if (args.askedFor !== undefined && args.askedFor !== null) {
    return opsProblem("askedFor is for a patient's own request only.", 400, "invalid_args");
  }
  let linkedRecordId: string | null = null;
  if (args.linkedRecordId !== undefined && args.linkedRecordId !== null) {
    const raw = typeof args.linkedRecordId === "string" ? args.linkedRecordId.trim().toLowerCase() : "";
    if (!UUID_SHAPED.test(raw)) return opsProblem("A linked record id must be a uuid.", 400, "invalid_args");
    if (!LINKABLE[kind]) {
      return opsProblem("A correction or an export is recorded by nothing an intake can name.", 400, "invalid_args");
    }
    linkedRecordId = raw;
  }
  const clinic = await clinicById(rawClinic);
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  try {
    const outcome = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) =>
        recordIntake(tx, {
          requestKey,
          kind,
          receivedOn,
          verifiedVia,
          askedFor,
          linkedRecordId,
          recordedBy: operatorLabel(operator.email),
        }),
    );
    if (outcome.outcome === "not_found") {
      return opsProblem("No such record at this clinic for that kind of request.", 404, "invalid_args");
    }
    if (outcome.outcome === "asked_for_mismatch") {
      return opsProblem("That patient request asked for something else.", 400, "invalid_args");
    }
    // Nothing changed, so nothing was owed to the log.
    if (outcome.outcome === "already_recorded") return ok({ ...outcome, auditRecorded: true });
    const auditRecorded = await audit(operator, "rights_intake_recorded", {
      clinicSlug: clinic.slug,
      intakeId: outcome.id,
      kind,
      verifiedVia,
      linkedRecordId,
    });
    return ok({ ...outcome, auditRecorded });
  } catch (error) {
    log.error("rights intake not recorded", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The request could not be recorded.", 500, "failed");
  }
}

export async function opCloseRightsIntake(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["clinicId", "id", "status"]);
  if (unknown.length > 0) {
    return opsProblem("closeRightsIntake takes only clinicId, id and status.", 400, "invalid_args");
  }
  const rawClinic = typeof args.clinicId === "string" ? args.clinicId.trim().toLowerCase() : "";
  const rawId = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
  if (!UUID_SHAPED.test(rawClinic) || !UUID_SHAPED.test(rawId)) {
    return opsProblem("The clinic and the intake are each a uuid.", 400, "invalid_args");
  }
  if (args.status !== "done" && args.status !== "not_applicable") {
    return opsProblem("Close an intake as done or not_applicable.", 400, "invalid_args");
  }
  const status = args.status;
  const clinic = await clinicById(rawClinic);
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  try {
    const outcome = await withTenant(
      { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
      (tx) => closeIntake(tx, { id: rawId, status }),
    );
    if (outcome.outcome === "not_found") return opsProblem("No such intake at this clinic.", 404, "invalid_args");
    if (outcome.outcome === "retell_outstanding") return opsProblem(`${RETELL_OUTSTANDING}.`, 409, "invalid_args");
    if (outcome.outcome === "already_closed") return ok({ ...outcome, auditRecorded: true });
    const auditRecorded = await audit(operator, "rights_intake_closed", {
      clinicSlug: clinic.slug,
      intakeId: rawId,
      status,
    });
    return ok({ ...outcome, auditRecorded });
  } catch (error) {
    log.error("rights intake not closed", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The request could not be closed.", 500, "failed");
  }
}
