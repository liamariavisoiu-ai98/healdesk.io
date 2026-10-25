import type {
  BatchClass,
  ChecklistStep,
  IncidentApprovalItem,
  IncidentBatchFacts,
  IncidentReportFacts,
  ScopeChannel,
  ScopeClocksView,
  ScopeReach,
  ScopeVendor,
} from "@/lib/admin/ops-client";

import { onDay, whenWords } from "./approval-words";

/**
 * The plain words the console puts on the incident assistant's codes (ops
 * automation Phase 6, lane P6i; drawn by lane P6j on Queues › Approvals and
 * on Compliance › Incidents › Incident assistant). Every value here is a
 * closed code of apps/app's, read in its source by `incident-words.test.ts`:
 * the vendors, channels, reaches, classes and checklist steps
 * (lib/incidents/assistant/vocab.ts) and the two reporting rules
 * (lib/incidents/reporting-rules.ts). Types only from ops-client, so a
 * client component may import this (lib/admin/client-imports.test.ts).
 *
 * Two clocks, never confused: the agreement's deadline is the practice's
 * promise; our own target, 24 hours from discovery, is internal and never
 * shown to a clinic (owner, 12 October 2026), so its label says so wherever
 * it is printed.
 */

/** A vendor as apps/app's alerts name it (lib/ops/alert-wording/words.ts VENDOR_WORDS), plus Meta, which signs no agreement. */
export const VENDOR_WORDS: Record<ScopeVendor, string> = {
  retell: "Retell (the voice provider)",
  anthropic: "Anthropic (the AI model provider)",
  database_host: "the database host",
  aws: "AWS (our host)",
  meta: "Meta (Instagram, Messenger, WhatsApp)",
};

export const SCOPE_CHANNEL_WORDS: Record<ScopeChannel, string> = {
  voice: "phone",
  web: "website chat",
  meta: "Meta (Instagram, Messenger, WhatsApp)",
};

/**
 * Which clinics a scope reaches (vocab.ts SCOPE_REACHES): the database host
 * and AWS hold everything the service stores, so their default is every
 * clinic holding data; every other scope is the window.
 */
export const REACH_WORDS: Record<ScopeReach, string> = {
  all_holding: "every clinic holding data",
  window_only: "only clinics reached in the window",
};

/** The three classes an agreement's reporting clause covers, as the Incidents page words them. */
export const BATCH_CLASS_WORDS: Record<BatchClass, string> = {
  breach: "Breach of unsecured PHI",
  security_incident: "Security incident",
  improper_use_or_disclosure: "Use or disclosure the agreement does not permit",
};

/**
 * The procedure's nine steps (docs/incident-response.md, "The procedure";
 * vocab.ts CHECKLIST_STEPS), each a thing a person does. A tick records that
 * it was done (lib/incidents/assistant/checklist.ts); it never does it.
 */
export const CHECKLIST_STEP_WORDS: Record<ChecklistStep, string> = {
  contain: "Contain it: stop the exposure continuing",
  open: "Open the incident, which starts both clocks",
  preserve_ids: "Preserve the ids involved: nothing deleted, the ids noted in the incident",
  investigate: "Investigate from the audit log",
  notify_email: "Notify the practice by email: its report",
  notify_phone: "Notify the practice by phone",
  affected_list_recorded: "Record the list of who it affected, by contact id, on the host",
  help_clinic: "Help the practice notify the people affected",
  resolve: "Resolve the incident",
};

/** Two steps are facts the incident row already holds, so a tick is refused until it does (checklist.ts tickStep). */
export const STEP_NEEDS: Partial<Record<ChecklistStep, string>> = {
  notify_email: "ticked only once a report has gone or a notice is recorded",
  resolve: "ticked only once the incident is resolved on the clinic's Care tab",
};

/** What each agreement promises about the notice (lib/incidents/reporting-rules.ts). */
export const RULE_WORDS: Record<ScopeClocksView["agreementRule"], string> = {
  sixty_calendar_days: "no later than 60 calendar days after discovery",
  five_days: "five calendar days for a breach, five business days otherwise (BAA 1.2.1 and before, or no agreement on file)",
};

/** The one label our own target ever carries: it is never a promise to a clinic. */
export const INTERNAL_TARGET_LABEL = "Our own target (never shown to the clinic)";

export const AGREEMENT_DEADLINE_LABEL = "Agreement deadline";

/** What the Tick control does and does not do: the one sentence over a checklist. */
export const TICK_WORDS = "Ticking records that you did a step, by you and when. It does not do the step.";

export const TICK_CONFIRM = "Record this step as done by you, now? It cannot be unticked.";

/** What the two propose controls do: nothing until the owner's yes under Approvals. */
export const PROPOSE_BATCH_WORDS = "Nothing is opened until you approve it in Approvals.";
export const PROPOSE_REPORT_WORDS = "Nothing is sent until you approve it in Approvals.";

/** The scope's source and window in one line: "Retell (the voice provider), phone conversations from … to …". */
export function scopeWords(facts: Pick<IncidentBatchFacts, "source" | "value" | "from" | "to">): string {
  const what =
    facts.source === "vendor"
      ? `${VENDOR_WORDS[facts.value as ScopeVendor]}'s incident`
      : `an incident on our ${SCOPE_CHANNEL_WORDS[facts.value as ScopeChannel]} channel`;
  return `${what}, window ${whenWords(facts.from)} to ${whenWords(facts.to)}`;
}

/** The report's number in words: the first is the report, the rest are updates. */
export function reportWords(report: number): string {
  return report === 1 ? "the report" : `update ${report - 1}`;
}

/** The two clocks as label and value pairs, the internal one always labelled as never shown. */
export function clockLines(clocks: ScopeClocksView, agreementVersion: string | null): [string, string][] {
  return [
    [
      AGREEMENT_DEADLINE_LABEL,
      clocks.agreementDeadline
        ? `${onDay(clocks.agreementDeadline)} (${agreementVersion ? `agreement ${agreementVersion}` : "no agreement on file: the strictest rule"}: ${RULE_WORDS[clocks.agreementRule]})`
        : "none",
    ],
    [INTERNAL_TARGET_LABEL, whenWords(clocks.internalTarget)],
    ...(clocks.ownerNoticeBy ? [["The practice tells the people affected by", onDay(clocks.ownerNoticeBy)] as [string, string]] : []),
  ];
}

/** The counts over a batch's clinics in one line. */
export function batchCountWords(facts: Pick<IncidentBatchFacts, "clinicsTotal" | "toOpen" | "alreadyOpen" | "outOfService">): string {
  const parts = [`${facts.toOpen} to open`];
  if (facts.alreadyOpen) parts.push(`${facts.alreadyOpen} already open`);
  if (facts.outOfService) parts.push(`${facts.outOfService} out of service`);
  return `${facts.clinicsTotal} ${facts.clinicsTotal === 1 ? "clinic" : "clinics"} listed: ${parts.join(", ")}`;
}

/** When the packet lists fewer clinics than it counts (incident-kinds.ts BATCH_CLINICS_SHOWN). */
export function shownWords(facts: Pick<IncidentBatchFacts, "clinicsTotal" | "clinics">): string | null {
  if (facts.clinics.length >= facts.clinicsTotal) return null;
  return `The first ${facts.clinics.length} of ${facts.clinicsTotal}, soonest agreement deadline first; the counts cover all ${facts.clinicsTotal}.`;
}

/** A batch clinic's state in one word or two. */
export function batchClinicState(clinic: IncidentBatchFacts["clinics"][number]): string {
  if (!clinic.inService) return "out of service: skipped";
  return clinic.opened ? "already open: left as it is" : "to open";
}

/** The report item's facts as label and value pairs, both clocks included. */
export function reportFactLines(facts: IncidentReportFacts): [string, string][] {
  const lines: [string, string][] = [
    ["Report", `${reportWords(facts.report)}, for ${BATCH_CLASS_WORDS[facts.incidentClass].toLowerCase()}`],
    ["Discovered", whenWords(facts.discoveredAt)],
    [
      AGREEMENT_DEADLINE_LABEL,
      facts.agreementDeadline
        ? `${onDay(facts.agreementDeadline)}${facts.agreementVersion ? ` (agreement ${facts.agreementVersion})` : " (no agreement on file: the strictest rule)"}`
        : "none",
    ],
    [INTERNAL_TARGET_LABEL, whenWords(facts.internalTarget)],
  ];
  if (facts.ownerNoticeBy) lines.push(["The practice tells the people affected by", onDay(facts.ownerNoticeBy)]);
  lines.push(["People recorded as affected", String(facts.affectedRecorded)]);
  lines.push(["Checklist steps ticked", facts.ticked.length === 0 ? "none yet" : facts.ticked.map((s) => CHECKLIST_STEP_WORDS[s]).join("; ")]);
  return lines;
}

/** The sentence under a report whose "what happened" is not picked: apps/app refuses to send without it. */
export const PICK_EVENT_WORDS = "Pick what happened before you approve: the report cannot go without it.";

/** Whether a report item can be approved as its choices stand. */
export function reportReady(facts: Pick<IncidentReportFacts, "fields">, event: string | null = facts.fields.event): boolean {
  return event !== null;
}

/** The incident's class behind an approval item, for the choices a breach alone may carry. */
export function classOf(item: IncidentApprovalItem): BatchClass | null {
  return item.packet?.facts.incidentClass ?? null;
}
