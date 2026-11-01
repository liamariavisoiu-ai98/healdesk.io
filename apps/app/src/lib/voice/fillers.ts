import type { SpokenLanguage } from "./spoken";

/**
 * The word a person says while they gather an answer (owner, 1 November
 * 2026: "make sure that those filler words and sounds are almost always
 * present"). People answer each other within about 200 ms; our reply needs
 * the model's first words, which take longer, so a filler that fits what the
 * caller just said is said at once and the model carries on from it.
 *
 * Fillers were switched off on 26 October 2026 because one list ("Hmm.",
 * "Mm-hmm.", "Right.", "Sure.") played in front of every answer and the
 * owner heard "the emotions are in a loop". So these are chosen by what the
 * caller said (sympathy for a worry, delight for an occasion, a thinking word
 * for a question), never the same as the one before, each at most twice a
 * call, and none for a thank-you, a goodbye, a word or two, or before a line
 * code says itself (an urgent line, a card warning, a fixed call line, a
 * booking line on a turn the model does not answer).
 */

type Mood = "sympathy" | "delight" | "question" | "request" | "plain";

const LINES: Readonly<Record<SpokenLanguage, Readonly<Record<Mood, readonly string[]>>>> = {
  en: {
    sympathy: ["Oh no,", "Aw,", "Oh, I hear you,"],
    delight: ["Oh, nice!", "Ooh,", "Oh, how fun!"],
    question: ["So,", "Good question,", "Okay, so,", "Hmm,"],
    request: ["Sure,", "Okay,", "Sure thing,", "Perfect,"],
    plain: ["Okay,", "Right,", "Got it,"],
  },
  // Awaiting a native speaker's review, as the call's other Spanish lines are.
  es: {
    sympathy: ["Ay, lo siento,", "Ay, entiendo,"],
    delight: ["¡Qué bien!", "¡Ay, qué lindo!"],
    question: ["A ver,", "Buena pregunta,", "Bueno,"],
    request: ["Claro,", "Perfecto,", "Muy bien,"],
    plain: ["Bueno,", "Claro,", "Vale,"],
  },
};

const SYMPATHY = /\b(?:ugh|frustrat\w*|annoy\w*|upset|worried|worry|nervous|scared|anxious|afraid|terrible|awful|bad day|rough|stress\w*|disappoint\w*|lo siento|preocupad\w*|nervios\w*)\b/i;
const DELIGHT = /\b(?:wedding|birthday|anniversary|honeymoon|vacation|holiday|trip|graduation|reunion|party|excited|engaged|baby shower|prom|boda|cumplea[nñ]os|vacaciones|emocionad\w*)\b/i;
const QUESTION = /\?\s*$|^\W*(?:what|how|why|which|who|where|when|do|does|did|can|could|is|are|will|would|should|qu[eé]|c[oó]mo|cu[aá]nto|cu[aá]l|d[oó]nde|cu[aá]ndo|puedo|tienen|hay)\b/i;
const REQUEST = /\b(?:book|appointment|schedule|come in|reserve|sign me up|i(?:'d| would) like|i want|cita|reservar|quiero)\b/i;
/** No filler: a thank-you, a goodbye, a plain yes or no, a name or a number, which want an answer straight away. */
const NONE = /^\W*(?:thanks?|thank you|bye|goodbye|that'?s (?:all|it)|no(?:pe)?|yes|yeah|yep|ok(?:ay)?|sure|gracias|adi[oó]s|s[ií])\b[^?]{0,20}$|\d{3}/i;

export const FILLER_MIN_WORDS = 3;
/** How many times one filler may be said in a call. */
export const FILLER_MAX_PER_CALL = 2;

/**
 * The filler for the caller's words, or null for none. `said` is every
 * filler said so far this call, in order.
 */
export function fillerFor(words: string, language: SpokenLanguage, said: readonly string[], random: () => number = Math.random): string | null {
  const text = words.trim();
  if (text.split(/\s+/).filter(Boolean).length < FILLER_MIN_WORDS || NONE.test(text)) return null;
  const mood: Mood = SYMPATHY.test(text) ? "sympathy" : DELIGHT.test(text) ? "delight" : QUESTION.test(text) ? "question" : REQUEST.test(text) ? "request" : "plain";
  const last = said[said.length - 1] ?? null;
  const count = (line: string) => said.filter((s) => s === line).length;
  const choices = LINES[language][mood].filter((line) => line !== last && count(line) < FILLER_MAX_PER_CALL && !(line === "Hmm," && count(line) > 0));
  if (choices.length === 0) return null;
  return choices[Math.floor(random() * choices.length)] ?? choices[0]!;
}
