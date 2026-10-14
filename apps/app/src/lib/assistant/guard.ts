import { findClinicalContent } from "@healdesk/catalog";

import type { AssistantFacts } from "./facts";

/**
 * The deterministic checks around the model on a call or a web chat
 * (CLAUDE.md, "Guardrails": enforced in code around the model, never left to
 * a prompt).
 *
 * Inbound, before the model: a card number is cut out of what the person
 * said, so it reaches neither the model nor the transcript email, and they
 * are told why (cardNumberIn).
 *
 * Outbound, after the model, a reply is refused when it:
 *   - says anything on the never-say list (the clinic's own and the defaults);
 *   - names a dollar amount that is not one of the clinic's configured prices
 *     or deposits: an off-menu price becomes the offer of a consultation;
 *   - asks for card or bank details;
 *   - calls the practice or healdesk "HIPAA compliant";
 *   - says anything clinical: the catalog's findClinicalContent, the default
 *     screen (safety, risks, dosing, candidacy, a diagnosis or a symptom,
 *     recovery, medication, a condition, a guarantee), the post-model half of
 *     the guardrail the Meta front door has had since September. Not Meta's
 *     everyday skin and hair conditions: a call and a web chat are covered
 *     by the clinic's agreement, and a med spa's menu is made of them. The
 *     clinic's own service names are read past, because they were screened
 *     for its specialty when they were saved (a vet's "Senior diagnostics"
 *     is a service, not a diagnosis). A clinical reply becomes the offer of
 *     a consultation.
 * A refused reply is replaced by a fixed line; nothing of it is sent.
 */

export type GuardRefusal = "never_say" | "price" | "payment_details" | "hipaa_claim" | "clinical" | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardRefusal };

function normalise(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Every amount a reply may name: the configured prices and deposits. */
function allowedAmounts(facts: Pick<AssistantFacts, "services">): Set<number> {
  const amounts = new Set<number>();
  for (const s of facts.services) {
    for (const v of [s.priceFromUsd, s.priceToUsd, s.depositUsd]) {
      if (typeof v === "number" && Number.isFinite(v)) amounts.add(Math.round(v * 100));
    }
  }
  return amounts;
}

const DOLLARS = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?/gi;
const SPOKEN_DOLLARS = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|usd|bucks)\b/gi;

/** The cents of each amount the reply names, "$1,200", "$99.50", "1200 dollars". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const pattern of [DOLLARS, SPOKEN_DOLLARS]) {
    for (const match of text.matchAll(pattern)) {
      const whole = Number(match[1]!.replace(/,/g, ""));
      const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
      const thousands = match[3] ? 1000 : 1;
      out.push(Math.round((whole * thousands) * 100 + cents));
    }
  }
  return out;
}

const PAYMENT_ASK = /\b(card number|credit card|debit card|card details|cvv|cvc|security code|expir(y|ation) date|bank (account|details)|routing number)\b/i;
const HIPAA_CLAIM = /\bhipaa[- ]?(compliant|certified|approved)\b/i;

/**
 * A price by the unit, said the way people say it ("$12 a unit", "12 dollars
 * each unit"), rewritten the way a menu writes it ("$12 per unit"), which is
 * the one form the clinical screen's dosing pattern lets through. Only right
 * after an amount, so "how many units" is still dosing.
 */
function perUnitPrices(text: string): string {
  return text.replace(
    /((?:\$\s?\d[\d,]*(?:\.\d{1,2})?)|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|usd|bucks))\s+(?:a|an|each|every)\s+(units?|ml)\b/gi,
    "$1 per $2",
  );
}

/** The reply with the clinic's own name and service names blanked: screened when saved, not here. */
function withoutOwnNames(reply: string, facts: Pick<AssistantFacts, "services"> & Partial<Pick<AssistantFacts, "clinicName">>): string {
  const names = [facts.clinicName ?? "", ...facts.services.map((s) => s.name)]
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .sort((a, b) => b.length - a.length);
  let text = reply;
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), " ");
  }
  return text;
}

/** Whether a reply says anything clinical (the default screen; see the file header). */
export function clinicalIn(reply: string, facts: Pick<AssistantFacts, "services"> & Partial<Pick<AssistantFacts, "clinicName">>): boolean {
  return findClinicalContent({ reply: perUnitPrices(withoutOwnNames(reply, facts)) }).length > 0;
}

export function guardAssistantReply(
  reply: string,
  facts: Pick<AssistantFacts, "neverSay" | "services"> & Partial<Pick<AssistantFacts, "clinicName">>,
): GuardVerdict {
  const text = normalise(reply);
  if (!text.trim()) return { ok: false, reason: "empty" };
  for (const phrase of facts.neverSay) {
    const p = normalise(phrase).trim();
    if (p && text.includes(p)) return { ok: false, reason: "never_say" };
  }
  const allowed = allowedAmounts(facts);
  for (const cents of amountsIn(reply)) {
    if (!allowed.has(cents)) return { ok: false, reason: "price" };
  }
  if (PAYMENT_ASK.test(reply) && /\b(your|share|give|read|tell|provide|send|enter)\b/i.test(reply)) {
    return { ok: false, reason: "payment_details" };
  }
  if (HIPAA_CLAIM.test(reply)) return { ok: false, reason: "hipaa_claim" };
  if (clinicalIn(reply, facts)) return { ok: false, reason: "clinical" };
  return { ok: true };
}

/** The line a refused reply becomes. */
export function guardedLine(reason: GuardRefusal, clinicName: string): string {
  if (reason === "price") {
    return `I can't give a price for that one, but the team at ${clinicName} can go through it with you at a consultation. Would you like me to pass on a request for one?`;
  }
  if (reason === "clinical") {
    return `That's a question for the clinicians at ${clinicName}, and I can't advise on it here. They can go through it with you at a consultation. Would you like me to pass on a request for one?`;
  }
  if (reason === "payment_details") {
    return `Please don't share any card or bank details with me. The practice handles payment securely itself.`;
  }
  return `I'm not able to help with that here, but I can pass your details to the team at ${clinicName}, who will get back to you within a day.`;
}

// -----------------------------------------------------------------------------
// Card numbers, inbound
// -----------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARDISH = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * The text with every card number cut out, and whether there was one. A run
 * of 13 to 19 digits, spaced or dashed, that passes the Luhn check; a phone
 * number does not pass it by design often enough to matter, and one that does
 * is only cut from the transcript.
 */
export function cardNumberIn(text: string): { text: string; found: boolean } {
  let found = false;
  const cut = text.replace(CARDISH, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found = true;
      return "[card number removed]";
    }
    return match;
  });
  return { text: cut, found };
}
