import { and, eq, like } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { incidents, opsApprovals } from "@/db/schema";
import { ASSISTANT, reportProposal, reportSubject } from "@/lib/approvals/incident-kinds";
import { MAX_BATCH_CLINICS } from "@/lib/approvals/incident-payloads";
import { propose, type Proposal } from "@/lib/approvals/store";
import { checklistOf, tickStep, type ChecklistRow, type TickRefusal } from "@/lib/incidents/assistant/checklist";
import { batchKey, incidentScope, readScopeArgs, type ScopeResult } from "@/lib/incidents/assistant/scope";
import { isChecklistStep, type ChecklistStep } from "@/lib/incidents/assistant/vocab";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

// api.ts imports this module for its dispatch, and this module borrows
// api.ts's helpers: safe, because nothing here touches them while the
// modules load (the same note as lib/ops/billing.ts).
import { actorFor, audit, clinicById, ok, opsProblem, stringArg, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The incident assistant's operations (ops automation Phase 6, lane P6i;
 * design E6 §3 item 17; docs/incident-response.md). The page is lane P6j's.
 * The assistant gathers and drafts; the owner decides, through the approval
 * inbox, with a fresh code (owner decision D18). Nothing here sends a
 * report, records an incident not reportable, resolves one, or opens one by
 * itself:
 *
 *   - `incidentScope {vendor | channel, from, to, class?, discoveredAt?,
 *     includeDemo?}` (read): the clinics the scope reached, each with its
 *     conversation counts per channel, its agreement version and, given the
 *     class and discovery, both clocks. Ids, counts, versions, dates and the
 *     clinic's name only.
 *   - `incidentChecklist {clinicId, incidentId}` (read): the procedure's
 *     steps, each ticked or not, with who and when.
 *   - `tickIncidentStep {clinicId, incidentId, step}` (write): one step
 *     ticked, once, add-only, by the operator account. It records the step;
 *     it does not do it.
 *   - `proposeIncidentBatch {vendor | channel, from, to, class,
 *     discoveredAt, includeDemo?}` (write): reads the scope again here and
 *     proposes one inbox item that, approved, opens an incident at each
 *     clinic it lists. Opens nothing now.
 *   - `proposeIncidentReport {clinicId, incidentId}` (write): proposes the
 *     incident's next report, pre-filled from fixed lists, due at its
 *     agreement deadline. Sends nothing now.
 *
 * Outcomes are `{ status: <done>, ... }` or `{ status: "refused", message }`,
 * the console's convention; every write records one security event.
 */

type Refused = { status: "refused"; message: string };
const refused = (message: string) => ok({ status: "refused", message } satisfies Refused);

const TICK_REFUSALS: Readonly<Record<TickRefusal, string>> = {
  no_such_incident: "No such incident at this clinic.",
  not_notified_yet:
    "No report has gone and no notice is recorded for this incident yet, so the email step cannot be ticked. Send the report first, or record how the practice was told on its Care tab.",
  not_resolved_yet: "This incident is not resolved yet. Resolve it on the clinic's Care tab, then tick this step.",
};

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export async function opIncidentScope(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const input = readScopeArgs(args);
  if ("problem" in input) return opsProblem(input.problem, 400, "invalid_args");
  try {
    const scope = await incidentScope(input, { actor: actorFor(operator), request: operator.request });
    return ok(scope satisfies ScopeResult);
  } catch (error) {
    log.error("incident scope not read", { error: describeError(error) });
    return opsProblem("The scope could not be read.", 500, "failed");
  }
}

export type IncidentChecklistView = { incidentId: string; steps: ChecklistRow[] };

export async function opIncidentChecklist(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const incidentId = stringArg(args, "incidentId");
  if (!incidentId || !UUID_SHAPED.test(incidentId)) return refused("Which incident?");
  const steps = await withTenant({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, (tx) =>
    checklistOf(tx, incidentId),
  );
  if (!steps) return refused(TICK_REFUSALS.no_such_incident);
  return ok({ incidentId, steps } satisfies IncidentChecklistView);
}

// -----------------------------------------------------------------------------
// The checklist
// -----------------------------------------------------------------------------

export type TickOutcomeView =
  | { status: "ticked" | "already"; step: ChecklistStep; tickedAt: string; affectedCount: number | null; auditRecorded: boolean }
  | Refused;

export async function opTickIncidentStep(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  if (typeof operator?.email !== "string" || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(operator.email)) {
    return opsProblem("No operator to record the tick against.", 401, "unauthorized");
  }
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const incidentId = stringArg(args, "incidentId");
  if (!incidentId || !UUID_SHAPED.test(incidentId)) return refused("Which incident?");
  const step = args.step;
  if (!isChecklistStep(step)) return refused("Pick the step from the checklist.");
  const outcome = await withTenant({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, (tx) =>
    tickStep(tx, { incidentId, step, tickedBy: operator.email }),
  );
  if (outcome.status === "refused") return refused(TICK_REFUSALS[outcome.refusal]);
  const auditRecorded =
    outcome.status === "ticked"
      ? await audit(operator, "incident_step_ticked", { clinicSlug: clinic.slug, incidentId, step })
      : true;
  return ok({
    status: outcome.status,
    step,
    tickedAt: outcome.tickedAt.toISOString(),
    affectedCount: outcome.status === "ticked" ? outcome.affectedCount : null,
    auditRecorded,
  } satisfies TickOutcomeView);
}

// -----------------------------------------------------------------------------
// Proposals: nothing runs until the owner approves in the inbox
// -----------------------------------------------------------------------------

export type ProposalOutcome =
  | { status: "proposed" | "already_waiting"; approvalId: string; clinics?: number; auditRecorded: boolean }
  | Refused;

async function waitingFor(kind: "incident_open_batch" | "incident_report_send", subjectRef: string): Promise<string | null> {
  const [row] = await unsafeDb
    .select({ id: opsApprovals.id })
    .from(opsApprovals)
    .where(and(eq(opsApprovals.kind, kind), eq(opsApprovals.subjectRef, subjectRef), eq(opsApprovals.status, "waiting")))
    .limit(1);
  return row?.id ?? null;
}

function operatorActor(operator: Operator) {
  return { label: operator.email, ip: operator.request.ipAddress ?? null, userAgent: operator.request.userAgent ?? null };
}

/**
 * Why a scope is too big for one approval, and what to do instead. A
 * window-bound scope (a vendor whose incident window names the
 * conversations) shrinks with a shorter window; an all-holding one
 * (database_host, aws) selects every clinic that ever held data, whatever
 * the window, so a shorter window changes nothing.
 */
export function tooManyClinics(reach: "window_only" | "all_holding", n: number): string {
  return reach === "all_holding"
    ? `This scope reaches ${n} clinics, more than the ${MAX_BATCH_CLINICS} one approval may open. Open the incidents for the rest from each clinic's Care tab, or propose the batch in parts by clinic group once the console offers it.`
    : `This scope reaches ${n} clinics, more than the ${MAX_BATCH_CLINICS} one approval may open. Split it into shorter windows and propose each one.`;
}

export async function opProposeIncidentBatch(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const input = readScopeArgs(args);
  if ("problem" in input) return refused(input.problem);
  if (!input.incidentClass || !input.discoveredAt) return refused("Give the class and the discovery time: each incident is opened with them.");
  const scope = await incidentScope(input, { actor: actorFor(operator), request: operator.request });
  if (scope.unread > 0) {
    return refused(
      `${scope.unread} clinic${scope.unread === 1 ? "" : "s"} could not be read, so the scope may be missing some. Nothing was proposed; try again.`,
    );
  }
  if (scope.clinics.length === 0) {
    return refused(
      input.reach === "all_holding"
        ? "No clinic holds any data yet, so there is nothing to open. Record the vendor's notice as an incident finding with no clinic affected."
        : "No clinic had a conversation through this in that window, so there is nothing to open. Record the vendor's notice as an incident finding with no clinic affected.",
    );
  }
  if (scope.clinics.length > MAX_BATCH_CLINICS) return refused(tooManyClinics(input.reach, scope.clinics.length));
  const subjectRef = batchKey({ ...input, incidentClass: input.incidentClass });
  const waiting = await waitingFor("incident_open_batch", subjectRef);
  if (waiting) return ok({ status: "already_waiting", approvalId: waiting, auditRecorded: true } satisfies ProposalOutcome);
  const now = new Date();
  const id = await propose(
    {
      kind: "incident_open_batch",
      subjectClinicId: null,
      subjectRef,
      payload: {
        source: input.source,
        value: input.value,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        incidentClass: input.incidentClass,
        discoveredAt: input.discoveredAt.toISOString(),
        reach: input.reach,
        clinicIds: scope.clinics.map((c) => c.clinicId),
        counts: scope.clinics.map((c) => c.total),
      },
      // Due at the internal target: the agreements' deadlines are each incident's report's.
      dueAt: new Date(input.discoveredAt.getTime() + 24 * 60 * 60 * 1000),
      proposedBy: ASSISTANT,
      actor: operatorActor(operator),
    },
    now,
  );
  if (!id) {
    // propose() inserts nothing while an item for this scope waits, or after
    // the owner rejected one; another request may also have just proposed it.
    return refused(
      "This scope is already waiting for your yes, or you rejected it before, so nothing new was proposed. Look for it under the incident assistant's items; to open an incident at one clinic, use its Care tab.",
    );
  }
  const auditRecorded = await audit(operator, "incident_batch_proposed", {
    approvalId: id,
    source: input.source,
    value: input.value,
    class: input.incidentClass,
    clinics: scope.clinics.length,
  });
  return ok({ status: "proposed", approvalId: id, clinics: scope.clinics.length, auditRecorded } satisfies ProposalOutcome);
}

export async function opProposeIncidentReport(args: Record<string, unknown>, operator: Operator): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return refused("No such clinic.");
  const incidentId = stringArg(args, "incidentId");
  if (!incidentId || !UUID_SHAPED.test(incidentId)) return refused("Which incident?");
  type Prepared = { refusal: string } | { waiting: string } | { proposal: Proposal<"incident_report_send"> };
  const prepared = await withTenant<Prepared>({ clinicId: clinic.id, actor: actorFor(operator), request: operator.request }, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, incidentId), eq(incidents.clinicId, tx.clinicId)))
      .limit(1);
    if (!row) return { refusal: "No such incident at this clinic." } as const;
    const report = row.reportsSent + 1;
    const base = reportSubject(row.id, report);
    // Every item already proposed for this report: a waiting one is the answer; each rejection lets one more be proposed.
    const earlier = await unsafeDb
      .select({ id: opsApprovals.id, status: opsApprovals.status, subjectRef: opsApprovals.subjectRef })
      .from(opsApprovals)
      .where(and(eq(opsApprovals.kind, "incident_report_send"), like(opsApprovals.subjectRef, `${base}%`)));
    const mine = earlier.filter((e) => e.subjectRef === base || e.subjectRef.startsWith(`${base}:`));
    const waiting = mine.find((e) => e.status === "waiting");
    if (waiting) return { waiting: waiting.id } as const;
    const attempt = mine.length;
    const proposal = await reportProposal(tx, row, { proposedBy: ASSISTANT, actor: operatorActor(operator), attempt });
    if (!proposal) {
      return {
        refusal:
          "This incident is not waiting for a report: a service complaint, already recorded not reportable, or resolved.",
      } as const;
    }
    return { proposal } as const;
  });
  if ("refusal" in prepared) return refused(prepared.refusal);
  if ("waiting" in prepared) {
    return ok({ status: "already_waiting", approvalId: prepared.waiting, auditRecorded: true } satisfies ProposalOutcome);
  }
  const id = await propose(prepared.proposal, new Date());
  if (!id) return refused("A report for this incident is already waiting or was just decided. Reload to see where it stands.");
  const auditRecorded = await audit(operator, "incident_report_proposed", {
    approvalId: id,
    clinicSlug: clinic.slug,
    incidentId,
    report: prepared.proposal.payload.report,
  });
  return ok({ status: "proposed", approvalId: id, auditRecorded } satisfies ProposalOutcome);
}
