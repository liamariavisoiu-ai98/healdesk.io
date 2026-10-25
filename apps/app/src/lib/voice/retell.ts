import { randomUUID } from "node:crypto";

import { audienceFor, messageLanguage, openDemoCallContext, SENDER_IDENTITY, type DemoCallContext } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics, clinicSettings } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { bookingTools, EMPTY_TOOL_STATE, type BookingTools, type BookingToolState } from "@/lib/assistant/booking-tools";
import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { checkMenu } from "@/lib/assistant/menu-check";
import { openingLine } from "@/lib/assistant/opening";
import { answerTurn, EMPTY_CAPTURE, failureLine, languageTerms, type AssistantResponder, type BookingCapture } from "@/lib/assistant/turn";
import { assistantFallbackRefused, patientDataRefused, voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { demoVoiceOpening, voiceDisclosureEs } from "@/lib/compliance/disclosure";
import { renderTranscriptEmail, sendTranscriptEmail, type TranscriptTurn } from "@/lib/conversations/transcript-email";
import { deliverCriticalAfterCommit } from "@/lib/email/outbox";
import { raiseHandover } from "@/lib/handovers/record";
import { describeError, log } from "@/lib/log";
import { notifyBookingAlert, urgentAlertNotQueued, withoutTeamTold } from "@/lib/notices/booking-alerts";
import { notifyOps } from "@/lib/ops/notify";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { nextCallLanguage, START_LANGUAGE, type CallLanguageState } from "./call-language";
import { DEMO_TIME_ZONE, demoAssistantFacts, demoContextFromCall, demoStageNote, nextDemoStage, type DemoStage } from "./demo-facts";
import { fallbackLineFor, rememberDirectLine, rememberedDirectLine, usableLine, type FallbackLookup } from "./fallback-line";
import { forwardedFromCall, type ForwardedFrom } from "./forwarded-from";
import { ingestCall, type IngestResult, type VoiceCallEvent } from "./ingest";
import { redialPromptBlock, takeRedialContext, welcomeBackLine, type RedialContext } from "./redial";
import type { SpokenLanguage } from "./spoken";
import { screenTestCall, voiceRealCallsAllowed, type TestCallScreen } from "./test-calls";

/**
 * One call on Retell's custom-LLM WebSocket (the v1 voice agent; CLAUDE.md,
 * "Deployment": its own long-lived process, src/voice/server.ts). Retell does
 * the telephony, the speech recognition and the voice; healdesk is the LLM:
 * every word the agent says comes from here.
 *
 * The protocol, as this file speaks it:
 *
 *   on connect      `config` (auto-reconnect pings, call details), then the
 *                   answer gate, then response 0: the locked AI line, said
 *                   before anything else, with the call's transcription
 *                   (lib/compliance/disclosure.ts),
 *                   then the clinic's phone greeting. The time it was sent is
 *                   the call's disclosure_played_at. A caller who spoke
 *                   before it went out never heard it: it is said again
 *                   before the next reply that is not urgent, and the time
 *                   moves with it.
 *   call_details    the caller's number, the call's start and the lines the
 *                   carrier says forwarded it (lib/voice/forwarded-from.ts),
 *                   kept in memory; an outbound call is ended at once (v1 is
 *                   inbound only).
 *   ping_pong       echoed.
 *   update_only     nothing: the transcript is this file's own.
 *   response_required / reminder_required
 *                   the caller's latest words (Retell's transcript after the
 *                   agent's last turn) go to the shared brain
 *                   (lib/assistant/turn.ts: card numbers cut, urgent content
 *                   answered with a fixed line before the model, the guard
 *                   after it), and the reply is sent whole, never streamed,
 *                   because the guard reads all of it first. A newer request
 *                   supersedes an older one still being answered. Urgent
 *                   content queues the clinic's L12 alert, sent in-process
 *                   once it has committed, and a caller asking for a person
 *                   queues L11, each once per call
 *                   (lib/notices/booking-alerts.ts). An urgent call at a
 *                   practice with a line that reaches a person (urgentLine)
 *                   is put through to it as the fixed reply ends (owner,
 *                   23 October 2026).
 *   close           the call is over: the post-call ingest (lib/voice/ingest.ts)
 *                   records the conversation, turns what the caller asked for
 *                   into one booking request for the desk, counts the minutes
 *                   and queues the transcript for the clinic, all idempotent on
 *                   the call id.
 *
 * Booking: while direct booking is on for the location (the owner's switch,
 * counsel's addendum and a calendar that can offer times), the booking tool
 * layer (lib/assistant/booking-tools.ts) offers free times, holds the one
 * chosen for 60 seconds while the caller gives their details and books it
 * into Google under the key "retell:" + call id + ":1"; the ingest links
 * that booking or request to the call's conversation and files no second
 * one. Otherwise the assistant takes a request and books nothing itself.
 * A call never sends a link: a deposit is said, and left to the front desk.
 *
 * Until real calls are switched on (HEALDESK_VOICE_REAL_CALLS, lib/voice/
 * test-calls.ts), a call is taken only for a made-up clinic: any other is
 * put through to its direct line, or closed with a fixed line, before the
 * gate runs, and nothing of it is recorded. The check shares the start's
 * deadline: one that cannot answer in time is a refusal too, to the line
 * this process remembers or with the closing line, never silence.
 *
 * Every degradation ends at a person (CLAUDE.md, "Failure"): a gate that
 * refuses the call, or a model that fails twice running, transfers the
 * caller to the clinic's direct line where there is one. With none, the
 * assistant takes the caller's details, so the call still reaches someone;
 * once the Services have ended, it closes the call with a fixed line.
 * Every number a call is put through to is first checked not to be one that
 * reaches us (fallback-line.ts, usableLine), so a transfer never loops.
 * A call that cannot start because the database cannot be read goes to the
 * direct line too, known without the database (fallback-line.ts: this
 * process's memory of the clinic's last call, then the fallback number Retell
 * holds for the clinic's AYA number); only with neither does it close. A
 * fault while answering a turn is a failure like the model's, never silence.
 *
 * A call back after a call that ended unexpectedly (lib/voice/redial.ts):
 * once the call is answered and the caller's number is known, the session
 * takes the sealed record of that call's last turns, if one is waiting for
 * the number, and deletes it as it does. The opening line is said as on any
 * call; the first reply that is not urgent then starts with a fixed
 * welcome-back line (saying the team was told only when the earlier call's
 * alert is queued and alerts reach the clinic), and every turn's context
 * carries the earlier turns as a record. No number, or a lookup that fails
 * or is slow, is an ordinary call.
 *
 * Language (owner, 22 October 2026). Every call opens in English. A caller
 * who speaks Spanish, to a clinic that answers in Spanish, turns the call to
 * Spanish (call-language.ts: two Spanish utterances in a row, or one long
 * one), and the first time it does, the Spanish AI and transcription line
 * (voiceDisclosureEs) is said before the next reply that is not urgent, once
 * per call. From then on every fixed line this call says is the Spanish one
 * (CLOSED_LINE_ES and its siblings, the failure, card, refusal and booking lines, the spoken
 * digits) until the caller turns it back to English. A line said before the
 * caller has spoken (the transfer or closing line at the start) is English.
 *
 * A personalised demo call (owner, 24 October 2026: "the demo AYAs and the
 * client AYA should be THE SAME, only difference should be the start"):
 * src/voice/server.ts opens a session in demo mode (deps.demo) for the demo
 * engine agent's socket, /llm-websocket/<secret>/demo. It runs this same
 * class, so the same prompt, VOICE_STYLE, screens, guard, acknowledgements,
 * no-repeat rule and streaming, with three differences:
 *   - the facts come from the clinic's published website, sealed by apps/web
 *     into the call's dynamic variable (@healdesk/catalog demo-call.ts) and
 *     read from call details (demo-facts.ts), never from the database; a
 *     context that does not open (forged, older than two hours, malformed,
 *     missing) hears DEMO_EXPIRED_LINE and the call ends;
 *   - the start: the demo opening line (disclosure.ts, demoVoiceOpening),
 *     with the same two facts, then three stages (owner, 25 October 2026;
 *     demo-facts.ts, DemoStage), each with its own note: intro (who they
 *     are, their role, the choice), role-play (from Aya's "Ring ring!") and
 *     pitch (from her "how was that?"), so no stage's instructions run into
 *     another; a goodbye inside the role-play never ends the call;
 *   - nothing is written or sent anywhere: no answer gate or billing, no
 *     test-mode screen (voice_real_calls governs clinics' calls, and a demo
 *     is no clinic's: no clinic row is read, and no patient's call reaches
 *     this agent), no booking tools (requests only, kept nowhere), no
 *     redial store, no urgent or handover alert, no ops notice, no ingest,
 *     transcript or conversation row, and no transfer: an urgent caller
 *     hears the fixed 9-1-1 line and stays on the call. A phone call-back
 *     demo is an outbound call, which only demo mode lets go on. One
 *     exception, kept nowhere either: an operator's test call (the sealed
 *     context's `test`) has its transcript emailed to hello@ as it ends
 *     (emailDemoTranscript).
 *
 * Nothing here is written to disk or a log but ids, counts and outcomes. The
 * call's words live in this object until the ingest seals them.
 */

const ACTOR: ActorContext = { type: "agent", serviceName: "retell-voice" };

// No apology and no "trouble on my end" (owner, 24 October 2026: "less
// apologetic"): a person at a desk gives direction, not an error message.
export const CLOSED_LINE = "This line isn't taking calls right now. Please try the practice again later. Bye for now!";
export const TRANSFER_LINE = "Let me put you through to the practice team now.";
export const TROUBLE_TRANSFER_LINE = "Let me get you to the team, one sec.";

/**
 * What a silence hears (Retell's reminder_required, up to the agent's
 * reminder_max_count, retell-agent.ts): two short check-ins, never the same
 * twice, then a warm close that ends the call, rather than one line said
 * again and again into a dead line (owner, 24 October 2026).
 */
export const REMINDER_LINES = ["Still with me?", "Hm, you there?"] as const;
export const REMINDER_CLOSE_LINE = "Looks like I lost you. I'll let you go, call back any time!";

/** The lines above, for a call the caller has taken into Spanish. Awaiting a native speaker's review. */
export const CLOSED_LINE_ES = "Esta línea no está atendiendo llamadas ahora. Por favor, intente llamar a la clínica más tarde. Adiós.";
export const TRANSFER_LINE_ES = "Le comunico ahora con el equipo de la clínica.";
export const TROUBLE_TRANSFER_LINE_ES = "Le paso con el equipo, un momento.";
export const REMINDER_LINES_ES = ["¿Sigue ahí?", "¿Me escucha?"] as const;
export const REMINDER_CLOSE_LINE_ES = "Parece que se cortó. Le dejo, ¡llame cuando quiera!";

/**
 * The first time the model fails in a row on a call: a person's reset, not
 * an error message (owner, 24 October 2026). A second failure in a row is
 * put through to the direct line, or hears the plain failure line
 * (turn.ts failureLine), which says to contact the practice. No apology
 * (owner, 24 October 2026: "less apologetic"): a person who missed a word
 * just asks for it again.
 */
export const RETRY_LINE = "Hm, say that one more time for me?";
export const RETRY_LINE_ES = "¿Me lo repite, por favor?";

/** A demo call whose sealed context did not open (forged, stale, malformed or missing): said, then the call ends. */
export const DEMO_EXPIRED_LINE = "This demo link has expired. Please start the demo again from the page.";

/**
 * What a call hears while the model thinks, so there is no dead air (owner,
 * 24 October 2026). The sound of someone thinking rather than a verdict
 * ("Mm.", not "Sure."), so whatever follows (a booking question, a refusal,
 * the failure line) still reads naturally after it. Said once the reply has
 * not started within ACKNOWLEDGE_AFTER_MS (the owner: "no pause for the
 * first word"), picked at random and never the same twice in a row, so it
 * has no pattern. No "okay", which Retell's backchannel and the model's own
 * openers already say.
 */
export const ACKNOWLEDGEMENTS: Readonly<Record<SpokenLanguage, readonly string[]>> = {
  en: ["Mm.", "Hmm.", "Mm-hmm.", "Right.", "Sure."],
  es: ["Mm.", "A ver.", "Ajá.", "Claro."],
};

/** How long the reply may take to start before the acknowledgement is said instead. */
export const ACKNOWLEDGE_AFTER_MS = 200;

/** Words the caller must have said for an acknowledgement: a lone "John" or "nails" is answered straight away anyway. */
const ACKNOWLEDGE_MIN_WORDS = 3;

type VoiceLines = {
  closed: string;
  transfer: string;
  troubleTransfer: string;
  reminders: readonly string[];
  reminderClose: string;
  retry: string;
};
const VOICE_LINES: Readonly<Record<SpokenLanguage, VoiceLines>> = {
  en: {
    closed: CLOSED_LINE,
    transfer: TRANSFER_LINE,
    troubleTransfer: TROUBLE_TRANSFER_LINE,
    reminders: REMINDER_LINES,
    reminderClose: REMINDER_CLOSE_LINE,
    retry: RETRY_LINE,
  },
  es: {
    closed: CLOSED_LINE_ES,
    transfer: TRANSFER_LINE_ES,
    troubleTransfer: TROUBLE_TRANSFER_LINE_ES,
    reminders: REMINDER_LINES_ES,
    reminderClose: REMINDER_CLOSE_LINE_ES,
    retry: RETRY_LINE_ES,
  },
};

type RetellTranscriptEntry = { role?: unknown; content?: unknown };
type RetellEvent = {
  interaction_type?: unknown;
  response_id?: unknown;
  transcript?: unknown;
  timestamp?: unknown;
  call?: {
    from_number?: unknown;
    to_number?: unknown;
    direction?: unknown;
    start_timestamp?: unknown;
    call_id?: unknown;
    retell_llm_dynamic_variables?: unknown;
  };
};

export type RetellOutbound =
  | { response_type: "config"; config: { auto_reconnect: boolean; call_details: boolean } }
  | { response_type: "ping_pong"; timestamp: number }
  | {
      response_type: "response";
      response_id: number;
      content: string;
      content_complete: boolean;
      end_call: boolean;
      transfer_number?: string;
      no_interruption_allowed?: boolean;
    };

export type RetellSessionDeps = {
  responder: AssistantResponder | null;
  transport?: EmailTransport;
  now?: () => Date;
  gate?: (clinicId: string, now: Date) => Promise<AnswerDecision>;
  ingest?: (event: VoiceCallEvent) => Promise<IngestResult>;
  /** Real patients' calls allowed; unset reads HEALDESK_VOICE_REAL_CALLS. */
  realCalls?: boolean;
  screen?: (clinicId: string) => Promise<TestCallScreen>;
  /** Where the call goes when the database cannot be read (fallback-line.ts). */
  fallbackLine?: FallbackLookup;
  /** How long a call that cannot start waits for Retell's call details, which name the number called. */
  callDetailsWaitMs?: number;
  /** How long the gate and the clinic's facts may take before the call falls through. */
  startDeadlineMs?: number;
  /** The booking tool layer; unset builds the shared one for the call (lib/assistant/booking-tools.ts). */
  tools?: (facts: AssistantFacts) => BookingTools | null;
  /** The redial lookup (lib/voice/redial.ts, takeRedialContext); unset uses it. */
  redial?: (clinicId: string, callerPhone: string) => Promise<RedialContext | null>;
  /**
   * Answer with the clinic's facts as a recent call read them (FACTS_FRESH_MS)
   * while this call's own read is still out, so the opening line waits only
   * for the answer gate (owner, 24 October 2026). Only the facts: the gate,
   * which decides pause, suspension and the end of the service, is asked on
   * every call. The call's own read replaces them as soon as it lands. Set by
   * src/voice/server.ts in the running process, never by default.
   */
  cacheFacts?: boolean;
  /** How long a reply may take to start before the acknowledgement is said (ACKNOWLEDGE_AFTER_MS). */
  acknowledgeAfterMs?: number;
  /** The acknowledgement's pick, 0 to 1; Math.random unset. */
  random?: () => number;
  /**
   * A personalised demo call (see the file header): `secret` opens the
   * sealed context (HEALDESK_PROVISION_SECRET; null opens none, so every
   * demo call hears DEMO_EXPIRED_LINE). Set only by src/voice/server.ts, for
   * the demo path. In demo mode nothing above that reaches the database or
   * a vendor is ever called: gate, ingest, screen, fallbackLine, tools,
   * redial and cacheFacts are all left unused.
   */
  demo?: { secret: string | null; detailsWaitMs?: number };
};

/** How long a clinic's facts read by one call may open the next. */
const FACTS_FRESH_MS = 2 * 60_000;

/** The facts the last call for each clinic read, in this process only. */
const recentFacts = new Map<string, { facts: AssistantFacts; at: number }>();

/**
 * A database that hangs rather than refuses (a blackholed route, a stalled
 * failover, a full pool) would otherwise hold the caller in silence for as
 * long as the connection takes to give up, which the pool does not bound.
 */
const START_DEADLINE_MS = 3_000;
/**
 * A start that passed its deadline with no line known anywhere may still be
 * slow rather than dead (the gate also sends ops and clinic email): it gets
 * this much longer to answer the call normally before the closing line.
 */
const LATE_START_GRACE_MS = 5_000;
/** The direct line read alone, for a start that failed rather than hung. */
const LINE_ALONE_DEADLINE_MS = 1_500;
/** The urgent and handover alerts' writes; past it the reply is said without them. */
const ALERT_DEADLINE_MS = 2_000;
/** How long the first reply waits for the redial lookup before answering as an ordinary call. */
const REDIAL_DEADLINE_MS = 1_000;
/** How long a caller waits for Google to take a booking before it becomes a request. */
const BOOKING_BUDGET_MS = 6_000;

/** `promise`, or a rejection once `ms` have passed. Never leaves a timer behind. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type Started = { decision: AnswerDecision; facts: AssistantFacts | null };

class Deadline extends Error {
  constructor() {
    super("passed its deadline");
    this.name = "Deadline";
  }
}

/** Retell sends call details straight after our config; this only bounds a call where it never does. */
const CALL_DETAILS_WAIT_MS = 1_500;
/**
 * A demo call cannot say a word without them (the context is in them), so it
 * waits a little longer than a call falling through, then hears the expired
 * line rather than silence.
 */
const DEMO_CALL_DETAILS_WAIT_MS = 3_000;

/** The caller's words since the agent last spoke, from Retell's transcript. */
export function latestCallerWords(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  const entries = transcript as RetellTranscriptEntry[];
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.role === "agent") break;
    if (entry.role === "user" && typeof entry.content === "string" && entry.content.trim()) out.unshift(entry.content.trim());
  }
  return out.join(" ").slice(0, 2_000);
}

/**
 * What the caller heard of the agent's last reply when they cut in: Retell's
 * transcript holds the part spoken, which is shorter than what was sent.
 * Null when it holds the whole reply, holds none, or does not match.
 */
export function interruptedAt(transcript: unknown, turns: readonly TranscriptTurn[]): string | null {
  if (!Array.isArray(transcript)) return null;
  const entries = transcript as RetellTranscriptEntry[];
  let heard: string | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.role === "agent") {
      heard = typeof entry.content === "string" ? entry.content.trim() : null;
      break;
    }
  }
  const sent = [...turns].reverse().find((t) => t.speaker === "assistant")?.text.trim();
  if (!heard || !sent) return null;
  const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const h = words(heard);
  const t = words(sent);
  // Only a real cut: at least a few words missing, and what was heard is how the reply began.
  if (h.length === 0 || h.length + 3 > t.length) return null;
  if (!h.every((w, i) => t[i] === w)) return null;
  return heard.slice(0, 300);
}

export class RetellCallSession {
  private facts: AssistantFacts | null = null;
  private turns: TranscriptTurn[] = [];
  private capture: BookingCapture = EMPTY_CAPTURE;
  private toolState: BookingToolState = EMPTY_TOOL_STATE;
  private tools: BookingTools | null = null;
  private openedAt: Date;
  private startedAt: Date | null = null;
  private disclosurePlayedAt: Date | null = null;
  /** The language the call is being spoken in, and the evidence for it (call-language.ts). */
  private callLanguage: CallLanguageState = START_LANGUAGE;
  /** The Spanish AI and transcription line has been said on this call. */
  private spanishDisclosed = false;
  private callerPhone: string | null = null;
  /** The AYA number the call came in on, from call details. */
  private calledNumber: string | null = null;
  private calledNumberArrived: () => void = () => {};
  private readonly callDetailsArrived = new Promise<void>((resolve) => {
    this.calledNumberArrived = resolve;
  });
  private outbound = false;
  private urgent = false;
  private handoff = false;
  /** The urgent alert this call raised is not known to be queued: no reply may say the team was told. */
  private urgentUntold = false;
  private handoverAlerted = false;
  /** The lines the carrier says forwarded the call (lib/voice/forwarded-from.ts); in memory only. */
  private forwardedFrom: ForwardedFrom[] = [];
  /** Alerts being sent after their commit; the call's record waits for them. */
  private sending: Promise<void>[] = [];
  private failures = 0;
  private latestResponseId = -1;
  private directLine: string | null = null;
  /** The answer gate said answer: only then can this call be phone's first answer (lib/channels/events.ts). */
  private gateAnswered = false;
  /** AYA gave the caller a real answer at least once, not only the failure line. */
  private answered = false;
  private closing = false;
  /**
   * Refused in test mode: a real clinic's caller, of whom nothing is kept.
   * Set from the start of the check, so a drain that records the call
   * before the check answers keeps nothing either.
   */
  private unrecorded = false;
  /** The record has begun: a late start must not rewrite what it reads. */
  private recording = false;
  /**
   * The socket has closed, told at once by the server rather than in turn
   * behind open(): a start that lands after it says nothing, and nothing is
   * recorded as heard.
   */
  private hungUp = false;
  /**
   * The opening line has not reached the caller: Retell dropped it for a
   * caller who spoke first, it went unsaid because the first reply was
   * urgent, or a late start answered the caller's words instead. The next
   * reply that is not urgent says it first.
   */
  private openingOwed = false;
  /**
   * The newest request that came while the start was still being found (the
   * fall-through): a start that lands late answers it, words and all.
   */
  private pendingStart: RetellEvent | null = null;
  /**
   * The last thing said that ended the call or put it through. Retell keeps
   * only the latest response, so a caller who speaks before it is said, or
   * over it, would otherwise lose the transfer; every later request while
   * closing is answered with it again.
   */
  private final: { content: string; endCall: boolean; transferTo: string | null } | null = null;
  /**
   * The gate refused with a reason after which nothing may be kept
   * (patientDataRefused: the Services ended, the agreement no longer covers
   * the practice, the host's agreement lapsed): the call is put through or
   * closed, and not recorded at hang-up. Set as soon as the gate says so,
   * even when the start then fails and the fall-through takes the call.
   */
  private keepsNothing = false;
  private finished: Promise<IngestResult | null> | null = null;
  /** The redial lookup, started once the call is answered and the number is known. */
  private redialLookup: Promise<RedialContext | null> | null = null;
  /** What the lookup found: the earlier call's last turns. In memory for this call only. */
  private redial: RedialContext | null = null;
  /** The welcome-back line has been said. */
  private welcomedBack = false;
  /** How many acknowledgements this call has said, which picks the next. */
  private acknowledged = 0;
  /** The last acknowledgement said, never said again next. */
  private lastAcknowledgement: string | null = null;
  /** Silences answered so far: the check-ins, then the close. */
  private reminders = 0;
  /** A demo call's context, once opened: the requester's first name and the clinic's profile. In memory only. */
  private demoContext: DemoCallContext | null = null;
  /** Where a demo call is (demo-facts.ts, DemoStage), moved on by Aya's own scripted lines. */
  private demoStage: DemoStage = "intro";
  /** Retell's call object from call details, for a demo call's context; dropped once read. */
  private demoCall: unknown = null;

  constructor(
    readonly clinicId: string,
    readonly callId: string,
    private readonly send: (message: RetellOutbound) => void,
    private readonly deps: RetellSessionDeps,
  ) {
    this.openedAt = this.now();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The fixed lines in the language the call is being spoken in. */
  private get lines(): VoiceLines {
    return VOICE_LINES[this.callLanguage.language];
  }

  /** The language the call is being spoken in: English until the caller turns it (call-language.ts). */
  get language(): SpokenLanguage {
    return this.callLanguage.language;
  }

  /**
   * Send `content` as the end of the response `responseId`. `spokenBefore`
   * is an acknowledgement already sent as that response's first part
   * (Retell appends the parts of one response): the record keeps both.
   * `noInterruption` asks Retell not to let the caller talk over it, for the
   * opening line, whose disclosure must be heard.
   */
  private say(
    responseId: number,
    content: string,
    options: { endCall?: boolean; transferTo?: string | null; spokenBefore?: string | null; noInterruption?: boolean } = {},
  ): void {
    this.turns.push({ speaker: "assistant", text: [options.spokenBefore, content].filter(Boolean).join(" ") });
    if (options.endCall || options.transferTo) this.final = { content, endCall: Boolean(options.endCall), transferTo: options.transferTo ?? null };
    this.send({
      response_type: "response",
      response_id: responseId,
      content: options.spokenBefore ? (content ? ` ${content}` : "") : content,
      content_complete: true,
      end_call: Boolean(options.endCall),
      ...(options.transferTo ? { transfer_number: options.transferTo } : {}),
      ...(options.noInterruption ? { no_interruption_allowed: true } : {}),
    });
  }

  /**
   * The connection is up: configure, ask the gate, and speak first. In test
   * mode the clinic is screened before the config, which asks Retell for the
   * caller's number only once the clinic is known to be made up.
   */
  async open(): Promise<void> {
    if (this.deps.demo) {
      this.openDemo();
      return;
    }
    // One deadline for the whole start, the test-mode check included.
    const startBy = Date.now() + (this.deps.startDeadlineMs ?? START_DEADLINE_MS);
    if (!(this.deps.realCalls ?? voiceRealCallsAllowed()) && !(await this.madeUpClinic(startBy))) return;
    this.send({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    const now = this.now();
    let gated: AnswerDecision | null = null;
    // Nothing here writes the session but keepsNothing: a start that finishes
    // after its deadline changes nothing else unless the fall-through hands
    // it back.
    // The gate and the facts are read side by side, not one after the
    // other: the caller hears nothing until both are in, and reading the
    // facts of a call the gate then refuses writes nothing.
    const reading = withTenant({ clinicId: this.clinicId, actor: ACTOR }, async (tx) =>
      (await clinicHasLeft(tx)) ? null : assistantFacts(tx, { alertTransport: this.deps.transport }),
    );
    reading.catch(() => {});
    const recent = this.deps.cacheFacts ? recentFacts.get(this.clinicId) : undefined;
    const cached = recent && Date.now() - recent.at < FACTS_FRESH_MS ? recent.facts : null;
    if (this.deps.cacheFacts) {
      reading
        .then((fresh) => {
          if (fresh) recentFacts.set(this.clinicId, { facts: fresh, at: Date.now() });
          else recentFacts.delete(this.clinicId);
          // The call opened on a recent read: its own takes over for the
          // turns. Never with nothing: a call with no facts answers nobody,
          // and the gate, asked fresh, has already decided whether to answer.
          if (fresh && cached && this.facts === cached) this.facts = fresh;
        })
        .catch(() => {});
    }
    const started: Promise<Started> = (async () => {
      const decision = await (this.deps.gate ?? voiceAnswerDecision)(this.clinicId, now);
      gated = decision;
      // The one write before the deadline: it only ever keeps less.
      if (decision.decision === "pass_through" && patientDataRefused(decision.reason)) this.keepsNothing = true;
      const facts = cached ?? (await reading);
      return { decision, facts };
    })();
    let result: Started;
    try {
      result = await withDeadline(started, Math.max(0, startBy - Date.now()));
    } catch (error) {
      log.error("retell call could not start", { clinicId: this.clinicId, error: describeError(error) });
      this.closing = true;
      // A gate that answered before the facts failed, even after the
      // deadline, names the line: read when the fall-through decides. A
      // start that failed rather than hung may leave the line readable on its
      // own (fallThrough); one that hung is not asked again.
      const known = () => {
        const decision = gated as AnswerDecision | null;
        return decision?.decision === "pass_through" ? decision.directLine : null;
      };
      this.sending.push(this.fallThrough(known, error instanceof Deadline ? started : null));
      return;
    }
    this.begin(result);
  }

  /** The opening line: the demo's for a demo call, the clinic's (openingLine) otherwise. */
  private openingFor(facts: AssistantFacts): string {
    return this.demoContext
      ? demoVoiceOpening({ clinicName: facts.clinicName, firstName: this.demoContext.firstName })
      : openingLine(facts, "voice");
  }

  /**
   * A demo call's start: ask for call details and return at once, because
   * the details arrive as a message the server hands this session only after
   * open() has returned. The start goes on beside the message chain
   * (startDemo), as the fall-through does.
   */
  private openDemo(): void {
    this.send({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    this.sending.push(this.startDemo());
  }

  /**
   * The call details are in, or did not come in time: open the sealed
   * context and say the demo opening line, or the expired line and end the
   * call. Reads nothing but the call object; writes nothing anywhere.
   */
  private async startDemo(): Promise<void> {
    const wait = this.deps.demo?.detailsWaitMs ?? DEMO_CALL_DETAILS_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.callDetailsArrived,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, wait);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (this.hungUp || this.recording) return;
    const sealed = demoContextFromCall(this.demoCall);
    this.demoCall = null;
    const secret = this.deps.demo?.secret ?? null;
    const context = sealed && secret ? openDemoCallContext(sealed, secret) : null;
    // On the newest request, if the caller spoke while the details came.
    const responseId = Math.max(this.latestResponseId, 0);
    if (!context) {
      log.warn("retell demo call refused: its context did not open", {
        clinicId: this.clinicId,
        callId: this.callId,
        code: !secret ? "no_secret" : sealed ? "not_opened" : "missing",
      });
      this.closing = true;
      this.say(responseId, DEMO_EXPIRED_LINE, { endCall: true });
      return;
    }
    this.demoContext = context;
    const facts = demoAssistantFacts(context);
    this.facts = facts;
    this.disclosurePlayedAt = this.now();
    this.say(responseId, this.openingFor(facts), { noInterruption: true });
    log.info("retell demo call started", { clinicId: this.clinicId, callId: this.callId, source: context.mode, count: facts.services.length });
  }

  /**
   * The gate and the facts are in: transfer, close, or say the opening line.
   * Without the opening line (a late start answering the caller's words), it
   * is owed to the first reply.
   */
  private begin({ decision, facts }: Started, options: { opening?: boolean } = {}): void {
    this.facts = facts;
    // On the newest request, if the caller spoke while the start was slow.
    const responseId = Math.max(this.latestResponseId, 0);
    this.directLine = this.usable(facts?.directLine ?? (decision.decision === "pass_through" ? decision.directLine : null));
    // Kept for a later call that cannot read the database (fallback-line.ts).
    if (facts) rememberDirectLine(this.clinicId, this.usable(facts.directLine), facts.phone);
    // Hung up while the start was read: nothing is said, and nothing heard.
    if (this.hungUp) return;

    const passTo = decision.decision === "pass_through" ? this.usable(decision.directLine) : null;
    if (passTo) {
      // Paused, capped, suspended, or the service ended (the Terms'
      // pass-through, sections 2 and 7): the caller goes to a person, never
      // to silence. Every degradation path ends at the direct line.
      this.closing = true;
      this.say(responseId, this.lines.transfer, { transferTo: passTo });
      return;
    }
    // No direct line, and the clinic has left, its Services have ended, its
    // agreement no longer covers it, or a vendor's agreement on the call's
    // path has lapsed: the call is closed with the fixed line, never
    // answered by the safe script, which is AYA herself.
    if (!facts || (decision.decision === "pass_through" && assistantFallbackRefused(decision.reason))) {
      this.closing = true;
      this.say(responseId, this.lines.closed, { endCall: true });
      return;
    }
    this.gateAnswered = decision.decision === "answer";
    checkMenu(facts, "voice");
    this.startRedialLookup();
    if (options.opening === false) {
      this.openingOwed = true;
      return;
    }
    this.disclosurePlayedAt = this.now();
    // Short since 24 October 2026, and said whole: the caller cannot talk
    // over the disclosure, so it is heard before anything they say is answered.
    this.say(responseId, openingLine(facts, "voice"), { noInterruption: true });
  }

  /**
   * A line this call may be put through to (usableLine): never the number
   * it came in on, once call details have named it, nor the clinic's
   * published or AYA number. The answer gate has already refused the
   * clinic's own published and AYA numbers from the database; this holds the
   * same for the line kept in memory, which test mode's refusal can use when
   * call details are never asked for.
   */
  private usable(line: string | null | undefined): string | null {
    return usableLine(line, [this.calledNumber, this.facts?.phone, this.facts?.assistantNumber]);
  }

  /**
   * Where an urgent call is put through to: the urgent-help number, then the
   * direct line, whichever is set apart from the published number (the one
   * the urgent reply would have read out, turn.ts personNumber), and only
   * if it is usable: never a number that forwards back to us.
   */
  private urgentLine(facts: AssistantFacts): string | null {
    const line = [facts.urgentPhone, facts.directLine].find((n) => n && n !== facts.phone) ?? null;
    return this.usable(line);
  }

  /** The request kept while the start was found, if it is still the newest and has words to answer. */
  private keptRequest(): RetellEvent | null {
    const kept = this.pendingStart;
    this.pendingStart = null;
    return kept && kept.response_id === this.latestResponseId && latestCallerWords(kept.transcript) ? kept : null;
  }

  /**
   * The call could not start: send it to the direct line, known without the
   * database, or close it when nowhere holds one. Runs beside the message
   * chain rather than in it, because the number the call came in on arrives
   * as a message (call details) after this has begun. The record waits for it.
   */
  private async fallThrough(known: () => string | null, late: Promise<Started> | null): Promise<void> {
    // Call details may already have said this is an outbound call, which
    // callDetails has ended (v1 is inbound only): nothing more is said.
    if (this.outbound) return;
    // The slow start's grace runs from its deadline, beside the lookup
    // below, never after it: the caller is already waiting.
    const lateStart = late ? withDeadline(late, LATE_START_GRACE_MS) : null;
    lateStart?.catch(() => {});
    const gateLine = () => {
      const line = usableLine(known(), [this.calledNumber]);
      return line ? { line, source: "gate" } : null;
    };
    let found: { line: string; source: string } | null = gateLine();
    // A start that failed rather than hung (no late start to wait for) may
    // leave the database readable: the direct line, read alone, before the
    // places that hold it without the database. Bounded all the same: a
    // database that refused one query may hang the next.
    if (!found && !late) {
      const line = await withDeadline(this.directLineAlone(), LINE_ALONE_DEADLINE_MS).catch(() => null);
      if (line) found = { line, source: "database" };
    }
    if (!found) {
      await Promise.race([
        this.callDetailsArrived,
        new Promise<void>((resolve) => setTimeout(resolve, this.deps.callDetailsWaitMs ?? CALL_DETAILS_WAIT_MS).unref?.()),
      ]);
      try {
        found = await (this.deps.fallbackLine ?? fallbackLineFor)({ clinicId: this.clinicId, calledNumber: this.calledNumber });
      } catch {
        found = null;
      }
    }
    if (this.outbound) return;
    // A line that would send the caller back to us is no line at all; and a
    // slow gate may have named one while the lookup ran.
    if (found && !usableLine(found.line, [this.calledNumber])) found = null;
    found ??= gateLine();
    if (!found && lateStart) {
      // Nowhere holds a line, and the start was slow rather than failed:
      // give it longer to answer the call normally before closing.
      try {
        const result = await lateStart;
        // Hung up meanwhile: the record has begun, and nothing was heard.
        if (this.outbound || this.recording || this.hungUp) return;
        log.warn("retell call started late", { clinicId: this.clinicId });
        this.closing = false;
        // The caller spoke into the silence: the start answers that request,
        // so their words reach the urgent screen and the record, rather than
        // the bare opening line taking its place.
        const kept = this.keptRequest();
        this.begin(result, { opening: !kept });
        if (kept && !this.closing) {
          try {
            await this.respond({ ...kept, interaction_type: "response_required" });
          } catch (error) {
            this.respondFailed(kept, error);
          }
        }
        return;
      } catch {
        if (this.outbound) return;
      }
      found = gateLine();
    }
    if (this.recording || this.hungUp) {
      // Hung up, or the process is shutting down, before anything was said:
      // nothing to say, nowhere it went.
      void notifyOps("voice_call_start_failed", { clinicId: this.clinicId, code: "hung_up" });
      return;
    }
    // The latest request, if the caller has spoken while this was found.
    const responseId = Math.max(this.latestResponseId, 0);
    const line = found ? usableLine(found.line, [this.calledNumber]) : null;
    if (found && line) {
      this.say(responseId, this.lines.troubleTransfer, { transferTo: line });
    } else {
      found = null;
      this.say(responseId, this.lines.closed, { endCall: true });
    }
    // Not awaited: with the database hanging, the alert's own write could
    // hold the call's record, and the process's drain, until it gave up.
    void notifyOps("voice_call_start_failed", { clinicId: this.clinicId, code: found ? `transferred_${found.source}` : "closed" });
  }

  /**
   * The clinic's direct line, read alone for a call whose start failed, with
   * the numbers it must not be (usableLine); null when that fails too.
   */
  private async directLineAlone(): Promise<string | null> {
    try {
      return await withTenant({ clinicId: this.clinicId, actor: ACTOR }, async (tx) => {
        const [row] = await tx.db
          .select({ line: clinicSettings.directLineE164, published: clinics.publishedPhoneE164, assistant: clinics.assistantNumberE164 })
          .from(clinicSettings)
          .innerJoin(clinics, eq(clinics.id, clinicSettings.clinicId))
          .where(eq(clinicSettings.clinicId, tx.clinicId))
          .limit(1);
        return usableLine(row?.line, [row?.published, row?.assistant]);
      });
    } catch (error) {
      log.error("retell direct line not read", { clinicId: this.clinicId, error: describeError(error) });
      return null;
    }
  }

  /**
   * Test mode: true for a made-up clinic. Otherwise the caller has already
   * been put through to the clinic's direct line, or heard CLOSED_LINE, and
   * the call is marked to be forgotten. A failed check fails closed, and so
   * does one still out at the start's deadline (a database that hangs): the
   * caller goes to the line this process remembers for the clinic, if any,
   * else hears the closing line, never silence. Ops hears of every refusal.
   */
  private async madeUpClinic(startBy: number): Promise<boolean> {
    this.unrecorded = true;
    let screen: TestCallScreen | null = null;
    try {
      screen = await withDeadline((this.deps.screen ?? screenTestCall)(this.clinicId), Math.max(0, startBy - Date.now()));
    } catch (error) {
      log.error("retell test-call check failed", { clinicId: this.clinicId, error: describeError(error) });
    }
    if (screen?.madeUp && !this.closing) {
      this.unrecorded = false;
      return true;
    }
    if (screen?.madeUp) return false;
    log.warn("retell call refused: real calls are off and the clinic is not made up", { clinicId: this.clinicId });
    this.closing = true;
    this.send({ response_type: "config", config: { auto_reconnect: true, call_details: false } });
    const line = usableLine(screen ? screen.directLine : rememberedDirectLine(this.clinicId), [this.calledNumber]);
    if (line) this.say(0, TRANSFER_LINE, { transferTo: line });
    else this.say(0, CLOSED_LINE, { endCall: true });
    // Not awaited: the database may be what failed the check.
    void notifyOps("voice_test_mode_refused", {
      clinicId: this.clinicId,
      phase: screen ? "not_made_up" : "check_failed",
      code: line ? "transferred" : "closed",
    });
    return false;
  }

  /** The socket closed. Called at once, before the record waits its turn. */
  socketClosed(): void {
    this.hungUp = true;
  }

  /** One message from Retell. Never throws: a fault is logged and the caller hears a fixed line. */
  async handle(raw: string): Promise<void> {
    let event: RetellEvent;
    try {
      event = JSON.parse(raw) as RetellEvent;
    } catch {
      return;
    }
    switch (event.interaction_type) {
      case "ping_pong":
        if (typeof event.timestamp === "number") this.send({ response_type: "ping_pong", timestamp: event.timestamp });
        return;
      case "call_details":
        this.callDetails(event);
        return;
      case "update_only":
        return;
      case "reminder_required":
      case "response_required":
        try {
          await this.respond(event);
        } catch (error) {
          this.respondFailed(event, error);
        }
        return;
      default:
        return;
    }
  }

  private callDetails(event: RetellEvent): void {
    if (this.deps.demo) {
      // Only the call object, for the sealed context: no caller's number,
      // no forwarding lines, no redial. A demo call-back is outbound, and
      // goes on.
      this.demoCall ??= event.call ?? null;
      this.calledNumberArrived();
      return;
    }
    const call = event.call ?? {};
    if (typeof call.from_number === "string" && call.from_number.trim()) this.callerPhone = call.from_number.trim();
    if (typeof call.to_number === "string" && call.to_number.trim()) this.calledNumber = call.to_number.trim();
    this.calledNumberArrived();
    if (typeof call.start_timestamp === "number") this.startedAt = new Date(call.start_timestamp);

    this.forwardedFrom = forwardedFromCall(event.call);
    if (call.direction !== "outbound") this.startRedialLookup();
    if (call.direction === "outbound") {
      // healdesk places no calls. A call the vendor says we placed is a
      // misconfiguration: say nothing more, end it, and let the ingest
      // record the refusal as a security event.
      this.outbound = true;
      this.closing = true;
      // A refused test call is not ingested, so its security event is this line.
      if (this.unrecorded) log.error("retell outbound call refused", { clinicId: this.clinicId });
      this.final = { content: "", endCall: true, transferTo: null };
      this.send({ response_type: "response", response_id: Math.max(this.latestResponseId, 0), content: "", content_complete: true, end_call: true });
    }
  }

  /**
   * Look for a cut-off call from this number, once: only on a call AYA is
   * answering (the facts are read and nothing is closing it), never a
   * refused test call, and only with the caller's number.
   */
  private startRedialLookup(): void {
    if (this.redialLookup || this.deps.demo || !this.facts || this.closing || this.unrecorded || this.keepsNothing || this.outbound || !this.callerPhone) return;
    const lookup = this.deps.redial ?? ((clinicId, phone) => takeRedialContext(clinicId, phone, ACTOR));
    this.redialLookup = lookup(this.clinicId, this.callerPhone).catch((error) => {
      log.error("redial lookup failed", { clinicId: this.clinicId, error: describeError(error) });
      return null;
    });
  }

  /** The lookup's answer, waited for briefly on the first reply; null afterwards is an ordinary call. */
  private async redialContext(): Promise<RedialContext | null> {
    if (this.redial || !this.redialLookup) return this.redial;
    const lookup = this.redialLookup;
    try {
      this.redial = await withDeadline(lookup, REDIAL_DEADLINE_MS);
    } catch {
      this.redial = null;
    }
    // Asked once: a lookup that answered late is not used.
    this.redialLookup = Promise.resolve(this.redial);
    return this.redial;
  }

  private async respond(event: RetellEvent): Promise<void> {
    const responseId = typeof event.response_id === "number" ? event.response_id : NaN;
    if (!Number.isInteger(responseId) || responseId < 0) return;
    this.latestResponseId = Math.max(this.latestResponseId, responseId);
    if (this.closing) {
      if (responseId !== this.latestResponseId) return;
      // Answer again with the transfer or the goodbye, on the newest id.
      if (this.final) {
        this.send({
          response_type: "response",
          response_id: responseId,
          content: this.final.content,
          content_complete: true,
          end_call: this.final.endCall,
          ...(this.final.transferTo ? { transfer_number: this.final.transferTo } : {}),
        });
      } else if (!this.recording) {
        // Nothing said yet: the start is still being found. Kept, so a
        // start that lands late answers these words rather than drop them.
        this.pendingStart = event;
      }
      return;
    }
    if (!this.facts) return;

    if (event.interaction_type === "reminder_required") {
      const lines = this.lines;
      const index = this.reminders++;
      if (index < lines.reminders.length) this.say(responseId, lines.reminders[index]!);
      else {
        this.closing = true;
        this.say(responseId, lines.reminderClose, { endCall: true });
      }
      return;
    }
    const words = latestCallerWords(event.transcript);
    if (!words) return;
    // The turn's timing, from Retell asking for an answer: when the caller
    // first heard something and when the answer was complete. Logged once
    // the answer is said, as numbers only (owner, 24 October 2026).
    const askedAt = Date.now();
    let firstHeardAt: number | null = null;
    const heard = () => {
      firstHeardAt ??= Date.now();
    };

    const facts = this.facts;
    const resumed = await this.redialContext();
    // The language these words leave the call in. Kept only once this
    // answer is said: a newer request carries these words again, and must
    // not count them twice.
    const language = nextCallLanguage(this.callLanguage, words, {
      knownTerms: languageTerms(facts),
      spanishAllowed: facts.languages.includes("es"),
    });
    // A demo call books nothing and takes requests only, kept nowhere.
    this.tools ??= this.deps.demo
      ? null
      : this.deps.tools
      ? this.deps.tools(facts)
      : bookingTools({
          clinicId: this.clinicId,
          channel: "voice",
          holderKey: `retell:${this.callId}`,
          bookingKey: `retell:${this.callId}:1`,
          conversationId: null,
          timeZone: facts.timeZone,
          actor: ACTOR,
          budgetMs: BOOKING_BUDGET_MS,
          // A call the gate let in is not cut off by the cap (R18); the safe
          // script's call is asked about the cap again, and a pause stops both.
          answering: { continuing: this.gateAnswered },
        });
    // A short acknowledgement while the model thinks, only where nothing
    // must come first: not before an owed opening line, the Spanish line or
    // the welcome-back line, and not for a word or two.
    let acknowledgement: string | null = null;
    // The opening line is owed when Retell dropped it (no agent words in its
    // transcript yet), which is settled after the answer below; asked here
    // too, so nothing is ever said ahead of it.
    const agentSpokeYet = Array.isArray(event.transcript) && (event.transcript as RetellTranscriptEntry[]).some((e) => e.role === "agent");
    // Nothing may go ahead of the reply's fixed beginnings: an owed opening
    // line, the Spanish line the first time, the welcome-back line. While one
    // is due, the reply is neither acknowledged nor spoken as it is written.
    const nothingDue =
      !this.openingOwed &&
      !(this.disclosurePlayedAt && !agentSpokeYet) &&
      !(language.language === "es" && !this.spanishDisclosed) &&
      !(resumed && !this.welcomedBack);
    const acknowledgeable =
      nothingDue &&
      // In the caller's own language only: no English "Okay." to Spanish words.
      messageLanguage(words, { knownTerms: languageTerms(facts) }) === language.language &&
      words.split(/\s+/).filter(Boolean).length >= ACKNOWLEDGE_MIN_WORDS &&
      !/[()[\]]/.test(words);
    // The reply's sentences as they are written and guarded (turn.ts, speak),
    // appended to the response after the acknowledgement.
    let streamed = "";
    const ackLines = ACKNOWLEDGEMENTS[language.language];
    const ackChoices = ackLines.filter((line) => line !== this.lastAcknowledgement);
    const ackLine = ackChoices[Math.floor((this.deps.random ?? Math.random)() * ackChoices.length)] ?? ackChoices[0]!;
    // Said only if the reply has not started by then: the first sentence,
    // or the end of the turn, stops it.
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const stopAck = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
    };
    const turn = await answerTurn({
      facts,
      channel: "voice",
      acknowledge: acknowledgeable
        ? {
            line: ackLine,
            say: () => {
              ackTimer = setTimeout(() => {
                ackTimer = null;
                // Not for a request a newer one has already replaced.
                if (responseId !== this.latestResponseId || this.closing || streamed) return;
                this.send({ response_type: "response", response_id: responseId, content: ackLine, content_complete: false, end_call: false });
                acknowledgement = ackLine;
                this.acknowledged += 1;
                this.lastAcknowledgement = ackLine;
                heard();
              }, this.deps.acknowledgeAfterMs ?? ACKNOWLEDGE_AFTER_MS);
            },
          }
        : null,
      speak: nothingDue
        ? (sentence: string) => {
            stopAck();
            if (responseId !== this.latestResponseId || this.closing) return;
            const lead = acknowledgement || streamed ? " " : "";
            this.send({ response_type: "response", response_id: responseId, content: `${lead}${sentence}`, content_complete: false, end_call: false });
            streamed = streamed ? `${streamed} ${sentence}` : sentence;
            heard();
          }
        : null,
      interruptedAt: interruptedAt(event.transcript, this.turns),
      history: this.turns,
      text: words,
      capture: this.capture,
      responder: this.deps.responder,
      now: this.now(),
      tools: this.tools,
      toolState: this.toolState,
      callerPhone: this.callerPhone,
      resumed: resumed ? redialPromptBlock(resumed) : null,
      language: language.language,
      // A demo call is never put through anywhere.
      urgentTransferTo: this.deps.demo ? null : this.urgentLine(facts),
      // The note for the stage the demo is in (demo-facts.ts), so no stage's
      // instructions are ever repeated into another, a role-play above all.
      notes: this.demoContext ? [demoStageNote(this.demoContext, this.demoStage, this.now().getTime())] : null,
    }).finally(stopAck);
    // The caller spoke again while this was being answered: the newer
    // request carries these words too, so this answer is dropped unsaid.
    if (responseId !== this.latestResponseId || this.closing) return;
    this.callLanguage = language;

    this.turns.push({ speaker: "person", text: turn.personText });
    this.capture = turn.capture;
    this.toolState = turn.toolState;
    this.handoff ||= turn.handoff;
    // A demo's stage moves on only with an answer that is said. A goodbye
    // inside the role-play, its "patient" signing off included, never ends
    // the call: the pitch comes after it.
    const stageBefore = this.demoStage;
    if (this.demoContext && turn.source !== "fallback") this.demoStage = nextDemoStage(stageBefore, turn.reply);
    const ends = turn.end && !(this.demoContext && stageBefore === "roleplay");

    let urgentQueued = false;
    if (turn.urgent && !this.urgent && this.deps.demo) {
      // A demo call raises no alert: the fixed urgent line, never saying the team was told.
      this.urgent = true;
      this.urgentUntold = true;
    } else if (turn.urgent && !this.urgent) {
      this.urgent = true;
      const writing = withTenant({ clinicId: this.clinicId, actor: ACTOR }, (tx) =>
        notifyBookingAlert(tx, "urgent", { callId: this.callId, channel: "voice" }),
      );
      // A transaction that fails, now or after the deadline, never queued
      // the row: ops is told, to phone the clinic. notifyBookingAlert tells
      // ops itself when only its savepoint failed (it then returns false).
      writing.catch(() => urgentAlertNotQueued(this.clinicId, { channel: "voice", callId: this.callId }));
      try {
        // Bounded, so a database that hangs never holds the urgent reply.
        urgentQueued = await withDeadline(writing, ALERT_DEADLINE_MS);
      } catch (error) {
        log.error("retell urgent alert not raised", { clinicId: this.clinicId, error: describeError(error) });
      }
      this.urgentUntold = !urgentQueued;
    }
    // L11: the caller asked for a person. Once per call, and not after an
    // urgent alert, which already has the clinic looking at it. Kept for
    // Bookings' Needs you as well as alerted (lib/handovers/record.ts).
    if (turn.handoff && !this.handoverAlerted && !this.urgent && !this.deps.demo) {
      this.handoverAlerted = true;
      try {
        await withDeadline(
          withTenant({ clinicId: this.clinicId, actor: ACTOR }, (tx) =>
            raiseHandover(tx, { channel: "voice", callId: this.callId }),
          ),
          ALERT_DEADLINE_MS,
        );
      } catch (error) {
        log.error("retell handover alert not raised", { clinicId: this.clinicId, error: describeError(error) });
      }
    }

    if (turn.source !== "fallback") this.answered = true;
    let reply0 = turn.reply;
    if (turn.source === "fallback") {
      this.failures += 1;
      const line = this.usable(this.directLine);
      if (this.failures >= 2 && line) {
        this.closing = true;
        this.say(responseId, this.lines.troubleTransfer, { transferTo: line, spokenBefore: acknowledgement });
        return;
      }
      // The first failure in a row asks again like a person; a second, with
      // no line to put the caller through to, keeps the plain failure line.
      if (this.failures === 1) reply0 = this.lines.retry;
    } else {
      this.failures = 0;
    }
    if (ends) this.closing = true;
    // Retell keeps only the latest response: a caller who spoke before the
    // opening line went out may never have heard it. Retell's transcript
    // then holds no word of the agent's, and the opening line is owed. It
    // comes first in the next reply that is not urgent: an urgent reply
    // must not wait behind it (and says it is an AI itself), so the line
    // stays owed past it, whatever the transcript then holds. The call's
    // disclosure_played_at is when it was said.
    const agentSpoke = Array.isArray(event.transcript) && (event.transcript as RetellTranscriptEntry[]).some((e) => e.role === "agent");
    if (this.disclosurePlayedAt && !agentSpoke) {
      this.disclosurePlayedAt = null;
      this.openingOwed = true;
    }
    // The fixed urgent reply says the team was told only while the alert
    // would reach the clinic (facts.urgentAlertsReady); while this call's
    // alert is not known to be queued, it must not say so either.
    let reply = turn.urgent && this.urgentUntold ? withoutTeamTold(reply0) : reply0;
    // A call back after a cut-off call: the fixed welcome-back line, once,
    // before the first reply that is not urgent, after the opening line.
    // It says the team was told only while that is true (welcomeBackLine).
    if (resumed && !this.welcomedBack && !turn.urgent) {
      reply = `${welcomeBackLine(resumed, facts.urgentAlertsReady === true)} ${reply}`;
      this.welcomedBack = true;
    }
    // The call has turned to Spanish for the first time: the AI and
    // transcription line in Spanish, before the reply and once per call.
    // Like the opening line, never in front of an urgent reply, which says
    // it is an AI itself (in Spanish, for Spanish words): it stays owed.
    if (this.callLanguage.language === "es" && !this.spanishDisclosed && !turn.urgent) {
      reply = `${voiceDisclosureEs({ clinicName: facts.clinicName })} ${reply}`;
      this.spanishDisclosed = true;
      log.info("retell spanish disclosure said", { clinicId: this.clinicId });
    }
    if (this.openingOwed && !turn.urgent) {
      reply = `${this.openingFor(facts)} ${reply}`;
      this.openingOwed = false;
      this.disclosurePlayedAt = this.now();
    }
    // An urgent turn at a practice with a line that reaches a person: the
    // fixed reply ends "I'll put you through", and the call is.
    const transferTo = turn.urgent ? (turn.transferTo ?? null) : null;
    if (transferTo) this.closing = true;
    // Spoken as it was written: only what is left goes now, after the
    // acknowledgement and the sentences already sent (turn.ts, `spoken`).
    const already = turn.spoken && reply.startsWith(turn.spoken) ? turn.spoken : "";
    this.say(responseId, already ? reply.slice(already.length).trim() : reply, {
      endCall: ends && !transferTo,
      transferTo,
      spokenBefore: [acknowledgement, already].filter(Boolean).join(" ") || null,
    });
    heard();
    log.info("retell turn timing", {
      clinicId: this.clinicId,
      callId: this.callId,
      source: turn.source,
      ms: (firstHeardAt ?? Date.now()) - askedAt,
      totalMs: Date.now() - askedAt,
    });
    // The urgent alert is critical: sent in-process once its row has
    // committed, after the caller has heard the reply, so the line never
    // waits on an email. It never rejects; whatever it misses, the minute
    // queue sends.
    if (urgentQueued) this.sending.push(deliverCriticalAfterCommit(this.clinicId, { transport: this.deps.transport }));
  }

  /**
   * Answering a turn threw (anything outside the model, whose own failure
   * answerTurn already turns into FAILURE_LINE): the caller goes to the
   * direct line, or hears the failure line, never silence.
   */
  private respondFailed(event: RetellEvent, error: unknown): void {
    log.error("retell turn failed", { clinicId: this.clinicId, error: describeError(error) });
    const responseId = typeof event.response_id === "number" ? event.response_id : NaN;
    if (this.closing || !Number.isInteger(responseId) || responseId < this.latestResponseId) return;
    const line = this.usable(this.directLine);
    if (line) {
      this.closing = true;
      this.say(responseId, this.lines.troubleTransfer, { transferTo: line });
      return;
    }
    this.failures += 1;
    this.say(responseId, failureLine(this.callLanguage.language));
  }

  /** What the caller asked the desk for, as the ingest reads it. */
  private requestFor(): Pick<VoiceCallEvent, "outcome" | "booking" | "collectedFields" | "callerName"> {
    const c = this.capture;
    // The tool layer booked or logged it during the call, under the call's
    // key: the ingest links it to the conversation and files nothing more.
    // Nothing booked or logged by it (the caller hung up first): what they
    // asked for still reaches the desk, as below.
    if (this.toolState.done) return { outcome: "booked", callerName: c.firstName ?? undefined };
    // A request needs the caller's number, which is how the desk reaches
    // them (bookingRequestFrom refuses one without a contact), and a time.
    if (c.wants && c.window && this.callerPhone) {
      return {
        outcome: "booked",
        callerName: c.firstName ?? undefined,
        booking: { preferredWindow: c.window, alternativeWindows: c.altWindows, treatment: c.service ?? undefined },
        collectedFields: c.fields,
      };
    }
    return { outcome: this.urgent || this.handoff ? "escalated_to_human" : this.turns.some((t) => t.speaker === "person") ? "qualified_no_booking" : "abandoned" };
  }

  /**
   * An operator's test demo call (DemoCallContext.test, sealed by apps/web
   * only for someone signed in to /admin): its transcript, rendered exactly
   * as a clinic's (transcript-email.ts) and sent the same way, through SES,
   * to hello@, the one mailbox, which stands in for the clinic on a test
   * (owner, 25 October 2026). Nothing is queued or kept: no outbox row, no
   * conversation, so a failed send is logged and not retried. A prospect's
   * demo call never comes here (the Privacy page: no transcript is kept).
   * Never throws.
   */
  private async emailDemoTranscript(context: DemoCallContext): Promise<string> {
    if (!this.turns.some((t) => t.speaker === "person")) return "caller_silent";
    const clinicName = context.clinic.clinicName;
    const clinicId = this.facts?.clinicId ?? `demo:${context.slug}`;
    try {
      const rendered = renderTranscriptEmail({
        conversationId: randomUUID(),
        clinic: { id: clinicId, name: clinicName, timeZone: this.facts?.timeZone ?? DEMO_TIME_ZONE, audience: audienceFor(context.clinic.specialty) },
        channel: "voice",
        startedAt: this.startedAt ?? this.openedAt,
        turns: this.turns,
      });
      const result = await sendTranscriptEmail(rendered, { to: SENDER_IDENTITY.replyTo, clinicId, clinicName }, { transport: this.deps.transport });
      if (result.status === "sent") return "transcript_sent";
      log.error("retell demo transcript not sent", { callId: this.callId, transport: result.transport, reason: result.reason });
    } catch (error) {
      log.error("retell demo transcript not sent", { callId: this.callId, error: describeError(error) });
    }
    return "transcript_failed";
  }

  /** The socket closed: record the call once, however many times this is called. */
  finish(): Promise<IngestResult | null> {
    this.finished ??= this.record();
    return this.finished;
  }

  private async record(): Promise<IngestResult | null> {
    this.recording = true;
    this.closing = true;
    // The earlier call's turns were for this call's replies only.
    this.redial = null;
    this.redialLookup = null;
    if (this.deps.demo) {
      // A demo call keeps nothing: no conversation, no minutes, no transcript
      // row. An operator's test call alone emails its transcript to hello@.
      const status = this.demoContext?.test ? await this.emailDemoTranscript(this.demoContext) : "nothing_kept";
      log.info("retell demo call ended", { clinicId: this.clinicId, callId: this.callId, count: this.turns.length, status });
      this.turns = [];
      this.demoContext = null;
      this.demoCall = null;
      return null;
    }
    if (this.unrecorded) {
      this.turns = [];
      this.callerPhone = null;
      return null;
    }
    await Promise.all(this.sending);
    if (this.keepsNothing) {
      // Nothing may be kept for this call: no conversation, no minutes, no transcript.
      log.info("retell call not recorded: nothing may be kept", { clinicId: this.clinicId });
      this.turns = [];
      return null;
    }
    const endedAt = this.now();
    const startedAt = this.startedAt ?? this.openedAt;
    const event: VoiceCallEvent = {
      externalCallId: this.callId,
      clinicId: this.clinicId,
      callerPhone: this.callerPhone ?? undefined,
      ...(this.forwardedFrom.length > 0 ? { forwardedFrom: this.forwardedFrom } : {}),
      startedAt,
      endedAt,
      durationSeconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      isCallback: this.outbound,
      answeredByAssistant: this.gateAnswered && this.answered,
      urgent: this.urgent,
      disclosurePlayedAt: this.disclosurePlayedAt ?? undefined,
      transcriptTurns: this.turns.some((t) => t.speaker === "person") ? this.turns : undefined,
      ...this.requestFor(),
    };
    try {
      const result = await (this.deps.ingest ?? ((e) => ingestCall(e, ACTOR, { transport: this.deps.transport })))(event);
      log.info("retell call recorded", {
        clinicId: this.clinicId,
        conversationId: result.conversationId,
        outcome: event.outcome ?? "none",
        count: this.turns.length,
        // The transcript's: queued for the clinic, or why none was.
        status: result.transcriptEmailId ? "queued" : result.duplicate ? "duplicate" : event.transcriptTurns ? "none" : "caller_silent",
      });
      return result;
    } catch (error) {
      log.error("retell call not recorded", { clinicId: this.clinicId, error: describeError(error) });
      return null;
    } finally {
      this.turns = [];
      this.forwardedFrom = [];
    }
  }
}
