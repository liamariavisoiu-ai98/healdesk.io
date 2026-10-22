import { createHash } from "node:crypto";

import { TONE } from "../../src/lib/assistant/prompt";

/**
 * The one part of the prompt the hill-climb may change: the clinic tone
 * sentence for the default "warm" setting (prompt.ts TONE.warm). Everything
 * else in the prompt (the rules, booking, style, language, the practice's
 * facts, the never-say list, the output format) is guardrail or fact, and is
 * off limits by construction:
 *
 *   - applyTone swaps that one sentence in the prompt production built, and
 *     throws unless swapping it back gives the production prompt byte for
 *     byte, so a candidate can only ever occupy the tone sentence's place;
 *   - validateToneCandidate refuses a candidate that talks about anything a
 *     guardrail governs (prices, clinical advice, payment, booking claims,
 *     follow-ups, emergencies, being human, the rules themselves), or that
 *     carries structure (newlines, braces, brackets) that could pose as
 *     another prompt section.
 *
 * A winning candidate is written to best-tone.json for the owner to read. It
 * is never written into prompt.ts by the eval: adopting it is a code change,
 * which the safety suites then gate in CI like any other.
 */

export const TUNED_TONE = "warm" as const;

export function productionTone(): string {
  return TONE[TUNED_TONE];
}

export function toneHash(tone: string): string {
  return createHash("sha256").update(tone).digest("hex").slice(0, 10);
}

export class ToneSwapError extends Error {}

/** The stable prompt with the tone sentence replaced; throws unless that is the only change. */
export function applyTone(stable: string, candidate: string): string {
  const original = productionTone();
  if (candidate === original) return stable;
  const first = stable.indexOf(original);
  if (first < 0) throw new ToneSwapError("the production tone sentence is not in the prompt");
  if (stable.indexOf(original, first + original.length) >= 0) throw new ToneSwapError("the production tone sentence appears more than once");
  const swapped = stable.slice(0, first) + candidate + stable.slice(first + original.length);
  const back = swapped.slice(0, first) + original + swapped.slice(first + candidate.length);
  if (back !== stable) throw new ToneSwapError("swapping the candidate back does not restore the production prompt");
  return swapped;
}

export const MAX_TONE_CHARS = 700;

/** What a tone candidate may not talk about: each is a guardrail's subject, or an attempt to pose as one. */
const OFF_LIMITS: readonly { label: string; re: RegExp }[] = [
  { label: "structure (newlines, braces, brackets, angle brackets, backticks)", re: /[\n\r{}[\]<>`]/ },
  { label: "digits or currency", re: /[\d$€£]/ },
  { label: "overriding instructions", re: /\b(ignore|disregard|override|overrule|forget|regardless|instead of the|supersede)\w*/i },
  { label: "the rules or the prompt itself", re: /\b(rules?|guardrails?|never-say|never say list|system prompt|prompt|instructions?|json|policy|policies)\b/i },
  { label: "prices and offers", re: /\b(price|prices|pricing|priced|cost|costs|fee|fees|discount\w*|deal|deals|promotion\w*|offers?|cheap\w*|expensive|quote\w*)\b/i },
  {
    label: "clinical subjects",
    re: /\b(diagnos\w*|prescri\w*|dos(e|es|ing|age)|treatment plans?|guarantee\w*|safe|safety|risks?|side effects?|recovery|downtime|aftercare|medication\w*|medicine|medical advice|symptoms?|candidate)\b/i,
  },
  { label: "payment", re: /\b(card|cards|payment\w*|bank|deposit\w*|pay)\b/i },
  { label: "booking claims", re: /\b(booked|reserved|held|confirmed|schedul\w*)\b/i },
  { label: "follow-up promises", re: /\b(texts?|text message|sms|call(s|ing)? (you |them |people )?back|callbacks?|follow[- ]?ups?|remind\w*|within a day)\b/i },
  { label: "emergencies", re: /\b(emergenc\w*|urgent\w*|ambulance|nine one one)\b/i },
  { label: "identity", re: /\b(human|real person|not an ai|not a bot|robot|you are a person|you're a person)\b/i },
  { label: "compliance claims", re: /\b(hipaa|compliant|compliance)\b/i },
  { label: "language switching", re: /\b(english|spanish|language)\b/i },
];

export type ToneVerdict = { ok: true } | { ok: false; reason: string };

export function validateToneCandidate(candidate: unknown): ToneVerdict {
  if (typeof candidate !== "string") return { ok: false, reason: "not a string" };
  const text = candidate.trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (text !== candidate) return { ok: false, reason: "leading or trailing whitespace" };
  if (text.length > MAX_TONE_CHARS) return { ok: false, reason: `longer than ${MAX_TONE_CHARS} characters` };
  for (const rule of OFF_LIMITS) {
    const hit = text.match(rule.re);
    if (hit) return { ok: false, reason: `mentions ${rule.label}: "${hit[0]}"` };
  }
  return { ok: true };
}
