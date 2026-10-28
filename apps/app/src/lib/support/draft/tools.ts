import type Anthropic from "@anthropic-ai/sdk";
import { CHANNEL_NAMES, type Channel } from "@healdesk/catalog";
import { and, desc, eq, gt, ne } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { billingTransitions, channelEvents, supportCases } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { formatPhone } from "@/lib/setup/help";
import { withTenant } from "@/lib/tenant";

import { describeAccountState } from "../account-state";
import { readAccountState } from "../account-reader";
import { FACTS_DAYS, readCaseFacts } from "../case-facts";
import { ACTION_KEYS, ACTION_VALUES } from "../actions/tiers";
import { printRef, SUPPORT_CASE_URGENCIES } from "../case-vocab";
import { ESCALATION_TOPICS, SYMPTOM_IDS, TOPIC_IDS, topicLabel } from "../escalation-fields";
import { readForwardingSteps, type ForwardingAnswer } from "../forwarding";

/**
 * The support drafter's tools (design E5 §6; lane P7b): four read-only
 * readers of the case's own clinic and one strict proposal.
 *
 *   get_account_state     the chat's account facts, in the chat's words
 *                         (describeAccountState), read by readAccountState.
 *   get_forwarding_steps  the forwarding and undo codes for the clinic's
 *                         carrier and coverage mode (readForwardingSteps).
 *   get_clinic_signals    the last 14 days of ops alerts raised about the
 *                         clinic (event names and times), its channel events
 *                         (kinds and times), its transcript emails (counts
 *                         by status) and its billing transitions (statuses,
 *                         reasons and times). Reuses readCaseFacts, the
 *                         console's facts panel.
 *   get_case_history      this case and the clinic's other cases: refs,
 *                         dates, topics, states and how they closed.
 *   propose_action        lane D: ONE change to the practice's Settings that
 *                         its email asks for, from the closed list only
 *                         (lib/support/actions/tiers.ts). The model never
 *                         makes it: code answers what will happen
 *                         (lib/support/actions/propose.ts) and runs it, or
 *                         not, outside the model.
 *   propose_reply         the draft, its triage and the facts it rests on.
 *
 * Every reader takes the case's clinic id and nothing else: the tenant
 * readers run inside withTenant for that clinic, and the platform-wide
 * tables (ops_alerts, support_cases) are filtered to it, so another clinic's
 * data cannot reach the model. A case with no clinic gets no tools at all
 * (run.ts never calls the model for it).
 *
 * What each returns is plain text: labels, closed words, counts and dates
 * written out ("Wednesday 28 October 2026 (2026-10-28)"), so a fact the
 * reply quotes can be found in it word for word (checks.ts, check 1).
 * Nothing anyone typed is in it, and nothing about a patient.
 */

export const READ_TOOL_NAMES = [
  "get_account_state",
  "get_forwarding_steps",
  "get_clinic_signals",
  "get_case_history",
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export const PROPOSE_REPLY = "propose_reply";
/** Lane D: the one Settings change the email asks for, from the closed list (lib/support/actions/tiers.ts). */
export const PROPOSE_ACTION = "propose_action";
/** The tools a fact may cite: the readers, and propose_action's answer (its "- Setting:" and "- Value:" lines). */
export const FACT_TOOL_NAMES = [...READ_TOOL_NAMES, PROPOSE_ACTION] as const;
export type FactToolName = (typeof FACT_TOOL_NAMES)[number];

/** Why a person must handle it beyond the reply (E5 §3, "Hands to a person"). */
export const HANDOFF_REASONS = [
  "money",
  "cancellation",
  "agreement_or_legal",
  "security",
  "about_a_patient",
  "asked_for_a_person",
  "upset_practice",
  "needs_a_call",
  "other",
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** How many facts and questions a proposal may carry, and how long each may be. */
export const PROPOSAL_LIMITS = { facts: 30, factChars: 300, questions: 5, questionChars: 300, replyChars: 4_000 } as const;

const NO_INPUT: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/** In a fixed order: the tools are the front of the cached prefix. */
export const DRAFT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_account_state",
    description:
      "The practice's account as plain facts: setup and the build tracker, each channel's status and next step, the coverage mode, carrier and phone system, which numbers and switches are set, the calendar and payment connections, the package, plan start, auto-renew, the allowance switch, usage this period, and whether its email address takes mail.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "get_forwarding_steps",
    description:
      "The call forwarding codes for this practice's carrier, line and coverage mode, with the undo codes. Returns nothing until phone is ready for forwarding on healdesk's side, and only the undo steps once the service has ended.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "get_clinic_signals",
    description: `What happened to this practice in the last ${FACTS_DAYS} days, as names, states and dates: the alerts healdesk raised about it, its channels' events, how its transcript emails stand, and its billing status changes.`,
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: "get_case_history",
    description:
      "This case (its reference, when it opened, its topic, what is wrong, its urgency, its state and the day a person replies by) and the practice's other support cases: dates, topics, states and how they closed. Never anyone's words.",
    input_schema: NO_INPUT,
    strict: true,
  },
  {
    name: PROPOSE_ACTION,
    description:
      "Proposes ONE change to the practice's Settings that its email clearly asks for, from this closed list only. You never make the change: healdesk's system decides whether and when it runs and answers with what will happen and what your reply may say. Call it at most once, before propose_reply, and only when the email asks for exactly this change.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", enum: [...ACTION_KEYS], description: "The setting the email asks to change." },
        value: {
          type: "string",
          enum: [...ACTION_VALUES],
          description: "on or off for a switch; for a choice, the option's id (tone: warm, clinical; payment_ask: deposit_only, full_payment; deposit_hold_minutes: 30, 60, 120, 240, 1440; deposit_uncollectable: book_and_flag, hold_and_alert, decline_and_alert).",
        },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: PROPOSE_REPLY,
    description:
      "Proposes the email reply for a person at healdesk to read, edit and send, with your reading of the case and every fact the reply relies on. Call it once, last.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...TOPIC_IDS], description: "Your reading of the topic." },
        symptom: {
          type: "string",
          enum: [...SYMPTOM_IDS],
          description: "Your reading of what is wrong, from the topic's own list; 'other' when none fits.",
        },
        urgency: {
          type: "string",
          enum: [...SUPPORT_CASE_URGENCIES],
          description:
            "now: AYA not answering, calls ringing out, a charge disputed, a lost device or anything about security. today: something the practice relies on is broken. this_week: questions and changes.",
        },
        handoff_reasons: {
          type: "array",
          items: { type: "string", enum: [...HANDOFF_REASONS] },
          description: "Why a person must handle more than the reply; empty when the reply settles it.",
        },
        reply: {
          type: "string",
          description:
            'The reply in plain text, two to four sentences, at most six and 900 characters, not signed (the email adds "The Healdesk Team").',
        },
        facts_used: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", enum: [...FACT_TOOL_NAMES] },
              field: { type: "string", description: "The line's label in that tool's result, copied exactly as the tool printed it before its colon." },
              value: { type: "string", description: "The value exactly as that tool wrote it." },
            },
            required: ["tool", "field", "value"],
            additionalProperties: false,
          },
          description:
            "Every fact the reply relies on. Each date, day, time, amount, percent, count, package name, phone number and link in the reply must be in one of these values.",
        },
        questions_for_ops: {
          type: "array",
          items: { type: "string" },
          description:
            "Short questions the person at healdesk should answer before sending; never a name, a number or an address. Empty when there are none, and always empty when the case has an <email>: they are not kept then.",
        },
        confidence: {
          type: "string",
          enum: [...CONFIDENCE_LEVELS],
          description: "high when the facts settle it, medium when they mostly do, low when the reply mostly asks.",
        },
      },
      required: [
        "category",
        "symptom",
        "urgency",
        "handoff_reasons",
        "reply",
        "facts_used",
        "questions_for_ops",
        "confidence",
      ],
      additionalProperties: false,
    },
    strict: true,
  },
];

// -----------------------------------------------------------------------------
// Dates, written so a reply can quote them
// -----------------------------------------------------------------------------

const NEW_YORK = "America/New_York";

/** "Wednesday 28 October 2026 (2026-10-28)", for an ISO day or an instant (in New York). */
export function dayWords(value: string | Date, timeZone = NEW_YORK): string {
  let iso: string;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    iso = value;
  } else {
    const at = typeof value === "string" ? new Date(value) : value;
    if (Number.isNaN(at.getTime())) return "unknown";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    iso = `${get("year")}-${get("month")}-${get("day")}`;
  }
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")} (${iso})`;
}

/** A closed word or an id from a fixed list, kept only when it looks like one. */
function token(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) ? value : null;
}

// -----------------------------------------------------------------------------
// The readers, each for the case's clinic only
// -----------------------------------------------------------------------------

export type DraftCaseFacts = {
  id: string;
  ref: string;
  category: string;
  symptom: string;
  urgency: string;
  state: string;
  openedAt: Date;
  replyByOn: string;
};

export type DraftToolbox = {
  accountState(): Promise<string | null>;
  forwardingSteps(): Promise<ForwardingAnswer | null>;
  clinicSignals(): Promise<string>;
  caseHistory(): Promise<string>;
};

export function accountStateText(lines: readonly (readonly [string, string])[]): string {
  return `The account:\n${lines.map(([label, value]) => `- ${label}: ${value}`).join("\n")}`;
}

export function forwardingText(steps: ForwardingAnswer | null): string {
  if (!steps) {
    return "Nothing yet: phone isn't ready for call forwarding on healdesk's side, so there are no codes. The practice should not change its call forwarding yet: the steps appear in Setup once phone is ready.";
  }
  if (steps.closed) {
    return [
      "The service has ended: there are no codes to forward calls to AYA, only the way back.",
      `Carrier: ${steps.carrier}.`,
      "To undo:",
      ...steps.undo.map((s) => `- ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
    ].join("\n");
  }
  const lines = [
    `AYA's number: ${formatPhone(steps.ayaNumberE164)}. Carrier: ${steps.carrier}. Which calls reach AYA: ${steps.mode}.`,
    "To forward:",
    ...steps.steps.map((s, i) => `${i + 1}. ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
    "To undo:",
    ...steps.undo.map((s) => `- ${s.label}${s.dial ? ` ${s.dial}` : ""}`),
    ...(steps.notes.length > 0 ? ["Notes:", ...steps.notes.map((n) => `- ${n}`)] : []),
  ];
  if (steps.needsCarrierHelp) lines.push("Exact codes aren't known for this carrier: the practice asks its carrier; never guess a code.");
  return lines.join("\n");
}

function symptomWords(topic: string, symptom: string): string {
  const symptoms = (ESCALATION_TOPICS as Record<string, { symptoms: Record<string, string> }>)[topic]?.symptoms;
  return symptoms?.[symptom] ?? symptom;
}

const STATE_WORDS: Readonly<Record<string, string>> = {
  new: "waiting for a reply from healdesk",
  drafting: "a reply is being drafted",
  drafted: "a reply is drafted, waiting for a person at healdesk",
  needs_edit: "a reply is waiting for a person at healdesk",
  waiting_clinic: "healdesk replied; waiting on the practice",
  snoozed: "put aside by healdesk for now",
  closed: "closed",
};

/** get_case_history for one clinic: this case first, then up to ten others, newest first. */
export async function caseHistoryText(clinicId: string, current: DraftCaseFacts, now: Date): Promise<string> {
  const since = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const others = await unsafeDb
    .select({
      ref: supportCases.ref,
      category: supportCases.category,
      symptom: supportCases.symptom,
      state: supportCases.state,
      openedAt: supportCases.openedAt,
      closedAt: supportCases.closedAt,
      closedReason: supportCases.closedReason,
    })
    .from(supportCases)
    .where(and(eq(supportCases.subjectClinicId, clinicId), ne(supportCases.id, current.id), gt(supportCases.openedAt, since)))
    .orderBy(desc(supportCases.openedAt), desc(supportCases.id))
    .limit(10);
  const lines = [
    "This case:",
    `- Reference: ${printRef(current.ref)}`,
    `- Opened: ${dayWords(current.openedAt)}`,
    `- Topic: ${topicLabel(current.category)}`,
    `- What is wrong: ${symptomWords(current.category, current.symptom)}`,
    `- Urgency: ${current.urgency}`,
    `- State: ${STATE_WORDS[current.state] ?? current.state}`,
    `- A person replies by: ${dayWords(current.replyByOn)}`,
  ];
  lines.push(others.length > 0 ? "The practice's other support cases this year, newest first:" : "The practice has no other support cases this year.");
  for (const c of others) {
    const closed = c.closedAt ? `, closed ${dayWords(c.closedAt)} (${c.closedReason ?? "closed"})` : "";
    lines.push(
      `- ${printRef(c.ref)}: opened ${dayWords(c.openedAt)}, ${topicLabel(c.category)}, ${symptomWords(c.category, c.symptom)}; ${STATE_WORDS[c.state] ?? c.state}${closed}`,
    );
  }
  return lines.join("\n");
}

/** get_clinic_signals for one clinic. Each part reads on its own; one that fails says so. */
export async function clinicSignalsText(clinicId: string, actor: ActorContext, now: Date): Promise<string> {
  const since = new Date(now.getTime() - FACTS_DAYS * 24 * 60 * 60 * 1000);
  const facts = await readCaseFacts({ clinicId, actor, now });
  const tenant = await withTenant({ clinicId, actor }, async (tx) => {
    const events = await tx.db
      .select({ channel: channelEvents.channel, kind: channelEvents.kind, waitingOn: channelEvents.waitingOn, at: channelEvents.occurredAt })
      .from(channelEvents)
      .where(and(eq(channelEvents.clinicId, tx.clinicId), gt(channelEvents.occurredAt, since)))
      .orderBy(desc(channelEvents.occurredAt), desc(channelEvents.id))
      .limit(30);
    const billing = await tx.db
      .select({ from: billingTransitions.fromStatus, to: billingTransitions.toStatus, reason: billingTransitions.reason, at: billingTransitions.createdAt })
      .from(billingTransitions)
      .where(and(eq(billingTransitions.clinicId, tx.clinicId), gt(billingTransitions.createdAt, since)))
      .orderBy(desc(billingTransitions.createdAt), desc(billingTransitions.id))
      .limit(20);
    return { events, billing };
  }).catch((error: unknown) => {
    log.warn("support draft: signals not read", { clinicId, error: describeError(error) });
    return null;
  });

  const lines = [`The last ${FACTS_DAYS} days, newest first.`];
  lines.push("Alerts healdesk raised about the practice:");
  if (facts.alerts === null) lines.push("- could not be read just now");
  else if (facts.alerts.length === 0) lines.push("- none");
  for (const a of facts.alerts ?? []) {
    const repeats = a.repeats > 0 ? `, raised again ${a.repeats} times` : "";
    lines.push(`- ${token(a.event) ?? "an alert"}: first ${dayWords(a.raisedAt)}, last ${dayWords(a.lastRaisedAt)}${repeats}`);
  }
  lines.push("Channel events:");
  if (!tenant) lines.push("- could not be read just now");
  else if (tenant.events.length === 0) lines.push("- none");
  for (const e of tenant?.events ?? []) {
    const channel = e.channel ? CHANNEL_NAMES[e.channel as Channel] ?? e.channel : "all channels";
    const waiting = e.waitingOn ? ` (waiting on ${token(e.waitingOn) ?? "the practice"})` : "";
    lines.push(`- ${channel}: ${e.kind}${waiting}, ${dayWords(e.at)}`);
  }
  lines.push("Transcript emails, by status:");
  if (facts.transcripts === null) lines.push("- could not be read just now");
  else {
    const counts = Object.entries(facts.transcripts).filter(([, n]) => n > 0);
    if (counts.length === 0) lines.push("- none");
    for (const [status, n] of counts) lines.push(`- ${token(status) ?? "other"}: ${n}`);
  }
  lines.push("Billing status changes:");
  if (!tenant) lines.push("- could not be read just now");
  else if (tenant.billing.length === 0) lines.push("- none");
  for (const b of tenant?.billing ?? []) {
    lines.push(`- ${b.from ?? "none"} to ${b.to} (${token(b.reason) ?? "other"}), ${dayWords(b.at)}`);
  }
  return lines.join("\n");
}

/** The four readers for the case's clinic. */
export function draftToolbox(input: { clinicId: string; actor: ActorContext; current: DraftCaseFacts; now: Date }): DraftToolbox {
  const { clinicId, actor, current, now } = input;
  return {
    accountState: async () => {
      const read = await readAccountState({ clinicId, userId: null, actor, now });
      return read ? accountStateText(describeAccountState(read.account)) : null;
    },
    forwardingSteps: () => readForwardingSteps({ clinicId, actor }),
    clinicSignals: () => clinicSignalsText(clinicId, actor, now),
    caseHistory: () => caseHistoryText(clinicId, current, now),
  };
}
