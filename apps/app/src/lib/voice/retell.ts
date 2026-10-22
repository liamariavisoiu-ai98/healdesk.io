import { eq } from "drizzle-orm";

import { clinics, clinicSettings } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { bookingTools, EMPTY_TOOL_STATE, type BookingTools, type BookingToolState } from "@/lib/assistant/booking-tools";
import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { openingLine } from "@/lib/assistant/opening";
import { answerTurn, EMPTY_CAPTURE, FAILURE_LINE, type AssistantResponder, type BookingCapture } from "@/lib/assistant/turn";
import { assistantFallbackRefused, patientDataRefused, voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { deliverCriticalAfterCommit } from "@/lib/email/outbox";
import { raiseHandover } from "@/lib/handovers/record";
import { describeError, log } from "@/lib/log";
import { notifyBookingAlert, urgentAlertNotQueued, withoutTeamTold } from "@/lib/notices/booking-alerts";
import { notifyOps } from "@/lib/ops/notify";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { fallbackLineFor, rememberDirectLine, rememberedDirectLine, usableLine, type FallbackLookup } from "./fallback-line";
import { forwardedFromCall, type ForwardedFrom } from "./forwarded-from";
import { ingestCall, type IngestResult, type VoiceCallEvent } from "./ingest";
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
 *                   before anything else, with the call's transcription and
 *                   that no audio is kept (lib/compliance/disclosure.ts),
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
 *                   (lib/notices/booking-alerts.ts).
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
 * Nothing here is written to disk or a log but ids, counts and outcomes. The
 * call's words live in this object until the ingest seals them.
 */

const ACTOR: ActorContext = { type: "agent", serviceName: "retell-voice" };

export const CLOSED_LINE = "I'm sorry, this line can't take calls right now. Please try the practice again later. Goodbye.";
export const TRANSFER_LINE = "Let me put you through to the practice team now.";
export const TROUBLE_TRANSFER_LINE = "I'm having trouble on my end, so let me put you through to the practice team.";
export const REMINDER_LINE = "Are you still there? I'm happy to help with anything else.";

type RetellTranscriptEntry = { role?: unknown; content?: unknown };
type RetellEvent = {
  interaction_type?: unknown;
  response_id?: unknown;
  transcript?: unknown;
  timestamp?: unknown;
  call?: { from_number?: unknown; to_number?: unknown; direction?: unknown; start_timestamp?: unknown; call_id?: unknown };
};

export type RetellOutbound =
  | { response_type: "config"; config: { auto_reconnect: boolean; call_details: boolean } }
  | { response_type: "ping_pong"; timestamp: number }
  | { response_type: "response"; response_id: number; content: string; content_complete: true; end_call: boolean; transfer_number?: string };

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
};

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

export class RetellCallSession {
  private facts: AssistantFacts | null = null;
  private turns: TranscriptTurn[] = [];
  private capture: BookingCapture = EMPTY_CAPTURE;
  private toolState: BookingToolState = EMPTY_TOOL_STATE;
  private tools: BookingTools | null = null;
  private openedAt: Date;
  private startedAt: Date | null = null;
  private disclosurePlayedAt: Date | null = null;
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

  private say(responseId: number, content: string, options: { endCall?: boolean; transferTo?: string | null } = {}): void {
    this.turns.push({ speaker: "assistant", text: content });
    if (options.endCall || options.transferTo) this.final = { content, endCall: Boolean(options.endCall), transferTo: options.transferTo ?? null };
    this.send({
      response_type: "response",
      response_id: responseId,
      content,
      content_complete: true,
      end_call: Boolean(options.endCall),
      ...(options.transferTo ? { transfer_number: options.transferTo } : {}),
    });
  }

  /**
   * The connection is up: configure, ask the gate, and speak first. In test
   * mode the clinic is screened before the config, which asks Retell for the
   * caller's number only once the clinic is known to be made up.
   */
  async open(): Promise<void> {
    // One deadline for the whole start, the test-mode check included.
    const startBy = Date.now() + (this.deps.startDeadlineMs ?? START_DEADLINE_MS);
    if (!(this.deps.realCalls ?? voiceRealCallsAllowed()) && !(await this.madeUpClinic(startBy))) return;
    this.send({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    const now = this.now();
    let gated: AnswerDecision | null = null;
    // Nothing here writes the session but keepsNothing: a start that finishes
    // after its deadline changes nothing else unless the fall-through hands
    // it back.
    const started: Promise<Started> = (async () => {
      const decision = await (this.deps.gate ?? voiceAnswerDecision)(this.clinicId, now);
      gated = decision;
      // The one write before the deadline: it only ever keeps less.
      if (decision.decision === "pass_through" && patientDataRefused(decision.reason)) this.keepsNothing = true;
      const facts = await withTenant({ clinicId: this.clinicId, actor: ACTOR }, async (tx) => ((await clinicHasLeft(tx)) ? null : assistantFacts(tx)));
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
      this.say(responseId, TRANSFER_LINE, { transferTo: passTo });
      return;
    }
    // No direct line, and the clinic has left, its Services have ended, its
    // agreement no longer covers it, or a vendor's agreement on the call's
    // path has lapsed: the call is closed with the fixed line, never
    // answered by the safe script, which is AYA herself.
    if (!facts || (decision.decision === "pass_through" && assistantFallbackRefused(decision.reason))) {
      this.closing = true;
      this.say(responseId, CLOSED_LINE, { endCall: true });
      return;
    }
    this.gateAnswered = decision.decision === "answer";
    if (options.opening === false) {
      this.openingOwed = true;
      return;
    }
    this.disclosurePlayedAt = this.now();
    this.say(responseId, openingLine(facts, "voice"));
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
      this.say(responseId, TROUBLE_TRANSFER_LINE, { transferTo: line });
    } else {
      found = null;
      this.say(responseId, CLOSED_LINE, { endCall: true });
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
    const call = event.call ?? {};
    if (typeof call.from_number === "string" && call.from_number.trim()) this.callerPhone = call.from_number.trim();
    if (typeof call.to_number === "string" && call.to_number.trim()) this.calledNumber = call.to_number.trim();
    this.calledNumberArrived();
    if (typeof call.start_timestamp === "number") this.startedAt = new Date(call.start_timestamp);

    this.forwardedFrom = forwardedFromCall(event.call);
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
      this.say(responseId, REMINDER_LINE);
      return;
    }
    const words = latestCallerWords(event.transcript);
    if (!words) return;

    const facts = this.facts;
    this.tools ??= this.deps.tools
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
    const turn = await answerTurn({
      facts,
      channel: "voice",
      history: this.turns,
      text: words,
      capture: this.capture,
      responder: this.deps.responder,
      now: this.now(),
      tools: this.tools,
      toolState: this.toolState,
      callerPhone: this.callerPhone,
    });
    // The caller spoke again while this was being answered: the newer
    // request carries these words too, so this answer is dropped unsaid.
    if (responseId !== this.latestResponseId || this.closing) return;

    this.turns.push({ speaker: "person", text: turn.personText });
    this.capture = turn.capture;
    this.toolState = turn.toolState;
    this.handoff ||= turn.handoff;

    let urgentQueued = false;
    if (turn.urgent && !this.urgent) {
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
    if (turn.handoff && !this.handoverAlerted && !this.urgent) {
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
    if (turn.source === "fallback") {
      this.failures += 1;
      const line = this.usable(this.directLine);
      if (this.failures >= 2 && line) {
        this.closing = true;
        this.say(responseId, TROUBLE_TRANSFER_LINE, { transferTo: line });
        return;
      }
    } else {
      this.failures = 0;
    }
    if (turn.end) this.closing = true;
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
    // The fixed urgent reply says the team was told; while the alert is not
    // known to be queued, it must not (URGENT_ALERT_DELIVERED).
    let reply = turn.urgent && this.urgentUntold ? withoutTeamTold(turn.reply) : turn.reply;
    if (this.openingOwed && !turn.urgent) {
      reply = `${openingLine(facts, "voice")} ${reply}`;
      this.openingOwed = false;
      this.disclosurePlayedAt = this.now();
    }
    this.say(responseId, reply, { endCall: turn.end });
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
      this.say(responseId, TROUBLE_TRANSFER_LINE, { transferTo: line });
      return;
    }
    this.failures += 1;
    this.say(responseId, FAILURE_LINE);
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

  /** The socket closed: record the call once, however many times this is called. */
  finish(): Promise<IngestResult | null> {
    this.finished ??= this.record();
    return this.finished;
  }

  private async record(): Promise<IngestResult | null> {
    this.recording = true;
    this.closing = true;
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
      log.info("retell call recorded", { clinicId: this.clinicId, conversationId: result.conversationId, outcome: event.outcome ?? "none", count: this.turns.length });
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
