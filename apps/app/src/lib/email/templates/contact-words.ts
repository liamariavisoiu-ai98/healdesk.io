/**
 * The closed word lists of the emails the owner sends a clinic by hand
 * through the approval inbox (ops automation lane P6f): the BAA re-sign
 * chase, the agreement question and the three setup notices.
 *
 * Owner decision D12 (25 October 2026): free-form text goes out in one kind
 * only, the support reply. These emails are fixed templates whose only
 * editable parts are structured fields: a day count, a channel phrase from
 * PHRASES and, optionally, one sentence from NOTES. A payload carries the
 * code, never the words, so the payload allowlist (lib/email/lint.ts) sees a
 * bare token, and the template prints the words from here. Nothing anyone
 * types reaches an email.
 *
 * Pure data with no imports, so lib/approvals and the templates read the
 * same lists.
 */

/** What a setup notice is about: the part of setup it names. */
export const PHRASES = ["phone", "website_chat", "meta", "calendar"] as const;
export type PhraseCode = (typeof PHRASES)[number];

/** Each phrase as a sentence prints it, short enough for a 70-character subject. */
export const PHRASE_WORDS: Readonly<Record<PhraseCode, string>> = {
  phone: "your phone line",
  website_chat: "your website chat",
  meta: "Instagram, Messenger & WhatsApp",
  calendar: "your Google Calendar connection",
};

/** The approved closing sentences, one of which an email may carry. */
export const NOTES = ["call_offer", "thanks", "reply_questions", "thanks_sign"] as const;
export type NoteCode = (typeof NOTES)[number];

export const NOTE_WORDS: Readonly<Record<NoteCode, string>> = {
  call_offer: "If it's easier to talk it through, reply with a time that suits you and we'll call.",
  thanks: "Thank you for your patience while we sort this out.",
  reply_questions: "If anything is unclear, reply to this email and we'll help.",
  // The chase's own closing line: nothing is being sorted out, a signature is asked for.
  thanks_sign: "Thank you for taking a moment to sign it.",
};

/** The note's sentence, or nothing for a code that is not on the list. */
export function noteLine(note: unknown): string | null {
  return typeof note === "string" && (NOTES as readonly string[]).includes(note) ? NOTE_WORDS[note as NoteCode] : null;
}

/** The phrase's words; a code off the list is refused by the caller before it gets here. */
export function phraseWords(phrase: unknown): string | null {
  return typeof phrase === "string" && (PHRASES as readonly string[]).includes(phrase)
    ? PHRASE_WORDS[phrase as PhraseCode]
    : null;
}
