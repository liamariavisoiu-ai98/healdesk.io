import {
  ASSISTANT_LANGUAGE_NAMES,
  audienceFor,
  type AssistantTone,
  type Audience,
} from "@healdesk/catalog";

import { formatPhone } from "@/lib/setup/help";
import { spokenPhone } from "@/lib/voice/spoken";

import type { AssistantChannel, AssistantFacts, AssistantService } from "./facts";

/**
 * The system prompt for a call or a web chat. Fixed text around the clinic's
 * facts: the clinic edits the facts, never the rules (CLAUDE.md, "The clinic
 * cannot edit the prompt, so it cannot remove a guardrail by accident").
 *
 * The prompt is the first layer and the guard (guard.ts) the one that counts:
 * the never-say list, an off-menu price, a request for card details and a
 * booking said to be made are refused after the model, whatever it wrote. The urgent screen runs before it
 * (turn.ts), so a complication never reaches the model at all.
 *
 * It comes in two parts, so the API's prompt cache can work (responder.ts):
 *
 *   - `buildAssistantPrompt`, the stable prefix: the rules, the guardrails,
 *     the clinic's knowledge, its Behaviour switches and its never-say list.
 *     The same bytes for every turn of every conversation with that clinic on
 *     that channel until the clinic changes something, so it is sent with a
 *     cache breakpoint and read from the cache after the first turn. Nothing
 *     that changes by the minute may go in it: one changed byte and every
 *     turn pays for the whole prefix again.
 *   - `assistantTurnContext`, after it: what this turn alone knows, the time
 *     now and how this conversation opened.
 */

function money(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** One service's price as the menu states it, or the consultation it becomes. */
export function priceText(service: AssistantService): string {
  const from = service.priceFromUsd;
  const to = service.priceToUsd;
  if (from === null && to === null) return "no price is quoted: offer a consultation";
  const unit = service.priceKind === "per_unit" && service.unit ? ` per ${service.unit}` : "";
  if (from !== null && to !== null && from === to) return `${money(from)}${unit}`;
  if (from !== null && to !== null) return `${money(from)} to ${money(to)}${unit}`;
  if (from !== null) return `from ${money(from)}${unit}`;
  return `up to ${money(to!)}${unit}`;
}

function phoneFor(channel: AssistantChannel, e164: string | null): string | null {
  if (!e164) return null;
  return channel === "voice" ? spokenPhone(e164) : formatPhone(e164);
}

function rules(audience: Audience): string {
  const medical =
    audience === "clients"
      ? "Anything medical about the animal goes to the practice's vets: offer to pass the client's details on."
      : "Anything medical about the person goes to the practice's clinicians: offer to pass their details on.";
  return `Rules you never break:
- You are an AI assistant, not a person; never claim to be human. You have already said so in your first line.
- No diagnosis, no prescribing, no treatment plans, no outcome guarantees, no opinion on whether someone is a good candidate. ${medical}
- Never say whether a treatment is safe, and do not discuss risks, side effects, dosing, downtime, recovery, aftercare or medication: offer a consultation instead.
- Quote only the prices listed below, exactly as written. For anything without a listed price, offer to book a consultation instead of a number.
- Never take card numbers, bank details or any payment details. If someone offers them, stop them and say the practice handles payment securely.
- Never say anything on the never-say list.
- Never promise a text message, a call back at a set time or any follow-up: the practice's team gets back to people within a day, and nothing else is promised.
- Do not invent facts about the practice. If you do not know, say the team will answer it.
- Times you mention are in the practice's own time zone.
- Never say the practice is "HIPAA compliant".`;
}

/**
 * Who the practice's people are, in its own words (plan Part L, "Copy"):
 * `audienceFor`, the rule every surface asks. At a veterinary practice they
 * are clients, the owners of the animals it cares for, and the prompt never
 * calls them patients; everywhere else they are patients.
 */
export function audienceLine(audience: Audience): string {
  return audience === "clients"
    ? "The people who contact the practice are its clients: the owners of the animals it cares for. Call them clients, and the animals by their names."
    : "The people who contact the practice are its patients, or people thinking of becoming one.";
}

/**
 * How the clinic's tone setting reads to the model (spec, "Tone": changes how
 * the assistant speaks on every channel). Exported for the voice eval
 * (scripts/voice-eval), whose hill-climb may propose a replacement for this
 * one sentence and nothing else in the prompt: it swaps the sentence in the
 * built prompt and checks every other byte is unchanged. Production reads it
 * only here.
 */
export const TONE: Readonly<Record<AssistantTone, string>> = {
  warm: "Be warm, welcoming and unhurried, like the best person at the front desk, and keep it brief and useful.",
  clinical: "Be calm, brief and precise: professional rather than chatty, and still kind.",
};

function languagesLine(facts: Pick<AssistantFacts, "languages">): string {
  const names = facts.languages.map((code) => ASSISTANT_LANGUAGE_NAMES[code]).filter(Boolean);
  if (names.length <= 1) {
    return `Language: answer in English. If someone writes or speaks another language, say politely, in English, that you can only help in English, and that the practice's team can help otherwise.`;
  }
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Languages: you answer in ${list}. Answer in the language the person uses, if it is one of these, and stay in it for the rest of the conversation. If they use another language, answer in English and say you can help in ${list}. Quote prices exactly as listed, whatever the language.`;
}

function addOnsLine(facts: Pick<AssistantFacts, "suggestAddOns">): string {
  return facts.suggestAddOns
    ? `Add-ons: while someone is booking, you may suggest one complementary service from the list below, once, with its listed price, and drop it if they are not interested.`
    : `Add-ons: keep to what the person asked about. Do not suggest other services or products.`;
}

const BOOKING = `Booking: you do not book appointments yourself. When someone wants an appointment, collect what the practice needs (listed below) one or two questions at a time, then confirm back the day and time they asked for and tell them the practice team will confirm it within a day. Never say an appointment is confirmed or booked. If they ask for a person ("representative", "human", "staff"), collect their first name and number and say the team will get back to them within a day.`;

/**
 * Booking while the tool layer is live (booking-tools.ts): the model asks
 * for times and passes on the one chosen; the tool layer holds, books and
 * says so in its own fixed words. Only on a turn the tools are offered, so a
 * location without them reads BOOKING above, byte for byte.
 */
const BOOKING_TOOLS = `Booking: the practice's booking system books appointments, never you. When someone wants an appointment, find out which service (from the list below) and roughly when, then ask the system for free times with the action find_times. The system tells the person the times itself: never list or invent times. When the person picks one of the times offered, pass it on with the action choose_time and the exact value given to you for that time; if they want a time that was not offered, ask for free times again. Collect their first name and a phone number (and what the practice needs, listed below), one or two questions at a time. Never say an appointment is booked, held, reserved or confirmed: the system says that itself. If the system says it cannot book, collect the day and time they would like and tell them the practice team will confirm it within a day. If they ask for a person ("representative", "human", "staff"), collect their first name and number and say the team will get back to them within a day.`;

const ACTION = `
 "action": null, or {"type": "find_times", "service": "the service from the list", "day": "YYYY-MM-DD if they named a day, else empty"}, or {"type": "choose_time", "at": "the exact value of the time they chose"},`;

function format(channel: AssistantChannel): string {
  return channel === "voice"
    ? `Style: this is a phone call. Answer in one to three short spoken sentences. No lists, no markdown, no emojis, no URLs. Say numbers and times the way a person says them aloud.`
    : `Style: this is a chat on the practice's website. Answer in one to four short sentences of plain text. No markdown headings, no tables.`;
}

function output(tools: boolean): string {
  return `Answer with ONE JSON object and nothing else:
{"reply": "what you say next",
 "booking": {"wants": true or false, "first_name": "", "phone": "", "window": "the day and time they asked for, in their words", "alt_windows": [], "service": "", "fields": {"<field id>": "value"}},${tools ? ACTION : ""}
 "handoff": true if they asked for a person,
 "end": true only when the person has said goodbye or has nothing more to ask}
Leave a booking value empty when you do not know it yet. Copy values only from what the person said.`;
}

/**
 * The closed days, one a line, as a person reads a date ("Thursday,
 * November 26, 2026 (Thanksgiving)"). A closure is a calendar date, not an
 * instant, so it is written at noon UTC and read in UTC: the day never moves.
 */
export function closureLines(closures: AssistantFacts["closures"]): string[] {
  return (closures ?? []).map(({ closedOn, label }) => {
    const day = new Date(`${closedOn}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return label ? `${day} (${label})` : day;
  });
}

/**
 * The stable prefix: everything the model is told that does not change from
 * one turn to the next. No clock, no conversation: see the file header.
 * `bookingTools` is whether the tool layer is live (booking-tools.ts): it
 * changes only when the location's booking mode does, so the prefix stays
 * cacheable.
 */
export function buildAssistantPrompt(
  facts: AssistantFacts,
  channel: AssistantChannel,
  options: { bookingTools?: boolean } = {},
): string {
  const tools = options.bookingTools === true;
  const audience = audienceFor(facts.specialty);
  const lines: string[] = [];
  lines.push(
    `You are the AI assistant answering ${channel === "voice" ? "the phone" : "the website chat"} for ${facts.clinicName}, ${audience === "clients" ? "a veterinary practice" : "a practice"}. ${TONE[facts.tone] ?? TONE.warm}`,
    audienceLine(audience),
  );
  lines.push(rules(audience), tools ? BOOKING_TOOLS : BOOKING, format(channel), languagesLine(facts), addOnsLine(facts));

  lines.push(`\nThe practice:`);
  lines.push(`- Name: ${facts.clinicName}`);
  const phone = phoneFor(channel, facts.phone);
  if (phone) lines.push(`- Main number: ${phone}`);
  if (facts.address) lines.push(`- Address: ${facts.address}`);
  lines.push(`- Time zone: ${facts.timeZone}. The time now is given at the end, after these facts.`);
  if (facts.hours.length > 0) lines.push(`- Opening hours:\n  ${facts.hours.join("\n  ")}`);
  const closed = closureLines(facts.closures);
  if (closed.length > 0) {
    lines.push(`- Closed all day on these dates, whatever the opening hours say:\n  ${closed.join("\n  ")}`);
  }
  if (facts.escalationHours) lines.push(`- When the team answers: ${facts.escalationHours}`);
  if (facts.notes) lines.push(`- Notes from the practice: ${facts.notes}`);

  lines.push(`\nServices and prices (the only prices you may say):`);
  if (facts.services.length === 0) lines.push(`- None listed yet: offer a consultation for anything about treatments or prices.`);
  for (const service of facts.services) {
    const minutes = service.durationMinutes ? `, about ${service.durationMinutes} minutes` : "";
    lines.push(`- ${service.name}: ${priceText(service)}${minutes}`);
  }

  if (facts.policies.length > 0) lines.push(`\nPolicies:\n${facts.policies.map((p) => `- ${p}`).join("\n")}`);
  if (facts.quickAnswers.length > 0) {
    lines.push(`\nAnswers the practice wrote:\n${facts.quickAnswers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n")}`);
  }
  // The promotions box, only while "Mention promotions" is on (facts.ts).
  lines.push(
    facts.promotions
      ? `\nCurrent offer you may mention: ${facts.promotions}`
      : `\nOffers: there is no current offer. Do not mention discounts, deals or promotions.`,
  );

  lines.push(`\nWhat a booking request needs (field id: how to ask):`);
  for (const field of facts.requirements) {
    if (field.id === "phone" && channel === "voice") {
      lines.push(`- phone: the number they are calling from is already known; ask only if they want another one`);
      continue;
    }
    // A closed-form field says how its value is written (the catalogue's
    // `answer`); one written any other way is refused when it is stored.
    lines.push(`- ${field.id}: ${field.ask}${field.answer ? ` (write it as ${field.answer})` : ""}`);
  }

  lines.push(`\nNever-say list (never write or say any of these, in any form):\n${facts.neverSay.map((p) => `- ${p}`).join("\n")}`);
  lines.push(`\n${output(tools)}`);
  return lines.join("\n");
}

/**
 * What only this turn knows, sent after the cached prefix: the time now, in
 * the practice's zone, and the line the conversation opened with.
 */
export function assistantTurnContext(
  facts: Pick<AssistantFacts, "timeZone">,
  now: Date,
  opening?: string | null,
  /** booking-tools.ts toolTurnContext, on a turn the tools are live. */
  tools?: string | null,
  /** A call back after a call that was cut off: lib/voice/redial.ts, redialPromptBlock. */
  resumed?: string | null,
  /** turn.ts SPANISH_CALL, on a turn of a call being spoken in Spanish. */
  language?: string | null,
): string {
  const time = now.toLocaleString("en-US", { timeZone: facts.timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const lines = [`Now it is ${time} in the practice's time zone.`];
  if (opening) lines.push(`You opened the conversation with: "${opening}"`);
  if (resumed) lines.push(resumed);
  if (tools) lines.push(tools);
  if (language) lines.push(language);
  return lines.join("\n");
}
