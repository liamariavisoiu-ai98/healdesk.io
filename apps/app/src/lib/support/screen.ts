import { META_TREATMENT_VOCABULARY, TREATMENT_NAMES } from "@healdesk/catalog";

/**
 * The support chat's screen (plan Part H; spec, "One rule that has to be in
 * the interface"): what a person types is changed, visibly, before the model
 * sees it, and what the model writes is changed the same way before the
 * person reads it.
 *
 *   - IDENTIFIERS. A phone-shaped run of seven or more digits becomes
 *     "[number hidden]" and an email address "[email hidden]", unless it is
 *     the clinic's own number, healdesk's own support line, the signed-in
 *     user's own address or one of healdesk's. Staff paste a caller's number
 *     into a support chat to ask "why didn't AYA book this one?"; the digit
 *     rule catches a card number, a date of birth written as digits or a
 *     record number on the way.
 *   - TREATMENT NAMES. Every word of the catalog's treatment vocabulary
 *     (META_TREATMENT_VOCABULARY, the Meta reply guard's list, and
 *     TREATMENT_NAMES, the email copy lint's), and the clinic's own menu,
 *     becomes "[treatment]" (spec: "Treatment names never appear in … the
 *     support chat"). The person sees the replacement in their own message,
 *     with the line "We hide treatment names here.", so nothing is hidden
 *     from them silently.
 *
 * The screen never says which word or number it hid: the counts are all a
 * caller gets back, so the hidden text cannot reach a log through them.
 *
 * Matching is by whole words on a copy of the text with its accents taken
 * off ("Juvéderm" is "juvederm"), mapped back to the original, so a
 * replacement covers exactly the characters it matched and the rest of the
 * message is left as typed. Pure: no database, no clock.
 */

export const TREATMENT_MASK = "[treatment]";
export const EMAIL_MASK = "[email hidden]";
export const NUMBER_MASK = "[number hidden]";

/** Shown under a message whose treatment names were hidden. */
export const TREATMENT_NOTICE = "We hide treatment names here.";

export type ScreenAllow = {
  /** Numbers that may stay, in any form: the clinic's own, and healdesk's support line. */
  numbers: readonly (string | null | undefined)[];
  /** Addresses that may stay: the signed-in user's own. healdesk's are always allowed. */
  emails: readonly (string | null | undefined)[];
  /** The clinic's own service names, hidden as well as the catalog's vocabulary. */
  serviceNames?: readonly string[];
};

export type Screened = {
  text: string;
  hiddenTreatments: number;
  hiddenIdentifiers: number;
};

/**
 * A match. `replacement` null is a number or an address that may stay (the
 * practice's own): it is not replaced, but a streamed reply is never cut
 * inside it either, or its second half would be read alone as a stranger's.
 */
type Span = {
  start: number;
  end: number;
  replacement: string | null;
  kind: "treatment" | "identifier";
};

// -----------------------------------------------------------------------------
// Folding: accents off, mapped back to the original
// -----------------------------------------------------------------------------

/**
 * The text with its combining marks removed, and for each folded character
 * the index of the original character it came from (plus one sentinel at the
 * end), so a match in the folded copy maps back to the original's span.
 */
function fold(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let index = 0;
  for (const ch of text) {
    const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    for (const unit of base.split("")) {
      folded += unit;
      map.push(index);
    }
    index += ch.length;
  }
  map.push(index);
  return { folded, map };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_BREAK = "[^\\p{L}\\p{N}]+";

/** The words of a vocabulary entry, folded and lower case. */
function wordsOf(entry: string): string[] {
  return fold(entry.normalize("NFC"))
    .folded.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** One entry as a pattern: its words with any separator between them, a plural allowed. */
function termPattern(words: readonly string[]): string {
  return `${words.map(escapeRegExp).join(WORD_BREAK)}(?:s|es)?`;
}

/**
 * Words that make a menu item a booking rather than a treatment: a clinic
 * whose menu has "Free consultation" must not lose the word "consultation"
 * from every answer about how AYA offers one. A service name made only of
 * these (and numbers) is not hidden.
 */
const GENERIC_SERVICE_WORDS: ReadonlySet<string> = new Set([
  "consultation",
  "consultations",
  "consult",
  "consults",
  "free",
  "new",
  "patient",
  "patients",
  "client",
  "clients",
  "appointment",
  "appointments",
  "visit",
  "visits",
  "follow",
  "up",
  "check",
  "checkup",
  "initial",
  "virtual",
  "video",
  "phone",
  "call",
  "in",
  "person",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "session",
  "and",
  "or",
  "with",
  "the",
  "a",
]);

function isGenericServiceName(words: readonly string[]): boolean {
  return words.every((w) => GENERIC_SERVICE_WORDS.has(w) || /^\d+$/.test(w));
}

/** The catalog's vocabulary as one pattern, built once. Longest first, so a phrase wins over its word. */
const CATALOG_TERMS: readonly string[][] = dedupeTerms(
  [...META_TREATMENT_VOCABULARY, ...TREATMENT_NAMES].map(wordsOf),
);

function dedupeTerms(terms: readonly string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const words of terms) {
    if (words.length === 0) continue;
    const key = words.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(words);
  }
  return out;
}

const CATALOG_PATTERN = treatmentRegExp(CATALOG_TERMS);

function treatmentRegExp(terms: readonly string[][]): RegExp | null {
  if (terms.length === 0) return null;
  const alternatives = [...terms]
    .sort((a, b) => b.join(" ").length - a.join(" ").length)
    .map(termPattern);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/** Each allow list's menu pattern, built once however many times a stream asks. */
const SERVICE_PATTERNS = new WeakMap<ScreenAllow, RegExp | null>();

/** The clinic's own menu names as a pattern, or null when it has none worth hiding. */
function servicePatternFor(allow: ScreenAllow): RegExp | null {
  if (!SERVICE_PATTERNS.has(allow)) SERVICE_PATTERNS.set(allow, servicePattern(allow.serviceNames));
  return SERVICE_PATTERNS.get(allow) ?? null;
}

function servicePattern(serviceNames: readonly string[] | undefined): RegExp | null {
  if (!serviceNames || serviceNames.length === 0) return null;
  const terms = dedupeTerms(
    serviceNames
      .slice(0, 300)
      .map((name) => wordsOf(name.slice(0, 120)))
      .filter((words) => words.length > 0 && !isGenericServiceName(words)),
  );
  return treatmentRegExp(terms);
}

/** The longest catalog term, in characters: how far a streamed reply holds back. */
export const LONGEST_TERM = Math.max(...CATALOG_TERMS.map((t) => t.join(" ").length));

// -----------------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------------

const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/**
 * A run of digits that could be a phone number, a card or a record number:
 * an optional country code ("+1 "), an optional area code in brackets
 * ("(512) "), then digits with at most one space, dot or dash between any
 * two; seven digits or more in all (checked after the match). Not a slash,
 * so a date written "10/14/2026" stays; not a comma, so "$1,500" stays; and
 * two numbers a bracket apart are two runs, not one.
 */
const DIGIT_RUN =
  /(?<![\p{L}\p{N}])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d(?:[ .-]?\d){5,}(?![\p{L}\p{N}])/gu;

/** An ISO date or date-time, which the digit rule would otherwise read as a number. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** healdesk's own addresses: hello@, legal@ and privacy@ are all published. */
const HEALDESK_ADDRESS = /@healdesk\.io$/i;

function digitsOf(value: string): string {
  return value.replace(/\D+/g, "");
}

/** The same number, written either way: compared on the last ten digits when both have them. */
function sameNumber(a: string, b: string): boolean {
  if (a.length >= 10 && b.length >= 10) return a.slice(-10) === b.slice(-10);
  return a === b;
}

function identifierSpans(text: string, allow: ScreenAllow): Span[] {
  const spans: Span[] = [];
  const emails = new Set(
    allow.emails.filter((e): e is string => Boolean(e)).map((e) => e.trim().toLowerCase()),
  );
  for (const match of text.matchAll(EMAIL)) {
    const value = match[0].replace(/[.'-]+$/, "");
    const lower = value.toLowerCase();
    const allowed = emails.has(lower) || HEALDESK_ADDRESS.test(lower);
    spans.push({
      start: match.index,
      end: match.index + value.length,
      replacement: allowed ? null : EMAIL_MASK,
      kind: "identifier",
    });
  }
  const numbers = allow.numbers
    .filter((n): n is string => Boolean(n))
    .map(digitsOf)
    .filter((d) => d.length >= 7);
  for (const match of text.matchAll(DIGIT_RUN)) {
    const value = match[0];
    if (ISO_DATE.test(value)) continue;
    const digits = digitsOf(value);
    if (digits.length < 7) continue;
    const allowed = numbers.some((n) => sameNumber(n, digits));
    spans.push({
      start: match.index,
      end: match.index + value.length,
      replacement: allowed ? null : NUMBER_MASK,
      kind: "identifier",
    });
  }
  return spans;
}

function treatmentSpans(text: string, allow: ScreenAllow): Span[] {
  const { folded, map } = fold(text);
  const spans: Span[] = [];
  for (const pattern of [CATALOG_PATTERN, servicePatternFor(allow)]) {
    if (!pattern) continue;
    pattern.lastIndex = 0;
    for (const match of folded.matchAll(pattern)) {
      const start = map[match.index]!;
      const end = map[match.index + match[0].length]!;
      spans.push({ start, end, replacement: TREATMENT_MASK, kind: "treatment" });
    }
  }
  return spans;
}

/**
 * Every match, in order, none overlapping: identifiers first, then treatment
 * names longest first, so the clinic's "Signature Glow Facial" is one
 * replacement rather than "Signature Glow" and the catalog's "facial".
 */
function spansOf(text: string, allow: ScreenAllow): Span[] {
  const kept: Span[] = [];
  const overlaps = (s: Span) => kept.some((k) => s.start < k.end && k.start < s.end);
  const treatments = treatmentSpans(text, allow).sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  );
  for (const span of [...identifierSpans(text, allow), ...treatments]) {
    if (!overlaps(span)) kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function apply(text: string, spans: readonly Span[]): Screened {
  let out = "";
  let at = 0;
  let hiddenTreatments = 0;
  let hiddenIdentifiers = 0;
  for (const span of spans) {
    if (span.replacement === null) continue;
    out += text.slice(at, span.start) + span.replacement;
    at = span.end;
    if (span.kind === "treatment") hiddenTreatments += 1;
    else hiddenIdentifiers += 1;
  }
  return { text: out + text.slice(at), hiddenTreatments, hiddenIdentifiers };
}

/** Screen one complete piece of text. */
export function screenText(text: string, allow: ScreenAllow): Screened {
  const normal = text.normalize("NFC");
  return apply(normal, spansOf(normal, allow));
}

/** The lines shown under a person's message that was changed, in the order they apply. */
export function screenNotices(screened: Screened): string[] {
  const notices: string[] = [];
  if (screened.hiddenIdentifiers > 0) {
    notices.push(
      "We hid a phone number or an email address: this chat is for questions about healdesk, not about a person.",
    );
  }
  if (screened.hiddenTreatments > 0) notices.push(TREATMENT_NOTICE);
  return notices;
}

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

/**
 * How much of a streamed reply is held back: enough that no treatment name
 * or identifier can straddle what has been sent and what has not.
 */
const HOLD_BACK = Math.max(LONGEST_TERM + 4, 64);

/**
 * The screen for a reply that arrives in pieces. `push` returns the part that
 * is safe to send: everything up to a space at least HOLD_BACK characters
 * from the end that is not inside a match. `end` screens and returns the
 * rest. A treatment name or a number cut in two by the stream is therefore
 * always seen whole before any of it is sent.
 */
export class StreamScreen {
  private buffer = "";
  private hiddenTreatments = 0;
  private hiddenIdentifiers = 0;

  constructor(private readonly allow: ScreenAllow) {}

  push(delta: string): string {
    this.buffer += delta;
    if (this.buffer.length <= HOLD_BACK) return "";
    const spans = spansOf(this.buffer, this.allow);
    let cut = lastSpaceAtOrBefore(this.buffer, this.buffer.length - HOLD_BACK);
    for (let moved = true; moved && cut > 0;) {
      moved = false;
      for (const span of spans) {
        if (span.start < cut && cut < span.end) {
          cut = lastSpaceAtOrBefore(this.buffer, span.start);
          moved = true;
        }
      }
    }
    if (cut <= 0) return "";
    const sent = apply(
      this.buffer.slice(0, cut),
      spans.filter((s) => s.end <= cut),
    );
    this.count(sent);
    this.buffer = this.buffer.slice(cut);
    return sent.text;
  }

  end(): string {
    const rest = screenText(this.buffer, this.allow);
    this.count(rest);
    this.buffer = "";
    return rest.text;
  }

  get hidden(): { treatments: number; identifiers: number } {
    return { treatments: this.hiddenTreatments, identifiers: this.hiddenIdentifiers };
  }

  private count(screened: Screened): void {
    this.hiddenTreatments += screened.hiddenTreatments;
    this.hiddenIdentifiers += screened.hiddenIdentifiers;
  }
}

/** The index of the last whitespace character at or before `limit`, or 0. */
function lastSpaceAtOrBefore(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length - 1); i > 0; i -= 1) {
    if (/\s/.test(text[i]!)) return i;
  }
  return 0;
}
