import { currentDirectBookingAddendum } from "@healdesk/catalog";
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
import {
  bookedLine,
  BOOKING_REFUSED_LINE,
  DEPOSIT_HOLD_LINE,
  DEPOSIT_REQUEST_LINE,
  depositLine,
  detailsBeforeHoldLine,
  forChat,
  heldAskLine,
  IN_PROGRESS_LINE,
  MANUAL_BOOKING_LINE,
  MISSING_DETAIL_LINES,
  NO_FREE_TIME_LINE,
  offerLine,
  ONE_REQUEST_PER_CALL_LINE,
  oneBookingPerCallLine,
  REQUEST_TAKEN_LINE,
  slotGoneLine,
  TOOL_FAILURE_LINE,
} from "@/lib/booking/lines";
import { bookingModeFor } from "@/lib/booking/mode";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

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
  | { type: "find_times"; service: string | null; day: string | null }
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
  /** The location stopped offering times in this conversation: the request flow takes over. */
  manual: boolean;
  /** The conversation's one booking or request, once the engine has it. */
  done: { kind: "booked" | "request"; at: string | null; requestId: string | null; appointmentId: string | null } | null;
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
  }): Promise<ToolTurn | null>;
};

/**
 * Every switch that must be on before the tools are offered: the owner's
 * kill switch and counsel's release of the Direct booking addendum. Read on
 * every turn; neither is ever set by code.
 */
export function directBookingToolsAllowed(): boolean {
  return env.directBookingEnabled() && currentDirectBookingAddendum().approvedByCounsel === true;
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

/** At most this many times are offered at once. */
const OFFERED = 3;

export function bookingTools(
  context: BookingToolsContext,
  engine: BookingEngine = ENGINE,
  mayAnswer: typeof assistantMayAnswer = assistantMayAnswer,
): BookingTools {
  const say = (line: string) => (context.channel === "web_chat" ? forChat(line) : line);
  const label = (iso: string) => slotLabel(new Date(iso), context.timeZone);
  // B's gate, as the engine asks it before a write: true only when it would answer now.
  const gate = (now: Date) => async () =>
    (
      await mayAnswer({
        clinicId: context.clinicId,
        channel: context.channel === "voice" ? "voice" : "web",
        ...context.answering,
        now,
        actor: context.actor,
      })
    ).decision === "answer";

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
    };
  }

  async function findTimes(action: Extract<ToolAction, { type: "find_times" }>, state: BookingToolState, now: Date): Promise<ToolTurn> {
    const service = action.service ?? state.service;
    let answer: OfferTimes;
    try {
      answer = await engine.offerTimes(context.clinicId, {
        channel: context.channel,
        holderKey: context.holderKey,
        day: action.day ? zonedDayStart(action.day, context.timeZone) : null,
        service,
        now,
        actor: context.actor,
      });
    } catch (error) {
      log.error("booking tool find_times failed", { clinicId: context.clinicId, error: describeError(error) });
      return findTimesFailed(state);
    }
    if (answer.status === "unavailable") return findTimesFailed(state);
    if (answer.status === "request_only") {
      // Manual booking in the same turn: the request flow takes the time.
      const next = { ...state, manual: true, offered: [], chosen: null, held: false };
      return turn(answer.reasons.includes("deposit_required") ? DEPOSIT_REQUEST_LINE : MANUAL_BOOKING_LINE, next);
    }
    if (answer.slots.length === 0) return turn(NO_FREE_TIME_LINE, offered(state, [], service));
    const next = offered(state, answer.slots, service);
    return turn(offerLine(next.offered.map((s) => label(s.at))), next);
  }

  /**
   * Google could not say which times are free. The website chat takes the
   * request in words from here on (`manual`), so the chat files it for the
   * desk once it has a name, a number and a time (web-chat.ts takeRequest
   * runs only while the tools are off); left live, the tools would keep
   * failing and the details the visitor gives would reach no one.
   */
  function findTimesFailed(state: BookingToolState): ToolTurn {
    if (context.channel !== "web_chat") return turn(TOOL_FAILURE_LINE, state);
    return turn(MANUAL_BOOKING_LINE, { ...state, manual: true, offered: [], chosen: null, held: false });
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
        preferredWindow: label(chosen.at),
        service: state.service,
        fields: details.fields,
        now,
        actor: context.actor,
      });
    } catch (error) {
      log.error("booking tool request after a failed booking not logged", { clinicId: context.clinicId, error: describeError(error) });
      return turn(TOOL_FAILURE_LINE, state);
    }
    if (logged.kind === "key_reused") return answerBooking(logged, state, chosen);
    if (logged.kind === "invalid") return turn(TOOL_FAILURE_LINE, state);
    const requestId = logged.requestId ?? null;
    const done = { kind: "request" as const, at: chosen.at, requestId, appointmentId: null };
    return turn(REQUEST_TAKEN_LINE, { ...state, done, chosen: null, held: false }, { requestId });
  }

  async function hold(state: BookingToolState, chosen: OfferedSlot, now: Date): Promise<{ held: true } | { turn: ToolTurn }> {
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
      return { turn: turn(TOOL_FAILURE_LINE, state) };
    }
    switch (placed.kind) {
      case "held":
        return { held: true };
      case "slot_taken": {
        const next = offered(state, placed.alternatives.map((at) => ({ at, providerId: null })), state.service);
        return { turn: turn(slotGoneLine(next.offered.map((s) => label(s.at))), next) };
      }
      case "request_only": {
        // Auto-confirm off, a deposit the channel cannot take, a calendar that
        // stopped allowing the write: no hold; the engine logs the request
        // when the details are in (bookConversation answers it as one).
        return { held: true };
      }
      case "in_progress":
        return { turn: turn(IN_PROGRESS_LINE, state) };
      case "unavailable":
        return { turn: turn(TOOL_FAILURE_LINE, state) };
    }
  }

  function answerBooking(result: BookConversationResult, state: BookingToolState, chosen: OfferedSlot): ToolTurn {
    switch (result.kind) {
      case "booked": {
        const at = result.startsAt.toISOString();
        const done = { kind: "booked" as const, at, requestId: result.requestId, appointmentId: result.appointmentId };
        // A call says the deposit the front desk will take; never a link.
        const deposit = context.channel === "voice" && result.deposit ? depositLine({ ...result.deposit, scope: "booking" }) : "";
        return turn([bookedLine(label(at), result.canonicalService), deposit].filter(Boolean).join(" "), { ...state, done, chosen: null, held: false }, {
          bookingWritten: true,
          requestId: result.requestId,
          appointmentId: result.appointmentId,
        });
      }
      case "request_logged": {
        const done = { kind: "request" as const, at: chosen.at, requestId: result.requestId ?? null, appointmentId: null };
        const next = { ...state, done, chosen: null, held: false, manual: state.manual || result.reason === "calendar_broken" };
        let line = REQUEST_TAKEN_LINE;
        if (result.reason === "deposit_hold") line = DEPOSIT_HOLD_LINE;
        else if (result.reason === "deposit_required") {
          line = context.channel === "voice" && result.deposit ? depositLine({ ...result.deposit, scope: "booking" }) : DEPOSIT_REQUEST_LINE;
        }
        return turn(line, next, { requestId: result.requestId ?? null });
      }
      case "slot_taken": {
        const next = offered(state, result.alternatives.map((at) => ({ at, providerId: null })), state.service);
        return turn(slotGoneLine(next.offered.map((s) => label(s.at))), next);
      }
      case "in_progress":
        return turn(IN_PROGRESS_LINE, state);
      case "key_reused":
        return turn(
          result.first === "booked" ? oneBookingPerCallLine(result.firstStartsAt ? label(result.firstStartsAt.toISOString()) : null) : ONE_REQUEST_PER_CALL_LINE,
          state,
        );
      case "invalid":
        if (result.field === "at") {
          const next = { ...state, chosen: null, held: false };
          return turn(state.offered.length > 0 ? offerLine(state.offered.map((s) => label(s.at))) : MISSING_DETAIL_LINES.at, next);
        }
        return turn(MISSING_DETAIL_LINES[result.field], state);
      case "unavailable":
        return turn(TOOL_FAILURE_LINE, state);
      case "refused":
        // Paused, capped, suspended or ended since the conversation opened:
        // nothing written, the person sent to the clinic, no tools again.
        return turn(BOOKING_REFUSED_LINE, { ...state, manual: true, chosen: null, held: false });
    }
  }

  /** The website chat's line about a booked appointment's deposit, or null when there is nothing to say. */
  async function chatDeposit(appointmentId: string, now: Date): Promise<string | null> {
    let deposit: ChatDeposit;
    try {
      deposit = await engine.chatDepositFor(context.clinicId, appointmentId, { channel: "web", actor: context.actor, now });
    } catch (error) {
      // The booking stands; the deposit is still owed, and the Bookings
      // screen shows it. Nothing about it is promised here.
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
    if (state.manual) return null;
    if (state.done) {
      // The conversation's one booking or request is made: a second is the desk's.
      if (!action) return null;
      return turn(state.done.kind === "booked" ? oneBookingPerCallLine(state.done.at ? label(state.done.at) : null) : ONE_REQUEST_PER_CALL_LINE, state);
    }
    if (action?.type === "find_times") return findTimes(action, state, now);

    let chosenNow = false;
    if (action?.type === "choose_time") {
      const match = state.offered.find((s) => s.at === action.at);
      if (!match) {
        // Never a time the engine did not offer: offer again.
        return state.offered.length > 0 ? turn(offerLine(state.offered.map((s) => label(s.at))), state) : turn(MISSING_DETAIL_LINES.at, state);
      }
      state = { ...state, chosen: match, held: state.chosen?.at === match.at ? state.held : false };
      chosenNow = true;
    }
    const chosen = state.chosen;
    if (!chosen) return null;

    const firstName = capture.firstName?.trim() || null;
    const phone = (capture.phone ? toE164(capture.phone) : null) ?? (input.callerPhone ? toE164(input.callerPhone) : null);
    const missing = !firstName ? ("first_name" as const) : !phone ? ("phone" as const) : null;

    if (context.channel === "voice" && !state.held) {
      // A call holds the time while the caller gives their details.
      const held = await hold(state, chosen, now);
      if ("turn" in held) return held.turn;
      state = { ...state, held: true };
      if (missing) return turn(heldAskLine(missing), state);
    }
    if (missing) {
      // The details are still to come: asked for once, when the time is chosen;
      // otherwise the model's own reply stands.
      return chosenNow ? turn(detailsBeforeHoldLine(label(chosen.at)), state) : null;
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
      if (context.channel === "web_chat") return requestInstead(state, chosen, { firstName: firstName!, phone: phone!, fields: capture.fields }, now);
      return turn(TOOL_FAILURE_LINE, state);
    }
    if (result.kind === "unavailable" && context.channel === "web_chat") {
      return requestInstead(state, chosen, { firstName: firstName!, phone: phone!, fields: capture.fields }, now);
    }
    const answered = answerBooking(result, state, chosen);
    if (context.channel !== "web_chat" || result.kind !== "booked" || !result.appointmentId) return answered;
    // The booking is in the calendar and said; its deposit after it, as the
    // appointment stands: the clinic's own payment link, or the front desk.
    const deposit = await chatDeposit(result.appointmentId, now);
    return deposit ? { ...answered, reply: `${answered.reply} ${deposit}` } : answered;
  }

  return { channel: context.channel, available, run };
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
    return { type: "find_times", service: text(raw.service, 120), day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null };
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
