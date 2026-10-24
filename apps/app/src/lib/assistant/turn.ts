import {
  findUrgentContent,
  fixedUrgentReply,
  messageLanguage,
  otherLanguageReply,
  urgentSetFor,
  type UrgentFinding,
} from "@healdesk/catalog";

import { openGiven } from "@/lib/clinic/closures";
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
import { assistantTurnContext, buildAssistantPrompt, SPOKEN_END } from "./prompt";
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
  /**
   * On a call that spoke the reply as it was written (`speak`), the words
   * already said, each sentence passed by the guard: `reply` starts with
   * them, and the adapter sends only the rest.
   */
  spoken?: string;
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
> &
  Partial<Pick<AssistantFacts, "closures">>;

/** Whether the practice is open now: its weekly hours, and shut on a closed day (openGiven). */
export function openNow(
  facts: Pick<AssistantFacts, "openingHours" | "timeZone"> & Partial<Pick<AssistantFacts, "closures">>,
  now: Date,
): boolean | null {
  try {
    return openGiven(
      facts.openingHours,
      (facts.closures ?? []).map((c) => c.closedOn),
      now,
      facts.timeZone,
    );
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
 * A call's answer split into its words and its details: at the delimiter, or,
 * for an answer that forgot it, at an object after the words that has no
 * "reply" of its own. Null for an answer in the JSON form (it starts with a
 * brace) or plain prose.
 */
function spokenParts(raw: string): { words: string; details: string } | null {
  const at = raw.indexOf(SPOKEN_END);
  if (at >= 0 && !raw.slice(0, at).trimStart().startsWith("{")) {
    return { words: clean(raw.slice(0, at), MAX_TEXT) ?? "", details: raw.slice(at + SPOKEN_END.length) };
  }
  const brace = raw.indexOf("{");
  if (brace > 0 && raw.slice(0, brace).trim() && !/"reply"\s*:/.test(raw)) {
    return { words: clean(raw.slice(0, brace), MAX_TEXT) ?? "", details: raw.slice(brace) };
  }
  return null;
}

/** The details object of a call's answer, read as the JSON form's fields are; anything unreadable is nothing. */
function detailsOf(text: string): Omit<ModelAnswer, "reply"> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { booking: {}, handoff: false, end: false, action: null };
  try {
    const { reply: _reply, ...rest } = parseModelAnswer(text.slice(start, end + 1));
    return rest.malformed ? { booking: {}, handoff: false, end: false, action: null } : rest;
  } catch {
    return { booking: {}, handoff: false, end: false, action: null };
  }
}

/**
 * The words of a call's answer, cut into sentences as the model writes them
 * (owner, 24 October 2026: a caller waited for the whole reply before hearing
 * a word). Each complete sentence goes to `onSentence`, which guards and says
 * it; the words still being written stay here until a sentence ends or the
 * delimiter arrives, which ends the words and sends what is left. An answer
 * that opens with a brace is the JSON form and is never spoken as it comes.
 */
/** Words a spoken piece needs before it goes out on its own: shorter ones ("Sure!") wait for the next. */
const MIN_SPOKEN_WORDS = 4;

export class SpokenStream {
  private text = "";
  private consumed = 0;
  /** A sentence too short to judge alone ("Mm-hmm."), held to go out with the next. */
  private held = "";
  private mode: "unknown" | "words" | "json" = "unknown";
  private ended = false;
  /** How many deltas arrived: none means the responder did not stream. */
  received = 0;

  constructor(private readonly onSentence: (sentence: string) => void) {}

  push(delta: string): void {
    this.received += 1;
    this.text += delta;
    if (this.mode === "unknown") {
      const start = this.text.trimStart();
      if (!start) return;
      this.mode = start.startsWith("{") ? "json" : "words";
    }
    if (this.mode !== "words" || this.ended) return;
    const at = this.text.indexOf(SPOKEN_END);
    if (at >= 0) {
      this.ended = true;
      this.emit(this.text.slice(this.consumed, at), true);
      this.consumed = at;
      return;
    }
    // A "#" at the end may be the delimiter arriving: it waits.
    const words = this.text.replace(/#+$/, "");
    const pending = words.slice(this.consumed);
    let cut = -1;
    for (const m of pending.matchAll(/[.!?…]["'’”)\]]*(?=\s)/g)) cut = m.index! + m[0].length;
    if (cut > 0) {
      this.emit(pending.slice(0, cut));
      this.consumed += cut;
    }
  }

  /** Whether any of the words have been handed out as they came. */
  get streamed(): boolean {
    return this.mode === "words" && this.received > 0;
  }

  /** The words written after the last sentence handed out: the end of the reply, said with the turn's last part. */
  remainder(): string {
    if (this.mode !== "words") return "";
    const at = this.text.indexOf(SPOKEN_END);
    return clean(`${this.held} ${this.text.slice(this.consumed, at >= 0 ? at : undefined)}`, MAX_TEXT) ?? "";
  }

  /** Out with a sentence, or held with the next while it is under MIN_SPOKEN_WORDS; `last` sends whatever is held. */
  private emit(chunk: string, last = false): void {
    const sentence = clean(`${this.held} ${chunk}`, MAX_TEXT);
    this.held = "";
    if (!sentence) return;
    if (!last && sentence.split(" ").length < MIN_SPOKEN_WORDS) {
      this.held = sentence;
      return;
    }
    this.onSentence(sentence);
  }
}

/**
 * The model's JSON, read leniently: the first object in the text, or plain
 * prose (no brace, no reply field) as the reply. Text that meant to be the
 * object and does not parse is malformed, with no reply.
 */
export function parseModelAnswer(raw: string): ModelAnswer {
  // A call's answer: the words, the delimiter, then the details (prompt.ts,
  // spokenFirst). The words are the reply, read by the guard as any reply;
  // details that do not parse are dropped, never spoken.
  const spoken = spokenParts(raw);
  if (spoken) {
    const details = detailsOf(spoken.details);
    if (!spoken.words) return { reply: "", booking: {}, handoff: false, end: false, action: null, malformed: true };
    return { ...details, reply: spoken.words };
  }
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
  // An object that does not parse whole (a stray quote, a cut-off booking
  // object) whose "reply" string is still intact: that string, alone, and
  // nothing else it held. The guard reads it as any reply. Until 24 October
  // 2026 the caller heard the failure line for these.
  const replyOnly = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (replyOnly) {
    try {
      const reply = clean(JSON.parse(`"${replyOnly[1]}"`), MAX_TEXT);
      if (reply) return { reply, booking: {}, handoff: false, end: false, action: null };
    } catch {
      // not a JSON string: malformed, below
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

/** Words a sentence needs before saying it twice counts as repeating it: "Okay." or "Got it." may come back. */
const REPEAT_MIN_WORDS = 3;

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?…]["'’”)\]]*)\s+/).filter((s) => s.trim());
const sameWords = (sentence: string): string =>
  sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/**
 * `text` without any sentence already said in `said`, or twice in `text`
 * itself (owner, 24 October 2026: "she should never repeat the same sentence
 * twice in a row"). The prompt asks for it too; this holds it whatever the
 * model writes. A call reads `said` as the turn before and what this turn has
 * already spoken. A sentence of a word or two may repeat. Empty when every
 * sentence is a repeat: the caller decides what to say then.
 */
export function withoutRepeats(text: string, said: readonly string[]): string {
  const seen = new Set(said.flatMap(sentencesOf).map(sameWords).filter((s) => s.split(" ").length >= REPEAT_MIN_WORDS));
  const kept: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const words = sameWords(sentence);
    if (words.split(" ").length >= REPEAT_MIN_WORDS) {
      if (seen.has(words)) continue;
      seen.add(words);
    }
    kept.push(sentence.trim());
  }
  return kept.join(" ");
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
  /**
   * On a call, a short fixed acknowledgement ("Okay.", "Sure.") the adapter
   * says out loud the moment the turn goes to the model, so the caller hears
   * no dead air while it thinks (owner, 24 October 2026). `say` is called
   * once, after every screen has passed and just before the model is asked,
   * so nothing is said ahead of an urgent, card or language line; the model
   * is told it was said, so it does not start with another.
   */
  acknowledge?: { line: string; say: () => void } | null;
  /**
   * On a call, what the caller heard of the last reply when they cut in
   * (lib/voice/retell.ts reads it from Retell's transcript): the model is
   * told, so it yields and does not repeat what they talked over.
   */
  interruptedAt?: string | null;
  /**
   * On a call, say a sentence now (owner, 24 October 2026). When given, and
   * the booking tools are not live this turn, the answer is spoken as it is
   * written: each sentence, once the guard has passed it alone, goes here;
   * the first one the guard refuses is replaced by its fixed line and
   * nothing after it is said. The result's `spoken` is what went out.
   */
  speak?: ((sentence: string) => void) | null;
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
  const notes: string[] = [];
  if (input.interruptedAt) {
    notes.push(
      `The caller cut in while you were speaking; they heard only: "${input.interruptedAt}". Answer what they just said, and do not repeat what they talked over unless they ask.`,
    );
  }
  if (input.acknowledge) {
    notes.push(`You have already said "${input.acknowledge.line}" out loud at the start of this reply: carry straight on from it, without another acknowledgement or filler.`);
  }
  const system = {
    stable: buildAssistantPrompt(facts, channel, { bookingTools: toolsLive }),
    turn: assistantTurnContext(
      facts,
      now,
      opening,
      toolsLive ? toolTurnContext(toolState, facts.timeZone) : null,
      input.resumed ?? null,
      language === "es" ? SPANISH_CALL : null,
      notes,
    ),
  };
  // Every screen has passed and the model is next: the acknowledgement goes now.
  input.acknowledge?.say();
  // Spoken as written, sentence by sentence, each through the guard alone.
  // Not while the tools are live: their fixed line may replace the words.
  const spoken: string[] = [];
  let refusedMidway: GuardRefusal | null = null;
  // Words the language check could not place yet ("Mm-hmm. Got it."): they
  // wait for the next sentence, and are judged with it or with the end.
  let unplaced = "";
  // On a call, nothing said in the turn before is said again (withoutRepeats).
  const before = channel === "voice" ? [lastAssistantLine(input.history) ?? ""] : null;
  const fresh = (text: string) => (before ? withoutRepeats(text, [...before, ...spoken]) : text);
  const stream =
    input.speak && !toolsLive
      ? new SpokenStream((sentence) => {
          if (refusedMidway) return;
          const piece = fresh([unplaced, sentence].filter(Boolean).join(" "));
          if (!piece) {
            unplaced = "";
            return;
          }
          // Read with everything already said, so a rule that needs the
          // sentence before it (a question asked back, the reply's language)
          // reads it as the whole reply would; what came before has passed.
          const verdict = guardAssistantReply([saidSoFar(), piece].filter(Boolean).join(" "), facts, NO_BOOKING_WRITTEN);
          if (!verdict.ok && verdict.reason === "language") {
            unplaced = piece;
            return;
          }
          unplaced = "";
          if (!verdict.ok) {
            refusedMidway = verdict.reason;
            return;
          }
          spoken.push(piece);
          input.speak!(piece);
        })
      : null;
  const saidSoFar = () => spoken.join(" ");
  let raw: Awaited<ReturnType<AssistantResponder>>;
  try {
    const answer = input.responder({
      system,
      messages: messagesFor(input.history, personText, (text) => screenedBeforeModel(text, facts)),
      channel,
      ...(stream ? { onText: (delta: string) => stream.push(delta) } : {}),
    });
    raw = await withinDeadline(answer, input.modelDeadlineMs ?? MODEL_DEADLINE_MS[channel]);
  } catch (error) {
    if (error instanceof ModelDeadline) log.warn("model answer past its deadline", { channel, kind: "deadline" });
    // Words already said stand: the turn ends on them rather than taking them back.
    if (spoken.length > 0) return { ...base, reply: saidSoFar(), spoken: saidSoFar(), source: "model" };
    return { ...base, reply: failureLine(language), source: "fallback" };
  }
  if (isModelRefusal(raw)) {
    // Its own outcome: not a reply the guard refused, not a failure to answer.
    const line = refusalLine(facts, channel, language);
    if (spoken.length > 0) return { ...base, reply: `${saidSoFar()} ${line}`, spoken: saidSoFar(), source: "refusal" };
    return { ...base, reply: line, source: "refusal" };
  }
  const answer = parseModelAnswer(raw);
  if (stream?.streamed && (spoken.length > 0 || refusedMidway)) {
    // The words went out as they came: what is left is the end of the reply,
    // guarded on its own, or the fixed line for the sentence the guard refused.
    const merged = mergeCapture(capture, answer.booking);
    const rest = refusedMidway ? null : fresh([unplaced, stream.remainder()].filter(Boolean).join(" "));
    const restVerdict = rest ? guardAssistantReply([saidSoFar(), rest].filter(Boolean).join(" "), facts, NO_BOOKING_WRITTEN) : null;
    const reason: GuardRefusal | null = refusedMidway ?? (restVerdict && !restVerdict.ok ? restVerdict.reason : null);
    const tail = reason ? guardedLine(reason, facts.clinicName, language === "es" ? "es" : "en") : (rest ?? "");
    const reply = [saidSoFar(), tail].filter(Boolean).join(" ");
    // The guard read each sentence alone; read the whole once more, so a rule
    // that only a whole reply breaks is at least seen. Kind only, never words.
    const whole = guardAssistantReply(reply, facts, NO_BOOKING_WRITTEN);
    if (!reason && !whole.ok) log.warn("streamed reply refused whole after its sentences passed", { channel, kind: whole.reason });
    return {
      ...base,
      toolsLive,
      capture: merged,
      handoff: answer.handoff,
      end: reason ? false : answer.end,
      reply,
      spoken: saidSoFar(),
      source: reason ? "guard" : "model",
      ...(reason ? { guard: reason } : {}),
    };
  }
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
  // A reply that only repeats the turn before is said as written: silence would be worse.
  const replyText = (before && fresh(answer.reply)) || answer.reply;
  const verdict = guardAssistantReply(replyText, facts, NO_BOOKING_WRITTEN);
  if (!verdict.ok) {
    // The fixed line in the language of the reply it replaces, Spanish only
    // where that reply (or, for a reply in no screened language, the person)
    // was Spanish, or where the call is being spoken in Spanish; English
    // otherwise, as it always was.
    const said = messageLanguage(replyText, { knownTerms: languageTerms(facts) });
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
  return { ...live, capture: merged, handoff: answer.handoff, end: answer.end, reply: replyText, source: "model" };
}
