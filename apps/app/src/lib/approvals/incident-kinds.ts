import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { incidents, opsApprovals, type OpsApproval } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { checklistOf, incidentOpenedBy, tickStep } from "@/lib/incidents/assistant/checklist";
import {
  fieldsHash,
  parseReportFields,
  prefillReport,
  senderInput,
  type ReportFields,
} from "@/lib/incidents/assistant/report-draft";
import { batchKey, clocksFor, type ScopeClocks } from "@/lib/incidents/assistant/scope";
import type { BatchClass, ScopeReach, ScopeSource } from "@/lib/incidents/assistant/vocab";
import { openIncident } from "@/lib/incidents/incidents";
import { isReportableClass } from "@/lib/incidents/reporting-rules";
import { describeError, log } from "@/lib/log";
import { readIncidentReportFields } from "@/lib/notices/operator-notices";
import { actorFor, audit, type OpsOutcome } from "@/lib/ops/api";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import type { OpsEvent } from "@/lib/ops/notify";
import { opSendIncidentReport } from "@/lib/ops/notices-ops";
import { withTenant, type TenantTx } from "@/lib/tenant";

import type { ExecutionContext, ExecutionResult, Executor } from "./executors";
import type { IncidentBatchPayload, IncidentReportPayload } from "./incident-payloads";
import { KIND_SPECS, parsePayload, type ApprovalKind } from "./kinds";
import { propose, type EventActor, type Proposal } from "./store";

/**
 * The incident assistant's two approval kinds (ops automation Phase 6, lane
 * P6i; design E6 §3 item 17; owner decision D18): what each runs, its
 * packet, how the owner edits it, and what the hourly proposer finds.
 *
 *   - `incident_open_batch`: one item for a vendor's or a channel's scope,
 *     proposed by an operator pressing a button (`proposeIncidentBatch`).
 *     Approving runs the existing openIncident at each clinic the scope
 *     listed when it was proposed, in this same request, once per clinic per
 *     scope ever (the `open` tick's batch key), and puts each new incident's
 *     report in the list for its own yes. It sends nothing.
 *   - `incident_report_send`: one item per report (and per update), its L29
 *     fields pre-filled from the incident (lib/incidents/assistant/
 *     report-draft.ts) and changed only by choosing from the catalog's lists.
 *     Approving runs the Incidents page's own Send report
 *     (lib/ops/notices-ops.ts opSendIncidentReport) with those fields, once.
 *     Proposed by an operator (`proposeIncidentReport`), by an approved
 *     batch for each incident it opened, and by the hourly proposer for any
 *     open reportable incident whose first report has not gone, so the
 *     agreement's clock cannot pass unnoticed. Due at the incident's
 *     agreement deadline.
 *
 * Both are legal clocks: alerted on arrival and re-alerted every 4 hours
 * while they wait, by email and Slack (event incident_step_waiting), never
 * expired by time and never approved by time. The proposal of first reports,
 * the clean-up of overtaken items and those alerts run from the hourly
 * incident-deadlines job, which ships on, as well as from approvals-propose
 * (./incident-sweep.ts), so neither depends on the other's switch. Not
 * reportable stays the Incidents page's own owner-only button: nothing here
 * records it, and nothing here resolves an incident.
 *
 * Until lane P6j draws these items on the Incidents page, no apps/web screen
 * shows them: the Approvals section reads only the billing family
 * (lib/ops/approval-ops.ts `family`), and apps/web's
 * fetchIncidentApprovals has no caller yet. P6j must draw them before the
 * Home row and the alert, which point at the Incidents page, are true.
 */

export const INCIDENT_KINDS: ReadonlySet<string> = new Set<ApprovalKind>(["incident_open_batch", "incident_report_send"]);

/** The service name an operator's proposal is recorded under (ops_approvals.proposed_by). */
export const ASSISTANT = "incident-assistant";

/** The alert a waiting item of this kind re-raises: the incident kinds' own wording, every other kind's approval_waiting. */
export function waitingAlertEvent(kind: string): OpsEvent {
  return INCIDENT_KINDS.has(kind) ? "incident_step_waiting" : "approval_waiting";
}

type Ctx = { actor: ActorContext; request?: RequestContext };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

// -----------------------------------------------------------------------------
// The report: its subject, its pre-fill, and the proposal
// -----------------------------------------------------------------------------

/** "<incident id>:<report number>", with a third part for an operator's proposal after a rejection. */
export function reportSubject(incidentId: string, report: number, attempt = 0): string {
  return attempt > 0 ? `${incidentId}:${report}:${attempt}` : `${incidentId}:${report}`;
}

export function parseReportSubject(subjectRef: string): { incidentId: string; report: number } | null {
  const [incidentId, n] = subjectRef.split(":");
  const report = Number(n);
  return incidentId && Number.isInteger(report) && report >= 1 ? { incidentId, report } : null;
}

type IncidentRow = typeof incidents.$inferSelect;

/** Whether the incident is still waiting for report number `report`: open, reportable, undecided, with report−1 sent. */
export function awaitingReport(row: Pick<IncidentRow, "class" | "resolvedAt" | "notReportableAt" | "reportsSent">, report: number): boolean {
  return isReportableClass(row.class) && !row.resolvedAt && !row.notReportableAt && row.reportsSent === report - 1;
}

/** The scope a batch opened the incident from, read off its `open` tick. */
async function batchOf(tx: TenantTx, incidentId: string): Promise<{ source: ScopeSource; fromDay: string } | null> {
  const result = await tx.db.execute<{ batch_key: string | null }>(
    sql`select batch_key from incident_checklist_ticks where clinic_id = ${tx.clinicId} and incident_id = ${incidentId} and step = 'open'`,
  );
  // "<source>:<value>:<reach>:<from ISO>:<to ISO>:<class>" (lib/incidents/assistant/scope.ts batchKey).
  const match = /^(vendor|channel):[a-z_]+:[a-z_]+:(\d{4}-\d{2}-\d{2})T/.exec(result.rows[0]?.batch_key ?? "");
  return match ? { source: match[1] as ScopeSource, fromDay: match[2]! } : null;
}

export async function prefillFor(tx: TenantTx, row: IncidentRow): Promise<ReportFields> {
  return prefillReport({
    incidentClass: row.class as BatchClass,
    discoveredOn: isoDay(row.discoveredAt),
    batch: await batchOf(tx, row.id),
  });
}

/** The proposal of an incident's next report, pre-filled, due at its agreement deadline; null when it is not awaiting one. */
export async function reportProposal(
  tx: TenantTx,
  row: IncidentRow,
  options: { proposedBy?: string; actor?: EventActor; attempt?: number } = {},
): Promise<Proposal<"incident_report_send"> | null> {
  const report = row.reportsSent + 1;
  if (!awaitingReport(row, report)) return null;
  return {
    kind: "incident_report_send",
    subjectClinicId: tx.clinicId,
    subjectRef: reportSubject(row.id, report, options.attempt ?? 0),
    payload: { incidentId: row.id, report, fields: await prefillFor(tx, row) },
    dueAt: row.agreementNotifyBy ?? row.notifyBy,
    ...(options.proposedBy ? { proposedBy: options.proposedBy } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  };
}

// -----------------------------------------------------------------------------
// What the hourly proposer finds
// -----------------------------------------------------------------------------

export type IncidentFound = {
  proposals: Proposal[];
  /** "<incident id>:<report>" for every open incident's next report, at the clinics read. */
  awaiting: Set<string>;
  readClinics: Set<string>;
  /** Clinics destroyed, or healdesk's demo clinic: an item about one leaves the list as `clinic_out_of_service`. */
  goneClinics: Set<string>;
  /** Every clinic the overview lists; empty when it could not be read. */
  listed: Set<string>;
  unread: number;
};

/** "<incident id>:<report>" of every report item ever proposed, in any status. */
async function reportsEverProposed(): Promise<Set<string>> {
  const rows = await unsafeDb
    .select({ subjectRef: opsApprovals.subjectRef })
    .from(opsApprovals)
    .where(eq(opsApprovals.kind, "incident_report_send"));
  const seen = new Set<string>();
  for (const { subjectRef } of rows) {
    const s = parseReportSubject(subjectRef);
    if (s) seen.add(`${s.incidentId}:${s.report}`);
  }
  return seen;
}

/**
 * The first report of an open reportable incident gets one item, so the
 * agreement's clock is in the owner's list even when nobody pressed the
 * button, but only once, ever: never again after the owner rejected it, it
 * failed or it was overtaken (any item for that report, in any status, as
 * proposeIncidentReport reads them), and never for an incident whose
 * practice has already been told and the notice recorded (`notified_at`:
 * the owner phoned and recorded it). An operator can still propose one by
 * hand. Updates are proposed by an operator only. healdesk's demo clinic and
 * destroyed clinics are left out. Nothing here throws: a failure to read is
 * counted in `unread`, so the billing proposer that calls it carries on.
 */
export async function findIncidentSubjects(now: Date, ctx: Ctx): Promise<IncidentFound> {
  void now;
  const found: IncidentFound = {
    proposals: [],
    awaiting: new Set(),
    readClinics: new Set(),
    goneClinics: new Set(),
    listed: new Set(),
    unread: 0,
  };
  let proposedBefore: Set<string>;
  let clinics: ClinicOverview[];
  try {
    proposedBefore = await reportsEverProposed();
    clinics = await listClinics();
  } catch (error) {
    found.unread += 1;
    log.warn("approvals: the incidents could not be read", { error: describeError(error) });
    return found;
  }
  for (const clinic of clinics) found.listed.add(clinic.id);
  for (const clinic of clinics) {
    if (clinic.destroyedAt) {
      found.goneClinics.add(clinic.id);
      continue;
    }
    try {
      await withTenant({ clinicId: clinic.id, actor: ctx.actor }, async (tx) => {
        const demo = await tx.db.execute<{ demo: boolean }>(sql`select app_clinic_is_demo(${tx.clinicId}) as demo`);
        if (demo.rows[0]?.demo === true) {
          found.goneClinics.add(clinic.id);
          return;
        }
        const open = await tx.db
          .select()
          .from(incidents)
          .where(and(eq(incidents.clinicId, tx.clinicId), isNull(incidents.resolvedAt), isNull(incidents.notReportableAt)));
        for (const row of open) {
          if (!isReportableClass(row.class)) continue;
          found.awaiting.add(`${row.id}:${row.reportsSent + 1}`);
          if (row.reportsSent > 0 || row.notifiedAt !== null || proposedBefore.has(`${row.id}:1`)) continue;
          const proposal = await reportProposal(tx, row);
          if (proposal) found.proposals.push(proposal);
        }
        found.readClinics.add(clinic.id);
      });
    } catch (error) {
      found.unread += 1;
      log.warn("approvals: a clinic's incidents could not be read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return found;
}

/**
 * Why a waiting incident item leaves the list unrun, read this run, or null
 * while it is still owed: `clinic_out_of_service` when its clinic has been
 * destroyed or is healdesk's demo clinic; `no_longer_needed` for a report
 * whose incident has since been reported, recorded not reportable or
 * resolved by the Incidents page's own buttons. A batch waits until the
 * owner decides it.
 */
export function incidentItemResolution(item: OpsApproval, found: IncidentFound): "no_longer_needed" | "clinic_out_of_service" | null {
  if (item.kind !== "incident_report_send" || item.subjectClinicId === null) return null;
  if (found.goneClinics.has(item.subjectClinicId)) return "clinic_out_of_service";
  if (found.listed.size > 0 && !found.listed.has(item.subjectClinicId)) return "clinic_out_of_service";
  const subject = parseReportSubject(item.subjectRef);
  if (!subject || !found.readClinics.has(item.subjectClinicId)) return null;
  return found.awaiting.has(`${subject.incidentId}:${subject.report}`) ? null : "no_longer_needed";
}

// -----------------------------------------------------------------------------
// The owner's edit of a report: choices from the lists, checked before the decision
// -----------------------------------------------------------------------------

export type FieldDecision =
  | { ok: true; fields: ReportFields; hashApproved: string; edited: boolean }
  | { ok: false; message: string };

export type FieldEditor = (item: OpsApproval, editedFields: unknown, now: Date, ctx: Ctx) => Promise<FieldDecision>;

/**
 * The report as it will go: the pre-fill, or the owner's choices, read only
 * from the lists (parseReportFields), then held to the sender's own rules
 * for this incident (readIncidentReportFields: what happened is picked, the
 * dates are real and not after the discovery, the breach-only choices go
 * only in a breach's report), so a choice that would make Send report refuse
 * is refused now, before anything is recorded as approved.
 */
const reportEditor: FieldEditor = async (item, editedFields, now, ctx) => {
  const payload = parsePayload("incident_report_send", item.payload);
  if (!payload || !item.subjectClinicId) return { ok: false, message: "This item's details could not be read, so nothing was run." };
  let fields = payload.fields;
  if (editedFields !== undefined && editedFields !== null) {
    const edit = parseReportFields(editedFields);
    if (!edit) {
      return { ok: false, message: "The report's choices could not be read: each one must come from its list. Nothing was changed." };
    }
    fields = edit;
  }
  const incident = await withTenant({ clinicId: item.subjectClinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const [row] = await tx.db
      .select({ class: incidents.class, discoveredAt: incidents.discoveredAt })
      .from(incidents)
      .where(and(eq(incidents.id, payload.incidentId), eq(incidents.clinicId, tx.clinicId)))
      .limit(1);
    return row ?? null;
  });
  if (!incident || !isReportableClass(incident.class)) {
    return { ok: false, message: "This incident is not one an agreement reports, so nothing was run." };
  }
  const checked = readIncidentReportFields(
    senderInput(fields) as Parameters<typeof readIncidentReportFields>[0],
    isoDay(incident.discoveredAt),
    incident.class,
    isoDay(now),
  );
  if ("status" in checked) return { ok: false, message: `${checked.message} Nothing was changed.` };
  const hashApproved = fieldsHash(fields);
  return { ok: true, fields, hashApproved, edited: hashApproved !== fieldsHash(payload.fields) };
};

export const FIELD_EDITORS: Readonly<Partial<Record<ApprovalKind, FieldEditor>>> = {
  incident_report_send: reportEditor,
};

// -----------------------------------------------------------------------------
// Executors
// -----------------------------------------------------------------------------

const MALFORMED: ExecutionResult = {
  ok: false,
  outcomeCode: "malformed_item",
  message: "This item's details could not be read, so nothing was run.",
  auditRecorded: null,
};

const NO_LONGER_NEEDED: ExecutionResult = {
  ok: false,
  outcomeCode: "no_longer_needed",
  message: "This has already been dealt with since it was proposed, so nothing was run.",
  auditRecorded: null,
};

function answerOf(outcome: OpsOutcome): Record<string, unknown> | { problem: string } {
  if (outcome.status !== 200 || !("data" in outcome.body)) {
    return { problem: "error" in outcome.body ? outcome.body.error : "The operation did not answer." };
  }
  const data = outcome.body.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

function keyOf(payload: IncidentBatchPayload): string {
  return batchKey({
    source: payload.source,
    value: payload.value,
    reach: payload.reach,
    from: new Date(payload.from),
    to: new Date(payload.to),
    incidentClass: payload.incidentClass,
  });
}

/** The summary an opened incident carries: ids and codes only, no date (the PHI guard reads one as a number). */
function batchSummary(payload: IncidentBatchPayload, approvalId: string): string {
  return `Opened by the incident assistant from an approved ${payload.source} scope (${payload.value}), approval ${approvalId}. The scope's window is on the incident's checklist.`;
}

const openBatch: Executor = async (approval, operator) => {
  const payload = parsePayload("incident_open_batch", approval.payload);
  if (!payload) return MALFORMED;
  const key = keyOf(payload);
  const discoveredAt = new Date(payload.discoveredAt);
  const overviews = new Map((await listClinics()).map((c) => [c.id, c]));
  let opened = 0;
  let already = 0;
  let gone = 0;
  let failed = 0;
  let audited = true;
  for (const clinicId of payload.clinicIds) {
    const clinic = overviews.get(clinicId);
    if (!clinic || clinic.destroyedAt) {
      gone += 1;
      continue;
    }
    let result: { opened: IncidentRow | null; proposal?: Proposal<"incident_report_send"> | null };
    try {
      result = await withTenant(
        { clinicId, actor: actorFor(operator), request: operator.request },
        async (tx) => {
          // One opening per clinic per scope, even under two racing requests.
          await tx.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`incident_batch|${clinicId}|${key}`}, 0))`);
          if (await incidentOpenedBy(tx, key)) return { opened: null };
          const row = await openIncident(tx, {
            class: payload.incidentClass,
            summary: batchSummary(payload, approval.id),
            discoveredAt,
            openedBy: operator.email,
            isCoveredEntity: clinic.isCoveredEntity,
          });
          const tick = await tickStep(tx, { incidentId: row.id, step: "open", tickedBy: operator.email, batchKey: key });
          if (tick.status !== "ticked") throw new Error("the batch's open tick was not recorded");
          const proposal = await reportProposal(tx, row, { proposedBy: ASSISTANT, actor: { label: operator.email } });
          return { opened: row, proposal };
        },
      );
    } catch (error) {
      failed += 1;
      log.error("incident batch: a clinic's incident was not opened", { clinicId, error: describeError(error) });
      continue;
    }
    if (!result.opened) {
      already += 1;
      continue;
    }
    // Committed: the incident is open, whatever happens to its audit row or its report's proposal.
    opened += 1;
    audited =
      (await audit(operator, "incident_opened", {
        clinicSlug: clinic.slug,
        class: payload.incidentClass,
        incidentId: result.opened.id,
        approvalId: approval.id,
      })) && audited;
    try {
      if (result.proposal) await propose(result.proposal, new Date());
    } catch (error) {
      // The hourly sweep proposes its first report (./incident-sweep.ts).
      log.error("incident batch: an opened incident's report was not proposed", { clinicId, error: describeError(error) });
    }
  }
  const parts = [
    `Opened ${opened} incident${opened === 1 ? "" : "s"}; each one's report is now waiting in this list for your yes.`,
    already ? `${already} clinic${already === 1 ? " already had" : "s already had"} this scope's incident open and ${already === 1 ? "was" : "were"} left as ${already === 1 ? "it was" : "they were"}.` : "",
    gone ? `${gone} clinic${gone === 1 ? " is" : "s are"} no longer in service and ${gone === 1 ? "was" : "were"} skipped.` : "",
    failed ? `${failed} could not be opened: propose this scope again to open ${failed === 1 ? "it" : "them"}; the ones opened are not opened twice.` : "",
  ].filter(Boolean);
  return {
    ok: failed === 0,
    outcomeCode: failed === 0 ? "opened" : "partly_opened",
    message: parts.join(" "),
    auditRecorded: audited,
  };
};

const sendReport: Executor = async (approval, operator, context: ExecutionContext) => {
  const payload = parsePayload("incident_report_send", approval.payload);
  if (!payload || !approval.subjectClinicId) return MALFORMED;
  // The fields the owner approved, as checked before the decision; the pre-fill when he chose nothing else.
  const fields = context.fields ?? payload.fields;
  const clinicId = approval.subjectClinicId;
  const still = await withTenant({ clinicId, actor: actorFor(operator), request: operator.request }, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, payload.incidentId), eq(incidents.clinicId, tx.clinicId)))
      .limit(1);
    return row ? awaitingReport(row, payload.report) : false;
  });
  if (!still) return NO_LONGER_NEEDED;
  const answer = answerOf(
    // The report's number goes too: the sender refuses, under its row lock,
    // when another item for the same incident sent first, rather than send
    // this one as an update nobody approved.
    await opSendIncidentReport(
      { clinicId, incidentId: payload.incidentId, ...senderInput(fields), expectedReport: payload.report },
      operator,
    ),
  );
  if ("problem" in answer) return { ok: false, outcomeCode: "operation_refused", message: String(answer.problem), auditRecorded: null };
  if (answer.status !== "sent") {
    return {
      ok: false,
      outcomeCode: "refused",
      message: typeof answer.message === "string" ? answer.message : "Send report refused and did not say why.",
      auditRecorded: null,
    };
  }
  return {
    ok: true,
    outcomeCode: "sent",
    message: "Sent. Phone the practice as well, and tick Notify by phone on the incident's checklist once you have.",
    auditRecorded: answer.auditRecorded === true,
    draftHashSent: fieldsHash(fields),
  };
};

export const INCIDENT_EXECUTORS: Readonly<Record<"incident_open_batch" | "incident_report_send", Executor>> = {
  incident_open_batch: openBatch,
  incident_report_send: sendReport,
};

// -----------------------------------------------------------------------------
// Packets
// -----------------------------------------------------------------------------

export type BatchClinicFacts = {
  clinicId: string;
  clinicName: string;
  /** Its conversations in the window when the scope was proposed (never recounted here). */
  conversations: number;
  agreementVersion: string | null;
  clocks: ScopeClocks;
  /** This scope's incident is already open at the clinic. */
  opened: boolean;
  inService: boolean;
};

/** The most clinics a batch's packet lists one by one; the counts cover them all. */
export const BATCH_CLINICS_SHOWN = 20;

export type IncidentBatchFacts = {
  kind: "incident_open_batch";
  source: ScopeSource;
  value: string;
  reach: ScopeReach;
  from: string;
  to: string;
  incidentClass: BatchClass;
  discoveredAt: string;
  /** Every clinic the item lists, and of them: still to open, already open, out of service. */
  clinicsTotal: number;
  toOpen: number;
  alreadyOpen: number;
  outOfService: number;
  /** The first BATCH_CLINICS_SHOWN, soonest agreement deadline first. */
  clinics: BatchClinicFacts[];
};

export type IncidentReportFacts = {
  kind: "incident_report_send";
  incidentId: string;
  incidentClass: BatchClass;
  report: number;
  discoveredAt: string;
  /** Our own target: internal, never quoted to the practice, and never in the report. */
  internalTarget: string;
  /** What the practice's agreement promises: the item is due at this. */
  agreementDeadline: string | null;
  agreementVersion: string | null;
  /** For a breach at a clinic that is not a covered entity: the practice's own 30-day clock to tell the people affected. */
  ownerNoticeBy: string | null;
  /** How many people the incident's list names, never who. */
  affectedRecorded: number;
  /** The checklist's steps ticked so far. */
  ticked: string[];
  /** The report as it will go unless the owner chooses otherwise: codes from the catalog's lists only. */
  fields: ReportFields;
};

const CLASS_WORDS: Readonly<Record<BatchClass, string>> = {
  breach: "a breach",
  security_incident: "a security incident",
  improper_use_or_disclosure: "an improper use or disclosure",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayWords(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function batchEffect(facts: Pick<IncidentBatchFacts, "incidentClass" | "toOpen" | "alreadyOpen" | "reach">): string {
  const { toOpen, alreadyOpen: open } = facts;
  const words = CLASS_WORDS[facts.incidentClass];
  return (
    `Opens an incident at ${toOpen === 1 ? "the 1 clinic" : `each of the ${toOpen} clinics`} below, classed as ${words}, and puts each one's report in this list for your yes. Nothing is sent to any clinic.` +
    (facts.reach === "all_holding"
      ? " Every clinic holding data is listed, whether or not it had a conversation in the window."
      : "") +
    (open ? ` ${open === 1 ? "1 clinic already has" : `${open} clinics already have`} this incident open and ${open === 1 ? "is" : "are"} left as ${open === 1 ? "it is" : "they are"}.` : "")
  );
}

export function reportEffect(facts: Pick<IncidentReportFacts, "report" | "incidentClass" | "agreementDeadline" | "fields">): string {
  const what = facts.report === 1 ? "this incident's report" : `update ${facts.report - 1} to this incident's report`;
  return [
    `Emails the practice's address ${what}, built only from the choices below, and records the practice as told. It cannot be taken back.`,
    facts.incidentClass === "breach"
      ? "It links to the incident's page, where the practice reads who it affected; that list is never emailed."
      : "",
    facts.fields.event === null ? "Pick what happened before you approve: the report cannot go without it." : "",
    facts.agreementDeadline ? `The practice's agreement deadline for this notice is ${dayWords(facts.agreementDeadline)}.` : "",
    "Phone the practice as well: the report does not replace the call.",
  ]
    .filter(Boolean)
    .join(" ");
}

export type IncidentPacket = {
  operation: string;
  irreversible: boolean;
  stillNeeded: boolean;
  effect: string;
  facts: IncidentBatchFacts | IncidentReportFacts;
};

async function batchPacket(approval: OpsApproval, ctx: Ctx): Promise<IncidentPacket | null> {
  const payload = parsePayload("incident_open_batch", approval.payload);
  if (!payload) return null;
  // Cheap by construction: the counts are the proposal's, never recounted;
  // the clinics' names and versions come from one overview read; and each
  // clinic costs one indexed lookup of its open tick. At most
  // MAX_BATCH_CLINICS clinics, of which BATCH_CLINICS_SHOWN are listed.
  const discoveredAt = new Date(payload.discoveredAt);
  const key = keyOf(payload);
  const overviews = new Map<string, ClinicOverview>((await listClinics()).map((c) => [c.id, c]));
  const all: BatchClinicFacts[] = [];
  for (const [i, clinicId] of payload.clinicIds.entries()) {
    const clinic = overviews.get(clinicId);
    if (!clinic || clinic.destroyedAt) {
      all.push({
        clinicId,
        clinicName: clinic?.name ?? "",
        conversations: payload.counts[i] ?? 0,
        agreementVersion: null,
        clocks: clocksFor(payload.incidentClass, discoveredAt, null, null),
        opened: false,
        inService: false,
      });
      continue;
    }
    const opened = await withTenant({ clinicId, actor: ctx.actor, request: ctx.request }, (tx) => incidentOpenedBy(tx, key));
    all.push({
      clinicId,
      clinicName: clinic.name,
      conversations: payload.counts[i] ?? 0,
      agreementVersion: clinic.baaVersion,
      clocks: clocksFor(payload.incidentClass, discoveredAt, clinic.baaVersion, clinic.isCoveredEntity),
      opened: opened !== null,
      inService: true,
    });
  }
  const toOpen = all.filter((c) => c.inService && !c.opened).length;
  const facts: IncidentBatchFacts = {
    kind: "incident_open_batch",
    source: payload.source,
    value: payload.value,
    reach: payload.reach,
    from: payload.from,
    to: payload.to,
    incidentClass: payload.incidentClass,
    discoveredAt: payload.discoveredAt,
    clinicsTotal: all.length,
    toOpen,
    alreadyOpen: all.filter((c) => c.opened).length,
    outOfService: all.filter((c) => !c.inService).length,
    clinics: [...all]
      .sort((a, b) => (a.clocks.agreementDeadline ?? "").localeCompare(b.clocks.agreementDeadline ?? ""))
      .slice(0, BATCH_CLINICS_SHOWN),
  };
  return {
    operation: KIND_SPECS.incident_open_batch.operation,
    irreversible: KIND_SPECS.incident_open_batch.irreversible,
    stillNeeded: toOpen > 0,
    effect: batchEffect(facts),
    facts,
  };
}

async function reportPacket(approval: OpsApproval, ctx: Ctx): Promise<IncidentPacket | null> {
  const payload: IncidentReportPayload | null = parsePayload("incident_report_send", approval.payload);
  if (!payload || !approval.subjectClinicId) return null;
  return withTenant({ clinicId: approval.subjectClinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, payload.incidentId), eq(incidents.clinicId, tx.clinicId)))
      .limit(1);
    if (!row || !isReportableClass(row.class)) return null;
    const checklist = (await checklistOf(tx, row.id)) ?? [];
    const facts: IncidentReportFacts = {
      kind: "incident_report_send",
      incidentId: row.id,
      incidentClass: row.class,
      report: payload.report,
      discoveredAt: row.discoveredAt.toISOString(),
      internalTarget: row.notifyBy.toISOString(),
      agreementDeadline: row.agreementNotifyBy?.toISOString() ?? null,
      agreementVersion: row.agreementVersion,
      ownerNoticeBy: row.ftcNotifyBy?.toISOString() ?? null,
      affectedRecorded: row.affectedRecorded,
      ticked: checklist.filter((c) => c.tickedAt !== null).map((c) => c.step),
      fields: payload.fields,
    };
    return {
      operation: KIND_SPECS.incident_report_send.operation,
      irreversible: KIND_SPECS.incident_report_send.irreversible,
      stillNeeded: awaitingReport(row, payload.report),
      effect: reportEffect(facts),
      facts,
    };
  });
}

export async function incidentPacketFor(approval: OpsApproval, ctx: Ctx): Promise<IncidentPacket | null> {
  if (approval.kind === "incident_open_batch") return batchPacket(approval, ctx);
  if (approval.kind === "incident_report_send") return reportPacket(approval, ctx);
  return null;
}
