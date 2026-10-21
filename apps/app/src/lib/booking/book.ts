import { randomUUID } from "node:crypto";

import { toE164 } from "@healdesk/connectors";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import {
  agentConfigs,
  bookingRequests,
  clinicProviders,
  clinicSettings,
  clinics,
  slotHolds,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { recordDepositOutcome, type DepositOutcome } from "@/lib/billing/deposits";
import { describeError, log } from "@/lib/log";
import { createBookingRequest, type BookingRequestStatus } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { upsertCallerContact } from "@/lib/voice/ingest";

import { availableSlotsFor, checkSpan, nearestAlternatives, serviceDuration } from "./availability";
import { slotLabel } from "./calendar";
import { depositGateFor, type DepositGate, type DepositLineFacts } from "./deposit-gate";
import { ANSWERED_AS_REQUEST, holderRefOf, holdSpanWithin, lockClinicCalendar } from "./holds";
import { bookingModeFor, type BookingModeReasonCode } from "./mode";
import { bookedDepositLine, writeHeldBooking, type HeldWrite } from "./writer";

/**
 * Booking a conversation (plan §7.7): hold, re-check, claim, write, record.
 * Called through lib/booking/engine.ts, the only way anything may write the
 * assistant's bookings; the call and the web chat reach it through the
 * shared tool layer (lib/assistant/booking-tools.ts).
 *
 *   0. Validate: a first name (letters, at most 40), a future start, a
 *      phone number; the service resolved against the clinic's own list.
 *   1. Replay by the booking key. The same key and the same booking is the
 *      first answer again (a retried tool call, a duplicate webhook); the
 *      same key and a different booking is `key_reused`, and nothing is
 *      written.
 *      B's answer gate, when the caller passes it, is asked after the
 *      replay (R25): a booking that went through is answered as it was,
 *      whatever the gate says now.
 *   2. The mode must be live; otherwise a request, in the call.
 *   3. The deposit gate, before anything is held or written: decline logs
 *      a request; reserve keeps the slot for staff (7b); write goes on.
 *   4. One write in flight per holder. A caller who held a named provider's
 *      time and books it without naming them again books that provider.
 *   5. The re-check, with no transaction open and a fresh token: busy is
 *      `slot_taken` with alternatives; Google's definitive no marks the
 *      connection broken and takes a request in the same turn.
 *   6. The claim, under the calendar lock: the caller's contact, this
 *      holder's live hold over exactly the span (or a fresh one), the
 *      request (`agent_direct`, keyed), and the hold moved to `writing`
 *      under a lease, all in one transaction.
 *   7. The write, after commit (lib/booking/writer.ts), raced against the
 *      caller's budget: a write still in flight when it runs out goes on and
 *      records its own outcome, and the caller is answered with a request.
 *   8. A request in the call, for every way the assistant may not book.
 *
 * The slot is held for 60 seconds before anything confirming is said, and
 * nothing about a booking is said until Google has it.
 *
 * The clinic hears through booking alerts (lib/notices/booking-alerts.ts),
 * ids only, each raised in the transaction that commits what it reports; no
 * desk link is mailed (the design record's §9, item 11). A request logged
 * in the call raises booking_request (L7), except one logged because a call
 * cannot take a deposit, whose alert is D's deposit_to_collect (L10); a
 * deposit reservation raises L10 alone (D's recordDepositOutcome, in the
 * claim); a booking made raises nothing (the writer's alerts are listed in
 * lib/booking/writer.ts); a key asked for a second booking raises nothing.
 * The claim raises nothing, or every direct booking would raise one.
 */

const ENGINE_ACTOR: ActorContext = { type: "service", serviceName: "booking-engine" };
const FIRST_NAME = /^[\p{L}][\p{L}' -]*$/u;
const POLL_MS = 250;
const MAX_WINDOW_CHARS = 120;

/** Why the assistant took a request instead of a booking. */
export type RequestReason =
  /** The location books by request now; `modeReasons` says why. */
  | "manual"
  | "deposit_required"
  | "deposit_hold"
  | "calendar_broken"
  /** The terms, the connection or Auto-confirm stopped allowing the write since the mode was read. */
  | "calendar_not_permitted"
  | "opening_hours_unknown"
  | "timezone_unconfirmed"
  | "provider_unavailable"
  /** Google did not confirm the write; staff are told to check. */
  | "unconfirmed"
  /** The caller's budget ran out with the write in flight: staff get the request, and the write still records itself. */
  | "budget"
  | "write_refused"
  | "record_conflict"
  /** A request the caller asked for (logRequest). */
  | "requested"
  /** A replay of a request whose first reason is not kept. */
  | "already_logged";

export type BookConversationInput = {
  /** A call, or a web chat (lib/assistant/booking-tools.ts). */
  channel: "voice" | "web_chat";
  /** "retell:" + call id; "web:" + conversation id. */
  holderKey: string;
  /** "retell:" + call id + ":" + n, n growing only when the caller asks for another booking; "web:" + conversation id + ":" + n. */
  bookingKey: string;
  /**
   * The chat's conversation, which exists while it runs; null for a call,
   * whose conversation is written when it ends (the ingest links it).
   */
  conversationId?: string | null;
  startsAt: Date;
  firstName: string;
  phoneE164: string;
  /** The service as the caller named it; matched on the clinic's own list. */
  service: string | null;
  /** The clinic's other required fields, as collected (screened at creation). */
  fields?: Record<string, string>;
  /**
   * A named provider the caller asked for. Left out, the provider of the
   * caller's own live hold at that time, if it is on one; else whichever
   * provider who offers the service is free.
   */
  providerId?: string | null;
  /** How long the caller can wait for Google, in milliseconds. */
  budgetMs: number;
  now?: Date;
  actor?: ActorContext;
  /** B's answer gate, asked once after the replay; false refuses with nothing written. */
  gate?: () => Promise<boolean>;
};

export type BookConversationResult =
  | {
      kind: "booked";
      startsAt: Date;
      minutes: number;
      canonicalService: string | null;
      /** The named provider whose calendar it is in; null for the location's own. */
      providerId: string | null;
      replayed: boolean;
      /** The booking recorded, when it is known: a chat's deposit link is made for it. */
      appointmentId: string | null;
      /** The request the booking confirmed. */
      requestId: string | null;
      /** A deposit left for the front desk, for the voice line (depositLine); never a link. */
      deposit: DepositLineFacts | null;
    }
  | {
      kind: "request_logged";
      reason: RequestReason;
      modeReasons?: BookingModeReasonCode[];
      replayed: boolean;
      deposit: DepositLineFacts | null;
      /** The request staff confirm, when it is known. */
      requestId?: string | null;
    }
  | { kind: "slot_taken"; alternatives: Date[] }
  | { kind: "in_progress" }
  | { kind: "key_reused"; first: "booked" | "request_logged"; firstStartsAt?: Date }
  | { kind: "unavailable" }
  /** B's answer gate refused the call. */
  | { kind: "refused" }
  | { kind: "invalid"; field: "first_name" | "at" | "phone" | "preferred_window" };

export type LogRequestInput = {
  channel: "voice";
  holderKey: string;
  bookingKey: string;
  firstName: string;
  phoneE164: string;
  preferredWindow: string;
  alternativeWindows?: string[];
  service: string | null;
  fields?: Record<string, string>;
  now?: Date;
  actor?: ActorContext;
};

export type LogRequestResult =
  | { kind: "request_logged"; replayed: boolean }
  | { kind: "key_reused"; first: "booked" | "request_logged"; firstStartsAt?: Date }
  | { kind: "invalid"; field: "first_name" | "phone" | "preferred_window" };

// -----------------------------------------------------------------------------
// bookConversation
// -----------------------------------------------------------------------------

export async function bookConversation(
  clinicId: string,
  input: BookConversationInput,
): Promise<BookConversationResult> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? ENGINE_ACTOR;
  const firstName = cleanFirstName(input.firstName);
  if (!firstName) return { kind: "invalid", field: "first_name" };
  if (!(input.startsAt instanceof Date) || !Number.isFinite(input.startsAt.getTime())) {
    return { kind: "invalid", field: "at" };
  }
  if (input.startsAt.getTime() <= now.getTime()) return { kind: "invalid", field: "at" };
  const phone = toE164(input.phoneE164);
  if (!phone) return { kind: "invalid", field: "phone" };
  const call = callOf(clinicId, input, { firstName, phone, now, actor });
  const holderRef = call.holderRef;

  // 0–1. The clinic's facts and the key's first answer, in one read.
  const facts = await withTenant({ clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const [agent] = await tx.db
      .select({ services: agentConfigs.services })
      .from(agentConfigs)
      .where(eq(agentConfigs.clinicId, tx.clinicId))
      .limit(1);
    return {
      timeZone: clinic?.timezone ?? "UTC",
      service: serviceDuration(agent?.services ?? [], input.service),
      prior: await priorOf(tx, input.bookingKey),
    };
  });
  const ask: Ask = {
    startsAt: input.startsAt,
    minutes: facts.service.minutes,
    canonical: facts.service.canonicalName,
    treatment: treatmentOf(facts.service.canonicalName, input.service),
    label: slotLabel(input.startsAt, facts.timeZone),
  };
  if (facts.prior) return replay(call, ask, facts.prior, true);
  if (input.gate && !(await input.gate())) return { kind: "refused" };

  // 2–4. The mode, the deposit gate, what this holder has in flight, and
  // the provider: the one named, else the one whose time the caller holds.
  const state = await withTenant({ clinicId, actor }, async (tx) => ({
    mode: await bookingModeFor(tx),
    gate: await depositGateFor(tx, {
      channel: depositChannelOf(call.channel),
      service: ask.canonical ?? input.service,
    }),
    inFlight: await inFlightUnderOtherKey(tx, holderRef, input.bookingKey),
    providerId: input.providerId ?? (await heldProviderOf(tx, holderRef, input.startsAt)),
  }));
  if (state.mode.mode !== "live") {
    return logInCall(call, ask, facts.timeZone, {
      reason: "manual",
      modeReasons: state.mode.reasons.map((r) => r.code),
    });
  }
  if (state.gate.branch === "decline") {
    return logInCall(call, ask, facts.timeZone, { reason: "deposit_required", gate: state.gate });
  }
  if (state.inFlight) return { kind: "in_progress" };

  // 5. The re-check, with no transaction open and a fresh token.
  const span = await checkSpan(clinicId, {
    startsAt: input.startsAt,
    service: ask.canonical ?? input.service,
    providerId: state.providerId,
    holderRef,
    fresh: true,
    now,
    actor,
  });
  if (span.status === "busy") {
    // The same booking asked twice at once: the other attempt's own event
    // is what Google shows busy. The key's first answer, not slot_taken.
    const raced = await withTenant({ clinicId, actor }, (tx) => priorOf(tx, input.bookingKey));
    if (raced) return replay(call, ask, raced, true);
    await releaseHolderHolds(clinicId, holderRef, "slot_taken", actor);
    return { kind: "slot_taken", alternatives: await alternativesNear(call, ask) };
  }
  if (span.status === "broken") {
    // Google's definitive no was recorded by the read (availability.ts):
    // the location books by request from this turn on.
    return logInCall(call, ask, facts.timeZone, { reason: "calendar_broken" });
  }
  if (span.status === "transient") return { kind: "unavailable" };
  if (span.status === "unavailable") {
    return logInCall(call, ask, facts.timeZone, {
      reason:
        span.reason === "not_writable" || span.reason === "outside_horizon"
          ? "calendar_not_permitted"
          : span.reason,
    });
  }
  ask.minutes = span.minutes;

  // 6. The claim.
  const reserve = state.gate.branch === "reserve";
  let claimed: Claimed;
  try {
    claimed = await withTenant({ clinicId, actor }, (tx) =>
      claim(tx, call, ask, facts.timeZone, span.calendarId, reserve ? state.gate : null),
    );
  } catch (error) {
    const { code, constraint } = pgErrorOf(error);
    if (error instanceof HoldLapsed) return { kind: "unavailable" };
    if (
      code === "23P01" ||
      (code === "23505" && constraint === "booking_requests_vendor_call_idx")
    ) {
      // A retry of this same booking may have claimed the span first.
      const prior = await withTenant({ clinicId, actor }, (tx) => priorOf(tx, input.bookingKey));
      if (prior) return replay(call, ask, prior, true);
      if (code === "23505") throw error;
      return { kind: "slot_taken", alternatives: await alternativesNear(call, ask) };
    }
    if (code === "23505") return { kind: "in_progress" };
    if (code === "23514") {
      // The hold trigger: the terms, the connection or Auto-confirm stopped
      // allowing the assistant's write since the mode was read.
      return logInCall(call, ask, facts.timeZone, { reason: "calendar_not_permitted" });
    }
    throw error;
  }

  // 7b. A deposit reservation: nothing goes to Google; staff confirm it.
  // The claim raised its L10 alert (D's recordDepositOutcome).
  if (!claimed.lease) {
    return {
      kind: "request_logged",
      reason: "deposit_hold",
      replayed: false,
      deposit: lineFacts(state.gate.outcome),
      requestId: claimed.requestId,
    };
  }

  // 7. The write, raced against the budget.
  const writing = writeHeldBooking(clinicId, claimed.holdId, claimed.lease, {
    firstName,
    actor,
    now,
  });
  const outcome = await withinBudget(writing, input.budgetMs);
  if (outcome === BUDGET) {
    writing.catch((error) =>
      log.error("assistant calendar write failed after the call moved on", {
        clinicId,
        requestId: claimed.requestId,
        error: describeError(error),
      }),
    );
    const seen = await answerAsRequest(clinicId, claimed.holdId, claimed.requestId, actor);
    if (seen === "answered") {
      return {
        kind: "request_logged",
        reason: "budget",
        replayed: false,
        deposit: null,
        requestId: claimed.requestId,
      };
    }
    // The write settled as the budget ran out: its own answer, a moment late.
    return answerOf(await writing, ask, span.providerId, claimed.requestId);
  }
  return answerOf(outcome, ask, span.providerId, claimed.requestId);
}

function answerOf(
  outcome: HeldWrite,
  ask: Ask,
  providerId: string | null,
  requestId: string,
): BookConversationResult {
  const request = { replayed: false, deposit: null, requestId } as const;
  switch (outcome.kind) {
    case "booked":
      return {
        kind: "booked",
        startsAt: outcome.startsAt,
        minutes: outcome.minutes,
        canonicalService: ask.canonical,
        providerId,
        replayed: false,
        deposit: outcome.deposit,
        appointmentId: outcome.appointmentId,
        requestId,
      };
    case "unconfirmed":
    case "lost":
      return { kind: "request_logged", reason: "unconfirmed", ...request };
    case "calendar_broken":
      return { kind: "request_logged", reason: "calendar_broken", ...request };
    case "refused":
      return { kind: "request_logged", reason: "write_refused", ...request };
    case "conflict":
      return { kind: "request_logged", reason: "record_conflict", ...request };
  }
}

// -----------------------------------------------------------------------------
// logRequest
// -----------------------------------------------------------------------------

/**
 * A request the caller asked for, in the call (plan §7.4): the preferred
 * window and up to two others, as words, for staff to confirm, with the
 * booking_request alert (L7). The same key and the same request is the
 * first answer again; the same key and a different one is `key_reused`.
 */
export async function logRequest(
  clinicId: string,
  input: LogRequestInput,
): Promise<LogRequestResult> {
  const now = input.now ?? new Date();
  const actor = input.actor ?? ENGINE_ACTOR;
  const firstName = cleanFirstName(input.firstName);
  if (!firstName) return { kind: "invalid", field: "first_name" };
  const phone = toE164(input.phoneE164);
  if (!phone) return { kind: "invalid", field: "phone" };
  const window = cleanWindow(input.preferredWindow);
  if (!window) return { kind: "invalid", field: "preferred_window" };
  const call = callOf(clinicId, input, { firstName, phone, now, actor });
  const facts = await withTenant({ clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const [agent] = await tx.db
      .select({ services: agentConfigs.services })
      .from(agentConfigs)
      .where(eq(agentConfigs.clinicId, tx.clinicId))
      .limit(1);
    return {
      timeZone: clinic?.timezone ?? "UTC",
      canonical: serviceDuration(agent?.services ?? [], input.service).canonicalName,
      prior: await priorOf(tx, input.bookingKey),
    };
  });
  const ask: Ask = {
    startsAt: null,
    minutes: 0,
    canonical: facts.canonical,
    treatment: treatmentOf(facts.canonical, input.service),
    label: window,
  };
  if (facts.prior) return requestReplay(call, ask, facts.prior);
  const logged = await logInCall(call, ask, facts.timeZone, {
    reason: "requested",
    alternatives: input.alternativeWindows ?? [],
  });
  if (logged.kind === "key_reused") return logged;
  return { kind: "request_logged", replayed: logged.kind === "request_logged" && logged.replayed };
}

async function requestReplay(call: Call, ask: Ask, prior: Prior): Promise<LogRequestResult> {
  const answer = await replay(call, ask, prior, false);
  if (answer.kind === "key_reused") return answer;
  if (answer.kind === "booked") {
    // A request asked for under a key that already booked is a different ask.
    return keyReused(prior);
  }
  return { kind: "request_logged", replayed: true };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** One call to the engine, validated. */
type Call = {
  clinicId: string;
  channel: "voice" | "web_chat";
  conversationId: string | null;
  holderKey: string;
  bookingKey: string;
  service: string | null;
  fields?: Record<string, string>;
  providerId: string | null;
  /** How long a replay may wait for a write in flight. */
  budgetMs: number;
  firstName: string;
  phone: string;
  holderRef: string;
  now: Date;
  actor: ActorContext;
};

function callOf(
  clinicId: string,
  input: BookConversationInput | LogRequestInput,
  checked: { firstName: string; phone: string; now: Date; actor: ActorContext },
): Call {
  return {
    clinicId,
    channel: input.channel,
    holderKey: input.holderKey,
    bookingKey: input.bookingKey,
    conversationId: "conversationId" in input ? (input.conversationId ?? null) : null,
    service: input.service,
    fields: input.fields,
    providerId: "providerId" in input ? (input.providerId ?? null) : null,
    budgetMs: "budgetMs" in input ? input.budgetMs : 0,
    holderRef: holderRefOf(clinicId, input.holderKey),
    ...checked,
  };
}

/** What this call asks for: the span (null for a request in words), the service, and the words for the desk. */
type Ask = {
  startsAt: Date | null;
  minutes: number;
  canonical: string | null;
  treatment: string | null;
  /** The preferred window as the desk reads it: the slot's label, or the caller's words. */
  label: string;
};

type Prior = {
  id: string;
  status: BookingRequestStatus;
  treatment: string | null;
  preferredWindow: string;
  confirmedFor: Date | null;
  appointmentId: string | null;
  hold: {
    id: string;
    status: string;
    startsAt: Date;
    minutes: number;
    holderRef: string;
    /** The named provider whose calendar the hold is on; null for the location's own. */
    providerId: string | null;
  } | null;
};

async function priorOf(tx: TenantTx, bookingKey: string): Promise<Prior | null> {
  // One statement, so the request and its hold come from one snapshot. Read
  // apart, a record step committing between the two reads (the hold
  // converted and the request confirmed together, writer.ts) showed a retry
  // the request still `requested` beside a hold already `converted`, and
  // the retry answered "already logged" for a booking that had gone in.
  const latestHold = sql`(
    select h.id from slot_holds h
     where h.booking_request_id = ${bookingRequests.id}
     order by h.created_at desc
     limit 1)`;
  const [row] = await tx.db
    .select({
      id: bookingRequests.id,
      status: bookingRequests.status,
      treatment: bookingRequests.treatment,
      preferredWindow: bookingRequests.preferredWindow,
      confirmedFor: bookingRequests.confirmedFor,
      appointmentId: bookingRequests.appointmentId,
      holdId: slotHolds.id,
      holdStatus: slotHolds.status,
      holdStartsAt: slotHolds.startsAt,
      holdMinutes: slotHolds.durationMinutes,
      holdHolderRef: slotHolds.holderRef,
      holdCalendarId: slotHolds.calendarId,
    })
    .from(bookingRequests)
    .leftJoin(slotHolds, eq(slotHolds.id, latestHold))
    .where(
      and(eq(bookingRequests.clinicId, tx.clinicId), eq(bookingRequests.vendorCallId, bookingKey)),
    )
    .limit(1);
  if (!row) return null;
  const {
    holdId,
    holdStatus,
    holdStartsAt,
    holdMinutes,
    holdHolderRef,
    holdCalendarId,
    ...request
  } = row;
  if (
    holdId === null ||
    holdStatus === null ||
    holdStartsAt === null ||
    holdMinutes === null ||
    holdHolderRef === null ||
    holdCalendarId === null
  ) {
    return { ...request, hold: null };
  }
  return {
    ...request,
    hold: {
      id: holdId,
      status: holdStatus,
      startsAt: holdStartsAt,
      minutes: holdMinutes,
      holderRef: holdHolderRef,
      providerId: await providerOnCalendar(tx, holdCalendarId),
    },
  };
}

/**
 * The active named provider whose calendar `calendarId` is, while the
 * location books by provider; null for the location's own calendar.
 */
export async function providerOnCalendar(tx: TenantTx, calendarId: string): Promise<string | null> {
  const [row] = await tx.db
    .select({ id: clinicProviders.id })
    .from(clinicProviders)
    .innerJoin(clinicSettings, eq(clinicSettings.clinicId, clinicProviders.clinicId))
    .where(
      and(
        eq(clinicProviders.clinicId, tx.clinicId),
        eq(clinicProviders.calendarId, calendarId),
        eq(clinicProviders.active, true),
        eq(clinicSettings.bookingDetail, "named_provider"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * The provider of this holder's live hold at exactly `startsAt`, if it is on
 * a named provider's calendar: what a booking that names nobody books, so a
 * caller who held Dr Kim's time is never moved to Dr Lee's.
 */
async function heldProviderOf(
  tx: TenantTx,
  holderRef: string,
  startsAt: Date,
): Promise<string | null> {
  const [hold] = await tx.db
    .select({ calendarId: slotHolds.calendarId })
    .from(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, holderRef),
        eq(slotHolds.status, "held"),
        sql`${slotHolds.expiresAt} > clock_timestamp()`,
        eq(slotHolds.startsAt, startsAt),
      ),
    )
    .limit(1);
  return hold ? providerOnCalendar(tx, hold.calendarId) : null;
}

/**
 * The answer to a key that already has a request (plan §7.7 step 1). With
 * `poll`, a write this holder has in flight under the key is waited for, up
 * to the budget, every 250 ms.
 */
async function replay(
  call: Call,
  ask: Ask,
  prior: Prior,
  poll: boolean,
): Promise<BookConversationResult> {
  if (!sameAsk(prior, ask)) return keyReused(prior);
  if (prior.status === "confirmed") {
    const deposit = prior.appointmentId
      ? await withTenant({ clinicId: call.clinicId, actor: call.actor }, (tx) =>
          bookedDepositLine(tx, prior.appointmentId!),
        )
      : null;
    return {
      kind: "booked",
      startsAt: prior.confirmedFor ?? prior.hold?.startsAt ?? ask.startsAt ?? call.now,
      minutes: prior.hold?.minutes ?? ask.minutes,
      canonicalService: ask.canonical,
      providerId: prior.hold?.providerId ?? null,
      replayed: true,
      deposit,
      appointmentId: prior.appointmentId,
      requestId: prior.id,
    };
  }
  if (
    poll &&
    prior.status === "requested" &&
    prior.hold?.status === "writing" &&
    prior.hold.holderRef === call.holderRef
  ) {
    const deadline = Date.now() + Math.max(0, call.budgetMs);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const again = await withTenant({ clinicId: call.clinicId, actor: call.actor }, (tx) =>
        priorOf(tx, call.bookingKey),
      );
      if (!again) break;
      if (again.status !== "requested" || again.hold?.status !== "writing") {
        return replay(call, ask, again, false);
      }
    }
    // The budget ran out with the first attempt's write still in flight:
    // this caller is answered with a request, as the first attempt answers
    // when its own budget runs out, and the alert goes once between them.
    const seen = await answerAsRequest(call.clinicId, prior.hold.id, prior.id, call.actor);
    if (seen === "answered") {
      return {
        kind: "request_logged",
        reason: "budget",
        replayed: true,
        deposit: null,
        requestId: prior.id,
      };
    }
    const settled = await withTenant({ clinicId: call.clinicId, actor: call.actor }, (tx) =>
      priorOf(tx, call.bookingKey),
    );
    if (settled) return replay(call, ask, settled, false);
  }
  const logged = { replayed: true, deposit: null, requestId: prior.id } as const;
  if (prior.hold?.status === "reserved") {
    return { kind: "request_logged", reason: "deposit_hold", ...logged };
  }
  if (prior.hold?.status === "unknown" || prior.hold?.status === "writing") {
    return { kind: "request_logged", reason: "unconfirmed", ...logged };
  }
  // A request taken for a deposit says so again, as the clinic's switches stand.
  const gate = await withTenant({ clinicId: call.clinicId, actor: call.actor }, (tx) =>
    depositGateFor(tx, { channel: depositChannelOf(call.channel), service: prior.treatment }),
  );
  return gate.branch === "decline"
    ? {
        kind: "request_logged",
        reason: "deposit_required",
        ...logged,
        deposit: lineFacts(gate.outcome),
      }
    : { kind: "request_logged", reason: "already_logged", ...logged };
}

/** The same booking: its span (or window) and its service. */
function sameAsk(prior: Prior, ask: Ask): boolean {
  const sameService = keyOf(prior.treatment) === keyOf(ask.treatment);
  if (!ask.startsAt) return sameService && keyOf(prior.preferredWindow) === keyOf(ask.label);
  const sameSpan = prior.hold
    ? prior.hold.startsAt.getTime() === ask.startsAt.getTime() && prior.hold.minutes === ask.minutes
    : prior.confirmedFor
      ? prior.confirmedFor.getTime() === ask.startsAt.getTime()
      : keyOf(prior.preferredWindow) === keyOf(ask.label);
  return sameSpan && sameService;
}

/**
 * `key_reused`: a second booking asked for under a key that has one. The
 * caller is told the assistant books one per call and the clinic will
 * arrange the other (C14's lines); the clinic is not alerted again, as the
 * first booking or request is already in Bookings.
 */
function keyReused(prior: Prior): {
  kind: "key_reused";
  first: "booked" | "request_logged";
  firstStartsAt?: Date;
} {
  return prior.status === "confirmed"
    ? {
        kind: "key_reused",
        first: "booked",
        ...(prior.confirmedFor ? { firstStartsAt: prior.confirmedFor } : {}),
      }
    : { kind: "key_reused", first: "request_logged" };
}

/** Whether this holder has a write unsettled under a key other than this one. */
async function inFlightUnderOtherKey(
  tx: TenantTx,
  holderRef: string,
  bookingKey: string,
): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: slotHolds.id })
    .from(slotHolds)
    .leftJoin(bookingRequests, eq(bookingRequests.id, slotHolds.bookingRequestId))
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, holderRef),
        inArray(slotHolds.status, ["writing", "unknown"]),
        sql`${bookingRequests.vendorCallId} is distinct from ${bookingKey}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

type Claimed = { holdId: string; lease: string | null; requestId: string };

class HoldLapsed extends Error {
  constructor() {
    super("The hold lapsed between its check and its claim.");
  }
}

/**
 * Step 6 (plan §7.7): one transaction under the calendar lock. A 23P01 (the
 * span taken), a 23505 (the key or the holder's one write) or a 23514 (the
 * write no longer permitted) rolls all of it back for the caller to answer.
 * With a deposit `reserve` gate, the hold is reserved for staff instead of
 * claimed for a write, and the L10 alert raised.
 */
async function claim(
  tx: TenantTx,
  call: Call,
  ask: Ask,
  timeZone: string,
  calendarId: string,
  reserve: DepositGate | null,
): Promise<Claimed> {
  const startsAt = ask.startsAt!;
  await lockClinicCalendar(tx);
  const contactId = await upsertCallerContact(tx.db, {
    clinicId: tx.clinicId,
    phone: call.phone,
    name: call.firstName,
    clinicTimezone: timeZone,
  });
  const [match] = await tx.db
    .select({ id: slotHolds.id })
    .from(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, call.holderRef),
        eq(slotHolds.status, "held"),
        sql`${slotHolds.expiresAt} > clock_timestamp()`,
        eq(slotHolds.startsAt, startsAt),
        eq(slotHolds.durationMinutes, ask.minutes),
        eq(slotHolds.calendarId, calendarId),
      ),
    )
    .limit(1);
  let holdId: string;
  if (match) {
    await tx.db
      .update(slotHolds)
      .set({
        status: sql`case when ${slotHolds.expiresAt} <= clock_timestamp() then 'expired' else 'released' end`,
        outcomeReason: "superseded",
        releasedAt: sql`clock_timestamp()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(slotHolds.clinicId, tx.clinicId),
          eq(slotHolds.holderRef, call.holderRef),
          eq(slotHolds.status, "held"),
          ne(slotHolds.id, match.id),
        ),
      );
    holdId = match.id;
  } else {
    // A 23P01 here (another holder, or a booking, has the span) propagates.
    const placed = await holdSpanWithin(tx, {
      channel: call.channel,
      holderKey: call.holderKey,
      calendarId,
      startsAt,
      minutes: ask.minutes,
      contactId,
      callRef: call.holderRef,
    });
    if (placed.kind !== "held") throw new HoldLapsed();
    holdId = placed.holdId;
  }
  const created = await createBookingRequest(tx, {
    channel: call.channel,
    contactId,
    conversationId: call.conversationId,
    preferredWindow: ask.label,
    treatment: ask.treatment,
    collectedFields: call.fields,
    vendorCallId: call.bookingKey,
    bookedVia: reserve ? "desk" : "agent_direct",
  });
  if (reserve) {
    const [moved] = await tx.db
      .update(slotHolds)
      .set({
        status: "reserved",
        contactId,
        bookingRequestId: created.id,
        blocksUntil: sql`clock_timestamp() + make_interval(mins => ${reserve.holdMinutes})`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(slotHolds.id, holdId),
          eq(slotHolds.status, "held"),
          sql`${slotHolds.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: slotHolds.id });
    if (!moved) throw new HoldLapsed();
    tx.audit.record({
      action: "update",
      resourceType: "slot_hold",
      resourceId: holdId,
      metadata: { outcome: "reserved", holdMinutes: reserve.holdMinutes },
    });
    await recordDepositOutcome(tx, reserve.outcome, {
      bookingRequestId: created.id,
      ...chatRef(call),
    });
    return { holdId, lease: null, requestId: created.id };
  }
  const lease = randomUUID();
  const [moved] = await tx.db
    .update(slotHolds)
    .set({
      status: "writing",
      contactId,
      bookingRequestId: created.id,
      leaseToken: lease,
      leaseUntil: sql`clock_timestamp() + interval '30 seconds'`,
      insertAttemptedAt: sql`clock_timestamp()`,
      blocksUntil: sql`clock_timestamp() + interval '15 minutes'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(slotHolds.id, holdId),
        eq(slotHolds.status, "held"),
        sql`${slotHolds.expiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: slotHolds.id });
  if (!moved) throw new HoldLapsed();
  tx.audit.record({
    action: "update",
    resourceType: "slot_hold",
    resourceId: holdId,
    metadata: { outcome: "writing", callRef: call.holderRef },
  });
  return { holdId, lease, requestId: created.id };
}

/**
 * Step 8 (plan §7.7): a request in the call and this holder's held time let
 * go, with the clinic's alert in the same transaction: booking_request
 * (L7), or for a deposit a call cannot take, D's deposit_to_collect (L10)
 * instead, one alert for the one event. A request already under the key (a
 * race with a retry) is answered by the replay, and alerts nothing again.
 */
async function logInCall(
  call: Call,
  ask: Ask,
  timeZone: string,
  how: {
    reason: RequestReason;
    modeReasons?: BookingModeReasonCode[];
    gate?: DepositGate;
    alternatives?: string[];
  },
): Promise<BookConversationResult> {
  let requestId: string;
  try {
    requestId = await withTenant({ clinicId: call.clinicId, actor: call.actor }, async (tx) => {
      const contactId = await upsertCallerContact(tx.db, {
        clinicId: tx.clinicId,
        phone: call.phone,
        name: call.firstName,
        clinicTimezone: timeZone,
      });
      const created = await createBookingRequest(tx, {
        channel: call.channel,
        contactId,
        conversationId: call.conversationId,
        preferredWindow: ask.label,
        treatment: ask.treatment,
        alternativeWindows: how.alternatives ?? [],
        collectedFields: call.fields,
        vendorCallId: call.bookingKey,
      });
      await releaseHeldWithin(tx, call.holderRef, "request_logged");
      const ref = { bookingRequestId: created.id, ...chatRef(call) };
      if (how.gate) {
        await recordDepositOutcome(tx, how.gate.outcome, ref);
      } else {
        await notifyBookingAlert(tx, "booking_request", ref);
      }
      return created.id;
    });
  } catch (error) {
    const { code, constraint } = pgErrorOf(error);
    if (code === "23505" && constraint === "booking_requests_vendor_call_idx") {
      const prior = await withTenant({ clinicId: call.clinicId, actor: call.actor }, (tx) =>
        priorOf(tx, call.bookingKey),
      );
      if (prior) return replay(call, ask, prior, false);
    }
    throw error;
  }
  return {
    kind: "request_logged",
    reason: how.reason,
    ...(how.modeReasons ? { modeReasons: how.modeReasons } : {}),
    replayed: false,
    deposit: how.gate ? lineFacts(how.gate.outcome) : null,
    requestId,
  };
}

/** A chat's alert names its conversation and the website, as the chat's own request does (lib/chat/web-chat.ts). */
function chatRef(call: Call): { conversationId?: string; channel?: "web" } {
  if (call.channel !== "web_chat") return {};
  return {
    channel: "web",
    ...(call.conversationId ? { conversationId: call.conversationId } : {}),
  };
}

function depositChannelOf(channel: Call["channel"]): "voice" | "web" {
  return channel === "web_chat" ? "web" : "voice";
}

/** Let go of this holder's `held` time, with a reason. */
async function releaseHeldWithin(tx: TenantTx, holderRef: string, reason: string): Promise<void> {
  await tx.db
    .update(slotHolds)
    .set({
      status: sql`case when ${slotHolds.expiresAt} <= clock_timestamp() then 'expired' else 'released' end`,
      outcomeReason: reason,
      releasedAt: sql`clock_timestamp()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        eq(slotHolds.holderRef, holderRef),
        eq(slotHolds.status, "held"),
      ),
    );
}

async function releaseHolderHolds(
  clinicId: string,
  holderRef: string,
  reason: string,
  actor: ActorContext,
): Promise<void> {
  await withTenant({ clinicId, actor }, (tx) => releaseHeldWithin(tx, holderRef, reason));
}

/**
 * Up to three free times nearest the one asked for (plan §7.5, §6.2), over a
 * few days around it, for this holder; none when Google cannot say.
 */
export async function alternativesNear(
  call: {
    clinicId: string;
    holderRef: string;
    now: Date;
    actor: ActorContext;
    service: string | null;
    providerId?: string | null;
  },
  ask: { startsAt: Date | null; canonical: string | null },
): Promise<Date[]> {
  if (!ask.startsAt) return [];
  try {
    const found = await availableSlotsFor(call.clinicId, {
      from: new Date(ask.startsAt.getTime() - 2 * 86_400_000),
      days: 5,
      service: ask.canonical ?? call.service,
      providerId: call.providerId ?? null,
      holderRef: call.holderRef,
      now: call.now,
      actor: call.actor,
    });
    if (found.status !== "ok") return [];
    return nearestAlternatives(
      found.slots.map((s) => s.at),
      ask.startsAt,
      3,
    );
  } catch (error) {
    log.warn("alternatives not read", { clinicId: call.clinicId, error: describeError(error) });
    return [];
  }
}

const BUDGET = Symbol("budget");

async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | typeof BUDGET> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof BUDGET>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET), Math.max(0, budgetMs));
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The caller is about to be answered with a request while the write is in
 * flight (plan §7.8's budget row; the coordinator's ruling of 12 October):
 * the request is the desk's, so its booking_request alert (L7) goes now, in
 * the transaction that records that answer on the hold (ANSWERED_AS_REQUEST),
 * under the hold's row lock. Every transaction that settles the hold takes
 * that lock first and reads the mark, so the writer raises nothing of its
 * own for this request afterwards, and a booking that lands is recorded as
 * confirmed after the call, which is what staff calling back see. A retry
 * that finds the mark already there sends nothing more.
 *
 * `answered` when the caller is to hear the request. Otherwise the write
 * settled first and raised its own alert, if any: `settled`, and the caller
 * hears what it came to.
 */
async function answerAsRequest(
  clinicId: string,
  holdId: string,
  requestId: string,
  actor: ActorContext,
): Promise<"answered" | "settled"> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [hold] = await tx.db
      .select({ status: slotHolds.status, outcomeReason: slotHolds.outcomeReason })
      .from(slotHolds)
      .where(and(eq(slotHolds.id, holdId), eq(slotHolds.clinicId, tx.clinicId)))
      .for("update")
      .limit(1);
    if (hold?.status !== "writing") return "settled";
    if (hold.outcomeReason === ANSWERED_AS_REQUEST) return "answered";
    await tx.db
      .update(slotHolds)
      .set({ outcomeReason: ANSWERED_AS_REQUEST, updatedAt: sql`now()` })
      .where(and(eq(slotHolds.id, holdId), eq(slotHolds.status, "writing")));
    tx.audit.record({
      action: "update",
      resourceType: "booking_request",
      resourceId: requestId,
      metadata: { outcome: ANSWERED_AS_REQUEST, reason: "budget" },
    });
    await notifyBookingAlert(tx, "booking_request", { bookingRequestId: requestId });
    return "answered";
  });
}

function lineFacts(outcome: DepositOutcome): DepositLineFacts | null {
  return outcome.isRequired ? { action: outcome.action, amountUsd: outcome.amountUsd } : null;
}

function cleanFirstName(raw: string): string | null {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return name.length > 0 && name.length <= 40 && FIRST_NAME.test(name) ? name : null;
}

function cleanWindow(raw: string): string | null {
  const window = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return window.length > 0 ? window.slice(0, MAX_WINDOW_CHARS) : null;
}

/** The service a request records: the clinic's own name for it, else the caller's words. */
function treatmentOf(canonical: string | null, asked: string | null): string | null {
  if (canonical) return canonical;
  const words = typeof asked === "string" ? asked.trim().replace(/\s+/g, " ") : "";
  return words ? words.slice(0, MAX_WINDOW_CHARS) : null;
}

function keyOf(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function pgErrorOf(error: unknown): { code?: string; constraint?: string } {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return {};
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}
