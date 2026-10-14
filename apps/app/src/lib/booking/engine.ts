// No channel calls this yet: the assistant takes requests for the desk, and direct booking waits on HEALDESK_DIRECT_BOOKING_ENABLED.

import type { SlotHoldChannel } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import type { DepositChannel } from "@/lib/billing/deposits";
import { withTenant } from "@/lib/tenant";

import { availableSlotsFor, checkSpan } from "./availability";
import { alternativesNear } from "./book";
import { depositGateFor } from "./deposit-gate";
import { holderRefOf, holdSpanWithin, lockClinicCalendar, writeInFlight } from "./holds";
import { bookingModeFor } from "./mode";

/**
 * The booking engine (plan §7.4; the design record's §6): what the Retell
 * process (launch plan 2.1) and the web-chat and Meta adapters will call
 * once direct booking is switched on. Nothing else writes the assistant's
 * bookings, and Google is never called inside a database transaction.
 *
 *   offerTimes          free start times for a service, each with the named
 *                       provider whose calendar it is on, while the location
 *                       may offer real times (canOfferTimes, not the mode:
 *                       with Auto-confirm off, or still in setup, real times
 *                       are offered and the time chosen becomes a request);
 *   placeHold           60 seconds on one start, before the details are
 *                       taken, while the location books live;
 *   bookConversation    hold, re-check, claim, write, record (book.ts);
 *   logRequest          a request in the caller's words (book.ts).
 *
 * The clinic is told through booking alerts (lib/notices/booking-alerts.ts),
 * each raised inside the transaction that commits what it reports, so a
 * process that dies leaves nothing committed untold: there is no notice to
 * send afterwards, no desk link to mail and no post-call step to make sure
 * of it. Which alert each outcome raises is in book.ts and writer.ts.
 *
 * The keys (plan §7.13): Retell's holder is "retell:" + call id and its
 * booking key "retell:" + call id + ":" + n, n growing only when the caller
 * asks for another booking. A booking key is unique per clinic
 * (booking_requests.vendor_call_id): a retried tool call, a duplicate
 * webhook or a repeated tool call under it returns the original booking,
 * and a different booking asked for under it is refused (`key_reused`).
 *
 * The funnel's "Talk to your AYA" preview (not built yet), whose tools
 * will hold and write nothing, is to call offerTimes only.
 */

export { bookConversation, logRequest } from "./book";
export type {
  BookConversationInput,
  BookConversationResult,
  LogRequestInput,
  LogRequestResult,
  RequestReason,
} from "./book";

const ENGINE_ACTOR: ActorContext = { type: "service", serviceName: "booking-engine" };

export type OfferTimesInput = {
  channel: SlotHoldChannel;
  holderKey: string;
  /** The earliest start the person asked about. */
  from?: Date | null;
  /** A date the person named: its start, in the clinic's zone; times that day only (up to 60 days out). */
  day?: Date | null;
  service?: string | null;
  providerId?: string | null;
  now?: Date;
  actor?: ActorContext;
};

/** One start on offer, and the named provider whose calendar it is free on (null: the location's own). */
export type OfferedTime = { at: Date; providerId: string | null };

export type OfferTimes =
  | {
      status: "ok";
      timeZone: string;
      serviceMinutes: number;
      canonicalService: string | null;
      slots: OfferedTime[];
    }
  /** The location takes requests: the mode's reason codes, or `deposit_required`, or why no time can be read. */
  | { status: "request_only"; reasons: string[] }
  /** Google did not answer this time; nothing changed. */
  | { status: "unavailable" };

export async function offerTimes(clinicId: string, input: OfferTimesInput): Promise<OfferTimes> {
  const actor = input.actor ?? ENGINE_ACTOR;
  const state = await withTenant({ clinicId, actor }, async (tx) => ({
    mode: await bookingModeFor(tx),
    gate: await depositGateFor(tx, {
      channel: depositChannelOf(input.channel),
      service: input.service ?? null,
    }),
  }));
  if (!state.mode.canOfferTimes) {
    return { status: "request_only", reasons: state.mode.reasons.map((r) => r.code) };
  }
  if (state.gate.branch === "decline") {
    return { status: "request_only", reasons: ["deposit_required"] };
  }
  const found = await availableSlotsFor(clinicId, {
    from: input.day ?? input.from ?? null,
    ...(input.day ? { days: 1 } : {}),
    service: input.service ?? null,
    providerId: input.providerId ?? null,
    holderRef: holderRefOf(clinicId, input.holderKey),
    now: input.now,
    actor,
  });
  if (found.status === "ok") {
    return {
      status: "ok",
      timeZone: found.timeZone,
      serviceMinutes: found.serviceMinutes,
      canonicalService: found.canonicalService,
      slots: found.slots.map((slot) => ({ at: slot.at, providerId: slot.providerId })),
    };
  }
  if (found.status === "transient") return { status: "unavailable" };
  return {
    status: "request_only",
    reasons: [found.status === "broken" ? "calendar_broken" : found.reason],
  };
}

export type PlaceHoldInput = {
  channel: SlotHoldChannel;
  holderKey: string;
  startsAt: Date;
  service: string | null;
  providerId?: string | null;
  /** The person, where the channel already knows them; web chat must (spec, the chat widget). */
  contactId?: string | null;
  now?: Date;
  actor?: ActorContext;
};

export type PlacedHold =
  | {
      kind: "held";
      holdId: string;
      expiresAt: Date;
      startsAt: Date;
      minutes: number;
      /** The named provider whose calendar the time is held on; null for the location's own. */
      providerId: string | null;
    }
  | { kind: "slot_taken"; alternatives: Date[] }
  | { kind: "request_only"; reasons: string[] }
  /** This caller's last booking is still being written to Google: nothing else until it settles. */
  | { kind: "in_progress" }
  | { kind: "unavailable" };

/**
 * Hold one start for 60 seconds while the details are taken (plan §7.5):
 * only while the location books live and no deposit gate declines; the
 * start must be one the assistant would have offered (checkSpan), and the
 * database refuses one another holder or a healdesk booking already has.
 * A holder holds one time at once: a new hold lets go of its last. A holder
 * whose write is unsettled holds nothing (`in_progress`, lib/booking/holds.ts
 * writeInFlight): the record step for that write would meet the new hold and
 * turn a booking already in Google into a conflict.
 */
export async function placeHold(clinicId: string, input: PlaceHoldInput): Promise<PlacedHold> {
  const actor = input.actor ?? ENGINE_ACTOR;
  const now = input.now ?? new Date();
  if (!(input.startsAt instanceof Date) || !Number.isFinite(input.startsAt.getTime())) {
    return { kind: "unavailable" };
  }
  const holderRef = holderRefOf(clinicId, input.holderKey);
  const state = await withTenant({ clinicId, actor }, async (tx) => ({
    mode: await bookingModeFor(tx),
    gate: await depositGateFor(tx, {
      channel: depositChannelOf(input.channel),
      service: input.service,
    }),
    inFlight: await writeInFlight(tx, holderRef),
  }));
  if (state.mode.mode !== "live") {
    return { kind: "request_only", reasons: state.mode.reasons.map((r) => r.code) };
  }
  if (state.gate.branch === "decline")
    return { kind: "request_only", reasons: ["deposit_required"] };
  if (input.channel === "web_chat" && !input.contactId) {
    return { kind: "request_only", reasons: ["contact_required"] };
  }
  // Asked again under the lock below; here only to spare Google the read.
  if (state.inFlight) return { kind: "in_progress" };
  const near = {
    clinicId,
    holderRef,
    now,
    actor,
    service: input.service,
    providerId: input.providerId,
  };
  const span = await checkSpan(clinicId, {
    startsAt: input.startsAt,
    service: input.service,
    providerId: input.providerId ?? null,
    holderRef,
    fresh: false,
    now,
    actor,
  });
  if (span.status === "busy") {
    return {
      kind: "slot_taken",
      alternatives: await alternativesNear(near, { startsAt: input.startsAt, canonical: null }),
    };
  }
  if (span.status === "broken") return { kind: "request_only", reasons: ["calendar_broken"] };
  if (span.status === "transient") return { kind: "unavailable" };
  if (span.status === "unavailable") return { kind: "request_only", reasons: [span.reason] };
  let placed: Awaited<ReturnType<typeof holdSpanWithin>> | { kind: "in_progress" };
  try {
    // Under the calendar lock, as the claim moves a hold into `writing`, so
    // the check and the insert see the same holds.
    placed = await withTenant({ clinicId, actor }, async (tx) => {
      await lockClinicCalendar(tx);
      if (await writeInFlight(tx, holderRef)) return { kind: "in_progress" as const };
      return holdSpanWithin(tx, {
        channel: input.channel,
        holderKey: input.holderKey,
        calendarId: span.calendarId,
        startsAt: input.startsAt,
        minutes: span.minutes,
        contactId: input.contactId ?? null,
        callRef: holderRef,
      });
    });
  } catch (error) {
    if (pgCodeOf(error) !== "23P01") throw error;
    placed = { kind: "slot_taken" };
  }
  if (placed.kind === "held") return { ...placed, providerId: span.providerId };
  if (placed.kind === "in_progress") return placed;
  return {
    kind: "slot_taken",
    alternatives: await alternativesNear(near, { startsAt: input.startsAt, canonical: null }),
  };
}

function pgCodeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function depositChannelOf(channel: SlotHoldChannel): DepositChannel {
  return channel === "web_chat" ? "web" : channel;
}
