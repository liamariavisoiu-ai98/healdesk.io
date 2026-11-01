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

/**
 * The answer gate refused the booking (paused, stopped at the allowance,
 * suspended, ended): nothing is written, and the person is sent to the clinic.
 */
export const BOOKING_REFUSED_LINE =
  "I'm not able to book appointments right now. Please contact the clinic directly, and their team will arrange a time with you.";

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

const ASK_DETAIL = {
  first_name: "Could I take your first name?",
  phone: "What's the best number for the clinic to reach you on?",
} as const;

/** The one detail still to take, asked on its own. */
export function askLine(missing: "first_name" | "phone"): string {
  return ASK_DETAIL[missing];
}

/** The voice HOLD_LINE, and the one detail still to take. */
export function heldAskLine(missing: "first_name" | "phone"): string {
  return `${HOLD_LINE} ${ASK_DETAIL[missing]}`;
}

/**
 * A time chosen on a call that the engine would not hold (Auto-confirm off, a
 * deposit the call cannot take, a calendar that stopped allowing the write):
 * nothing is held, so it is worded as the request it will become, and the
 * one detail still to take.
 */
export function requestAskLine(missing: "first_name" | "phone", deposit: boolean): string {
  return `${deposit ? DEPOSIT_REQUEST_LINE : MANUAL_BOOKING_LINE} ${ASK_DETAIL[missing]}`;
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

// -----------------------------------------------------------------------------
// Spanish, for a call the caller has taken into Spanish
// -----------------------------------------------------------------------------

/**
 * Every fixed line above, for one language. The English set is the lines
 * above themselves, byte for byte; the Spanish set is said only on a call
 * whose caller is speaking Spanish (lib/voice/call-language.ts), and only on
 * a call: the website chat stays English (forChat rewrites English only).
 * Same meaning, same promises, nothing added: each Spanish line says what
 * its English line says, and no more. Awaiting a native speaker's review.
 */
export type BookingLines = {
  manual: string;
  hold: string;
  noFreeTime: string;
  requestTaken: string;
  depositHold: string;
  depositRequest: string;
  oneRequestPerCall: string;
  inProgress: string;
  toolFailure: string;
  refused: string;
  missing: Readonly<Record<keyof typeof MISSING_DETAIL_LINES, string>>;
  booked: (when: string, service: string | null, firstName?: string | null) => string;
  oneBookingPerCall: (when: string | null) => string;
  /** `gone`: the time that went, spoken, when known (the call says it: "Ah, 2 just went"). */
  slotGone: (alternatives: readonly string[], gone?: string | null) => string;
  offer: (times: readonly string[]) => string;
  detailsBeforeHold: (when: string) => string;
  ask: (missing: "first_name" | "phone") => string;
  /** `when`: the time held, spoken, when known. */
  heldAsk: (missing: "first_name" | "phone", when?: string | null) => string;
  requestAsk: (missing: "first_name" | "phone", deposit: boolean) => string;
  deposit: typeof depositLine;
};

export const BOOKING_LINES_EN: BookingLines = {
  manual: MANUAL_BOOKING_LINE,
  hold: HOLD_LINE,
  noFreeTime: NO_FREE_TIME_LINE,
  requestTaken: REQUEST_TAKEN_LINE,
  depositHold: DEPOSIT_HOLD_LINE,
  depositRequest: DEPOSIT_REQUEST_LINE,
  oneRequestPerCall: ONE_REQUEST_PER_CALL_LINE,
  inProgress: IN_PROGRESS_LINE,
  toolFailure: TOOL_FAILURE_LINE,
  refused: BOOKING_REFUSED_LINE,
  missing: MISSING_DETAIL_LINES,
  booked: bookedLine,
  oneBookingPerCall: oneBookingPerCallLine,
  slotGone: slotGoneLine,
  offer: offerLine,
  detailsBeforeHold: detailsBeforeHoldLine,
  ask: askLine,
  heldAsk: heldAskLine,
  requestAsk: requestAskLine,
  deposit: depositLine,
};

const HOLD_LINE_ES = "Le tengo ese horario reservado por un minuto mientras tomo sus datos.";

function askLineEs(missing: "first_name" | "phone"): string {
  return missing === "first_name" ? "¿Me podría dar su nombre?" : "¿Cuál es el mejor número para que la clínica se comunique con usted?";
}

function joinOrEs(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  // "o" becomes "u" before a word starting with the "o" sound: "siete u ocho".
  const or = (next: string) => (/^h?o/i.test(next) ? "u" : "o");
  if (items.length === 2) return `${items[0]} ${or(items[1]!)} ${items[1]}`;
  const last = items[items.length - 1]!;
  return `${items.slice(0, -1).join(", ")} ${or(last)} ${last}`;
}

/** depositLine, in Spanish: the same rule, the same promises, never a link. */
function depositLineEs(input: Parameters<typeof depositLine>[0]): string {
  if (!input) return "";
  const amount = input.amountUsd !== null && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null;
  if (input.action === "book_and_flag") {
    if (input.scope === "some_services") return "Algunas citas necesitan un depósito para reservarlas. Si la suya lo necesita, la recepción le llamará para cobrarlo; no se cobra nada en esta llamada.";
    return `Se requiere ${amount !== null ? `un depósito de ${amount} dólares` : "un depósito"} para reservar la cita. La recepción le llamará para cobrarlo; no se cobra nada en esta llamada.`;
  }
  if (input.action === "decline_and_alert") {
    if (input.scope === "some_services") return "Algunas citas necesitan un depósito y no se pueden reservar en esta llamada. Para esas, pasaré su solicitud al equipo, que le llamará para cobrar el depósito y confirmar un horario; no se cobra nada en esta llamada.";
    if (input.scope === "clinic") return `Las citas necesitan un depósito${amount !== null ? ` de ${amount} dólares` : ""}, así que no se pueden reservar en esta llamada. Pasaré su solicitud al equipo, que le llamará para cobrar el depósito y confirmar un horario; no se cobra nada en esta llamada.`;
    return `Esta cita necesita un depósito${amount !== null ? ` de ${amount} dólares` : ""}, así que no se puede reservar en esta llamada. Pasaré su solicitud al equipo, que le llamará para cobrar el depósito y confirmar un horario; no se cobra nada en esta llamada.`;
  }
  return "";
}

export const BOOKING_LINES_ES: BookingLines = {
  manual: "No puedo reservar eso directamente ahora, así que tomaré el horario que prefiere y la clínica se lo confirmará.",
  hold: HOLD_LINE_ES,
  noFreeTime: "No tengo un horario libre en ese momento. ¿Qué otro día u hora le vendría bien?",
  requestTaken: "Pasé su solicitud a la clínica, y ellos le confirmarán el horario.",
  depositHold: "Le reservé ese horario mientras la clínica gestiona el depósito. Le llamarán para cobrarlo y confirmar su cita.",
  depositRequest: "Esa cita necesita un depósito, así que pasaré su solicitud a la clínica y le llamarán para gestionarlo.",
  oneRequestPerCall: "Ya pasé una solicitud a la clínica en esta llamada. Cuando le llamen, pueden gestionar la otra cita también.",
  inProgress: "No puedo tomar otra reserva en esta llamada mientras la primera se sigue confirmando. La clínica puede gestionar cualquier otra cosa con usted.",
  toolFailure: "Lo siento, no pude completarlo en este momento. Puedo comunicarle con la clínica, o tomar sus datos para que se lo confirmen.",
  refused:
    "No puedo reservar citas en este momento. Comuníquese directamente con la clínica, y su equipo le dará un horario.",
  missing: {
    first_name: "No entendí su nombre. ¿Me lo podría repetir?",
    at: "No tengo un horario que pueda reservar. ¿Qué día y hora le vendría bien?",
    phone: "No entendí un número en el que la clínica pueda localizarle. ¿Me lo podría repetir?",
    preferred_window: "¿Qué día u hora le vendría mejor?",
  },
  booked: (when, service) => `Su cita está reservada para el ${when}${service ? ` para ${service}` : ""}. Está en el calendario de la clínica.`,
  oneBookingPerCall: (when) =>
    `Solo puedo reservar una cita por llamada, y la suya ya está reservada${when ? ` para el ${when}` : ""}. Para otra cita, vuelva a llamar o pregunte a la clínica.`,
  slotGone: (alternatives) =>
    alternatives.length === 0
      ? "Ese horario se acaba de ocupar. ¿Qué otro día u hora le vendría bien?"
      : `Ese horario se acaba de ocupar. Los horarios más cercanos que tengo son el ${joinOrEs(alternatives)}.`,
  offer: (times) => (times.length === 0 ? "No tengo un horario libre en ese momento. ¿Qué otro día u hora le vendría bien?" : `Tengo el ${joinOrEs(times)}. ¿Cuál le viene mejor?`),
  detailsBeforeHold: (when) => `Antes de reservarle el ${when}, ¿me podría dar su nombre y un número de celular en el que la clínica pueda localizarle?`,
  ask: askLineEs,
  heldAsk: (missing) => `${HOLD_LINE_ES} ${askLineEs(missing)}`,
  requestAsk: (missing, deposit) =>
    `${deposit ? "Esa cita necesita un depósito, así que pasaré su solicitud a la clínica y le llamarán para gestionarlo." : "No puedo reservar eso directamente ahora, así que tomaré el horario que prefiere y la clínica se lo confirmará."} ${askLineEs(missing)}`,
  deposit: depositLineEs,
};

/** The fixed booking lines in a call's language. */
/** A call's lines, in the caller's language (the website chat uses BOOKING_LINES_EN). */
export function bookingLinesFor(language: "en" | "es" = "en"): BookingLines {
  return language === "es" ? BOOKING_LINES_ES : BOOKING_LINES_VOICE_EN;
}

// -----------------------------------------------------------------------------
// English on a call (owner, 1 November 2026, docs/design/demo-aya-simpler-2026-11-01.md
// section 3a): the lines as a front desk says them, short, one question each.
// The website chat keeps BOOKING_LINES_EN above, word for word.
// -----------------------------------------------------------------------------

/** The front desk's part of the call's deposit line: replaced by the text's offer when the text is offered (payment-text.ts). */
export const VOICE_DEPOSIT_DESK_TAIL = ", and our front desk will give you a quick call to take it.";

/** The day of a spoken time ("Thursday the 5th at 3": "Thursday the 5th"), and its time ("3"). */
function dayOf(label: string): string {
  return label.split(" at ")[0] ?? label;
}
function timeOf(label: string): string {
  return label.includes(" at ") ? label.split(" at ").slice(1).join(" at ") : label;
}

/** Times said together, as a person lists them: "10, 2 or 4". */
function joinOrSpoken(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Times on offer, the day said once: "Thursday the 5th, I've got 10, 2 or 4". */
function spokenTimes(times: readonly string[]): string {
  const [first, ...rest] = times;
  if (!first) return "";
  if (first.includes(" at ") && rest.every((t) => !t.includes(" at "))) return `${dayOf(first)}, I've got ${joinOrSpoken([timeOf(first), ...rest])}`;
  // Times over more than one day, each day said once: "Monday the 2nd at 2 or 4, or Tuesday the 3rd at 2".
  const groups: { day: string; times: string[] }[] = [];
  let day = "";
  for (const label of times) {
    if (label.includes(" at ")) day = dayOf(label);
    const time = label.includes(" at ") ? timeOf(label) : label;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.times.push(time);
    else groups.push({ day, times: [time] });
  }
  const said = groups.map((g) => (g.day ? `${g.day} at ${joinOrSpoken(g.times)}` : joinOrSpoken(g.times)));
  return `I've got ${said.length === 2 ? `${said[0]}, or ${said[1]}` : said.length > 2 ? `${said.slice(0, -1).join(", ")}, or ${said[said.length - 1]}` : said[0]}`;
}

const VOICE_ASK = {
  first_name: "What's your first name?",
  phone: "What's the best number for you?",
} as const;

function voiceDepositLine(input: Parameters<typeof depositLine>[0]): string {
  if (!input) return "";
  const amount = input.amountUsd !== null && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null;
  if (input.action === "book_and_flag") {
    if (input.scope === "some_services") return "Some appointments need a deposit; if yours does, our front desk will give you a quick call to take it.";
    return `There's ${amount !== null ? `a ${amount} dollar deposit` : "a deposit"}${VOICE_DEPOSIT_DESK_TAIL}`;
  }
  return depositLine(input);
}

export const BOOKING_LINES_VOICE_EN: BookingLines = {
  ...BOOKING_LINES_EN,
  manual: "I'll note that time, and our team will confirm it with you.",
  hold: "I'm holding that time for you.",
  noFreeTime: "That one's full. Another day work?",
  toolFailure: "Sorry, that didn't go through. Want me to put you through to the clinic, or take your details so the team can confirm?",
  missing: {
    first_name: "Sorry, your first name?",
    at: "Which day and time would suit you?",
    phone: "Sorry, what was that number?",
    preferred_window: "Which day or time works best?",
  },
  booked: (when, service, firstName) => `Perfect${firstName ? `, ${firstName}` : ""}, you're booked${service ? ` for ${service}` : ""} on ${when}.`,
  oneBookingPerCall: (when) =>
    when ? `You're all set for ${when.replace(/ the \d+(?:st|nd|rd|th)\b/, "")}. For a second visit, our front desk can sort that out.` : "You're all set. For a second visit, our front desk can sort that out.",
  slotGone: (alternatives, gone) => {
    const lead = `Ah, ${gone ? timeOf(gone) : "that one"} just went.`;
    if (alternatives.length === 0) return `${lead} Another day work?`;
    const sameDay = gone && alternatives[0]!.includes(" at ") && dayOf(alternatives[0]!) === dayOf(gone);
    const times = sameDay ? [timeOf(alternatives[0]!), ...alternatives.slice(1)] : alternatives;
    return `${lead} I've got ${joinOrSpoken(times)}?`;
  },
  offer: (times) => {
    if (times.length === 0) return "That one's full. Another day work?";
    return `${spokenTimes(times)}. ${times.length === 1 ? "Does that work?" : "Any of those work?"}`;
  },
  detailsBeforeHold: () => `Lovely. ${VOICE_ASK.first_name}`,
  ask: (missing) => (missing === "phone" ? "And the best number for you?" : VOICE_ASK.first_name),
  heldAsk: (missing, when) => `Great, I'm holding ${when ? timeOf(when) : "that"} for you. ${VOICE_ASK[missing]}`,
  requestAsk: (missing, deposit) => `${deposit ? DEPOSIT_REQUEST_LINE : "I'll note that time, and our team will confirm it with you."} ${VOICE_ASK[missing]}`,
  deposit: voiceDepositLine,
};

/** Read back a number the caller gave, as a person checks it: "three oh five ..., right?" (forVoice speaks the digits). */
export function readBackLine(number: string): string {
  return `${number}, right?`;
}
