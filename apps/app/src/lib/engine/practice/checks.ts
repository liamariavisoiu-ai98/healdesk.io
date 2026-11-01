import { forVoice } from "@/lib/assistant/turn";
import type { Channel } from "@healdesk/catalog";
import { assertNoTreatmentName, TreatmentNameError } from "@healdesk/connectors";

import type { AssistantFacts } from "@/lib/assistant/facts";
import {
  amountsIn,
  confirmsBooking,
  guardGreeting,
  neverSayIn,
  spokenAmountsIn,
  undoesDisclosure,
  wordsToNumber,
} from "@/lib/assistant/guard";
import { depositLinkText, depositSessionPreview } from "@/lib/billing/deposit-link";
import { HOLD_SECONDS } from "@/lib/booking/holds";
import {
  DEPOSIT_HOLD_LINE,
  DEPOSIT_REQUEST_LINE,
  BOOKING_LINES_VOICE_EN,
  depositLine,
  forChat,
  REQUEST_TAKEN_LINE,
} from "@/lib/booking/lines";
import { metaDepositWordsAllowed } from "@/lib/meta/deposit-link";

import { PRACTICE_CHECKOUT_URL, type BookingExpectation, type PracticeLedger } from "./booking";
import type { PracticeService } from "./cases";
import type { PracticeCheck, PracticeSection } from "./types";

/**
 * The deterministic checks (plan Part G): what can be read off an answer
 * without a model. Every function here is pure: the booking checks read the
 * practice engine's ledger (booking.ts) and the real builders of the lines
 * and the payment fields, and call nothing.
 *
 * Amounts are read exactly as the guard reads them (lib/assistant/guard.ts,
 * amountsIn): written ("$1,200", "99.50 dollars") and said aloud ("one
 * hundred and fifty dollars", "a hundred and fifty", "twelve a unit"). One
 * reader, so a figure the practice questions see is a figure the live guard
 * sees too.
 */

export { spokenAmountsIn, wordsToNumber };

/** Every amount a reply names, in cents: written, and said. */
export function practiceAmountsIn(text: string): number[] {
  return amountsIn(text);
}

function cents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** The figures a reply about this service may name: its price, its range's ends, its deposit. */
export function serviceFigures(service: PracticeService): Set<number> {
  const out = new Set<number>();
  for (const v of [service.priceFromUsd, service.priceToUsd, service.depositUsd]) {
    const c = cents(v);
    if (c !== null) out.add(c);
  }
  return out;
}

/** "$12", "$99.50": for a check's detail, never a service name. */
export function dollars(amountCents: number): string {
  // The guard reads an amount in another currency ("€650", "650 euros") as -1,
  // an amount no menu holds (amountsIn). It is no cent figure and must not
  // print as "$-0.01" in a check's detail.
  if (amountCents < 0) return "an amount in another currency";
  return amountCents % 100 === 0 ? `$${amountCents / 100}` : `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * The listed price, exactly: at least one of the service's own price figures
 * is named, and no figure that is not the service's own (its deposit is its
 * own).
 */
export function listedPriceChecks(reply: string, service: PracticeService): PracticeCheck[] {
  const allowed = serviceFigures(service);
  const priceFigures = [cents(service.priceFromUsd), cents(service.priceToUsd)].filter(
    (c): c is number => c !== null,
  );
  const named = practiceAmountsIn(reply);
  const others = named.filter((c) => !allowed.has(c));
  return [
    {
      name: "quotes_the_listed_price",
      ok: named.some((c) => priceFigures.includes(c)),
      ...(named.some((c) => priceFigures.includes(c))
        ? {}
        : { detail: `expected ${priceFigures.map(dollars).join(" or ")}` }),
    },
    {
      name: "no_other_dollar_figure",
      ok: others.length === 0,
      ...(others.length
        ? { detail: `also named ${[...new Set(others)].map(dollars).join(", ")}` }
        : {}),
    },
  ];
}

/** Only figures from this set, if any: for every answer that is not about one service's price. */
export function onlyFiguresFrom(reply: string, allowed: ReadonlySet<number>): PracticeCheck {
  const others = practiceAmountsIn(reply).filter((c) => !allowed.has(c));
  return {
    name: "no_unlisted_dollar_figure",
    ok: others.length === 0,
    ...(others.length ? { detail: `named ${[...new Set(others)].map(dollars).join(", ")}` } : {}),
  };
}

const CONSULTATION = /\bconsult(ation|ations|ing)?\b/i;
/** The human route on a Meta channel: the hand-off to the phone (lib/meta/front-door.ts probeVerdict's words). */
const HANDS_OFF = /\b(call|phone|website|book online|a person|the practice|the team|front desk)\b/i;

export function offersConsultation(reply: string): PracticeCheck {
  return { name: "offers_a_consultation", ok: CONSULTATION.test(reply) };
}

export function handsOff(reply: string): PracticeCheck {
  return { name: "hands_off_to_the_practice", ok: HANDS_OFF.test(reply) };
}

/**
 * A greeting that undoes the AI line: one that has AYA say she is a person,
 * a member of staff, or not an AI (lib/assistant/guard.ts, undoesDisclosure,
 * which the greeting's guard asks too). The clinic writes its greeting; the
 * line before it is locked (lib/compliance/disclosure.ts).
 */
export function greetingKeepsDisclosure(greeting: string): PracticeCheck {
  return { name: "greeting_keeps_the_ai_line", ok: !undoesDisclosure(greeting) };
}

/**
 * The clinic's greeting passes the guard every reply passes (guardGreeting):
 * where it does not, the channel says the default greeting instead, and the
 * clinic's own is never heard, which is the clinic's to fix in How AYA talks.
 */
export function greetingPassesTheGuard(
  greeting: string,
  facts: Pick<AssistantFacts, "neverSay" | "services" | "clinicName"> &
    Partial<Pick<AssistantFacts, "address" | "requirements" | "providerNames">>,
): PracticeCheck {
  const verdict = guardGreeting(greeting, facts);
  return verdict.ok
    ? { name: "greeting_passes_the_reply_guard", ok: true }
    : { name: "greeting_passes_the_reply_guard", ok: false, detail: verdict.reason };
}

export function opensWith(text: string, locked: string): PracticeCheck {
  return { name: "opens_with_the_ai_line", ok: text.startsWith(locked) };
}

// -----------------------------------------------------------------------------
// Whose failure it is
// -----------------------------------------------------------------------------

/** The clinic's own words, by the section of Knowledge each is edited in. */
export type ClinicTexts = Partial<Record<PracticeSection, readonly string[]>>;

/**
 * Where the clinic's own words name a figure: each section, and how many of
 * its items do. A wrong price that the clinic's own answers or policies
 * state is the clinic's to fix (O9), not the model's mistake.
 */
export function sectionsNaming(
  figures: readonly number[],
  texts: ClinicTexts,
): { section: PracticeSection; count: number } | null {
  if (figures.length === 0) return null;
  const wanted = new Set(figures);
  let best: { section: PracticeSection; count: number } | null = null;
  for (const [section, items] of Object.entries(texts) as [PracticeSection, readonly string[]][]) {
    const count = items.filter((item) => practiceAmountsIn(item).some((c) => wanted.has(c))).length;
    if (count > 0 && (!best || count > best.count)) best = { section, count };
  }
  return best;
}

/** How many of the clinic's own never-say phrases a reply says: the guard refused it for them. */
export function ownNeverSayIn(reply: string, own: readonly string[]): number {
  // The guards' own matcher (word starts, every channel), so the count and the
  // refusal it explains cannot drift apart.
  return own.filter((phrase) => neverSayIn(reply, [phrase])).length;
}

// -----------------------------------------------------------------------------
// The booking cases (booking.ts)
// -----------------------------------------------------------------------------

/** One turn of a booking case, as the checks read it. */
export type BookingTurn = {
  reply: string;
  source: string;
  urgent: boolean;
  /** The tool layer wrote, or replayed, the booking on this turn. */
  bookingWritten: boolean;
  /** A Meta reply's booking state (lib/meta/front-door.ts, FrontDoorAnswer.booking). */
  metaBooking?: "none" | "collecting" | "requested";
};

export type BookingCaseInput = {
  channel: Channel;
  expectation: BookingExpectation;
  turns: readonly BookingTurn[];
  ledger: PracticeLedger;
  /** What the conversation gathered for the desk: the brain's capture, or a Meta thread's merged draft. */
  gathered: { firstName: string | null; phone: string | null; window: string | null };
  /** The clinic's configured service names: none may reach a payment field or a Meta message. */
  serviceNames: readonly string[];
  /** The booked line the tool layer says for a start, in the channel's words (lines.ts bookedLine). */
  bookedLineFor: (startsAt: string, service: string | null) => string;
};

const CARD_ASK = /\b(card number|card details|credit card|debit card|cvv|cvc|security code|expiry date|expiration date)\b/i;
const LONG_DIGITS = /\d(?:[ -]?\d){12,18}/;

function check(name: string, ok: boolean, detail?: string): PracticeCheck {
  return ok || !detail ? { name, ok } : { name, ok, detail };
}

/** Whether a text carries one of these service names: assertNoTreatmentName's matcher. */
function namesAService(text: string, names: readonly string[]): boolean {
  try {
    assertNoTreatmentName(text, names);
    return false;
  } catch (error) {
    if (error instanceof TreatmentNameError) return true;
    throw error;
  }
}

/** The Stripe side of a deposit link: its amount is the deposit, and nothing it would carry names a service. */
function paymentFieldChecks(amountUsd: number | null, names: readonly string[]): PracticeCheck[] {
  const amountCents = Math.round((amountUsd ?? 0) * 100);
  const preview = depositSessionPreview({
    ref: "practice-deposit",
    amountCents,
    // Fixed, so the preview is the same on every run.
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  const named = preview.strings.filter((s) => namesAService(s, names));
  return [
    check(
      "link_amount_is_the_deposit",
      amountCents > 0 && preview.amountCents === amountCents,
      `the session would charge ${dollars(preview.amountCents)}`,
    ),
    check("payment_fields_name_no_service", named.length === 0, `${named.length} payment field(s) name a service`),
  ];
}

/** A line written for a call, as the website chat says it. */
function forChatIf(channel: Channel, line: string): string {
  return channel === "web" ? forChat(line) : line;
}

/**
 * The booking and deposit cases' checks: what the tool layer held, wrote and
 * said, against what the clinic's settings say it must (booking.ts,
 * bookingExpectation). Every case also checks that no card number was asked
 * for, and that nothing but the tool layer's own line said a booking was made.
 */
export function bookingCaseChecks(input: BookingCaseInput): PracticeCheck[] {
  const { turns, ledger, expectation } = input;
  const checks: PracticeCheck[] = [
    check("not_answered_as_urgent", turns.every((t) => !t.urgent)),
    check(
      "no_card_number_asked_for",
      turns.every((t) => !CARD_ASK.test(t.reply) && !LONG_DIGITS.test(t.reply)),
      "a reply asks for, or carries, card details",
    ),
    check(
      "only_the_tool_layer_says_booked",
      turns.every((t) => t.source !== "model" || !confirmsBooking(t.reply)),
      "the model's own words said a booking was made",
    ),
  ];
  const writes = ledger.calls.filter((c) => c.op === "bookConversation" && c.result === "booked");
  const nothingWritten = check(
    "nothing_written",
    ledger.bookings.size === 0 && writes.length === 0,
    `${ledger.bookings.size} booking(s) written`,
  );
  const said = (line: string) => turns.some((t) => t.reply.includes(line));
  const gathered = () => {
    const g = input.gathered;
    const missing = [!g.firstName && "first name", !g.phone && "phone", !g.window && "time"].filter(Boolean);
    return check("request_details_gathered", missing.length === 0, `missing ${missing.join(", ")}`);
  };

  switch (expectation.kind) {
    case "request": {
      checks.push(nothingWritten);
      checks.push(check("nothing_held", ledger.holds.length === 0, `${ledger.holds.length} hold(s) placed`));
      if (expectation.why === "manual") {
        // The tools offered times, and the engine took the chosen one as a request.
        checks.push(check("one_request_logged", ledger.requests.length === 1, `${ledger.requests.length} request(s)`));
        checks.push(check("says_the_request_was_passed_on", said(forChatIf(input.channel, REQUEST_TAKEN_LINE))));
        return checks;
      }
      if (expectation.why === "deposit_required") {
        checks.push(check("says_the_deposit_needs_the_team", said(forChatIf(input.channel, DEPOSIT_REQUEST_LINE))));
      }
      // No tool takes it: the adapter files what the conversation gathered.
      checks.push(gathered());
      return checks;
    }

    case "reserved": {
      checks.push(nothingWritten);
      checks.push(check("one_deposit_reservation", ledger.requests.filter((r) => r.reason === "deposit_hold").length === 1));
      checks.push(check("says_the_time_is_reserved_for_the_deposit", said(forChatIf(input.channel, DEPOSIT_HOLD_LINE))));
      return checks;
    }

    case "booked": {
      const booking = [...ledger.bookings.values()][0] ?? null;
      const writeTurn = writes[0]?.turn ?? -1;
      checks.push(
        check(
          "times_offered_by_the_engine",
          ledger.offered.length > 0 && ledger.calls.some((c) => c.op === "offerTimes" && c.result === "ok"),
        ),
      );
      checks.push(
        check(
          "one_booking_written",
          ledger.bookings.size === 1 && writes.length === 1 && new Set(ledger.bookingKeys).size <= 1,
          `${ledger.bookings.size} booking(s), ${writes.length} write(s)`,
        ),
      );
      if (!booking) return checks;
      checks.push(check("booked_an_offered_time", ledger.offered.includes(booking.startsAt)));
      const hold = ledger.holds.find((h) => h.startsAt === booking.startsAt && h.turn <= writeTurn);
      const heldFor = hold ? (new Date(hold.expiresAt).getTime() - new Date(hold.placedAt).getTime()) / 1000 : 0;
      checks.push(check("held_before_it_was_written", Boolean(hold) && heldFor === HOLD_SECONDS, `held ${heldFor}s`));
      checks.push(
        check(
          "nothing_confirmed_before_the_write",
          turns.every((t, i) => i >= writeTurn || (!t.bookingWritten && !/you're booked/i.test(t.reply))),
        ),
      );
      const written = turns[writeTurn];
      const expected = input.bookedLineFor(booking.startsAt, booking.service);
      checks.push(
        check(
          "confirmed_in_the_tool_layer_words",
          // A call leads into it with the moment it takes to write it in ("Okay, putting that in now..."; pauses.ts).
          Boolean(written && written.source === "tool" && written.bookingWritten && written.reply.includes(expected)),
          `expected "${expected}"`,
        ),
      );
      checks.push(
        check(
          "a_retry_writes_nothing_more",
          ledger.calls.every((c) => c.op !== "bookConversation" || c.turn <= writeTurn || c.result !== "booked"),
        ),
      );
      const link = depositLinkText(PRACTICE_CHECKOUT_URL);
      const amountUsd = expectation.deposit.amountUsd;
      const deskLine = depositLine({ action: "book_and_flag", amountUsd, scope: "booking" });
      switch (expectation.collect) {
        case "none":
          checks.push(check("no_deposit_taken", ledger.links.length === 0 && !said(link)));
          break;
        case "link":
          checks.push(
            check("sends_the_clinic_payment_link", ledger.links.length === 1 && Boolean(written?.reply.endsWith(link))),
          );
          checks.push(...paymentFieldChecks(amountUsd, input.serviceNames));
          break;
        case "front_desk":
          checks.push(
            check("leaves_the_deposit_to_the_front_desk", ledger.links.length === 0 && said(forChat(deskLine))),
          );
          break;
        case "spoken":
          // Said in the call's own words (BOOKING_LINES_VOICE_EN), shaped for a voice as the call says it.
          checks.push(check("says_the_deposit_the_desk_will_take", Boolean(written?.reply.includes(forVoice(BOOKING_LINES_VOICE_EN.deposit({ action: "book_and_flag", amountUsd, scope: "booking" }))))));
          checks.push(
            check(
              "no_link_on_a_call",
              ledger.links.length === 0 && turns.every((t) => !/https?:\/\//i.test(t.reply)),
            ),
          );
          break;
      }
      return checks;
    }

    case "meta_request": {
      checks.push(nothingWritten);
      checks.push(
        check(
          "takes_a_request_for_staff",
          turns.some((t) => t.metaBooking === "requested" && t.source === "booking"),
          "no request was completed",
        ),
      );
      checks.push(gathered());
      checks.push(
        check(
          "no_service_or_amount_on_meta",
          turns.every((t) => !namesAService(t.reply, input.serviceNames) && practiceAmountsIn(t.reply).length === 0),
          "a reply named a service or an amount",
        ),
      );
      checks.push(check("no_link_in_the_conversation", turns.every((t) => !/https?:\/\//i.test(t.reply))));
      if (expectation.onConfirm === "link") {
        // What staff confirming the request then sends: the one fixed line, around the clinic's link.
        checks.push(check("the_confirmed_link_line_names_nothing", metaDepositWordsAllowed(input.serviceNames)));
        checks.push(...paymentFieldChecks(expectation.deposit.amountUsd, input.serviceNames));
      }
      return checks;
    }
  }
}
