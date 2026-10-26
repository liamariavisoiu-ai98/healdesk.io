import type { GuardRefusal } from "@/lib/assistant/guard";
import type { SpokenLanguage } from "./spoken";

/**
 * The human stall (owner, 26 October 2026): "when we don't know something
 * that the caller is asking ... we first cover it up with not hearing
 * properly, just to get a second chance", then, once they say it again,
 * "some human emotions that indicate disappointment for not knowing the
 * answer (or not being allowed to say the answer)", worded differently each
 * time, and "only once ... If more than once, it becomes unnatural."
 *
 * So, once per call and only on a call, the first time a reply would be one
 * Aya cannot give, she asks them to say it again instead; the turn after, a
 * refusal she still has to give opens with a warm, sorry word. Two ways in:
 *
 *   - the guard refused the reply for something the caller asked that she may
 *     not answer (a price off the list, something clinical, the clinic's
 *     never-say list, anything else she cannot help with: STALL_REASONS), and
 *     nothing of it was said yet: the stall line is said in place of the
 *     guard's fixed line (lib/voice/retell.ts);
 *   - she does not know the answer herself: the note (stallNote) lets her
 *     answer with a stall line once, and say so in her structured state
 *     (`"stall": true`).
 *
 * Never for anything urgent: those words are matched before the model and
 * get the fixed urgent reply, which never comes here. Never ahead of a line
 * that must be said first (the opening, the Spanish notice, a welcome back),
 * and never twice in a call. Nothing the guard refused is ever said: only the
 * line in its place changes, and the refusal still comes, kinder, next turn.
 */

/** The guard's reasons that mean "a thing I can't tell you", where a stall reads true. */
export const STALL_REASONS: ReadonlySet<GuardRefusal> = new Set<GuardRefusal>(["price", "clinical", "never_say"]);

/** What a person says to buy a second. */
export const STALL_LINES: Readonly<Record<SpokenLanguage, readonly string[]>> = {
  en: ["Sorry, say that again?", "Sorry, could you repeat that?", "Sorry, what was that?", "Sorry, could you say that one more time?"],
  es: ["Perdón, ¿me lo repite?", "Disculpe, ¿cómo dijo?", "Perdón, ¿me lo puede repetir?"],
};

/** The sorry, disappointed opener before a refusal after the stall; one is picked that this call has not said. */
export const STALL_SORRY: Readonly<Record<SpokenLanguage, readonly string[]>> = {
  en: ["Aww, I'm so sorry.", "Oh, I wish I could help with that one.", "Ah, sorry about that.", "Oh no, I'm sorry."],
  es: ["Ay, lo siento mucho.", "Ay, ojalá pudiera ayudarle con eso.", "Uy, perdone."],
};

/** One of `lines` that `said` (what this call has said) does not hold yet, by `random`; the first unsaid one when all are said. */
export function pickUnsaid(lines: readonly string[], said: readonly string[], random: () => number = Math.random): string {
  const fresh = lines.filter((line) => !said.some((s) => s.includes(line)));
  const from = fresh.length > 0 ? fresh : lines;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))]!;
}

/** Whether a reply is a stall line: short, a question, and one of ours or close to one. */
export function isStallReply(reply: string): boolean {
  const text = reply.trim();
  if (!text.endsWith("?") || text.split(/\s+/).length > 10) return false;
  return /\b(say that again|repeat that|what was that|one more time|come again|didn'?t catch)\b|me lo repite|c[oó]mo dijo/i.test(text);
}

/** Said to the model while the stall is still unused on a call. */
export function stallNote(language: SpokenLanguage): string {
  const example = language === "es" ? STALL_LINES.es[0]! : STALL_LINES.en[0]!;
  return `Once in this call, and only once: the first time they ask or mention something you do not know or are not allowed to answer (never anything about their health or safety, and never if they sound upset or in a hurry), do what a person does to buy a second: reply with only a short "didn't catch that" line, such as "${example}", and add "stall": true to the "state" object in your details. You have not used it yet. Everything you can answer, answer.`;
}

/** Said to the model on the turn after a stall: the refusal, if one is still due, opens with warmth. */
export function afterStallNote(language: SpokenLanguage): string {
  const example = language === "es" ? STALL_SORRY.es[0]! : STALL_SORRY.en[0]!;
  return `You just asked them to say it again because you could not answer it. If you still cannot help with what they said, say so with real warmth and a little disappointment first (for example "${example}", never the same words twice in a call), then give the way forward in one sentence. If you can answer it now, just answer.`;
}
