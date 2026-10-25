import type Anthropic from "@anthropic-ai/sdk";
import { audienceFor, CARRIER_SERVICE_NUMBERS, type AgreementKind, type Audience } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { publicOrigin } from "@/lib/public-url";
import { helpContacts } from "@/lib/setup/help";

import { readAccountState } from "../account-reader";
import { screenAllowFor } from "../chat";
import { SYMPTOM_IDS, TOPIC_IDS } from "../escalation-fields";
import { SUPPORT_MODEL } from "../model";
import { readForwardingSteps } from "../forwarding";
import { screenText, type ScreenAllow } from "../screen";
import { SUPPORT_CASE_URGENCIES } from "../case-vocab";
import { failedCheckIds, runReplyChecks, type FactsUsed, type ToolResult } from "./checks";
import { buildDraftPrompt, draftRequestText } from "./prompt";
import {
  claimCaseToDraft,
  DRAFTS_PER_CASE,
  recordDraft,
  type ClaimedCase,
  type DraftFailure,
} from "./store";
import {
  CONFIDENCE_LEVELS,
  DRAFT_TOOLS,
  draftToolbox,
  forwardingText,
  HANDOFF_REASONS,
  PROPOSAL_LIMITS,
  PROPOSE_REPLY,
  READ_TOOL_NAMES,
  type Confidence,
  type DraftToolbox,
  type HandoffReason,
  type ReadToolName,
} from "./tools";

/**
 * One drafting run (design E5 §2.3 and §6; lane P7b): a claimed case, the
 * model on healdesk's key with the drafter's read-only tools for the case's
 * clinic, one proposal, the eight checks, and the draft written on the case.
 *
 * The turn is the case's FIELDS and the clinic's account: in this slice a
 * case comes only from a chat escalation, which carries no words, so the
 * model is never given anything a clinic typed. The model reads with its
 * tools (at most DRAFT_MAX_ROUNDS requests, each with a 60-second timeout
 * and one retry by the SDK), and must end with propose_reply: the last
 * request names it. The model's own category, symptom and urgency are kept
 * on the draft as its reading; the case's are never changed by it, so
 * nothing the model was shown can move a case's triage or its address.
 *
 * A case with no clinic is never drafted: it gets no tools, no model call
 * and keeps `new` (NO_CLINIC_NOTE). Every other failure ends the run with
 * the case `needs_edit` and the reason on a row (store.ts): a person always
 * gets the case, with or without a draft.
 */

export const DRAFT_TIMEOUT_MS = 60_000;
export const DRAFT_MAX_TOKENS = 2_000;
/** Requests in one run: enough to read three or four tools and propose. */
export const DRAFT_MAX_ROUNDS = 4;

export const NO_CLINIC_NOTE =
  "No draft: this case names no practice. Match it to a practice, or close it, and a draft follows for a matched case.";

const ACTOR: ActorContext = { type: "service", serviceName: "support-draft" };

/** The one call the drafter makes. A fake in the tests; the SDK's messages.create otherwise. */
export type DraftModelClient = {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
};

/** The SDK's client on healdesk's key, or null when the key is not set. */
export async function anthropicDraftClient(): Promise<DraftModelClient | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: DRAFT_TIMEOUT_MS, maxRetries: 1 });
  return { create: (params) => client.messages.create(params) };
}

/** One request of a run. Exported so the tests can hold its shape. */
export function draftRequest(input: {
  system: { stable: string; turn: string };
  messages: Anthropic.MessageParam[];
  final: boolean;
}): Anthropic.MessageCreateParamsNonStreaming {
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: input.system.stable, cache_control: { type: "ephemeral" } },
  ];
  if (input.system.turn.trim()) system.push({ type: "text", text: input.system.turn });
  return {
    model: SUPPORT_MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    output_config: { effort: "low" },
    system,
    tools: DRAFT_TOOLS,
    // Every request must call a tool; the last must propose.
    tool_choice: input.final ? { type: "tool", name: PROPOSE_REPLY } : { type: "any" },
    messages: input.messages,
  };
}

// -----------------------------------------------------------------------------
// What the checks need to know about the practice
// -----------------------------------------------------------------------------

/** The practice-specific inputs to runReplyChecks: for the drafter, and for the send path (lane P7c). */
export type ReplyCheckContext = {
  clinicId: string;
  clinicName: string;
  audience: Audience;
  agreementKind: AgreementKind | null;
  timeZone: string;
  /** The practice's own numbers, healdesk's support line, AYA's number and the carriers' service numbers. */
  allowNumbers: string[];
  serviceNames: string[];
  otherClinicNames: string[];
  portalOrigin: string | null;
};

/** Read the context for `clinicId`, or null when its account cannot be read. */
export async function readReplyCheckContext(input: { clinicId: string; actor?: ActorContext; now?: Date }): Promise<ReplyCheckContext | null> {
  const actor = input.actor ?? ACTOR;
  const read = await readAccountState({ clinicId: input.clinicId, userId: null, actor, now: input.now });
  if (!read) return null;
  const allow: ScreenAllow = screenAllowFor(read.state, helpContacts().phoneE164);
  const forwarding = await readForwardingSteps({ clinicId: input.clinicId, actor }).catch(() => null);
  const numbers = [
    ...allow.numbers.filter((n): n is string => Boolean(n)),
    ...(forwarding && !forwarding.closed ? [forwarding.ayaNumberE164] : []),
    ...CARRIER_SERVICE_NUMBERS,
  ];
  const names = await unsafeDb
    .execute<{ id: string; name: string | null }>(sql`select id, name from app_clinics_overview()`)
    .then((r) => r.rows.filter((row) => String(row.id) !== input.clinicId && row.name).map((row) => String(row.name)))
    .catch(() => [] as string[]);
  let portalOrigin: string | null;
  try {
    portalOrigin = publicOrigin();
  } catch {
    portalOrigin = null;
  }
  return {
    clinicId: input.clinicId,
    clinicName: read.state.clinic.name,
    audience: audienceFor(read.state.clinic.specialty),
    agreementKind: read.state.clinic.agreementKind,
    timeZone: read.state.clinic.timezone,
    allowNumbers: numbers,
    serviceNames: [...(allow.serviceNames ?? [])],
    otherClinicNames: names,
    portalOrigin,
  };
}

// -----------------------------------------------------------------------------
// The proposal
// -----------------------------------------------------------------------------

export type Proposal = {
  category: string;
  symptom: string;
  urgency: string;
  handoffReasons: HandoffReason[];
  reply: string;
  factsUsed: FactsUsed[];
  questionsForOps: string[];
  confidence: Confidence;
};

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** propose_reply's input, read strictly (the schema is strict; this is the server's second look). Null when it is not one. */
export function readProposal(input: unknown): Proposal | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  if (!oneOf(TOPIC_IDS, p.category) || !oneOf(SYMPTOM_IDS, p.symptom) || !oneOf(SUPPORT_CASE_URGENCIES, p.urgency)) return null;
  if (!oneOf(CONFIDENCE_LEVELS, p.confidence)) return null;
  if (typeof p.reply !== "string" || p.reply.trim().length === 0 || p.reply.length > PROPOSAL_LIMITS.replyChars) return null;
  if (!Array.isArray(p.handoff_reasons) || !p.handoff_reasons.every((r) => oneOf(HANDOFF_REASONS, r))) return null;
  if (!Array.isArray(p.facts_used) || p.facts_used.length > PROPOSAL_LIMITS.facts) return null;
  const facts: FactsUsed[] = [];
  for (const f of p.facts_used) {
    const { tool, field, value } = (f ?? {}) as Record<string, unknown>;
    if (!oneOf(READ_TOOL_NAMES, tool) || typeof field !== "string" || typeof value !== "string") return null;
    facts.push({ tool, field: field.slice(0, 120), value: value.slice(0, PROPOSAL_LIMITS.factChars) });
  }
  if (!Array.isArray(p.questions_for_ops) || !p.questions_for_ops.every((q) => typeof q === "string")) return null;
  return {
    category: p.category,
    symptom: p.symptom,
    urgency: p.urgency,
    handoffReasons: [...new Set(p.handoff_reasons as HandoffReason[])],
    reply: p.reply.trim(),
    factsUsed: facts,
    questionsForOps: (p.questions_for_ops as string[])
      .map((q) => q.trim().slice(0, PROPOSAL_LIMITS.questionChars))
      .filter(Boolean)
      .slice(0, PROPOSAL_LIMITS.questions),
    confidence: p.confidence,
  };
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

export type DraftRunOutcome =
  | { outcome: "drafted" | "needs_edit"; caseId: string; version: number; failed: string[] }
  | { outcome: "failed"; caseId: string; version: number; reason: DraftFailure }
  | { outcome: "superseded"; caseId: string }
  | { outcome: "no_clinic"; note: string }
  | { outcome: "nothing_to_draft" };

export type DraftDeps = {
  client?: DraftModelClient | null;
  now?: Date;
  /** The readers, for the tests; draftToolbox for the claimed case otherwise. */
  toolbox?: (claimed: ClaimedCase, now: Date) => DraftToolbox;
  context?: (clinicId: string, now: Date) => Promise<ReplyCheckContext | null>;
};

async function runReadTool(name: ReadToolName, toolbox: DraftToolbox): Promise<{ text: string; isError: boolean }> {
  try {
    switch (name) {
      case "get_account_state": {
        const text = await toolbox.accountState();
        return text ? { text, isError: false } : { text: "The account could not be read just now.", isError: true };
      }
      case "get_forwarding_steps":
        return { text: forwardingText(await toolbox.forwardingSteps()), isError: false };
      case "get_clinic_signals":
        return { text: await toolbox.clinicSignals(), isError: false };
      case "get_case_history":
        return { text: await toolbox.caseHistory(), isError: false };
    }
  } catch (error) {
    log.warn("support draft tool failed", { op: name, error: describeError(error) });
  }
  return { text: "That could not be read just now.", isError: true };
}

/** Ask the model, with its tools, for one proposal. */
async function askForProposal(
  client: DraftModelClient,
  system: { stable: string; turn: string },
  firstMessage: string,
  toolbox: DraftToolbox,
): Promise<{ proposal: Proposal; toolResults: ToolResult[]; toolsRun: string[] } | { failure: DraftFailure }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: firstMessage }];
  const toolResults: ToolResult[] = [];
  const toolsRun: string[] = [];
  for (let round = 0; round < DRAFT_MAX_ROUNDS; round += 1) {
    let message: Anthropic.Message;
    try {
      message = await client.create(draftRequest({ system, messages, final: round === DRAFT_MAX_ROUNDS - 1 }));
    } catch (error) {
      log.warn("support draft model failed", { error: error instanceof Error ? error.name : "unknown" });
      return { failure: "model_failed" };
    }
    if (message.stop_reason === "refusal") return { failure: "model_refused" };
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const propose = uses.find((u) => u.name === PROPOSE_REPLY);
    if (propose) {
      // A proposal cut off at max_tokens is never taken.
      if (message.stop_reason === "max_tokens") return { failure: "no_proposal" };
      const proposal = readProposal(propose.input);
      return proposal ? { proposal, toolResults, toolsRun } : { failure: "no_proposal" };
    }
    if (uses.length === 0 || message.stop_reason !== "tool_use") return { failure: "no_proposal" };
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      if (!oneOf(READ_TOOL_NAMES, use.name)) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `There is no tool called ${use.name}.`, is_error: true });
        continue;
      }
      const read = await runReadTool(use.name, toolbox);
      toolsRun.push(use.name);
      if (!read.isError) toolResults.push({ tool: use.name, text: read.text });
      results.push({ type: "tool_result", tool_use_id: use.id, content: read.text, ...(read.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { failure: "no_proposal" };
}

async function fail(claimed: ClaimedCase, reason: DraftFailure, now: Date): Promise<DraftRunOutcome> {
  const written = await recordDraft(claimed, { kind: "failure", failure: reason }, now);
  if (!written.written) return { outcome: "superseded", caseId: claimed.id };
  log.info("support draft not written", { clinicId: claimed.clinicId, reason, attempt: claimed.version });
  return { outcome: "failed", caseId: claimed.id, version: claimed.version, reason };
}

/** Draft one claimed case. Never throws for a failure it can name: the case ends `needs_edit` with the reason. */
export async function draftClaimedCase(claimed: ClaimedCase, deps: DraftDeps = {}): Promise<DraftRunOutcome> {
  const now = deps.now ?? new Date();
  if (claimed.attempts >= DRAFTS_PER_CASE) return fail(claimed, "draft_limit", now);
  const client = deps.client === undefined ? await anthropicDraftClient() : deps.client;
  if (!client) return fail(claimed, "model_unavailable", now);

  const context = await (deps.context ?? ((clinicId, at) => readReplyCheckContext({ clinicId, now: at })))(claimed.clinicId, now).catch(
    (error: unknown) => {
      log.warn("support draft: account not read", { clinicId: claimed.clinicId, error: describeError(error) });
      return null;
    },
  );
  if (!context) return fail(claimed, "account_unreadable", now);

  const toolbox = (deps.toolbox ?? ((c, at) => draftToolbox({ clinicId: c.clinicId, actor: ACTOR, current: c, now: at })))(claimed, now);
  const system = buildDraftPrompt({
    clinicName: context.clinicName,
    audience: context.audience,
    agreementKind: context.agreementKind,
    timeZone: context.timeZone,
    now,
  });
  const asked = await askForProposal(
    client,
    system,
    draftRequestText({
      ref: `HD-${claimed.ref}`,
      source: claimed.source,
      category: claimed.category,
      symptom: claimed.symptom,
      urgency: claimed.urgency,
      fields: claimed.fields,
    }),
    toolbox,
  );
  if ("failure" in asked) return fail(claimed, asked.failure, now);

  const { proposal, toolResults, toolsRun } = asked;
  const checks = runReplyChecks({
    text: proposal.reply,
    clinicName: context.clinicName,
    facts: proposal.factsUsed,
    toolResults,
    ownCaseRef: claimed.ref,
    mode: "draft",
    allowNumbers: context.allowNumbers,
    serviceNames: context.serviceNames,
    clinicId: claimed.clinicId,
    otherClinicNames: context.otherClinicNames,
    agreementKind: context.agreementKind,
    portalOrigin: context.portalOrigin,
  });
  // What is kept is what the screen lets through: a stranger's number or a
  // treatment name the model wrote is stored hidden, and check 2 says so.
  const allow: ScreenAllow = { numbers: context.allowNumbers, emails: [], serviceNames: context.serviceNames };
  const written = await recordDraft(
    claimed,
    {
      kind: "draft",
      text: screenText(proposal.reply, allow).text,
      checks,
      facts: {
        factsUsed: proposal.factsUsed.map((f) => ({ ...f, value: screenText(f.value, allow).text })),
        questionsForOps: proposal.questionsForOps.map((q) => screenText(q, allow).text),
        confidence: proposal.confidence,
        proposal: {
          category: proposal.category,
          symptom: proposal.symptom,
          urgency: proposal.urgency,
          handoffReasons: proposal.handoffReasons,
        },
        toolsRun,
      },
    },
    now,
  );
  if (!written.written) return { outcome: "superseded", caseId: claimed.id };
  const failed = failedCheckIds(checks);
  log.info("support draft written", { clinicId: claimed.clinicId, attempt: claimed.version, code: failed.join(",") || "ok" });
  return { outcome: checks.ok ? "drafted" : "needs_edit", caseId: claimed.id, version: claimed.version, failed };
}

/**
 * Claim and draft one case, the most urgent first, or the case named. A case
 * with no clinic is not claimed: drafting one returns NO_CLINIC_NOTE.
 */
export async function draftNextCase(deps: DraftDeps = {}, only?: string): Promise<DraftRunOutcome> {
  const now = deps.now ?? new Date();
  if (only) {
    const [row] = await unsafeDb.execute<{ subject_clinic_id: string | null }>(
      sql`select subject_clinic_id from support_cases where id = ${only}`,
    ).then((r) => r.rows);
    if (row && row.subject_clinic_id === null) return { outcome: "no_clinic", note: NO_CLINIC_NOTE };
  }
  const claimed = await claimCaseToDraft(now, only);
  if (!claimed) return { outcome: "nothing_to_draft" };
  try {
    return await draftClaimedCase(claimed, { ...deps, now });
  } catch (error) {
    // A database failure after the claim: the case is left `drafting`, and
    // the next run past the lease takes it again.
    log.error("support draft run failed", { clinicId: claimed.clinicId, error: describeError(error) });
    return fail(claimed, "model_failed", now).catch(() => ({ outcome: "superseded" as const, caseId: claimed.id }));
  }
}
