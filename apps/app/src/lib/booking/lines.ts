/**
 * The fixed lines the assistant says about a booking (plan §7.13), in one
 * place, so a tool's answer and the assistant's words cannot drift apart.
 * They are said as written: the model never rewords a line about whether
 * someone is booked, held or passed to the clinic, and a tool that fails
 * says TOOL_FAILURE_LINE rather than an explanation of its own (the spec's
 * failure table).
 *
 * `{when}` is a spoken time in the clinic's own zone (lib/voice/spoken.ts
 * spokenSlot), and `{ for service}` names the clinic's own service only,
 * never the caller's words for it. A call never takes a deposit and is
 * never sent a link: a deposit is said with depositLine (lib/voice/tools.ts).
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

function joinOr(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
