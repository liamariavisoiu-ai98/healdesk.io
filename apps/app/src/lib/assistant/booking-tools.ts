import { toE164 } from "@healdesk/connectors";

import type { ActorContext } from "@/lib/audit";
import { assistantMayAnswer, type AssistantMayAnswerInput } from "@/lib/billing/answering";
import { slotLabel } from "@/lib/booking/calendar";
import { chatDepositFor, type ChatDeposit } from "@/lib/booking/deposit-gate";
import {
  bookConversation,
  logRequest,
  offerTimes,
  placeHold,
  type BookConversationResult,
  type OfferTimes,
  type PlacedHold,
} from "@/lib/booking/engine";
import { BOOKING_LINES_EN, BOOKING_LINES_ES, bookingLinesFor, depositLine, forChat, readBackLine, type BookingLines } from "@/lib/booking/lines";
import { directBookingOpen } from "@/lib/booking/direct-switch";
import { bookingModeFor } from "@/lib/booking/mode";
import { describeError, log } from "@/lib/log";
import type { PaymentTextState } from "@/lib/sms/payment-text";
import { withTenant } from "@/lib/tenant";
import { pause } from "@/lib/voice/pauses";
import { spokenSlotEn, spokenSlotEs } from "@/lib/voice/spoken";

import type { BookingCapture } from "./turn";

/**
 * The fixed tool layer between the shared brain (turn.ts) and the booking
 * engine (lib/booking/engine.ts): one adapter, used by the call and the web
 * chat alike (CLAUDE.md, "One brain, four adapters"). The model never writes
 * a booking and never words one. It asks, in its JSON, for one of two
 * actions, and this layer runs the engine and answers with the fixed lines
 * of lib/booking/lines.ts in place of the model's words:
 *
 *   find_times    the engine's free times (Google free/busy over the
 *                 location's hours, zone and the service's length), three at
 *                 most, kept in the conversation's state;
 *   choose_time   one of those times, by its exact value: anything else is
 *                 refused and the times are offered again, never guessed at.
 *
 * Once a time is chosen and the person's first name and number are known,
 * the time is held (60 seconds, lib/booking/holds.ts) and then booked
 * (bookConversation: re-checked, claimed and written to Google, idempotent on
 * the conversation's booking key), all before anything confirming is said.
 * A call holds the time as soon as it is chosen, while the caller gives
 * their details; the website chat holds nothing until it has a name and a
 * number (spec, "How a session runs", step 3).
 *
 * The engine's answer decides the line: booked (BOOKED_LINE, and on a call
 * the deposit the front desk will take), a request (the mode is manual, the
 * connection broke in this turn, a deposit the channel cannot take), the
 * time gone (the nearest times offered again), and so on. Only a booked
 * answer lets the turn say a booking is made (guard.ts, bookingWritten).
 *
 * Deposits (DEPOSIT-01). Card numbers are never taken. In the website chat a
 * booking whose service needs a deposit is written, and then the clinic's
 * own payment link is sent after the booked line (chatDepositFor: Stripe
 * sees an amount, "Appointment deposit" and an opaque reference, never the
 * service); when no link can be made the deposit is left to the front desk
 * and the chat says so. A call never sends a link: the deposit is said
 * (depositLine) and flagged for staff, as D's rules decide.
 *
 * The tools are offered to the model only while every switch allows direct
 * booking (directBookingToolsAllowed): the owner's kill switch
 * (HEALDESK_DIRECT_BOOKING_ENABLED), the Direct booking addendum released by
 * counsel, and a location that can offer real free times now
 * (bookingModeFor's canOfferTimes, read fresh each turn). Otherwise the turn
 * is exactly what it was before the tools existed: the model takes a request
 * in words and the adapter files it for the desk.
 *
 * One booking per conversation: the booking key ends ":1", so a second
 * booking asked for under it is the engine's `key_reused`.
 *
 * The answer gate (assistantMayAnswer) is asked again by the engine before
 * anything is written, after its replay (book.ts, step 1): a pause, a cap,
 * a suspension or an ending that began after the conversation opened writes
 * nothing, says BOOKING_REFUSED_LINE and offers the tools no more. The
 * adapter's usage reference or `continuing` keeps the cap from cutting off a
 * conversation it already let in (R18).
 */

export type ToolAction =
  | {
      type: "find_times";
      service: string | null;
      day: string | null;
      /** Only times starting at or after this hour of the day, "HH:MM" (24-hour): "after four", "evening". */
      after?: string | null;
      /** Only times starting before this hour of the day: "before noon", "mornings". */
      before?: string | null;
    }
  | { type: "choose_time"; at: string };

export type OfferedSlot = { at: string; providerId: string | null };

/** What the tool layer keeps between turns, beside the capture. JSON, so a chat can seal it. */
export type BookingToolState = {
  /** The times last offered, ISO, in the order offered. */
  offered: OfferedSlot[];
  /** The service they were offered for, as the person named it. */
  service: string | null;
  /** The time the person chose from them. */
  chosen: OfferedSlot | null;
  /** A call's hold on `chosen` was placed. */
  held: boolean;
  /**
   * A call's hold on `chosen` was refused as request-only (placeHold's
   * `request_only`): nothing is held, and the time becomes a request.
   * Optional, so a state sealed before it existed still reads.
   */
  asRequest?: boolean;
  /** The location stopped offering times in this conversation: the request flow takes over. */
  manual: boolean;
  /**
   * A call only (owner, 1 November 2026: "make sure that she confirms a phone
   * number whenever it's been given"): the number the caller gave, read back
   * and waiting for their yes; and the one they said yes to. In the call's
   * memory only; never sealed. Optional, so a state sealed before it existed
   * still reads.
   */
  readBack?: string | null;
  phoneConfirmed?: string | null;
  /** The conversation's one booking or request, once the engine has it. */
  done: { kind: "booked" | "request"; at: string | null; requestId: string | null; appointmentId: string | null } | null;
  /**
   * A call only: the payment-link text after its booking, once offered
   * (lib/sms/payment-text.ts). In the call's memory only; never sealed.
   */
  text?: PaymentTextState;
};

export const EMPTY_TOOL_STATE: BookingToolState = {
  offered: [],
  service: null,
  chosen: null,
  held: false,
  manual: false,
  done: null,
};

/** What a turn the tool layer answered did. */
export type ToolTurn = {
  /** The fixed line said in place of the model's words. */
  reply: string;
  state: BookingToolState;
  /** The engine wrote a booking into the calendar on this turn (a replay counts: it is the same booking). */
  bookingWritten: boolean;
  /** The engine's request or booking, for the adapter's record. */
  requestId: string | null;
  appointmentId: string | null;
};

export type BookingToolsContext = {
  clinicId: string;
  channel: "voice" | "web_chat";
  /** "retell:" + call id; "web:" + conversation id. */
  holderKey: string;
  /** The holder key + ":1": one booking per conversation. */
  bookingKey: string;
  /** The chat's conversation row, once it exists; null for a call. */
  conversationId: string | null;
  timeZone: string;
  actor: ActorContext;
  /** How long the person can wait for Google. */
  budgetMs: number;
  /** What the answer gate is told about this conversation, as the adapter's own gate was. */
  answering?: Pick<AssistantMayAnswerInput, "usage" | "continuing">;
};

export type BookingTools = {
  readonly channel: "voice" | "web_chat";
  /** Whether the model may use the tools on this turn. Never throws: a failure is no tools. */
  available(): Promise<boolean>;
  /** The tool layer's turn, or null when the model's own reply stands. */
  run(input: {
    action: ToolAction | null;
    capture: BookingCapture;
    state: BookingToolState;
    /** The number the call came from, when the caller has given no other. */
    callerPhone?: string | null;
    now: Date;
    /** The language a call is being spoken in (lib/voice/call-language.ts); English when absent, and always on the website chat. */
    language?: "en" | "es";
    /** The person's words this turn: a call reads its yes to a number read back from them (readBack). */
    words?: string;
  }): Promise<ToolTurn | null>;
  /**
   * Read the calendar ahead for a find_times the turn is likely to ask for
   * (a day or part of the day the caller named), so its answer is ready when
   * it is asked; a find_times for the same day, window and service within
   * PREFETCH_FRESH_MS uses it. Read-only, never throws, optional.
   */
  prefetch?(action: Extract<ToolAction, { type: "find_times" }>, now: Date): void;
};

/** How long a calendar read ahead (prefetch) is used for. */
const PREFETCH_FRESH_MS = 20_000;

/**
 * Every switch that must be on before the tools are offered: the owner's
 * kill switch, counsel's release of the Direct booking addendum and the
 * deployed addendum version matching it, all through the one shared check
 * (lib/booking/direct-switch.ts, DB-1). Read on every turn; none is ever set
 * by code.
 */
export function directBookingToolsAllowed(): boolean {
  return directBookingOpen();
}

/** The engine, as the tool layer calls it; tests may pass their own. */
export type BookingEngine = {
  offerTimes: typeof offerTimes;
  placeHold: typeof placeHold;
  bookConversation: typeof bookConversation;
  chatDepositFor: typeof chatDepositFor;
  logRequest: typeof logRequest;
};

const ENGINE: BookingEngine = { offerTimes, placeHold, bookConversation, chatDepositFor, logRequest };

/** The answer gate threw: the clinic's state is unknown, so nothing is written for it. */
class GateUnreadable extends Error {
  constructor(cause: unknown) {
    super("the answer gate could not be read");
    this.name = "GateUnreadable";
    this.cause = cause;
  }
}

/** At most this many times are offered at once. */
const OFFERED = 3;

/** The caller's yes, or no, to a number read back (readBack). */
const AFFIRMED = /^\W*(?:yes|yeah|yep|yup|ya|correct|right|exactly|perfect|sure|uh[- ]?huh|mm[- ]?hmm|that'?s (?:right|it|correct|me|the one)|s[ií]|claro|correcto|eso es)\b/i;
const DENIED = /\b(?:no|nope|nah|wrong|not quite|not right|that'?s not)\b/i;

/** An E.164 number as a person reads it in its own country: "+13055550199" is "305-555-0199". */
function nationalNumber(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `${us[1]}-${us[2]}-${us[3]}` : e164.replace(/^\+/, "");
}

export function bookingTools(
  context: BookingToolsContext,
  engine: BookingEngine = ENGINE,
  mayAnswer: typeof assistantMayAnswer = assistantMayAnswer,
): BookingTools {
  const say = (line: string) => (context.channel === "web_chat" ? forChat(line) : line);
  // On a call, a time as a person says it ("Thursday, November 5 at 3 PM"); in the chat, as it is written.
  const labelIn = (L: BookingLines) => (iso: string) =>
    L === BOOKING_LINES_ES
      ? spokenSlotEs(new Date(iso), context.timeZone)
      : context.channel === "voice"
        ? spokenSlotEn(new Date(iso), context.timeZone)
        : slotLabel(new Date(iso), context.timeZone);
  // Times said together: on an English call, a day said once ("Thursday, November 5 at 10 AM, 2 PM, or 4 PM").
  const labelsOf = (isos: readonly string[], L: BookingLines): string[] => {
    const label = labelIn(L);
    const full = isos.map(label);
    if (context.channel !== "voice" || L === BOOKING_LINES_ES || isos.length < 2) return full;
    const day = (iso: string) => full[isos.indexOf(iso)]!.split(" at ")[0];
    if (!isos.every((iso) => day(iso) === day(isos[0]!))) return full;
    return full.map((text, i) => (i === 0 ? text : text.split(" at ")[1] ?? text));
  };
  // B's gate, as the engine asks it before a write: true only when it would answer now.
  // A gate that cannot be read is its own failure (GateUnreadable): nobody knows
  // whether the clinic may answer, so the website chat's request-on-failure
  // below must not log a request for it either.
  const gate = (now: Date) => async () => {
    let decision: Awaited<ReturnType<typeof mayAnswer>>;
    try {
      decision = await mayAnswer({
        clinicId: context.clinicId,
        channel: context.channel === "voice" ? "voice" : "web",
        ...context.answering,
        now,
        actor: context.actor,
      });
    } catch (error) {
      throw new GateUnreadable(error);
    }
    return decision.decision === "answer";
  };

  async function available(): Promise<boolean> {
    if (!directBookingToolsAllowed()) return false;
    try {
      const mode = await withTenant({ clinicId: context.clinicId, actor: context.actor }, (tx) => bookingModeFor(tx));
      return mode.canOfferTimes;
    } catch (error) {
      log.warn("booking tools not offered: the mode could not be read", { clinicId: context.clinicId, error: describeError(error) });
      return false;
    }
  }

  function turn(reply: string, state: BookingToolState, extra: Partial<ToolTurn> = {}): ToolTurn {
    return { reply: say(reply), state, bookingWritten: false, requestId: null, appointmentId: null, ...extra };
  }

  function offered(state: BookingToolState, slots: readonly { at: Date; providerId: string | null }[], service: string | null): BookingToolState {
    return {
      ...state,
      offered: spread(slots).map((s) => ({ at: s.at.toISOString(), providerId: s.providerId })),
      service,
      chosen: null,
      held: false,
      asRequest: false,
    };
  }

  // The calendar read ahead (prefetch): one read, by what it was asked for.
  let ahead: { key: string; at: number; answer: Promise<OfferTimes> } | null = null;
  // The same treatment however it is written ("BOTOX® Cosmetic", "botox cosmetic"), the same day and start.
  const keyOf = (action: Extract<ToolAction, { type: "find_times" }>, service: string | null) =>
    JSON.stringify([service?.toLowerCase().replace(/[®™]/g, "").replace(/\s+/g, " ").trim() ?? null, action.day ?? null, action.after && action.day ? action.after : null]);
  const read = (action: Extract<ToolAction, { type: "find_times" }>, service: string | null, now: Date) =>
    engine.offerTimes(context.clinicId, {
      channel: context.channel,
      holderKey: context.holderKey,
      day: action.day ? zonedDayStart(action.day, context.timeZone) : null,
      // "After four": the engine starts from that hour of the day they named (or of today), and the window is kept below.
      ...(action.after && action.day ? { from: atHour(zonedDayStart(action.day, context.timeZone), action.after) } : {}),
      service,
      now,
      actor: context.actor,
    });

  function prefetch(action: Extract<ToolAction, { type: "find_times" }>, now: Date): void {
    const answer = read(action, action.service, now);
    answer.catch(() => {});
    ahead = { key: keyOf(action, action.service), at: Date.now(), answer };
  }

  async function findTimes(action: Extract<ToolAction, { type: "find_times" }>, state: BookingToolState, now: Date, L: BookingLines): Promise<ToolTurn> {
    const service = action.service ?? state.service;
    let answer: OfferTimes;
    try {
      const ready = ahead && ahead.key === keyOf(action, service) && Date.now() - ahead.at < PREFETCH_FRESH_MS ? ahead.answer : null;
      ahead = null;
      // A read ahead that failed is never the answer: the calendar is asked again, as it always was.
      answer = ready ? await ready.catch(() => read(action, service, now)) : await read(action, service, now);
    } catch (error) {
      log.error("booking tool find_times failed", { clinicId: context.clinicId, error: describeError(error) });
      return findTimesFailed(state, L);
    }
    if (answer.status === "unavailable") return findTimesFailed(state, L);
    if (answer.status === "request_only") {
      // Manual booking in the same turn: the request flow takes the time.
      const next = { ...state, manual: true, offered: [], chosen: null, held: false };
      return turn(answer.reasons.includes("deposit_required") ? L.depositRequest : L.manual, next);
    }
    // A window of the day they asked for ("after four", "not mornings"): only the times inside it (a test call of
    // 1 November 2026: "I want evening" offered the same morning-heavy times again).
    if (action.after || action.before) {
      answer = { ...answer, slots: answer.slots.filter((slot) => inWindow(slot.at, context.timeZone, action.after ?? null, action.before ?? null)) };
    }
    // Asked again, the times not just offered come first (the same three, three times, on a test call of 1 November 2026).
    if (state.offered.length > 0 && answer.slots.length > OFFERED) {
      const before = new Set(state.offered.map((s) => s.at));
      const fresh = answer.slots.filter((slot) => !before.has(slot.at.toISOString()));
      if (fresh.length > 0) answer = { ...answer, slots: fresh };
    }
    if (answer.slots.length === 0) return turn(L.noFreeTime, offered(state, [], service));
    const next = offered(state, answer.slots, service);
    return turn(L.offer(labelsOf(next.offered.map((s) => s.at), L)), next);
  }

  /**
   * Google could not say which times are free. The website chat takes the
   * request in words from here on (`manual`), so the chat files it for the
   * desk once it has a name, a number and a time (web-chat.ts takeRequest
   * runs only while the tools are off); left live, the tools would keep
   * failing and the details the visitor gives would reach no one.
   */
  function findTimesFailed(state: BookingToolState, L: BookingLines): ToolTurn {
    if (context.channel !== "web_chat") return turn(L.toolFailure, state);
    return turn(L.manual, { ...state, manual: true, offered: [], chosen: null, held: false });
  }

  /**
   * The engine could not book a visitor who chose a time and gave a name
   * and a number: Google's re-check failed for now, the hold lapsed, or
   * something threw. The website chat logs their request for the desk
   * instead, under the conversation's booking key (logRequest: idempotent
   * on the key, booking_request L7 in the same transaction; a booking or
   * request already under the key is answered as it stands), and tells
   * them the clinic will confirm. Nothing is said as booked. Only if the
   * request cannot be logged either is the failure line said.
   */
  async function requestInstead(
    state: BookingToolState,
    chosen: OfferedSlot,
    details: { firstName: string; phone: string; fields: Record<string, string> | undefined },
    now: Date,
  ): Promise<ToolTurn> {
    let logged: Awaited<ReturnType<typeof logRequest>>;
    try {
      logged = await engine.logRequest(context.clinicId, {
        channel: "web_chat",
        holderKey: context.holderKey,
        bookingKey: context.bookingKey,
        conversationId: context.conversationId,
        firstName: details.firstName,
        phoneE164: details.phone,
        preferredWindow: labelIn(BOOKING_LINES_EN)(chosen.at),
        service: state.service,
        fields: details.fields,
        now,
        actor: context.actor,
      });
    } catch (error) {
      log.error("booking tool request after a failed booking not logged", { clinicId: context.clinicId, error: describeError(error) });
      return turn(BOOKING_LINES_EN.toolFailure, state);
    }
    if (logged.kind === "key_reused") return answerBooking(logged, state, chosen, BOOKING_LINES_EN);
    if (logged.kind === "invalid") return turn(BOOKING_LINES_EN.toolFailure, state);
    const requestId = logged.requestId ?? null;
    const done = { kind: "request" as const, at: chosen.at, requestId, appointmentId: null };
    return turn(BOOKING_LINES_EN.requestTaken, { ...state, done, chosen: null, held: false }, { requestId });
  }

  async function hold(
    state: BookingToolState,
    chosen: OfferedSlot,
    now: Date,
    L: BookingLines,
  ): Promise<{ held: true } | { asRequest: true; deposit: boolean } | { turn: ToolTurn }> {
    let placed: PlacedHold;
    try {
      placed = await engine.placeHold(context.clinicId, {
        channel: context.channel,
        holderKey: context.holderKey,
        startsAt: new Date(chosen.at),
        service: state.service,
        providerId: chosen.providerId,
        contactId: null,
        now,
        actor: context.actor,
      });
    } catch (error) {
      log.error("booking tool hold failed", { clinicId: context.clinicId, error: describeError(error) });
      return { turn: turn(L.toolFailure, state) };
    }
    switch (placed.kind) {
      case "held":
        return { held: true };
      case "slot_taken": {
        const next = offered(state, placed.alternatives.map((at) => ({ at, providerId: null })), state.service);
        return { turn: turn(L.slotGone(labelsOf(next.offered.map((s) => s.at), L), labelIn(L)(chosen.at)), next) };
      }
      case "request_only": {
        // Auto-confirm off, a deposit the channel cannot take, a calendar that
        // stopped allowing the write: no hold; the engine logs the request
        // when the details are in (bookConversation answers it as one).
        // Nothing is held, so the caller is never told it is.
        return { asRequest: true, deposit: placed.reasons.includes("deposit_required") };
      }
      case "in_progress":
        return { turn: turn(L.inProgress, state) };
      case "unavailable":
        return { turn: turn(L.toolFailure, state) };
    }
  }

  function answerBooking(result: BookConversationResult, state: BookingToolState, chosen: OfferedSlot, L: BookingLines, firstName: string | null = null): ToolTurn {
    const label = labelIn(L);
    switch (result.kind) {
      case "booked": {
        const at = result.startsAt.toISOString();
        const done = { kind: "booked" as const, at, requestId: result.requestId, appointmentId: result.appointmentId };
        // A call says the deposit the front desk will take; never a link.
        const deposit = context.channel === "voice" && result.deposit ? L.deposit({ ...result.deposit, scope: "booking" }) : "";
        // On a call, a beat between the booking and the deposit, so the booking lands first (pauses.ts).
        const joint = context.channel === "voice" ? ` ${pause("beat")} ` : " ";
        return turn([L.booked(label(at), result.canonicalService, context.channel === "voice" ? firstName : null), deposit].filter(Boolean).join(joint), { ...state, done, chosen: null, held: false }, {
          bookingWritten: true,
          requestId: result.requestId,
          appointmentId: result.appointmentId,
        });
      }
      case "request_logged": {
        const done = { kind: "request" as const, at: chosen.at, requestId: result.requestId ?? null, appointmentId: null };
        const next = { ...state, done, chosen: null, held: false, manual: state.manual || result.reason === "calendar_broken" };
        let line = L.requestTaken;
        if (result.reason === "deposit_hold") line = L.depositHold;
        else if (result.reason === "deposit_required") {
          line = context.channel === "voice" && result.deposit ? L.deposit({ ...result.deposit, scope: "booking" }) : L.depositRequest;
        }
        return turn(line, next, { requestId: result.requestId ?? null });
      }
      case "slot_taken": {
        const next = offered(state, result.alternatives.map((at) => ({ at, providerId: null })), state.service);
        return turn(L.slotGone(labelsOf(next.offered.map((s) => s.at), L), label(chosen.at)), next);
      }
      case "in_progress":
        return turn(L.inProgress, state);
      case "key_reused":
        return turn(
          result.first === "booked" ? L.oneBookingPerCall(result.firstStartsAt ? label(result.firstStartsAt.toISOString()) : null) : L.oneRequestPerCall,
          state,
        );
      case "invalid":
        if (result.field === "at") {
          const next = { ...state, chosen: null, held: false, asRequest: false };
          return turn(state.offered.length > 0 ? L.offer(labelsOf(state.offered.map((s) => s.at), L)) : L.missing.at, next);
        }
        return turn(L.missing[result.field], state);
      case "unavailable":
        return turn(L.toolFailure, state);
      case "refused":
        // Paused, capped, suspended or ended since the conversation opened:
        // nothing written, the person sent to the clinic, no tools again.
        return turn(L.refused, { ...state, manual: true, chosen: null, held: false });
    }
  }

  /** The website chat's line about a booked appointment's deposit, or null when there is nothing to say. */
  async function chatDeposit(appointmentId: string, now: Date): Promise<string | null> {
    let deposit: ChatDeposit;
    try {
      deposit = await engine.chatDepositFor(context.clinicId, appointmentId, { channel: "web", actor: context.actor, now });
    } catch (error) {
      // The booking stands; the deposit is still owed (`pending_link`, written
      // with the booking), and lib/billing/deposit-sweep.ts hands it to the
      // front desk. Nothing about it is promised here.
      log.error("booking tool deposit failed", { clinicId: context.clinicId, error: describeError(error) });
      return null;
    }
    if (deposit.kind === "link") return deposit.text;
    if (deposit.kind === "flagged") return forChat(depositLine({ action: "book_and_flag", amountUsd: deposit.amountUsd, scope: "booking" }));
    return null;
  }

  async function run(input: Parameters<BookingTools["run"]>[0]): Promise<ToolTurn | null> {
    const { action, capture, now } = input;
    let state = input.state;
    // A call in Spanish hears the Spanish lines; the website chat never passes a language.
    const L = context.channel === "voice" ? bookingLinesFor(input.language ?? "en") : BOOKING_LINES_EN;
    const label = labelIn(L);
    if (state.manual) return null;
    if (state.done) {
      // The conversation's one booking or request is made: a second is the desk's.
      if (!action) return null;
      return turn(state.done.kind === "booked" ? L.oneBookingPerCall(state.done.at ? label(state.done.at) : null) : L.oneRequestPerCall, state);
    }
    if (action?.type === "find_times") return findTimes(action, state, now, L);

    let chosenNow = false;
    if (action?.type === "choose_time") {
      const match = state.offered.find((s) => s.at === action.at);
      if (!match) {
        // Never a time the engine did not offer: offer again.
        return state.offered.length > 0 ? turn(L.offer(labelsOf(state.offered.map((s) => s.at), L)), state) : turn(L.missing.at, state);
      }
      const same = state.chosen?.at === match.at;
      state = { ...state, chosen: match, held: same ? state.held : false, asRequest: same ? state.asRequest : false };
      chosenNow = true;
    }
    const chosen = state.chosen;
    if (!chosen) return null;

    const firstName = capture.firstName?.trim() || null;
    const given = capture.phone ? toE164(capture.phone) : null;
    if (context.channel === "voice" && given && given !== state.phoneConfirmed) {
      // A number the caller gave is read back before it is used, and used only after their yes.
      if (state.readBack === given && AFFIRMED.test(input.words ?? "")) {
        state = { ...state, readBack: null, phoneConfirmed: given };
      } else if (state.readBack === given && DENIED.test(input.words ?? "")) {
        return turn(L.missing.phone, { ...state, readBack: null });
      } else if (state.readBack !== given) {
        return turn(L === BOOKING_LINES_ES ? `${nationalNumber(given)}, ¿correcto?` : readBackLine(nationalNumber(given)), { ...state, readBack: given });
      } else {
        // Neither a yes nor a no: asked once more, in the shortest words.
        return turn(L === BOOKING_LINES_ES ? `${nationalNumber(given)}, ¿correcto?` : readBackLine(nationalNumber(given)), state);
      }
    }
    const phone = (context.channel === "voice" && given ? (state.phoneConfirmed === given ? given : null) : given) ?? (input.callerPhone ? toE164(input.callerPhone) : null);
    const missing = !firstName ? ("first_name" as const) : !phone ? ("phone" as const) : null;

    if (context.channel === "voice" && !state.held && !state.asRequest) {
      // A call holds the time while the caller gives their details.
      const held = await hold(state, chosen, now, L);
      if ("turn" in held) return held.turn;
      if ("asRequest" in held) {
        state = { ...state, asRequest: true };
        if (missing) return turn(L.requestAsk(missing, held.deposit), state);
      } else {
        state = { ...state, held: true };
        if (missing) return turn(L.heldAsk(missing, label(chosen.at)), state);
      }
    }
    if (missing) {
      // The details are still to come: asked for once, when the time is chosen;
      // otherwise the model's own reply stands.
      return chosenNow ? turn(L.detailsBeforeHold(label(chosen.at)), state) : null;
    }

    // The chat's hold is the engine's own claim (book.ts, step 6): the visitor
    // named and the time held under the calendar lock, then written, in one
    // step, so a repeated tool call meets its own booking first (the replay)
    // rather than its own hold.
    let result: BookConversationResult;
    try {
      result = await engine.bookConversation(context.clinicId, {
        channel: context.channel,
        holderKey: context.holderKey,
        bookingKey: context.bookingKey,
        conversationId: context.conversationId,
        startsAt: new Date(chosen.at),
        firstName: firstName!,
        phoneE164: phone!,
        service: state.service,
        providerId: chosen.providerId,
        fields: capture.fields,
        budgetMs: context.budgetMs,
        gate: gate(now),
        now,
        actor: context.actor,
      });
    } catch (error) {
      log.error("booking tool book failed", { clinicId: context.clinicId, error: describeError(error) });
      if (context.channel === "web_chat" && !(error instanceof GateUnreadable)) {
        return requestInstead(state, chosen, { firstName: firstName!, phone: phone!, fields: capture.fields }, now);
      }
      return turn(L.toolFailure, state);
    }
    if (result.kind === "unavailable" && context.channel === "web_chat") {
      return requestInstead(state, chosen, { firstName: firstName!, phone: phone!, fields: capture.fields }, now);
    }
    const answered = answerBooking(result, state, chosen, L, firstName);
    if (context.channel !== "web_chat" || result.kind !== "booked" || !result.appointmentId) return answered;
    // The booking is in the calendar and said; its deposit after it, as the
    // appointment stands: the clinic's own payment link, or the front desk.
    const deposit = await chatDeposit(result.appointmentId, now);
    return deposit ? { ...answered, reply: `${answered.reply} ${deposit}` } : answered;
  }

  return { channel: context.channel, available, run, prefetch };
}

/**
 * Up to OFFERED of the engine's times, in its order, an hour apart where
 * the day allows (8:00, 9:00, 10:00 rather than 8:00, 8:15, 8:30), the
 * nearest others after them when it does not.
 */
export function spread<T extends { at: Date }>(slots: readonly T[]): T[] {
  const picked: T[] = [];
  for (const slot of slots) {
    if (picked.length >= OFFERED) break;
    const last = picked[picked.length - 1];
    if (!last || slot.at.getTime() - last.at.getTime() >= SPREAD_MS) picked.push(slot);
  }
  for (const slot of slots) {
    if (picked.length >= OFFERED) break;
    if (!picked.includes(slot)) picked.push(slot);
  }
  return picked.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const SPREAD_MS = 60 * 60_000;

/** "16:00" as minutes after midnight; null for anything else. */
function minutesOf(hhmm: string | null): number | null {
  const m = hhmm ? /^(\d{1,2}):(\d{2})$/.exec(hhmm) : null;
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

/** A day's start moved to an hour of it ("16:00"), or the day's start when the hour cannot be read. */
function atHour(dayStart: Date | null, hhmm: string): Date | null {
  const minutes = minutesOf(hhmm);
  return dayStart ? new Date(dayStart.getTime() + (minutes ?? 0) * 60_000) : null;
}

/** Whether a time starts inside a window of the day, in the practice's zone. */
function inWindow(at: Date, timeZone: string, after: string | null, before: string | null): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const minutes = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  const from = minutesOf(after);
  const to = minutesOf(before);
  return (from === null || minutes >= from) && (to === null || minutes < to);
}

/** "2026-10-23" as the instant that day starts in `timeZone`; null for anything else. */
export function zonedDayStart(day: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(guess) || new Date(guess).getUTCDate() !== d) return null;
  let at = guess;
  // Twice, so a day that starts across a DST change lands on its own midnight.
  for (let i = 0; i < 2; i += 1) at = guess - offsetMs(new Date(at), timeZone);
  return new Date(at);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/** The model's action, read strictly: a known type and well-formed values, or none. */
export function parseToolAction(value: unknown): ToolAction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  if (raw.type === "find_times") {
    const day = text(raw.day, 10);
    const hour = (v: unknown) => {
      const t = text(v, 5);
      return t && /^\d{1,2}:\d{2}$/.test(t) ? t : null;
    };
    return { type: "find_times", service: text(raw.service, 120), day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null, after: hour(raw.after), before: hour(raw.before) };
  }
  if (raw.type === "choose_time") {
    const at = text(raw.at, 40);
    return at ? { type: "choose_time", at } : null;
  }
  return null;
}

/**
 * What the model is told on a turn the tools are live (after the cached
 * prefix, prompt.ts assistantTurnContext): the times on offer with the exact
 * value to choose one by, and the time chosen.
 */
export function toolTurnContext(state: BookingToolState, timeZone: string): string {
  const lines = ["Live booking is available on this turn: use the actions described above."];
  if (state.offered.length > 0) {
    lines.push("Times offered to the person (choose_time takes the exact value before the '='):");
    for (const slot of state.offered) lines.push(`- ${slot.at} = ${slotLabel(new Date(slot.at), timeZone)}`);
  }
  if (state.chosen) lines.push(`The person chose ${slotLabel(new Date(state.chosen.at), timeZone)}; collect their first name and phone number.`);
  return lines.join("\n");
}
