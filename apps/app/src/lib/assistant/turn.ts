import {
  findUrgentContent,
  fixedUrgentReply,
  messageLanguage,
  otherLanguageReply,
  urgentSetFor,
  type UrgentFinding,
} from "@healdesk/catalog";

import { isOpenAt } from "@/lib/clinic/opening-hours";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { URGENT_ALERT_DELIVERED } from "@/lib/notices/booking-alerts";
import { formatPhone } from "@/lib/setup/help";
import { spokenPhone } from "@/lib/voice/spoken";

import type { AssistantChannel, AssistantFacts } from "./facts";
import { cardNumberIn, guardAssistantReply, guardedLine, type GuardRefusal } from "./guard";
import { assistantTurnContext, buildAssistantPrompt } from "./prompt";
import { isModelRefusal, type AssistantMessage, type AssistantResponder } from "./responder";

export type { AssistantMessage, AssistantPrompt, AssistantResponder, ModelRefusal } from "./responder";

/**
 * One turn of a call or a web chat: the brain both adapters share (CLAUDE.md,
 * "One brain, four adapters"; the Meta channels keep their own narrower front
 * door, lib/meta/front-door.ts).
 *
 *   1. A card number is cut from the person's words before anything else sees
 *      them, and they are told not to share card details.
 *   2. A complication or an urgent symptom is matched before the model
 *      (findUrgentContent, with the practice's own set: people's, or an
 *      animal's at a veterinary practice) and answered with the catalog's
 *      fixed line (fixedUrgentReply): 911, or the emergency vet, then the
 *      clinic's own number. The adapter escalates (an alert to the clinic).
 *   3. A message in a language the screens do not read (messageLanguage:
 *      neither English nor Spanish) gets a fixed line in English and
 *      Spanish, with 911 and the clinic's number, and never the model.
 *   4. Otherwise the model answers from the clinic's facts, as one JSON
 *      object, and the guard (guard.ts) reads its reply; a refused reply is
 *      replaced by a fixed line. A model that declines to answer at all (a
 *      refusal) gets its own fixed line and its own source, "refusal",
 *      never the guard's.
 *
 * The model writes nothing: what it collects for a booking request is
 * returned as a capture, cleaned, and the adapter decides what to do with it
 * (the post-call ingest for a call, the request writer for a chat). A model
 * that fails or times out gives the fixed failure line, never silence.
 */

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

export type TurnSource = "model" | "urgent" | "guard" | "card" | "fallback" | "refusal" | "language";

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


/**
 * What the tool layer wrote on a turn: never a booking. The brain has no
 * booking tools: it takes a request and the adapter files it, so a reply
 * that says a booking is made is refused (guard.ts, confirmsBooking). The
 * tool layer, once it exists, says per turn whether it wrote one.
 */
const NO_BOOKING_WRITTEN = { bookingWritten: false } as const;

export const FAILURE_LINE =
  "Sorry, I'm having trouble on my end. Please try again in a moment, or contact the practice directly.";

function numberFor(channel: AssistantChannel, e164: string | null): string | null {
  if (!e164) return null;
  return channel === "voice" ? spokenPhone(e164) : formatPhone(e164);
}

/**
 * The number that reaches a person at the practice, for the channel. On a
 * call never the published number, which forwards back to the assistant:
 * the urgent-help number, then the direct line, and none when neither is set
 * apart from it. In writing, the urgent-help number (lib/setup/urgent.ts),
 * else the published one.
 */
function personNumber(
  facts: Pick<AssistantFacts, "urgentPhone" | "phone" | "directLine">,
  channel: AssistantChannel,
): string | null {
  if (channel !== "voice") return numberFor(channel, facts.urgentPhone ?? facts.phone);
  const number = [facts.urgentPhone, facts.directLine].find((n) => n && n !== facts.phone) ?? null;
  return numberFor(channel, number);
}

type ReplyFacts = Pick<
  AssistantFacts,
  "clinicName" | "urgentPhone" | "phone" | "directLine" | "vetReferralPhone" | "openingHours" | "timeZone"
>;

function openNow(facts: Pick<AssistantFacts, "openingHours" | "timeZone">, now: Date): boolean | null {
  try {
    return isOpenAt(facts.openingHours, now, facts.timeZone);
  } catch {
    return null; // a bad time zone: hours unknown, which counts as open
  }
}

/**
 * The fixed urgent reply (@healdesk/catalog, fixedUrgentReply) with this
 * clinic's numbers written for the channel (personNumber), in the language
 * the person wrote in, and at a veterinary practice the emergency referral
 * clinic, with the practice's own number only while it is open. "I've told
 * the team" only once the urgent alert reaches the clinic
 * (URGENT_ALERT_DELIVERED).
 */
export function urgentReply(
  facts: ReplyFacts & Partial<Pick<AssistantFacts, "specialty">>,
  channel: AssistantChannel,
  finding: Pick<UrgentFinding, "emergency"> & Partial<Pick<UrgentFinding, "language">>,
  now: Date,
): string {
  return fixedUrgentReply({
    channel,
    emergency: finding.emergency,
    language: finding.language ?? "en",
    veterinary: urgentSetFor(facts.specialty) === "veterinary",
    clinicName: facts.clinicName,
    clinicNumber: personNumber(facts, channel),
    referralNumber: numberFor(channel, facts.vetReferralPhone),
    clinicOpen: openNow(facts, now),
    teamAlerted: URGENT_ALERT_DELIVERED,
  });
}

/**
 * What the person hears when the model declines to answer: honest that it
 * cannot help, and how to reach a person. On the website chat, the clinic's
 * published number; on a call, which already came in on that number, the
 * number that reaches a person (personNumber), or none.
 */
export function refusalLine(
  facts: Pick<AssistantFacts, "clinicName" | "phone" | "urgentPhone" | "directLine">,
  channel: AssistantChannel,
): string {
  const number = channel === "voice" ? personNumber(facts, channel) : numberFor(channel, facts.phone ?? facts.urgentPhone);
  return (
    `Sorry, that's not something I can help with. ` +
    (number
      ? `The team at ${facts.clinicName} can: please call them on ${number}.`
      : `The team at ${facts.clinicName} can help, and they get back to people within a day.`)
  );
}

/**
 * The practice's own words, for the language check (@healdesk/catalog,
 * messageLanguage): its name, its address and city, its services and its
 * providers. Neither English nor another language, so "is Okonkwo in on
 * Tuesday?" or the name of its signature facial never turns a message away.
 */
export function languageTerms(
  facts: Pick<AssistantFacts, "clinicName" | "address" | "services"> & Partial<Pick<AssistantFacts, "providerNames">>,
): string[] {
  return [facts.clinicName, facts.address ?? "", ...facts.services.map((s) => s.name), ...(facts.providerNames ?? [])].filter(
    (term) => term.trim().length > 0,
  );
}

/** The fixed line for a message in a language no screen reads, in English and in Spanish. */
export function languageLine(facts: ReplyFacts & Pick<AssistantFacts, "specialty">, channel: AssistantChannel): string {
  return otherLanguageReply({
    channel,
    clinicName: facts.clinicName,
    clinicNumber: personNumber(facts, channel),
    referralNumber: numberFor(channel, facts.vetReferralPhone),
    veterinary: urgentSetFor(facts.specialty) === "veterinary",
  });
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

  const now = input.now ?? new Date();
  const finding = findUrgentContent(personText, facts.specialty, { clinicName: facts.clinicName });
  if (finding) {
    return { ...base, reply: urgentReply(facts, channel, finding, now), source: "urgent", urgent: true };
  }
  if (card.found) {
    return { ...base, reply: CARD_LINE, source: "card" };
  }
  // A language the screens cannot read: no model, a fixed line in English and Spanish.
  if (messageLanguage(personText, { knownTerms: languageTerms(facts) }) === "other") {
    return { ...base, reply: languageLine(facts, channel), source: "language" };
  }
  if (!input.responder) {
    return { ...base, reply: FAILURE_LINE, source: "fallback" };
  }

  const opening = input.history.find((t) => t.speaker === "assistant")?.text;
  const system = { stable: buildAssistantPrompt(facts, channel), turn: assistantTurnContext(facts, now, opening) };
  let raw: Awaited<ReturnType<AssistantResponder>>;
  try {
    raw = await input.responder({ system, messages: messagesFor(input.history, personText), channel });
  } catch {
    return { ...base, reply: FAILURE_LINE, source: "fallback" };
  }
  if (isModelRefusal(raw)) {
    // Its own outcome: not a reply the guard refused, not a failure to answer.
    return { ...base, reply: refusalLine(facts, channel), source: "refusal" };
  }
  const answer = parseModelAnswer(raw);
  const merged = mergeCapture(capture, answer.booking);
  const verdict = guardAssistantReply(answer.reply, facts, NO_BOOKING_WRITTEN);
  if (!verdict.ok) {
    return { ...base, capture: merged, handoff: answer.handoff, reply: guardedLine(verdict.reason, facts.clinicName), source: "guard", guard: verdict.reason };
  }
  return { ...base, capture: merged, handoff: answer.handoff, end: answer.end, reply: answer.reply, source: "model" };
}
