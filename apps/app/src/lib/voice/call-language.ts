import { languageScores, messageLanguage, type LanguageOptions } from "@healdesk/catalog";

import type { SpokenLanguage } from "./spoken";

/**
 * Which language a call is being spoken in, turn by turn (owner, 22 October
 * 2026): the state that picks every fixed line a call says (lib/voice/
 * retell.ts) and, the first time it turns to Spanish, the Spanish AI and
 * transcription line (lib/compliance/disclosure.ts, voiceDisclosureEs).
 *
 * Every call starts in English, the clinic's default and the language of the
 * opening line. It turns to Spanish only for a clinic whose languages include
 * Spanish (facts.languages), and only on evidence, read with the catalog's
 * own language check (messageLanguage, languageScores), never the model:
 *
 *   - two Spanish utterances in a row, or
 *   - one long, confident one (LONG_WORDS Spanish words or more, at least
 *     twice as many as English ones).
 *
 * It turns back to English by the same rule, mirrored. An utterance with no
 * evidence either way (a name, a time, "ok", "sí", a language no screen
 * reads) leaves the state and the streak as they are, so a caller answering
 * "Maria" or "3pm" never flips a call. A speech recogniser that hears one
 * stray word of the other language cannot flip it either: one ordinary
 * utterance is a streak of one.
 */

/** Spanish (or English) words in one utterance for it to decide the language alone. */
export const LONG_WORDS = 6;

/** Utterances in a row, each leaning the same way, that turn a call's language. */
export const STREAK = 2;

export type CallLanguageState = {
  language: SpokenLanguage;
  /** The language the latest utterances leaned to, and how many in a row. */
  leaning: SpokenLanguage | null;
  streak: number;
};

export const START_LANGUAGE: CallLanguageState = { language: "en", leaning: null, streak: 0 };

type Vote = { language: SpokenLanguage; confident: boolean } | null;

/** What one utterance says about its language: a vote, confident or not, or nothing. */
export function utteranceVote(text: string, options: LanguageOptions = {}): Vote {
  const said = messageLanguage(text, options);
  if (said === "other") return null;
  const scores = languageScores(text, options);
  if (said === "es" && scores.es >= 2 && scores.es > scores.en) {
    return { language: "es", confident: scores.es >= LONG_WORDS && scores.es >= 2 * scores.en };
  }
  if (said === "en" && scores.en >= 2 && scores.en > scores.es) {
    return { language: "en", confident: scores.en >= LONG_WORDS && scores.en >= 2 * scores.es };
  }
  return null;
}

/**
 * The state after one more utterance. `spanishAllowed` is whether the clinic
 * answers in Spanish: without it the call stays English whatever is said,
 * and the model says it can only help in English (prompt.ts, languagesLine).
 */
export function nextCallLanguage(
  state: CallLanguageState,
  text: string,
  options: LanguageOptions & { spanishAllowed: boolean },
): CallLanguageState {
  if (!options.spanishAllowed) return START_LANGUAGE;
  const vote = utteranceVote(text, options);
  if (!vote) return state;
  const streak = state.leaning === vote.language ? state.streak + 1 : 1;
  const turns = vote.confident || streak >= STREAK;
  return { language: turns ? vote.language : state.language, leaning: vote.language, streak };
}
