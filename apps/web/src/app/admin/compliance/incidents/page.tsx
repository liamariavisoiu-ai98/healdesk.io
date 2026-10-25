import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { checkApprovalEdit } from "@/app/admin/queues/approval-edit";
import type { ApprovalEdit } from "@/app/admin/queues/ApprovalDecision";
import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import { isUuid } from "@/lib/admin/issue-link";
import { requireOperator } from "@/lib/admin/operator";
import {
  fetchIncidentApprovals,
  fetchIncidentChecklist,
  fetchIncidentRegister,
  fetchIncidentScope,
  fetchJobs,
  markIncidentNotReportable as notReportableUpstream,
  proposeIncidentBatch,
  proposeIncidentReport,
  sendIncidentReport as sendReportUpstream,
  tickIncidentStep,
  type ApproveReason,
  type ChecklistStep,
  type IncidentReportFields,
  type IncidentScopeQuery,
  type RejectReason,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { INCIDENT_PROPOSER_JOBS, IncidentAssistant } from "./IncidentAssistant";
import { IncidentsBoard } from "./IncidentsBoard";
import { checkScopeQuery } from "./scope-input";

/**
 * /admin/compliance/incidents (until 23 October 2026 /admin/incidents): every practice's incidents on one page (WP7; plan Part
 * K), each with the deadline its agreement promises and healdesk's internal
 * target beside it, and ops' decision: "Send report", which emails the
 * practice an L29 report built from fixed fields only, or "Not reportable",
 * which records the reason. Nothing reaches a practice unless ops sends it.
 *
 * Incidents are opened, notified and resolved from each practice's care
 * page, as before; this page is where they are decided. Everything goes
 * through the ops envelope: the report's fields are the catalog's codes,
 * counts and a date, and the reason is scanned by apps/app for anything that
 * looks like a patient's details. The list of people affected is never
 * emailed and never typed here.
 *
 * The Incident assistant (ops automation lane P6j; the operations are lane
 * P6i's) adds, on each card, the incident's checklist ("Tick" records a
 * step) and "Propose the report", and below the list its own section: the
 * assistant's items waiting for the owner's yes (the same cards and the
 * same step-up decision as Queues › Approvals, through
 * lib/admin/approval-decide.ts), and the scope form with "Propose opening
 * these incidents". Each proposal only proposes; each tick only records.
 */

export const metadata: Metadata = { title: "Incidents" };
export const dynamic = "force-dynamic";

const PATH = "/admin/compliance/incidents";

const NOT_THIS_PAGE = { ok: false as const, code: "refused" as const, message: "That incident is not one on this page. Reload and try again." };

export default async function IncidentsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  // The jobs are read for two switches: with both proposer jobs off, no
  // incident's first report is proposed by itself, which the empty line
  // then says. A failed jobs read says nothing extra.
  const [register, items, jobs] = await Promise.all([fetchIncidentRegister(), fetchIncidentApprovals(), fetchJobs()]);
  if (isHostUnreachable(register)) return <HostStandbyPage title="Incidents" />;
  const now = new Date().toISOString();
  const proposersOff = jobs.ok
    ? INCIDENT_PROPOSER_JOBS.every((name) => jobs.data.some((job) => job.name === name && !job.enabled))
    : null;

  async function sendReport(clinicId: string, incidentId: string, fields: IncidentReportFields) {
    "use server";
    const result = await sendReportUpstream(clinicId, incidentId, fields);
    revalidatePath(PATH);
    return result;
  }
  async function notReportable(clinicId: string, incidentId: string, reason: string) {
    "use server";
    const result = await notReportableUpstream(clinicId, incidentId, reason);
    revalidatePath(PATH);
    return result;
  }

  // The assistant's reads and proposals. The ids are the card's, drawn by
  // this page; a scope is checked against apps/app's own lists and window
  // rules before the signed request (./scope-input.ts).
  async function readScope(query: IncidentScopeQuery) {
    "use server";
    const checked = checkScopeQuery(query, new Date().toISOString());
    if (!checked.ok) return { ok: false as const, code: "refused" as const, message: checked.problem };
    return fetchIncidentScope(checked.query);
  }
  async function proposeBatch(query: IncidentScopeQuery) {
    "use server";
    const checked = checkScopeQuery(query, new Date().toISOString());
    if (!checked.ok) return { ok: false as const, code: "refused" as const, message: checked.problem };
    const q = checked.query;
    if (q.class === undefined || q.discoveredAt === undefined) {
      return { ok: true as const, data: { status: "refused" as const, message: "Give the class and the discovery time: each incident is opened with them." } };
    }
    const result = await proposeIncidentBatch({ ...q, class: q.class, discoveredAt: q.discoveredAt });
    revalidatePath(PATH);
    return result;
  }
  async function checklist(clinicId: string, incidentId: string) {
    "use server";
    if (!isUuid(clinicId) || !isUuid(incidentId)) return NOT_THIS_PAGE;
    return fetchIncidentChecklist(clinicId, incidentId);
  }
  async function tick(clinicId: string, incidentId: string, step: ChecklistStep) {
    "use server";
    if (!isUuid(clinicId) || !isUuid(incidentId)) return NOT_THIS_PAGE;
    const result = await tickIncidentStep(clinicId, incidentId, step);
    revalidatePath(PATH);
    return result;
  }
  async function proposeReport(clinicId: string, incidentId: string) {
    "use server";
    if (!isUuid(clinicId) || !isUuid(incidentId)) return NOT_THIS_PAGE;
    const result = await proposeIncidentReport(clinicId, incidentId);
    revalidatePath(PATH);
    return result;
  }

  // A decision on one of the assistant's items: the same entry as Queues ›
  // Approvals (the session, then the fresh code, then the signed request),
  // the report's choices checked by the ops client against the lists.
  async function decide(approvalId: string, action: "approve" | "reject", reasonCode: ApproveReason | RejectReason, code: string, edit?: ApprovalEdit) {
    "use server";
    const checked = checkApprovalEdit(edit);
    if (!checked.ok) return { ok: true as const, data: { status: "refused" as const, message: checked.message } };
    const e = checked.edit;
    const result = await decideApprovalWithCode(
      approvalId,
      action,
      reasonCode,
      code,
      e && "fields" in e ? { fields: e.fields } : undefined,
      e && "incident" in e ? e.incident : undefined,
    );
    revalidatePath(PATH);
    revalidatePath("/admin/queues");
    return result;
  }

  return (
    <IncidentsBoard register={register} now={now} actions={{ sendReport, notReportable, assistant: { checklist, tick, proposeReport } }}>
      <IncidentAssistant items={items} proposersOff={proposersOff} now={now} onDecide={decide} onReadScope={readScope} onProposeBatch={proposeBatch} />
    </IncidentsBoard>
  );
}
