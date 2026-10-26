/**
 * How healdesk's support sounds (ops automation design E5 §7, Phase 7 slice 1;
 * owner, 24 and 25 October 2026): the tone rules, the phrases a reply never
 * uses, the sign-off, and one pure check, `lintSupportTone`, that every
 * written reply passes before a person reads it.
 *
 * One list, three readers: the portal's support chat carries the rules in
 * its cached prompt prefix (apps/app lib/support/prompt.ts); the email
 * drafter (lane P7b) prompts with them and checks its draft with the lint;
 * and the send path (lane P7c) runs the lint again on the text the owner
 * approved, so an edit cannot bring a banned phrase back in. Here, in the
 * catalog, because all three must agree to the byte, and because a reply is
 * read by a receptionist or an owner between patients, often worried that
 * something is wrong with their phones or their money: the words are the
 * product's, not each caller's to choose.
 *
 * Replies are signed "The Healdesk Team", never a first name (owner,
 * 25 October 2026): v1 has one shared operator sign-in, so a name would
 * promise a person the clinic cannot reach by name.
 *
 * No dependencies, like the rest of the catalog.
 */

/** How every email reply is signed. The chat signs nothing. */
export const SUPPORT_SIGN_OFF = "The Healdesk Team";

/**
 * The eight rules, in the order E5 §7.1 gives them, rule 3 rewritten for the
 * team sign-off. Each is one line a model can follow and a person can check.
 */
export const SUPPORT_TONE_RULES: readonly string[] = [
  "Short. Two to four sentences, one idea per sentence. If it needs more than that, offer a call.",
  'Plain words. Say "phone", "calendar", "card", "your portal". Never "provisioning", "endpoint", "integration", "tenant", "latency" or "ticket".',
  `Greet by first name once ("Hi Dana,") only when the person gave it, or use no greeting at all. Never "Hi there", never "Dear Customer". An email is signed "${SUPPORT_SIGN_OFF}", never with a first name; a chat reply is not signed.`,
  'Own it. "That\'s on us" when it is; "Thanks for catching this" when they did. No passive voice around a fault ("an error occurred").',
  'Next step and when. End with what happens next and the day it happens, named ("by Wednesday"). Never "shortly", never "within 24 hours", never a go-live date.',
  "Never blame. Not the practice, and not a vendor by name as an excuse. State the fault, the fix and when.",
  'Calm, not cheerful. No exclamation marks, no "awesome", no emoji. Reassure with facts ("Calls are going to your direct line, so nobody is missed"), not with adjectives.',
  "Never clinical, never about a patient. No diagnosis or advice, and never confirm or deny anything about a patient or client. Point to the portal screen that shows it.",
];

/**
 * The phrases a reply never uses (E5 §7.2), matched without regard to case,
 * on word boundaries. Exclamation marks and emoji are checked on their own
 * (below), not listed here.
 */
export const SUPPORT_BANNED_PHRASES: readonly string[] = [
  "unfortunately",
  "I apologise for any inconvenience",
  "I apologize for any inconvenience",
  "as per",
  "kindly",
  "please be advised",
  "no worries",
  "hope this helps",
  "feel free to",
  "at your earliest convenience",
  "do not hesitate",
  "don't hesitate",
  "going forward",
  "reach out",
  "circle back",
  "touch base",
  "ticket",
  "escalate",
  "escalated",
  "escalating",
  "escalation",
  "HIPAA compliant",
  "revenue",
  "guarantee",
  "guaranteed",
  "live in two minutes",
  "ASAP",
  "within 24 hours",
  "shortly",
  "our system",
  "the AI",
  "Hi there",
  "Dear Customer",
  "awesome",
];

/** What the lint found, by rule; `phrase` is the banned phrase as listed. */
export type SupportToneProblem =
  | { rule: "exclamation" }
  | { rule: "emoji" }
  | { rule: "banned_phrase"; phrase: string };

const EMOJI = /\p{Extended_Pictographic}/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One pattern per phrase: word boundaries at each end, any run of spaces between words, curly or straight apostrophes. */
const BANNED = SUPPORT_BANNED_PHRASES.map((phrase) => ({
  phrase,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}])${phrase
      .split(/\s+/)
      .map((word) => escapeRegExp(word).replace(/'/g, "['’]"))
      .join("\\s+")}(?![\\p{L}\\p{N}])`,
    "iu",
  ),
}));

/**
 * Every tone rule the text breaks, in a fixed order (exclamation, emoji,
 * then each banned phrase in list order, once), or an empty list when it
 * keeps them all. Pure, and it never echoes the text: a caller may log or
 * show the rule names, and the phrase is our own list's.
 */
export function lintSupportTone(text: string): SupportToneProblem[] {
  const problems: SupportToneProblem[] = [];
  if (text.includes("!") || text.includes("！")) problems.push({ rule: "exclamation" });
  if (EMOJI.test(text)) problems.push({ rule: "emoji" });
  for (const { phrase, pattern } of BANNED) {
    if (pattern.test(text)) problems.push({ rule: "banned_phrase", phrase });
  }
  return problems;
}

/** Whether the text keeps every tone rule. */
export function keepsSupportTone(text: string): boolean {
  return lintSupportTone(text).length === 0;
}
