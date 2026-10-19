import type { ActorContext } from "@/lib/audit";
import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { openingLine } from "@/lib/assistant/opening";
import { answerTurn, EMPTY_CAPTURE, type AssistantResponder, type BookingCapture } from "@/lib/assistant/turn";
import { servicesEnded, voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { deliverCriticalAfterCommit } from "@/lib/email/outbox";
import { raiseHandover } from "@/lib/handovers/record";
import { describeError, log } from "@/lib/log";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { ingestCall, type IngestResult, type VoiceCallEvent } from "./ingest";

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
 *                   the call's disclosure_played_at.
 *   call_details    the caller's number and the call's start, kept in memory;
 *                   an outbound call is ended at once (v1 is inbound only).
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
 * Booking stays with the desk: the assistant takes a request and books
 * nothing itself; direct booking through the booking engine
 * (lib/booking/engine.ts) waits for counsel and the owner.
 *
 * Every degradation ends at a person (CLAUDE.md, "Failure"): a gate that
 * refuses the call, or a model that fails twice running, transfers the
 * caller to the clinic's direct line where there is one. With none, the
 * assistant takes the caller's details, so the call still reaches someone;
 * once the Services have ended, it closes the call with a fixed line.
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
  call?: { from_number?: unknown; direction?: unknown; start_timestamp?: unknown; call_id?: unknown };
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
};

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
  private openedAt: Date;
  private startedAt: Date | null = null;
  private disclosurePlayedAt: Date | null = null;
  private callerPhone: string | null = null;
  private outbound = false;
  private urgent = false;
  private handoff = false;
  private handoverAlerted = false;
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
    this.send({
      response_type: "response",
      response_id: responseId,
      content,
      content_complete: true,
      end_call: Boolean(options.endCall),
      ...(options.transferTo ? { transfer_number: options.transferTo } : {}),
    });
  }

  /** The connection is up: configure, ask the gate, and speak first. */
  async open(): Promise<void> {
    this.send({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
    const now = this.now();
    let decision: AnswerDecision;
    try {
      decision = await (this.deps.gate ?? voiceAnswerDecision)(this.clinicId, now);
      this.facts = await withTenant({ clinicId: this.clinicId, actor: ACTOR }, async (tx) => ((await clinicHasLeft(tx)) ? null : assistantFacts(tx)));
    } catch (error) {
      log.error("retell call could not start", { clinicId: this.clinicId, error: describeError(error) });
      this.closing = true;
      this.say(0, CLOSED_LINE, { endCall: true });
      return;
    }
    this.directLine = this.facts?.directLine ?? (decision.decision === "pass_through" ? decision.directLine : null);

    if (!this.facts || (decision.decision === "pass_through" && servicesEnded(decision.reason))) {
      this.closing = true;
      this.say(0, CLOSED_LINE, { endCall: true });
      return;
    }
    if (decision.decision === "pass_through" && decision.directLine) {
      // Paused, capped or suspended: the caller goes to a person, never to silence.
      this.closing = true;
      this.say(0, TRANSFER_LINE, { transferTo: decision.directLine });
      return;
    }
    this.gateAnswered = decision.decision === "answer";
    this.disclosurePlayedAt = now;
    this.say(0, openingLine(this.facts, "voice"));
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
        await this.respond(event);
        return;
      default:
        return;
    }
  }

  private callDetails(event: RetellEvent): void {
    const call = event.call ?? {};
    if (typeof call.from_number === "string" && call.from_number.trim()) this.callerPhone = call.from_number.trim();
    if (typeof call.start_timestamp === "number") this.startedAt = new Date(call.start_timestamp);
    if (call.direction === "outbound") {
      // healdesk places no calls. A call the vendor says we placed is a
      // misconfiguration: say nothing more, end it, and let the ingest
      // record the refusal as a security event.
      this.outbound = true;
      this.closing = true;
      this.send({ response_type: "response", response_id: Math.max(this.latestResponseId, 0), content: "", content_complete: true, end_call: true });
    }
  }

  private async respond(event: RetellEvent): Promise<void> {
    if (this.closing || !this.facts) return;
    const responseId = typeof event.response_id === "number" ? event.response_id : NaN;
    if (!Number.isInteger(responseId) || responseId < 0) return;
    this.latestResponseId = Math.max(this.latestResponseId, responseId);

    if (event.interaction_type === "reminder_required") {
      this.say(responseId, REMINDER_LINE);
      return;
    }
    const words = latestCallerWords(event.transcript);
    if (!words) return;

    const facts = this.facts;
    const turn = await answerTurn({ facts, channel: "voice", history: this.turns, text: words, capture: this.capture, responder: this.deps.responder, now: this.now() });
    // The caller spoke again while this was being answered: the newer
    // request carries these words too, so this answer is dropped unsaid.
    if (responseId !== this.latestResponseId || this.closing) return;

    this.turns.push({ speaker: "person", text: turn.personText });
    this.capture = turn.capture;
    this.handoff ||= turn.handoff;

    let urgentQueued = false;
    if (turn.urgent && !this.urgent) {
      this.urgent = true;
      try {
        await withTenant({ clinicId: this.clinicId, actor: ACTOR }, (tx) =>
          notifyBookingAlert(tx, "urgent", { callId: this.callId, channel: "voice" }),
        );
        urgentQueued = true;
      } catch (error) {
        log.error("retell urgent alert not raised", { clinicId: this.clinicId, error: describeError(error) });
      }
    }
    // L11: the caller asked for a person. Once per call, and not after an
    // urgent alert, which already has the clinic looking at it. Kept for
    // Bookings' Needs you as well as alerted (lib/handovers/record.ts).
    if (turn.handoff && !this.handoverAlerted && !this.urgent) {
      this.handoverAlerted = true;
      try {
        await withTenant({ clinicId: this.clinicId, actor: ACTOR }, (tx) =>
          raiseHandover(tx, { channel: "voice", callId: this.callId }),
        );
      } catch (error) {
        log.error("retell handover alert not raised", { clinicId: this.clinicId, error: describeError(error) });
      }
    }

    if (turn.source !== "fallback") this.answered = true;
    if (turn.source === "fallback") {
      this.failures += 1;
      if (this.failures >= 2 && this.directLine) {
        this.closing = true;
        this.say(responseId, TROUBLE_TRANSFER_LINE, { transferTo: this.directLine });
        return;
      }
    } else {
      this.failures = 0;
    }
    if (turn.end) this.closing = true;
    this.say(responseId, turn.reply, { endCall: turn.end });
    // The urgent alert is critical: sent in-process once its row has
    // committed, after the caller has heard the reply, so the line never
    // waits on an email. It never rejects; whatever it misses, the minute
    // queue sends.
    if (urgentQueued) this.sending.push(deliverCriticalAfterCommit(this.clinicId, { transport: this.deps.transport }));
  }

  /** What the caller asked the desk for, as the ingest reads it. */
  private requestFor(): Pick<VoiceCallEvent, "outcome" | "booking" | "collectedFields" | "callerName"> {
    const c = this.capture;
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
    this.closing = true;
    await Promise.all(this.sending);
    const endedAt = this.now();
    const startedAt = this.startedAt ?? this.openedAt;
    const event: VoiceCallEvent = {
      externalCallId: this.callId,
      clinicId: this.clinicId,
      callerPhone: this.callerPhone ?? undefined,
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
    }
  }
}
