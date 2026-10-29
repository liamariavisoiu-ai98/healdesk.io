import type { Channel } from "@healdesk/catalog";

import type { AgentService, DepositPolicy } from "@/db/schema";
import type { BookingEngine } from "@/lib/assistant/booking-tools";
import { depositLinkText } from "@/lib/billing/deposit-link";
import {
  depositDecision,
  effectiveDepositUsd,
  findService,
  readClinicDepositFacts,
  type DepositFacts,
  type DepositOutcome,
} from "@/lib/billing/deposits";
import { bookedDepositOutcome, depositBranch } from "@/lib/booking/deposit-gate";
import { directBookingOpen } from "@/lib/booking/direct-switch";
import { HOLD_SECONDS } from "@/lib/booking/holds";
import { bookingModeFor, modeOfReasons, type BookingModeReasonCode } from "@/lib/booking/mode";
import type { TenantTx } from "@/lib/tenant";

/**
 * The booking side of the practice questions (plan Part G; spec, "The
 * pre-launch audit": "Correct slot held, correct booking written, correct
 * confirmation spoken", and "Follows the clinic's configured deposit
 * behaviour exactly").
 *
 * The booking cases are asked of the real fixed tool layer
 * (lib/assistant/booking-tools.ts, bookingTools), exactly as the website chat
 * and the call wire it, with one difference: the engine beneath it is this
 * file's practice engine, which answers by the real engine's own rules and
 * writes nothing. A practice run must never hold a time in a clinic's
 * calendar, write a booking into its Google Calendar, log a request for its
 * desk or open a Stripe session on its account: the run is synthetic, and
 * the clinic is not live. So the practice engine
 *
 *   - decides the mode and the deposit with the real deciders, over the
 *     clinic's own settings as the practice read them (PracticeBookingFacts):
 *     modeOfReasons (lib/booking/mode.ts) and depositDecision with
 *     depositBranch (lib/billing/deposits.ts, lib/booking/deposit-gate.ts),
 *     the functions offerTimes, placeHold and bookConversation ask;
 *   - offers three synthetic free times on the day asked, holds a time for
 *     HOLD_SECONDS, books once per booking key (a retry under the same key
 *     replays the first booking, as book.ts does), and records every call in
 *     a ledger the checks read (checks.ts, bookingCaseChecks);
 *   - makes a deposit's link from the same fixed words a real one is sent in
 *     (depositLinkText) around a synthetic Checkout URL, and previews what
 *     its session would carry to Stripe with the link's own sessionParams
 *     (depositSessionPreview), so the check that no service name reaches a
 *     payment field reads the real builder.
 *
 * What the real engine adds on top (the calendar lock, Google's re-check,
 * the claim's exclusion constraint, the idempotent write) is the engine's
 * own suite's to prove (tests/booking-engine.test.ts, booking-tools.test.ts);
 * what the practice questions prove is that this clinic's brain, prompt and
 * settings drive the tool layer to the right booking and the right words.
 */

/** The clinic's booking settings as a practice run reads them: part of every channel's input version. */
export type PracticeBookingFacts = {
  /**
   * The owner's direct-booking switch (lib/booking/direct-switch.ts,
   * directBookingOpen), or the value a caller injected for its own run
   * (readPracticeInputs' `directBookingOpen`). Off, no channel offers the
   * tools: every booking is a request for the desk, as production takes it.
   */
  directOpen: boolean;
  /**
   * The location's booking-mode reasons, read as they would be once the
   * script is approved (the practice's own pass approves it), and with the
   * switch's reason as `directOpen` says.
   */
  modeReasons: BookingModeReasonCode[];
  deposits: {
    depositsEnabled: boolean;
    isConnected: boolean;
    bookVoiceWithoutDeposit: boolean;
    bookChatWithoutDeposit: boolean;
    uncollectable: DepositFacts["uncollectable"];
    holdMinutes: number;
    /** The configured services' names and deposits, as the engine's deposit gate reads them. */
    services: { name: string; depositUsd: number | null }[];
    policy: DepositPolicy | null;
  };
};

/** No direct booking and no deposits: what a channel input without booking facts is read as. */
export const NO_DIRECT_BOOKING: PracticeBookingFacts = {
  directOpen: false,
  modeReasons: ["kill_switch_off"],
  deposits: {
    depositsEnabled: false,
    isConnected: false,
    bookVoiceWithoutDeposit: true,
    bookChatWithoutDeposit: false,
    uncollectable: "decline_and_alert",
    holdMinutes: 60,
    services: [],
    policy: null,
  },
};

/** The tenant clinic's booking facts, for its practice run. `directOpen` defaults to the real switch. */
export async function readPracticeBookingFacts(
  tx: TenantTx,
  options: { directBookingOpen?: () => boolean } = {},
): Promise<PracticeBookingFacts> {
  const directOpen = (options.directBookingOpen ?? directBookingOpen)();
  const mode = await bookingModeFor(tx);
  const deposits = await readClinicDepositFacts(tx);
  const reasons: BookingModeReasonCode[] = mode.reasons
    .map((r) => r.code)
    // As approved, and with the switch as this run reads it.
    .filter((code) => code !== "agent_not_approved" && code !== "kill_switch_off");
  if (!directOpen) reasons.push("kill_switch_off");
  return {
    directOpen,
    modeReasons: reasons,
    deposits: {
      depositsEnabled: deposits.depositsEnabled,
      isConnected: deposits.isConnected,
      bookVoiceWithoutDeposit: deposits.bookVoiceWithoutDeposit,
      bookChatWithoutDeposit: deposits.bookChatWithoutDeposit,
      uncollectable: deposits.uncollectable,
      holdMinutes: deposits.holdMinutes,
      services: deposits.services.map((s) => ({ name: s.name, depositUsd: s.depositUsd ?? null })),
      policy: deposits.policy,
    },
  };
}

/** Whether the tools are offered on this channel: the switch, and a location that can offer real times (booking-tools.ts available()). */
export function practiceToolsLive(facts: PracticeBookingFacts): boolean {
  return facts.directOpen && modeOfReasons(facts.modeReasons).canOfferTimes;
}

/** The deposit decision for one service on one channel, as the engine's deposit gate takes it. */
export function practiceDeposit(
  facts: PracticeBookingFacts,
  channel: "voice" | "web" | "meta",
  service: string | null,
): DepositOutcome {
  const d = facts.deposits;
  const found = findService(d.services as AgentService[], service);
  return depositDecision({
    channel,
    depositsEnabled: d.depositsEnabled,
    isConnected: d.isConnected,
    amountUsd: effectiveDepositUsd({ service: found, policy: d.policy }),
    bookVoiceWithoutDeposit: d.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: d.bookChatWithoutDeposit,
    uncollectable: d.uncollectable,
    // The website chat can send its link in the conversation (engine.ts
    // canCollectNow); a Meta request's link goes after staff confirm it, in
    // a window the practice cannot see, so it is read as sendable.
    canCollectNow: channel !== "voice",
  });
}

// -----------------------------------------------------------------------------
// What a booking case must come to
// -----------------------------------------------------------------------------

/**
 * What the clinic's settings say a booking case must come to on a channel:
 *
 *   request         nothing written: the desk gets a request (the tools are
 *                   off, the location books by request, or a deposit this
 *                   channel cannot take declines the booking);
 *   reserved        the deposit hold: the time reserved for staff;
 *   booked          written once, with the deposit as `deposit` says:
 *                   none, the website chat's link, the front desk (the chat
 *                   says so), or a call's spoken deposit line (never a link);
 *   meta_request    Instagram, Messenger and WhatsApp take a request, and
 *                   staff confirm it; `deposit` is what that confirmation
 *                   then does (the fixed payment-link line, or the front desk).
 */
export type BookingExpectation =
  | { kind: "request"; why: "tools_off" | "manual" | "deposit_required"; deposit: DepositOutcome }
  | { kind: "reserved"; deposit: DepositOutcome }
  | { kind: "booked"; deposit: DepositOutcome; collect: "none" | "link" | "front_desk" | "spoken" }
  | { kind: "meta_request"; deposit: DepositOutcome; onConfirm: "none" | "link" | "front_desk" };

export function bookingExpectation(
  facts: PracticeBookingFacts,
  channel: Channel,
  service: string | null,
): BookingExpectation {
  if (channel === "meta") {
    const deposit = bookedDepositOutcome(practiceDeposit(facts, "meta", service));
    return {
      kind: "meta_request",
      deposit,
      onConfirm: !deposit.isRequired ? "none" : deposit.action === "collect" ? "link" : "front_desk",
    };
  }
  const deposit = practiceDeposit(facts, channel === "voice" ? "voice" : "web", service);
  if (!practiceToolsLive(facts)) return { kind: "request", why: "tools_off", deposit };
  const branch = depositBranch(deposit.action);
  if (branch === "decline") return { kind: "request", why: "deposit_required", deposit };
  if (modeOfReasons(facts.modeReasons).mode !== "live") return { kind: "request", why: "manual", deposit };
  if (branch === "reserve") return { kind: "reserved", deposit };
  const collect = !deposit.isRequired
    ? "none"
    : channel === "voice"
      ? "spoken"
      : deposit.action === "collect"
        ? "link"
        : "front_desk";
  return { kind: "booked", deposit, collect };
}

// -----------------------------------------------------------------------------
// The practice engine
// -----------------------------------------------------------------------------

/** The synthetic Checkout link a practice deposit is said with: never a real session. */
export const PRACTICE_CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_practice_questions";

export type PracticeBooking = {
  bookingKey: string;
  startsAt: string;
  appointmentId: string;
  service: string | null;
  deposit: DepositOutcome;
};

/** Every call the tool layer made of the engine, in order, and what it came to. */
export type PracticeLedger = {
  offered: string[];
  calls: { op: "offerTimes" | "placeHold" | "bookConversation" | "chatDepositFor" | "logRequest"; turn: number; result: string }[];
  holds: { startsAt: string; placedAt: string; expiresAt: string; turn: number }[];
  /** The bookings written, by booking key: one per conversation, whatever was retried. */
  bookings: Map<string, PracticeBooking>;
  bookingKeys: string[];
  requests: { reason: string; turn: number }[];
  /** What each deposit link would carry: its amount, for the checks; the session's strings are previewed there. */
  links: { appointmentId: string; amountCents: number; turn: number }[];
  /** The turn the conversation is on; the runner moves it. */
  turn: number;
};

export function emptyLedger(): PracticeLedger {
  return { offered: [], calls: [], holds: [], bookings: new Map(), bookingKeys: [], requests: [], links: [], turn: 0 };
}

/** `day` (a zoned day start) or the next day after `now`, at these local hours, as instants; never before `now`. */
function practiceSlots(day: Date | null, now: Date): Date[] {
  const start = day && day.getTime() > now.getTime() - 24 * 3_600_000 ? day : new Date(now.getTime() + 24 * 3_600_000);
  // An hour apart from early afternoon, offset from the day's start: the
  // runner's clock is fixed, so the same profile is offered the same times.
  return [13, 14, 15]
    .map((h) => new Date(start.getTime() + h * 3_600_000))
    .filter((at) => at.getTime() > now.getTime());
}

/**
 * The engine the tool layer calls in a practice run: the real deciders over
 * the clinic's settings, nothing written anywhere. Every answer is the one
 * the real engine gives for the same mode and deposit (engine.ts, book.ts).
 */
export function practiceEngine(facts: PracticeBookingFacts, ledger: PracticeLedger): BookingEngine {
  const mode = modeOfReasons(facts.modeReasons);
  const channelOf = (c: "voice" | "web_chat") => (c === "web_chat" ? "web" : "voice") as "voice" | "web";
  const gateFor = (c: "voice" | "web_chat", service: string | null) => {
    const outcome = practiceDeposit(facts, channelOf(c), service);
    return { outcome, branch: depositBranch(outcome.action) };
  };
  const canonical = (service: string | null) =>
    findService(facts.deposits.services as AgentService[], service)?.name ?? null;
  const record = (op: PracticeLedger["calls"][number]["op"], result: string) =>
    ledger.calls.push({ op, turn: ledger.turn, result });
  const lineFacts = (outcome: DepositOutcome) =>
    outcome.isRequired ? { action: outcome.action, amountUsd: outcome.amountUsd } : null;

  const engine: BookingEngine = {
    async offerTimes(_clinicId, input) {
      const now = input.now ?? new Date();
      if (!mode.canOfferTimes) {
        record("offerTimes", "request_only");
        return { status: "request_only", reasons: [...facts.modeReasons] };
      }
      if (gateFor(input.channel === "web_chat" ? "web_chat" : "voice", input.service ?? null).branch === "decline") {
        record("offerTimes", "request_only");
        return { status: "request_only", reasons: ["deposit_required"] };
      }
      const slots = practiceSlots(input.day ?? null, now);
      for (const at of slots) if (!ledger.offered.includes(at.toISOString())) ledger.offered.push(at.toISOString());
      record("offerTimes", "ok");
      return {
        status: "ok",
        timeZone: "UTC",
        serviceMinutes: 60,
        canonicalService: canonical(input.service ?? null),
        slots: slots.map((at) => ({ at, providerId: null })),
      };
    },

    async placeHold(_clinicId, input) {
      const now = input.now ?? new Date();
      if (mode.mode !== "live") {
        record("placeHold", "request_only");
        return { kind: "request_only", reasons: [...facts.modeReasons] };
      }
      if (gateFor(input.channel === "web_chat" ? "web_chat" : "voice", input.service).branch === "decline") {
        record("placeHold", "request_only");
        return { kind: "request_only", reasons: ["deposit_required"] };
      }
      if (input.channel === "web_chat" && !input.contactId) {
        record("placeHold", "request_only");
        return { kind: "request_only", reasons: ["contact_required"] };
      }
      const startsAt = input.startsAt.toISOString();
      const expiresAt = new Date(now.getTime() + HOLD_SECONDS * 1000);
      ledger.holds.push({ startsAt, placedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), turn: ledger.turn });
      record("placeHold", "held");
      return { kind: "held", holdId: `practice-hold-${ledger.holds.length}`, expiresAt, startsAt: input.startsAt, minutes: 60, providerId: null };
    },

    async bookConversation(_clinicId, input) {
      const now = input.now ?? new Date();
      ledger.bookingKeys.push(input.bookingKey);
      const startsAt = input.startsAt.toISOString();
      const prior = ledger.bookings.get(input.bookingKey);
      if (prior) {
        // The key's first answer, as book.ts replays it.
        record("bookConversation", prior.startsAt === startsAt ? "replayed" : "key_reused");
        if (prior.startsAt !== startsAt) return { kind: "key_reused", first: "booked", firstStartsAt: new Date(prior.startsAt) };
        return {
          kind: "booked",
          startsAt: input.startsAt,
          minutes: 60,
          canonicalService: prior.service,
          providerId: null,
          replayed: true,
          appointmentId: prior.appointmentId,
          requestId: null,
          deposit: input.channel === "voice" ? lineFacts(bookedDepositOutcome(prior.deposit)) : null,
        };
      }
      const priorRequest = ledger.requests.length > 0;
      if (priorRequest) {
        record("bookConversation", "key_reused");
        return { kind: "key_reused", first: "request_logged" };
      }
      if (!ledger.offered.includes(startsAt)) {
        record("bookConversation", "invalid");
        return { kind: "invalid", field: "at" };
      }
      const gate = gateFor(input.channel, input.service);
      if (mode.mode !== "live") {
        ledger.requests.push({ reason: "manual", turn: ledger.turn });
        record("bookConversation", "request_logged");
        return { kind: "request_logged", reason: "manual", modeReasons: [...facts.modeReasons], replayed: false, deposit: null, requestId: null };
      }
      if (gate.branch === "decline") {
        ledger.requests.push({ reason: "deposit_required", turn: ledger.turn });
        record("bookConversation", "request_logged");
        return { kind: "request_logged", reason: "deposit_required", replayed: false, deposit: lineFacts(gate.outcome), requestId: null };
      }
      // The chat's hold is the claim itself (book.ts, step 6): held, then written.
      if (input.channel === "web_chat") {
        const expiresAt = new Date(now.getTime() + HOLD_SECONDS * 1000);
        ledger.holds.push({ startsAt, placedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), turn: ledger.turn });
      }
      if (gate.branch === "reserve") {
        ledger.requests.push({ reason: "deposit_hold", turn: ledger.turn });
        record("bookConversation", "request_logged");
        return { kind: "request_logged", reason: "deposit_hold", replayed: false, deposit: lineFacts(gate.outcome), requestId: null };
      }
      const booking: PracticeBooking = {
        bookingKey: input.bookingKey,
        startsAt,
        appointmentId: `practice-appointment-${ledger.bookings.size + 1}`,
        service: canonical(input.service),
        deposit: gate.outcome,
      };
      ledger.bookings.set(input.bookingKey, booking);
      record("bookConversation", "booked");
      return {
        kind: "booked",
        startsAt: input.startsAt,
        minutes: 60,
        canonicalService: booking.service,
        providerId: null,
        replayed: false,
        appointmentId: booking.appointmentId,
        requestId: null,
        deposit: input.channel === "voice" ? lineFacts(bookedDepositOutcome(gate.outcome)) : null,
      };
    },

    async chatDepositFor(_clinicId, appointmentId) {
      const booking = [...ledger.bookings.values()].find((b) => b.appointmentId === appointmentId);
      const outcome = booking ? bookedDepositOutcome(booking.deposit) : null;
      if (!booking || !outcome?.isRequired) {
        record("chatDepositFor", "none");
        return { kind: "none" };
      }
      if (outcome.action === "collect") {
        const amountCents = Math.round((outcome.amountUsd ?? 0) * 100);
        ledger.links.push({ appointmentId, amountCents, turn: ledger.turn });
        record("chatDepositFor", "link");
        return { kind: "link", text: depositLinkText(PRACTICE_CHECKOUT_URL), reused: false, url: PRACTICE_CHECKOUT_URL, depositId: `practice-deposit-${ledger.links.length}` };
      }
      record("chatDepositFor", "flagged");
      return { kind: "flagged", amountUsd: outcome.amountUsd };
    },

    async logRequest(_clinicId, input) {
      if (ledger.bookings.has(input.bookingKey)) {
        record("logRequest", "key_reused");
        return { kind: "key_reused", first: "booked" };
      }
      ledger.requests.push({ reason: "logged", turn: ledger.turn });
      record("logRequest", "request_logged");
      return { kind: "request_logged", replayed: false, requestId: null };
    },
  };
  return engine;
}
