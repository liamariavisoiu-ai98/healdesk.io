import { spokenPhone } from "@/lib/voice/spoken";

/**
 * Lines a call says itself, in place of the model, for asks a front desk
 * answers the same way every time (owner, 1 November 2026, on a test call to
 * the Miami Skin & Vein demo: "go ahead with all of it"). Every call, a
 * clinic's own and a demo, has them; an urgent reply, matched before any of
 * this, still wins.
 */

/** A business ask, not a patient's: a franchise, a partnership, a sale, a job. */
const BUSINESS =
  /\b(?:franchis\w*|business (?:opportunit\w*|proposal|inquir\w*|enquir\w*|partner\w*|deal)|partnership|invest(?:or|ors|ment|ing) (?:in|opportunit\w*)|sales (?:rep|call|pitch)|i(?:'m| am) (?:selling|calling from (?:a|an) (?:agency|company))|marketing (?:services|agency)|vendor|supplier|wholesale|job (?:opening|application)s?|are you hiring|(?:is the (?:clinic|practice|business)|are you) for sale|buy (?:the|your) (?:clinic|practice|business))\b/i;

/**
 * What she says to a business ask (owner, 1 November 2026: "please call our
 * office on ...", on demo and clinic calls alike): the office's number, and
 * nothing promised (the demo's "I'll pass your details and they'll get back
 * to you within a day" was a follow-up nobody would make).
 */
export function businessLine(words: string, officeNumber: string | null): string | null {
  if (!BUSINESS.test(words)) return null;
  return officeNumber
    ? `For business inquiries, please call our office on ${spokenPhone(officeNumber)}. Anything else I can help with?`
    : "For business inquiries, please contact our office directly. Anything else I can help with?";
}

/** "Are you always busy?", "Is it full of clients all the time?": a question about how busy the practice is. */
const BUSY = /\b(?:busy|packed|booked (?:up|solid)|full of (?:clients|patients|people)|(?:always|usually|really|very|so|all the time) full|full all the time)\b|\b(?:is|are) (?:it|you|the (?:clinic|practice|office|place)|[\w&' ]{2,40}?) (?:always |usually |really |very |so )?full\b/i;

/**
 * Her answer to it: never an empty schedule ("Not at all, we have openings
 * this week") and never a claim the calendar does not show ("we never
 * double-book"); a time found for them instead.
 */
export function busyLine(words: string): string | null {
  return BUSY.test(words) ? "I can usually find you a time that works. Want me to take a look?" : null;
}

/** Words that end a thought unfinished: "Before", "Besides Botox,", "is it". */
const DANGLING = /^\W*(?:and|but|so|or|because|besides|before|after|except|other than|plus|also|like|um+|uh+|what about|how about)\b[^.?!]{0,30}$|\b(?:and|but|or|because|about|with|for|the|a|an|to|of|is it|like|besides|than)\W*$/i;

/**
 * A caller's turn that is a fragment (they paused mid-sentence): a word or
 * three, ending on a joining word or a comma, with no full stop or question
 * mark. She waits for the rest instead of answering it ("Before" was
 * answered "Before what?", "Besides Botox," with "I think I lost you there").
 */
export function isFragment(words: string): boolean {
  const w = words.trim();
  if (!w || /[.?!]$/.test(w)) return false;
  return w.split(/\s+/).length <= 4 && (DANGLING.test(w) || /,$/.test(w));
}

/** What she says to a fragment: a short nod for the rest, and a different one the second time in a row. */
export function fragmentLine(inARow: number): string {
  return inARow <= 1 ? "Mm-hmm?" : "Take your time.";
}

/** "Hi.", "Hello there", "Hey": a greeting and nothing else. */
const GREETING = /^\W*(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|yo)(?:\s+there)?\W*$/i;

/** A reply to a bare greeting always asks how she can help ("Hi there!" alone left a silence, then "Still with me?"). */
export function withGreetingQuestion(words: string, reply: string): string {
  if (!GREETING.test(words) || /\?/.test(reply)) return reply;
  return `${reply.trim()} How can I help you today?`.trim();
}
