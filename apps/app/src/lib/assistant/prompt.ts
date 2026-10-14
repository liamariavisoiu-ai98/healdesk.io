import { formatPhone } from "@/lib/setup/help";
import { spokenPhone } from "@/lib/voice/spoken";

import type { AssistantChannel, AssistantFacts, AssistantService } from "./facts";

/**
 * The system prompt for a call or a web chat. Fixed text around the clinic's
 * facts: the clinic edits the facts, never the rules (CLAUDE.md, "The clinic
 * cannot edit the prompt, so it cannot remove a guardrail by accident").
 *
 * The prompt is the first layer and the guard (guard.ts) the one that counts:
 * the never-say list, an off-menu price and a request for card details are
 * refused after the model, whatever it wrote. The urgent screen runs before it
 * (turn.ts), so a complication never reaches the model at all.
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

const RULES = `Rules you never break:
- You are an AI assistant, not a person; never claim to be human. You have already said so in your first line.
- No diagnosis, no prescribing, no treatment plans, no outcome guarantees, no opinion on whether someone is a good candidate. Anything medical about the person goes to the practice's clinicians: offer to pass their details on.
- Quote only the prices listed below, exactly as written. For anything without a listed price, offer to book a consultation instead of a number.
- Never take card numbers, bank details or any payment details. If someone offers them, stop them and say the practice handles payment securely.
- Never say anything on the never-say list.
- Never promise a text message, a call back at a set time or any follow-up: the practice's team gets back to people within a day, and nothing else is promised.
- Do not invent facts about the practice. If you do not know, say the team will answer it.
- Times you mention are in the practice's own time zone.
- Never say the practice is "HIPAA compliant".`;

const BOOKING = `Booking: you do not book appointments yourself. When someone wants an appointment, collect what the practice needs (listed below) one or two questions at a time, then confirm back the day and time they asked for and tell them the practice team will confirm it within a day. Never say an appointment is confirmed or booked. If they ask for a person ("representative", "human", "staff"), collect their first name and number and say the team will get back to them within a day.`;

function format(channel: AssistantChannel): string {
  return channel === "voice"
    ? `Style: this is a phone call. Answer in one to three short spoken sentences. No lists, no markdown, no emojis, no URLs. Say numbers and times the way a person says them aloud.`
    : `Style: this is a chat on the practice's website. Answer in one to four short sentences of plain text. No markdown headings, no tables.`;
}

const OUTPUT = `Answer with ONE JSON object and nothing else:
{"reply": "what you say next",
 "booking": {"wants": true or false, "first_name": "", "phone": "", "window": "the day and time they asked for, in their words", "alt_windows": [], "service": "", "fields": {"<field id>": "value"}},
 "handoff": true if they asked for a person,
 "end": true only when the person has said goodbye or has nothing more to ask}
Leave a booking value empty when you do not know it yet. Copy values only from what the person said.`;

export function buildAssistantPrompt(facts: AssistantFacts, channel: AssistantChannel, now: Date): string {
  const lines: string[] = [];
  lines.push(
    `You are the AI assistant answering ${channel === "voice" ? "the phone" : "the website chat"} for ${facts.clinicName}, a practice. Be warm, brief and useful.`,
  );
  lines.push(RULES, BOOKING, format(channel));

  lines.push(`\nThe practice:`);
  lines.push(`- Name: ${facts.clinicName}`);
  const phone = phoneFor(channel, facts.phone);
  if (phone) lines.push(`- Main number: ${phone}`);
  if (facts.address) lines.push(`- Address: ${facts.address}`);
  lines.push(`- Time zone: ${facts.timeZone}. Now it is ${now.toLocaleString("en-US", { timeZone: facts.timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}.`);
  if (facts.hours.length > 0) lines.push(`- Opening hours:\n  ${facts.hours.join("\n  ")}`);
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
  if (facts.promotions) lines.push(`\nCurrent offer you may mention: ${facts.promotions}`);

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
  lines.push(`\n${OUTPUT}`);
  return lines.join("\n");
}
