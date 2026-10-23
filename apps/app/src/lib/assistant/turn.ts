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
import { log } from "@/lib/log";
import { formatPhone } from "@/lib/setup/help";
import { spokenPhone, type SpokenLanguage } from "@/lib/voice/spoken";

import {
  EMPTY_TOOL_STATE,
  parseToolAction,
  toolTurnContext,
  type BookingTools,
  type BookingToolState,
  type ToolAction,
  type ToolTurn,
} from "./booking-tools";
import type { AssistantChannel, AssistantFacts } from "./facts";
import { cardNumberIn, guardAssistantReply, guardedLine, movingOnLine, type GuardRefusal } from "./guard";
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
 *      Spanish, with 911 and the clinic's number, and never the model. When
 *      the urgent screen reads urgent words in it (its French, German,
 *      Italian and Portuguese fragments), the turn is urgent as well, so
 *      the adapter alerts the clinic whatever the language.
 *      Neither it nor an urgent message reaches the model on a later turn
 *      either: the history the model is sent is screened again
 *      (messagesFor, screenedBeforeModel).
 *   4. Otherwise the model answers from the clinic's facts, as one JSON
 *      object, and the guard (guard.ts) reads its reply; a refused reply is
 *      replaced by a fixed line. A model that declines to answer at all (a
 *      refusal) gets its own fixed line and its own source, "refusal",
 *      never the guard's.
 *
 * The model writes nothing: what it collects for a booking request is
 * returned as a capture, cleaned, and the adapter decides what to do with it
 * (the post-call ingest for a call, the request writer for a chat). A model
 * that fails, times out, passes our own deadline (MODEL_DEADLINE_MS) or
 * answers with JSON that does not parse gives the fixed failure line, never
 * silence and never its raw text.
 *
 * Where the adapter passes the booking tool layer (booking-tools.ts) and it
 * is live this turn, the model may also ask for an action (free times, or
 * the time chosen). The tool layer runs the booking engine, and when it
 * answers, its fixed line is said instead of the model's words: the tool's
 * result, never the model, decides what is said about a booking. A reply of
 * the model's own that says a booking is made is refused on every turn
 * (guard.ts, confirmsBooking), because only the tool layer's line may say it.
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

export type TurnSource = "model" | "urgent" | "guard" | "card" | "fallback" | "refusal" | "language" | "tool";

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
  /** The tool layer's state after the turn: what to pass back on the next. */
  toolState: BookingToolState;
  /** The tools were offered to the model on this turn: the tool layer, not the adapter, takes any booking. */
  toolsLive: boolean;
  /** What the tool layer did, when it answered the turn. */
  tool: ToolTurn | null;
  /** On a call, the line the caller is put through to as the reply ends: an urgent turn's (urgentTransferTo). */
  transferTo?: string | null;
};


/**
 * What the guard is told of the model's own words: never that a booking was
 * written. Only the tool layer's fixed line may say that (booking-tools.ts),
 * and it is said in place of the model's reply, so the model's reply is
 * always read as written on a turn that booked nothing.
 */
const NO_BOOKING_WRITTEN = { bookingWritten: false } as const;

export const FAILURE_LINE =
  "Sorry, I'm having trouble on my end. Please try again in a moment, or contact the practice directly.";

/** FAILURE_LINE for a call the caller has taken into Spanish (lib/voice/call-language.ts). */
export const FAILURE_LINE_ES =
  "Lo siento, estoy teniendo problemas de mi lado. Inténtelo de nuevo en un momento, o comuníquese directamente con la clínica.";

/** The failure line in a call's language: English unless the call is in Spanish. */
export function failureLine(language: SpokenLanguage = "en"): string {
  return language === "es" ? FAILURE_LINE_ES : FAILURE_LINE;
}

/**
 * Our own wall-clock bound on one model answer, per channel, beside the
 * SDK's (responder.ts, MODEL_CONFIG): a responder that never settles, or
 * an SDK whose timeout and retries add up past what the person can wait,
 * still ends the turn with the failure line. On a call, a second under the
 * SDK's 8 seconds, so the caller hears the line on our clock and the
 * adapter's second failure transfers them (retell.ts). On the web chat,
 * past the SDK's 30 seconds but short of its one retry's full minute.
 * answerTurn takes another through `modelDeadlineMs`.
 */
export const MODEL_DEADLINE_MS: Readonly<Record<AssistantChannel, number>> = {
  voice: 7_000,
  web_chat: 40_000,
};

class ModelDeadline extends Error {}

/** The responder's answer, or ModelDeadline once `ms` pass; the timer never outlives the turn. */
async function withinDeadline<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ModelDeadline()), ms);
  });
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function numberFor(channel: AssistantChannel, e164: string | null, language: SpokenLanguage = "en"): string | null {
  if (!e164) return null;
  return channel === "voice" ? spokenPhone(e164, language) : formatPhone(e164);
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
  language: SpokenLanguage = "en",
): string | null {
  if (channel !== "voice") return numberFor(channel, facts.urgentPhone ?? facts.phone);
  const number = [facts.urgentPhone, facts.directLine].find((n) => n && n !== facts.phone) ?? null;
  return numberFor(channel, number, language);
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
 * the team" only while an urgent alert would reach the clinic
 * (facts.urgentAlertsReady, read by assistantFacts); otherwise the same
 * fixed lines without it: 911 (or the emergency vet) and the number that
 * reaches a person. On a call, the numbers are spoken in the reply's own
 * language: Spanish digits in the Spanish reply.
 */
export function urgentReply(
  facts: ReplyFacts & Partial<Pick<AssistantFacts, "specialty" | "urgentAlertsReady">>,
  channel: AssistantChannel,
  finding: Pick<UrgentFinding, "emergency"> & Partial<Pick<UrgentFinding, "language">>,
  now: Date,
  /** On a call, the caller is being put through to the practice as this is said (answerTurn, urgentTransferTo). */
  transferring = false,
): string {
  const language = finding.language ?? "en";
  return fixedUrgentReply({
    transferring,
    channel,
    emergency: finding.emergency,
    language,
    veterinary: urgentSetFor(facts.specialty) === "veterinary",
    clinicName: facts.clinicName,
    clinicNumber: personNumber(facts, channel, language),
    referralNumber: numberFor(channel, facts.vetReferralPhone, language),
    clinicOpen: openNow(facts, now),
    teamAlerted: facts.urgentAlertsReady === true,
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
  language: SpokenLanguage = "en",
): string {
  const number = channel === "voice" ? personNumber(facts, channel, language) : numberFor(channel, facts.phone ?? facts.urgentPhone);
  if (language === "es") {
    return (
      `Lo siento, eso no es algo con lo que pueda ayudarle. ` +
      (number
        ? `El equipo de ${facts.clinicName} sí puede: por favor, llámelos al ${number}.`
        : `El equipo de ${facts.clinicName} puede ayudarle, y responde en un plazo de un día.`)
    );
  }
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
const CARD_LINE_ES = "Por favor, no me dé datos de tarjeta: dejé ese número fuera. La clínica gestiona los pagos de forma segura.";

/**
 * What the model is told on a turn of a call being spoken in Spanish, after
 * the cached prefix (assistantTurnContext): the prefix itself is unchanged,
 * byte for byte, for every call.
 */
export const SPANISH_CALL =
  "The caller is speaking Spanish: answer in Spanish, using \"usted\", and say numbers, prices, days and times the way a Spanish speaker says them aloud. A caller who says \"representante\" is asking for a person.";

const MAX_TEXT = 2_000;
const MAX_FIELD = 120;

function clean(value: unknown, max = MAX_FIELD): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text.length > 0 ? text : null;
}

type ModelAnswer = {
  reply: string;
  booking: Partial<BookingCapture>;
  handoff: boolean;
  end: boolean;
  action: ToolAction | null;
  /**
   * The text began an object that does not parse: a reply cut off at the
   * token limit, or JSON the model got wrong. Its words are never sent (they
   * may hold the booking object, braces and field names); answerTurn gives
   * the failure line instead.
   */
  malformed?: true;
};

/**
 * Whether text that did not parse was meant as the JSON object: it has a
 * brace, or names the reply field. Plain prose with neither is read as the
 * reply itself, as it always was.
 */
function meantAsJson(raw: string): boolean {
  return raw.includes("{") || /"reply"\s*:/.test(raw);
}

/**
 * The model's JSON, read leniently: the first object in the text, or plain
 * prose (no brace, no reply field) as the reply. Text that meant to be the
 * object and does not parse is malformed, with no reply.
 */
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
        action: parseToolAction(parsed.action),
      };
    } catch {
      // not an object: malformed, below
    }
  }
  if (meantAsJson(raw)) return { reply: "", booking: {}, handoff: false, end: false, action: null, malformed: true };
  return { reply: clean(raw, MAX_TEXT) ?? "", booking: {}, handoff: false, end: false, action: null };
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

/**
 * What the model reads in place of an earlier message the screens answered
 * before it: never the message's words. The fixed line that answered it
 * stays, so the model does not contradict it.
 */
export const SCREENED_TURN =
  "(This message was answered by the practice's fixed line for urgent messages or a language the assistant cannot read, so its words are not shown to you. Do not ask what it said.)";

/**
 * Whether the screens answer this message before the model, as answerTurn
 * does on the turn it comes in: a complication or an urgent symptom, or a
 * language no screen reads. Asked again of every earlier turn each time the
 * model is called (messagesFor), so a message the model was never shown is
 * never shown to it on a later turn either.
 */
export function screenedBeforeModel(
  text: string,
  facts: Pick<AssistantFacts, "specialty" | "clinicName" | "address" | "services"> & Partial<Pick<AssistantFacts, "providerNames">>,
): boolean {
  if (findUrgentContent(text, facts.specialty, { clinicName: facts.clinicName })) return true;
  return messageLanguage(text, { knownTerms: languageTerms(facts) }) === "other";
}

/**
 * The conversation as the model sees it: alternating, starting with the
 * person. An earlier message of the person's that `screened` says the
 * screens answered is replaced by SCREENED_TURN (spec, "Guardrails": the
 * match happens before the model sees the message, and short-circuits the
 * model entirely). The history itself keeps it, for the transcript the
 * clinic is sent.
 */
export function messagesFor(
  history: readonly TranscriptTurn[],
  personText: string,
  screened: (text: string) => boolean = () => false,
): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  for (const turn of history) push(out, turn.speaker, turn.speaker === "person" && screened(turn.text) ? SCREENED_TURN : turn.text);
  push(out, "person", personText);
  return out;
}

function push(out: AssistantMessage[], speaker: TranscriptTurn["speaker"], text: string): void {
  const role = speaker === "person" ? "user" : "assistant";
  if (out.length === 0 && role === "assistant") return; // the opening line is in the system prompt
  const last = out[out.length - 1];
  if (last && last.role === role) last.content = `${last.content}\n${text}`;
  else out.push({ role, content: text });
}

/** The last thing the assistant said, or null before it has spoken. */
function lastAssistantLine(history: readonly TranscriptTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i]!.speaker === "assistant") return history[i]!.text;
  return null;
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
  /** The booking tool layer, for a channel that books; absent, the turn takes requests only. */
  tools?: BookingTools | null;
  toolState?: BookingToolState;
  /** A call's caller id, for a booking whose caller gave no other number. */
  callerPhone?: string | null;
  /** Our own bound on the model's answer; MODEL_DEADLINE_MS for the channel when absent. */
  modelDeadlineMs?: number;
  /**
   * The block for a call back after a call that was cut off (lib/voice/redial.ts),
   * in the turn context after the cached prefix. The screens above run first
   * on this call's words as on any other.
   */
  resumed?: string | null;
  /**
   * The language a call is being spoken in (lib/voice/call-language.ts),
   * which picks the fixed lines: the failure, card, refusal and booking
   * lines, and the spoken digits. English when absent, as it always was;
   * the website chat never passes one.
   */
  language?: SpokenLanguage;
  /**
   * On a call, a line that reaches a person at the practice, already checked
   * by the adapter not to forward back to us (lib/voice/fallback-line.ts,
   * usableLine). An urgent turn at a practice for people puts the caller
   * through to it, after the fixed reply's 911 line (owner, 23 October
   * 2026); without one the reply is 911 alone.
   */
  urgentTransferTo?: string | null;
}): Promise<AssistantTurnResult> {
  const { facts, channel } = input;
  const language: SpokenLanguage = input.language ?? "en";
  const capture = input.capture ?? EMPTY_CAPTURE;
  const toolState = input.toolState ?? EMPTY_TOOL_STATE;
  const card = cardNumberIn(input.text.slice(0, MAX_TEXT));
  const personText = card.text;
  const base = { personText, capture, handoff: false, end: false, urgent: false, toolState, toolsLive: false, tool: null };

  const now = input.now ?? new Date();
  const finding = findUrgentContent(personText, facts.specialty, { clinicName: facts.clinicName });
  if (finding?.otherLanguage) {
    // Urgent words in a language the assistant does not answer in (French,
    // German, Italian, Portuguese): the line for another language, in
    // English and Spanish with 911 and the number, as any message in it
    // gets; and urgent, so the adapter alerts the clinic as for any urgent
    // hit. Until 21 October 2026 such a message was only "language", and no
    // alert was queued.
    return { ...base, reply: languageLine(facts, channel), source: "language", urgent: true };
  }
  if (finding) {
    const transferTo =
      channel === "voice" && input.urgentTransferTo && urgentSetFor(facts.specialty) !== "veterinary" ? input.urgentTransferTo : null;
    return {
      ...base,
      reply: urgentReply(facts, channel, finding, now, transferTo !== null),
      source: "urgent",
      urgent: true,
      ...(transferTo ? { transferTo } : {}),
    };
  }
  if (card.found) {
    return { ...base, reply: language === "es" ? CARD_LINE_ES : CARD_LINE, source: "card" };
  }
  // A language the screens cannot read: no model, a fixed line in English and Spanish.
  // Not urgent, so no clinic alert: the language alone raises none. That is
  // the owner's default until answered (H4, 21 October 2026, open question
  // 1); urgent words the screen can read in it alert, as above.
  if (messageLanguage(personText, { knownTerms: languageTerms(facts) }) === "other") {
    return { ...base, reply: languageLine(facts, channel), source: "language" };
  }
  if (!input.responder) {
    return { ...base, reply: failureLine(language), source: "fallback" };
  }

  // Asked fresh each turn: a switch pulled or a connection that broke since
  // the last turn takes the tools away from this one.
  const toolsLive = Boolean(input.tools) && !toolState.manual && !toolState.done && (await input.tools!.available());
  const opening = input.history.find((t) => t.speaker === "assistant")?.text;
  const system = {
    stable: buildAssistantPrompt(facts, channel, { bookingTools: toolsLive }),
    turn: assistantTurnContext(facts, now, opening, toolsLive ? toolTurnContext(toolState, facts.timeZone) : null, input.resumed ?? null, language === "es" ? SPANISH_CALL : null),
  };
  let raw: Awaited<ReturnType<AssistantResponder>>;
  try {
    const answer = input.responder({
      system,
      messages: messagesFor(input.history, personText, (text) => screenedBeforeModel(text, facts)),
      channel,
    });
    raw = await withinDeadline(answer, input.modelDeadlineMs ?? MODEL_DEADLINE_MS[channel]);
  } catch (error) {
    if (error instanceof ModelDeadline) log.warn("model answer past its deadline", { channel, kind: "deadline" });
    return { ...base, reply: failureLine(language), source: "fallback" };
  }
  if (isModelRefusal(raw)) {
    // Its own outcome: not a reply the guard refused, not a failure to answer.
    return { ...base, reply: refusalLine(facts, channel, language), source: "refusal" };
  }
  const answer = parseModelAnswer(raw);
  if (answer.malformed) {
    // A failure to answer, like a throw: the fixed line, never the raw text,
    // and nothing it held is captured. Logged by kind, never with the text.
    log.warn("model answer not valid JSON", { channel, kind: "malformed" });
    return { ...base, reply: failureLine(language), source: "fallback" };
  }
  const merged = mergeCapture(capture, answer.booking);
  const live = { ...base, toolsLive };
  if (toolsLive && !answer.handoff) {
    // The tool layer, on what the model asked for and what is now known.
    const tool = await input.tools!.run({
      action: answer.action,
      capture: merged,
      state: toolState,
      callerPhone: input.callerPhone ?? null,
      now,
      ...(input.language ? { language: input.language } : {}),
    });
    if (tool) {
      return { ...live, capture: merged, toolState: tool.state, tool, reply: tool.reply, source: "tool" };
    }
  }
  const verdict = guardAssistantReply(answer.reply, facts, NO_BOOKING_WRITTEN);
  if (!verdict.ok) {
    // The fixed line in the language of the reply it replaces, Spanish only
    // where that reply (or, for a reply in no screened language, the person)
    // was Spanish, or where the call is being spoken in Spanish; English
    // otherwise, as it always was.
    const said = messageLanguage(answer.reply, { knownTerms: languageTerms(facts) });
    const spanish =
      language === "es" || said === "es" || (said === "other" && messageLanguage(personText, { knownTerms: languageTerms(facts) }) === "es");
    const line = guardedLine(verdict.reason, facts.clinicName, spanish ? "es" : "en");
    // The same refusal as the last thing said: the person answered it ("yes,
    // please") and the model's next try was refused again. Saying it a third
    // time is a loop (test call of 23 October 2026), so the turn hands over.
    if (lastAssistantLine(input.history) === line) {
      return { ...live, capture: merged, handoff: true, reply: movingOnLine(facts.clinicName, spanish ? "es" : "en"), source: "guard", guard: verdict.reason };
    }
    return { ...live, capture: merged, handoff: answer.handoff, reply: line, source: "guard", guard: verdict.reason };
  }
  return { ...live, capture: merged, handoff: answer.handoff, end: answer.end, reply: answer.reply, source: "model" };
}
