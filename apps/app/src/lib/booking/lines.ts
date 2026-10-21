import type { DepositAction } from "@/lib/billing/deposits";

/**
 * The fixed lines the assistant says about a booking (plan §7.13), in one
 * place, so a tool's answer and the assistant's words cannot drift apart.
 * They are said as written: the model never rewords a line about whether
 * someone is booked, held or passed to the clinic, and a tool that fails
 * says TOOL_FAILURE_LINE rather than an explanation of its own (the spec's
 * failure table).
 *
 * `{when}` is a time as the caller hears it, in the clinic's own zone, and
 * `{ for service}` names the clinic's own service only, never the caller's
 * words for it. A call never takes a deposit and is never sent a link: a
 * deposit is said with depositLine below.
 */

/** The assistant may not book this call itself: it takes the time as a request. */
export const MANUAL_BOOKING_LINE =
  "I can't book that directly right now, so I'll take the time you'd like and the clinic will confirm it with you.";

/** A time held for 60 seconds, before anything confirming is said (spec, "How a call runs" step 5). */
export const HOLD_LINE = "I've got that time held for a minute while I take your details.";

/** The time asked for was taken; the nearest free times follow it, spoken. */
export const SLOT_GONE_LINE = "That time has just gone.";

/** Nothing free on the day or after the time the caller named: ask for another, never guess one. */
export const NO_FREE_TIME_LINE =
  "I don't have a free time then. Which other day or time would suit you?";

/** Owner Q5 (5 October 2026): spec step 8, as re-exported in 082cf9d. */
export const BOOKED_LINE = "You're booked for {when}{ for service}. It's in the clinic's calendar.";

/** A request the clinic will confirm: every way the assistant takes the time without booking it. */
export const REQUEST_TAKEN_LINE =
  "I've passed your request to the clinic, and they'll confirm your time with you.";

/** The clinic's "hold the time and alert staff" deposit setting: reserved, not booked. */
export const DEPOSIT_HOLD_LINE =
  "I've reserved that time for you while the clinic arranges the deposit. They'll call you to take it and confirm your booking.";

/** A deposit this call cannot take, said before a time is chosen (the amount is said at booking). */
export const DEPOSIT_REQUEST_LINE =
  "That appointment needs a deposit, so I'll pass your request to the clinic and they'll call you to arrange it.";

/** A second booking asked for on a call that has booked one. */
export const ONE_BOOKING_PER_CALL_LINE =
  "I can only book one appointment per call, and yours is already booked for {when}. For another appointment, please call back or ask the clinic.";

/** A second request asked for on a call that has passed one to the clinic. */
export const ONE_REQUEST_PER_CALL_LINE =
  "I've already passed one request to the clinic on this call. When they call you, they can arrange the other appointment too.";

/** This caller's last booking is still on its way to the calendar: nothing else until it settles. */
export const IN_PROGRESS_LINE =
  "I can't take another booking on this call while your first one is still being confirmed. The clinic can arrange anything else with you.";

/** Google, or the tool itself, did not answer: the fixed line and the offer of a person. */
export const TOOL_FAILURE_LINE =
  "I'm sorry, I couldn't complete that just now. I can put you through to the clinic, or take your details so they can confirm with you.";

/** A detail the assistant must ask for again, by the field the engine refused. */
export const MISSING_DETAIL_LINES = {
  first_name: "I didn't catch your first name. Could you tell me again?",
  at: "I didn't get a time I can book. Which day and time would suit you?",
  phone: "I didn't catch a number the clinic can reach you on. Could you tell me again?",
  preferred_window: "Which day or time would suit you best?",
} as const;

/** BOOKED_LINE for one booking: `when` already spoken, `service` the clinic's own name or null. */
export function bookedLine(when: string, service: string | null): string {
  // Replacer functions, so a "$" in a clinic's service name is never a pattern.
  return BOOKED_LINE.replace("{when}", () => when).replace("{ for service}", () =>
    service ? ` for ${service}` : "",
  );
}

/** ONE_BOOKING_PER_CALL_LINE, with the first booking's time when it is known. */
export function oneBookingPerCallLine(when: string | null): string {
  return when
    ? ONE_BOOKING_PER_CALL_LINE.replace("{when}", () => when)
    : ONE_BOOKING_PER_CALL_LINE.replace(" for {when}", "");
}

/** SLOT_GONE_LINE and the nearest times, already spoken; with none, a question instead. */
export function slotGoneLine(alternatives: readonly string[]): string {
  if (alternatives.length === 0) return `${SLOT_GONE_LINE} Which other day or time would suit you?`;
  return `${SLOT_GONE_LINE} The nearest times I have are ${joinOr(alternatives)}.`;
}

/** Free times on offer, already written for the channel; the person picks one. */
export function offerLine(times: readonly string[]): string {
  if (times.length === 0) return NO_FREE_TIME_LINE;
  return `I have ${joinOr(times)}. Which would suit you?`;
}

/**
 * The website chat holds nothing for a visitor it cannot name (spec, "How a
 * session runs" step 3: name and phone before any slot is held), so a time
 * chosen before the details waits for them.
 */
export function detailsBeforeHoldLine(when: string): string {
  return `Before I hold ${when} for you, could I take your first name and a mobile number the clinic can reach you on?`;
}

/** The voice HOLD_LINE, and the one detail still to take. */
export function heldAskLine(missing: "first_name" | "phone"): string {
  return `${HOLD_LINE} ${missing === "first_name" ? "Could I take your first name?" : "What's the best number for the clinic to reach you on?"}`;
}

/**
 * A line written for a call, as the website chat says it: the chat is not a
 * call, and cannot be called back.
 */
export function forChat(line: string): string {
  return line
    .replace(/please call back or ask the clinic/g, "please ask the clinic")
    .replace(/\bon this call\b/g, "in this chat")
    .replace(/\bper call\b/g, "per chat")
    .replace(/\bthis call\b/g, "this chat");
}

function joinOr(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * The deposit rule as the agent states it (BD27): what the deposit decision
 * means for this caller, and who collects, never a payment link (voice never
 * collects, §E.7). `book_and_flag` books and leaves the deposit to the front
 * desk; `decline_and_alert` books nothing, so the line never promises a
 * booking, and says the team will call to take the deposit and confirm a
 * time. `booking` is one appointment's line; `clinic` is the line for the
 * clinic's default deposit, said before anything is chosen; `some_services`
 * is the line when there is no default but some services ask for one, and
 * the agent learns which at booking.
 */
export function depositLine(input: { action: DepositAction; amountUsd: number | null; scope?: "booking" | "clinic" | "some_services" } | null): string {
  if (!input) return "";
  const amount = input.amountUsd !== null && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null;
  if (input.action === "book_and_flag") {
    if (input.scope === "some_services") return "Some appointments need a deposit to hold them. If yours does, the front desk will call you to take it; nothing is charged on this call.";
    return `${amount !== null ? `A deposit of ${amount} dollars` : "A deposit"} is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call.`;
  }
  if (input.action === "decline_and_alert") {
    if (input.scope === "some_services") return "Some appointments need a deposit and can't be booked on this call. For those, I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.";
    if (input.scope === "clinic") return `Appointments need a deposit${amount !== null ? ` of ${amount} dollars` : ""}, so they can't be booked on this call. I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.`;
    return `This appointment needs a deposit${amount !== null ? ` of ${amount} dollars` : ""}, so it can't be booked on this call. I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.`;
  }
  return "";
}
