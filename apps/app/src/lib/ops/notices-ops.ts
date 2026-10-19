import { startBaaVersionResigns, type BaaVersionResignSummary } from "@/lib/agreements/baa-version";
import { assertNoPhi, PhiInAuditError } from "@/lib/audit";
import {
  broadcastProductUpdate,
  broadcastSubprocessorNotice,
  broadcastTermsNotice,
  incidentRegister,
  markIncidentNotReportable,
  operatorNoticesView,
  recordGuaranteeClaim,
  sendGuaranteeFinding,
  sendIncidentReport,
  suspendForCause,
  type BroadcastSummary,
  type IncidentRegisterRow,
  type OperatorNoticesView,
} from "@/lib/notices/operator-notices";

import {
  actorFor,
  audit,
  booleanArg,
  clinicById,
  ok,
  stringArg,
  UUID_SHAPED,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The console's operator notices and the cross-practice incidents page
 * (WP7; plan Part K): what /admin/incidents and /admin/notices send through
 * the ops envelope. Every argument is an id, a date, a flag or a code from
 * the catalog's closed lists (packages/catalog operator-notices.ts), checked
 * again in lib/notices/operator-notices.ts; the one piece of prose, the
 * reason an incident is not reportable, is PHI-scanned here as an incident
 * summary is. Nothing here returns a payload, an address or a patient.
 *
 * Outcomes are `{ status: <done>, ..., auditRecorded }` or
 * `{ status: "refused", message }`, the console's convention.
 */

type Refused = { status: "refused"; message: string };

const refused = (message: string) => ok({ status: "refused", message } satisfies Refused);

/** The reason an incident is not reportable: prose, scanned like an incident summary. */
function reasonProblem(reason: string | undefined): string | null {
  if (!reason) return "Say why it is not reportable.";
  try {
    assertNoPhi({ remark: reason }, "reason");
    return null;
  } catch (error) {
    if (error instanceof PhiInAuditError) {
      return `The reason looks like it carries patient details (${error.message}). Give it in ids and counts.`;
    }
    throw error;
  }
}

// -----------------------------------------------------------------------------
// The incidents page
// -----------------------------------------------------------------------------

export type IncidentRegisterView = { incidents: IncidentRegisterRow[] };

export async function opListIncidentRegister(operator: Operator): Promise<OpsOutcome> {
  const incidents = await incidentRegister(actorFor(operator));
  return ok({ incidents } satisfies IncidentRegisterView);
}

export type SendIncidentReportOutcome =
  { status: "sent"; report: number; auditRecorded: boolean } | Refused;

export async function opSendIncidentReport(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const incidentId = stringArg(args, "incidentId");
  if (!incidentId || !UUID_SHAPED.test(incidentId)) return refused("Which incident?");
  const result = await sendIncidentReport(
    clinic.id,
    incidentId,
    {
      event: args.event,
      occurredOn: args.occurredOn,
      info: args.info,
      mitigations: args.mitigations,
    },
    { actorLabel: operator.email },
  );
  if (result.status !== "sent") return ok(result);
  const auditRecorded = await audit(operator, "incident_report_sent", {
    clinicSlug: clinic.slug,
    incidentId,
    report: result.report,
  });
  return ok({
    status: "sent",
    report: result.report,
    auditRecorded,
  } satisfies SendIncidentReportOutcome);
}

export type NotReportableOutcome = { status: "updated"; auditRecorded: boolean } | Refused;

export async function opMarkIncidentNotReportable(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const incidentId = stringArg(args, "incidentId");
  if (!incidentId || !UUID_SHAPED.test(incidentId)) return refused("Which incident?");
  const reason = stringArg(args, "reason", 2000);
  const problem = reasonProblem(reason);
  if (problem) return refused(problem);
  const result = await markIncidentNotReportable(clinic.id, incidentId, reason!, {
    actorLabel: operator.email,
  });
  if (result.status !== "updated") return ok(result);
  const auditRecorded = await audit(operator, "incident_not_reportable", {
    clinicSlug: clinic.slug,
    incidentId,
  });
  return ok({ status: "updated", auditRecorded } satisfies NotReportableOutcome);
}

// -----------------------------------------------------------------------------
// Broadcasts: L28, L29's subcontractor notice, L33
// -----------------------------------------------------------------------------

export type BroadcastOutcome = (BroadcastSummary & { auditRecorded: boolean }) | Refused;

async function broadcastOutcome(
  operator: Operator,
  event: string,
  result: BroadcastSummary | Refused,
  metadata: Record<string, unknown>,
): Promise<OpsOutcome> {
  if (result.status !== "queued") return ok(result);
  const auditRecorded = await audit(operator, event, {
    ...metadata,
    queued: result.queued,
    alreadyQueued: result.alreadyQueued,
    noAddress: result.noAddress,
    failed: result.failed,
  });
  return ok({ ...result, auditRecorded } satisfies BroadcastOutcome);
}

export async function opSendTermsNotice(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const result = await broadcastTermsNotice({
    version: stringArg(args, "version", 40),
    effectiveOn: stringArg(args, "effectiveOn", 10),
    topics: args.topics,
    isPublished: booleanArg(args, "isPublished"),
    actorLabel: operator.email,
  });
  // No version or date in the audit row: the guard reads "2026-11-30.1" as
  // a phone number and would refuse the whole row. The notices carry them.
  return broadcastOutcome(operator, "terms_notice_sent", result, {});
}

export async function opSendSubprocessorNotice(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const provider = stringArg(args, "provider", 40);
  const result = await broadcastSubprocessorNotice({
    provider,
    startsAt: stringArg(args, "startsAt", 40),
    actorLabel: operator.email,
  });
  return broadcastOutcome(operator, "subprocessor_notice_sent", result, { provider });
}

export async function opSendProductUpdate(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const code = stringArg(args, "code", 64);
  const result = await broadcastProductUpdate({ code, actorLabel: operator.email });
  return broadcastOutcome(operator, "product_update_sent", result, { code });
}

// -----------------------------------------------------------------------------
// L22 for every account on an older BAA (wave 2 R11)
// -----------------------------------------------------------------------------

export type BaaVersionResignOutcome = (BaaVersionResignSummary & { auditRecorded: boolean }) | Refused;

export async function opStartBaaVersionResigns(operator: Operator): Promise<OpsOutcome> {
  const result = await startBaaVersionResigns({ actorLabel: operator.email });
  if (result.status !== "started") return ok(result);
  // Counts only: the guard reads a version such as "1.6.0" beside a date as
  // a number it must refuse, and the re-signs' own rows name the versions.
  const auditRecorded = await audit(operator, "baa_version_resigns_started", {
    opened: result.opened,
    emailed: result.emailed,
    alreadyOpen: result.alreadyOpen,
    failed: result.failed,
  });
  return ok({ ...result, auditRecorded } satisfies BaaVersionResignOutcome);
}

// -----------------------------------------------------------------------------
// One practice: L30 and L31
// -----------------------------------------------------------------------------

export type GuaranteeClaimOutcome =
  { status: "queued"; findingByOn: string; auditRecorded: boolean } | Refused;

export async function opRecordGuaranteeClaim(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const result = await recordGuaranteeClaim(clinic.id, {
    claimReceivedOn: stringArg(args, "claimReceivedOn", 10),
    actorLabel: operator.email,
  });
  if (result.status !== "queued") return ok(result);
  // No date in the audit row (the guard reads one as a phone number); the
  // claim's notice carries it.
  const auditRecorded = await audit(operator, "guarantee_claim_recorded", {
    clinicSlug: clinic.slug,
  });
  return ok({
    status: "queued",
    findingByOn: result.findingByOn,
    auditRecorded,
  } satisfies GuaranteeClaimOutcome);
}

export type GuaranteeFindingOutcome = { status: "queued"; auditRecorded: boolean } | Refused;

export async function opSendGuaranteeFinding(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const outcome = stringArg(args, "outcome", 40);
  const result = await sendGuaranteeFinding(clinic.id, {
    claimReceivedOn: stringArg(args, "claimReceivedOn", 10),
    outcome,
    refundByOn: stringArg(args, "refundByOn", 10),
    failure: stringArg(args, "failure", 40),
    actorLabel: operator.email,
  });
  if (result.status !== "queued") return ok(result);
  const auditRecorded = await audit(operator, "guarantee_finding_sent", {
    clinicSlug: clinic.slug,
    outcome,
  });
  return ok({ status: "queued", auditRecorded } satisfies GuaranteeFindingOutcome);
}

export type SuspendForCauseOutcome = { status: "suspended"; auditRecorded: boolean } | Refused;

export async function opSuspendForCause(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const cause = stringArg(args, "cause", 40);
  const result = await suspendForCause(clinic.id, { cause, actorLabel: operator.email });
  if (result.status !== "suspended") return ok(result);
  const auditRecorded = await audit(operator, "suspended_for_cause", {
    clinicSlug: clinic.slug,
    cause,
  });
  return ok({ status: "suspended", auditRecorded } satisfies SuspendForCauseOutcome);
}

// -----------------------------------------------------------------------------
// The record
// -----------------------------------------------------------------------------

export async function opGetOperatorNotices(operator: Operator): Promise<OpsOutcome> {
  const view = await operatorNoticesView(actorFor(operator));
  return ok(view satisfies OperatorNoticesView);
}
