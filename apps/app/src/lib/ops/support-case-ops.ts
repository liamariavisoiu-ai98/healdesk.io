import { describeError, log } from "@/lib/log";
import { readCaseFacts, type CaseFacts } from "@/lib/support/case-facts";
import { SUPPORT_CASE_STATES, SUPPORT_CLOSED_REASONS, type SupportClosedReason } from "@/lib/support/case-vocab";
import {
  assignSupportCase,
  closeSupportCase,
  listSupportCases,
  matchSupportCase,
  readSupportCase,
  snoozeSupportCase,
  SUPPORT_CASES_LIST_MAX,
  type CaseMoveOutcome,
  type MatchOutcome,
  type SupportCaseFilter,
} from "@/lib/support/cases";
import { opsPeople } from "@/lib/support/people";

import { actorFor, audit, clinicById, ok, opsProblem, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";
import { supportDraftFor } from "./support-draft-ops";

/**
 * The support cases' ops operations (ops automation Phase 7, lane P7a;
 * design E5 §2.4), kept beside the ops API's dispatch rather than in it.
 * None of them sends mail or calls a model: the drafter is lane P7b's, and
 * Send is lane P7c's.
 *
 *   - `listSupportCases {state?, limit?, includeDemo?}`, a read across
 *     clinics: each case's ref, clinic, source, topic, symptom, urgency,
 *     state, age, reply-by day and flags. Never a word of text.
 *   - `getSupportCase {caseId}`: the case, what passed on it (kinds, times
 *     and a chat escalation's fields; never text), and its facts panel
 *     (lib/support/case-facts.ts). `draft` is null until lane P7b writes one.
 *   - `snoozeSupportCase {caseId, until}`, `assignSupportCase {caseId,
 *     label}` (a name from HEALDESK_OPS_PEOPLE), `matchSupportCase {caseId,
 *     clinicId}` (an unmatched case only) and `closeSupportCase {caseId,
 *     reason}`: MUTATING, each with a security event naming the operator,
 *     with ids, closed words and counts only.
 */

const UNKNOWN = (args: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(args).filter((key) => !allowed.includes(key));

const FILTERS: readonly SupportCaseFilter[] = [...SUPPORT_CASE_STATES, "open", "needs_us", "all"];
const DEFAULT_LIMIT = 100;
/** How far ahead a case may be snoozed. */
export const SNOOZE_MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function caseIdOf(args: Record<string, unknown>): string | null {
  const raw = typeof args.caseId === "string" ? args.caseId.trim().toLowerCase() : "";
  return UUID_SHAPED.test(raw) ? raw : null;
}

export async function opListSupportCases(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["state", "limit", "includeDemo"]);
  if (unknown.length > 0) {
    return opsProblem("listSupportCases takes only state, limit and includeDemo.", 400, "invalid_args");
  }
  const filter = args.state ?? "open";
  if (!(FILTERS as readonly unknown[]).includes(filter)) {
    return opsProblem(`The state is one of ${FILTERS.join(", ")}.`, 400, "invalid_args");
  }
  const limit = args.limit ?? DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SUPPORT_CASES_LIST_MAX) {
    return opsProblem(`The limit is a whole number from 1 to ${SUPPORT_CASES_LIST_MAX}.`, 400, "invalid_args");
  }
  if (args.includeDemo !== undefined && typeof args.includeDemo !== "boolean") {
    return opsProblem("includeDemo is a boolean.", 400, "invalid_args");
  }
  try {
    return ok(
      await listSupportCases({
        filter: filter as SupportCaseFilter,
        limit,
        includeDemo: args.includeDemo === true,
        actor: actorFor(operator),
        now,
      }),
    );
  } catch (error) {
    log.error("support cases not listed", { error: describeError(error) });
    return opsProblem("The support cases could not be read.", 500, "failed");
  }
}

export async function opGetSupportCase(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["caseId"]);
  if (unknown.length > 0) return opsProblem("getSupportCase takes only caseId.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  try {
    const read = await readSupportCase(caseId, now);
    if (!read) return opsProblem("No such support case.", 404, "invalid_args");
    const facts: CaseFacts | null = read.row.clinicId
      ? await readCaseFacts({ clinicId: read.row.clinicId, actor: actorFor(operator), request: operator.request, now })
      : null;
    const draft = await supportDraftFor(caseId);
    return ok({ case: read.row, messages: read.messages, facts, draft, people: [...opsPeople()] });
  } catch (error) {
    log.error("support case not read", { error: describeError(error) });
    return opsProblem("The support case could not be read.", 500, "failed");
  }
}

/** A move's outcome as the console reads it, or the refusal in words. */
async function answer(
  operator: Operator,
  event: string,
  outcome: CaseMoveOutcome | MatchOutcome,
  metadata: Record<string, unknown>,
): Promise<OpsOutcome> {
  switch (outcome.outcome) {
    case "not_found":
      return opsProblem("No such support case.", 404, "invalid_args");
    case "closed":
      return opsProblem(`${outcome.ref} is closed. A clinic that writes again opens a new case.`, 409, "invalid_args");
    case "not_allowed":
      return opsProblem(`${outcome.ref} cannot do that while it is ${outcome.state.replace(/_/g, " ")}.`, 409, "invalid_args");
    case "already_matched":
      return opsProblem(`${outcome.ref} already names its clinic.`, 409, "invalid_args");
    case "clinic_gone":
      return opsProblem("That clinic has left; its support cases went with its data.", 409, "invalid_args");
    case "unchanged":
      return ok({ outcome: "unchanged", ref: outcome.ref, state: outcome.state, auditRecorded: true });
    case "done": {
      const auditRecorded = await audit(operator, event, {
        ref: outcome.ref,
        clinicId: outcome.clinicId,
        from: outcome.from,
        to: outcome.to,
        ...metadata,
      });
      return ok({ outcome: "done", ref: outcome.ref, state: outcome.to, auditRecorded });
    }
  }
}

export async function opSnoozeSupportCase(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["caseId", "until"]);
  if (unknown.length > 0) return opsProblem("snoozeSupportCase takes only caseId and until.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  const until = typeof args.until === "string" && /^\d{4}-\d{2}-\d{2}T/.test(args.until) ? new Date(args.until) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return opsProblem("Snooze until an ISO date and time.", 400, "invalid_args");
  }
  if (until.getTime() <= now.getTime() || until.getTime() > now.getTime() + SNOOZE_MAX_DAYS * DAY_MS) {
    return opsProblem(`Snooze to a time in the next ${SNOOZE_MAX_DAYS} days.`, 400, "invalid_args");
  }
  try {
    const outcome = await snoozeSupportCase(caseId, until, now);
    // Whole days ahead, not the time: the security log refuses digit runs.
    const days = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
    return await answer(operator, "support_case_snoozed", outcome, { days });
  } catch (error) {
    log.error("support case not snoozed", { error: describeError(error) });
    return opsProblem("The case could not be snoozed.", 500, "failed");
  }
}

export async function opAssignSupportCase(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["caseId", "label"]);
  if (unknown.length > 0) return opsProblem("assignSupportCase takes only caseId and label.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  const people = opsPeople();
  if (typeof args.label !== "string" || !people.includes(args.label)) {
    return opsProblem(`Give the case to one of: ${people.join(", ")}.`, 400, "invalid_args");
  }
  try {
    const outcome = await assignSupportCase(caseId, args.label, now);
    return await answer(operator, "support_case_assigned", outcome, { label: args.label });
  } catch (error) {
    log.error("support case not assigned", { error: describeError(error) });
    return opsProblem("The case could not be reassigned.", 500, "failed");
  }
}

export async function opMatchSupportCase(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["caseId", "clinicId"]);
  if (unknown.length > 0) return opsProblem("matchSupportCase takes only caseId and clinicId.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  const rawClinic = typeof args.clinicId === "string" ? args.clinicId.trim().toLowerCase() : "";
  if (!UUID_SHAPED.test(rawClinic)) return opsProblem("A clinic id must be a uuid.", 400, "invalid_args");
  const clinic = await clinicById(rawClinic);
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  try {
    const outcome = await matchSupportCase(caseId, clinic.id, actorFor(operator), now);
    return await answer(operator, "support_case_matched", outcome, {});
  } catch (error) {
    log.error("support case not matched", { clinicId: clinic.id, error: describeError(error) });
    return opsProblem("The case could not be matched.", 500, "failed");
  }
}

export async function opCloseSupportCase(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = UNKNOWN(args, ["caseId", "reason"]);
  if (unknown.length > 0) return opsProblem("closeSupportCase takes only caseId and reason.", 400, "invalid_args");
  const caseId = caseIdOf(args);
  if (!caseId) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  if (!(SUPPORT_CLOSED_REASONS as readonly unknown[]).includes(args.reason)) {
    return opsProblem(`The reason is one of ${SUPPORT_CLOSED_REASONS.join(", ")}.`, 400, "invalid_args");
  }
  const reason = args.reason as SupportClosedReason;
  try {
    const outcome = await closeSupportCase(caseId, reason, now);
    return await answer(operator, "support_case_closed", outcome, { reason });
  } catch (error) {
    log.error("support case not closed", { error: describeError(error) });
    return opsProblem("The case could not be closed.", 500, "failed");
  }
}
