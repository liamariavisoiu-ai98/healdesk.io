import { findUrgentContent } from "@healdesk/catalog";

import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { formatPhone } from "@/lib/setup/help";
import { spokenPhone } from "@/lib/voice/spoken";

import type { AssistantChannel, AssistantFacts } from "./facts";
import { cardNumberIn, guardAssistantReply, guardedLine, type GuardRefusal } from "./guard";
import { buildAssistantPrompt } from "./prompt";

/**
 * One turn of a call or a web chat: the brain both adapters share (CLAUDE.md,
 * "One brain, four adapters"; the Meta channels keep their own narrower front
 * door, lib/meta/front-door.ts).
 *
 *   1. A card number is cut from the person's words before anything else sees
 *      them, and they are told not to share card details.
 *   2. A complication or an urgent symptom is matched before the model
 *      (findUrgentContent) and answered with a fixed line: 911, then the
 *      clinic's urgent-help number. The adapter escalates (an alert to the
 *      clinic; on a call, a transfer to that number).
 *   3. Otherwise the model answers from the clinic's facts, as one JSON
 *      object, and the guard (guard.ts) reads its reply; a refused reply is
 *      replaced by a fixed line.
 *
 * The model writes nothing: what it collects for a booking request is
 * returned as a capture, cleaned, and the adapter decides what to do with it
 * (the post-call ingest for a call, the request writer for a chat). A model
 * that fails or times out gives the fixed failure line, never silence.
 */

export type AssistantMessage = { role: "user" | "assistant"; content: string };

/** The model: a system prompt and the conversation so far, the last message the person's. Returns its raw text. */
export type AssistantResponder = (request: { system: string; messages: AssistantMessage[]; channel: AssistantChannel }) => Promise<string>;

export type BookingCapture = {
  wants: boolean;
  firstName: string | null;
  phone: string | null;
  window: string | null;
  altWindows: string[];
  service: string | null;
  fields: Record<string, string>;
};

export const EMPTY_CAPTURE: BookingCapture = { wants: false, firstName: null, phone: null, window: null, altWindows: [], service: null, fields: {} };

export type TurnSource = "model" | "urgent" | "guard" | "card" | "fallback";

export type AssistantTurnResult = {
  /** What the assistant says next. */
  reply: string;
  source: TurnSource;
  /** The person's words as they may be kept for the transcript: a card number cut. */
  personText: string;
  capture: BookingCapture;
  handoff: boolean;
  end: boolean;
  urgent: boolean;
  guard?: GuardRefusal;
};


export const FAILURE_LINE =
  "Sorry, I'm having trouble on my end. Please try again in a moment, or contact the practice directly.";

function numberFor(channel: AssistantChannel, e164: string | null): string | null {
  if (!e164) return null;
  return channel === "voice" ? spokenPhone(e164) : formatPhone(e164);
}

export function urgentReply(facts: Pick<AssistantFacts, "clinicName" | "urgentPhone" | "phone">, channel: AssistantChannel): string {
  const number = numberFor(channel, facts.urgentPhone ?? facts.phone);
  return (
    `I'm an AI assistant, so I can't help with anything urgent. ` +
    `If this is an emergency, call 911 now. ` +
    `Otherwise, please contact ${facts.clinicName}${number ? ` right away on ${number}` : " right away"}.`
  );
}

const CARD_LINE = "Please don't share card details with me: I've left that number out. The practice handles payment securely itself.";

const MAX_TEXT = 2_000;
const MAX_FIELD = 120;

function clean(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text.length > 0 ? text : null;
}

type ModelAnswer = { reply: string; booking: Partial<BookingCapture>; handoff: boolean; end: boolean };

/** The model's JSON, read leniently: the first object in the text, or the text itself as the reply. */
export function parseModelAnswer(raw: string): ModelAnswer {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const b = (parsed.booking && typeof parsed.booking === "object" ? parsed.booking : {}) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      if (b.fields && typeof b.fields === "object") {
        for (const [key, value] of Object.entries(b.fields as Record<string, unknown>)) {
          const v = clean(value);
          if (v && /^[a-z_]{1,40}$/.test(key)) fields[key] = v;
        }
      }
      return {
        reply: clean(parsed.reply, MAX_TEXT) ?? "",
        booking: {
          wants: b.wants === true,
          firstName: clean(b.first_name, 60),
          phone: clean(b.phone, 30),
          window: clean(b.window),
          altWindows: Array.isArray(b.alt_windows) ? b.alt_windows.map((w) => clean(w)).filter((w): w is string => Boolean(w)).slice(0, 2) : [],
          service: clean(b.service),
          fields,
        },
        handoff: parsed.handoff === true,
        end: parsed.end === true,
      };
    } catch {
      // fall through to the text itself
    }
  }
  return { reply: clean(raw, MAX_TEXT) ?? "", booking: {}, handoff: false, end: false };
}

/** Later values win; an empty value never erases one already captured. */
export function mergeCapture(previous: BookingCapture, next: Partial<BookingCapture>): BookingCapture {
  return {
    wants: previous.wants || next.wants === true,
    firstName: next.firstName ?? previous.firstName,
    phone: next.phone ?? previous.phone,
    window: next.window ?? previous.window,
    altWindows: next.altWindows && next.altWindows.length > 0 ? next.altWindows : previous.altWindows,
    service: next.service ?? previous.service,
    fields: { ...previous.fields, ...(next.fields ?? {}) },
  };
}

/** The conversation as the model sees it: alternating, starting with the person. */
export function messagesFor(history: readonly TranscriptTurn[], personText: string): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  for (const turn of [...history, { speaker: "person" as const, text: personText }]) {
    const role = turn.speaker === "person" ? "user" : "assistant";
    if (out.length === 0 && role === "assistant") continue; // the opening line is in the system prompt
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${turn.text}`;
    else out.push({ role, content: turn.text });
  }
  return out;
}

export async function answerTurn(input: {
  facts: AssistantFacts;
  channel: AssistantChannel;
  /** Everything said so far, the opening line included. */
  history: readonly TranscriptTurn[];
  text: string;
  capture?: BookingCapture;
  responder: AssistantResponder | null;
  now?: Date;
}): Promise<AssistantTurnResult> {
  const { facts, channel } = input;
  const capture = input.capture ?? EMPTY_CAPTURE;
  const card = cardNumberIn(input.text.slice(0, MAX_TEXT));
  const personText = card.text;
  const base = { personText, capture, handoff: false, end: false, urgent: false };

  if (findUrgentContent(personText)) {
    return { ...base, reply: urgentReply(facts, channel), source: "urgent", urgent: true };
  }
  if (card.found) {
    return { ...base, reply: CARD_LINE, source: "card" };
  }
  if (!input.responder) {
    return { ...base, reply: FAILURE_LINE, source: "fallback" };
  }

  const opening = input.history.find((t) => t.speaker === "assistant")?.text;
  const system =
    buildAssistantPrompt(facts, channel, input.now ?? new Date()) +
    (opening ? `\n\nYou opened the conversation with: "${opening}"` : "");
  let raw: string;
  try {
    raw = await input.responder({ system, messages: messagesFor(input.history, personText), channel });
  } catch {
    return { ...base, reply: FAILURE_LINE, source: "fallback" };
  }
  const answer = parseModelAnswer(raw);
  const merged = mergeCapture(capture, answer.booking);
  const verdict = guardAssistantReply(answer.reply, facts);
  if (!verdict.ok) {
    return { ...base, capture: merged, handoff: answer.handoff, reply: guardedLine(verdict.reason, facts.clinicName), source: "guard", guard: verdict.reason };
  }
  return { ...base, capture: merged, handoff: answer.handoff, end: answer.end, reply: answer.reply, source: "model" };
}
