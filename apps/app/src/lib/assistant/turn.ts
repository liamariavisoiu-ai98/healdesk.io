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
import type { PaymentTextTools } from "@/lib/sms/payment-text";
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
import { cardNumberIn, guardAssistantReply, guardedLine, movingOnLine, routedAgainLine, routingProvider, type GuardRefusal } from "./guard";
import { holdLine, lookupLine, pause, writeLine } from "@/lib/voice/pauses";

import { pairingFor } from "./pairings";

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
  /** The model's structured update for the adapter (ModelAnswer.state), when its answer carried one. */
  state?: Record<string, unknown> | null;
};


/**
 * What the guard is told of the model's own words: never that a booking was
 * written. Only the tool layer's fixed line may say that (booking-tools.ts),
 * and it is said in place of the model's reply, so the model's reply is
 * always read as written on a turn that booked nothing.
 */
const NO_BOOKING_WRITTEN = { bookingWritten: false } as const;

export const FAILURE_LINE =
  "I can't get to that right now. Please try again in a moment, or contact the practice directly.";

/** FAILURE_LINE for a call the caller has taken into Spanish (lib/voice/call-language.ts). */
export const FAILURE_LINE_ES =
  "Ahora mismo no puedo con eso. Inténtelo de nuevo en un momento, o comuníquese directamente con la clínica.";

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
      `Eso no es algo con lo que pueda ayudarle. ` +
      (number
        ? `El equipo de ${facts.clinicName} sí puede: por favor, llámelos al ${number}.`
        : `El equipo de ${facts.clinicName} puede ayudarle, y responde en un plazo de un día.`)
    );
  }
  return (
    `That's not something I can help with. ` +
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
  facts: Pick<AssistantFacts, "clinicName" | "address" | "services"> & Partial<Pick<AssistantFacts, "shortName" | "providerNames">>,
): string[] {
  return [facts.clinicName, facts.shortName ?? "", facts.address ?? "", ...facts.services.map((s) => s.name), ...(facts.providerNames ?? [])].filter(
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
   * A structured update the adapter asked for in the details, as an object
   * and nothing else (a demo call's `{"asked", "beats"}`, lib/voice/demo-facts.ts
   * demoStateFrom); the adapter checks every value against its own list.
   */
  state?: Record<string, unknown> | null;
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
    return { words: clean(withoutMood(raw.slice(0, at)), MAX_TEXT) ?? "", details: raw.slice(at + SPOKEN_END.length) };
  }
  const brace = raw.indexOf("{");
  if (brace > 0 && raw.slice(0, brace).trim() && !/"reply"\s*:/.test(raw)) {
    return { words: clean(withoutMood(raw.slice(0, brace)), MAX_TEXT) ?? "", details: raw.slice(brace) };
  }
  return null;
}

/**
 * The moods a call's reply may open with (prompt.ts, VOICE_STYLE): one word
 * in square brackets, written before the words, so the reply is written from
 * that feeling rather than decorated with it afterwards (owner, 26 October
 * 2026: "an emotion or a set of emotions established before the response").
 * Never said: it is taken out before the guard reads a word or the caller
 * hears one, and costs the few tokens it takes to write, not a second call.
 */
export const MOODS = ["warm", "cheerful", "excited", "sympathetic", "apologetic", "reassuring", "curious", "playful", "calm", "focused"] as const;

/** The mood at the start of a reply, and any mood tag left anywhere in it, taken out. */
const LEADING_MOOD = /^\s*\[[a-z]{3,14}\]\s*/i;
const ANY_MOOD = new RegExp(`\\s*\\[(?:${MOODS.join("|")})\\]\\s*`, "gi");

/** `text` without its mood tag (MOODS): what is said. */
export function withoutMood(text: string): string {
  return text.replace(LEADING_MOOD, "").replace(ANY_MOOD, " ").trim();
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
/**
 * Where a call's spoken words end: at the delimiter, or at the first brace,
 * whichever comes first. Spoken words never hold a brace; a details object
 * written without the delimiter starts with one (transcript 0a45870b: Aya
 * said `{"state": {...}}` out loud, again and again, after the role-play
 * note asked for booking details in her state).
 */
function wordsEnd(text: string): number {
  const marks = [text.indexOf(SPOKEN_END), text.indexOf("{")].filter((at) => at >= 0);
  return marks.length > 0 ? Math.min(...marks) : -1;
}

/**
 * What may be said or kept as said of a call's text: nothing from a brace, a
 * `"state":` or the delimiter onward. The last line of defence, on every
 * piece sent to Retell and every line of the record, whatever produced it.
 */
export function spokenOnly(text: string): string {
  const at = text.search(/[{}]|"\s*state"\s*:|#{3}/);
  return at < 0 ? text : text.slice(0, at).replace(/[\s,:;"'-]+$/, "");
}

/**
 * A full stop that ends an abbreviation, not a sentence: a title ("Dr.",
 * "Mrs."), an address word ("St.", "Ste.", "Rd."), "No." before a number,
 * "a.m."/"p.m.", "e.g."/"i.e.", "vs." and a single initial ("J."). A
 * sentence that really ends on one ("...on Red Rd.") is only held a little
 * longer and said with the next.
 */
const ABBREVIATION = /(?:^|[\s(])(?:dr|mr|mrs|ms|mx|prof|st|ste|rd|ave|blvd|no|jr|sr|vs|approx|dept|apt)\.$|(?:^|\s)(?:[ap]\.m|e\.g|i\.e)\.$|(?:^|\s)[A-Z]\.$/i;

export function endsWithAbbreviation(text: string): boolean {
  return ABBREVIATION.test(text);
}

/** Words a spoken piece needs before it goes out on its own: shorter ones ("Sure!") wait for the next; "Yep, we do!" goes. */
const MIN_SPOKEN_WORDS = 3;

export class SpokenStream {
  private text = "";
  private consumed = 0;
  /** A sentence too short to judge alone ("Mm-hmm."), held to go out with the next. */
  private held = "";
  private mode: "unknown" | "words" | "json" = "unknown";
  private ended = false;
  /** Whether the mood the words open with (MOODS) has been passed over. */
  private moodRead = false;
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
    if (!this.moodRead) {
      // The mood written first (MOODS) is never said: wait for its "]",
      // then start the words after it.
      const lead = this.text.length - this.text.trimStart().length;
      if (this.text[lead] === "[") {
        const close = this.text.indexOf("]", lead);
        if (close < 0) {
          if (this.text.length - lead <= 20) return;
        } else if (close - lead <= 16) {
          const after = this.text.slice(close + 1);
          this.consumed = close + 1 + (after.length - after.trimStart().length);
        }
      }
      this.moodRead = true;
    }
    const at = wordsEnd(this.text);
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
    for (const m of pending.matchAll(/[.!?…]["'’”)\]]*(?=\s)/g)) {
      // "Dr. Patel" is one name, not two sentences (demo call c4093be6: "that's
      // a question for Dr." was said alone, and the rest of the reply lost).
      if (m[0] === "." && endsWithAbbreviation(pending.slice(0, m.index! + 1))) continue;
      cut = m.index! + m[0].length;
    }
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
    const at = wordsEnd(this.text);
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
        reply: clean(typeof parsed.reply === "string" ? withoutMood(parsed.reply) : parsed.reply, MAX_TEXT) ?? "",
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
        state: parsed.state && typeof parsed.state === "object" && !Array.isArray(parsed.state) ? (parsed.state as Record<string, unknown>) : null,
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
      const reply = clean(withoutMood(String(JSON.parse(`"${replyOnly[1]}"`))), MAX_TEXT);
      if (reply) return { reply, booking: {}, handoff: false, end: false, action: null };
    } catch {
      // not a JSON string: malformed, below
    }
  }
  if (meantAsJson(raw)) return { reply: "", booking: {}, handoff: false, end: false, action: null, malformed: true };
  return { reply: clean(withoutMood(raw), MAX_TEXT) ?? "", booking: {}, handoff: false, end: false, action: null };
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

/**
 * A caller asking to hear it again ("sorry?", "what was that?", "can you
 * speak up?"): the one time a sentence from the turn before may be said
 * again, since that is what they asked for.
 */
const ASKED_AGAIN =
  /^\W*(?:sorry|what|pardon|huh|excuse me|come again|say (?:that|it) again|(?:can|could) you (?:say that again|repeat(?: that)?|speak up)|i (?:can't|cannot|couldn't) hear(?: you)?|speak up|perd[oó]n|c[oó]mo|qu[eé])\b[^.!?]{0,40}[.!?]*\W*$/i;

/**
 * The same ask inside a longer short utterance ("Wait. Wait. What did you
 * say?", "You were telling me about your services"): the owner's test call
 * of 25 October 2026 asked "what did you say?" after a "wait", the reply's
 * repeat of the list was taken out as a repeat, and only "Sorry, let me
 * repeat that." was said, into silence.
 */
const ASKED_AGAIN_WITHIN =
  /\b(?:what did you (?:just )?say|what was that|say (?:that|it) again|(?:can|could) you (?:say that again|repeat)|repeat (?:that|it)|come again|didn'?t (?:catch|hear|get) (?:that|it|you|what you said)|can'?t hear you|you were (?:telling|saying|listing|going through)|go on|keep going|qu[eé] dijo|rep[ií]talo)\b/i;

/** Whether the caller asked to hear the last reply again (ASKED_AGAIN, ASKED_AGAIN_WITHIN). */
export function askedAgain(text: string): boolean {
  return ASKED_AGAIN.test(text) || (text.length <= 120 && ASKED_AGAIN_WITHIN.test(text));
}

/**
 * A caller turning down what was just offered or asked ("no thanks", "not
 * really", "I'm good"): the model is told, so it drops the idea instead of
 * pressing it again in other words (owner, 24 October 2026).
 */
const DECLINED =
  /^\W*(?:no|nope|nah|no thanks|no thank you|not really|not interested|not now|not right now|not today|maybe later|i'?m good|i'?m fine|i'?m okay|i'?ll pass|pass|i don'?t (?:want|need|think so)|that'?s okay|it'?s okay|no,? gracias|no me interesa|ahora no|estoy bien)\b/i;

/**
 * Sounds and one-word verdicts a call's reply opens with out of habit
 * ("Hmm.", "Mm-hmm.", "Ha,", "Right.", "Sure."): the owner's test call of
 * 25 October 2026 heard one, often two, at the start of every reply, on top
 * of the acknowledgement ("the emotions are in a loop and feel
 * repetitive"). Never a word that carries meaning: "Oh no," "Got it," and
 * "Right, that makes sense" stay.
 */
const LEADING_FILLER = /^(?:(?:m+|h+m+|m+-?h+m+|mhm|uh-?huh|u+m+|u+h+|ha(?:ha)*|let(?:'s| me) see|let me (?:check|think|look)|one (?:sec|moment|second))[.,!…]+\s*|(?:right|sure|okay|ok|alright)[.!]+\s+)+/i;

/** `text` without the filler it opens with (LEADING_FILLER); empty when it is nothing else. */
export function withoutLeadingFiller(text: string): string {
  const rest = text.replace(LEADING_FILLER, "");
  if (rest === text) return text;
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "";
}

/** A reply's opening apology ("Sorry, Thomas,", "I'm so sorry,"), with what it opens kept. */
const LEADING_APOLOGY = /^(?:(?:oh|ah|aw+),?\s+)?(?:i'?m\s+)?(?:so\s+|really\s+)?sorry\b(?:\s+about\s+that)?(?:,\s*[a-z]+)?\s*[,.!—–-]+\s*/i;

/**
 * What a call says, shaped where a reminder in the prompt was not enough
 * (test call 72dc66b7: his name in nearly every reply, about twenty times,
 * "I'm sorry, the address is...", and "Talk soon, Thomas!" as he hung up in
 * frustration). Sentence by sentence, so what streams and what is kept as
 * said are shaped alike:
 *   - after the caller's first name was said twice in the call, it is taken
 *     out where it is only a form of address ("Sure, Thomas," to "Sure,");
 *     the "Talk soon, <name>!" sign-off keeps it;
 *   - once the call has had an apology, a reply's opening "Sorry," goes,
 *     unless the reply is nothing else or the stall's warm sorry is due;
 *   - with `noSignOff`, a sentence saying "Talk soon" is left out;
 *   - with `oneQuestion`, a question after the reply's first is left out
 *     (transcript a17b5aff: "What are your patients calling about most? And
 *     how many calls do you get a day?", then "what was your other
 *     question?"); `askedAlready` says the words already said asked one, and a
 *     scripted line's own question (`keepQuestions`) always stays.
 * Words are only ever taken out, so the guard, which reads what is left,
 * screens exactly as it would have.
 */
/** A day or a time said to be open: "Thursday afternoon works", "I have Monday at 11 AM", "we have openings this week". */
const FREE_TIME_SAID =
  /\b(?:openings?|slots?|availability|calendar|schedule)\b[^.?!]{0,60}?\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b|\b(?:we|i)(?:'ve| have) (?:got )?(?:some |a few |an? )?(?:openings?|slots?|availability|times? (?:open|free|available))\b|\b(?:works|is (?:open|free|available)|are (?:open|free|available)|(?:i|we) (?:can (?:do|offer|fit you in)|have)|(?:i|we)'?ve got)\b[^.?!]{0,40}?\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)|noon|morning|afternoon|evening|(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|this week|next week)\b|\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)|morning|afternoon|evening|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b[^.?!]{0,30}?\b(?:works|is (?:open|free|available)|are (?:open|free|available))\b/i;

/** A part of the day a person asked for, as the booking action's window: "evening" from 16:00, "not mornings" from noon. */
export function windowNamedIn(words: string): { after: string | null; before: string | null } {
  const after = /\b(?:after|later than|past)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(a\.?m|p\.?m)?/i.exec(words);
  if (after) {
    const n: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    let h = n[after[1]!.toLowerCase()] ?? Number(after[1]);
    const pm = after[3] ? /^p/i.test(after[3]) : h <= 7;
    if (pm && h < 12) h += 12;
    return { after: `${String(h).padStart(2, "0")}:${after[2] ?? "00"}`, before: null };
  }
  if (/\b(?:not?|don'?t (?:want|like)|can'?t do)\b[^.?!]{0,20}\bmornings?\b/i.test(words)) return { after: "12:00", before: null };
  if (/\b(?:evenings?|after work|end of the day)\b/i.test(words)) return { after: "16:00", before: null };
  if (/\bafternoons?\b/i.test(words)) return { after: "12:00", before: "17:00" };
  if (/\bmornings?\b/i.test(words) && !/\bgood morning\b/i.test(words)) return { after: null, before: "12:00" };
  return { after: null, before: null };
}

/** Whether a reply says a time is free. */
/**
 * A tool line on a call, with the moment a person takes before it (owner, 1
 * November 2026; pauses.ts): a lookup before times, a hold before "I'm holding
 * 3", writing before "you're booked". After words she has already said this
 * turn, they lead into the pause; with nothing said, a short lookup line does,
 * never the same twice in a call. Other tool lines (a detail asked again, one
 * booking per call) are said as they are.
 */
export function withToolMoment(input: {
  line: string;
  kind: "lookup" | "lookupAgain" | "hold" | "write" | null;
  spoken: string;
  day: string | null;
  timeZone: string;
  history: readonly { speaker: string; text: string }[];
  /** The call's language: a Spanish call's lead line is Spanish, as its tool line is. */
  language?: "en" | "es";
}): string {
  if (!input.kind) return input.spoken ? `${input.spoken} ${input.line}` : input.line;
  if (input.spoken) return `${input.spoken} ${pause(input.kind)} ${input.line}`;
  const said = input.history.filter((t) => t.speaker === "assistant").map((t) => t.text);
  const weekday = input.day ? new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, weekday: "long" }).format(new Date(`${input.day}T12:00:00Z`)) : null;
  const es = input.language === "es";
  const lead =
    input.kind === "write" ? writeLine(said, es) : input.kind === "hold" ? holdLine(said, es) : lookupLine(weekday, said, input.kind === "lookupAgain", es);
  return `${lead} ${pause(input.kind)} ${input.line}`;
}

/** Which moment a tool line follows (withToolMoment). */
function toolMoment(tool: { bookingWritten: boolean; state: { chosen: unknown; held: boolean } }, action: { type: string } | null, offeredBefore: boolean): "lookup" | "lookupAgain" | "hold" | "write" | null {
  if (tool.bookingWritten) return "write";
  if (action?.type === "find_times") return offeredBefore ? "lookupAgain" : "lookup";
  // A hold only when one was placed: a time that was never offered is offered again, with no "let me hold that".
  if (action?.type === "choose_time") return tool.state.chosen && tool.state.held ? "hold" : null;
  return null;
}

/**
 * A reply with the sentences that name a free time taken out (claimsFreeTime),
 * for a turn that asked for no times ("Is it always full there?" answered
 * "Not at all, we have openings"): what is left, or a plain line when
 * nothing of substance is.
 */
export function withoutFreeTimeClaims(reply: string): string {
  const kept = reply.split(/(?<=[.!?])\s+/).filter((sentence) => !claimsFreeTime(sentence) || RESTATES_BOOKING.test(sentence)).join(" ").trim();
  return kept.split(/\s+/).filter(Boolean).length > 2 ? kept : "It varies day to day.";
}

/** A sentence that says back their own booking or a time already offered ("I have you down for Thursday at 2"), never a new free time. */
const RESTATES_BOOKING = /\b(?:you down|you in for|you(?:'re| are) (?:booked|all set|in)|your (?:appointment|booking|visit|time)|booked (?:you|for)|(?:the )?(?:first|second|third|last) (?:one|time|option)|(?:i|we) (?:offered|said|mentioned))\b/i;

/** Whether the turn is about a time: they asked for times, named a day, or want to book. */
function aboutATime(personText: string, wants: boolean | undefined, now: Date, timeZone: string, offered = false): boolean {
  return (
    offered ||
    asksForTimes(personText) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)\b(?:\s*(?:a\.?m|p\.?m|o'?clock|thirty|fifteen|forty-five))?/i.test(personText) && /\b(?:a\.?m|p\.?m|o'?clock|noon|thirty|works?|then)\b/i.test(personText) || Boolean(wants) || dayNamedIn(personText, now, timeZone) !== null || /\b(?:morning|afternoon|evening|tonight|tomorrow|today|next week|this week|weekend|\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m))\b/i.test(personText)
  );
}

const HOUR_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, noon: 12 };

/**
 * The one offered time the person named by its hour ("Four PM would work",
 * "the 2 o'clock", "three then"), when exactly one offered time matches it
 * (and its day, when they named one); null otherwise. An hour with no AM or PM
 * is read as a front desk hears it: one to seven in the afternoon.
 */
export function offeredTimeNamed(words: string, offered: readonly { at: string }[], timeZone: string, now: Date): string | null {
  if (offered.length === 0) return null;
  // A time turned down is never taken as picked ("No, 4 doesn't work").
  if (/\b(?:no|not|nope|don'?t|doesn'?t|can'?t|cannot|won'?t|isn'?t|never|other than|instead of|anything but)\b/i.test(words)) return null;
  const m = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon)(?::(\d{2}))?\s*(a\.?m|p\.?m|o'?clock)?\b/i.exec(words);
  if (!m) return null;
  // Said as a time: with AM, PM or o'clock, after "at" or "the", before "works", "then" or "please", or the whole
  // answer a few words long; never a count ("my 2 kids", "3 units").
  const before = words.slice(0, m.index).trim();
  const after = words.slice(m.index + m[0].length).trim();
  const asTime =
    Boolean(m[2] || m[3]) ||
    m[1]!.toLowerCase() === "noon" ||
    /\b(?:at|the|for|around|about)$/i.test(before) ||
    /^(?:works?|is (?:good|fine|great|perfect)|then|please|sounds good|one|slot|option|would (?:work|be (?:good|great|perfect)))\b/i.test(after) ||
    words.trim().split(/\s+/).length <= 4;
  if (!asTime) return null;
  let hour = HOUR_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return null;
  const minute = m[2] ? Number(m[2]) : 0;
  // An hour with no AM or PM, as a front desk hears it: one to seven, and twelve, in the afternoon.
  const pm = m[3] && /^p/i.test(m[3]) ? true : m[3] && /^a/i.test(m[3]) ? false : (hour >= 1 && hour <= 7) || hour === 12;
  if (pm && hour < 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  if (m[1]!.toLowerCase() === "noon") hour = 12;
  const day = dayNamedIn(words, now, timeZone);
  const local = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
  };
  const matches = offered.filter((slot) => {
    const at = local(slot.at);
    return at.hour === hour && at.minute === minute && (!day || at.day === day);
  });
  return matches.length === 1 ? matches[0]!.at : null;
}

/** An occasion the caller mentioned (a wedding, a trip), the word as said; null when none. */
const OCCASION = /\b(wedding|birthday|anniversary|honeymoon|vacation|holiday|trip|graduation|reunion|party|prom|photoshoot|interview|event)\b/i;
export function occasionIn(texts: readonly string[]): string | null {
  for (const text of [...texts].reverse()) {
    const m = OCCASION.exec(text);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}
/** The caller winding the call down: a goodbye, a thank-you, nothing more to ask. */
const WRAPPING_UP = /\b(?:bye|goodbye|that'?s (?:all|it|everything)|nothing else|no,? that'?s (?:all|it)|thanks?,? (?:so much|a lot)?\W*$)/i;
const GOODBYE_SAID = /\b(?:bye|have a (?:great|good|lovely|nice|wonderful)|take care|enjoy)\b/i;

/** The person asks which times are free ("what do you have Thursday?", "anything after five?"), not for a treatment. */
const ASKS_TIMES =
  /\b(?:what|which|any)\s+(?:other\s+)?(?:times?|slots?|openings?|availability|appointments?)\b|\bwhat (?:do|have) you (?:got|have)\b|\bwhat(?:'s| is) (?:open|free|available)\b|\b(?:are|is) (?:you|there) (?:free|open|available|anything)\b|\banything (?:open|available|free)\b|\bavailabilit(?:y|ies)\b/i;

export function asksForTimes(words: string): boolean {
  return ASKS_TIMES.test(words);
}

export function claimsFreeTime(reply: string): boolean {
  return FREE_TIME_SAID.test(reply);
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** The date a person named ("Thursday", "tomorrow"), YYYY-MM-DD in the practice's zone; null when none. */
export function dayNamedIn(words: string, now: Date, timeZone: string): string | null {
  const dateIn = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const weekdayAt = (at: Date) => DAY_NAMES.indexOf(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at).toLowerCase() as (typeof DAY_NAMES)[number]);
  if (/\btomorrow\b/i.test(words)) return dateIn(new Date(now.getTime() + 86_400_000));
  if (/\btoday\b/i.test(words)) return dateIn(now);
  const m = /\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b/i.exec(words);
  if (!m) return null;
  const wanted = DAY_NAMES.findIndex((d) => d.startsWith(m[1]!.toLowerCase().slice(0, 3)));
  for (let k = 1; k <= 7; k += 1) {
    const at = new Date(now.getTime() + k * 86_400_000);
    if (weekdayAt(at) === wanted) return dateIn(at);
  }
  return null;
}

/** "Our most popular", "best-selling", "everyone's favorite": a claim about the practice nobody wrote. */
const POPULARITY = /\b(?:(?:our|the|its|their) most (?:popular|requested|loved|booked)|best[- ]?sell(?:ing|er)|(?:fan|everyone'?s|patients'?|our) favou?rite|everyone loves|most people (?:choose|get|love))\b/i;

/** A price as a sentence says it: "from $6 per unit", "at $950 per syringe", "$199". */
const PRICE_PHRASE = /\s*(?:(?:starting |which (?:is|starts) )?(?:from|at|for|is|are|costs?|starts at)\s+)?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:per|a|an|\/)\s*(?:unit|syringe|vial|session|area|treatment|visit|month)s?)?/gi;

/** A sentence with more than two prices loses the prices and keeps the names (six in one reply on that call). */
function atMostTwoPrices(sentence: string): string {
  const prices = sentence.match(/\$\s?\d/g) ?? [];
  if (prices.length <= 2) return sentence;
  return sentence.replace(PRICE_PHRASE, "").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();
}

/** Short forms a voice reads badly in an address: "Red Rd" is "Red Road". */
const STREET_WORDS: readonly [RegExp, string][] = [
  [/\bRd\b\.?/g, "Road"],
  [/\bAve\b\.?/g, "Avenue"],
  [/\bBlvd\b\.?/g, "Boulevard"],
  [/\bSte\b\.?/g, "Suite"],
  [/\bHwy\b\.?/g, "Highway"],
  [/\bPkwy\b\.?/g, "Parkway"],
  [/\bDr\b\.?(?=,|\s+(?:Suite|Ste|#|\d|,))/g, "Drive"],
  [/\bSt\b\.?(?=,|\s+(?:Suite|Ste|#|\d|,))/g, "Street"],
];

/** Acronyms a voice should say letter by letter: never written as a word. */
const ACRONYMS = new Set(["IPL", "BBL", "PRP", "PRF", "HIFU", "CO2", "MD", "DO", "NP", "PA", "RN", "AM", "PM", "USA", "HIPAA", "FDA", "AI", "LED", "RF", "TCA", "FL", "NY", "CA", "TX"]);

/**
 * A reply made for a voice: no trademark signs; a name in capitals said as a
 * word ("BOTOX" was read letter by letter, as "AYA" was); an address without
 * its state and zip code and with its short forms said in full; and a phone
 * number as a person says it, in groups (a test call of 1 November 2026:
 * "6705 Red Rd, Suite 608, Coral Gables, FL 33143" and "(786) 618-5039").
 */
export function forVoice(text: string): string {
  let out = text.replace(/\s*[®™]/g, "");
  out = out.replace(/\b[A-Z][A-Z0-9]{3,}\b/g, (word) => (ACRONYMS.has(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()));
  out = out.replace(/,?\s*\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g, "");
  for (const [short, full] of STREET_WORDS) out = out.replace(short, full);
  out = out.replace(/(?<![\d$])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g, (_m, a: string, b: string, c: string) => spokenPhone(`+1${a}${b}${c}`));
  return out;
}

export function shapeVoiceReply(
  text: string,
  options: { name: string | null; nameUses: number; nameLimit?: number; apologised: boolean; first: boolean; noSignOff: boolean; oneQuestion?: boolean; askedAlready?: boolean; keepQuestions?: readonly string[]; drop?: RegExp | null },
): string {
  // A trademark sign is never spoken: a voice reads "BOTOX®" as "Botox registered" (demo call a44374c9).
  let out = sentencesOf(forVoice(text)).filter((sentence) => !(options.noSignOff && /\btalk soon\b/i.test(sentence)) && !options.drop?.test(sentence));
  // Never a popularity claim stated as the practice's fact (prompt.ts RECEPTIONIST_MANNER; a test call of 1 November 2026:
  // "Botox is our most popular injectable"), and never more than two prices in one sentence: the names stay, the prices go.
  out = out.filter((sentence) => !POPULARITY.test(sentence)).map(atMostTwoPrices);
  if (options.oneQuestion) {
    let asked = options.askedAlready === true;
    out = out.filter((sentence) => {
      if (!/\?\W*$/.test(sentence)) return true;
      if (options.keepQuestions?.some((line) => line.includes(sentence.trim()))) return true;
      if (asked) return false;
      asked = true;
      return true;
    });
  }
  if (options.name && options.nameUses >= (options.nameLimit ?? 2)) {
    const name = options.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.map((sentence) => {
      if (/\btalk soon\b/i.test(sentence)) return sentence;
      const dropped = sentence
        .replace(new RegExp(`,\\s*${name}(?=\\s*[,.!?])`, "gi"), "")
        .replace(new RegExp(`^${name},\\s*(\\S)`, "i"), (_m, c: string) => c.toUpperCase());
      return dropped.trim() || sentence;
    });
  }
  if (options.first && options.apologised && out.length > 0) {
    const rest = out[0]!.replace(LEADING_APOLOGY, "");
    if (rest && rest !== out[0]) out[0] = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return out.join(" ").trim();
}

/** A dollar figure in what was said: "$199", "199 dollars", "a hundred and ninety-nine dollars". */
const SAID_A_PRICE = /\$\s?\d|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|bucks)\b|\b(?:hundred|thousand|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b[^.?!]{0,30}\b(?:dollars|bucks)\b|\bd[oó]lares\b/i;

/** On a call, the price refusal's line when the turn before quoted a price: never "I don't have a price for that one". */
const PRICE_LINE_AFTER_QUOTE = {
  en: "The team can go through the options and pricing with you at a consultation. Want me to request one?",
  es: "El equipo puede revisar las opciones y los precios con usted en una consulta. ¿Quiere que pase una solicitud?",
} as const;

/**
 * The guard's fixed line for a refusal, as answerTurn says it: guardedLine,
 * but on a call whose last reply quoted a price, a price refusal never says
 * "I don't have a price for that one" (owner's test call, 25 October 2026:
 * Botox and the HydraFacial quoted, "that's a lot", and the next reply,
 * refused for a made-up figure after "I hear you.", ended on it). The guard
 * refuses exactly as before; only the words said in its place differ.
 */
function guardLineFor(
  reason: GuardRefusal,
  clinicName: string,
  language: "en" | "es",
  channel: AssistantChannel,
  history: readonly TranscriptTurn[],
  providerNames?: readonly string[] | null,
): string {
  if (reason === "price" && channel === "voice" && SAID_A_PRICE.test(lastAssistantLine(history) ?? "")) return PRICE_LINE_AFTER_QUOTE[language];
  return guardedLine(reason, clinicName, language, channel === "voice", routingProvider(providerNames));
}

/**
 * The providers a refusal may name (guard.ts, routingProvider): on a demo
 * call only, for now (demo call c4093be6). A clinic's own calls and chats
 * keep the fixed lines the safety suite pins, until the owner decides those
 * name the provider too.
 */
function routedTo(facts: Pick<AssistantFacts, "providerNames"> & Partial<Pick<AssistantFacts, "demoCall">>): readonly string[] | null {
  return facts.demoCall === true ? (facts.providerNames ?? null) : null;
}

/** An answer to the offer ("Yes, please", "Sure"): the loop the hand-over is for. */
const ASSENT = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|sounds good|that'?d be great|that would be great|absolutely|definitely|s[ií]|claro|por favor)\b/i;

/**
 * The provider's line in other words, when the same clinical or price
 * question is asked again rather than the offer answered (routedAgainLine);
 * null when it was answered, or when that line was itself the last thing
 * said: the turn then hands over, as before.
 */
function routedAskedAgain(
  reason: GuardRefusal,
  facts: Pick<AssistantFacts, "providerNames"> & Partial<Pick<AssistantFacts, "demoCall">>,
  personText: string,
  language: "en" | "es",
  channel: AssistantChannel,
  history: readonly TranscriptTurn[],
): string | null {
  if (ASSENT.test(personText)) return null;
  const names = routedTo(facts);
  if (!names) return null;
  const again = routedAgainLine(reason, names, language, channel === "voice");
  return again && !saidLast(history, again) ? again : null;
}

/** Whether `line` is the last thing said, alone or after an acknowledgement. */
function saidLast(history: readonly TranscriptTurn[], line: string): boolean {
  const last = lastAssistantLine(history);
  return last !== null && (last === line || last.endsWith(` ${line}`));
}

/**
 * Said to the model when its reply was refused for a dollar figure not on
 * the list, before it is asked once more (answerTurn). On the owner's test
 * call of 25 October 2026 the caller gave a budget ("roughly five hundred
 * dollars ... what do you suggest?"); each reply said the figure back, the
 * guard refused it, and the caller heard "I don't have a price for that
 * one" three times to a question about what to book.
 */
const PRICE_AGAIN =
  "Your draft reply was not said: it named a dollar amount that is not on the price list. Write it again with no dollar amount at all, not even one the caller said (say \"within your budget\" instead). If they asked for a price that is not listed, offer a consultation where the team can go through it.";

/** Said to the model before its second try on a softRefusal turn (answerTurn), for a refusal other than a price. */
function softAgain(reason: GuardRefusal): string {
  if (reason === "off_script") {
    return `Your draft reply was not said: it talked about how you work behind the scenes (a flow, a prompt, a session, a chat, who you are playing), or claimed something healdesk does not do (texting, not being able to book). You are Aya, on this live demo call with a clinic's owner, and this call is the demo. Write it again in plain words, as yourself, with only what your note says healdesk does.`;
  }
  return `Your draft reply was not said: the safety check read it as ${reason === "clinical" ? "clinical" : reason.replace(/_/g, " ")}. You are talking with a clinic's owner about their own business, not with a patient: write it again in plain words, put the word "calls" right after every number of calls, say no dollar figure except healdesk's own from the list, and nothing about treatments, results or doses.`;
}

/**
 * What a call's reply keeps doing, said to the model each turn from the
 * record itself, not left to the prompt alone (owner's test call, 25 October
 * 2026): the same openers, "sorry" again and again, and the caller's name in
 * nearly every reply.
 */
export function voiceHabits(history: readonly TranscriptTurn[], firstName: string | null, personText = ""): string[] {
  // Every reply but the opening line, which is fixed.
  const replies = history.filter((t) => t.speaker === "assistant").slice(1).map((t) => t.text);
  if (replies.length === 0) return [];
  const out: string[] = [];
  const again = askedBefore(history, personText);
  if (again) {
    out.push(
      `They asked nearly the same thing a moment ago ("${again.slice(0, 120).replace(/"/g, "'")}"), so say it again shorter and plainer, in new words, never a sentence you used before (the shortest version that answers it).`,
    );
  }
  // "Sorry, say that again?" asks them to repeat; it is not an apology (6e).
  if (replies.some((r) => /\b(?:sorry|apologi[sz]e)\b/i.test(r) && !SAY_AGAIN.test(r))) {
    out.push(`You have already apologised on this call: no more "sorry", just carry on.`);
  }
  const reflected = replies.slice(-3).filter((r) => REFLECTION_OPENER.test(r.trim()));
  if (reflected.length > 0) {
    const opening = reflected.at(-1)!.trim().split(/(?<=[.!?,])\s/)[0]!.slice(0, 80).replace(/"/g, "'");
    out.push(`Your recent replies opened by reflecting their words back ("${opening}"): don't. Go straight to the content; acknowledge only a negative feeling they voice, briefly and rarely.`);
  }
  const name = firstName?.trim();
  if (name) {
    const said = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const uses = replies.filter((r) => said.test(r)).length;
    if (uses >= 2 || said.test(replies.at(-1)!)) out.push(`Do not say their name in this reply.`);
  }
  const openers = replies
    .slice(-3)
    .map((r) => r.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, ""))
    .filter((w): w is string => Boolean(w));
  if (openers.length > 0) {
    out.push(`Your last replies began "${openers.join('", "')}": begin this one differently, straight with what you have to say.`);
  }
  return out;
}

/** A short "say that again?" (6e): asking them to repeat, not an apology. */
const SAY_AGAIN = /^[^.!?]{0,40}\b(?:say that again|repeat that|what was that|one more time|come again|didn'?t catch)\b[^.!?]{0,20}\?$/i;

/**
 * A reply opening by reflecting the caller's words back (owner, 26 October
 * 2026, 6c: "Sounds like you're losing business on calls you can't pick up",
 * "I hear you, Lia", opening nearly every reply). Noticed from the record,
 * so the next reply is told to go straight to the content.
 */
const REFLECTION_OPENER = /^(?:it\s+|so\s+it\s+)?sounds like\b|^i hear you\b|^so,?\s+you'?re saying\b|^so what you'?re saying\b|^got it,?\s+so\b|^i totally understand\b|^i understand\b/i;

/** Words too common to tell two questions apart. */
const COMMON_WORDS = new Set(
  "the a an and or but so do does did you your yours i me my we our us is are was were be been it its this that what which who how can could would will just only also about for of to in on at with from like okay ok yeah yes no not have has had any some there they them then".split(" "),
);

/** The channels a caller asks about in so many words ("phone only?", "social media?", "WhatsApp?"): one question, however it is put. */
const CHANNEL_WORDS = /\b(?:phone only|just the phone|only the phone|social media|socials|instagram|insta|facebook|messenger|whatsapp|website chat|web chat|live chat|dms?|text(?:ing)?|sms|channels?)\b/i;

/**
 * The caller's earlier words when what they say now asks nearly the same
 * (owner's test call, 25 October 2026: "phone only?", "social media?",
 * "WhatsApp?" in a row, each answered in part, the last near word for word
 * as the one before): the same content words, or the same channels
 * question. Null when they are asking something new.
 */
export function askedBefore(history: readonly TranscriptTurn[], personText: string): string | null {
  const words = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !COMMON_WORDS.has(w)));
  const now = words(personText);
  const earlier = history.filter((t) => t.speaker === "person").slice(-2);
  for (const turn of [...earlier].reverse()) {
    if (CHANNEL_WORDS.test(personText) && CHANNEL_WORDS.test(turn.text)) return turn.text;
    const then = words(turn.text);
    if (now.size < 2 || then.size < 2) continue;
    const shared = [...now].filter((w) => then.has(w)).length;
    if (shared / new Set([...now, ...then]).size >= 0.5) return turn.text;
  }
  return null;
}

/** Words a sentence needs before saying it twice counts as repeating it: "Okay." or "Got it." may come back. */
const REPEAT_MIN_WORDS = 3;
/** Words a sentence from earlier in the call needs to count: "Anything else I can help with?" (six) may come back, a whole answer may not. */
const EARLIER_REPEAT_MIN_WORDS = 7;

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?…]["'’”)\]]*)\s+/)
    .filter((s) => s.trim())
    // "Dr." ends no sentence: its piece goes back with the name after it (endsWithAbbreviation).
    .reduce<string[]>((out, piece) => {
      const last = out.at(-1);
      if (last !== undefined && endsWithAbbreviation(last)) out[out.length - 1] = `${last} ${piece}`;
      else out.push(piece);
      return out;
    }, []);
const sameWords = (sentence: string): string =>
  sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

/**
 * `text` without any sentence already said in `said`, or twice in `text`
 * itself (owner, 24 October 2026: "she should never repeat the same sentence
 * twice in a row"). The prompt asks for it too; this holds it whatever the
 * model writes. A call reads `said` as the turn before and what this turn has
 * already spoken, and `earlier` as every turn before that, where only a
 * sentence of EARLIER_REPEAT_MIN_WORDS or more counts. A sentence of a word
 * or two may repeat. Empty when every sentence is a repeat: the caller
 * decides what to say then.
 */
export function withoutRepeats(text: string, said: readonly string[], earlier: readonly string[] = []): string {
  const longEnough = (min: number) => (s: string) => s.split(" ").length >= min;
  const seen = new Set([
    ...said.flatMap(sentencesOf).map(sameWords).filter(longEnough(REPEAT_MIN_WORDS)),
    ...earlier.flatMap(sentencesOf).map(sameWords).filter(longEnough(EARLIER_REPEAT_MIN_WORDS)),
  ]);
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
   * On a call, a short fixed acknowledgement ("Sure.", "Got it.") the
   * adapter says out loud if the reply is slow to start, so the caller hears
   * no dead air while the model thinks (owner, 24 October 2026). `say` is
   * called once, after every screen has passed and just before the model is
   * asked, so nothing is said ahead of an urgent, card or language line; the
   * model is told it may be said, so it never starts with another.
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
   * the booking tools are not live this turn or no time has been offered yet
   * (streamWithTools), the answer is spoken as it is written: each sentence, once the guard has passed it alone, goes here;
   * the first one the guard refuses is replaced by its fixed line and
   * nothing after it is said. The result's `spoken` is what went out.
   */
  speak?: ((sentence: string) => void) | null;
  /** A call: how fast the caller speaks, from Retell's word timings (retell.ts paceOf); null or absent when unknown. */
  pace?: "quick" | "slow" | null;
  /**
   * What the adapter knows about the whole conversation that the facts do
   * not say, for the turn context after the cached prefix: a personalised
   * demo call's note (lib/voice/demo-facts.ts, demoCallNote). Every screen
   * and the guard run as on any turn; a note changes what the model is
   * told, never what it may say.
   */
  notes?: readonly string[] | null;
  /**
   * The stable prefix in place of the practice's own prompt
   * (buildAssistantPrompt), when the adapter is not answering as the
   * practice: a personalised demo call outside its role-play, where Aya is
   * healdesk's and talks with a clinic's owner (lib/voice/demo-facts.ts,
   * demoSalesPrompt). The facts still decide every screen and the guard;
   * only what the model is told changes, never what it may say.
   */
  stablePrompt?: string | null;
  /**
   * On a call, the caller's first name when the adapter knows it before the
   * model has captured one (a demo's requester), for voiceHabits.
   */
  callerFirstName?: string | null;
  /**
   * How many times the caller's first name may be said before it is taken
   * out of her sentences (shapeVoiceReply); 2 when not given. A demo call
   * passes 0: its code says the name once, in the booking's confirmation
   * (demo-facts.ts demoConfirmLine; demo call a44374c9 said "Thomas" three times).
   */
  nameLimit?: number;
  /**
   * A demo call, whose claims that a booking is made are the call's own code's
   * to check (demo-facts.ts: roleplayHolds, roleplayCheckedReply,
   * demoConfirmLine): the guard does not refuse them. Never set for a
   * clinic's call, where only the tool layer's write lets one through
   * (demo call a44374c9: "I can't confirm it myself" four times, answering
   * "what?" and "Yep, that works").
   */
  bookingClaimsOwned?: boolean;
  /**
   * On a call, never end on "Talk soon": a demo whose caller showed
   * frustration (lib/voice/demo-facts.ts, `impatient`). A sentence holding it
   * is left out of what is said.
   */
  noSignOff?: boolean;
  /**
   * On a call, one question a reply: any question after the first is left
   * out of what is said (shapeVoiceReply). A demo's talk with the owner sets
   * it (lib/voice/retell.ts), outside a call back's read-back; `keep` holds
   * scripted lines whose questions always stay (the call-back offer asks two).
   */
  oneQuestion?: { keep: readonly string[] } | null;
  /**
   * On a call, sentences matching this are left out of what is said
   * (shapeVoiceReply), as words only ever are: a fact said once a call and
   * never again (a demo's setup discount once it was said; retell.ts).
   */
  dropSentences?: RegExp | null;
  /** This is the one second try after a refusal (answerAgain); never set by a caller. */
  retried?: boolean;
  /**
   * On a call, where a refusal must never be heard as the guard's fixed line:
   * a demo's talk with a clinic's owner about their own business, after the
   * role-play (lib/voice/retell.ts). A refused reply with nothing said yet is
   * asked again once, with the reason, whatever the reason; a second refusal
   * says `line` (or `alternate`, when `line` was the last thing said), and a
   * refusal after some of the reply was already spoken ends it on `bridge`;
   * never "That one's really for the clinicians". The guard reads every word
   * as ever, and nothing it refuses is said: only the line in its place
   * changes. Never set on a patient's call, nor during a demo's role-play.
   */
  softRefusal?: { line: string; alternate: string; bridge: string } | null;
  /**
   * On a call, the payment-link text after its booking (lib/sms/payment-text.ts):
   * the offer added to the booked line when it may be made, and each turn
   * while it is in play read from the model's structured state, never its
   * words. While it is in play the reply is not spoken before the step,
   * since the step's fixed line may replace it.
   */
  paymentText?: PaymentTextTools | null;
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
  // "What do you have Thursday?" with the treatment already known: the tool
  // layer answers it on a call with no model turn first (owner, 1 November
  // 2026: "latency the lowest possible"); the model would only ask for the
  // same times and have its words replaced. A different treatment named, or
  // no day or part of the day, and the model answers as before.
  if (toolsLive && channel === "voice" && !toolState.chosen) {
    const service = toolState.service ?? capture.service ?? null;
    const day = dayNamedIn(personText, now, facts.timeZone);
    const window = windowNamedIn(personText);
    const plain = (name: string) => name.toLowerCase().replace(/[®™]/g, "").trim();
    const heard = personText.toLowerCase();
    const otherService = facts.services.some((svc) => {
      const first = plain(svc.name).split(/\s+/)[0] ?? "";
      return first.length > 2 && !plain(service ?? "").startsWith(first) && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(heard);
    });
    if (service && asksForTimes(personText) && (day || window.after || window.before) && !otherService) {
      const tool = await input.tools!.run({
        action: { type: "find_times", service, day, ...window },
        capture,
        state: toolState,
        callerPhone: input.callerPhone ?? null,
        words: personText,
        now,
        ...(input.language ? { language: input.language } : {}),
      });
      if (tool) {
        const kind = toolMoment(tool, { type: "find_times" }, toolState.offered.length > 0);
        const reply = withToolMoment({ line: forVoice(tool.reply), kind, spoken: "", day, timeZone: facts.timeZone, history: input.history, language: input.language === "es" ? "es" : "en" });
        return { ...base, toolsLive, toolState: tool.state, tool, reply, source: "tool" };
      }
    }
  }
  // The payment-link text after a call's booking, while it is in play (a call only).
  const textTools = channel === "voice" ? (input.paymentText ?? null) : null;
  const textLive = Boolean(textTools?.live(toolState));
  const opening = input.history.find((t) => t.speaker === "assistant")?.text;
  const notes: string[] = [...(input.notes ?? [])];
  const textNote = textLive ? textTools!.note(toolState) : null;
  if (textNote) notes.push(textNote);
  if (input.interruptedAt) {
    notes.push(
      `The caller cut in while you were speaking; they heard only: "${input.interruptedAt}". Answer what they just said, and do not repeat what they talked over unless they ask.`,
    );
  }
  const offered = channel === "voice" ? lastAssistantLine(input.history) : null;
  if (offered && /\?/.test(offered) && DECLINED.test(personText)) {
    notes.push(
      `They just turned down what you last asked or offered ("${offered}"). Drop it and follow their lead. Only if it truly matters, come back to it once, later, in completely different words, shorter and lighter, matched to how firmly they said no.`,
    );
  }
  if (channel === "voice") notes.push(...voiceHabits(input.history, capture.firstName ?? input.callerFirstName ?? null, personText));
  if (channel === "voice") {
    // How fast they speak, from Retell's word timings (retell.ts paceOf): the brisk or the unhurried example.
    if (input.pace === "quick") notes.push("They speak quickly: keep it brisk and short, no small talk, as in the brisk caller's call.");
    if (input.pace === "slow") notes.push("They speak slowly and calmly: unhurried and warm, never rushed.");
    // Their moment (a wedding, a trip), once, in the goodbye (owner, 1 November 2026: remember the caller's moment).
    const occasion = occasionIn([...input.history.filter((t) => t.speaker !== "assistant").map((t) => t.text), personText]);
    const wished = occasion && input.history.some((t) => t.speaker === "assistant" && t.text.toLowerCase().includes(occasion) && GOODBYE_SAID.test(t.text));
    if (occasion && !wished && (toolState.done || WRAPPING_UP.test(personText))) {
      notes.push(`They mentioned their ${occasion}: in your goodbye, wish them well for it in a few words ("Have the best time at the ${occasion}!"), once.`);
    }
    // One add-on from the practice's own menu, on a demonstration, before times are looked for (pairings.ts).
    const service = toolState.service ?? capture.service ?? null;
    const pairing = facts.demoCall && facts.suggestAddOns && toolsLive && service && toolState.offered.length === 0 && !toolState.chosen && input.pace !== "quick" ? pairingFor(service, facts.services) : null;
    if (pairing && !input.history.some((t) => t.speaker === "assistant" && t.text.toLowerCase().includes(pairing.name.toLowerCase().replace(/[®™]/g, "").split(/\s+/)[0]!))) {
      notes.push(
        `You may suggest one add-on, once, before looking for times: ${pairing.name} (${pairing.price}), ${pairing.why}. Say it as their convenience in one short sentence ("Since you're coming in for ${service}, ..."), with its price, then ask if they'd like it too; at a no, drop it for good. Never what it will do for them. If they say yes, the service is "${service} and ${pairing.name}".`,
      );
    }
    // The calendar read ahead for a day or part of the day they named, so the times are ready when asked for.
    if (toolsLive && service && !toolState.chosen && input.tools?.prefetch && (asksForTimes(personText) || /\b(?:book|appointment|come in|available|free|open|works?)\b/i.test(personText))) {
      const day = dayNamedIn(personText, now, facts.timeZone);
      const window = windowNamedIn(personText);
      if (day || window.after || window.before) input.tools.prefetch({ type: "find_times", service, day, ...window }, now);
    }
  }
  if (input.acknowledge) {
    notes.push(`"${input.acknowledge.line}" is being said out loud for you first: carry straight on from it, with no other opener, filler or feeling sound, as one sentence that starts with it would.`);
  }
  const system = {
    stable: input.stablePrompt ?? buildAssistantPrompt(facts, channel, { bookingTools: toolsLive }),
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
  // While the tools are live, only until times are offered (owner, 1 November
  // 2026: "latency the lowest possible"): before then the tool layer replaces
  // nothing she says but a free time she names (held back below, unsaid) and
  // a find_times she asks for, whose line then follows what she has said
  // ("Let me pull up our calendar..." and the times). From the first offer to
  // the booking, the reply is read whole: a picked time, a hold and the
  // booking are the tool layer's lines, and her words for them are replaced.
  const streamWithTools = toolsLive && !toolState.chosen && toolState.offered.length === 0;
  // A free time she named while streaming: it and everything after wait for the tool layer.
  let heldForTool = false;
  const spoken: string[] = [];
  let refusedMidway: GuardRefusal | null = null;
  // Words the language check could not place yet ("Mm-hmm. Got it."): they
  // wait for the next sentence, and are judged with it or with the end.
  let unplaced = "";
  // On a call, nothing said in the turn before is said again, nor a whole
  // sentence from earlier in the call (withoutRepeats).
  const assistantLines = input.history.filter((t) => t.speaker === "assistant").map((t) => t.text);
  const before = channel === "voice" && !askedAgain(personText) ? assistantLines.slice(-1) : null;
  const earlierLines = assistantLines.slice(0, -1);
  const fresh = (text: string) => (before ? withoutRepeats(text, [...before, ...spoken], earlierLines) : text);
  // A call's register, enforced (shapeVoiceReply): the opening line is fixed and not counted.
  const callerName = capture.firstName?.trim() || input.callerFirstName?.trim() || null;
  // A booking this conversation's tool layer wrote may be said on any later turn ("What time was my booking?" was
  // refused as an unconfirmed claim); a demo's claims were its own code's to check (bookingClaimsOwned).
  const written = input.bookingClaimsOwned === true || toolState.done?.kind === "booked" ? ({ bookingWritten: true } as const) : NO_BOOKING_WRITTEN;
  const nameSaid = (lines: readonly string[]) =>
    callerName ? lines.filter((line) => new RegExp(`\\b${callerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(line)).length : 0;
  const apologisedBefore = assistantLines.slice(1).some((line) => /\b(?:sorry|apologi[sz]e)\b/i.test(line) && !SAY_AGAIN.test(line));
  const shaped = (text: string, first: boolean) =>
    channel === "voice"
      ? shapeVoiceReply(text, {
          name: callerName,
          nameUses: nameSaid(assistantLines.slice(1)) + nameSaid(spoken),
          nameLimit: input.nameLimit,
          apologised: apologisedBefore,
          first,
          noSignOff: input.noSignOff === true,
          oneQuestion: Boolean(input.oneQuestion),
          keepQuestions: input.oneQuestion?.keep,
          askedAlready: spoken.some((line) => line.includes("?")),
          drop: input.dropSentences ?? null,
        })
      : text;
  const stream =
    input.speak && (!toolsLive || streamWithTools) && !textLive
      ? new SpokenStream((sentence) => {
          if (refusedMidway) return;
          if (heldForTool) {
            unplaced = [unplaced, sentence].filter(Boolean).join(" ");
            return;
          }
          if (toolsLive && claimsFreeTime(sentence)) {
            heldForTool = true;
            unplaced = [unplaced, sentence].filter(Boolean).join(" ");
            return;
          }
          let piece = fresh([unplaced, sentence].filter(Boolean).join(" "));
          if (!piece) {
            unplaced = "";
            return;
          }
          // The reply's opening filler goes; filler alone waits for what follows it.
          if (channel === "voice" && spoken.length === 0) {
            const rest = withoutLeadingFiller(piece);
            if (!rest) {
              unplaced = piece;
              return;
            }
            piece = rest;
          }
          piece = shaped(piece, spoken.length === 0);
          if (!piece) {
            unplaced = "";
            return;
          }
          // Read with everything already said, so a rule that needs the
          // sentence before it (a question asked back, the reply's language)
          // reads it as the whole reply would; what came before has passed.
          const verdict = guardAssistantReply([saidSoFar(), piece].filter(Boolean).join(" "), facts, written);
          if (!verdict.ok && verdict.reason === "language") {
            unplaced = piece;
            return;
          }
          unplaced = "";
          if (!verdict.ok) {
            refusedMidway = verdict.reason;
            // A price refused before a word was said: the second try starts
            // now, not after the rest of a reply nobody will hear is written.
            if ((verdict.reason === "price" || input.softRefusal) && spoken.length === 0 && channel === "voice" && !input.retried) {
              startAgain({ next: answerAgain(input, verdict.reason) });
            }
            return;
          }
          spoken.push(piece);
          input.speak!(piece);
        })
      : null;
  const saidSoFar = () => spoken.join(" ");
  // The second try after a price refused mid-stream, when one started (answerAgain).
  // Wrapped, so the race below takes it the moment it starts, not when it ends.
  let startAgain: (retry: { next: Promise<AssistantTurnResult> }) => void = () => {};
  const again = new Promise<{ next: Promise<AssistantTurnResult> }>((resolve) => {
    startAgain = resolve;
  });
  let raw: Awaited<ReturnType<AssistantResponder>>;
  try {
    const answer = input.responder({
      system,
      messages: messagesFor(input.history, personText, (text) => screenedBeforeModel(text, facts)),
      channel,
      ...(stream ? { onText: (delta: string) => stream.push(delta) } : {}),
    });
    const first = await Promise.race([
      withinDeadline(answer, input.modelDeadlineMs ?? MODEL_DEADLINE_MS[channel]).then((value) => ({ value })),
      again,
    ]);
    // The first reply is left to finish unheard; the second try is the turn.
    if ("next" in first) return await first.next;
    raw = first.value;
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
    if (toolsLive && !refusedMidway && !answer.handoff) {
      // The tool layer's turn, as on a reply read whole: its line follows what she has already said.
      const action =
        answer.action ??
        (claimsFreeTime(answer.reply) && aboutATime(personText, answer.booking?.wants, now, facts.timeZone, toolState.offered.length > 0)
          ? ({ type: "find_times", service: toolState.service ?? merged.service ?? null, day: dayNamedIn(personText, now, facts.timeZone), ...windowNamedIn(personText) } as const)
          : null);
      const tool = await input.tools!.run({
        action,
        capture: merged,
        state: toolState,
        callerPhone: input.callerPhone ?? null,
        words: personText,
        now,
        ...(input.language ? { language: input.language } : {}),
      });
      if (tool) {
        const line = channel === "voice" ? forVoice(tool.reply) : tool.reply;
        const kind = channel === "voice" ? toolMoment(tool, action, toolState.offered.length > 0) : null;
        const reply = withToolMoment({ line, kind, spoken: saidSoFar(), day: action && action.type === "find_times" ? (action.day ?? null) : null, timeZone: facts.timeZone, history: input.history, language: input.language === "es" ? "es" : "en" });
        return { ...base, toolsLive, capture: merged, toolState: tool.state, tool, reply, spoken: saidSoFar(), source: "tool" };
      }
    }
    // A free time she named that no tool line took over (a question that asked for none, a handoff) is never said.
    const left = [unplaced, stream.remainder()].filter(Boolean).join(" ");
    const unclaimed = toolsLive && left && claimsFreeTime(left) ? left.split(/(?<=[.!?])\s+/).filter((sentence) => !claimsFreeTime(sentence) || RESTATES_BOOKING.test(sentence)).join(" ") : left;
    const rest = refusedMidway ? null : shaped(fresh(unclaimed), spoken.length === 0) || null;
    const restVerdict = rest ? guardAssistantReply([saidSoFar(), rest].filter(Boolean).join(" "), facts, written) : null;
    const reason: GuardRefusal | null = refusedMidway ?? (restVerdict && !restVerdict.ok ? restVerdict.reason : null);
    if (reason && (reason === "price" || input.softRefusal) && spoken.length === 0 && channel === "voice" && !input.retried) return answerAgain(input, reason);
    if (reason && spoken.length === 0 && !input.softRefusal) {
      const line = guardLineFor(reason, facts.clinicName, language === "es" ? "es" : "en", channel, input.history, routedTo(facts));
      if (saidLast(input.history, line)) {
        const again = routedAskedAgain(reason, facts, personText, language === "es" ? "es" : "en", channel, input.history);
        if (again) return { ...base, toolsLive, capture: merged, reply: again, source: "guard", guard: reason };
        return { ...base, toolsLive, capture: merged, handoff: true, reply: movingOnLine(facts.clinicName, language === "es" ? "es" : "en", channel === "voice"), source: "guard", guard: reason };
      }
    }
    const tail = reason
      ? (softLine(input, spoken.length > 0) ?? guardLineFor(reason, facts.clinicName, language === "es" ? "es" : "en", channel, input.history, routedTo(facts)))
      : (rest ?? "");
    const reply = [saidSoFar(), tail].filter(Boolean).join(" ");
    // The guard read each sentence alone; read the whole once more, so a rule
    // that only a whole reply breaks is at least seen. Kind only, never words.
    const whole = guardAssistantReply(reply, facts, written);
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
      ...(reason ? { guard: reason } : { state: answer.state ?? null }),
    };
  }
  if (answer.malformed) {
    // A failure to answer, like a throw: the fixed line, never the raw text,
    // and nothing it held is captured. Logged by kind, never with the text.
    log.warn("model answer not valid JSON", { channel, kind: "malformed" });
    return { ...base, reply: failureLine(language), source: "fallback" };
  }
  const merged = mergeCapture(capture, answer.booking);
  let live = { ...base, toolsLive };
  if (textLive && !answer.handoff) {
    // The text's step, on the model's structured state alone: its fixed line
    // replaces the model's words, or the model's reply stands.
    const text = await textTools!.step({ state: toolState, answer: answer.state, now, language: input.language === "es" ? "es" : "en" });
    if (text.reply) {
      return { ...live, capture: merged, toolState: text.state, reply: text.reply, source: "tool" };
    }
    live = { ...live, toolState: text.state };
  }
  if (toolsLive && !answer.handoff && !answer.action && !toolState.chosen && claimsFreeTime(answer.reply) && !aboutATime(personText, answer.booking?.wants, now, facts.timeZone, toolState.offered.length > 0)) {
    // A free time named to a question that asks for none: the sentence goes, the rest of the reply stands.
    answer.reply = withoutFreeTimeClaims(answer.reply);
  }
  if (toolsLive && !answer.handoff) {
    // Free times come from the booking system, never the model: a reply that says a time or a day is open, with no
    // action and no time chosen yet, is the system's question to answer, for the day the person named (demo call
    // be078f77 and the calls before it: "Thursday afternoon works", "we have openings this week" with nothing checked).
    // The caller picked an offered time by its hour and the model did not pass it on: code does (a test call of
    // 1 November 2026: "Four PM would work." was offered the times again).
    const picked = !answer.action && !toolState.chosen ? offeredTimeNamed(personText, toolState.offered, facts.timeZone, now) : null;
    const action =
      answer.action ??
      (picked ? ({ type: "choose_time", at: picked } as const) : null) ??
      (!toolState.chosen && claimsFreeTime(answer.reply)
        ? ({ type: "find_times", service: toolState.service ?? merged.service ?? null, day: dayNamedIn(personText, now, facts.timeZone), ...windowNamedIn(personText) } as const)
        : null);
    // The tool layer, on what the model asked for and what is now known.
    const tool = await input.tools!.run({
      action,
      capture: merged,
      state: toolState,
      callerPhone: input.callerPhone ?? null,
        words: personText,
      now,
      ...(input.language ? { language: input.language } : {}),
    });
    if (tool) {
      // A booking written on a call: the text's offer joins the booked line, when it may be made.
      const offered = textTools && tool.bookingWritten ? await textTools.offerAfterBooking(tool, now, input.language === "es" ? "es" : "en") : tool;
      // A fixed line said on a call is shaped for a voice too: no "BOTOX®" read out (demo call be078f77),
      // and follows the moment a person takes to look, hold or write it in (pauses.ts).
      if (channel !== "voice") return { ...live, capture: merged, toolState: offered.state, tool: offered, reply: offered.reply, source: "tool" };
      const kind = toolMoment(offered, action, toolState.offered.length > 0);
      const day = action && action.type === "find_times" ? (action.day ?? null) : null;
      const reply = withToolMoment({ line: forVoice(offered.reply), kind, spoken: "", day, timeZone: facts.timeZone, history: input.history, language: input.language === "es" ? "es" : "en" });
      return { ...live, capture: merged, toolState: offered.state, tool: offered, reply, source: "tool" };
    }
  }
  if (input.tools && toolState.done && !answer.handoff && claimsFreeTime(answer.reply) && !aboutATime(personText, answer.booking?.wants, now, facts.timeZone)) {
    // A free time named to a question that asks for none ("Is it always full there?" answered "we have openings"):
    // only the sentence that names it goes, never the whole reply (be078f77 replay, 1 November 2026).
    answer.reply = withoutFreeTimeClaims(answer.reply);
  } else if (input.tools && toolState.done && !answer.handoff && claimsFreeTime(answer.reply)) {
    // The conversation's one booking is made, so the tools are off; a free time the model names still is not its to
    // name: the tool layer says the booking stands (be078f77: "we have openings Monday at 11 AM" after booking).
    const tool = await input.tools.run({ action: { type: "find_times", service: toolState.service, day: null }, capture: merged, state: toolState, callerPhone: input.callerPhone ?? null, words: personText, now, ...(input.language ? { language: input.language } : {}) });
    if (tool) return { ...live, capture: merged, toolState: tool.state, tool, reply: channel === "voice" ? forVoice(tool.reply) : tool.reply, source: "tool" };
  }
  // With booking tools on, free times are never the model's to name: one the tool layer did not take over
  // (a time already held, a question that asked for none) is taken out (be078f77 and sound-alike replays).
  if (input.tools && claimsFreeTime(answer.reply)) answer.reply = withoutFreeTimeClaims(answer.reply);
  // A reply that only repeats the turn before is said as written: silence would be worse.
  const unrepeated = (before && fresh(answer.reply)) || answer.reply;
  const unfilled = channel === "voice" ? withoutLeadingFiller(unrepeated) || unrepeated : unrepeated;
  const replyText = shaped(unfilled, true) || unfilled;
  const verdict = guardAssistantReply(replyText, facts, written);
  if (!verdict.ok && (verdict.reason === "price" || input.softRefusal) && channel === "voice" && !input.retried) return answerAgain(input, verdict.reason);
  const soft = verdict.ok ? null : softLine(input);
  if (soft) return { ...live, capture: merged, handoff: false, reply: soft, source: "guard", guard: (verdict as { reason: GuardRefusal }).reason };
  if (!verdict.ok) {
    // The fixed line in the language of the reply it replaces, Spanish only
    // where that reply (or, for a reply in no screened language, the person)
    // was Spanish, or where the call is being spoken in Spanish; English
    // otherwise, as it always was.
    const said = messageLanguage(replyText, { knownTerms: languageTerms(facts) });
    const spanish =
      language === "es" || said === "es" || (said === "other" && messageLanguage(personText, { knownTerms: languageTerms(facts) }) === "es");
    const line = guardLineFor(verdict.reason, facts.clinicName, spanish ? "es" : "en", channel, input.history, routedTo(facts));
    // The same refusal as the last thing said: the person answered it ("yes,
    // please") and the model's next try was refused again. Saying it a third
    // time is a loop (test call of 23 October 2026), so the turn hands over.
    if (saidLast(input.history, line)) {
      const again = routedAskedAgain(verdict.reason, facts, personText, spanish ? "es" : "en", channel, input.history);
      if (again) return { ...live, capture: merged, handoff: answer.handoff, reply: again, source: "guard", guard: verdict.reason };
      return { ...live, capture: merged, handoff: true, reply: movingOnLine(facts.clinicName, spanish ? "es" : "en", channel === "voice"), source: "guard", guard: verdict.reason };
    }
    return { ...live, capture: merged, handoff: answer.handoff, reply: line, source: "guard", guard: verdict.reason };
  }
  return { ...live, capture: merged, handoff: answer.handoff, end: answer.end, reply: replyText, source: "model", state: answer.state ?? null };
}

/**
 * On a call, the one second try after a refused reply with nothing said yet:
 * for a dollar figure on any call (PRICE_AGAIN), and for any refusal on a
 * softRefusal turn (softAgain). The model is told why and asked again; the
 * guard reads the second reply as it read the first, and a second refusal is
 * the fixed line (or the softRefusal line). The acknowledgement, if it was
 * said, is not said again. A call only: a chat reader sees the fixed line
 * once and reads on, where a caller hears it to a question it does not answer.
 */
function answerAgain(input: Parameters<typeof answerTurn>[0], reason: GuardRefusal): Promise<AssistantTurnResult> {
  return answerTurn({ ...input, acknowledge: null, retried: true, notes: [...(input.notes ?? []), reason === "price" ? PRICE_AGAIN : softAgain(reason)] });
}

/**
 * The softRefusal line for this turn: its bridge after words already spoken,
 * its alternate when the line was the last thing said; null on any other turn.
 */
function softLine(input: Parameters<typeof answerTurn>[0], midway = false): string | null {
  if (!input.softRefusal) return null;
  if (midway) return input.softRefusal.bridge;
  return saidLast(input.history, input.softRefusal.line) ? input.softRefusal.alternate : input.softRefusal.line;
}
